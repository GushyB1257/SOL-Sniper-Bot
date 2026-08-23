import { z } from 'zod';
import type { ExitOrder, Position } from '../types.js';
import type { Config } from '../config.js';
import { pctChange } from '../util/solana.js';
import { breakevenGrossPct, costModel } from './costs.js';

/**
 * An exit strategy the tuner wrote itself.
 *
 * The built-in modes — ladder, ratchet, scalp — are three fixed opinions about
 * how a trade should end, and the tuner could only pick one and adjust its
 * numbers. It could not express "sell half if it doubles inside twenty seconds,
 * then hold the rest until it stops making new highs", which is a different
 * strategy rather than a different setting, and there was no way to find out
 * whether ideas like that work.
 *
 * So: a small language of conditions over facts the bot already knows about a
 * position, and an action that sells some share of it. The model composes the
 * rules; this file decides what they mean and what they are allowed to do.
 *
 * The line drawn here matters, so it is worth stating plainly. This is NOT the
 * model writing code that runs in the process — that process holds a wallet key
 * and signs transactions, and no amount of measured upside justifies executing
 * generated code inside it. What it gets instead is freedom over the STRATEGY:
 * any combination of the primitives below, in any order, with any thresholds.
 * The interpreter is fixed and audited; the strategy is not.
 *
 * Everything a ruleset does still runs through the same machinery as a scalar
 * change — measured against a baseline over TUNER_MIN_TRADES, and reverted
 * automatically if it does not beat it. An invented strategy that loses money
 * is undone the same way a bad threshold is.
 */

/** Facts a rule may test. Each is something the position already knows. */
export const METRICS = [
  /** Percent from entry price, right now. */
  'gainPct',
  /** Percent below the best price seen since entry. Zero or negative. */
  'drawdownFromPeakPct',
  /** The best gainPct reached at any point, whether or not it held. */
  'peakGainPct',
  /** Seconds since the position opened. */
  'heldSeconds',
  /** Seconds since the position last made a new high. */
  'secondsSincePeak',
  /** Percent of the ORIGINAL position already sold. */
  'soldPct',
  /** Average percent gained per second held — separates a fast move from a slow one. */
  'gainPctPerSec',
  /** Gross move needed just to cover the round trip at this position's size. */
  'breakevenPct',
  /** How far above (or below) that breakeven the position currently is. */
  'gainOverBreakevenPct',
  /** Market cap in SOL implied by the current price. */
  'mcapSol',
  /** Safety score the entry was admitted on. */
  'safetyScore',
  /** 1 when the original stake has been recovered, 0 otherwise. */
  'costRecovered',
] as const;

export type Metric = (typeof METRICS)[number];

export const ruleSchema = z.object({
  /** All conditions must hold. An empty list is refused — it would fire at once. */
  when: z
    .array(
      z.object({
        metric: z.enum(METRICS),
        op: z.enum(['>', '>=', '<', '<=']),
        value: z.number().finite(),
      }),
    )
    .min(1)
    .max(6),
  /** Percent of the ORIGINAL position to sell, or every remaining token. */
  sell: z.union([z.number().positive().max(100), z.literal('all')]),
  /** Shown in the log and the trade journal, and grouped on by the evidence. */
  label: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'label must be lowercase letters, digits and underscores'),
});

export type ExitRule = z.infer<typeof ruleSchema>;

export const rulesetSchema = z.array(ruleSchema).min(1).max(12);
export type Ruleset = z.infer<typeof rulesetSchema>;

export interface RulesetCheck {
  ok: boolean;
  error?: string;
  ruleset?: Ruleset;
  /** Things worth knowing that are not grounds for refusal. */
  warnings: string[];
}

/**
 * Parses and vets a ruleset.
 *
 * Refusals are limited to rulesets that cannot mean anything — malformed JSON,
 * an unknown metric, selling more than exists. Everything else is a warning,
 * including a ruleset with no downside rule at all. That is a strategy choice
 * the config already allows elsewhere (`RATCHET_STOP_LOSS_PCT=0` is exactly
 * it), and refusing it here would be this file deciding what strategies are
 * permissible, which is the thing it is explicitly not for. MAX_HOLD_SECONDS
 * still terminates every position regardless, and the risk manager's daily loss
 * limit and circuit breaker are untouched by anything written here.
 */
