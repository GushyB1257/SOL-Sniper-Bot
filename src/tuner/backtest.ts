import type { Config } from '../config.js';
import type { Position, PricePoint, TradeJournalEntry } from '../types.js';
import { decideExit } from '../strategy/exit-planner.js';
import { checkRuleset } from '../strategy/custom-exit.js';
import { costModel, roundTripCostSol } from '../strategy/costs.js';

/**
 * Replays an exit strategy over the price paths of trades that already
 * happened.
 *
 * What makes this honest rather than a story: the entry is left exactly as it
 * was. Only the exit is re-decided. A backtest that also re-picked entries
 * would be choosing which trades to include using knowledge of how they turned
 * out, and every such backtest is profitable.
 *
 * The remaining limitation is real and is reported rather than hidden. A
 * recorded path runs from the entry to the exit the OLD strategy chose, and
 * then onward for as long as the aftermath tracker followed the token — thirty
 * minutes by default. Beyond that there is no data. A candidate strategy that
 * would still be holding when the path ends is marked TRUNCATED and valued at
 * the last known price, which is neither optimistic nor pessimistic but IS a
 * guess, so the coverage figure travels with every result.
 */

export interface BacktestResult {
  /** Trades that had a usable path. */
  trades: number;
  /** Journal rows skipped for want of a path — pre-dating recording, mostly. */
  skipped: number;
  netSol: number;
  expectancySol: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  /** Simulated exits that ran off the end of the recorded data. */
  truncated: number;
  /** Share of simulated trades that reached a real exit decision. */
  coveragePct: number;
  /** How often each rule (or built-in reason) fired. */
  byReason: Record<string, number>;
}

/**
 * Rebuilds a position as it stood at entry, so the planner can be run against
 * it with no knowledge of the future.
 */
function positionAt(t: TradeJournalEntry, cfg: Config): Position {
  const entryPrice = t.path![0]![1];
  return {
    id: t.positionId,
    mint: t.mint,
    symbol: t.symbol,
    creator: t.creator,
    pool: 'pump',
    status: 'open',
    costSol: t.costSol,
    notionalSol: t.costSol,
    originalQty: t.costSol / entryPrice,
    remainingQty: t.costSol / entryPrice,
    entryPrice,
    entryMarketCapSol: t.exitMcapSol,
    openedAt: 0,
    peakPrice: entryPrice,
    peakAt: 0,
    lastPrice: entryPrice,
    lastPriceAt: 0,
    ladder: cfg.EXIT_LADDER.map((tier) => ({ ...tier, filled: false })),
    moonbagArmed: false,
    realizedSol: 0,
    safetyScore: t.safetyScore,
    notes: [],
    firedRules: [],
    checkpointAt: 0,
    checkpointPrice: entryPrice,
    costRecovered: false,
  } as Position;
}

/** One trade replayed. Returns proceeds in SOL, and how it ended. */
function replay(
  t: TradeJournalEntry,
  cfg: Config,
): { proceedsSol: number; reason: string; truncated: boolean } {
  const path = t.path!;
  const p = positionAt(t, cfg);
  let proceeds = 0;
  let reason = '';

  for (const [seconds, price] of path) {
    const now = seconds * 1000;
    if (price > p.peakPrice) {
      p.peakPrice = price;
      p.peakAt = now;
    }
    p.lastPrice = price;
    p.lastPriceAt = now;

    // The ratchet advances its window on the real clock; without this a
    // backtest of ratchet mode would never reach a checkpoint at all.
    if (cfg.EXIT_MODE === 'ratchet' && now - (p.checkpointAt ?? 0) >= cfg.CHECKPOINT_SECONDS * 1000) {
      p.checkpointAt = now;
      p.checkpointPrice = price;
    }

    const order = decideExit({ position: p, price, cfg, now });
    if (!order) continue;

    const qty = order.closeAll ? p.remainingQty : Math.min(order.qty, p.remainingQty);
    proceeds += qty * price;
    p.remainingQty -= qty;
    p.realizedSol = proceeds;
    if (order.ruleIndex !== undefined) p.firedRules = [...(p.firedRules ?? []), order.ruleIndex];
    for (const i of order.tierIndexes) if (p.ladder[i]) p.ladder[i]!.filled = true;
    if (p.ladder.length > 0 && p.ladder.every((x) => x.filled)) p.moonbagArmed = true;
    if (proceeds >= p.costSol) p.costRecovered = true;
    if (!reason) reason = order.ruleLabel ?? order.reason;

    if (p.remainingQty <= 0) return { proceedsSol: proceeds, reason, truncated: false };
  }

  // Ran off the end still holding. Valued at the last known price — a guess,
  // and counted as one so the coverage figure can say how much of the result
  // rests on guesses.
  const last = path[path.length - 1]![1];
  return {
    proceedsSol: proceeds + p.remainingQty * last,
    reason: reason || 'still_holding',
    truncated: true,
  };
}

