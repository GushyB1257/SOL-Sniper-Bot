import { describe, it, expect, beforeEach } from 'vitest';
import { Watchlist, marketCapFromCurve } from '../src/watchlist/watchlist.js';
import { screenerSignal, screenSnapshot } from '../src/strategy/screener.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
} as unknown as NodeJS.ProcessEnv;

/** A round number keeps the USD arithmetic in these tests readable. */
const SOL_USD = 200;

let cfg: Config;
let wl: Watchlist;

const CANDIDATE: TokenCandidate = {
  mint: 'Mint1111111111111111111111111111111111111',
  creator: 'Dev11111111111111111111111111111111111111',
  symbol: 'TEST',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
  vSolInBondingCurve: 30,
  vTokensInBondingCurve: 1_073_000_000,
  initialBuySol: 0.5,
};

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

/**
 * Drives the token to a given market cap and volume the way real trading would
 * — through the curve — rather than by writing the fields directly.
 */
function trade(
  mint: string,
  opts: { buyers?: number; solEach?: number; vSol?: number; at?: number; side?: 'buy' | 'sell' } = {},
): void {
  const { buyers = 1, solEach = 1, vSol, at = Date.now(), side = 'buy' } = opts;
  for (let i = 0; i < buyers; i++) {
    wl.recordTrade({
      mint,
      trader: `${side}er-${i}`,
      side,
      solAmount: solEach,
      tokenAmount: 1000,
      vSolInCurve: vSol,
      at,
    });
  }
}

function withSocials(mint: string, count: number): void {
  wl.claimSocialsFetch(mint);
  wl.setSocials(mint, {
    checked: true,
    count,
    twitter: count > 0 ? 'https://x.com/x' : undefined,
  });
}

beforeEach(() => {
  cfg = config();
  wl = new Watchlist(cfg);
  wl.add(CANDIDATE);
});

describe('market cap derivation', () => {
  it('puts a fresh pump.fun curve just under $6k at $200 SOL', () => {
    // 30 vSOL against 1.073B tokens is where every pump.fun launch starts.
    const capSol = marketCapFromCurve(30, 30 * 1_073_000_000);
    expect(capSol).toBeCloseTo(27.96, 1);
    expect(capSol * SOL_USD).toBeGreaterThan(5000);
    expect(capSol * SOL_USD).toBeLessThan(6000);
  });

  it('scales as the square of the reserves', () => {
    const k = 30 * 1_073_000_000;
    // Doubling virtual SOL quadruples the cap on a constant-product curve.
    expect(marketCapFromCurve(60, k) / marketCapFromCurve(30, k)).toBeCloseTo(4);
  });

  it('refuses to invent a cap from garbage reserves', () => {
    expect(marketCapFromCurve(0, 1)).toBe(0);
    expect(marketCapFromCurve(10, 0)).toBe(0);
    expect(marketCapFromCurve(-1, 1)).toBe(0);
  });

  it('prefers the cap the feed reports over the derived one', () => {
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: 'w',
      side: 'buy',
      solAmount: 1,
      tokenAmount: 1,
      vSolInCurve: 35,
      marketCapSol: 999,
      at: Date.now(),
    });
    expect(wl.get(CANDIDATE.mint)!.latestMarketCapSol).toBe(999);
  });
});

describe('volume accounting', () => {
  it('counts both sides and the creation buy', () => {
    trade(CANDIDATE.mint, { buyers: 3, solEach: 2, vSol: 33 });
    trade(CANDIDATE.mint, { buyers: 1, solEach: 1, vSol: 33, side: 'sell' });
    const s = screenSnapshot(wl.get(CANDIDATE.mint)!, SOL_USD);
    // 0.5 creation + 6 bought + 1 sold
    expect(s.volumeSol).toBeCloseTo(7.5);
    expect(s.volumeUsd).toBeCloseTo(1500);
  });
});

