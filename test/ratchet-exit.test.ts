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
    expect(decide(p, 0.2, 20)).toBeNull();
    expect(decide(p, 0.05, 29)).toBeNull();
  });

  it('asks the first question sooner than the ones after it', () => {
    // A launch going nowhere pays for the whole first window before anything
    // can cut it, and most of the damage lands in the first thirty seconds.
    // Later windows keep the full length so a working position is not rushed.
    expect(C.RATCHET_FIRST_CHECKPOINT_SECONDS).toBeLessThan(C.CHECKPOINT_SECONDS);

    const fresh = position();
    expect(decide(fresh, 0.5, C.RATCHET_FIRST_CHECKPOINT_SECONDS - 1)).toBeNull();
    expect(decide(fresh, 0.5, C.RATCHET_FIRST_CHECKPOINT_SECONDS + 1)?.reason).toBe('time_stop');

    // Second window onwards: the full CHECKPOINT_SECONDS.
    const later = position({ checkpointAt: at(40), checkpointPrice: ENTRY });
    expect(decide(later, 0.5, 40 + C.CHECKPOINT_SECONDS - 1)).toBeNull();
    expect(decide(later, 0.5, 40 + C.CHECKPOINT_SECONDS + 1)?.reason).toBe('time_stop');
  });

  it('can be put back to one window length for both', () => {
    const c = cfg({ RATCHET_FIRST_CHECKPOINT_SECONDS: '60' });
    const p = position();
    expect(decide(p, 0.5, 59, c)).toBeNull();
    expect(decide(p, 0.5, 61, c)?.reason).toBe('time_stop');
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
    const p = position({ checkpointPrice: ENTRY * 2, checkpointAt: at(5) });
    // Below the last checkpoint AND unprofitable, but the window is still open.
    expect(decide(p, 1.01, 5 + C.CHECKPOINT_SECONDS - 1)).toBeNull();
  });

  it('can require real progress rather than any new high', () => {
    // Recovery off, so the stall rule is the only thing that can fire here.
    const c = cfg({
      RATCHET_MIN_PROGRESS_PCT: '10',
      RATCHET_GIVEBACK_PCT: '0',
      RECOVER_AT_GAIN_PCT: '500',
    });
    const p = position({ checkpointPrice: ENTRY * 1.5, checkpointAt: at(5), peakPrice: ENTRY * 1.7 });
    expect(decide(p, 1.55, 66, c)?.reason).toBe('ratchet_stall'); // only +3%
    expect(decide(p, 1.7, 66, c)).toBeNull(); // +13%
  });
});

describe('giving back a move', () => {
  it('closes a position that round-trips its gain before the window closes', () => {
    // The ratchet's biggest leak: the checkpoint only looks up once a window,
    // so a position could run to +90%, hand every bit of it back, and still be
    // holding when the window finally closed.
    const p = position({ peakPrice: ENTRY * 1.9 });
    const order = decide(p, 1.1, 15); // +90% peak, now +10%
    expect(order?.reason).toBe('trailing_stop');
    expect(order?.closeAll).toBe(true);
    expect(order?.detail).toMatch(/gave back/);
  });

  it('leaves a normal pullback alone', () => {
    // Peaked at +50%, now +42% — well inside the limit, and still below the
    // recovery threshold so nothing else fires. Expressed against the
    // configured limit rather than a hardcoded number, so tuning the default
    // does not silently turn this into a different test.
    expect(C.RATCHET_GIVEBACK_PCT).toBeGreaterThan(10);
    const p = position({ peakPrice: ENTRY * 1.5 });
    // Give back a third of the allowed share of a 50% move.
    const givenBack = 50 * (C.RATCHET_GIVEBACK_PCT / 100) * 0.33;
    expect(decide(p, 1 + (50 - givenBack) / 100, 15)).toBeNull();
  });

  it('cannot fire on a position that is down, however far', () => {
    // It measures the GAIN given back, so a position with no gain has nothing
    // to give back. This is what keeps it from becoming the stop loss that was
    // deliberately removed.
    const p = position({ peakPrice: ENTRY });
    expect(decide(p, 0.1, 10)).toBeNull();
    expect(decide(p, 0.01, 20)).toBeNull();
  });

  it('ignores noise around entry rather than closing on a wobble', () => {
    // A peak barely above entry is not a move, and treating it as one would
    // close positions in the first seconds of every launch.
    const p = position({ peakPrice: ENTRY * 1.05 });
    expect(decide(p, 1.0, 10)).toBeNull();
  });

  it('protects a recovered moonbag too', () => {
    const p = position({
      costRecovered: true,
      moonbagArmed: true,
      realizedSol: 0.25,
      remainingQty: 2_400_000,
      peakPrice: ENTRY * 5,
      checkpointPrice: ENTRY * 4,
      checkpointAt: NOW,
    });
    expect(decide(p, 2, 10)?.reason).toBe('trailing_stop');
  });

  it('can be turned off', () => {
    const c = cfg({ RATCHET_GIVEBACK_PCT: '0' });
    const p = position({ peakPrice: ENTRY * 1.9 });
    expect(decide(p, 1.1, 15, c)).toBeNull();
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
    // Raise the bar and the same move is not enough.
    expect(decide(position(), 1.6, 5, cfg({ RECOVER_AT_GAIN_PCT: '100' }))).toBeNull();
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
    expect(decide(recovered(), 0.01, C.RATCHET_FIRST_CHECKPOINT_SECONDS - 1)).toBeNull();
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
    const w = C.RATCHET_FIRST_CHECKPOINT_SECONDS;
    expect(checkpointElapsed(p, C, at(w - 1))).toBe(false);
    expect(checkpointElapsed(p, C, at(w))).toBe(true);
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
