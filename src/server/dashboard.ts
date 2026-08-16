import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { PositionManager } from '../strategy/position-manager.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { buildSnapshot, type AiView, type SessionStats, type Snapshot } from './snapshot.js';
import { renderPage } from './ui.js';

const log = logger('dashboard');

export interface DashboardDeps {
  cfg: Config;
  store: Store;
  positions: PositionManager;
  stats: () => SessionStats;
  walletBalance: () => Promise<number | null>;
  discoveryName: string;
  startedAt: number;
  killSwitchPath: string;
  /** Null when the deterministic strategy is running. */
  ai?: () => AiView | null;
}

/** Push interval for connected browsers. */
const PUSH_INTERVAL_MS = 1000;

/**
 * Local web dashboard.
 *
 * Security model, because this UI can force-sell positions:
 *
 *  - Binds to loopback by default. `DASHBOARD_HOST` is documented as
 *    do-not-change for that reason.
 *  - Mutating routes require a per-run bearer token, generated at startup and
 *    embedded in the page we serve. A random web page you happen to have open
 *    cannot read it, so it cannot forge a sell.
 *  - `Host` is checked against an allowlist of loopback names. Without this, a
 *    hostile site can point a DNS name it controls at 127.0.0.1 (DNS
 *    rebinding) and reach the API from the browser's perspective as
 *    same-origin.
 *  - `Origin`, when present, must match our own. Browsers attach it to
 *    cross-origin writes, so this stops ordinary CSRF.
 *  - Secrets never enter the snapshot: the private key is excluded by key name
 *    and RPC URLs are redacted, since they routinely embed paid API keys.
 */
export class Dashboard {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly token = randomBytes(24).toString('hex');
  private cachedBalance: number | null = null;
  private balanceCheckedAt = 0;

  constructor(private readonly deps: DashboardDeps) {}

  get url(): string {
    return `http://${this.deps.cfg.DASHBOARD_HOST}:${this.deps.cfg.DASHBOARD_PORT}`;
  }

  async start(): Promise<void> {
    const { cfg } = this.deps;

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error(`Request failed: ${errMessage(err)}`);
        if (!res.headersSent) this.json(res, 500, { error: 'internal error' });
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.originOk(req) || !this.hostOk(req)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
        // Send an immediate frame so the page paints without waiting a tick.
        void this.snapshot().then((s) => this.send(ws, s));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(cfg.DASHBOARD_PORT, cfg.DASHBOARD_HOST, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    this.pushTimer = setInterval(() => void this.broadcast(), PUSH_INTERVAL_MS);
    this.pushTimer.unref?.();

    log.info(`Dashboard on ${this.url}`);
    if (cfg.DASHBOARD_HOST !== '127.0.0.1' && cfg.DASHBOARD_HOST !== 'localhost') {
      log.warn(
        `DASHBOARD_HOST is ${cfg.DASHBOARD_HOST}, not loopback. The dashboard can ` +
          'force-sell positions — anyone who can reach this port can liquidate you.',
      );
    }
  }

  // --- request guards -----------------------------------------------------

  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const name = host.split(':')[0]?.toLowerCase() ?? '';
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  }

  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (curl) send no Origin
    try {
      const name = new URL(origin).hostname.toLowerCase();
      return name === '127.0.0.1' || name === 'localhost' || name === '::1';
    } catch {
      return false;
    }
  }

  private tokenOk(req: IncomingMessage): boolean {
    const header = req.headers['x-sniper-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // --- routing ------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostOk(req)) {
      this.json(res, 403, { error: 'host not allowed' });
      return;
    }
    if (!this.originOk(req)) {
      this.json(res, 403, { error: 'origin not allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = renderPage(this.token);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // The page is fully self-contained; no external loads of any kind.
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "img-src data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && path === '/api/snapshot') {
      this.json(res, 200, await this.snapshot());
      return;
    }

    // --- mutating routes: token required ---------------------------------

    if (req.method === 'POST' && path === '/api/kill-switch') {
      if (!this.tokenOk(req)) return this.json(res, 403, { error: 'bad token' });
      const body = await readJson(req);
      const enabled = body?.enabled === true;
      this.setKillSwitch(enabled);
      this.json(res, 200, { killSwitch: enabled });
      return;
    }

    if (req.method === 'POST' && path === '/api/positions/close') {
      if (!this.tokenOk(req)) return this.json(res, 403, { error: 'bad token' });
      const body = await readJson(req);
      const id = typeof body?.id === 'string' ? body.id : '';
      const position = this.deps.store.getPosition(id);
      if (!position || position.status !== 'open') {
        this.json(res, 404, { error: 'no such open position' });
        return;
      }
      log.warn(`Manual close requested from dashboard: ${position.symbol ?? position.mint}`);
      await this.deps.positions.closeOut(position, 'manual', 'closed from dashboard');
      this.json(res, 200, { ok: true });
      return;
    }

    this.json(res, 404, { error: 'not found' });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  }

  // --- state --------------------------------------------------------------

  private setKillSwitch(enabled: boolean): void {
    const path = this.deps.killSwitchPath;
    if (enabled) {
      writeFileSync(path, `halted from dashboard at ${new Date().toISOString()}\n`);
      log.warn('Kill switch ENGAGED from dashboard — no new entries.');
    } else if (existsSync(path)) {
      rmSync(path);
      log.warn('Kill switch released from dashboard — entries resume.');
    }
  }

  /**
   * Balance is polled on a slower cadence than the UI refreshes; an RPC call
   * per second per connected tab would burn the rate limit the sniper needs.
   */
  private async walletBalance(): Promise<number | null> {
    if (Date.now() - this.balanceCheckedAt > 15_000) {
      this.balanceCheckedAt = Date.now();
      try {
        this.cachedBalance = await this.deps.walletBalance();
      } catch {
        this.cachedBalance = null;
      }
    }
    return this.cachedBalance;
  }

  private async snapshot(): Promise<Snapshot> {
    return buildSnapshot({
      cfg: this.deps.cfg,
      store: this.deps.store,
      stats: this.deps.stats(),
      startedAt: this.deps.startedAt,
      discovery: this.deps.discoveryName,
      killSwitch: existsSync(this.deps.killSwitchPath),
      walletBalanceSol: await this.walletBalance(),
      ai: this.deps.ai?.() ?? null,
    });
  }

  private send(ws: WebSocket, snapshot: Snapshot): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(snapshot));
    } catch {
      this.clients.delete(ws);
    }
  }

  private async broadcast(): Promise<void> {
    if (this.clients.size === 0) return;
    const snapshot = await this.snapshot();
    for (const ws of this.clients) this.send(ws, snapshot);
  }

  async stop(): Promise<void> {
    if (this.pushTimer) clearInterval(this.pushTimer);
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // Sockets held open by a browser tab would otherwise block shutdown.
      this.server.closeAllConnections?.();
    });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
