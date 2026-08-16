import { describe, it, expect, beforeEach } from 'vitest';
import { momentumSignal, measureWindow } from '../src/strategy/momentum.js';
import {
  breakevenGrossPct,
  costModel,
  netPnlSol,
  requiredWinRatePct,
  targetGrossPct,
} from '../src/strategy/costs.js';
import { decideScalpExit } from '../src/strategy/exit-planner.js';
import { Watchlist } from '../src/watchlist/watchlist.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Position, TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
} as unknown as NodeJS.ProcessEnv;

const CANDIDATE: TokenCandidate = {
  mint: 'Mint1111111111111111111111111111111111111',
  creator: 'Dev1',
  symbol: 'FAST',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
  vSolInBondingCurve: 30,
};

let cfg: Config;
let wl: Watchlist;

/** Builds a token that is `ageSec` old with a pump over the last `windowSec`. */
function pumping(now: number, opts: { buyers: number; vSolNow: number; ageSec: number }) {
  wl.add(CANDIDATE);
  const t = wl.get(CANDIDATE.mint)!;
  t.firstSeen = now - opts.ageSec * 1000;
  t.samples = [{ at: t.firstSeen, vSol: 30 }];
  for (let i = 0; i < opts.buyers; i++) {
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: `buyer-${i}`,
      side: 'buy',
      solAmount: 0.4,
      tokenAmount: 1000,
      vSolInCurve: opts.vSolNow,
      at: now - 5_000,
    });
  }
  return t;
}

beforeEach(() => {
  cfg = loadConfig(BASE_ENV);
  wl = new Watchlist(cfg);
});

describe('momentum window', () => {
  it('measures price change as the square of the reserve ratio', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 8, vSolNow: 33, ageSec: 60 });
    const w = measureWindow(t, 30, now);
    // 33/30 = 1.1 reserves → 1.21 price → +21%
    expect(w.gainPct).toBeCloseTo(21, 0);
    expect(w.buyers).toBe(8);
  });
});

describe('momentum trigger', () => {
  it('fires on a real pump with a crowd behind it', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 8, vSolNow: 33, ageSec: 60 });
    const s = momentumSignal(t, cfg, now);
    expect(s.fire).toBe(true);
    expect(s.reason).toMatch(/8 buyers/);
  });

  it('does not fire on a move made by too few wallets', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 2, vSolNow: 40, ageSec: 60 });
    const s = momentumSignal(t, cfg, now);
    expect(s.fire).toBe(false);
    expect(s.reason).toMatch(/buyers/);
  });

  it('does not fire when the price has not moved', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 10, vSolNow: 30.1, ageSec: 60 });
    const s = momentumSignal(t, cfg, now);
    expect(s.fire).toBe(false);
    expect(s.reason).toMatch(/in window/);
  });

  it('refuses to chase a token that already ran', () => {
    const now = Date.now();
    // 30 → 80 virtual SOL is roughly +610% on price: the move is over.
    const t = pumping(now, { buyers: 12, vSolNow: 80, ageSec: 120 });
    const s = momentumSignal(t, cfg, now);
    expect(s.fire).toBe(false);
    expect(s.reason).toMatch(/too late to chase/);
  });

  it('never fires once the deployer has sold', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 10, vSolNow: 33, ageSec: 60 });
    t.deployerSold = true;
    expect(momentumSignal(t, cfg, now).fire).toBe(false);
  });

  it('does not fire on a token that is too young to read', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 10, vSolNow: 33, ageSec: 2 });
    expect(momentumSignal(t, cfg, now).reason).toBe('too young');
  });

  it('runs fast enough to sit on the trade stream', () => {
    const now = Date.now();
    const t = pumping(now, { buyers: 40, vSolNow: 33, ageSec: 60 });
    const started = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) momentumSignal(t, cfg, now);
    const perCallUs = Number(process.hrtime.bigint() - started) / 1000 / 10_000;
    // Budget is generous; the point is it is microseconds, not milliseconds.
    expect(perCallUs).toBeLessThan(200);
  });
});

