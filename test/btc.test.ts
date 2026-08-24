import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BtcData, parseKlines, HOUR_MS, type Candle } from '../src/btc/data.js';
import { rollingMax, rollingMin, rsi, sma } from '../src/btc/indicators.js';
import { buildCatalogue, type Strategy } from '../src/btc/strategies.js';
import { runBacktest, sweep } from '../src/btc/backtest.js';
import { BtcBot } from '../src/btc/bot.js';
import { loadConfig, type Config } from '../src/config.js';

let dir: string;

const NOW = 1_756_000_800_000; // an exact hour boundary

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

/** Synthetic candles: one per hour ending an hour before NOW. */
function candlesFrom(closes: number[]): Candle[] {
  const t0 = NOW - closes.length * HOUR_MS;
  return closes.map((c, i) => {
    const o = i > 0 ? closes[i - 1]! : c;
    return {
      t: t0 + i * HOUR_MS,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 100,
      qv: 100 * c,
      n: 1000,
      tb: 50,
    };
  });
}

/** A raw Binance kline row for a candle. */
function rawKline(c: Candle): unknown[] {
  return [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v),
    c.t + HOUR_MS - 1, String(c.qv), c.n, String(c.tb), '0', '0'];
}

/** fetch stub serving `candles`, honouring startTime and limit like the API. */
function fetchServing(candles: Candle[], calls?: string[]): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    calls?.push(u.toString());
    const from = Number(u.searchParams.get('startTime') ?? 0);
    const limit = Number(u.searchParams.get('limit') ?? 1000);
    const batch = candles.filter((c) => c.t >= from).slice(0, limit).map(rawKline);
    return { ok: true, json: async () => batch } as Response;
  }) as typeof fetch;
}

const steadyUp = (n: number, step = 0.005): number[] => {
  const out: number[] = [];
  let p = 10_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + step;
    out.push(p);
  }
  return out;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-btc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('candle data', () => {
  it('parses the positional kline format', () => {
    const c = candlesFrom([100, 101])[1]!;
    const [parsed] = parseKlines([rawKline(c)]);
    expect(parsed).toEqual(c);
  });

  it('refuses malformed rows rather than trading on NaN', () => {
    expect(() => parseKlines([[0, 'x', '1', '1', 'nope', '1', 0, '1', 1, '1', '0', '0']])).toThrow();
  });

  it('fills from empty, then tops up incrementally from the last candle', async () => {
    const candles = candlesFrom(steadyUp(50));
    const calls: string[] = [];
    const data = new BtcData({ dataDir: dir, symbol: 'BTCUSDT', fetchFn: fetchServing(candles, calls), now: () => NOW });

    expect(await data.refresh(365)).toBe(50);

    calls.length = 0;
    await data.refresh(365);
    // The second refresh asks only for what is missing — from the last cached
    // candle, not from a year ago. This is what keeps steady state at one
    // small request rather than nine big ones every poll.
    const from = Number(new URL(calls[0]!).searchParams.get('startTime'));
    expect(from).toBe(candles[candles.length - 1]!.t);
  });

  it('keeps its candles and reports the error when every host fails', async () => {
    const good = new BtcData({ dataDir: dir, symbol: 'BTCUSDT', fetchFn: fetchServing(candlesFrom(steadyUp(30))), now: () => NOW });
    await good.refresh(365);

    const bad = new BtcData({
      dataDir: dir,
      symbol: 'BTCUSDT',
      fetchFn: (async () => { throw new Error('offline'); }) as typeof fetch,
      now: () => NOW,
    });
    // Loaded from the cache the first instance saved — a restart does not
    // refetch a year of data, and an outage does not blank the strategies.
    expect(bad.all().length).toBe(30);
    expect(await bad.refresh(365)).toBe(0);
    expect(bad.all().length).toBe(30);
    expect(bad.lastError).toMatch(/offline/);
  });

  it('excludes the still-forming candle from closed()', async () => {
    const candles = candlesFrom(steadyUp(10));
    // A candle that opened 30 minutes ago is still forming.
    candles.push({ ...candles[9]!, t: NOW - HOUR_MS / 2 });
    const data = new BtcData({ dataDir: dir, symbol: 'BTCUSDT', fetchFn: fetchServing(candles), now: () => NOW });
    await data.refresh(365);
    expect(data.all().length).toBe(11);
    expect(data.closed().length).toBe(10);
  });
});

