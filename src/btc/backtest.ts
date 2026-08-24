import type { Candle } from './data.js';
import type { Strategy } from './strategies.js';

/**
 * Replays a strategy over candles and reports what it would have made.
 *
 * The fill model is stated rather than hidden, because it is where backtests
 * lie: a decision made on candle i fills AT THAT CANDLE'S CLOSE, and every unit
 * of position change pays `feeBps + slippageBps`. On hourly candles the gap
 * between a close and the next open is negligible next to those costs; the
 * costs are not, and charging them is what separates this from the backtests
 * that make every strategy look rich.
 */
export interface BacktestOptions {
  feeBps: number;
  slippageBps: number;
  /** Trade only inside [startIndex, endIndex). Indicators still see it all. */
  startIndex?: number;
  endIndex?: number;
}

export interface BtcBacktestResult {
  netPct: number;
  maxDrawdownPct: number;
  /** Completed round trips (entry to flat or flip). */
  trades: number;
  winRatePct: number;
  /** Share of candles spent holding a position at all. */
  exposurePct: number;
  /** Annualised mean/sd of hourly returns. Rough, but comparable across rows. */
  sharpe: number;
  /** Candles evaluated. */
  bars: number;
}

export function runBacktest(
  candles: readonly Candle[],
  strategy: Strategy,
  opts: BacktestOptions,
): BtcBacktestResult {
  const start = Math.max(opts.startIndex ?? 0, strategy.warmup);
  const end = Math.min(opts.endIndex ?? candles.length, candles.length);
  const costPerUnit = (opts.feeBps + opts.slippageBps) / 10_000;

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let pos: -1 | 0 | 1 = 0;
  let entryEquity = 1;
  let trades = 0;
  let wins = 0;
  let exposed = 0;
  let retSum = 0;
  let retSumSq = 0;
  let steps = 0;

  for (let i = start; i < end; i++) {
    // P&L for the candle just closed, under the position decided last candle.
    if (i > start) {
      const r = (candles[i]!.c - candles[i - 1]!.c) / candles[i - 1]!.c;
      const stepRet = pos * r;
      equity *= 1 + stepRet;
      retSum += stepRet;
      retSumSq += stepRet * stepRet;
      steps += 1;
      if (pos !== 0) exposed += 1;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (peak - equity) / peak);
    }

    const target = strategy.signal(i, pos);
    if (target !== pos) {
      equity *= 1 - Math.abs(target - pos) * costPerUnit;
      // A flip closes one round trip and opens the next in the same fill.
      if (pos !== 0) {
        trades += 1;
        if (equity > entryEquity) wins += 1;
      }
      if (target !== 0) entryEquity = equity;
      pos = target;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (peak - equity) / peak);
    }
  }

  // A position still open at the end is closed at the last price, so a
  // strategy cannot hide a loser by never selling it.
  if (pos !== 0) {
    equity *= 1 - costPerUnit;
    trades += 1;
    if (equity > entryEquity) wins += 1;
  }

  const bars = Math.max(0, end - start);
  const mean = steps > 0 ? retSum / steps : 0;
  const sd = steps > 1 ? Math.sqrt(Math.max(0, retSumSq / steps - mean * mean)) : 0;

  return {
    netPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    trades,
    winRatePct: trades > 0 ? (wins / trades) * 100 : 0,
    exposurePct: steps > 0 ? (exposed / steps) * 100 : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0,
    bars,
  };
}

export interface SweepRow {
  id: string;
  family: string;
  label: string;
  train: BtcBacktestResult;
  test: BtcBacktestResult;
  /** What the leaderboard sorts by. */
  score: number;
}

export interface SweepResult {
  rows: SweepRow[];
  /** Buy-and-hold over the same two windows — the bar everything must clear. */
  benchmark: { train: BtcBacktestResult; test: BtcBacktestResult };
  trainBars: number;
  testBars: number;
  splitIndex: number;
}

/**
 * Return penalised by drawdown. A strategy up 40% having been down 35% along
 * the way is not better than one up 30% that was never down 10 — not for a
 * bankroll that has to survive the path as well as arrive.
 */
function scoreOf(r: BtcBacktestResult): number {
  return r.netPct - r.maxDrawdownPct / 2;
}

/**
 * Backtests every variant with a train/test split, ranked on TRAIN.
 *
 * The split is the honesty mechanism. Trying hundreds of variants over one
 * window and picking the best is guaranteed to find something that fit that
 * window's noise; the last 30% is withheld from the choice, so the `test`
 * column is an out-of-sample read for the winners. Ranking is BY TRAIN on
 * purpose — ranking by test would just move the overfit one window to the
 * right. Selection happens on data the choice never saw, once: in the forward
 * paper test.
 */
export function sweep(
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  opts: { feeBps: number; slippageBps: number; trainFraction?: number },
): SweepResult {
  const split = Math.floor(candles.length * (opts.trainFraction ?? 0.7));
  const base = { feeBps: opts.feeBps, slippageBps: opts.slippageBps };

  const rows: SweepRow[] = strategies.map((st) => {
    const train = runBacktest(candles, st, { ...base, endIndex: split });
    const test = runBacktest(candles, st, { ...base, startIndex: split });
    return { id: st.id, family: st.family, label: st.label, train, test, score: scoreOf(train) };
  });
  rows.sort((a, b) => b.score - a.score);

  const hold = strategies.find((s) => s.id === 'hold');
  const benchRow = hold
    ? {
        train: runBacktest(candles, hold, { ...base, endIndex: split }),
        test: runBacktest(candles, hold, { ...base, startIndex: split }),
      }
    : { train: rows[0]!.train, test: rows[0]!.test };

  return {
    rows,
    benchmark: benchRow,
    trainBars: split,
    testBars: candles.length - split,
    splitIndex: split,
  };
}
