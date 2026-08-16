import { describe, it, expect } from 'vitest';
import { decideExit, costRecoveryQty, checkpointElapsed } from '../src/strategy/exit-planner.js';
import { costModel, breakevenGrossPct } from '../src/strategy/costs.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Position } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  BUY_AMOUNT_SOL: '0.25',
} as unknown as NodeJS.ProcessEnv;

function cfg(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

const C = cfg();
const ENTRY = 5e-8;
const NOW = 1_700_000_000_000;

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    mint: 'MintAddress1111111111111111111111111111111',
    symbol: 'TEST',
    creator: 'Creator111111111111111111111111111111111',
    pool: 'pump',
    status: 'open',
    costSol: 0.25,
    notionalSol: 0.25,
    originalQty: 5_000_000,
    remainingQty: 5_000_000,
    entryPrice: ENTRY,
    openedAt: NOW,
    peakPrice: ENTRY,
    lastPrice: ENTRY,
    lastPriceAt: NOW,
    ladder: [],
    moonbagArmed: false,
    realizedSol: 0,
    checkpointAt: NOW,
    checkpointPrice: ENTRY,
    costRecovered: false,
    safetyScore: 0,
    notes: [],
    ...overrides,
  };
}

/** A moment `seconds` after the position opened. */
const at = (seconds: number) => NOW + seconds * 1000;

function decide(p: Position, mult: number, seconds: number, c: Config = C) {
  return decideExit({ position: p, price: ENTRY * mult, cfg: c, now: at(seconds) });
}

const BREAKEVEN = breakevenGrossPct(costModel(C, 0.25)); // ~3.7% at 0.25 SOL

describe('no stop loss', () => {
  it('holds a position that is deeply underwater inside the window', () => {
    // The behaviour the whole redesign is for: a stop would have sold here.
    const p = position();
    expect(decide(p, 0.4, 10)).toBeNull();
    expect(decide(p, 0.2, 30)).toBeNull();
    expect(decide(p, 0.05, 59)).toBeNull();
  });

  it('holds a position that dumps and recovers within the window', () => {
    const p = position();
    expect(decide(p, 0.3, 20)).toBeNull(); // -70%
    expect(decide(p, 1.5, 45)).toBeNull(); // back to +50%
    // At the checkpoint it is up and above where it started, so it survives.
    expect(decide(p, 1.5, 61)).toBeNull();
  });

  it('can be given a stop back through config', () => {
    const c = cfg({ RATCHET_STOP_LOSS_PCT: '50' });
    const order = decide(position(), 0.4, 10, c);
    expect(order?.reason).toBe('stop_loss');
    expect(order?.closeAll).toBe(true);
  });
});

describe('the 60-second checkpoint', () => {
  it('sells everything when it is not profitable after 60s', () => {
    const order = decide(position(), 1.01, 61);
    expect(order?.reason).toBe('time_stop');
    expect(order?.closeAll).toBe(true);
    expect(order?.detail).toMatch(/below the .* needed to cover fees/);
  });

  it('counts fees, not the chart — barely green is not profitable', () => {
    // +2% looks like a win and is a loss after a 3.7% round trip.
    expect(BREAKEVEN).toBeGreaterThan(2);
    expect(decide(position(), 1.02, 61)?.reason).toBe('time_stop');
    expect(decide(position(), 1 + (BREAKEVEN + 1) / 100, 61)).toBeNull();
  });

  it('holds a profitable position that is still climbing', () => {
    expect(decide(position(), 1.5, 61)).toBeNull();
  });

  it('sells a profitable position that stopped climbing', () => {
    // Checkpoint was set at +50%; an hour of that price is not progress.
    const p = position({ checkpointPrice: ENTRY * 1.5, checkpointAt: NOW });
    const order = decide(p, 1.5, 61);
    expect(order?.reason).toBe('ratchet_stall');
    expect(order?.closeAll).toBe(true);
  });

  it('sells a profitable position that is drifting down', () => {
    const p = position({ checkpointPrice: ENTRY * 1.8, checkpointAt: NOW });
    const order = decide(p, 1.4, 61);
    expect(order?.reason).toBe('ratchet_stall');
    expect(order?.detail).toContain('+40.0%');
  });

  it('decides nothing between checkpoints', () => {
    const p = position({ checkpointPrice: ENTRY * 2, checkpointAt: NOW });
    // Below the last checkpoint AND unprofitable, but the window is still open.
    expect(decide(p, 1.01, 59)).toBeNull();
  });

  it('can require real progress rather than any new high', () => {
    const c = cfg({ RATCHET_MIN_PROGRESS_PCT: '10' });
    const p = position({ checkpointPrice: ENTRY * 1.5, checkpointAt: NOW });
    expect(decide(p, 1.55, 61, c)?.reason).toBe('ratchet_stall'); // only +3%
    expect(decide(p, 1.7, 61, c)).toBeNull(); // +13%
  });
});

