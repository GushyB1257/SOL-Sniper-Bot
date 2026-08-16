import type { Config } from '../config.js';

/**
 * Round-trip cost model.
 *
 * For a quick in-and-out strategy this is not a detail — it is most of the
 * trade. Per side you pay the pump.fun program fee, the router fee if the
 * transaction was built by one, and a priority fee that is FIXED per
 * transaction and therefore punishes small positions hardest.
 *
 * With S the SOL notional, f the per-side proportional fee, p the priority fee
 * per transaction and m the gross price multiple at exit:
 *
 *   cost basis   = S(1 + f) + p
 *   net proceeds = S·m(1 - f) - p
 *   net PnL      = S[m(1 - f) - (1 + f)] - 2p
 *
 * Everything below falls out of that. The headline consequence: at 0.05 SOL
 * with a 0.0008 priority fee you need a **6.3% gross move just to break even**,
 * so a "quick 5% scalp" at that size is a guaranteed loss no matter how well
 * the entry is timed.
 */

export interface CostModel {
  /** Proportional fee charged on each side, as a fraction (0.015 = 1.5%). */
  perSideFee: number;
  /** Fixed SOL cost per transaction. */
  priorityFeeSol: number;
  /** SOL notional committed to the position. */
  notionalSol: number;
}

export function costModel(cfg: Config, notionalSol = cfg.BUY_AMOUNT_SOL): CostModel {
  return {
    perSideFee: (cfg.PROGRAM_FEE_PCT + cfg.ROUTER_FEE_PCT) / 100,
    priorityFeeSol: cfg.PRIORITY_FEE_SOL,
    notionalSol,
  };
}

/** Total SOL burned on fees over one full in-and-out at zero price movement. */
export function roundTripCostSol(m: CostModel): number {
  return m.notionalSol * 2 * m.perSideFee + 2 * m.priorityFeeSol;
}

/**
 * The gross price move, in percent, that merely gets you back to flat.
 * Anything below this is a losing trade even though the chart went up.
 */
export function breakevenGrossPct(m: CostModel): number {
  if (m.notionalSol <= 0) return Infinity;
  const f = m.perSideFee;
  if (f >= 1) return Infinity;
  return (((1 + f + (2 * m.priorityFeeSol) / m.notionalSol) / (1 - f)) - 1) * 100;
}

/**
 * The gross move needed to clear costs AND bank `netPct` of the notional.
 * This is what the scalp exit actually triggers on: you name a net return, the
 * bot works out what the chart has to do to deliver it.
 */
export function targetGrossPct(m: CostModel, netPct: number): number {
  if (m.notionalSol <= 0) return Infinity;
  const f = m.perSideFee;
  if (f >= 1) return Infinity;
  return (
    (((1 + f + (2 * m.priorityFeeSol) / m.notionalSol + netPct / 100) / (1 - f)) - 1) * 100
  );
}

/** Net SOL PnL for a completed round trip at gross price move `grossPct`. */
export function netPnlSol(m: CostModel, grossPct: number): number {
  const f = m.perSideFee;
  return m.notionalSol * ((1 + grossPct / 100) * (1 - f) - (1 + f)) - 2 * m.priorityFeeSol;
}

/** Share of round-trip cost that is the fixed priority fee, not the percentage. */
export function fixedCostShare(m: CostModel): number {
  const total = roundTripCostSol(m);
  return total > 0 ? (2 * m.priorityFeeSol) / total : 0;
}

/**
 * Win rate a scalp needs just to break even, given its target and stop.
 *
 * "Volume trading, small profits each time" is sold on not needing to pick
 * winners. That is only true up to a point: a tight target against a wider stop
 * needs a HIGH hit rate, and every trade pays the fee twice. Check a config
 * against this before running it — the number is usually sobering.
 */
export function requiredWinRatePct(m: CostModel, netTargetPct: number, stopPct: number): number {
  const win = netPnlSol(m, targetGrossPct(m, netTargetPct));
  const loss = netPnlSol(m, -stopPct);
  const denom = win - loss;
  if (denom <= 0) return 100;
  return Math.min(100, Math.max(0, (-loss / denom) * 100));
}