describe('fee model', () => {
  it('reproduces the documented breakeven at 0.05 SOL', () => {
    const m = costModel(cfg, 0.05);
    expect(breakevenGrossPct(m)).toBeCloseTo(6.29, 1);
  });

  it('shows fixed priority fees punishing small positions', () => {
    expect(breakevenGrossPct(costModel(cfg, 0.02))).toBeGreaterThan(
      breakevenGrossPct(costModel(cfg, 0.5)),
    );
  });

  it('targets a gross move that actually nets the requested return', () => {
    const m = costModel(cfg, 0.25);
    const gross = targetGrossPct(m, 8);
    // Net PnL at that gross move should be 8% of the notional.
    expect(netPnlSol(m, gross)).toBeCloseTo(0.25 * 0.08, 6);
  });

  it('a below-breakeven exit is a loss even though the chart is up', () => {
    const m = costModel(cfg, 0.05);
    expect(netPnlSol(m, 5)).toBeLessThan(0); // +5% but breakeven is 6.3%
  });

  it('reports the sobering win rate a tight scalp needs', () => {
    const m = costModel(cfg, 0.25);
    const needed = requiredWinRatePct(m, 8, 18);
    expect(needed).toBeGreaterThan(50);
    expect(needed).toBeLessThan(100);
  });
});

describe('scalp exit', () => {
  const position = (o: Partial<Position> = {}): Position => {
    const now = Date.now();
    return {
      id: 'p1',
      mint: 'Mint1',
      symbol: 'FAST',
      creator: 'Dev1',
      pool: 'pump',
      status: 'open',
      costSol: 0.0513,
      notionalSol: 0.05,
      originalQty: 1_000_000,
      remainingQty: 1_000_000,
      entryPrice: 5e-8,
      openedAt: now,
      peakPrice: 5e-8,
      lastPrice: 5e-8,
      lastPriceAt: now,
      ladder: [],
      moonbagArmed: false,
      realizedSol: 0,
      safetyScore: 0,
      notes: [],
      ...o,
    };
  };

  it('holds below the fee-aware target', () => {
    const p = position();
    // +8% gross is under the ~14% needed to net 8% at this size.
    const order = decideScalpExit({ position: p, price: p.entryPrice * 1.08, cfg, now: Date.now() });
    expect(order).toBeNull();
  });

  it('banks at the target and keeps a runner', () => {
    const p = position();
    const target = targetGrossPct(costModel(cfg, 0.05), cfg.SCALP_TARGET_NET_PCT);
    const order = decideScalpExit({
      position: p,
      price: p.entryPrice * (1 + target / 100 + 0.01),
      cfg,
      now: Date.now(),
    });
    expect(order?.reason).toBe('ladder');
    expect(order?.closeAll).toBe(false);
    // 20% runner kept back by default.
    expect(order!.qty).toBeCloseTo(800_000, -3);
  });

  it('fires the stop loss', () => {
    const p = position();
    const order = decideScalpExit({ position: p, price: p.entryPrice * 0.75, cfg, now: Date.now() });
    expect(order?.reason).toBe('stop_loss');
  });

  it('protects breakeven once a trade has been meaningfully green', () => {
    const p = position({ peakPrice: 5e-8 * 1.15 });
    // Peaked at +15% (breakeven 6.3% + arm 3%), now back at +2%.
    const order = decideScalpExit({ position: p, price: p.entryPrice * 1.02, cfg, now: Date.now() });
    expect(order?.reason).toBe('trailing_stop');
    expect(order?.detail).toMatch(/breakeven/);
  });

  it('does not arm breakeven on a trade that was never green', () => {
    const p = position({ peakPrice: 5e-8 * 1.02 });
    const order = decideScalpExit({ position: p, price: p.entryPrice * 1.0, cfg, now: Date.now() });
    expect(order).toBeNull();
  });

  it('times out a flat position to free the slot', () => {
    const now = Date.now();
    const p = position({ openedAt: now - (cfg.SCALP_TIME_STOP_SECONDS + 5) * 1000 });
    const order = decideScalpExit({ position: p, price: p.entryPrice * 1.01, cfg, now });
    expect(order?.reason).toBe('time_stop');
  });

  it('lets the runner trail after the target filled', () => {
    const p = position({ moonbagArmed: true, remainingQty: 200_000, peakPrice: 5e-8 * 3 });
    // Only 20% off peak — the runner keeps going.
    expect(
      decideScalpExit({ position: p, price: p.peakPrice * 0.8, cfg, now: Date.now() }),
    ).toBeNull();
    // 40% off peak trips the runner stop.
    const order = decideScalpExit({ position: p, price: p.peakPrice * 0.6, cfg, now: Date.now() });
    expect(order?.reason).toBe('trailing_stop');
  });
});
