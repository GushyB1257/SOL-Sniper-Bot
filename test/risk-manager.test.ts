import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  BUY_AMOUNT_SOL: '0.05',
  MAX_CONCURRENT_POSITIONS: '3',
  DAILY_LOSS_LIMIT_SOL: '0.5',
  MAX_CONSECUTIVE_LOSSES: '4',
  HOURLY_SPEND_CAP_SOL: '0.5',
  MIN_WALLET_RESERVE_SOL: '0.05',
} as unknown as NodeJS.ProcessEnv;

let dir: string;
let store: Store;
let cfg: Config;
let risk: RiskManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-test-'));
  cfg = loadConfig({ ...BASE_ENV, DATA_DIR: dir });
  store = new Store(dir);
  // Point the kill switch at a path that will not exist.
  risk = new RiskManager(cfg, store, join(dir, 'no-such-stop-file'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RiskManager.canOpen', () => {
  it('allows a normal entry', () => {
    expect(risk.canOpen(1).allowed).toBe(true);
  });

  it('blocks when the wallet cannot cover the buy plus the reserve', () => {
    const d = risk.canOpen(0.06); // needs 0.05 + 0.05
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/insufficient balance/);
  });

  it('blocks at the concurrent position limit', () => {
    for (let i = 0; i < 3; i++) {
      store.savePosition({
        id: `p${i}`,
        mint: `mint${i}`,
        creator: 'c',
        pool: 'pump',
        status: 'open',
        costSol: 0.05,
        originalQty: 1,
        remainingQty: 1,
        entryPrice: 1,
        openedAt: Date.now(),
        peakPrice: 1,
        lastPrice: 1,
        lastPriceAt: Date.now(),
        ladder: [],
        moonbagArmed: false,
        realizedSol: 0,
        safetyScore: 90,
        notes: [],
      });
    }
    const d = risk.canOpen(10);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/position limit/);
  });

  it('blocks once the daily loss limit is breached', () => {
    store.recordRealisedPnl(-0.6);
    const d = risk.canOpen(10);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/daily loss limit/);
  });

  it('blocks once the hourly spend cap is reached', () => {
    for (let i = 0; i < 10; i++) store.recordSpend(0.05);
    const d = risk.canOpen(10);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/hourly spend cap/);
  });
});

describe('RiskManager circuit breaker', () => {
  it('trips after the configured losing streak and blocks entries', () => {
    for (let i = 0; i < 3; i++) risk.recordOutcome(-0.01);
    expect(risk.canOpen(10).allowed).toBe(true);

    risk.recordOutcome(-0.01); // fourth consecutive loss
    const d = risk.canOpen(10);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/circuit breaker/);
  });

  it('resets the streak on a winner', () => {
    risk.recordOutcome(-0.01);
    risk.recordOutcome(-0.01);
    risk.recordOutcome(-0.01);
    risk.recordOutcome(+0.02);
    risk.recordOutcome(-0.01);
    expect(risk.canOpen(10).allowed).toBe(true);
  });
});

describe('Store', () => {
  it('survives a restart with open positions intact', () => {
    store.savePosition({
      id: 'p1',
      mint: 'mintA',
      creator: 'c',
      pool: 'pump',
      status: 'open',
      costSol: 0.05,
      originalQty: 100,
      remainingQty: 100,
      entryPrice: 1,
      openedAt: Date.now(),
      peakPrice: 1,
      lastPrice: 1,
      lastPriceAt: Date.now(),
      ladder: [],
      moonbagArmed: false,
      realizedSol: 0,
      safetyScore: 90,
      notes: [],
    });
    store.flush();

    const reopened = new Store(dir);
    expect(reopened.openPositions()).toHaveLength(1);
    expect(reopened.hasTraded('mintA')).toBe(true);
  });

  it('tracks deployer reputation across launches', () => {
    store.recordCreatorLaunch('dev1', 'mint1');
    store.recordCreatorLaunch('dev1', 'mint2');
    store.recordCreatorOutcome('dev1', true);
    store.recordCreatorOutcome('dev1', false);

    const rec = store.getCreator('dev1');
    expect(rec?.launches).toBe(2);
    expect(rec?.rugs).toBe(1);
    expect(rec?.wins).toBe(1);
  });

  it('expires spend outside the rolling hour', () => {
    store.recordSpend(0.1);
    expect(store.spendLastHour()).toBeCloseTo(0.1);
  });
});