export function checkRuleset(raw: string): RulesetCheck {
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}`, warnings };
  }

  const result = rulesetSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((i) => `${i.path.join('.') || 'ruleset'}: ${i.message}`)
        .join('; '),
      warnings,
    };
  }
  const ruleset = result.data;

  // Partial sells are shares of the ORIGINAL position, so more than 100% across
  // them cannot be honoured — the later rules would find nothing left and the
  // strategy would not be the one that was measured.
  const partials = ruleset.filter((r) => r.sell !== 'all');
  const total = partials.reduce((a, r) => a + (r.sell as number), 0);
  if (total > 100) {
    return {
      ok: false,
      error: `partial sells total ${total}% of the original position, which exceeds 100%`,
      warnings,
    };
  }

  const labels = ruleset.map((r) => r.label);
  if (new Set(labels).size !== labels.length) {
    return { ok: false, error: 'two rules share a label; exits could not be told apart', warnings };
  }

  // A rule that can never be reached is not an error, but it is almost always a
  // mistake and it silently costs a whole measurement window.
  const firstCloseAll = ruleset.findIndex((r) => r.sell === 'all' && r.when.length === 1);
  if (firstCloseAll >= 0 && firstCloseAll < ruleset.length - 1) {
    const shadowed = ruleset[firstCloseAll]!;
    warnings.push(
      `rule "${shadowed.label}" closes the whole position on a single condition and ` +
        `${ruleset.length - firstCloseAll - 1} rule(s) sit below it; first match wins, so those ` +
        'only ever run when this one does not',
    );
  }

  const hasDownside = ruleset.some((r) =>
    r.when.some(
      (c) =>
        (c.metric === 'gainPct' && (c.op === '<' || c.op === '<=')) ||
        (c.metric === 'drawdownFromPeakPct' && (c.op === '<' || c.op === '<=')) ||
        (c.metric === 'gainOverBreakevenPct' && (c.op === '<' || c.op === '<=')),
    ),
  );
  if (!hasDownside) {
    warnings.push(
      'no rule tests the downside, so nothing here cuts a loser — positions that fall ' +
        'will be held until MAX_HOLD_SECONDS. That may be deliberate; it is not a default.',
    );
  }

  if (total < 100 && !ruleset.some((r) => r.sell === 'all')) {
    warnings.push(
      `no rule closes the position and the partials only sell ${total}% of it, so every ` +
        'trade ends at MAX_HOLD_SECONDS holding the remainder',
    );
  }

  return { ok: true, ruleset, warnings };
}

/** Everything a rule can test, computed once per evaluation. */
export function metricsFor(p: Position, price: number, cfg: Config, now: number): Record<Metric, number> {
  const gainPct = pctChange(p.entryPrice, price);
  const heldSeconds = Math.max(0.001, (now - p.openedAt) / 1000);
  const sold = p.originalQty > 0 ? ((p.originalQty - p.remainingQty) / p.originalQty) * 100 : 0;
  const breakevenPct = breakevenGrossPct(costModel(cfg, p.notionalSol ?? p.costSol));
  const supply = p.entryPrice > 0 && p.entryMarketCapSol ? p.entryMarketCapSol / p.entryPrice : 0;

  return {
    gainPct,
    drawdownFromPeakPct: p.peakPrice > 0 ? pctChange(p.peakPrice, price) : 0,
    peakGainPct: p.peakPrice > 0 ? pctChange(p.entryPrice, p.peakPrice) : 0,
    heldSeconds,
    // Falls back to the open time rather than to zero: before any new high the
    // honest answer is "it has not made one since it opened", and zero would
    // read as "it just made one", which is the opposite.
    secondsSincePeak: (now - (p.peakAt ?? p.openedAt)) / 1000,
    soldPct: sold,
    gainPctPerSec: gainPct / heldSeconds,
    breakevenPct,
    gainOverBreakevenPct: gainPct - breakevenPct,
    mcapSol: supply > 0 ? price * supply : 0,
    safetyScore: p.safetyScore,
    costRecovered: p.costRecovered ? 1 : 0,
  };
}

function holds(actual: number, op: ExitRule['when'][number]['op'], want: number): boolean {
  if (op === '>') return actual > want;
  if (op === '>=') return actual >= want;
  if (op === '<') return actual < want;
  return actual <= want;
}

/**
 * Runs a ruleset against a position. First match wins, as everywhere else in
 * the exit planner.
 *
 * A rule fires once. Without that a partial rule would sell its share on every
 * tick its condition held, draining the position in a few seconds through a
 * strategy nobody wrote — and the ladder has always worked this way, so the
 * semantics match what the rest of the file already means by a rung.
 */
export function decideCustomExit(
  ruleset: Ruleset,
  p: Position,
  price: number,
  cfg: Config,
  now: number,
): ExitOrder | null {
  const m = metricsFor(p, price, cfg, now);
  const fired = new Set(p.firedRules ?? []);

  for (let i = 0; i < ruleset.length; i++) {
    if (fired.has(i)) continue;
    const rule = ruleset[i]!;
    if (!rule.when.every((c) => holds(m[c.metric], c.op, c.value))) continue;

    const why = rule.when.map((c) => `${c.metric} ${c.op} ${c.value}`).join(' and ');
    const detail = `${why} (at ${m.gainPct.toFixed(1)}%)`;

    if (rule.sell === 'all') {
      return {
        mint: p.mint,
        positionId: p.id,
        qty: p.remainingQty,
        reason: 'custom_rule',
        closeAll: true,
        tierIndexes: [],
        ruleIndex: i,
        ruleLabel: rule.label,
        detail,
      };
    }

    const qty = Math.min(p.remainingQty, (p.originalQty * rule.sell) / 100);
    // Rounding, a dust balance, or a partial fill can leave less than the rule
    // asks for. Selling what remains is right; emitting a zero-quantity order
    // would mark the rule fired without selling anything.
    if (qty <= 0) continue;
    const closeAll = qty >= p.remainingQty;

    return {
      mint: p.mint,
      positionId: p.id,
      qty,
      reason: 'custom_rule',
      closeAll,
      tierIndexes: [],
      ruleIndex: i,
      ruleLabel: rule.label,
      detail: `sell ${rule.sell}% — ${detail}`,
    };
  }

  return null;
}
