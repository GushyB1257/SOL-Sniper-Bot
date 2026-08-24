import type { Candle } from './data.js';
import { ema, roc, rollingMax, rollingMin, rsi, sma, stdev } from './indicators.js';

/**
 * The strategy catalogue: every classic retail tactic, parameterised.
 *
 * A strategy here is a pure function from history to a TARGET position —
 * +1 long, -1 short, 0 flat — decided on a closed candle. It receives its own
 * previous position so that hold-until-opposite strategies (Donchian, the
 * mean-reversion exits) can be expressed without hidden state: the backtester
 * and the live forward test call the same function with the same arguments,
 * which is what makes the backtest a rehearsal of the real thing rather than a
 * different program that shares a name with it.
 *
 * Families, and what each is actually a bet on:
 *
 *  - sma/ema cross    trend exists and persists (the classic golden cross)
 *  - donchian         breakouts continue (turtle-style channel breakout)
 *  - momentum         recent return predicts the next one
 *  - rsi_revert       stretched moves snap back
 *  - boll_revert      price returns to its rolling mean
 *  - vol_surge        unusual volume marks the start of a move, not the end
 *  - flow             aggressive taker buying leads price (the free stand-in
 *                     for whale watching — aggregate aggressor flow rather
 *                     than named wallets, which are paid data)
 *  - hold             the benchmark every one of the above has to beat
 */
export interface Strategy {
  id: string;
  family: string;
  /** Human description with the parameters inline, for the leaderboard. */
  label: string;
  /** Candles required before the first decision. */
  warmup: number;
  /** Whether this variant is allowed to go short. */
  shorts: boolean;
  signal: (i: number, prev: -1 | 0 | 1) => -1 | 0 | 1;
}

export interface StrategyContext {
  candles: readonly Candle[];
  closes: number[];
}

/** Memoises indicator arrays so 300 variants share ~30 computations. */
class SeriesCache {
  private cache = new Map<string, number[]>();
  constructor(private readonly ctx: StrategyContext) {}

