import { config, walletLabel, type Config } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { PumpPortalDiscovery } from './discovery/pumpportal.js';
import { RpcDiscovery } from './discovery/rpc.js';
import { PaperExecutor } from './execution/paper.js';
import { OnchainExecutor } from './execution/onchain.js';
import { ChainPriceSource } from './execution/pricing.js';
import { AxiomExecutor } from './execution/axiom.js';
import { Dashboard } from './server/dashboard.js';
import { TradingBot, type BotId, type DashboardBot } from './bots/bot.js';
import { ArbBot } from './arb/bot.js';

/** Which config flag turns each bot on. */
const ENABLE_KEYS: Record<BotId, string> = {
  screener: 'BOT_SCREENER_ENABLED',
  sniper: 'BOT_SNIPER_ENABLED',
  copy: 'BOT_COPY_ENABLED',
  arb: 'BOT_ARB_ENABLED',
};
import { RuntimeSettings } from './settings/runtime.js';
import { AutoTuner } from './tuner/auto-tuner.js';
import { SolPrice } from './util/solprice.js';
import type { Discovery, Executor, TokenCandidate } from './types.js';
import type { Keypair } from '@solana/web3.js';
import { connection, lamportsToSol, loadKeypair } from './util/solana.js';
import { errMessage } from './util/async.js';
import { breakevenGrossPct, costModel } from './strategy/costs.js';

const log = logger('main');

/** How often watchlists are swept and analyst reviews run. */
const STRATEGY_TICK_INTERVAL_MS = 10_000;

/** Sentinel file that halts new entries across every bot. */
const KILL_SWITCH_PATH = 'STOP';
/** How long a wallet balance reading stays good enough for a risk check. */
const BALANCE_CACHE_MS = 5000;

const BOT_NAMES: Record<BotId, string> = {
  screener: 'Screener',
  sniper: 'Sniper',
  copy: 'Copy trader',
  arb: 'Arbitrage',
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
  private readonly bots = new Map<BotId, DashboardBot>();
  /** The arb strategy, kept typed so its own view can be read. */
  private readonly arb: ArbBot;
  private feed: PumpPortalDiscovery | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private strategyTimer: NodeJS.Timeout | null = null;
  private tunerTimer: NodeJS.Timeout | null = null;
  private readonly tuner: AutoTuner;
  private shuttingDown = false;
  private readonly startedAt = Date.now();
  /** Cached SOL balance, so the risk check does not cost a round trip per buy. */
  private balanceCache: { sol: number; at: number } | null = null;
  private walletKey: Keypair | null = null;

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
      // Late-bound on purpose: the copy bot does not exist yet when this object
      // is built, and the screener only calls it once trades are flowing.
      copyHolders: (mint: string) => this.bots.get('copy')?.watcher?.holdersOf(mint) ?? 0,
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
    // Arbitrage is a fourth strategy rather than a fourth TradingBot: no launch
    // feed, no position held over time, no exit planner. It shares the Store,
    // which is what puts it inside the same auto-tuning loop as the others.
    this.arb = new ArbBot({
      cfg,
      dataDir: cfg.DATA_DIR,
      killSwitchPath: KILL_SWITCH_PATH,
    });
    this.bots.set('arb', this.arb);

    this.tuner = new AutoTuner({
      cfg,
      settings: this.settings,
      stores: new Map([...this.bots].map(([id, bot]) => [id, bot.store])),
      dataDir: cfg.DATA_DIR,
    });

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
          tuner: this.tuner,
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
    if (id === 'arb') return this.cfg.BOT_ARB_ENABLED;
    return this.cfg.BOT_COPY_ENABLED;
  }

  /** Start or stop a bot without restarting the process. */
  private setBotEnabled(id: BotId, on: boolean): { ok: boolean; error?: string } {
    const key = ENABLE_KEYS[id];
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
    }, this.cfg.POSITION_TICK_INTERVAL_MS);

    this.strategyTimer = setInterval(() => {
      for (const bot of this.bots.values()) {
        if (!bot.running) continue;
        void bot.tickStrategy().catch((err) =>
          log.error(`${bot.name} strategy tick failed: ${errMessage(err)}`),
        );
      }
    }, STRATEGY_TICK_INTERVAL_MS);

    // The tuner paces itself off TUNER_INTERVAL_MINUTES; this only gives it a
    // chance to look. Checking every minute keeps the timer cheap and means an
    // interval change from the dashboard takes effect without a restart.
    this.tunerTimer = setInterval(() => {
      void this.tuner.tick().catch((err) => log.error(`Tuner failed: ${errMessage(err)}`));
    }, 60_000);
    this.tunerTimer.unref?.();
    if (this.cfg.AUTO_TUNE_ENABLED) {
      log.warn(
        `Auto-tuning is ON: Claude may change strategy settings every ` +
          `${this.cfg.TUNER_INTERVAL_MINUTES} minutes once a bot has ` +
          `${this.cfg.TUNER_MIN_TRADES}+ closed trades. Every change is measured and reverted ` +
          'if it does not beat its baseline. History is in data/tuning.json and on the dashboard.',
      );
    }

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
    for (const id of ['screener', 'sniper', 'copy', 'arb'] as BotId[]) {
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
      // Arbitrage does not consume the launch feed — it drives its own loop off
      // the aggregator, so there is nothing to hand it here.
      if (bot instanceof TradingBot) bot.onCandidate(candidate);
    }
  }

  /**
   * Our own SOL balance, cached for a few seconds.
   *
   * This is read on the entry path — the risk manager checks it before every
   * buy — so an uncached version puts a full RPC round trip between seeing a
   * trade and mirroring it. The balance cannot meaningfully change in the gap
   * without one of our own trades causing it, and a stale reading only ever
   * costs us the reserve check being a few seconds out of date.
   *
   * A read that FAILS is not cached: the fail-closed zero must not stick around
   * blocking entries after the RPC recovers.
   */
  private async walletBalance(): Promise<number> {
    if (this.cfg.MODE === 'paper') {
      return (this.executor as PaperExecutor).simulatedWalletSol;
    }

    const now = Date.now();
    if (this.balanceCache && now - this.balanceCache.at < BALANCE_CACHE_MS) {
      return this.balanceCache.sol;
    }

    try {
      // Decoding the key on every call is pure latency; it never changes.
      this.walletKey ??= loadKeypair(this.cfg.WALLET_PRIVATE_KEY);
      const sol = lamportsToSol(
        await connection(this.cfg).getBalance(this.walletKey.publicKey, 'confirmed'),
      );
      this.balanceCache = { sol, at: now };
      return sol;
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
    // Closing a terminal window is not Ctrl-C. On Windows that arrives as
    // SIGHUP or SIGBREAK, and without these the graceful path never ran — which
    // is how shutting down an editor left state unflushed. Guarded because
    // SIGBREAK does not exist on POSIX and listening for it throws there.
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    if (process.platform === 'win32') {
      process.on('SIGBREAK', () => shutdown('SIGBREAK'));
    }

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
    if (this.tunerTimer) clearInterval(this.tunerTimer);
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
      if (bot.positions) log.info(`${bot.name}: ${bot.positions.summary()}`);
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