/**
 * Runs `cfg`'s exit strategy over every trade with a recorded path.
 *
 * Costs are charged from the same model live trading uses, so a strategy that
 * only wins before fees loses here too — which is the failure mode that has
 * dominated this bot's results and the one a naive backtest would hide.
 */
export function backtest(
  journal: readonly TradeJournalEntry[],
  cfg: Config,
  limit = 400,
): BacktestResult {
  const usable = journal.filter((t) => t.path && t.path.length >= 3).slice(-limit);
  const skipped = journal.length - usable.length;

  const empty: BacktestResult = {
    trades: 0,
    skipped,
    netSol: 0,
    expectancySol: 0,
    winRatePct: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    truncated: 0,
    coveragePct: 0,
    byReason: {},
  };
  if (usable.length === 0) return empty;

  const byReason: Record<string, number> = {};
  const pnls: number[] = [];
  const pcts: number[] = [];
  let truncated = 0;

  for (const t of usable) {
    const { proceedsSol, reason, truncated: cut } = replay(t, cfg);
    const fees = roundTripCostSol(costModel(cfg, t.costSol));
    const pnl = proceedsSol - t.costSol - fees;
    pnls.push(pnl);
    pcts.push((pnl / t.costSol) * 100);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (cut) truncated += 1;
  }

  const wins = pcts.filter((x) => x > 0);
  const losses = pcts.filter((x) => x <= 0);
  const netSol = pnls.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    trades: usable.length,
    skipped,
    netSol,
    expectancySol: netSol / usable.length,
    winRatePct: (wins.length / usable.length) * 100,
    avgWinPct: mean(wins),
    avgLossPct: mean(losses),
    truncated,
    coveragePct: ((usable.length - truncated) / usable.length) * 100,
    byReason,
  };
}

/** Backtests a candidate ruleset without disturbing the live config. */
export function backtestRuleset(
  journal: readonly TradeJournalEntry[],
  cfg: Config,
  rulesJson: string,
): { ok: boolean; error?: string; result?: BacktestResult } {
  const check = checkRuleset(rulesJson);
  if (!check.ok) return { ok: false, error: check.error };
  return {
    ok: true,
    result: backtest(journal, { ...cfg, EXIT_MODE: 'custom', EXIT_RULES: rulesJson }),
  };
}

/**
 * What the trades that actually happened produced, on the same cost basis.
 *
 * The only fair comparison for a backtest. Comparing a simulated net against
 * the journal's recorded net would compare two different accountings and
 * flatter whichever one charged less.
 */
export function actualResult(journal: readonly TradeJournalEntry[], limit = 400): BacktestResult {
  const usable = journal.filter((t) => t.path && t.path.length >= 3).slice(-limit);
  if (usable.length === 0) {
    return {
      trades: 0, skipped: 0, netSol: 0, expectancySol: 0, winRatePct: 0,
      avgWinPct: 0, avgLossPct: 0, truncated: 0, coveragePct: 0, byReason: {},
    };
  }
  const pnls = usable.map((t) => t.pnlSol);
  const pcts = usable.map((t) => t.pnlPct);
  const wins = pcts.filter((x) => x > 0);
  const byReason: Record<string, number> = {};
  for (const t of usable) {
    const key = t.closeReason.split(':')[0]?.trim() || 'unknown';
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  const net = pnls.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    trades: usable.length,
    skipped: 0,
    netSol: net,
    expectancySol: net / usable.length,
    winRatePct: (wins.length / usable.length) * 100,
    avgWinPct: mean(wins),
    avgLossPct: mean(pcts.filter((x) => x <= 0)),
    truncated: 0,
    coveragePct: 100,
    byReason,
  };
}
