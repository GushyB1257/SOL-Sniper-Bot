import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionManager } from '../src/strategy/position-manager.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PriceSource } from '../src/execution/pricing.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import type { TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  BUY_AMOUNT_SOL: '0.05',
  EXIT_LADDER: '60:40,150:30,400:20',
} as unknown as NodeJS.ProcessEnv;

/**
 * Stub price source standing in for the chain. Holds a bonding curve whose
 * reserves we can move, so the test drives price exactly the way real trading
 * would — through the curve, not by poking at the executor.
 */
class StubPrices implements PriceSource {
  vSol = 30;
  vTokens = 1_073_000_000;
  complete = false;
  unreadable = false;

  async curve(): Promise<BondingCurveState | null> {
    if (this.unreadable) return null;
    return {
      virtualSolReserves: BigInt(Math.round(this.vSol * 1e9)),
      virtualTokenReserves: BigInt(Math.round(this.vTokens * 1e6)),
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: this.complete,
    };
  }

  async price(): Promise<number | null> {
    if (this.unreadable) return null;
    return this.vSol / this.vTokens;
  }

  /** Moves the curve so spot price becomes `multiple` x its starting value. */
  setPriceMultiple(entryPrice: number, multiple: number): void {
    const k = this.vSol * this.vTokens;
    const target = entryPrice * multiple;
    this.vSol = Math.sqrt(target * k);
    this.vTokens = k / this.vSol;
  }
}

let dir: string;
let cfg: Config;
let store: Store;
let exec: PaperExecutor;
let prices: StubPrices;
let manager: PositionManager;

const CANDIDATE: TokenCandidate = {
  mint: 'Mint1111111111111111111111111111111111111',
  creator: 'Dev11111111111111111111111111111111111111',
  name: 'Lifecycle Test',
  symbol: 'LIFE',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
  vSolInBondingCurve: 30,
  vTokensInBondingCurve: 1_073_000_000,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-lifecycle-'));
  cfg = loadConfig({ ...BASE_ENV, DATA_DIR: dir });
  store = new Store(dir);
  prices = new StubPrices();
  exec = new PaperExecutor(cfg, prices);
  manager = new PositionManager(cfg, store, exec, new RiskManager(cfg, store, join(dir, 'nostop')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setPriceMultiple(_mint: string, entryPrice: number, multiple: number): void {
  prices.setPriceMultiple(entryPrice, multiple);
}

describe('full position lifecycle', () => {
  it('buys, climbs the ladder, arms a moonbag, then trails out', async () => {
    const fill = await exec.buy(CANDIDATE, cfg.BUY_AMOUNT_SOL);
    expect(fill.ok).toBe(true);
    expect(fill.receivedQty).toBeGreaterThan(0);

    const p = manager.open(CANDIDATE, fill, 85);
    const entry = p.entryPrice;
    expect(store.openPositions()).toHaveLength(1);

    // +80%: clears rung 1 only.
    setPriceMultiple(p.mint, entry, 1.8);
    await manager.tick();
    let cur = store.getPosition(p.id)!;
    expect(cur.ladder[0]!.filled).toBe(true);
    expect(cur.ladder[1]!.filled).toBe(false);
    expect(cur.realizedSol).toBeGreaterThan(0);
    expect(cur.status).toBe('open');

    // +200%: clears rung 2. Stake should now be more than recovered.
    setPriceMultiple(p.mint, entry, 3.0);
    await manager.tick();
    cur = store.getPosition(p.id)!;
    expect(cur.ladder[1]!.filled).toBe(true);
    expect(cur.realizedSol).toBeGreaterThan(cur.costSol);

    // +500%: clears the final rung and arms the moonbag.
    setPriceMultiple(p.mint, entry, 6.0);
    await manager.tick();
    cur = store.getPosition(p.id)!;
    expect(cur.ladder.every((t) => t.filled)).toBe(true);
    expect(cur.moonbagArmed).toBe(true);
    expect(cur.status).toBe('open');
    expect(cur.remainingQty).toBeGreaterThan(0);

    // Moonbag is roughly the 10% the ladder left behind.
    expect(cur.remainingQty / cur.originalQty).toBeGreaterThan(0.05);
    expect(cur.remainingQty / cur.originalQty).toBeLessThan(0.15);

    // Crash 80% off the peak: breaches the moonbag trailing stop.
    setPriceMultiple(p.mint, entry, 1.2);
    await manager.tick();
    cur = store.getPosition(p.id)!;
    expect(cur.status).toBe('closed');
    expect(cur.closeReason).toMatch(/moonbag_trailing_stop/);

    // The whole point of the ladder: a position that pumped then round-tripped
    // most of the way back still books a profit.
    const journal = store.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0]!.pnlSol).toBeGreaterThan(0);
  });

  it('stops out a position that dumps straight after entry', async () => {
    const fill = await exec.buy(CANDIDATE, cfg.BUY_AMOUNT_SOL);
    const p = manager.open(CANDIDATE, fill, 85);

    setPriceMultiple(p.mint, p.entryPrice, 0.5); // -50%
    await manager.tick();

    const cur = store.getPosition(p.id)!;
    expect(cur.status).toBe('closed');
    expect(cur.closeReason).toMatch(/stop_loss/);

    const entry = store.journal()[0]!;
    expect(entry.pnlSol).toBeLessThan(0);
    // The stop has to actually bound the loss, not just fire.
    expect(entry.pnlPct).toBeGreaterThan(-60);
  });

  it('times out a launch that goes nowhere', async () => {
    const fill = await exec.buy(CANDIDATE, cfg.BUY_AMOUNT_SOL);
    const p = manager.open(CANDIDATE, fill, 85);

    // Backdate the entry past the time stop.
    p.openedAt = Date.now() - (cfg.TIME_STOP_SECONDS + 10) * 1000;
    store.savePosition(p);

    await manager.tick();
    expect(store.getPosition(p.id)!.closeReason).toMatch(/time_stop/);
  });

  it('records a losing trade against the deployer reputation', async () => {
    const fill = await exec.buy(CANDIDATE, cfg.BUY_AMOUNT_SOL);
    const p = manager.open(CANDIDATE, fill, 85);
    store.recordCreatorLaunch(CANDIDATE.creator, CANDIDATE.mint);

    setPriceMultiple(p.mint, p.entryPrice, 0.5);
    await manager.tick();

    const rec = store.getCreator(CANDIDATE.creator)!;
    expect(rec.wins + rec.rugs).toBe(1);
  });

  it('never opens two positions in the same mint', async () => {
    const fill = await exec.buy(CANDIDATE, cfg.BUY_AMOUNT_SOL);
    manager.open(CANDIDATE, fill, 85);
    expect(store.hasOpenPositionFor(CANDIDATE.mint)).toBe(true);
    expect(store.hasTraded(CANDIDATE.mint)).toBe(true);
  });
});