describe('cost recovery on a double', () => {
  it('fires the instant it doubles, without waiting for a checkpoint', () => {
    // A 2x can happen inside one window; waiting would give it back.
    const order = decide(position(), 2, 3);
    expect(order?.reason).toBe('cost_recovery');
    expect(order?.closeAll).toBe(false);
  });

  it('sells enough to actually cover the stake including fees', () => {
    const p = position();
    const order = decide(p, 2, 5)!;
    const price = ENTRY * 2;
    const m = costModel(C, 0.25);
    const net = order.qty * price * (1 - m.perSideFee) - m.priorityFeeSol;
    // The point of the rule: proceeds must clear the stake, not approximate it.
    expect(net).toBeGreaterThanOrEqual(p.costSol);
    expect(net).toBeLessThan(p.costSol * 1.02);
  });

  it('leaves a real moonbag — a bit under half at a clean 2x', () => {
    const p = position();
    const order = decide(p, 2, 5)!;
    const kept = (p.remainingQty - order.qty) / p.originalQty;
    expect(kept).toBeGreaterThan(0.4);
    expect(kept).toBeLessThan(0.5);
  });

  it('does not fire twice', () => {
    const p = position({ costRecovered: true, remainingQty: 2_400_000, realizedSol: 0.25 });
    expect(decide(p, 2.2, 5)).toBeNull();
  });

  it('closes out rather than pretending to be de-risked', () => {
    // Barely anything left: the remainder cannot cover the stake, so claiming
    // the position is now risk-free would be a lie.
    const p = position({ remainingQty: 100 });
    const order = decide(p, 2, 5);
    expect(order?.reason).toBe('cost_recovery');
    expect(order?.closeAll).toBe(true);
  });

  it('recovers at a configurable multiple', () => {
    const c = cfg({ RECOVER_AT_GAIN_PCT: '50' });
    expect(decide(position(), 1.6, 5, c)?.reason).toBe('cost_recovery');
    expect(decide(position(), 1.6, 5)).toBeNull(); // default needs 2x
  });
});

describe('the moonbag after recovery', () => {
  const recovered = (overrides: Partial<Position> = {}) =>
    position({
      costRecovered: true,
      moonbagArmed: true,
      realizedSol: 0.25,
      remainingQty: 2_400_000,
      checkpointPrice: ENTRY * 2,
      checkpointAt: NOW,
      ...overrides,
    });

  it('skims a slice while it keeps climbing', () => {
    const order = decide(recovered(), 3, 61);
    expect(order?.reason).toBe('moonbag_trim');
    expect(order?.closeAll).toBe(false);
    expect(order?.qty).toBeCloseTo(2_400_000 * 0.25, -2);
  });

  it('closes the moonbag the first time it stops climbing', () => {
    const order = decide(recovered(), 1.9, 61);
    expect(order?.reason).toBe('ratchet_stall');
    expect(order?.closeAll).toBe(true);
  });

  it('never applies the profitability test to house money', () => {
    // Deep below entry, but the stake is already back — there is nothing to
    // protect, so the only question is whether it is still going up.
    expect(decide(recovered({ checkpointPrice: ENTRY * 0.1 }), 0.5, 61)?.reason).toBe(
      'moonbag_trim',
    );
  });

  it('has no stop loss on the moonbag either', () => {
    expect(decide(recovered(), 0.01, 30)).toBeNull();
  });

  it('closes out instead of leaving dust', () => {
    const p = recovered({ remainingQty: 20_000 });
    const order = decide(p, 3, 61);
    expect(order?.closeAll).toBe(true);
    expect(order?.qty).toBe(20_000);
  });

  it('holds the whole moonbag when trimming is disabled', () => {
    const c = cfg({ MOONBAG_TRIM_PCT: '0' });
    expect(decide(recovered(), 3, 61, c)).toBeNull();
  });
});

describe('safety rails that remain', () => {
  it('still honours the absolute maximum hold', () => {
    const c = cfg({ MAX_HOLD_SECONDS: '3600' });
    const p = position({ checkpointAt: at(3500), checkpointPrice: ENTRY });
    expect(decide(p, 5, 3601, c)?.reason).toBe('max_hold');
  });

  it('ignores a closed position and a garbage price', () => {
    expect(decide(position({ status: 'closed' }), 2, 61)).toBeNull();
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(decideExit({ position: position(), price: bad, cfg: C, now: at(61) })).toBeNull();
    }
  });
});

describe('helpers', () => {
  it('checkpointElapsed falls back to the open time for older positions', () => {
    const p = position({ checkpointAt: undefined });
    expect(checkpointElapsed(p, C, at(59))).toBe(false);
    expect(checkpointElapsed(p, C, at(60))).toBe(true);
  });

  it('costRecoveryQty wants nothing once the stake is already back', () => {
    const p = position({ realizedSol: 0.25 });
    expect(costRecoveryQty(p, ENTRY * 2, costModel(C, 0.25))).toBe(0);
  });
});

describe('config guards', () => {
  it('refuses a moonbag trim that leaves no moonbag', () => {
    expect(() => cfg({ MOONBAG_TRIM_PCT: '100' })).toThrow();
  });

  it('refuses the long ladder behind a screener entry', () => {
    expect(() => cfg({ ENTRY_MODE: 'screener', EXIT_MODE: 'ladder' })).toThrow(/ladder/);
  });
});
