import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiOrchestrator } from '../src/ai/orchestrator.js';
import { PositionManager } from '../src/strategy/position-manager.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PriceSource } from '../src/execution/pricing.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import type { TokenCandidate } from '../src/types.js';
import type { TokenSocials } from '../src/watchlist/metadata.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ENTRY_MODE: 'screener',
} as unknown as NodeJS.ProcessEnv;

const SOL_USD = 200;

class StubPrices implements PriceSource {
  async curve(): Promise<BondingCurveState | null> {
    return {
      virtualSolReserves: 45_000_000_000n,
      virtualTokenReserves: 715_333_333_000_000n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    };
  }
  async price(): Promise<number | null> {
    return 45 / 715_333_333;
  }
}

const CANDIDATE: TokenCandidate = {
  mint: 'Mint1111111111111111111111111111111111111',
  creator: 'Dev11111111111111111111111111111111111111',
  symbol: 'SCRN',
  pool: 'pump',
  uri: 'https://ipfs.io/ipfs/abc',
  detectedAt: Date.now(),
  source: 'test',
  vSolInBondingCurve: 30,
  vTokensInBondingCurve: 1_073_000_000,
  initialBuySol: 0.5,
};

let dir: string;
let cfg: Config;
let store: Store;
let ai: AiOrchestrator;
let socialsCalls: number;
let socials: TokenSocials;

function build(overrides: Record<string, string> = {}): void {
  dir = mkdtempSync(join(tmpdir(), 'sniper-screener-'));
  cfg = loadConfig({ ...BASE_ENV, ...overrides, DATA_DIR: dir });
  store = new Store(dir);
  const exec = new PaperExecutor(cfg, new StubPrices());
  const risk = new RiskManager(cfg, store, join(dir, 'nostop'));
  socialsCalls = 0;
  socials = { checked: true, failed: false, count: 1, twitter: 'https://x.com/x' };

  ai = new AiOrchestrator({
    cfg,
    store,
    executor: exec,
    risk,
    positions: new PositionManager(cfg, store, exec, risk),
    walletBalance: async () => 10,
    trackTrades: () => {},
    untrackTrades: () => {},
    solPrice: { usd: SOL_USD, isLive: true },
    socialsFetcher: async () => {
      socialsCalls += 1;
      return socials;
    },
  });
}

/** Six distinct buyers at 3 SOL each, moving the curve to ~$12.6k cap. */
function pushVolume(mint = CANDIDATE.mint, buyers = 6, solEach = 3, vSol = 45): void {
  for (let i = 0; i < buyers; i++) {
    ai.recordTrade({
      mint,
      trader: `buyer-${i}`,
      side: 'buy',
      solAmount: solEach,
      tokenAmount: 1000,
      vSolInCurve: vSol,
      at: Date.now(),
    });
  }
}

/** Lets the fire-and-forget entry path settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => build());
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('screener entry path', () => {
  it('fetches socials once, then buys without waiting for another trade', async () => {
    ai.observe(CANDIDATE);
    pushVolume();
    await settle();

    // Asked exactly once despite six trade events, and re-screened as soon as
    // the answer arrived. Waiting for the next trade would lose a token that
    // went quiet during the fetch — which is when a fast mover is over.
    expect(socialsCalls).toBe(1);
    const open = store.openPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.symbol).toBe('SCRN');
  });

  it('writes the matching filter values onto the position', async () => {
    ai.observe(CANDIDATE);
    pushVolume();
    await settle();

    const note = store.openPositions()[0]!.notes.find((n) => n.startsWith('screen:'));
    expect(note).toBeDefined();
    expect(note).toMatch(/mcap/);
    expect(note).toMatch(/volume/);
  });

  it('opens exactly one position however many trades arrive', async () => {
    ai.observe(CANDIDATE);
    for (let i = 0; i < 6; i++) pushVolume();
    await settle();

    expect(store.openPositions()).toHaveLength(1);
    expect(ai.snapshotStats().screenMatched).toBe(1);
  });

  it('does not buy when the metadata loads and has no socials', async () => {
    socials = { checked: true, failed: false, count: 0 };
    ai.observe(CANDIDATE);
    pushVolume();
    await settle();
    pushVolume();
    await settle();

    expect(store.openPositions()).toHaveLength(0);
    expect(ai.snapshotStats().screenRejects.socials).toBeGreaterThan(0);
  });

  it('still buys when the metadata could not be read at all', async () => {
    // A rate-limited IPFS gateway must not silently veto every entry.
    socials = { checked: true, failed: true, count: 0 };
    ai.observe(CANDIDATE);
    pushVolume();
    await settle();

    expect(store.openPositions()).toHaveLength(1);
  });

  it('never drops a match because another entry was in flight', async () => {
    // Two tokens matching at the same instant must both be bought, not one
    // bought and the other silently discarded.
    ai.observe(CANDIDATE);
    ai.observe({ ...CANDIDATE, mint: 'Mint2222222222222222222222222222222222222', symbol: 'TWO' });
    pushVolume(CANDIDATE.mint);
    pushVolume('Mint2222222222222222222222222222222222222');
    await new Promise((r) => setTimeout(r, 40));

    const symbols = store.openPositions().map((p) => p.symbol).sort();
    expect(symbols).toEqual(['SCRN', 'TWO']);
  });

  it('reports a match it could not act on rather than swallowing it', async () => {
    build({ MAX_CONCURRENT_POSITIONS: '1' });
    ai.observe(CANDIDATE);
    ai.observe({ ...CANDIDATE, mint: 'Mint2222222222222222222222222222222222222', symbol: 'TWO' });
    pushVolume(CANDIDATE.mint);
    pushVolume('Mint2222222222222222222222222222222222222');
    await new Promise((r) => setTimeout(r, 40));

    const stats = ai.snapshotStats();
    expect(stats.screenMatched).toBe(2);
    expect(store.openPositions()).toHaveLength(1);
    expect(stats.blockedByRisk).toBe(1);
    expect(stats.lastBlockReason).toMatch(/position limit/);
  });

  it('does not spend a metadata fetch on a token failing a cheap filter', async () => {
    ai.observe({ ...CANDIDATE, mint: 'Mint2', pool: 'raydium' });
    pushVolume('Mint2');
    await settle();

    expect(socialsCalls).toBe(0);
    expect(ai.snapshotStats().screenRejects.pool).toBeGreaterThan(0);
  });

  it('attributes rejections to the filter that caused them', async () => {
    ai.observe(CANDIDATE);
    // Plenty of buyers, nowhere near the volume floor.
    pushVolume(CANDIDATE.mint, 6, 0.1, 45);
    await settle();

    const rejects = ai.snapshotStats().screenRejects;
    expect(rejects.volume).toBeGreaterThan(0);
    expect(rejects.mcap_low).toBeUndefined();
    expect(socialsCalls).toBe(0);
  });

  it('ignores trades for tokens it never saw launch', async () => {
    pushVolume('UnknownMint');
    await settle();
    expect(store.openPositions()).toHaveLength(0);
    expect(socialsCalls).toBe(0);
  });

  it('leaves the momentum path alone in fast mode', async () => {
    build({ ENTRY_MODE: 'fast' });
    ai.observe(CANDIDATE);
    pushVolume();
    await settle();
    // No socials fetch: the screener is not running.
    expect(socialsCalls).toBe(0);
  });
});
