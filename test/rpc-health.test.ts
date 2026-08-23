import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRpcHealth } from '../src/tuner/auto-tuner.js';
import type { RpcSnapshot } from '../src/tuner/ledger.js';
import { loadConfig, type Config } from '../src/config.js';

let dir: string;
let cfg: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-rpchealth-'));
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    RPC_MAX_REQUESTS_PER_SEC: '20',
  } as unknown as NodeJS.ProcessEnv);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const START: RpcSnapshot = {
  at: 1_000_000,
  requests: 0,
  rateLimited: 0,
  retries: 0,
  givenUp: 0,
  waitedMs: 0,
};

/** `minutes` of traffic at `perSec`, of which `limitedPct` came back 429. */
function after(perSec: number, minutes: number, limitedPct = 0, waitedMsPerCall = 0): RpcSnapshot {
  const seconds = minutes * 60;
  const requests = Math.round(perSec * seconds);
  return {
    at: START.at! + seconds * 1000,
    requests,
    rateLimited: Math.round(requests * (limitedPct / 100)),
    retries: 0,
    givenUp: 0,
    waitedMs: requests * waitedMsPerCall,
  };
}

describe('RPC health block', () => {
  it('says our own ceiling is binding when the rate is pinned with no 429s', () => {
    // The exact state the tuner asked a human to go check on the dashboard:
    // saturated, but the provider is not pushing back. Under the old code the
    // only RPC signal was a confounding caveat that fires above 5% rate
    // limiting — so this state produced complete silence.
    const out = renderRpcHealth(START, cfg, after(19.4, 20, 0));

    expect(out).toMatch(/BINDING CONSTRAINT: your own ceiling/);
    expect(out).toMatch(/RPC_MAX_CONCURRENT/);
    // And the specific inference it could not make on its own.
    expect(out).toMatch(/POSITION_TICK_INTERVAL_MS cannot help/);
  });

  it('says the provider is binding when 429s are landing', () => {
    const out = renderRpcHealth(START, cfg, after(19, 20, 8));

    expect(out).toMatch(/BINDING CONSTRAINT: the provider/);
    // The opposite advice to the pinned case, and the reason the two must not
    // be conflated: here raising the ceiling makes things worse.
    expect(out).toMatch(/produces more 429s, not more throughput/);
    expect(out).not.toMatch(/your own ceiling/);
  });

  it('says RPC is not involved when there is headroom and no 429s', () => {
    const out = renderRpcHealth(START, cfg, after(3.8, 20, 0));

    expect(out).toMatch(/NOT THE CONSTRAINT/);
    expect(out).toMatch(/19% of the 20\/s/);
    // Important negative: a latency problem that survives this block is not an
    // RPC problem, and the block should not offer headroom as a fix.
    expect(out).not.toMatch(/more headroom/i);
  });

  it('declines to judge a window with too little traffic', () => {
    // 40 calls over 30s says nothing about saturation either way, and a
    // confident verdict off that would be worse than none.
    const out = renderRpcHealth(START, cfg, after(1.3, 0.5));
    expect(out).toMatch(/too little traffic/);
    expect(out).not.toMatch(/BINDING CONSTRAINT/);
  });

  it('reports no baseline on the very first round', () => {
    expect(renderRpcHealth(undefined, cfg)).toMatch(/no baseline snapshot yet/);
    // A ledger entry written before snapshots carried a timestamp cannot be
    // used as a window start either, and must not be treated as time zero.
    expect(renderRpcHealth({ requests: 5, rateLimited: 0 }, cfg)).toMatch(/no baseline/);
  });

  it('measures a window as a delta, not as totals since boot', () => {
    // A session badly rate limited for its first hour and healthy since must
    // read as healthy now. Totals since boot would report it as broken
    // forever, and the tuner would keep declining to act on a problem that had
    // already passed.
    const sick: RpcSnapshot = {
      at: START.at,
      requests: 50_000,
      rateLimited: 12_000,
      retries: 9000,
      givenUp: 40,
      waitedMs: 4_000_000,
    };
    const healthySince: RpcSnapshot = {
      at: sick.at! + 20 * 60 * 1000,
      requests: sick.requests + 4560,
      rateLimited: sick.rateLimited, // not one more
      retries: sick.retries,
      givenUp: sick.givenUp,
      waitedMs: sick.waitedMs + 4560 * 12,
    };

    const out = renderRpcHealth(sick, cfg, healthySince);
    expect(out).toMatch(/NOT THE CONSTRAINT/);
    expect(out).toMatch(/rate limited 0 \(0\.0%\)/);
  });

  it('reports queue delay per call, which is the direct read on queueing', () => {
    const out = renderRpcHealth(START, cfg, after(19.4, 20, 0, 340));
    expect(out).toMatch(/average queue delay 340ms per call/);
  });
});
