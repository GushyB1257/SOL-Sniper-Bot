import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '@solana/web3.js';
import { SafetyEngine } from '../src/safety/engine.js';
import type { Check } from '../src/safety/types.js';
import { devBuyCheck } from '../src/safety/checks/supply.js';
import { deployerHistoryCheck } from '../src/safety/checks/deployer.js';
import { metadataSanityCheck } from '../src/safety/checks/metadata.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  MIN_SAFETY_SCORE: '70',
  MAX_DEV_BUY_PCT: '8',
} as unknown as NodeJS.ProcessEnv;

let dir: string;
let store: Store;
let cfg: Config;
const fakeConn = {} as Connection;

function candidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    mint: 'Mint1111111111111111111111111111111111111',
    creator: 'Dev11111111111111111111111111111111111111',
    name: 'Test Token',
    symbol: 'TEST',
    pool: 'pump',
    detectedAt: Date.now(),
    source: 'test',
    ...overrides,
  };
}

function ctxFor(c: TokenCandidate) {
  return { candidate: c, conn: fakeConn, cfg, store, cache: new Map<string, unknown>() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-safety-'));
  cfg = loadConfig({ ...BASE_ENV, DATA_DIR: dir });
  store = new Store(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('devBuyCheck', () => {
  it('passes when the deployer takes nothing', async () => {
    const r = await devBuyCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('passes a modest deployer stake', async () => {
    // 2% of the 1B supply.
    const r = await devBuyCheck.run(ctxFor(candidate({ initialBuyTokens: 20_000_000 })));
    expect(r.passed).toBe(true);
  });

  it('rejects a deployer who front-loads a large slice of supply', async () => {
    // 25% of supply — everyone who buys after this is exit liquidity.
    const r = await devBuyCheck.run(ctxFor(candidate({ initialBuyTokens: 250_000_000 })));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/25\.0% of supply/);
  });

  it('is fatal, so it vetoes regardless of score', () => {
    expect(devBuyCheck.severity).toBe('fatal');
  });
});

describe('deployerHistoryCheck', () => {
  it('is permissive without a meaningful sample', async () => {
    store.recordCreatorLaunch('Dev11111111111111111111111111111111111111', 'm1');
    store.recordCreatorOutcome('Dev11111111111111111111111111111111111111', true);
    const r = await deployerHistoryCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('rejects a deployer with a proven rug rate', async () => {
    const dev = 'Dev11111111111111111111111111111111111111';
    for (let i = 0; i < 5; i++) store.recordCreatorLaunch(dev, `m${i}`);
    for (let i = 0; i < 4; i++) store.recordCreatorOutcome(dev, true);
    store.recordCreatorOutcome(dev, false);

    const r = await deployerHistoryCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/rugged 4\/5/);
  });
});

describe('metadataSanityCheck', () => {
  it('accepts an ordinary ticker', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('rejects Cyrillic homoglyph impersonation', async () => {
    // "ВОNK" — the В and О are Cyrillic, so it renders as BONK in a list.
    const r = await metadataSanityCheck.run(ctxFor(candidate({ symbol: 'ВОNK' })));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/homoglyph/);
  });

  it('rejects zero-width character padding', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate({ name: 'Sol​ana' })));
    expect(r.passed).toBe(false);
  });

  it('rejects an absurdly long name', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate({ name: 'x'.repeat(200) })));
    expect(r.passed).toBe(false);
  });
});

describe('SafetyEngine scoring', () => {
  const passing = (id: string, penalty = 20): Check => ({
    id,
    severity: 'major',
    penalty,
    timeoutMs: 100,
    failClosed: false,
    run: async () => ({ passed: true, detail: 'ok' }),
  });
  const failing = (id: string, penalty = 20, severity: Check['severity'] = 'major'): Check => ({
    id,
    severity,
    penalty,
    timeoutMs: 100,
    failClosed: false,
    run: async () => ({ passed: false, detail: 'nope' }),
  });

  it('passes a clean token with a full score', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), passing('b')]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(100);
    expect(v.passed).toBe(true);
  });

  it('deducts penalties and rejects below the threshold', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [failing('a', 20), failing('b', 25)]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(55);
    expect(v.passed).toBe(false);
    expect(v.rejectedBy).toBe('score_threshold');
  });

  it('lets a single minor failure through', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), failing('b', 20)]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(80);
    expect(v.passed).toBe(true);
  });

  it('vetoes on a fatal failure even at a perfect score', async () => {
    const fatal: Check = {
      id: 'freeze',
      severity: 'fatal',
      penalty: 0,
      timeoutMs: 100,
      failClosed: true,
      run: async () => ({ passed: false, detail: 'freeze authority live' }),
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), fatal]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(100);
    expect(v.passed).toBe(false);
    expect(v.rejectedBy).toBe('freeze');
  });

  it('treats an errored fail-closed check as a failure', async () => {
    const exploding: Check = {
      id: 'exploding',
      severity: 'fatal',
      penalty: 0,
      timeoutMs: 50,
      failClosed: true,
      run: async () => {
        throw new Error('rpc down');
      },
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [exploding]);
    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(false);
    expect(v.results[0]!.errored).toBe(true);
  });

  it('lets an errored fail-open check degrade to a pass', async () => {
    const flaky: Check = {
      id: 'flaky',
      severity: 'major',
      penalty: 20,
      timeoutMs: 50,
      failClosed: false,
      run: async () => {
        throw new Error('rpc hiccup');
      },
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [flaky]);
    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(true);
    expect(v.results[0]!.errored).toBe(true);
  });

  it('times out a hanging check rather than missing the entry window', async () => {
    const hanging: Check = {
      id: 'hanging',
      severity: 'major',
      penalty: 10,
      timeoutMs: 50,
      failClosed: true,
      run: () => new Promise(() => {}),
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [hanging]);
    const started = Date.now();
    const v = await engine.evaluate(candidate());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(v.results[0]!.passed).toBe(false);
  });
});
