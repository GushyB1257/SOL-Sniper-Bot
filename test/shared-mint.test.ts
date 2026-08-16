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

/**
 * The three bots share one wallet and one executor, so they routinely hold the
 * same token at the same time — a launch the sniper buys at creation, the
 * screener buys again when it crosses the filter, and the copy trader buys
 * because a tracked wallet bought it.
 *
 * Observed in a live paper run: the copy trader closed its position in `Bo`
 * and sold 7,749,872 tokens — the pooled balance of all three positions, when
 * it had bought 2,011,797. The other two then failed with "no balance to sell"
 * and were booked at -100% on a token that had just been sold profitably.
 */
const ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  EXIT_MODE: 'ratchet',
  BUY_AMOUNT_SOL: '0.25',
} as unknown as NodeJS.ProcessEnv;

class StubPrices implements PriceSource {
  vSol = 45;
  vTokens = 1_073_000_000;

  async curve(): Promise<BondingCurveState | null> {
    return {
      virtualSolReserves: BigInt(Math.round(this.vSol * 1e9)),
      virtualTokenReserves: BigInt(Math.round(this.vTokens * 1e6)),
      realSolReserves: 15_000_000_000n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    };
  }
  async price(): Promise<number | null> {
    return this.vSol / this.vTokens;
  }
}

const MINT = 'Bo111111111111111111111111111111111111111';

const CANDIDATE: TokenCandidate = {
  mint: MINT,
  creator: 'Dev11111111111111111111111111111111111111',
  symbol: 'Bo',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
};

let dir: string;
let cfg: Config;
let exec: PaperExecutor;
let prices: StubPrices;
/** Two bots, two stores, one shared wallet and executor — as in production. */
let sniperStore: Store;
let copyStore: Store;
let sniper: PositionManager;
let copy: PositionManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-shared-'));
  cfg = loadConfig({ ...ENV, DATA_DIR: dir });
  prices = new StubPrices();
  exec = new PaperExecutor(cfg, prices);

  sniperStore = new Store(dir, 'sniper');
  copyStore = new Store(dir, 'copy');
  sniper = new PositionManager(
    cfg,
    sniperStore,
    exec,
    new RiskManager(cfg, sniperStore, join(dir, 'nostop')),
  );
  copy = new PositionManager(
    cfg,
    copyStore,
    exec,
    new RiskManager(cfg, copyStore, join(dir, 'nostop')),
  );
});

afterEach(() => {
  sniperStore.close();
  copyStore.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('two bots holding the same token', () => {
  it('closing one position does not empty the other', async () => {
    const aFill = await exec.buy(CANDIDATE, 0.25);
    const a = sniper.open(CANDIDATE, aFill, 80);
    const bFill = await exec.buy(CANDIDATE, 0.25);
    const b = copy.open(CANDIDATE, bFill, 0);

    // The wallet now holds both positions' tokens under one mint.
    expect(await exec.balance(MINT)).toBeCloseTo(a.originalQty + b.originalQty, 4);

    await copy.closeOut(b, 'manual', 'the wallet we copy is out');

    const closed = copyStore.getPosition(b.id)!;
    expect(closed.status).toBe('closed');
    // It sold ITS tokens, not the pooled balance.
    expect(closed.realizedSol).toBeGreaterThan(0);

    const left = (await exec.balance(MINT))!;
    expect(left).toBeCloseTo(a.originalQty, 4);

    // And the other position is intact and still sellable.
    const survivor = sniperStore.getPosition(a.id)!;
    expect(survivor.status).toBe('open');
    expect(survivor.remainingQty).toBeCloseTo(a.originalQty, 4);
  });

  it('lets the second position exit for a real price afterwards', async () => {
    // The reported symptom: the survivor was booked at -100% with "no balance
    // to sell" on a token that had just been sold at a profit.
    const aFill = await exec.buy(CANDIDATE, 0.25);
    const a = sniper.open(CANDIDATE, aFill, 80);
    const bFill = await exec.buy(CANDIDATE, 0.25);
    const b = copy.open(CANDIDATE, bFill, 0);

    await copy.closeOut(b, 'manual', 'copied wallet is out');
    await sniper.closeOut(a, 'manual', 'our own exit');

    const survivor = sniperStore.getPosition(a.id)!;
    expect(survivor.status).toBe('closed');
    expect(survivor.closeReason).not.toMatch(/no longer held/);
    expect(survivor.realizedSol).toBeGreaterThan(0);

    const journalled = sniperStore.journal()[0]!;
    expect(journalled.pnlPct).toBeGreaterThan(-100);
  });

  it('never lets a position claim more tokens than it bought', async () => {
    // Reconciliation reads a per-MINT balance, which is larger than this
    // position's share whenever another bot holds the same token. Adopting it
    // would have one position try to sell the other's tokens.
    const aFill = await exec.buy(CANDIDATE, 0.25);
    const a = sniper.open(CANDIDATE, aFill, 80);
    await exec.buy(CANDIDATE, 0.25); // a second bot's buy, same mint

    await sniper.externalExit(a, 'manual', 'trim a quarter', a.remainingQty * 0.25);

    const after = sniperStore.getPosition(a.id)!;
    expect(after.status).toBe('open');
    // Three quarters of what IT bought, not three quarters of the pool.
    expect(after.remainingQty).toBeCloseTo(aFill.receivedQty * 0.75, 4);
  });

  it('still exits cleanly when it is the only holder', async () => {
    const fill = await exec.buy(CANDIDATE, 0.25);
    const p = sniper.open(CANDIDATE, fill, 80);

    await sniper.closeOut(p, 'manual', 'done');

    expect(sniperStore.getPosition(p.id)!.status).toBe('closed');
    expect(await exec.balance(MINT)).toBeCloseTo(0, 6);
  });
});
