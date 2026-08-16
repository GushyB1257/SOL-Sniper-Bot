import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { RuntimeSettings } from '../settings/runtime.js';
import { ClaudeAnalyst, type AiUsageTotals } from '../ai/client.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import type { TradeJournalEntry } from '../types.js';
import { buildEvidence, renderEvidence, type Evidence } from './evidence.js';
import { TUNABLES, TUNABLE_BY_KEY, vetProposal } from './limits.js';
import { TuningLedger, type Change, type Experiment } from './ledger.js';

const log = logger('tuner');

/** One bot's position in the tune/measure cycle. */
export interface TunerProgress {
  /** gathering: waiting for trades. measuring: a change is under test. */
  phase: 'gathering' | 'ready' | 'measuring';
  trades: number;
  needed: number;
  /** When the change under measurement was made. */
  since?: number;
  /** When this bot's cooldown expires. */
  nextAt?: number;
  /** What is holding a change up right now, when something is. */
  blockedBy?: 'trades' | 'cooldown' | null;
}

export interface TunerDeps {
  cfg: Config;
  settings: RuntimeSettings;
  /** Each bot's own journal — they are tuned separately, on their own data. */
  stores: Map<string, Store>;
  dataDir: string;
}

export const proposalSchema = z.object({
  changes: z
    .array(
      z.object({
        key: z.string(),
        value: z.union([z.number(), z.string(), z.boolean()]),
        why: z.string().min(1),
      }),
    )
    .max(8),
  notes: z.array(z.string()).max(5).optional(),
});

type Proposal = z.infer<typeof proposalSchema>;

/**
 * Structured-output schema for a proposal.
 *
 * Deliberately plain. Two things the API's schema support does NOT accept, both
 * of which silently turned every tuning call into a 400 until they were found:
 *
 *  - `maxItems` on an array. The count limit is enforced after parsing instead,
 *    by the zod schema and by TUNER_MAX_CHANGES_PER_ROUND, which is where it
 *    actually matters.
 *  - A union of types on a property (`type: ['number','string','boolean']`).
 *    So every value arrives as a STRING and is converted according to what the
 *    parameter actually is — the tunable list already knows, and a string is
 *    what gets written into the settings patch either way.
 */
export const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'why'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Adjusts the bots' own strategy parameters from their trade history.
 *
 * The obvious version of this feature — feed the journal to a model every few
 * minutes and apply whatever it says — does not learn anything. It changes
 * something, the next batch of trades reflects a blend of every setting tried
 * so far, nothing can be attributed to anything, and the parameters random-walk
 * while the log fills with confident explanations. Three things make this
 * version different:
 *
 *  - **One experiment at a time per bot.** A change is made, then held still.
 *  - **Every change is measured.** Expectancy over the trades that follow is
 *    compared against the window before it, and a change that did not beat its
 *    baseline is reverted automatically. The default is the known state.
 *  - **A minimum sample before anything moves.** Under a few dozen trades,
 *    memecoin P&L is dominated by one or two outliers, and any change can be
 *    justified from the noise. The tuner declines rather than oblige.
 *
 * What it can touch is fixed at compile time in `limits.ts`: strategy knobs
 * only, never position size or a risk limit, always inside a hard range and a
 * per-round step cap. The model proposes; this decides.
 */
export class AutoTuner {
  private readonly ledger: TuningLedger;
  private readonly claude: ClaudeAnalyst;
  private running = false;
  private lastRunAt = 0;
  private lastError?: string;

  constructor(private readonly deps: TunerDeps) {
    this.ledger = new TuningLedger(deps.dataDir);
    this.claude = new ClaudeAnalyst(deps.cfg);
  }

  get history(): readonly Experiment[] {
    return this.ledger.all();
  }

