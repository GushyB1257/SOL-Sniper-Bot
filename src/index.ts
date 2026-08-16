import { config, walletLabel, type Config } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { PumpPortalDiscovery } from './discovery/pumpportal.js';
import { RpcDiscovery } from './discovery/rpc.js';
import { PaperExecutor } from './execution/paper.js';
import { OnchainExecutor } from './execution/onchain.js';
import { ChainPriceSource } from './execution/pricing.js';
import { AxiomExecutor } from './execution/axiom.js';
import { Dashboard } from './server/dashboard.js';
import { TradingBot, type BotId } from './bots/bot.js';
import { RuntimeSettings } from './settings/runtime.js';
import { SolPrice } from './util/solprice.js';
import type { Discovery, Executor, TokenCandidate } from './types.js';
import { connection, lamportsToSol, loadKeypair } from './util/solana.js';
import { errMessage } from './util/async.js';
import { breakevenGrossPct, costModel } from './strategy/costs.js';

const log = logger('main');

/** How often open positions are re-priced and re-evaluated for exits. */
const TICK_INTERVAL_MS = 1500;

/** How often watchlists are swept and analyst reviews run. */
const STRATEGY_TICK_INTERVAL_MS = 10_000;

/** Sentinel file that halts new entries across every bot. */
const KILL_SWITCH_PATH = 'STOP';

const BOT_NAMES: Record<BotId, string> = {
  screener: 'Screener',
  sniper: 'Sniper',
  copy: 'Copy trader',
};

/**
 * Runs the bots and owns everything they share: one wallet, one executor, one
 * discovery feed, one SOL price, one dashboard.
 *
 * Bots themselves share nothing else — separate positions, separate P&L,
 * separate risk limits — so the dashboard can answer "which of these is
 * actually working" rather than showing one blended number.
 */
class Supervisor {
  private readonly discovery: Discovery;
  private readonly executor: Executor;
  private readonly dashboard: Dashboard | null;
  private readonly settings: RuntimeSettings;
  private readonly solPrice: SolPrice;
  private readonly bots = new Map<BotId, TradingBot>();
  private feed: PumpPortalDiscovery | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private strategyTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly startedAt = Date.now();

  constructor(private readonly cfg: Config) {
    const conn = connection(cfg);
    this.settings = new RuntimeSettings(cfg, process.env, cfg.DATA_DIR);
    this.solPrice = new SolPrice(cfg.SOL_USD_FALLBACK);
    void this.solPrice.usd; // warm it before the first entry is stamped

    const prices = new ChainPriceSource(conn, cfg);
    this.executor = this.buildExecutor(cfg, prices);

    if (cfg.DISCOVERY_SOURCE === 'rpc') {
      this.discovery = new RpcDiscovery(conn);
    } else {
      const feed = new PumpPortalDiscovery(cfg.PUMPPORTAL_WS_URL);
      this.feed = feed;
      this.discovery = feed;
    }

    const deps = {
      cfg,
      dataDir: cfg.DATA_DIR,
      executor: this.executor,
      prices,
      connection: conn,
      walletBalance: () => this.walletBalance(),
      killSwitchPath: KILL_SWITCH_PATH,
      solPrice: this.solPrice,
      trackTrades: (mints: string[]) => this.feed?.trackTrades(mints),
      untrackTrades: (mints: string[]) => this.feed?.untrackTrades(mints),
    };

    // Every bot is constructed regardless of whether it is enabled, so the
    // dashboard can show its history and settings and start it later without a
    // restart. Only `start()` is gated.
    for (const id of ['screener', 'sniper', 'copy'] as BotId[]) {
      this.bots.set(id, new TradingBot(id, BOT_NAMES[id], deps));
    }

    this.dashboard = cfg.DASHBOARD_ENABLED
      ? new Dashboard({
          cfg,
          settings: this.settings,
          bots: this.bots,
          walletBalance: () => this.walletBalance(),
          discoveryName: this.discovery.name,
          startedAt: this.startedAt,
          killSwitchPath: KILL_SWITCH_PATH,
          solPrice: this.solPrice,
          setBotEnabled: (id: BotId, on: boolean) => this.setBotEnabled(id, on),
        })
      : null;
  }

