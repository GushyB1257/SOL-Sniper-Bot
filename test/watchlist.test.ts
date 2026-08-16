import { describe, it, expect, beforeEach } from 'vitest';
import { Watchlist } from '../src/watchlist/watchlist.js';
import { ladderFromTarget } from '../src/ai/orchestrator.js';
import { sanitiseEntry, sanitiseReview } from '../src/ai/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  STRATEGY: 'ai',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  WATCH_MIN_AGE_SECONDS: '90',
  WATCH_MAX_AGE_SECONDS: '1800',
  MIN_UNIQUE_BUYERS: '25',
  MIN_BUY_VOLUME_SOL: '3',
  MIN_RECENT_BUYERS: '4',
  MIN_PRICE_CHANGE_PCT: '-10',
} as unknown as NodeJS.ProcessEnv;

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
};

/** Adds `count` buys from distinct wallets, nudging the curve upward. */
function addBuyers(mint: string, count: number, at: number, vSol = 34): void {
  for (let i = 0; i < count; i++) {
    wl.recordTrade({
      mint,
      trader: `buyer-${i}`,
      side: 'buy',
      solAmount: 0.2,
      tokenAmount: 1000,
      vSolInCurve: vSol,
      at,
    });
  }
}

beforeEach(() => {
  cfg = loadConfig(BASE_ENV);
  wl = new Watchlist(cfg);
});

describe('watchlist tracking', () => {
  it('adds a candidate once', () => {
    expect(wl.add(CANDIDATE)).toBe(true);
    expect(wl.add(CANDIDATE)).toBe(false);
    expect(wl.size).toBe(1);
  });

  it('respects the size cap so a launch storm cannot exhaust memory', () => {
    const small = loadConfig({ ...BASE_ENV, WATCHLIST_MAX_SIZE: '10' });
    const capped = new Watchlist(small);
    for (let i = 0; i < 50; i++) {
      capped.add({ ...CANDIDATE, mint: `mint-${i}` });
    }
    expect(capped.size).toBe(10);
  });

  it('accumulates buy and sell flow', () => {
    wl.add(CANDIDATE);
    const now = Date.now();
    addBuyers(CANDIDATE.mint, 5, now);
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: 'seller-1',
      side: 'sell',
      solAmount: 0.1,
      tokenAmount: 500,
      at: now,
    });

    const m = wl.metrics(wl.get(CANDIDATE.mint)!, now);
    expect(m.uniqueBuyers).toBe(5);
    expect(m.uniqueSellers).toBe(1);
    expect(m.buyVolumeSol).toBeCloseTo(1.0);
    expect(m.volumeRatio).toBeCloseTo(10);
  });

  it('flags the deployer selling — the single worst signal on a launch', () => {
    wl.add(CANDIDATE);
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: CANDIDATE.creator,
      side: 'sell',
      solAmount: 2.5,
      tokenAmount: 1e6,
      at: Date.now(),
    });
    const m = wl.metrics(wl.get(CANDIDATE.mint)!);
    expect(m.deployerSold).toBe(true);
    expect(m.deployerSoldSol).toBeCloseTo(2.5);
  });

  it('measures the buyer wave across two windows', () => {
    wl.add(CANDIDATE);
    const now = Date.now();
    // 3 buyers 90s ago, 6 buyers just now.
    for (let i = 0; i < 3; i++) {
      wl.recordTrade({
        mint: CANDIDATE.mint,
        trader: `old-${i}`,
        side: 'buy',
        solAmount: 0.1,
        tokenAmount: 10,
        at: now - 90_000,
      });
    }
    for (let i = 0; i < 6; i++) {
      wl.recordTrade({
        mint: CANDIDATE.mint,
        trader: `new-${i}`,
        side: 'buy',
        solAmount: 0.1,
        tokenAmount: 10,
        at: now - 5_000,
      });
    }
    const m = wl.metrics(wl.get(CANDIDATE.mint)!, now);
    expect(m.buyersLast60s).toBe(6);
    expect(m.buyersPrev60s).toBe(3);
  });

  it('derives price change from the curve reserves', () => {
    wl.add(CANDIDATE);
    const now = Date.now();
    // vSol 30 → 60 is a 2x reserve move, which is 4x on a constant-product price.
    addBuyers(CANDIDATE.mint, 1, now, 60);
    const m = wl.metrics(wl.get(CANDIDATE.mint)!, now);
    expect(m.priceChangePct).toBeCloseTo(300, 0);
  });
});

