import { describe, it, expect, beforeEach } from 'vitest';
import { Watchlist, volumeOf } from '../src/watchlist/watchlist.js';
import { marketCapFromState } from '../src/watchlist/curve-poller.js';
import { screenerSignal } from '../src/strategy/screener.js';
import { loadConfig, type Config } from '../src/config.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import type { TokenCandidate } from '../src/types.js';

/**
 * The chain-read path exists because the trade feed cannot answer for trades
 * that happened before we subscribed — which, for a token we are meeting for
 * the first time, is all of them. These tests pin that property specifically.
 */

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
} as unknown as NodeJS.ProcessEnv;

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
};

/** A pump.fun curve with `solIn` SOL deposited by real buyers. */
function curve(solIn: number, complete = false): BondingCurveState {
  // Virtual reserves move with the real ones on a constant-product curve.
  const vSol = 30 + solIn;
  const k = 30 * 1_073_000_000;
  const vTokens = k / vSol;
  return {
    virtualSolReserves: BigInt(Math.round(vSol * 1e9)),
    virtualTokenReserves: BigInt(Math.round(vTokens * 1e6)),
    realSolReserves: BigInt(Math.round(solIn * 1e9)),
    realTokenReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete,
  };
}

beforeEach(() => {
  cfg = loadConfig(BASE_ENV);
  wl = new Watchlist(cfg);
  wl.add(CANDIDATE);
});

describe('marketCapFromState', () => {
  it('matches the launch cap of a fresh curve', () => {
    // 30 vSOL / 1.073B tokens x 1B supply
    expect(marketCapFromState(curve(0))).toBeCloseTo(27.96, 1);
  });

  it('rises as SOL enters the curve', () => {
    const before = marketCapFromState(curve(0));
    const after = marketCapFromState(curve(20));
    expect(after).toBeGreaterThan(before * 2);
  });

  it('returns zero rather than NaN on an empty curve', () => {
    expect(
      marketCapFromState({
        virtualSolReserves: 0n,
        virtualTokenReserves: 0n,
        realSolReserves: 0n,
        realTokenReserves: 0n,
        tokenTotalSupply: 0n,
        complete: false,
      }),
    ).toBe(0);
  });
});

describe('recordCurve', () => {
  it('counts SOL already in the curve as volume on the first read', () => {
    // The decisive property: this token traded 25 SOL before we ever saw it,
    // and the trade feed would report zero volume for it forever.
    expect(wl.recordCurve(CANDIDATE.mint, curve(25))).toBe(true);
    expect(volumeOf(wl.get(CANDIDATE.mint)!)).toBeCloseTo(25);
  });

  it('adds movement in both directions after the first read', () => {
    wl.recordCurve(CANDIDATE.mint, curve(10));
    wl.recordCurve(CANDIDATE.mint, curve(18)); // +8 bought
    wl.recordCurve(CANDIDATE.mint, curve(15)); // -3 sold
    // 10 seen + 8 + 3 of movement — sells are volume too.
    expect(volumeOf(wl.get(CANDIDATE.mint)!)).toBeCloseTo(21);
  });

  it('does not double count a curve that has not moved', () => {
    wl.recordCurve(CANDIDATE.mint, curve(10));
    wl.recordCurve(CANDIDATE.mint, curve(10));
    wl.recordCurve(CANDIDATE.mint, curve(10));
    expect(volumeOf(wl.get(CANDIDATE.mint)!)).toBeCloseTo(10);
  });

  it('takes the larger of the two volume estimates, never the sum', () => {
    const t = wl.get(CANDIDATE.mint)!;
    t.buyVolumeSol = 4; // what the feed happened to catch
    wl.recordCurve(CANDIDATE.mint, curve(25));
    expect(volumeOf(t)).toBeCloseTo(25);

    t.buyVolumeSol = 40; // feed now knows more than the curve's net figure
    expect(volumeOf(t)).toBeCloseTo(40);
  });

  it('marks a graduated token and stops claiming an update', () => {
    expect(wl.recordCurve(CANDIDATE.mint, curve(85, true))).toBe(false);
    expect(wl.get(CANDIDATE.mint)!.graduated).toBe(true);
  });

  it('updates market cap and the peak', () => {
    wl.recordCurve(CANDIDATE.mint, curve(30));
    const peak = wl.get(CANDIDATE.mint)!.peakMarketCapSol;
    wl.recordCurve(CANDIDATE.mint, curve(5));
    const t = wl.get(CANDIDATE.mint)!;
    expect(t.latestMarketCapSol).toBeLessThan(peak);
    expect(t.peakMarketCapSol).toBe(peak);
  });

  it('ignores a curve for a token it is not watching', () => {
    expect(wl.recordCurve('NotWatched', curve(10))).toBe(false);
  });
});

describe('screening off chain reads alone', () => {
  it('matches a token whose trades were never seen', () => {
    // No trade events at all — only what the chain says.
    wl.recordCurve(CANDIDATE.mint, curve(28));
    wl.claimSocialsFetch(CANDIDATE.mint);
    wl.setSocials(CANDIDATE.mint, { checked: true, failed: false, count: 1 });

    const v = screenerSignal(wl.get(CANDIDATE.mint)!, cfg, SOL_USD);
    expect(v.outcome).toBe('fire');
    expect(v.snapshot.volumeUsd).toBeCloseTo(28 * SOL_USD);
    expect(v.snapshot.marketCapUsd).toBeGreaterThan(cfg.SCREEN_MIN_MCAP_USD);
  });
});

describe('pollable', () => {
  it('returns the youngest tokens first', () => {
    const w = new Watchlist(cfg);
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      w.add({ ...CANDIDATE, mint: `m${i}` });
      w.get(`m${i}`)!.firstSeen = now - i * 1000;
    }
    expect(w.pollable(3, now)).toEqual(['m0', 'm1', 'm2']);
  });

  it('skips tokens outside the entry window', () => {
    const w = new Watchlist(cfg);
    const now = Date.now();
    w.add({ ...CANDIDATE, mint: 'fresh' });
    w.add({ ...CANDIDATE, mint: 'stale' });
    w.get('stale')!.firstSeen = now - (cfg.SCREEN_MAX_AGE_SECONDS + 60) * 1000;
    expect(w.pollable(10, now)).toEqual(['fresh']);
  });

  it('stops polling tokens it can no longer act on', () => {
    const w = new Watchlist(cfg);
    w.add({ ...CANDIDATE, mint: 'traded' });
    w.add({ ...CANDIDATE, mint: 'gone' });
    w.add({ ...CANDIDATE, mint: 'nocurve' });
    w.add({ ...CANDIDATE, mint: 'live' });
    w.markAnalysed('traded');
    w.recordCurve('gone', curve(85, true));
    w.markCurveMissing('nocurve');
    expect(w.pollable(10)).toEqual(['live']);
  });
});
