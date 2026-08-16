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
import { TUNABLES, vetProposal } from './limits.js';
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
}

export interface TunerDeps {
  cfg: Config;
  settings: RuntimeSettings;
  /** Each bot's own journal — they are tuned separately, on their own data. */
  stores: Map<string, Store>;
  dataDir: string;
}

const proposalSchema = z.object({
  changes: z
    .array(
      z.object({
        key: z.string(),
        value: z.number(),
        why: z.string().min(1),
      }),
    )
    .max(8),
  notes: z.array(z.string()).max(5).optional(),
});

type Proposal = z.infer<typeof proposalSchema>;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    changes: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'why'],
        properties: {
          key: { type: 'string' },
          value: { type: 'number' },
          why: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', maxItems: 5, items: { type: 'string' } },
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

      if (open) {
        const after = journal.length - open.journalAtStart;
        out[bot] = {
          phase: 'measuring',
          trades: after,
          needed: cfg.TUNER_MIN_TRADES,
          since: open.startedAt,
        };
        continue;
      }

      const since = this.tradesSinceLastChange(bot, journal);
      out[bot] = {
        phase: since.length >= cfg.TUNER_MIN_TRADES ? 'ready' : 'gathering',
        trades: since.length,
        needed: cfg.TUNER_MIN_TRADES,
      };
    }
    return out;
  }

  /** When the next review is due, in epoch ms. */
  get nextRunAt(): number {
    return this.lastRunAt + this.deps.cfg.TUNER_INTERVAL_MINUTES * 60_000;
  }

  /** Called on a timer. Never throws into the caller. */
  async tick(): Promise<void> {
    const { cfg } = this.deps;
    if (!cfg.AUTO_TUNE_ENABLED) return;
    if (this.running) return;

    const due = Date.now() - this.lastRunAt >= cfg.TUNER_INTERVAL_MINUTES * 60_000;
    if (!due) return;

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
  private wasReverted(bot: string, key: string, value: number): boolean {
    return this.ledger
      .all()
      .filter((e) => e.bot === bot && e.status === 'reverted')
      .slice(-10)
      .some((e) => e.changes.some((c) => c.key === key && c.to === value));
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

    const catalogue = knobs
      .map(
        (t) =>
          `  ${t.key} = ${current[t.key] ?? '?'}  ` +
          `[allowed ${t.min}..${t.max}, max ${t.maxStepPct}% move this round]\n    ${t.what}`,
      )
      .join('\n');

    const result = await this.claude.ask<Proposal>(
      {
        label: `tuner:${bot}`,
        system: SYSTEM,
        maxTokens: 2000,
        jsonSchema: JSON_SCHEMA,
        userContent:
          `${renderEvidence(evidence)}\n\n` +
          `PARAMETERS YOU MAY CHANGE (current value, hard range, step cap):\n${catalogue}\n\n` +
          `WHAT HAS ALREADY BEEN TRIED ON THIS BOT:\n${this.historyFor(bot)}\n\n` +
          'A change marked REVERTED was measured and did not beat its baseline. Do not ' +
          'propose it again — it will be refused. Build on what was KEPT.\n\n' +
          `Propose at most ${this.deps.cfg.TUNER_MAX_CHANGES_PER_ROUND} changes, or none. ` +
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
      const now = Number(current[c.key]);
      if (!Number.isFinite(now)) {
        log.warn(`${bot}: proposed ${c.key}, which has no current numeric value — ignored`);
        continue;
      }
      const vet = vetProposal(c.key, now, c.value, cfg.TUNER_MAX_STEP_PCT);
      if (!vet.ok) {
        log.info(`${bot}: rejected ${c.key}=${c.value} — ${vet.reason}`);
        continue;
      }
      // Belt and braces against the obvious loop: propose, revert, propose the
      // same thing again forever. The prompt is told what was reverted, but a
      // prompt is a request and this is a rule.
      if (this.wasReverted(bot, c.key, vet.value)) {
        log.info(`${bot}: rejected ${c.key}=${vet.value} — already tried and reverted`);
        continue;
      }
      out.push({ key: c.key, from: now, to: vet.value, why: c.why, clamped: vet.clamped });
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

const SYSTEM = `You tune the strategy parameters of a Solana memecoin trading bot from its own closed-trade history.

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
- You cannot change position size, the number of concurrent positions, the daily loss limit, the hourly spend cap, the loss-streak breaker, the wallet reserve, slippage, or the stop loss. If you believe one of those is the problem, say so in notes — a human will read them.
- Values outside the stated range, or moves larger than the stated step cap, are clamped or dropped. Propose realistic numbers rather than relying on the clamp.`;