describe('traction gate', () => {
  const ready = (mint: string, now: number) => {
    wl.add({ ...CANDIDATE, mint });
    const t = wl.get(mint)!;
    t.firstSeen = now - 300_000; // 5 minutes old
    addBuyers(mint, 30, now - 5_000);
    return t;
  };

  it('graduates a token with real traction', () => {
    const now = Date.now();
    ready(CANDIDATE.mint, now);
    const grads = wl.graduates(now);
    expect(grads).toHaveLength(1);
    expect(grads[0]!.metrics.uniqueBuyers).toBe(30);
  });

  it('holds back a token that is still too young', () => {
    const now = Date.now();
    wl.add(CANDIDATE);
    addBuyers(CANDIDATE.mint, 30, now);
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('rejects a token whose move already happened', () => {
    const now = Date.now();
    const t = ready(CANDIDATE.mint, now);
    t.firstSeen = now - 4000_000; // well past the max age
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('rejects too few unique buyers even with high volume', () => {
    const now = Date.now();
    wl.add(CANDIDATE);
    const t = wl.get(CANDIDATE.mint)!;
    t.firstSeen = now - 300_000;
    // Three wallets trading heavily with each other is wash volume, not a crowd.
    for (let i = 0; i < 60; i++) {
      wl.recordTrade({
        mint: CANDIDATE.mint,
        trader: `whale-${i % 3}`,
        side: 'buy',
        solAmount: 1,
        tokenAmount: 100,
        vSolInCurve: 40,
        at: now - 5_000,
      });
    }
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('rejects a stalled wave — no new buyers recently', () => {
    const now = Date.now();
    wl.add(CANDIDATE);
    const t = wl.get(CANDIDATE.mint)!;
    t.firstSeen = now - 300_000;
    addBuyers(CANDIDATE.mint, 30, now - 200_000); // all arrived long ago
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('rejects a token the deployer has sold into', () => {
    const now = Date.now();
    ready(CANDIDATE.mint, now);
    wl.recordTrade({
      mint: CANDIDATE.mint,
      trader: CANDIDATE.creator,
      side: 'sell',
      solAmount: 1,
      tokenAmount: 1e6,
      at: now,
    });
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('rejects a token where sellers outnumber buyers', () => {
    const now = Date.now();
    ready(CANDIDATE.mint, now);
    for (let i = 0; i < 40; i++) {
      wl.recordTrade({
        mint: CANDIDATE.mint,
        trader: `seller-${i}`,
        side: 'sell',
        solAmount: 0.1,
        tokenAmount: 10,
        at: now,
      });
    }
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('never re-sends a token that was already analysed', () => {
    const now = Date.now();
    ready(CANDIDATE.mint, now);
    expect(wl.graduates(now)).toHaveLength(1);
    wl.markAnalysed(CANDIDATE.mint);
    expect(wl.graduates(now)).toHaveLength(0);
  });

  it('ranks graduates by buy volume so the position cap buys the best', () => {
    const now = Date.now();
    ready('mint-weak', now);
    ready('mint-strong', now);
    wl.recordTrade({
      mint: 'mint-strong',
      trader: 'whale',
      side: 'buy',
      solAmount: 50,
      tokenAmount: 1e6,
      vSolInCurve: 45,
      at: now,
    });
    expect(wl.graduates(now)[0]!.token.candidate.mint).toBe('mint-strong');
  });

  it('prunes stale entries', () => {
    const now = Date.now();
    wl.add(CANDIDATE);
    wl.get(CANDIDATE.mint)!.firstSeen = now - 10_000_000;
    expect(wl.prune(now)).toBe(1);
    expect(wl.size).toBe(0);
  });
});

describe('decision sanitising', () => {
  const base = {
    action: 'buy' as const,
    conviction: 'high' as const,
    thesis: 'x',
    risks: [],
    supporting_signals: [],
  };

  it('clamps a confidence outside 0-100', () => {
    expect(
      sanitiseEntry({
        ...base,
        confidence: 900,
        expected_hold_seconds: 60,
        target_gain_pct: 50,
        invalidation_loss_pct: 20,
      }).confidence,
    ).toBe(100);
  });

  it('takes the magnitude of a negative invalidation level', () => {
    // The model may express the stop as -25 or 25; both mean the same thing.
    expect(
      sanitiseEntry({
        ...base,
        confidence: 80,
        expected_hold_seconds: 60,
        target_gain_pct: 50,
        invalidation_loss_pct: -25,
      }).invalidation_loss_pct,
    ).toBe(25);
  });

  it('caps an invalidation level that would allow a near-total loss', () => {
    expect(
      sanitiseEntry({
        ...base,
        confidence: 80,
        expected_hold_seconds: 60,
        target_gain_pct: 50,
        invalidation_loss_pct: 99,
      }).invalidation_loss_pct,
    ).toBe(95);
  });

  it('survives non-finite numbers', () => {
    const out = sanitiseEntry({
      ...base,
      confidence: NaN,
      expected_hold_seconds: Infinity,
      target_gain_pct: NaN,
      invalidation_loss_pct: NaN,
    });
    expect(out.confidence).toBe(0);
    expect(Number.isFinite(out.expected_hold_seconds)).toBe(true);
  });

  it('clamps a trim percentage', () => {
    expect(
      sanitiseReview({ action: 'trim', trim_pct: 250, reason: 'x', thesis_intact: true }).trim_pct,
    ).toBe(100);
  });
});

describe('ladderFromTarget', () => {
  it('builds an ascending ladder around the analyst target', () => {
    const l = ladderFromTarget(80);
    expect(l.map((t) => t.gainPct)).toEqual([40, 80, 200]);
    expect(l.reduce((a, t) => a + t.sellPctOfOriginal, 0)).toBe(90);
  });

  it('keeps rungs ascending even for a tiny target', () => {
    const l = ladderFromTarget(1);
    for (let i = 1; i < l.length; i++) {
      expect(l[i]!.gainPct).toBeGreaterThan(l[i - 1]!.gainPct);
    }
  });

  it('always leaves a runner', () => {
    for (const target of [5, 20, 100, 1000]) {
      const sold = ladderFromTarget(target).reduce((a, t) => a + t.sellPctOfOriginal, 0);
      expect(sold).toBeLessThan(100);
    }
  });
});
