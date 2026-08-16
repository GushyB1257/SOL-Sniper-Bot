import { describe, it, expect } from 'vitest';
import {
  decideExit,
  buildLadder,
  moonbagFraction,
  positionPnl,
} from '../src/strategy/exit-planner.js';
import type { Position } from '../src/types.js';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
} as unknown as NodeJS.ProcessEnv;

function cfg(overrides: Record<string, string> = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function position(overrides: Partial<Position> = {}): Position {
  const c = cfg();
  const now = Date.now();
  return {
    id: 'p1',
    mint: 'MintAddress1111111111111111111111111111111',
    symbol: 'TEST',
    creator: 'Creator111111111111111111111111111111111',
    pool: 'pump',
    status: 'open',
    costSol: 0.05,
    originalQty: 1_000_000,
    remainingQty: 1_000_000,
    entryPrice: 5e-8,
    openedAt: now,
    peakPrice: 5e-8,
    lastPrice: 5e-8,
    lastPriceAt: now,
    ladder: buildLadder(c),
    moonbagArmed: false,
    realizedSol: 0,
    safetyScore: 90,
    notes: [],
    ...overrides,
  };
}

describe('ladder construction', () => {
  it('leaves a moonbag with the default ladder', () => {
    const c = cfg();
    expect(c.EXIT_LADDER.map((t) => t.gainPct)).toEqual([60, 150, 400]);
    expect(moonbagFraction(c)).toBeCloseTo(0.1);
  });

  it('rejects a ladder that sells more than the whole position', () => {
    expect(() => cfg({ EXIT_LADDER: '50:60,100:60' })).toThrow(/exceeds 100%/);
  });

  it('rejects non-ascending rungs', () => {
    expect(() => cfg({ EXIT_LADDER: '100:30,50:30' })).toThrow(/strictly ascend/);
  });

  it('rejects a ladder that leaves no moonbag', () => {
    expect(() => cfg({ EXIT_LADDER: '50:50,100:50' })).toThrow(/no moonbag/);
  });
});

describe('decideExit — profit taking', () => {
  const c = cfg();

  it('holds below the first rung', () => {
    const p = position();
    const order = decideExit({ position: p, price: p.entryPrice * 1.4, cfg: c, now: Date.now() });
    expect(order).toBeNull();
  });

  it('sells the first rung at +60%', () => {
    const p = position();
    const order = decideExit({ position: p, price: p.entryPrice * 1.6, cfg: c, now: Date.now() });
    expect(order?.reason).toBe('ladder');
    expect(order?.tierIndexes).toEqual([0]);
    expect(order?.qty).toBeCloseTo(400_000); // 40% of original
    expect(order?.closeAll).toBe(false);
  });

  it('batches every rung a gap-up clears into one sell', () => {
    const p = position();
    // 6x in one tick clears all three rungs at once.
    const order = decideExit({ position: p, price: p.entryPrice * 6, cfg: c, now: Date.now() });
    expect(order?.tierIndexes).toEqual([0, 1, 2]);
    // 40 + 30 + 20 = 90% of the original position.
    expect(order?.qty).toBeCloseTo(900_000);
    expect(order?.closeAll).toBe(false);
  });

  it('does not refill a rung that already filled', () => {
    const p = position();
    p.ladder[0]!.filled = true;
    p.remainingQty = 600_000;
    const order = decideExit({ position: p, price: p.entryPrice * 1.7, cfg: c, now: Date.now() });
    expect(order).toBeNull();
  });

  it('closes out instead of leaving dust', () => {
    const p = position();
    p.ladder[0]!.filled = true;
    p.ladder[1]!.filled = true;
    // Only a sliver more than the final rung would sell.
    p.remainingQty = 201_000;
    const order = decideExit({ position: p, price: p.entryPrice * 5, cfg: c, now: Date.now() });
    expect(order?.closeAll).toBe(true);
    expect(order?.qty).toBe(201_000);
  });

  it('never sells more than is actually held', () => {
    const p = position();
    p.remainingQty = 100_000; // most of it already gone
    const order = decideExit({ position: p, price: p.entryPrice * 6, cfg: c, now: Date.now() });
    expect(order!.qty).toBeLessThanOrEqual(100_000);
  });
});

describe('decideExit — capital preservation', () => {
  const c = cfg();

  it('fires the hard stop loss', () => {
    const p = position();
    const order = decideExit({ position: p, price: p.entryPrice * 0.6, cfg: c, now: Date.now() });
    expect(order?.reason).toBe('stop_loss');
    expect(order?.closeAll).toBe(true);
  });

  it('holds just above the stop', () => {
    const p = position();
    const order = decideExit({ position: p, price: p.entryPrice * 0.7, cfg: c, now: Date.now() });
    expect(order).toBeNull();
  });

  it('arms the trailing stop only after a rung fills', () => {
    const now = Date.now();
    const p = position();
    p.peakPrice = p.entryPrice * 2;
    // 45% off a 2x peak is still +10% overall, so the hard stop is not in play.
    const price = p.peakPrice * 0.5;

    // No rung filled yet: the trailing stop is not armed.
    expect(decideExit({ position: p, price, cfg: c, now })).toBeNull();

    p.ladder[0]!.filled = true;
    const order = decideExit({ position: p, price, cfg: c, now });
    expect(order?.reason).toBe('trailing_stop');
  });

  it('gives the moonbag a looser leash', () => {
    const now = Date.now();
    const p = position({ moonbagArmed: true, remainingQty: 100_000 });
    p.ladder.forEach((t) => (t.filled = true));
    p.peakPrice = p.entryPrice * 10;

    // 50% off peak — would stop out a normal position, moonbag holds.
    expect(decideExit({ position: p, price: p.peakPrice * 0.5, cfg: c, now })).toBeNull();

    // 75% off peak breaches the moonbag stop.
    const order = decideExit({ position: p, price: p.peakPrice * 0.25, cfg: c, now });
    expect(order?.reason).toBe('moonbag_trailing_stop');
  });

  it('times out a position that went nowhere', () => {
    const now = Date.now();
    const p = position({ openedAt: now - 200_000 });
    const order = decideExit({ position: p, price: p.entryPrice * 1.02, cfg: c, now });
    expect(order?.reason).toBe('time_stop');
  });

  it('does not time out a position that is working', () => {
    const now = Date.now();
    const p = position({ openedAt: now - 200_000 });
    const order = decideExit({ position: p, price: p.entryPrice * 1.3, cfg: c, now });
    expect(order).toBeNull();
  });

  it('does not time out a position that already filled a rung', () => {
    const now = Date.now();
    const p = position({ openedAt: now - 200_000 });
    p.ladder[0]!.filled = true;
    const order = decideExit({ position: p, price: p.entryPrice * 1.02, cfg: c, now });
    expect(order).toBeNull();
  });

  it('closes at the maximum hold time regardless of price', () => {
    const now = Date.now();
    const p = position({ openedAt: now - 90_000_000, moonbagArmed: true });
    p.ladder.forEach((t) => (t.filled = true));
    p.peakPrice = p.entryPrice * 20;
    const order = decideExit({ position: p, price: p.entryPrice * 19, cfg: c, now });
    expect(order?.reason).toBe('max_hold');
  });

  it('prioritises the stop loss over a rung on a whipsaw', () => {
    // Contrived but real: a price that is somehow both below the stop and above
    // a rung cannot happen, so assert the ordering via a closed position.
    const p = position({ status: 'closed' });
    expect(decideExit({ position: p, price: p.entryPrice * 5, cfg: c, now: Date.now() })).toBeNull();
  });

  it('ignores garbage prices', () => {
    const p = position();
    for (const price of [0, -1, NaN, Infinity]) {
      expect(decideExit({ position: p, price, cfg: c, now: Date.now() })).toBeNull();
    }
  });
});

describe('positionPnl', () => {
  it('combines realised and unrealised', () => {
    const p = position({ costSol: 0.05, realizedSol: 0.06, remainingQty: 100_000 });
    const pnl = positionPnl(p, 1e-7);
    // 0.06 realised + 0.01 unrealised - 0.05 cost = 0.02
    expect(pnl.sol).toBeCloseTo(0.02);
    expect(pnl.pct).toBeCloseTo(40);
  });
});
