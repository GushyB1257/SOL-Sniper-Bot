import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dashboard } from '../src/server/dashboard.js';
import { buildSnapshot, redactUrl, summarisePnl, configRows } from '../src/server/snapshot.js';
import { renderPage } from '../src/server/ui.js';
import { Store } from '../src/state/store.js';
import { PositionManager } from '../src/strategy/position-manager.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Position, TradeJournalEntry } from '../src/types.js';

const SECRET = '4NF3TjMxqLpJk8vWqYbVsB2eZzTnR7cXhAaGdKfPmQxV1u9wErTyUiOpAsDfGhJkLzXcVbNmQwErTyUi';

function env(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://mainnet.helius-rpc.com/?api-key=super-secret-key-12345',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    WALLET_PRIVATE_KEY: SECRET,
    DASHBOARD_PORT: '0',
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

let dir: string;
let cfg: Config;
let store: Store;
let dash: Dashboard;
let base: string;
let killPath: string;

function position(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'p1',
    mint: 'Mint1111111111111111111111111111111111111',
    symbol: 'TEST',
    creator: 'Dev1',
    pool: 'pump',
    status: 'open',
    costSol: 0.05,
    originalQty: 1_000_000,
    remainingQty: 1_000_000,
    entryPrice: 1e-7,
    openedAt: now,
    peakPrice: 1e-7,
    lastPrice: 1e-7,
    lastPriceAt: now,
    ladder: [
      { gainPct: 60, sellPctOfOriginal: 40, filled: false },
      { gainPct: 150, sellPctOfOriginal: 30, filled: false },
      { gainPct: 400, sellPctOfOriginal: 20, filled: false },
    ],
    moonbagArmed: false,
    realizedSol: 0,
    safetyScore: 88,
    notes: [],
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-dash-'));
  killPath = join(dir, 'STOP');
  cfg = loadConfig(env(dir));
  store = new Store(dir);
  const exec = new PaperExecutor(cfg);
  const risk = new RiskManager(cfg, store, killPath);

  dash = new Dashboard({
    cfg,
    store,
    positions: new PositionManager(cfg, store, exec, risk),
    stats: () => ({ seen: 12, evaluated: 5, rejected: 4, bought: 1, skipped: 7 }),
    walletBalance: async () => 3.5,
    discoveryName: 'test',
    startedAt: Date.now() - 60_000,
    killSwitchPath: killPath,
  });

  await dash.start();
  // Port 0 means the OS picked one; read it back off the listening server.
  const addr = (dash as unknown as { server: { address(): { port: number } } }).server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await dash.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw HTTP GET, so we can set headers fetch() reserves (notably Host). */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The token the server embedded in the page, recovered the way a browser would. */
async function pageToken(): Promise<string> {
  const html = await (await fetch(base + '/')).text();
  const m = /var TOKEN = "([a-f0-9]+)"/.exec(html);
  return m?.[1] ?? '';
}

describe('dashboard serving', () => {
  it('serves the page', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('SOL Sniper');
    expect(html).toContain('Equity curve');
  });

  it('sets a content security policy that blocks external loads', async () => {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('serves a snapshot', async () => {
    const res = await fetch(base + '/api/snapshot');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('paper');
    expect(body.stats.seen).toBe(12);
    expect(body.risk.maxConcurrentPositions).toBe(3);
  });

  it('404s an unknown route', async () => {
    expect((await fetch(base + '/api/nope')).status).toBe(404);
  });
});

describe('dashboard secret handling', () => {
  it('never sends the private key to the browser', async () => {
    const snapshot = await (await fetch(base + '/api/snapshot')).text();
    expect(snapshot).not.toContain(SECRET);
    expect(snapshot).not.toContain('WALLET_PRIVATE_KEY');
  });

  it('redacts RPC credentials from the config view', async () => {
    const body = await (await fetch(base + '/api/snapshot')).json();
    const rpc = body.config.find((r: { key: string }) => r.key === 'RPC_HTTP_URL');
    expect(rpc.value).not.toContain('super-secret-key-12345');
    expect(rpc.value).toContain('redacted');
  });
});

describe('redactUrl', () => {
  it('strips a query-string api key', () => {
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=abc123')).not.toContain('abc123');
  });

  it('strips a key embedded in the hostname', () => {
    const out = redactUrl('https://long-secret-subdomain-key.solana-mainnet.quiknode.pro/path');
    expect(out).not.toContain('long-secret-subdomain-key');
    expect(out).toContain('quiknode.pro');
  });

  it('leaves a plain endpoint readable', () => {
    expect(redactUrl('https://api.mainnet-beta.solana.com')).toContain('api.mainnet-beta.solana.com');
  });

  it('does not throw on garbage', () => {
    expect(redactUrl('not a url')).toBe('(unparseable)');
  });
});

describe('dashboard write protection', () => {
  it('rejects a write with no token', async () => {
    const res = await fetch(base + '/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(existsSync(killPath)).toBe(false);
  });

  it('rejects a write with a wrong token', async () => {
    const res = await fetch(base + '/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Token': 'deadbeef' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(existsSync(killPath)).toBe(false);
  });

  it('accepts a write with the page token and toggles the kill switch', async () => {
    const token = await pageToken();
    expect(token).toHaveLength(48);

    const on = await fetch(base + '/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Token': token },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(existsSync(killPath)).toBe(true);

    await fetch(base + '/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Token': token },
      body: JSON.stringify({ enabled: false }),
    });
    expect(existsSync(killPath)).toBe(false);
  });

  it('blocks a cross-origin request (CSRF)', async () => {
    const token = await pageToken();
    const res = await fetch(base + '/api/kill-switch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sniper-Token': token,
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(existsSync(killPath)).toBe(false);
  });

  it('blocks a rebound host header (DNS rebinding)', async () => {
    // fetch() refuses to set Host, so this goes over a raw socket — which is
    // what an attacker would be doing anyway.
    const port = Number(new URL(base).port);
    const status = await rawGet(port, '/api/snapshot', 'attacker.example.com');
    expect(status).toBe(403);
  });

  it('allows a loopback host header', async () => {
    const port = Number(new URL(base).port);
    expect(await rawGet(port, '/api/snapshot', `localhost:${port}`)).toBe(200);
  });

  it('404s a close request for an unknown position', async () => {
    const token = await pageToken();
    const res = await fetch(base + '/api/positions/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Token': token },
      body: JSON.stringify({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('snapshot maths', () => {
  it('summarises an empty book without dividing by zero', () => {
    const s = summarisePnl([], [], 0);
    expect(s.netSol).toBe(0);
    expect(s.winRatePct).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(Number.isFinite(s.returnPct)).toBe(true);
  });

  it('computes win rate and profit factor', () => {
    const j: TradeJournalEntry[] = [
      { pnlSol: 0.1, costSol: 0.05 },
      { pnlSol: 0.05, costSol: 0.05 },
      { pnlSol: -0.03, costSol: 0.05 },
      { pnlSol: -0.02, costSol: 0.05 },
    ].map((x, i) => ({
      positionId: `p${i}`,
      mint: `m${i}`,
      creator: 'd',
      openedAt: 0,
      closedAt: i,
      proceedsSol: 0,
      pnlPct: 0,
      closeReason: 'ladder: x',
      safetyScore: 80,
      holdSeconds: 10,
      ...x,
    }));

    const s = summarisePnl(j, [], 0);
    expect(s.trades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.winRatePct).toBe(50);
    // gross wins 0.15 / gross losses 0.05 = 3.0
    expect(s.profitFactor).toBeCloseTo(3);
    expect(s.netSol).toBeCloseTo(0.1);
  });

  it('marks open positions to market in net P&L', () => {
    const open = position({ lastPrice: 2e-7 }); // 2x entry
    const s = summarisePnl([], [open], 0);
    // 1,000,000 tokens at 2e-7 = 0.2 SOL, minus 0.05 cost.
    expect(s.unrealizedSol).toBeCloseTo(0.15);
    expect(s.netSol).toBeCloseTo(0.15);
  });

  it('reports an infinite profit factor as null rather than Infinity', () => {
    const s = summarisePnl(
      [
        {
          positionId: 'p',
          mint: 'm',
          creator: 'd',
          openedAt: 0,
          closedAt: 1,
          costSol: 0.05,
          proceedsSol: 0.1,
          pnlSol: 0.05,
          pnlPct: 100,
          closeReason: 'ladder',
          safetyScore: 90,
          holdSeconds: 5,
        },
      ],
      [],
      0,
    );
    // JSON has no Infinity; null survives serialisation and the UI shows it.
    expect(s.profitFactor).toBeNull();
    expect(JSON.parse(JSON.stringify(s)).profitFactor).toBeNull();
  });
});

describe('position view', () => {
  it('reports the nearest stop and ladder state', () => {
    store.savePosition(
      position({
        lastPrice: 2e-7,
        peakPrice: 3e-7,
        ladder: [
          { gainPct: 60, sellPctOfOriginal: 40, filled: true },
          { gainPct: 150, sellPctOfOriginal: 30, filled: false },
          { gainPct: 400, sellPctOfOriginal: 20, filled: false },
        ],
        remainingQty: 600_000,
        realizedSol: 0.032,
      }),
    );

    const snap = buildSnapshot({
      cfg,
      store,
      stats: { seen: 0, evaluated: 0, rejected: 0, bought: 0, skipped: 0 },
      startedAt: Date.now(),
      discovery: 'test',
      killSwitch: false,
      walletBalanceSol: 1,
    });

    const v = snap.positions[0]!;
    expect(v.gainPct).toBeCloseTo(100);
    expect(v.remainingPct).toBeCloseTo(60);
    expect(v.ladder[0]!.filled).toBe(true);
    // A rung has filled, so the trailing stop is armed at 45% off the 3e-7 peak
    // (1.65e-7), which is above the hard stop at 0.65e-7 and therefore nearer.
    expect(v.trailPrice).toBeCloseTo(1.65e-7);
    expect(v.distanceToStopPct).toBeLessThan(0);
  });

  it('leaves the trailing stop unarmed before the first rung fills', () => {
    store.savePosition(position());
    const snap = buildSnapshot({
      cfg,
      store,
      stats: { seen: 0, evaluated: 0, rejected: 0, bought: 0, skipped: 0 },
      startedAt: Date.now(),
      discovery: 'test',
      killSwitch: false,
      walletBalanceSol: 1,
    });
    expect(snap.positions[0]!.trailPrice).toBeNull();
  });
});

describe('config view', () => {
  it('renders the ladder in a readable form', () => {
    const rows = configRows(cfg);
    const ladder = rows.find((r) => r.key === 'EXIT_LADDER')!;
    expect(ladder.value).toBe('+60% → sell 40%, +150% → sell 30%, +400% → sell 20%');
  });

  it('groups every row it exposes', () => {
    for (const row of configRows(cfg)) {
      expect(row.group).toBeTruthy();
      expect(row.value).toBeTruthy();
    }
  });
});

describe('page render', () => {
  it('embeds the token as valid JSON', () => {
    const html = renderPage('abc123');
    expect(html).toContain('var TOKEN = "abc123"');
  });

  it('references no external origins', () => {
    const html = renderPage('t');
    expect(html).not.toMatch(/src=["']https?:\/\//);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
  });
});
