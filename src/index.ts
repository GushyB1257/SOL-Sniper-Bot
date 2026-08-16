import { config, type Config } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { Store } from './state/store.js';
import { SafetyEngine, formatVerdict } from './safety/engine.js';
import { RiskManager } from './risk/risk-manager.js';
import { PositionManager } from './strategy/position-manager.js';
import { PumpPortalDiscovery } from './discovery/pumpportal.js';
import { RpcDiscovery } from './discovery/rpc.js';
import { PaperExecutor } from './execution/paper.js';
import { OnchainExecutor } from './execution/onchain.js';
import { ChainPriceSource } from './execution/pricing.js';
import { AxiomExecutor } from './execution/axiom.js';
import { Dashboard } from './server/dashboard.js';
import type { Discovery, Executor, TokenCandidate } from './types.js';
import { connection, lamportsToSol, loadKeypair } from './util/solana.js';
import { errMessage } from './util/async.js';

const log = logger('main');

/** How often open positions are re-priced and re-evaluated for exits. */
const TICK_INTERVAL_MS = 1500;

/** Sentinel file that halts new entries. Shared by the CLI and the dashboard. */
const KILL_SWITCH_PATH = 'STOP';

class SniperBot {
  private readonly store: Store;
  private readonly safety: SafetyEngine;
  private readonly risk: RiskManager;
  private readonly positions: PositionManager;
  private readonly discovery: Discovery;
  private readonly executor: Executor;
  private readonly dashboard: Dashboard | null;
  private readonly startedAt = Date.now();

  private tickTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  /** Serialises entries so two candidates can't both pass the position cap. */
  private entryInFlight = false;

  private stats = { seen: 0, evaluated: 0, rejected: 0, bought: 0, skipped: 0 };

  constructor(private readonly cfg: Config) {
    const conn = connection(cfg);
    this.store = new Store(cfg.DATA_DIR);
    this.safety = new SafetyEngine(cfg, conn, this.store);
    this.risk = new RiskManager(cfg, this.store, KILL_SWITCH_PATH);
    this.executor = this.buildExecutor(cfg);
    this.positions = new PositionManager(cfg, this.store, this.executor, this.risk);
    this.discovery =
      cfg.DISCOVERY_SOURCE === 'rpc'
        ? new RpcDiscovery(conn)
        : new PumpPortalDiscovery(cfg.PUMPPORTAL_WS_URL);

    this.dashboard = cfg.DASHBOARD_ENABLED
      ? new Dashboard({
          cfg,
          store: this.store,
          positions: this.positions,
          stats: () => ({ ...this.stats }),
          walletBalance: () => this.walletBalance(),
          discoveryName: this.discovery.name,
          startedAt: this.startedAt,
          killSwitchPath: KILL_SWITCH_PATH,
        })
      : null;
  }

  private buildExecutor(cfg: Config): Executor {
    // Both real and paper execution read the same live prices; the only
    // difference is whether a transaction is actually signed and sent.
    const prices = new ChainPriceSource(connection(cfg), cfg);
    switch (cfg.EXECUTOR) {
      case 'paper':
        return new PaperExecutor(cfg, prices);
      case 'onchain':
        return new OnchainExecutor(
          cfg,
          connection(cfg),
          loadKeypair(cfg.WALLET_PRIVATE_KEY),
          prices,
        );
      case 'axiom':
        return new AxiomExecutor();
    }
  }

  async start(): Promise<void> {
    this.banner();

    // Adopt any positions left open by a previous run before taking new ones —
    // a crash must not orphan tokens we are still holding.
    const resumed = this.store.openPositions();
    if (resumed.length > 0) {
      log.warn(`Resuming ${resumed.length} open position(s) from previous run`);
      for (const p of resumed) {
        log.warn(`  ${p.symbol ?? p.mint} — ${p.remainingQty.toFixed(0)} tokens, ${p.mint}`);
      }
    }

    if (this.dashboard) {
      try {
        await this.dashboard.start();
      } catch (err) {
        // A busy port must not stop the bot from trading.
        log.error(`Dashboard failed to start: ${errMessage(err)}`);
      }
    }

    await this.discovery.start((c) => this.onCandidate(c));

    this.tickTimer = setInterval(() => {
      void this.positions.tick().catch((err) => log.error(`Tick failed: ${errMessage(err)}`));
    }, TICK_INTERVAL_MS);

    this.installSignalHandlers();
    log.info(`Watching for launches via ${this.discovery.name}. Ctrl-C to stop.`);
    if (this.dashboard) log.info(`Dashboard: ${this.dashboard.url}`);
  }

