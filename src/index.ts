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
import { AiOrchestrator } from './ai/orchestrator.js';
import type { Discovery, Executor, TokenCandidate } from './types.js';
import { connection, lamportsToSol, loadKeypair } from './util/solana.js';
import { errMessage } from './util/async.js';
import { breakevenGrossPct, costModel, requiredWinRatePct, targetGrossPct } from './strategy/costs.js';

const log = logger('main');

/** How often open positions are re-priced and re-evaluated for exits. */
const TICK_INTERVAL_MS = 1500;

/** How often the watchlist is swept for graduates and positions re-reviewed. */
const AI_TICK_INTERVAL_MS = 10_000;

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
  private readonly ai: AiOrchestrator | null;
  /** Set only when the feed supports trade streaming (pumpportal source). */
  private feed: PumpPortalDiscovery | null = null;
  private aiTimer: NodeJS.Timeout | null = null;
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
    if (cfg.DISCOVERY_SOURCE === 'rpc') {
      this.discovery = new RpcDiscovery(conn);
    } else {
      const feed = new PumpPortalDiscovery(cfg.PUMPPORTAL_WS_URL);
      this.feed = feed;
      this.discovery = feed;
    }

    // AI strategy: launches go on a watchlist and are judged after they show
    // traction, rather than bought at creation.
    this.ai =
      cfg.STRATEGY === 'ai'
        ? new AiOrchestrator({
            cfg,
            store: this.store,
            executor: this.executor,
            risk: this.risk,
            positions: this.positions,
            walletBalance: () => this.walletBalance(),
            trackTrades: (mints) => this.feed?.trackTrades(mints),
            untrackTrades: (mints) => this.feed?.untrackTrades(mints),
            connection: conn,
          })
        : null;

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
          ai: () => this.aiView(),
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

        // Paper balances are in-memory, so a resumed position would otherwise
        // be unsellable: the store says we hold tokens, the executor says we
        // hold none, and every exit fails. The position record is the truth.
        if (this.executor instanceof PaperExecutor) {
          this.executor.seedBalance(p.mint, p.remainingQty);
        }

        // Put resumed positions back on the watchlist so the reviewer has live
        // flow data again instead of judging them blind.
        this.ai?.adoptPosition(p);
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

    if (this.ai && this.feed) {
      this.feed.onTradeEvent((t) => this.ai!.recordTrade(t));
    } else if (this.ai) {
      log.warn(
        'AI strategy needs the pumpportal trade feed for traction data. ' +
          'Set DISCOVERY_SOURCE=pumpportal.',
      );
    }

    await this.discovery.start((c) => this.onCandidate(c));

    this.tickTimer = setInterval(() => {
      void this.positions.tick().catch((err) => log.error(`Tick failed: ${errMessage(err)}`));
    }, TICK_INTERVAL_MS);

    if (this.ai) {
      // Slower cadence than the price tick: analyst calls cost money, and the
      // decisions they drive play out over minutes, not seconds.
      this.aiTimer = setInterval(() => {
        void this.ai!.tick().catch((err) => log.error(`AI tick failed: ${errMessage(err)}`));
      }, AI_TICK_INTERVAL_MS);
    }

    this.ai?.start();

    this.installSignalHandlers();
    log.info(`Watching for launches via ${this.discovery.name}. Ctrl-C to stop.`);
    if (this.cfg.ENTRY_MODE === 'screener') {
      // Worth saying out loud, because the symptom otherwise looks like a bug:
      // the feed only carries NEW launches, so a coin already on your screener
      // when the bot started was never on its watchlist and cannot be bought.
      log.warn(
        'Only launches from NOW ON are tracked. A coin already trading when the ' +
          'bot started is invisible to it — give it a few minutes before ' +
          'comparing against a screener you already had open.',
      );
      log.info(
        `Market cap and volume come from ${
          this.cfg.SCREEN_DATA_SOURCE === 'feed'
            ? 'the PumpPortal trade feed'
            : 'your RPC, read straight off each bonding curve'
        }. SOL/USD $${this.ai?.solUsd.toFixed(2)} — check that against your screener; ` +
          'if it disagrees, so will every USD threshold.',
      );
    }
    if (this.dashboard) log.info(`Dashboard: ${this.dashboard.url}`);
  }

  private banner(): void {
    const c = this.cfg;
    const ladder = c.EXIT_LADDER.map((t) => `+${t.gainPct}%→sell ${t.sellPctOfOriginal}%`).join(', ');
    const moonbag = 100 - c.EXIT_LADDER.reduce((a, t) => a + t.sellPctOfOriginal, 0);
    const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`);

    log.info('─'.repeat(72));
    log.info(
      `  SOL Trader — mode=${c.MODE.toUpperCase()} entry=${c.ENTRY_MODE} executor=${c.EXECUTOR}`,
    );
    if (c.ENTRY_MODE === 'screener') {
      log.info(
        `  Filter      ${c.SCREEN_ALLOWED_POOLS.join('/')} · mcap ${k(c.SCREEN_MIN_MCAP_USD)}` +
          `${c.SCREEN_MAX_MCAP_USD > 0 ? `-${k(c.SCREEN_MAX_MCAP_USD)}` : '+'}` +
          ` · volume ≥${k(c.SCREEN_MIN_VOLUME_USD)} · ≥${c.SCREEN_MIN_SOCIALS} social` +
          ` · ≥${c.SCREEN_MIN_BUYERS} buyers · age ${c.SCREEN_MIN_AGE_SECONDS}-${c.SCREEN_MAX_AGE_SECONDS}s`,
      );
    } else if (c.ENTRY_MODE === 'fast') {
      log.info(
        `  Momentum    +${c.MOMENTUM_MIN_GAIN_PCT}% in ${c.MOMENTUM_WINDOW_SECONDS}s, ` +
          `≥${c.MOMENTUM_MIN_BUYERS} buyers, ≥${c.MOMENTUM_MIN_VOLUME_SOL} SOL`,
      );
    } else if (c.ENTRY_MODE === 'ai') {
      log.info(`  Analyst     ${c.AI_MODEL} @ effort=${c.AI_EFFORT}, min confidence ${c.AI_MIN_CONFIDENCE}`);
      log.info(`  Gate        age ${c.WATCH_MIN_AGE_SECONDS}-${c.WATCH_MAX_AGE_SECONDS}s, ≥${c.MIN_UNIQUE_BUYERS} buyers, ≥${c.MIN_BUY_VOLUME_SOL} SOL volume`);
    }
    if (c.ENTRY_MODE === 'ai' || c.AI_MANAGE_EXITS) {
      log.info(`  AI budget   ${c.AI_MAX_CALLS_PER_HOUR} calls/h, $${c.AI_DAILY_BUDGET_USD}/day, review every ${c.AI_REVIEW_INTERVAL_SECONDS}s`);
    }
    log.info(`  Size        ${c.BUY_AMOUNT_SOL} SOL/position, max ${c.MAX_CONCURRENT_POSITIONS} concurrent`);
    if (c.EXIT_MODE === 'ratchet') {
      const be = breakevenGrossPct(costModel(c, c.BUY_AMOUNT_SOL));
      log.info(
        `  Exit        every ${c.CHECKPOINT_SECONDS}s it must be higher than the last check, ` +
          `or it is sold`,
      );
      log.info(
        `  De-risk     at +${c.RECOVER_AT_GAIN_PCT}% the ${c.BUY_AMOUNT_SOL} SOL stake comes back out; ` +
          `the rest rides free, trimmed ${c.MOONBAG_TRIM_PCT}% per surviving check`,
      );
      log.info(
        `  Stop loss   NONE${c.RATCHET_STOP_LOSS_PCT > 0 ? ` (override -${c.RATCHET_STOP_LOSS_PCT}%)` : ''} — ` +
          `worst case per trade is the full ${c.BUY_AMOUNT_SOL} SOL. First check needs ` +
          `> +${be.toFixed(1)}% just to cover fees.`,
      );
    } else if (c.EXIT_MODE === 'scalp') {
      const model = costModel(c, c.BUY_AMOUNT_SOL);
      const be = breakevenGrossPct(model);
      const tgt = targetGrossPct(model, c.SCALP_TARGET_NET_PCT);
      log.info(
        `  Exit        breakeven +${be.toFixed(1)}% → target +${tgt.toFixed(1)}% ` +
          `(net +${c.SCALP_TARGET_NET_PCT}%), keep ${c.SCALP_RUNNER_PCT}% runner`,
      );
      log.info(
        `  Stops       hard -${c.SCALP_STOP_LOSS_PCT}%, give back ${c.SCALP_GIVEBACK_PCT}% of peak, ` +
          `time stop ${c.SCALP_TIME_STOP_SECONDS}s`,
      );
      log.info(
        `  Win rate    needs ${requiredWinRatePct(model, c.SCALP_TARGET_NET_PCT, c.SCALP_STOP_LOSS_PCT).toFixed(0)}% ` +
          'of trades to hit target rather than stop, just to break even',
      );
    } else {
      log.info(`  Ladder      ${ladder}, moonbag ${moonbag}%`);
      log.info(`  Stops       hard -${c.STOP_LOSS_PCT}%, trailing -${c.TRAILING_STOP_PCT}%, moonbag -${c.MOONBAG_TRAILING_STOP_PCT}%`);
      log.info(`  Time stop   ${c.TIME_STOP_SECONDS}s below +${c.TIME_STOP_MIN_GAIN_PCT}%`);
    }
    log.info(`  Risk        daily -${c.DAILY_LOSS_LIMIT_SOL} SOL, ${c.HOURLY_SPEND_CAP_SOL} SOL/h, breaker at ${c.MAX_CONSECUTIVE_LOSSES} losses`);
    log.info('─'.repeat(72));

    if (c.MODE === 'live') {
      log.warn('LIVE MODE — this will spend real SOL. Ctrl-C now if that is not what you want.');
    }
  }

  private onCandidate(candidate: TokenCandidate): void {
    this.stats.seen += 1;

    // In AI mode nothing is bought at creation — every launch is watched and
    // judged later, once it has a track record to judge.
    if (this.ai) {
      this.ai.observe(candidate);
      return;
    }

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

  /** AI stats for the dashboard, or null when the deterministic strategy runs. */
  private aiView() {
    if (!this.ai) return null;
    const s = this.ai.snapshotStats();
    const u = this.ai.usage;
    return {
      enabled: true,
      model: this.cfg.AI_MODEL,
      entryMode: this.cfg.ENTRY_MODE,
      screenMatched: s.screenMatched,
      socialsFetched: s.socialsFetched,
      blockedByRisk: s.blockedByRisk,
      buyFailed: s.buyFailed,
      lastBlockReason: s.lastBlockReason,
      screenRejects: s.screenRejects,
      solUsd: this.ai.solUsd,
      solPriceLive: this.ai.solPriceIsLive,
      watching: s.watching,
      evaluated: s.evaluated,
      bought: s.bought,
      passed: s.passed,
      reviews: s.reviews,
      budgetBlocked: s.budgetBlocked,
      calls: u.calls,
      refusals: u.refusals,
      errors: u.errors,
      estimatedCostUsd: u.estimatedCostUsd,
      dailyBudgetUsd: this.cfg.AI_DAILY_BUDGET_USD,
      cacheReadTokens: u.cacheReadTokens,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    };
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
    if (this.aiTimer) clearInterval(this.aiTimer);
    this.ai?.stop();
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