describe('screenerSignal', () => {
  /** Puts the token squarely inside every default threshold. */
  function qualify(): void {
    // 45 vSOL is ~$12.6k cap at $200; 6 buyers at 3 SOL is $3.6k volume.
    trade(CANDIDATE.mint, { buyers: 6, solEach: 3, vSol: 45 });
    withSocials(CANDIDATE.mint, 1);
  }

  it('fires when every filter matches', () => {
    qualify();
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('fire');
    expect(v.fire).toBe(true);
    expect(v.reason).toContain('mcap');
    expect(v.snapshot.marketCapUsd).toBeGreaterThan(cfg.SCREEN_MIN_MCAP_USD);
    expect(v.snapshot.volumeUsd).toBeGreaterThan(cfg.SCREEN_MIN_VOLUME_USD);
  });

  it('rejects a venue outside the allowed pools', () => {
    const other = new Watchlist(cfg);
    other.add({ ...CANDIDATE, mint: 'Mint2', pool: 'raydium' });
    const v = screenerSignal(other.get('Mint2')!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toContain('pool raydium');
  });

  it('accepts a second venue when configured to', () => {
    const c = config({ SCREEN_ALLOWED_POOLS: 'pump,pump-amm' });
    const other = new Watchlist(c);
    other.add({ ...CANDIDATE, mint: 'Mint2', pool: 'pump-amm' });
    for (let i = 0; i < 6; i++) {
      other.recordTrade({
        mint: 'Mint2',
        trader: `w${i}`,
        side: 'buy',
        solAmount: 3,
        tokenAmount: 1,
        vSolInCurve: 45,
        at: Date.now(),
      });
    }
    other.claimSocialsFetch('Mint2');
    other.setSocials('Mint2', { checked: true, count: 2 });
    expect(screenerSignal(other.get('Mint2')!, c, SOL_USD).outcome).toBe('fire');
  });

  it('rejects a cap below the floor', () => {
    // Still at the launch cap, ~$5.6k.
    trade(CANDIDATE.mint, { buyers: 8, solEach: 3, vSol: 30 });
    withSocials(CANDIDATE.mint, 1);
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/mcap .* below/);
  });

  it('rejects a cap above the ceiling — the move already happened', () => {
    trade(CANDIDATE.mint, { buyers: 8, solEach: 5, vSol: 80 });
    withSocials(CANDIDATE.mint, 1);
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/mcap .* above/);
  });

  it('treats a zero ceiling as no ceiling', () => {
    const c = config({ SCREEN_MAX_MCAP_USD: '0' });
    trade(CANDIDATE.mint, { buyers: 8, solEach: 5, vSol: 80 });
    withSocials(CANDIDATE.mint, 1);
    expect(screenerSignal(wl.get(CANDIDATE.mint)!, c, SOL_USD).outcome).toBe('fire');
  });

  it('rejects thin volume', () => {
    trade(CANDIDATE.mint, { buyers: 5, solEach: 0.5, vSol: 45 });
    withSocials(CANDIDATE.mint, 1);
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/^volume/);
  });

  it('rejects a token the deployer is already selling', () => {
    qualify();
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: CANDIDATE.creator,
      side: 'sell',
      solAmount: 1,
      tokenAmount: 1,
      vSolInCurve: 45,
      at: Date.now(),
    });
    expect(screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD).reason).toBe('deployer sold');
  });

  it('rejects a token past the age window', () => {
    qualify();
    const t = wl.get(CANDIDATE.mint)!;
    const v = screenerSignal(t, cfg, SOL_USD, t.firstSeen + (cfg.SCREEN_MAX_AGE_SECONDS + 10) * 1000);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/old \(max/);
  });

  it('honours a minimum age when one is set', () => {
    const c = config({ SCREEN_MIN_AGE_SECONDS: '30' });
    qualify();
    const t = wl.get(CANDIDATE.mint)!;
    expect(screenerSignal(t, c, SOL_USD, t.firstSeen + 5000).reason).toMatch(/old \(min/);
    expect(screenerSignal(t, c, SOL_USD, t.firstSeen + 40_000).outcome).toBe('fire');
  });

  it('asks for socials rather than guessing at them', () => {
    trade(CANDIDATE.mint, { buyers: 6, solEach: 3, vSol: 45 });
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('needs-socials');
    expect(v.fire).toBe(false);
  });

  it('rejects once the fetch comes back with none', () => {
    trade(CANDIDATE.mint, { buyers: 6, solEach: 3, vSol: 45 });
    withSocials(CANDIDATE.mint, 0);
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/socials \(need/);
  });

  it('never asks for socials when the filter does not require them', () => {
    const c = config({ SCREEN_MIN_SOCIALS: '0' });
    trade(CANDIDATE.mint, { buyers: 6, solEach: 3, vSol: 45 });
    expect(screenerSignal(wl.get(CANDIDATE.mint)!, c, SOL_USD).outcome).toBe('fire');
  });

  it('rejects a cap reached by one wallet', () => {
    trade(CANDIDATE.mint, { buyers: 1, solEach: 20, vSol: 45 });
    withSocials(CANDIDATE.mint, 1);
    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('reject');
    expect(v.reason).toMatch(/buyers \(need/);
  });

  it('scales every USD threshold with the SOL price', () => {
    qualify();
    const t = wl.get(CANDIDATE.mint)!;
    // Same on-chain state, a tenth of the SOL price: nothing clears the floors.
    expect(screenerSignal(t, cfg, SOL_USD).outcome).toBe('fire');
    expect(screenerSignal(t, cfg, SOL_USD / 10).outcome).toBe('reject');
  });

  it('claims the socials fetch exactly once', () => {
    expect(wl.claimSocialsFetch(CANDIDATE.mint)).toBe(true);
    expect(wl.claimSocialsFetch(CANDIDATE.mint)).toBe(false);
    wl.setSocials(CANDIDATE.mint, { checked: true, count: 1 });
    expect(wl.claimSocialsFetch(CANDIDATE.mint)).toBe(false);
  });
});

describe('screener config validation', () => {
  it('rejects an unknown venue', () => {
    expect(() => config({ SCREEN_ALLOWED_POOLS: 'pump,uniswap' })).toThrow(/unknown pool/);
  });

  it('rejects an empty venue list', () => {
    expect(() => config({ SCREEN_ALLOWED_POOLS: ' , ' })).toThrow(/empty/);
  });

  it('rejects an age window nothing can pass', () => {
    expect(() => config({ SCREEN_MIN_AGE_SECONDS: '300', SCREEN_MAX_AGE_SECONDS: '60' })).toThrow(
      /must be below/,
    );
  });

  it('rejects a cap window nothing can pass', () => {
    expect(() => config({ SCREEN_MIN_MCAP_USD: '30000', SCREEN_MAX_MCAP_USD: '6000' })).toThrow(
      /must be below/,
    );
  });

  it('refuses to hold screener entries against the long ladder', () => {
    expect(() => config({ ENTRY_MODE: 'screener', SCALP_MODE: 'false' })).toThrow(/SCALP_MODE/);
  });
});