  get status(): { lastRunAt: number; lastError?: string; usage: AiUsageTotals } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError, usage: this.claude.usage };
  }

  /**
   * Where each bot is in the cycle, for the dashboard.
   *
   * "Is it working?" is a fair question about software that changes things on
   * its own schedule, and the honest answer is usually "it is waiting for
   * trades". Without this the only visible evidence is a change appearing
   * hours later, which is indistinguishable from it being broken.
   */
  progress(): Record<string, TunerProgress> {
    const { cfg } = this.deps;
    const out: Record<string, TunerProgress> = {};

    for (const [bot, store] of this.deps.stores) {
      const journal = store.journal();
      const open = this.ledger.running(bot);

      const nextAt = this.cooldownEndsAt(bot);

      if (open) {
        const after = journal.length - open.journalAtStart;
        out[bot] = {
          phase: 'measuring',
          trades: after,
          needed: cfg.TUNER_MIN_TRADES,
          since: open.startedAt,
          nextAt,
        };
        continue;
      }

      const since = this.tradesSinceLastChange(bot, journal);
      const enough = since.length >= cfg.TUNER_MIN_TRADES;
      out[bot] = {
        phase: enough ? 'ready' : 'gathering',
        trades: since.length,
        needed: cfg.TUNER_MIN_TRADES,
        nextAt,
        // Which gate is actually holding it up, so the card can say so rather
        // than showing a progress bar that has been full for an hour.
        blockedBy: enough && Date.now() < nextAt ? 'cooldown' : enough ? null : 'trades',
      };
    }
    return out;
  }

  /**
   * Earliest moment any bot could next be reviewed.
   *
   * The cooldown is per bot, so this is the soonest of them — what the header
   * shows when you are not looking at a specific bot.
   */
  get nextRunAt(): number {
    const times = [...this.deps.stores.keys()].map((b) => this.cooldownEndsAt(b));
    return times.length > 0 ? Math.min(...times) : Date.now();
  }

  /**
   * When this bot's cooldown expires.
   *
   * Read from the ledger rather than a field so it survives a restart — a
   * process that restarts every few minutes would otherwise re-review on every
   * boot and change something each time.
   */
  private cooldownEndsAt(bot: string): number {
    const mine = this.ledger.all().filter((e) => e.bot === bot);
    const last = mine[mine.length - 1];
    if (!last) return 0; // never touched: reviewable as soon as trades allow
    const touched = Math.max(last.startedAt, last.decidedAt ?? 0);
    return touched + this.deps.cfg.TUNER_INTERVAL_MINUTES * 60_000;
  }

  /** Called on a timer. Never throws into the caller. */
  async tick(): Promise<void> {
    const { cfg } = this.deps;
    if (!cfg.AUTO_TUNE_ENABLED) return;
    if (this.running) return;

    // No global clock gate. Whether a bot is ready is a question about ITS
    // trades and ITS last change — a fast bot should not wait on a slow one,
    // and 40 trades is 40 trades whether they took two minutes or two days.
    this.running = true;
    this.lastRunAt = Date.now();
    try {
      for (const [bot, store] of this.deps.stores) {
        try {
          await this.tuneBot(bot, store);
        } catch (err) {
          this.lastError = errMessage(err);
          log.error(`${bot}: tuning failed — ${this.lastError}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async tuneBot(bot: string, store: Store): Promise<void> {
    const { cfg } = this.deps;
    const journal = store.journal();

    // The cooldown is not about statistics — the trade count handles that. It
    // bounds API spend, and it stops a burst of fast trades producing a run of
    // changes before any of them has been given a chance to show an effect.
    const cooldown = this.cooldownEndsAt(bot);
    if (Date.now() < cooldown) {
      log.debug(`${bot}: cooling down for another ${Math.round((cooldown - Date.now()) / 1000)}s`);
      return;
    }

    // Settle any experiment that has collected enough evidence first, so a new
    // proposal is never made against data that is still half a blend.
    const open = this.ledger.running(bot);
    if (open) {
      this.settle(open, journal);
      // Whatever the verdict, this bot is done for the cycle. Proposing again
      // straight after settling re-applies the change that was just reverted
      // when the model has not been told the outcome yet, and the pair loops.
      return;
    }

    const since = this.tradesSinceLastChange(bot, journal);
    if (since.length < cfg.TUNER_MIN_TRADES) {
      log.debug(
        `${bot}: ${since.length}/${cfg.TUNER_MIN_TRADES} trades since the last change — waiting`,
      );
      return;
    }

    const evidence = buildEvidence(bot, since, cfg);
    const proposal = await this.propose(bot, evidence);
    if (!proposal) return;

    const changes = this.vet(bot, proposal);
    if (changes.length === 0) {
      log.info(`${bot}: no change this round${proposal.notes?.length ? ' (see notes)' : ''}`);
      if (proposal.notes?.length) for (const n of proposal.notes) log.info(`  note: ${n}`);
      return;
    }

    const applied = this.apply(changes);
    if (!applied) return;

    const experiment: Experiment = {
      id: randomUUID(),
      bot,
      startedAt: Date.now(),
      changes,
      baselineExpectancy: expectancy(since),
      baselineTrades: since.length,
      journalAtStart: journal.length,
      status: 'running',
      notes: proposal.notes,
    };
    this.ledger.add(experiment);

    log.warn(
      `${bot}: TUNED — ${changes
        .map((c) => `${c.key} ${c.from} -> ${c.to}`)
        .join(', ')} (baseline ${experiment.baselineExpectancy.toFixed(5)} SOL/trade over ` +
        `${since.length} trades; reverts automatically if it does not beat that)`,
    );
    for (const c of changes) log.info(`  ${c.key}: ${c.why}`);
  }

  /**
   * Decides a running experiment, or leaves it to collect more trades.
   *
   * Returns true once a verdict was reached.
   */
  private settle(exp: Experiment, journal: readonly TradeJournalEntry[]): boolean {
    const { cfg } = this.deps;
    const after = journal.slice(exp.journalAtStart);
    if (after.length < cfg.TUNER_MIN_TRADES) return false;

    const result = expectancy(after);
    const improved = result >= exp.baselineExpectancy;

    if (improved) {
      this.ledger.update(exp.id, {
        status: 'kept',
        resultExpectancy: result,
        resultTrades: after.length,
        decidedAt: Date.now(),
        verdict:
          `${result.toFixed(5)} SOL/trade over ${after.length} trades, against a baseline of ` +
          `${exp.baselineExpectancy.toFixed(5)} — kept`,
      });
      log.info(
        `${exp.bot}: change KEPT — ${result.toFixed(5)} SOL/trade vs baseline ` +
          `${exp.baselineExpectancy.toFixed(5)} over ${after.length} trades`,
      );
      return true;
    }

    // Did not beat the baseline, so put it back. A neutral result reverts too:
    // the known state is the one with more evidence behind it, and a tuner that
    // keeps every coin flip drifts by construction.
    const inverse = exp.changes.map((c) => ({ ...c, from: c.to, to: c.from }));
    const ok = this.apply(inverse);
    this.ledger.update(exp.id, {
      status: ok ? 'reverted' : 'abandoned',
      resultExpectancy: result,
      resultTrades: after.length,
      decidedAt: Date.now(),
      verdict:
        `${result.toFixed(5)} SOL/trade over ${after.length} trades, against a baseline of ` +
        `${exp.baselineExpectancy.toFixed(5)} — ${ok ? 'reverted' : 'REVERT FAILED, left in place'}`,
    });
    log.warn(
      `${exp.bot}: change REVERTED — ${result.toFixed(5)} SOL/trade did not beat baseline ` +
        `${exp.baselineExpectancy.toFixed(5)} over ${after.length} trades`,
    );
    return true;
  }

  /** Journal entries recorded since this bot's most recent applied change. */
  private tradesSinceLastChange(
    bot: string,
    journal: readonly TradeJournalEntry[],
  ): TradeJournalEntry[] {
    const past = this.ledger.all().filter((e) => e.bot === bot && e.status !== 'running');
    const last = past[past.length - 1];
    const from = last ? last.journalAtStart : 0;
    // Cap the window: a filter changed a week ago should not be judged against
    // a market regime that no longer exists.
    return journal.slice(Math.max(from, journal.length - 400));
  }

  /** True when this exact value was already tried for this key and reverted. */
  private wasReverted(bot: string, key: string, value: number | string | boolean): boolean {
    return this.ledger
      .all()
      .filter((e) => e.bot === bot && e.status === 'reverted')
      .slice(-10)
      .some((e) => e.changes.some((c) => c.key === key && String(c.to) === String(value)));
  }

  /** What has already been tried, so the model is not told to rediscover it. */
  private historyFor(bot: string): string {
    const past = this.ledger
      .all()
      .filter((e) => e.bot === bot && e.status !== 'running')
      .slice(-8);
    if (past.length === 0) return 'No changes have been made to this bot yet.';

    return past
      .map(
        (e) =>
          `  ${new Date(e.startedAt).toISOString().slice(0, 16)} [${e.status.toUpperCase()}] ` +
          e.changes.map((c) => `${c.key} ${c.from}->${c.to}`).join(', ') +
          (e.verdict ? `\n      ${e.verdict}` : ''),
      )
      .join('\n');
  }

  private async propose(bot: string, evidence: Evidence): Promise<Proposal | null> {
    const knobs = TUNABLES.filter((t) => t.bot === bot || t.bot === 'shared');
    const current = this.deps.settings.values();

    const bounds = (t: (typeof knobs)[number]): string => {
      if (t.kind === 'boolean') return '[true or false]';
      if (t.kind === 'enum') return `[one of: ${t.options?.join(' | ')}]`;
      if (t.kind === 'text') return '[text, must match the documented format]';
      return `[allowed ${t.min}..${t.max}, max ${t.maxStepPct}% move this round]`;
    };

    // Marked rather than hidden. A parameter that does nothing in the current
    // mode is still worth knowing about — switching the mode is itself a
    // proposal — but spending a measurement window on a scalp setting while the
    // ratchet is running is a wasted round, and there are enough parameters
    // here that the distinction is not obvious from the names.
    const inertNote = (key: string): string => {
      const exitMode = current.EXIT_MODE;
      const entryMode = current.ENTRY_MODE;
      if (key.startsWith('SCALP_') && exitMode !== 'scalp') return '  (INERT: EXIT_MODE is ' + exitMode + ')';
      if (key.startsWith('RATCHET_') && exitMode !== 'ratchet') return '  (INERT: EXIT_MODE is ' + exitMode + ')';
      if (
        ['STOP_LOSS_PCT', 'TRAILING_STOP_PCT', 'MOONBAG_TRAILING_STOP_PCT', 'EXIT_LADDER'].includes(key) &&
        exitMode !== 'ladder'
      ) {
        return '  (INERT: EXIT_MODE is ' + exitMode + ')';
      }
      if (key.startsWith('MOMENTUM_') && entryMode !== 'fast') return '  (INERT: ENTRY_MODE is ' + entryMode + ')';
      if (key.startsWith('SCREEN_') && entryMode !== 'screener') return '  (INERT: ENTRY_MODE is ' + entryMode + ')';
      if (key.startsWith('AI_') && entryMode !== 'ai' && current.AI_MANAGE_EXITS !== 'true') {
        return '  (INERT: no AI entry or exit management)';
      }
      return '';
    };

    const catalogue = knobs
      .map(
        (t) =>
          `  ${t.key} = ${current[t.key] ?? '?'}  ${bounds(t)}` +
          `${t.risk ? '  *** RISK ***' : ''}${inertNote(t.key)}\n    ${t.what}`,
      )
      .join('\n');

    const result = await this.claude.ask<Proposal>(
      {
        label: `tuner:${bot}`,
        system: SYSTEM_PROMPT,
        // Generous on purpose. Thinking is adaptive and this is a genuinely
        // hard call over a hundred-plus parameters, so a tight budget gets
        // spent reasoning before a single character of JSON is written and the
        // whole round returns empty. The tuner runs a few times an hour at
        // most, so the ceiling costs nothing when it is not used.
        maxTokens: 16_000,
        jsonSchema: JSON_SCHEMA,
        userContent:
          `${renderEvidence(evidence)}\n\n` +
          `PARAMETERS YOU MAY CHANGE (current value, allowed values):\n${catalogue}\n\n` +
          'Parameters marked *** RISK *** decide how much capital is exposed rather than ' +
          'what gets traded. In live mode they move real money. Propose one only when the ' +
          'evidence is about sizing or exposure specifically — the fee analysis above is the ' +
          'usual justification — and never merely to see what happens.\n\n' +
          `WHAT HAS ALREADY BEEN TRIED ON THIS BOT:\n${this.historyFor(bot)}\n\n` +
          'A change marked REVERTED was measured and did not beat its baseline. Do not ' +
          'propose it again — it will be refused. Build on what was KEPT.\n\n' +
          `Propose at most ${this.deps.cfg.TUNER_MAX_CHANGES_PER_ROUND} changes, or none. ` +
          'Give every value as a STRING: "0.35", "true", "scalp", "pump,pump-amm". ' +
          'Anything you want changed that is not in the list above goes in notes.',
      },
      proposalSchema,
    );

    if (!result.ok || !result.value) {
      this.lastError = result.error;
      log.warn(`${bot}: tuner call failed — ${result.error}`);
      return null;
    }
    this.lastError = undefined;
    return result.value;
  }

  /** Applies the limits. Anything that does not survive them is dropped. */
  private vet(bot: string, proposal: Proposal): Change[] {
    const { cfg } = this.deps;
    const current = this.deps.settings.values();
    const out: Change[] = [];

    for (const c of proposal.changes) {
      if (out.length >= cfg.TUNER_MAX_CHANGES_PER_ROUND) {
        log.info(`${bot}: ignoring extra proposals beyond ${cfg.TUNER_MAX_CHANGES_PER_ROUND}`);
        break;
      }
      const nowRaw = current[c.key];
      if (nowRaw === undefined) {
        log.warn(`${bot}: proposed ${c.key}, which is not a live setting — ignored`);
        continue;
      }
      const spec = TUNABLE_BY_KEY.get(c.key);
      const vet = vetProposal(
        c.key,
        nowRaw,
        c.value,
        // The step cap only means anything for numbers.
        spec?.kind === 'number' ? cfg.TUNER_MAX_STEP_PCT : undefined,
      );
      if (!vet.ok) {
        log.info(`${bot}: rejected ${c.key}=${String(c.value)} — ${vet.reason}`);
        continue;
      }
      // Belt and braces against the obvious loop: propose, revert, propose the
      // same thing again forever. The prompt is told what was reverted, but a
      // prompt is a request and this is a rule.
      if (this.wasReverted(bot, c.key, vet.value)) {
        log.info(`${bot}: rejected ${c.key}=${vet.value} — already tried and reverted`);
        continue;
      }
      out.push({
        key: c.key,
        from: spec?.kind === 'number' ? Number(nowRaw) : nowRaw,
        to: vet.typed,
        why: c.why,
        ...(vet.clamped && { clamped: vet.clamped }),
        ...(spec?.risk && { risk: true }),
      });
    }
    return out;
  }

  /**
   * Writes the change through the same path a human typing in the dashboard
   * uses, so zod validation and the cross-field rules still govern. A patch
   * that would produce an invalid config is refused whole.
   */
  private apply(changes: Change[]): boolean {
    const patch: Record<string, string> = {};
    for (const c of changes) patch[c.key] = String(c.to);

    const res = this.deps.settings.apply(patch);
    if (!res.ok) {
      this.lastError = res.error;
      log.error(`Tuner patch refused: ${res.error}`);
      return false;
    }
    return true;
  }
}

function expectancy(journal: readonly TradeJournalEntry[]): number {
  if (journal.length === 0) return 0;
  return journal.reduce((a, t) => a + t.pnlSol, 0) / journal.length;
}

export const SYSTEM_PROMPT = `You tune the strategy parameters of a Solana memecoin trading bot from its own closed-trade history.

You are one half of a loop. You propose; the bot enforces hard limits, applies the change, holds it still, measures the trades that follow, and REVERTS it automatically if it does not beat the baseline expectancy. So a bad proposal is not a catastrophe — but it does cost a whole measurement window, which is hours of trading. Propose only what the evidence in front of you actually supports.

How to read the evidence:

- "Before fees" vs "after fees" separates two different problems. Positive before and negative after means the entries were fine and the round-trip cost ate them: that is a hold-time or exit-timing problem, not a filter problem. Negative before fees means the entries lost money before a single fee was charged, and only the entry filters can fix that.
- The required win rate is computed from the average winner and average loser. If the actual win rate is below it, the SHAPE is wrong — winners are being closed too early or losers held too long — and moving entry filters will not close that gap.
- Buckets marked (thin) have under 10 trades. They are noise. Do not move a threshold because of one.
- A bucket only justifies a change if it is both LARGE and clearly losing. One big loser in an otherwise fine bucket is not a signal.

Rules:

- Propose NO changes when the evidence does not clearly point somewhere. "No change" is a valid and frequently correct answer, and is much better than moving something to look busy.
- One coherent idea per round. Changing three unrelated things at once means the measurement cannot attribute the result to any of them.
- Every change needs a specific reason citing a number you were given. "Might improve performance" is not a reason.
- Risk parameters split into two kinds, and they are not the same decision.

  EXPOSURE — position size, concurrent positions, the daily loss limit, the hourly spend cap, the wallet reserve. These decide what a mistake costs. Raise one only when the evidence is specifically about sizing, most often the fee analysis showing positive gross P&L eaten by fixed costs, and prefer the smallest step that tests the idea. Lowering exposure needs no special justification.

  SHAPE — the stop losses, the give-back limits, the checkpoint lengths, the recovery threshold. These decide how a winner and a loser each end, which is what the required-win-rate comparison measures. When your actual win rate is below the rate that pair needs, the shape is the problem and these are the levers for it. PROPOSE THEM. Do not describe them as a future step for someone else: shape is exactly the thing you are here to fix, and a note saying "the next lever is X" about a parameter in your own list is a wasted round.

- Anything in your parameter list is yours to propose. Notes are ONLY for things you cannot reach — a change to the code, a decision about the wallet, an observation with no parameter behind it. If you find yourself writing "a human should" about a key that appears above, propose it instead.
- The fee constants and the SOL price fallback are not in your list on purpose. They describe what the world charges, not what you have chosen; changing them would not make trading cheaper, only make the breakeven you are given wrong.
- Values outside the stated range, or moves larger than the stated step cap, are clamped or dropped. Propose realistic values rather than relying on the clamp.
- Parameters marked (INERT) do nothing in the current mode. Changing one wastes a whole measurement window on a change that cannot have an effect. They are listed because switching the mode itself is a valid proposal — but if you want a mode's settings to matter, change the mode first and tune it in a later round.
- If you believe something you cannot reach is the problem, say so in notes — a human reads them. A setting parked outside its allowed range is reachable: propose the nearest bound and it will be applied in one step.`;