  get(kind: string, period: number): number[] {
    const key = `${kind}:${period}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const closes = this.ctx.closes;
    let out: number[];
    if (kind === 'sma') out = sma(closes, period);
    else if (kind === 'ema') out = ema(closes, period);
    else if (kind === 'rsi') out = rsi(closes, period);
    else if (kind === 'sd') out = stdev(closes, period);
    else if (kind === 'roc') out = roc(closes, period);
    else if (kind === 'himax') out = rollingMax(this.ctx.candles.map((c) => c.h), period);
    else if (kind === 'lomin') out = rollingMin(this.ctx.candles.map((c) => c.l), period);
    else if (kind === 'volsma') out = sma(this.ctx.candles.map((c) => c.v), period);
    else if (kind === 'flowsma') {
      out = sma(this.ctx.candles.map((c) => (c.v > 0 ? c.tb / c.v : 0.5)), period);
    } else throw new Error(`unknown series ${kind}`);
    this.cache.set(key, out);
    return out;
  }
}

const longOnly = (p: -1 | 0 | 1): -1 | 0 | 1 => (p === -1 ? 0 : p);

/**
 * Builds the full catalogue over one candle history.
 *
 * `allowShorts=false` maps every short signal to flat rather than dropping the
 * variants: the long half of a long/short idea is still a strategy, and the
 * comparison between the two answers whether shorting earns its risk.
 */
export function buildCatalogue(ctx: StrategyContext, allowShorts: boolean): Strategy[] {
  const s = new SeriesCache(ctx);
  const closes = ctx.closes;
  const out: Strategy[] = [];

  const add = (
    id: string,
    family: string,
    label: string,
    warmup: number,
    raw: (i: number, prev: -1 | 0 | 1) => -1 | 0 | 1,
  ): void => {
    const shorts = allowShorts;
    out.push({
      id,
      family,
      label,
      warmup,
      shorts,
      signal: shorts ? raw : (i, prev) => longOnly(raw(i, longOnly(prev))),
    });
  };

  // --- trend: moving-average crosses ------------------------------------
  for (const [fast, slow] of [[12, 48], [24, 96], [48, 192], [24, 168], [72, 288]] as const) {
    add(`sma_${fast}_${slow}`, 'sma_cross', `SMA ${fast}/${slow}h cross`, slow + 1, (i) => {
      const f = s.get('sma', fast)[i]!;
      const sl = s.get('sma', slow)[i]!;
      if (Number.isNaN(f) || Number.isNaN(sl)) return 0;
      return f > sl ? 1 : -1;
    });
    add(`ema_${fast}_${slow}`, 'ema_cross', `EMA ${fast}/${slow}h cross`, slow + 1, (i) => {
      const f = s.get('ema', fast)[i]!;
      const sl = s.get('ema', slow)[i]!;
      if (Number.isNaN(f) || Number.isNaN(sl)) return 0;
      return f > sl ? 1 : -1;
    });
  }

  // --- trend: channel breakout ------------------------------------------
  for (const n of [24, 48, 96, 168]) {
    add(`donchian_${n}`, 'donchian', `Donchian ${n}h breakout`, n + 1, (i, prev) => {
      const hi = s.get('himax', n)[i]!;
      const lo = s.get('lomin', n)[i]!;
      if (Number.isNaN(hi) || Number.isNaN(lo)) return 0;
      if (closes[i]! > hi) return 1;
      if (closes[i]! < lo) return -1;
      return prev; // hold until the opposite band breaks
    });
  }

  // --- trend: raw momentum ----------------------------------------------
  for (const [n, thr] of [[24, 1.5], [24, 3], [72, 3], [168, 5]] as const) {
    add(`mom_${n}_${thr}`, 'momentum', `${n}h momentum > ${thr}%`, n + 1, (i) => {
      const r = s.get('roc', n)[i]!;
      if (Number.isNaN(r)) return 0;
      if (r > thr) return 1;
      if (r < -thr) return -1;
      return 0;
    });
  }

  // --- mean reversion: RSI ----------------------------------------------
  for (const [n, lo, hi] of [[14, 30, 70], [14, 25, 75], [6, 20, 80]] as const) {
    add(`rsi_${n}_${lo}_${hi}`, 'rsi_revert', `RSI(${n}) revert ${lo}/${hi}`, n + 2, (i, prev) => {
      const r = s.get('rsi', n)[i]!;
      if (Number.isNaN(r)) return 0;
      if (r < lo) return 1;
      if (r > hi) return -1;
      // Ride the snap-back to the midline, then stand aside.
      if (prev === 1 && r < 50) return 1;
      if (prev === -1 && r > 50) return -1;
      return 0;
    });
  }

  // --- mean reversion: Bollinger ----------------------------------------
  for (const [n, k] of [[20, 2], [48, 2], [20, 2.5]] as const) {
    add(`boll_${n}_${k}`, 'boll_revert', `Bollinger(${n}, ${k}σ) revert`, n + 1, (i, prev) => {
      const mid = s.get('sma', n)[i]!;
      const sd = s.get('sd', n)[i]!;
      if (Number.isNaN(mid) || Number.isNaN(sd) || sd === 0) return 0;
      if (closes[i]! < mid - k * sd) return 1;
      if (closes[i]! > mid + k * sd) return -1;
      // Hold until price recrosses the mean, which is the trade's whole thesis.
      if (prev === 1 && closes[i]! < mid) return 1;
      if (prev === -1 && closes[i]! > mid) return -1;
      return 0;
    });
  }

  // --- volume: surge in the direction of the candle ---------------------
  for (const [n, k] of [[48, 3], [96, 4]] as const) {
    add(`vol_${n}_${k}`, 'vol_surge', `Volume ${k}x over ${n}h avg`, n + 1, (i, prev) => {
      const av = s.get('volsma', n)[i]!;
      if (Number.isNaN(av) || av <= 0) return 0;
      const c = ctx.candles[i]!;
      if (c.v > k * av) return c.c > c.o ? 1 : -1;
      // Stay in while volume remains elevated; the move is over when the crowd leaves.
      if (prev !== 0 && c.v > av) return prev;
      return 0;
    });
  }

  // --- flow: aggregate aggressor buying (the free whale proxy) ----------
  for (const [n, hi] of [[24, 0.55], [48, 0.54], [12, 0.58]] as const) {
    add(`flow_${n}_${hi}`, 'flow', `Taker-buy flow(${n}h) > ${hi}`, n + 1, (i) => {
      const f = s.get('flowsma', n)[i]!;
      if (Number.isNaN(f)) return 0;
      if (f > hi) return 1;
      if (f < 1 - hi) return -1;
      return 0;
    });
  }

  // --- the benchmark -----------------------------------------------------
  out.push({
    id: 'hold',
    family: 'hold',
    label: 'Buy and hold',
    warmup: 1,
    shorts: false,
    signal: () => 1,
  });

  return out;
}
