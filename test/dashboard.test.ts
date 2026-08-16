import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dashboard } from '../src/server/dashboard.js';
import { aggregateTrades, buildSnapshot, redactUrl, summarisePnl, configRows } from '../src/server/snapshot.js';
import { renderPage } from '../src/server/ui.js';
import { Store } from '../src/state/store.js';
import { TradingBot } from '../src/bots/bot.js';
import { RuntimeSettings } from '../src/settings/runtime.js';
import { SolPrice } from '../src/util/solprice.js';
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
  ENTRY_MODE: 'fast',
  EXIT_MODE: 'ladder',
    DATA_DIR: dir,
    WALLET_PRIVATE_KEY: SECRET,
    DASHBOARD_PORT: '0',
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

let dir: string;
let cfg: Config;
let store: Store;
let bot: TradingBot;
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
  const exec = new PaperExecutor(cfg);

  bot = new TradingBot('screener', 'Screener', {
    cfg,
    dataDir: dir,
    executor: exec,
    prices: { curve: async () => null, price: async () => null },
    connection: {} as never,
    walletBalance: async () => 3.5,
    killSwitchPath: killPath,
    solPrice: new SolPrice(200),
    trackTrades: () => {},
    untrackTrades: () => {},
  });
  // The bot owns the screener's store, which is the same `state.json` the test
  // writes positions into, so `store` and `bot.store` are the same file.
  store = bot.store;

  dash = new Dashboard({
    cfg,
    settings: new RuntimeSettings(cfg, env(dir), dir),
    bots: new Map([['screener', bot]]),
    walletBalance: async () => 3.5,
    discoveryName: 'test',
    startedAt: Date.now() - 60_000,
    killSwitchPath: killPath,
    solPrice: new SolPrice(200),
    setBotEnabled: () => ({ ok: true }),
  });

  await dash.start();
  // Port 0 means the OS picked one; read it back off the listening server.
  const addr = (dash as unknown as { server: { address(): { port: number } } }).server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await dash.stop();
  store.close();
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
    expect(html).toContain('SOL Moneymaker');
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
    // Every bot carries its own books, so nothing at the top level is a P&L.
    expect(body.bots).toHaveLength(1);
    expect(body.bots[0].id).toBe('screener');
    expect(body.bots[0].risk.maxConcurrentPositions).toBe(8);
    expect(body.settings.fields.length).toBeGreaterThan(10);
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

/** Builds a snapshot the way the dashboard does, from the bot's own store. */
function snapshotOf(withCfg: Config = cfg) {
  return buildSnapshot({
    cfg: withCfg,
    startedAt: Date.now(),
    discovery: 'test',
    killSwitch: false,
    walletBalanceSol: 1,
    solUsd: 200,
    solPriceLive: true,
    settings: { fields: [], values: {} },
    bots: [
      {
        id: 'screener',
        name: 'Screener',
        enabled: true,
        running: true,
        paused: false,
        store,
        stats: { seen: 0, evaluated: 0, rejected: 0, bought: 0, skipped: 0 },
        ai: null,
        copy: null,
      },
    ],
  });
}

