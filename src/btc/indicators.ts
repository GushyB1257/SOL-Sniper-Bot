/**
 * Indicator primitives, all returning full-length arrays with NaN where the
 * lookback is not yet satisfied.
 *
 * Everything here is O(n) — rolling sums and monotonic deques rather than
 * per-point rescans — because the sweep runs a few hundred strategy variants
 * over ~9,000 candles, and an O(n·window) SMA would turn a two-second sweep
 * into a minute-long one.
 */

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      seed += values[i]!;
      if (i === period - 1) out[i] = seed / period;
      continue;
    }
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: readonly number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const up = Math.max(0, d);
    const down = Math.max(0, -d);
    if (i <= period) {
      gain += up;
      loss += down;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
      continue;
    }
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + down) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Rolling standard deviation, for Bollinger bands. */
export function stdev(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    sumSq += values[i]! * values[i]!;
    if (i >= period) {
      sum -= values[i - period]!;
      sumSq -= values[i - period]! * values[i - period]!;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
    }
  }
  return out;
}

/** Highest value over the PREVIOUS `period` entries — excludes the current. */
export function rollingMax(values: readonly number[], period: number): number[] {
  return rollingExtreme(values, period, (a, b) => a >= b);
}

/** Lowest value over the PREVIOUS `period` entries — excludes the current. */
export function rollingMin(values: readonly number[], period: number): number[] {
  return rollingExtreme(values, period, (a, b) => a <= b);
}

function rollingExtreme(
  values: readonly number[],
  period: number,
  beats: (a: number, b: number) => boolean,
): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const deque: number[] = []; // indexes, best at the front
  for (let i = 0; i < values.length; i++) {
    // The window for index i is [i-period, i-1]: breakout strategies compare
    // the CURRENT candle against the previous N, and a window including the
    // current value can never be broken out of.
    if (i >= period) out[i] = values[deque[0]!]!;
    while (deque.length > 0 && beats(values[i]!, values[deque[deque.length - 1]!]!)) deque.pop();
    deque.push(i);
    while (deque[0]! <= i - period) deque.shift();
  }
  return out;
}

/** Percent change over `period` entries. */
export function roc(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const base = values[i - period]!;
    out[i] = base > 0 ? ((values[i]! - base) / base) * 100 : NaN;
  }
  return out;
}
