import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperExecutor } from '../src/execution/paper.js';
import { reservesOf, solOut, tokensOut, type PriceSource } from '../src/execution/pricing.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import { PositionManager } from '../src/strategy/position-manager.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TokenCandidate } from '../src/types.js';

class StubPrices implements PriceSource {
  vSol = 30;
  vTokens = 1_073_000_000;
  complete = false;
  missing = false;

  async curve(): Promise<BondingCurveState | null> {
    if (this.missing) return null;
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
    if (this.missing) return null;
    return this.vSol / this.vTokens;
  }
}

const CANDIDATE: TokenCandidate = {
  mint: 'Mint1111111111111111111111111111111111111',
  creator: 'Dev1',
  symbol: 'PAPER',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
};

let dir: string;
let cfg: Config;
let prices: StubPrices;
let exec: PaperExecutor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-paper-'));
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
  } as unknown as NodeJS.ProcessEnv);
  prices = new StubPrices();
  exec = new PaperExecutor(cfg, prices);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('constant-product maths', () => {
  it('matches the curve formula for a buy', () => {
    const r = { vSol: 30, vTokens: 1_073_000_000 };
    const out = tokensOut(r, 1);
    // k / (30+1) subtracted from the token reserve.
    const expected = r.vTokens - (r.vSol * r.vTokens) / 31;
    expect(out).toBeCloseTo(expected, 6);
  });

  it('round-trips at a loss, because price impact is real', () => {
    const r = { vSol: 30, vTokens: 1_073_000_000 };
    const bought = tokensOut(r, 1);
    // Selling straight back into the moved curve returns less than 1 SOL.
    const moved = { vSol: r.vSol + 1, vTokens: r.vTokens - bought };
    const back = solOut(moved, bought);
    expect(back).toBeLessThanOrEqual(1.0000001);
    expect(back).toBeGreaterThan(0.99);
  });

  it('returns zero for nonsense inputs', () => {
    expect(tokensOut({ vSol: 0, vTokens: 0 }, 1)).toBe(0);
    expect(tokensOut({ vSol: 30, vTokens: 1e9 }, -1)).toBe(0);
    expect(solOut({ vSol: 30, vTokens: 1e9 }, 0)).toBe(0);
  });

  it('converts curve reserves out of base units', () => {
    const r = reservesOf({
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 0n,
      complete: false,
    });
    expect(r.vSol).toBeCloseTo(30);
    expect(r.vTokens).toBeCloseTo(1_073_000_000);
  });
});

describe('paper buys use live curve state', () => {
  it('fills at the price the real curve would have given', async () => {
    const res = await exec.buy(CANDIDATE, 0.05);
    expect(res.ok).toBe(true);
    const expected = tokensOut({ vSol: 30, vTokens: 1_073_000_000 }, 0.05);
    expect(res.receivedQty).toBeCloseTo(expected, 3);
    // Cost includes the 1% program fee and the priority fee we would have paid.
    expect(res.spentSol).toBeCloseTo(0.05 + 0.0005 + cfg.PRIORITY_FEE_SOL, 6);
  });

  it('refuses a token with no bonding curve on chain', async () => {
    prices.missing = true;
    const res = await exec.buy(CANDIDATE, 0.05);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no bonding curve/);
  });

  it('refuses a token that already graduated', async () => {
    prices.complete = true;
    const res = await exec.buy(CANDIDATE, 0.05);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/graduated/);
  });

  it('prices bigger buys worse, because impact scales', async () => {
    const small = tokensOut({ vSol: 30, vTokens: 1_073_000_000 }, 0.05);
    const big = tokensOut({ vSol: 30, vTokens: 1_073_000_000 }, 5);
    // Per-SOL, the large buy gets fewer tokens.
    expect(big / 5).toBeLessThan(small / 0.05);
  });
});

describe('paper sells are priced off the live curve', () => {
  it('books proceeds including its own impact', async () => {
    const buy = await exec.buy(CANDIDATE, 0.05);
    const position = {
      mint: CANDIDATE.mint,
      symbol: 'PAPER',
      pool: 'pump' as const,
      remainingQty: buy.receivedQty,
    };
    const res = await exec.sell(position as never, buy.receivedQty, true);
    expect(res.ok).toBe(true);
    // A full immediate round trip loses the fees and the spread, never gains.
    expect(res.receivedSol).toBeLessThan(buy.spentSol);
    expect(res.receivedSol).toBeGreaterThan(0);
  });

  it('reports the stuck-holding case when price disappears', async () => {
    const buy = await exec.buy(CANDIDATE, 0.05);
    // Curve gone AND no AMM quote: exactly the shape of a rug.
    prices.missing = true;
    const res = await exec.sell(
      { mint: CANDIDATE.mint, remainingQty: buy.receivedQty } as never,
      buy.receivedQty,
      true,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stuck holding/);
  });

  it('will not sell more than the paper balance holds', async () => {
    const buy = await exec.buy(CANDIDATE, 0.05);
    const res = await exec.sell(
      { mint: CANDIDATE.mint, remainingQty: buy.receivedQty } as never,
      buy.receivedQty * 10,
      false,
    );
    expect(res.soldQty).toBeCloseTo(buy.receivedQty, 3);
  });
});

describe('paper mode tracks a real rug to the floor', () => {
  it('stops out when the curve is drained, and books the loss', async () => {
    const store = new Store(dir);
    const risk = new RiskManager(cfg, store, join(dir, 'nostop'));
    const manager = new PositionManager(cfg, store, exec, risk);

    const fill = await exec.buy(CANDIDATE, 0.05);
    const p = manager.open(CANDIDATE, fill, 90);

    // Deployer dumps: SOL reserves collapse, price craters.
    prices.vSol = 30;
    prices.vTokens = 1_073_000_000;
    const k = prices.vSol * prices.vTokens;
    prices.vSol = Math.sqrt(p.entryPrice * 0.2 * k);
    prices.vTokens = k / prices.vSol;

    await manager.tick();

    const closed = store.getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.closeReason).toMatch(/stop_loss/);

    const journal = store.journal();
    expect(journal[0]!.pnlSol).toBeLessThan(0);
    // The stop has to bound the damage; an -80% move must not cost -100%.
    expect(journal[0]!.pnlPct).toBeGreaterThan(-95);
  });
});