describe('trade aggregation', () => {
  const MINT = 'Mint7777777777777777777777777777777777777';

  function leg(over: Partial<TradeJournalEntry>): TradeJournalEntry {
    const now = Date.now();
    return {
      positionId: 'p' + Math.random(),
      mint: MINT,
      symbol: 'AGG',
      creator: 'Dev1',
      openedAt: now - 120_000,
      closedAt: now - 60_000,
      costSol: 0.25,
      proceedsSol: 0.1,
      pnlSol: -0.15,
      pnlPct: -60,
      closeReason: 'cost_recovery: trimmed',
      safetyScore: 50,
      holdSeconds: 60,
      ...over,
    };
  }

  it('sums the legs so a token that made money does not read as two losses', () => {
    // This is the reported symptom: sold down in stages, each leg carries the
    // full cost against partial proceeds, and every line looks like a loss even
    // though the token was a winner.
    const rows = aggregateTrades(
      [
        leg({ proceedsSol: 0.1, pnlSol: -0.15, pnlPct: -60 }),
        leg({ proceedsSol: 0.9, pnlSol: 0.65, pnlPct: 260, closedAt: Date.now() }),
      ],
      cfg,
    );

    expect(rows).toHaveLength(1);
    const g = rows[0]!;
    expect(g.legs).toBe(2);
    expect(g.costSol).toBeCloseTo(0.5, 10);
    expect(g.proceedsSol).toBeCloseTo(1.0, 10);
    expect(g.pnlSol).toBeCloseTo(0.5, 10);
    // Percentage comes from the totals, not from averaging the legs.
    expect(g.pnlPct).toBeCloseTo(100, 6);
    expect(g.reasons).toHaveLength(2);
  });

  it('keeps different tokens apart and orders by the most recent exit', () => {
    const older = leg({ mint: 'Aaa1111111111111111111111111111111111111', closedAt: 1000 });
    const newer = leg({ mint: 'Bbb1111111111111111111111111111111111111', closedAt: 9000 });
    const rows = aggregateTrades([older, newer], cfg);
    expect(rows.map((r) => r.mint)).toEqual([newer.mint, older.mint]);
  });

  it('measures the hold from first entry to last exit, not by summing legs', () => {
    const rows = aggregateTrades(
      [
        leg({ openedAt: 0, closedAt: 10_000, holdSeconds: 10 }),
        leg({ openedAt: 50_000, closedAt: 60_000, holdSeconds: 10 }),
      ],
      cfg,
    );
    // 60s of wall clock, not the 20s the legs add up to.
    expect(rows[0]!.holdSeconds).toBe(60);
  });

  it('carries the copied wallet through to the aggregated row', () => {
    const wallet = 'FoLLoW1111111111111111111111111111111111111';
    const named = loadConfig(env(dir, { COPY_WALLETS: `${wallet}=Insider` }));
    const rows = aggregateTrades([leg({ copiedFrom: wallet })], named);
    expect(rows[0]!.copiedFromLabel).toBe('Insider');
  });

  it('is what the trades table renders', () => {
    // The table must read from the aggregate, not the raw journal, or none of
    // the above reaches the screen.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    expect(script).toContain('renderTrades(b.trades)');
    expect(script).toContain('t.legs > 1');
  });
});