  private banner(): void {
    const c = this.cfg;
    const ladder = c.EXIT_LADDER.map((t) => `+${t.gainPct}%→sell ${t.sellPctOfOriginal}%`).join(', ');
    const moonbag = 100 - c.EXIT_LADDER.reduce((a, t) => a + t.sellPctOfOriginal, 0);

    log.info('─'.repeat(72));
    log.info(`  SOL Sniper — mode=${c.MODE.toUpperCase()} executor=${c.EXECUTOR}`);
    log.info(`  Size        ${c.BUY_AMOUNT_SOL} SOL/snipe, max ${c.MAX_CONCURRENT_POSITIONS} concurrent`);
    log.info(`  Ladder      ${ladder}, moonbag ${moonbag}%`);
    log.info(`  Stops       hard -${c.STOP_LOSS_PCT}%, trailing -${c.TRAILING_STOP_PCT}%, moonbag -${c.MOONBAG_TRAILING_STOP_PCT}%`);
    log.info(`  Time stop   ${c.TIME_STOP_SECONDS}s below +${c.TIME_STOP_MIN_GAIN_PCT}%`);
    log.info(`  Risk        daily -${c.DAILY_LOSS_LIMIT_SOL} SOL, ${c.HOURLY_SPEND_CAP_SOL} SOL/h, breaker at ${c.MAX_CONSECUTIVE_LOSSES} losses`);
    log.info(`  Safety      min score ${c.MIN_SAFETY_SCORE}/100, max dev buy ${c.MAX_DEV_BUY_PCT}%`);
    log.info('─'.repeat(72));

    if (c.MODE === 'live') {
      log.warn('LIVE MODE — this will spend real SOL. Ctrl-C now if that is not what you want.');
    }
  }

  private onCandidate(candidate: TokenCandidate): void {
    this.stats.seen += 1;
    void this.considerCandidate(candidate).catch((err) =>
      log.error(`Candidate handling failed for ${candidate.mint}: ${errMessage(err)}`),
    );
  }

  private async considerCandidate(candidate: TokenCandidate): Promise<void> {
    if (this.shuttingDown) return;

    const label = candidate.symbol ?? candidate.mint.slice(0, 8);

    // Cheap rejections first — no point spending RPC budget on a token we
    // cannot or will not buy anyway.
    if (this.store.hasTraded(candidate.mint)) {
      this.stats.skipped += 1;
      return;
    }
    if (this.entryInFlight) {
      this.stats.skipped += 1;
      log.debug(`Skip ${label}: another entry is in flight`);
      return;
    }

    const age = Date.now() - candidate.detectedAt;
    if (age > this.cfg.MAX_CANDIDATE_AGE_MS) {
      this.stats.skipped += 1;
      log.debug(`Skip ${label}: ${age}ms stale`);
      return;
    }

    const balance = await this.walletBalance();
    const risk = this.risk.canOpen(balance);
    if (!risk.allowed) {
      this.stats.skipped += 1;
      log.debug(`Skip ${label}: ${risk.reason}`);
      return;
    }

    // Track every launch we see from this deployer, whether or not we buy —
    // that is what makes the spam and reputation checks work.
    this.store.recordCreatorLaunch(candidate.creator, candidate.mint);

    this.stats.evaluated += 1;
    const verdict = await this.safety.evaluate(candidate);

    if (!verdict.passed) {
      this.stats.rejected += 1;
      log.info(`REJECT ${label} — ${formatVerdict(verdict)} (${verdict.elapsedMs}ms)`);
      return;
    }

    log.info(`PASS ${label} — ${formatVerdict(verdict)} (${verdict.elapsedMs}ms), buying`);

    this.entryInFlight = true;
    try {
      // Re-check risk: the safety battery took time, and a position may have
      // opened underneath us.
      const recheck = this.risk.canOpen(await this.walletBalance());
      if (!recheck.allowed) {
        log.info(`Aborting entry for ${label}: ${recheck.reason}`);
        return;
      }

      const size = this.risk.sizeFor(verdict.score);
      const fill = await this.executor.buy(candidate, size);

      if (!fill.ok) {
        log.warn(`Buy failed for ${label}: ${fill.error ?? 'unknown'}`);
        // A failed buy that still spent SOL (landed but reverted) is a real
        // loss and has to hit the daily accounting.
        if (fill.spentSol > 0) this.risk.recordOutcome(-fill.spentSol);
        return;
      }

      this.stats.bought += 1;
      this.positions.open(candidate, fill, verdict.score);
    } finally {
      this.entryInFlight = false;
    }
  }

  private async walletBalance(): Promise<number> {
    if (this.cfg.MODE === 'paper') {
      return (this.executor as PaperExecutor).simulatedWalletSol;
    }
    try {
      const kp = loadKeypair(this.cfg.WALLET_PRIVATE_KEY);
      const lamports = await connection(this.cfg).getBalance(kp.publicKey, 'confirmed');
      return lamportsToSol(lamports);
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
      // Persist before dying; open positions must survive the crash.
      this.store.flush();
      process.exit(1);
    });
  }

  async stop(signal: string): Promise<void> {
    this.shuttingDown = true;
    log.warn(`${signal} received, shutting down`);

    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.discovery.stop();
    await this.dashboard?.stop();

    // Deliberately NOT auto-selling on shutdown: dumping every position into
    // a thin book because the process is restarting is usually worse than
    // holding. Positions are persisted and resumed on the next start.
    const open = this.store.openPositions();
    if (open.length > 0) {
      log.warn(`${open.length} position(s) left OPEN and persisted:`);
      for (const p of open) {
        log.warn(`  ${p.symbol ?? '?'} ${p.mint} — ${p.remainingQty.toFixed(0)} tokens`);
      }
      log.warn('Restart the bot to resume managing them, or sell manually.');
    }

    this.store.flush();
    log.info(
      `Session: ${this.stats.seen} seen, ${this.stats.evaluated} evaluated, ` +
        `${this.stats.rejected} rejected, ${this.stats.bought} bought, ${this.stats.skipped} skipped`,
    );
    log.info(`Lifetime: ${this.positions.summary()}`);
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

  const bot = new SniperBot(cfg);
  await bot.start();
}

void main();