  private buildExecutor(cfg: Config, prices: ChainPriceSource): Executor {
    switch (cfg.EXECUTOR) {
      case 'paper':
        return new PaperExecutor(cfg, prices);
      case 'onchain':
        return new OnchainExecutor(cfg, connection(cfg), loadKeypair(cfg.WALLET_PRIVATE_KEY), prices);
      case 'axiom':
        return new AxiomExecutor();
    }
  }

  private enabled(id: BotId): boolean {
    if (id === 'screener') return this.cfg.BOT_SCREENER_ENABLED;
    if (id === 'sniper') return this.cfg.BOT_SNIPER_ENABLED;
    return this.cfg.BOT_COPY_ENABLED;
  }

  /** Start or stop a bot without restarting the process. */
  private setBotEnabled(id: BotId, on: boolean): { ok: boolean; error?: string } {
    const key =
      id === 'screener'
        ? 'BOT_SCREENER_ENABLED'
        : id === 'sniper'
          ? 'BOT_SNIPER_ENABLED'
          : 'BOT_COPY_ENABLED';
    const result = this.settings.apply({ [key]: String(on) });
    if (!result.ok) return { ok: false, error: result.error };

    const bot = this.bots.get(id)!;
    if (on) {
      bot.start();
      log.info(`${bot.name} started`);
    } else {
      bot.stop();
      log.info(`${bot.name} stopped — open positions are still managed`);
    }
    return { ok: true };
  }

  async start(): Promise<void> {
    this.banner();

    for (const bot of this.bots.values()) {
      const resumed = bot.store.openPositions();
      if (resumed.length === 0) continue;
      log.warn(`${bot.name}: resuming ${resumed.length} open position(s)`);
      for (const p of resumed) {
        // Paper balances live in memory, so a resumed position would otherwise
        // be unsellable: the store says we hold tokens, the executor says we
        // hold none, and every exit fails.
        if (this.executor instanceof PaperExecutor) {
          this.executor.seedBalance(p.mint, p.remainingQty);
        }
        bot.ai?.adoptPosition(p);
      }
    }

    if (this.dashboard) {
      try {
        await this.dashboard.start();
      } catch (err) {
        log.error(`Dashboard failed to start: ${errMessage(err)}`);
      }
    }

    const screener = this.bots.get('screener')!;
    if (this.feed) {
      this.feed.onTradeEvent((t) => screener.ai?.recordTrade(t));
    }

    await this.discovery.start((c) => this.onCandidate(c));

    this.tickTimer = setInterval(() => {
      for (const bot of this.bots.values()) {
        void bot.tickPositions().catch((err) =>
          log.error(`${bot.name} tick failed: ${errMessage(err)}`),
        );
      }
    }, TICK_INTERVAL_MS);

    this.strategyTimer = setInterval(() => {
      for (const bot of this.bots.values()) {
        if (!bot.running) continue;
        void bot.tickStrategy().catch((err) =>
          log.error(`${bot.name} strategy tick failed: ${errMessage(err)}`),
        );
      }
    }, STRATEGY_TICK_INTERVAL_MS);

    for (const [id, bot] of this.bots) {
      if (this.enabled(id)) bot.start();
    }

    this.installSignalHandlers();
    log.info(`Watching for launches via ${this.discovery.name}. Ctrl-C to stop.`);
    if (this.dashboard) log.info(`Dashboard: ${this.dashboard.url}`);
  }