describe('wallet names', () => {
  const WALLET = 'FoLLoW1111111111111111111111111111111111111';

  function closedTrade(): TradeJournalEntry {
    return {
      positionId: 'p9',
      mint: 'Mint9999999999999999999999999999999999999',
      symbol: 'DONE',
      creator: 'Dev1',
      openedAt: Date.now() - 60_000,
      closedAt: Date.now(),
      costSol: 0.25,
      proceedsSol: 0.5,
      pnlSol: 0.25,
      pnlPct: 100,
      closeReason: 'cost_recovery',
      safetyScore: 0,
      holdSeconds: 60,
      copiedFrom: WALLET,
    };
  }

  it('relabels a closed trade when the wallet is renamed afterwards', () => {
    // The journal stores the address, so the name is resolved at render time.
    // Renaming a wallet has to relabel its whole history, not just new trades.
    store.appendJournal(closedTrade());

    const named = (label: string) =>
      snapshotOf(loadConfig(env(dir, { COPY_WALLETS: `${WALLET}=${label}` })));

    expect(named('Insider').bots[0]!.journal[0]!.copiedFromLabel).toBe('Insider');
    expect(named('Renamed').bots[0]!.journal[0]!.copiedFromLabel).toBe('Renamed');
  });

  it('falls back to a short address when the wallet has no name', () => {
    store.appendJournal(closedTrade());
    const s = snapshotOf(loadConfig(env(dir, { COPY_WALLETS: WALLET })));
    expect(s.bots[0]!.journal[0]!.copiedFromLabel).toBe(
      WALLET.slice(0, 4) + '…' + WALLET.slice(-4),
    );
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

    const v = snapshotOf().bots[0]!.positions[0]!;
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
    expect(snapshotOf().bots[0]!.positions[0]!.trailPrice).toBeNull();
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

  it('inlines a client script that actually parses', () => {
    // The whole UI is one inlined script. A syntax error in it is invisible
    // server-side and blanks the entire page, so it gets checked here rather
    // than discovered by opening a browser.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))?.[1];
    expect(script).toBeTruthy();
    expect(script!.length).toBeGreaterThan(1000);
    expect(() => new Function(script!)).not.toThrow();
  });

  it('renders a tab for every bot and a settings form', () => {
    const html = renderPage('t');
    for (const id of ['botBar', 'botStatus', 'botToggle', 'botPause', 'setForm', 'setSave']) {
      expect(html, id).toContain('id="' + id + '"');
    }
    expect(html).toContain('MCap in');
  });

  it('makes the mint copyable in the trade journal, not just open positions', () => {
    // The journal is where you look a token up after the fact, so the address
    // has to be reachable there — one shared chip, used by both tables.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    expect(script).toContain('function mintChip');
    expect(script).toContain('mintChip(t.mint)');
    expect(script).toContain('mintChip(p.mint)');
    expect((script.match(/navigator\.clipboard\.writeText/g) ?? []).length).toBe(1);
  });

  it('shows the tracked wallet name on positions and on closed trades', () => {
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    expect(script).toContain('p.copiedFromLabel');
    expect(script).toContain('t.copiedFromLabel');
  });

  it('shows what each tracked wallet has made in its card', () => {
    // A wallet worth following and one that has cost you money look identical
    // without this, which makes the whole list unactionable.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    const card = script.slice(script.indexOf('function renderCopy'));
    const upto = card.slice(0, card.indexOf('function srow'));
    expect(upto).toContain('w.pnl');
    expect(upto).toContain('pnl.netSol');
    expect(upto).toContain('pnl.unrealizedSol');
  });

  it('names the wallets in the tracked-wallets card', () => {
    // Naming a wallet is pointless if the one card devoted to wallets still
    // only shows the address.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    const card = script.slice(script.indexOf('function renderCopy'));
    expect(card.slice(0, card.indexOf('function srow'))).toContain('w.label');
  });

  it('gives the auto-tuner its own audit tab', () => {
    // Software that edits its own trading settings has to show its working
    // somewhere the user will actually look.
    const html = renderPage('t');
    expect(html).toContain('data-tab="tuner"');
    expect(html).toContain('id="tab-tuner"');
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(script).toContain('renderTuner(s.tuner)');
    const panel = script.slice(script.indexOf('function renderTuner'));
    // The reason and the verdict are the whole point of the trail.
    expect(panel).toContain('c.why');
    expect(panel).toContain('e.verdict');
    expect(panel).toContain('e.notes');
  });

  it('reloads itself when its token is from a previous run', () => {
    // The token is minted per run and baked into the page, so a tab left open
    // across a restart answers "bad token" on every button — and nothing shows
    // in the terminal, because a 403 is a normal response. Reloading is the
    // only recovery that does not hand the page a token out of band.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    const post = script.slice(script.indexOf('function post('), script.indexOf('// ---- equity'));
    expect(post).toContain('r.status === 403');
    expect(post).toContain('location.reload()');
    // Guarded, or a persistent 403 turns into a reload loop.
    expect(post).toContain('!reloading');
  });

  it('does not rebuild the settings form on every refresh', () => {
    // Rebuilding replaces every input node, which ejects the caret mid-typing —
    // the box becomes impossible to fill in. The form is built once per tab and
    // refreshed in place after that, skipping focused and edited fields.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    expect(script).toContain('settingsBuiltFor');
    expect(script).toContain('function refreshSettings');
    expect(script).toContain('input === document.activeElement');
    // The only innerHTML wipe of the form must sit behind the build guard.
    const build = script.slice(script.indexOf('function renderSettings'));
    const guard = build.indexOf('settingsBuiltFor === botId');
    const wipe = build.indexOf("host.innerHTML = ''");
    expect(guard).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(guard);
  });

  it('keeps the run state on a label, not on the action button', () => {
    // "Stop Copy trader" reads as a state as easily as an action, which is how
    // a running bot gets reported as a broken Start button.
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(renderPage('t'))![1]!;
    expect(script).toContain("'RUNNING'");
    expect(script).toContain("'STOPPED'");
    expect(script).toContain("'PAUSED'");
    expect(script).toMatch(/toggle\.textContent = b\.enabled \? 'Stop' : 'Start'/);
  });

  it('references no external origins', () => {
    const html = renderPage('t');
    expect(html).not.toMatch(/src=["']https?:\/\//);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
  });
});