// ---------------------------------------------------------------------------

describe('indicators', () => {
  it('sma of a constant is the constant, after warmup', () => {
    const out = sma([5, 5, 5, 5, 5], 3);
    expect(out[1]).toBeNaN();
    expect(out[4]).toBe(5);
  });

  it('rsi of a straight rise saturates high', () => {
    const out = rsi(steadyUp(30), 14);
    expect(out[29]).toBeGreaterThan(95);
  });

  it('rolling extremes exclude the current candle', () => {
    // Breakouts compare NOW against the PREVIOUS n candles; a window that
    // includes the current high can never be broken out of.
    expect(rollingMax([1, 2, 3], 2)[2]).toBe(2);
    expect(rollingMin([3, 2, 1], 2)[2]).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('backtester', () => {
  const always = (pos: -1 | 0 | 1, warmup = 1): Strategy => ({
    id: 't', family: 't', label: 't', warmup, shorts: true, signal: () => pos,
  });
  const OPTS = { feeBps: 10, slippageBps: 2 };

  it('long makes money in an uptrend, net of costs', () => {
    const r = runBacktest(candlesFrom(steadyUp(200)), always(1), OPTS);
    expect(r.netPct).toBeGreaterThan(50);
    expect(r.exposurePct).toBeCloseTo(100, 0);
  });

  it('short makes money in a downtrend', () => {
    const down = steadyUp(200).reverse();
    const r = runBacktest(candlesFrom(down), always(-1), OPTS);
    expect(r.netPct).toBeGreaterThan(0);
  });

  it('charges costs on every position change', () => {
    // Flat prices, flipping every candle: gross is zero, so the result is
    // exactly the cost drag — the thing naive backtests forget and the reason
    // most published "profitable" strategies are not.
    const flat = new Array(101).fill(10_000);
    const flip: Strategy = {
      id: 'f', family: 'f', label: 'f', warmup: 1, shorts: true,
      signal: (i) => (i % 2 === 0 ? 1 : -1),
    };
    const r = runBacktest(candlesFrom(flat), flip, OPTS);
    expect(r.netPct).toBeLessThan(-15);
  });

  it('confines trading to the requested window', () => {
    const seen: number[] = [];
    const spy: Strategy = {
      id: 's', family: 's', label: 's', warmup: 1, shorts: true,
      signal: (i) => { seen.push(i); return 0; },
    };
    runBacktest(candlesFrom(steadyUp(100)), spy, { ...OPTS, startIndex: 60, endIndex: 80 });
    expect(Math.min(...seen)).toBe(60);
    expect(Math.max(...seen)).toBe(79);
  });

  it('closes an open position at the end so losers cannot hide unsold', () => {
    const down = steadyUp(50).reverse();
    const r = runBacktest(candlesFrom(down), always(1), OPTS);
    expect(r.trades).toBe(1);
    expect(r.winRatePct).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the sweep', () => {
  const candles = candlesFrom([...steadyUp(700), ...steadyUp(340).reverse()]);
  const ctx = { candles, closes: candles.map((c) => c.c) };

  it('ranks by train score and withholds the test window from the ranking', () => {
    const result = sweep(candles, buildCatalogue(ctx, true), { feeBps: 10, slippageBps: 2 });

    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.score).toBeGreaterThanOrEqual(result.rows[i]!.score);
    }
    expect(result.splitIndex).toBe(Math.floor(candles.length * 0.7));
    // Every row carries both windows — the test column is the honest one.
    expect(result.rows[0]!.test.bars).toBeGreaterThan(0);
  });

  it('includes buy-and-hold as the benchmark', () => {
    const result = sweep(candles, buildCatalogue(ctx, true), { feeBps: 10, slippageBps: 2 });
    // Train window is a pure uptrend, so the benchmark must show it.
    expect(result.benchmark.train.netPct).toBeGreaterThan(0);
    // And the test window is a pure downtrend.
    expect(result.benchmark.test.netPct).toBeLessThan(0);
  });

  it('lets shorts profit where long-only cannot', () => {
    const down = candlesFrom(steadyUp(500).reverse());
    const dctx = { candles: down, closes: down.map((c) => c.c) };
    const ls = sweep(down, buildCatalogue(dctx, true), { feeBps: 10, slippageBps: 2 });
    const lo = sweep(down, buildCatalogue(dctx, false), { feeBps: 10, slippageBps: 2 });
    expect(ls.rows[0]!.train.netPct).toBeGreaterThan(lo.rows[0]!.train.netPct);
  });
});

// ---------------------------------------------------------------------------

describe('the lab bot', () => {
  const history = candlesFrom([...steadyUp(700), ...steadyUp(340).reverse()]);

  function bot(over: { candles?: Candle[]; now?: () => number; cfg?: Config } = {}): BtcBot {
    const cfg = over.cfg ?? loadConfig(env({ BOT_BTC_ENABLED: 'true', BTC_TOP_STRATEGIES: '4' }));
    return new BtcBot({
      cfg,
      dataDir: dir,
      fetchFn: fetchServing(over.candles ?? history),
      now: over.now ?? (() => NOW),
    });
  }

  it('sweeps on first tick and puts the winners forward, never the benchmark', async () => {
    const b = bot();
    await b.tick();

    const v = b.view();
    expect(v.leaderboard.length).toBeGreaterThan(0);
    expect(v.sweepAt).toBe(NOW);
    expect(v.benchmark).not.toBeNull();

    const forwardIds = v.forward.map((f) => f.id);
    expect(forwardIds.length).toBe(4);
    // 'hold' is the bar, not a contestant: a forward slot spent confirming
    // that buy-and-hold holds is a slot wasted.
    expect(forwardIds).not.toContain('hold');
  });

  it('advances the forward test on new candles with the same fill rules', async () => {
    let now = NOW;
    const candles = [...history];
    const b = bot({ candles, now: () => now });
    await b.tick();
    const before = b.view().forward.map((f) => ({ id: f.id, equityUsd: f.equityUsd }));

    // Sixty new hours of hard reversal — enough for any active strategy to
    // mark to market, and for most to trade.
    const last = candles[candles.length - 1]!;
    let price = last.c;
    for (let i = 1; i <= 60; i++) {
      price *= 0.99;
      const t = last.t + i * HOUR_MS;
      candles.push({ t, o: price / 0.99, h: price / 0.99, l: price, c: price, v: 100, qv: price * 100, n: 1000, tb: 20 });
    }
    now = NOW + 60 * HOUR_MS;
    await b.tick();

    const after = b.view().forward;
    const moved = after.filter((f) => {
      const prev = before.find((p) => p.id === f.id);
      return prev && Math.abs(f.equityUsd - prev.equityUsd) > 1e-9;
    });
    // At least one of the four graduated strategies was in a position through
    // a 45% drawdown — equities that all sat perfectly still would mean the
    // forward test is not actually running.
    expect(moved.length).toBeGreaterThan(0);
  });

  it('survives a restart with its sweep and forward record intact', async () => {
    const b = bot();
    await b.tick();
    const fillsBefore = b.view().forward.length;

    const b2 = bot();
    const v = b2.view();
    // The forward test's whole value is that it accumulates on data nobody
    // could pick. Losing it on restart would reset the only honest clock.
    expect(v.sweepAt).toBe(NOW);
    expect(v.forward.length).toBe(fillsBefore);
    expect(v.leaderboard.length).toBeGreaterThan(0);
  });

  it('does not re-sweep before BTC_SWEEP_HOURS has passed', async () => {
    let now = NOW;
    const b = bot({ now: () => now });
    await b.tick();
    const first = b.view().sweepAt;

    now = NOW + 2 * HOUR_MS; // default is 24h
    await b.tick();
    expect(b.view().sweepAt).toBe(first);

    now = NOW + 25 * HOUR_MS;
    await b.tick();
    expect(b.view().sweepAt).toBe(now);
  });
});