  private banner(): void {
    const c = this.cfg;
    const be = breakevenGrossPct(costModel(c, c.BUY_AMOUNT_SOL));

    log.info('─'.repeat(72));
    log.info(`  SOL Trader — mode=${c.MODE.toUpperCase()} executor=${c.EXECUTOR}`);
    for (const id of ['screener', 'sniper', 'copy'] as BotId[]) {
      const on = this.enabled(id);
      log.info(`  ${BOT_NAMES[id].padEnd(11)} ${on ? 'ON ' : 'off'}${this.botSummary(id)}`);
    }
    log.info(`  Size        ${c.BUY_AMOUNT_SOL} SOL/position, max ${c.MAX_CONCURRENT_POSITIONS} per bot`);
    log.info(
      `  Exit        ${c.EXIT_MODE}` +
        (c.EXIT_MODE === 'ratchet'
          ? ` — beat the last check every ${c.CHECKPOINT_SECONDS}s, stake back at ` +
            `+${c.RECOVER_AT_GAIN_PCT}%, NO stop loss (breakeven +${be.toFixed(1)}%)`
          : ''),
    );
    log.info(`  Risk        per bot: daily -${c.DAILY_LOSS_LIMIT_SOL} SOL, ${c.HOURLY_SPEND_CAP_SOL} SOL/h`);
    log.info('─'.repeat(72));

    if (c.MODE === 'live') {
      log.warn('LIVE MODE — this will spend real SOL. Ctrl-C now if that is not what you want.');
    }
  }

  private botSummary(id: BotId): string {
    const c = this.cfg;
    const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`);
    if (id === 'screener') {
      return (
        `  ${c.SCREEN_ALLOWED_POOLS.join('/')} · mcap ${k(c.SCREEN_MIN_MCAP_USD)}+ · ` +
        `vol ${k(c.SCREEN_MIN_VOLUME_USD)}+ · ${c.SCREEN_MIN_SOCIALS} social`
      );
    }
    if (id === 'sniper') return `  safety ≥${c.MIN_SAFETY_SCORE}/100, buys at creation`;
    return c.COPY_WALLETS.length > 0
      ? `  ${c.COPY_WALLETS.map((w) => walletLabel(c, w.address)).join(', ')} · ` +
        `ignore buys under ${c.COPY_MIN_BUY_SOL} SOL`
      : '  no wallets configured';
  }

  private onCandidate(candidate: TokenCandidate): void {
    if (this.shuttingDown) return;
    for (const [id, bot] of this.bots) {
      if (!bot.running || !this.enabled(id)) continue;
      bot.onCandidate(candidate);
    }
  }

  private async walletBalance(): Promise<number> {
    if (this.cfg.MODE === 'paper') {
      return (this.executor as PaperExecutor).simulatedWalletSol;
    }
    try {
      const kp = loadKeypair(this.cfg.WALLET_PRIVATE_KEY);
      return lamportsToSol(await connection(this.cfg).getBalance(kp.publicKey, 'confirmed'));
    } catch (err) {
      log.error(`Balance lookup failed: ${errMessage(err)}`);
      return 0; // fail closed: no balance reading means no new entries
    }
  }

  private installSignalHandlers(): void {
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) {
        log.warn('Second signal — exiting immediately, positions left open.');
        process.exit(1);
      }
      stopping = true;
      void this.stop(signal);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
      log.error(`Unhandled rejection: ${errMessage(reason)}`);
    });
    process.on('uncaughtException', (err) => {
      log.error(`Uncaught exception: ${errMessage(err)}`);
      for (const bot of this.bots.values()) bot.store.flush();
      process.exit(1);
    });
  }

  async stop(signal: string): Promise<void> {
    this.shuttingDown = true;
    log.warn(`${signal} received, shutting down`);

    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.strategyTimer) clearInterval(this.strategyTimer);
    for (const bot of this.bots.values()) bot.stop();
    await this.discovery.stop();
    await this.dashboard?.stop();

    // Deliberately NOT auto-selling: dumping every position into a thin book
    // because the process is restarting is usually worse than holding.
    for (const bot of this.bots.values()) {
      const open = bot.store.openPositions();
      if (open.length > 0) {
        log.warn(`${bot.name}: ${open.length} position(s) left OPEN and persisted`);
        for (const p of open) {
          log.warn(`  ${p.symbol ?? '?'} ${p.mint} — ${p.remainingQty.toFixed(0)} tokens`);
        }
      }
      log.info(`${bot.name}: ${bot.positions.summary()}`);
      bot.store.close();
    }
    process.exit(0);
  }
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = config();
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    process.stderr.write('\nCopy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  setLogLevel(cfg.LOG_LEVEL);

  const supervisor = new Supervisor(cfg);
  await supervisor.start();
}

void main();
