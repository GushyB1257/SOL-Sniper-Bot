import type { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import { Store } from '../state/store.js';
import { RiskManager } from '../risk/risk-manager.js';
import { PositionManager } from '../strategy/position-manager.js';
import { SafetyEngine, formatVerdict } from '../safety/engine.js';
import { AiOrchestrator } from '../ai/orchestrator.js';
import { WalletWatcher } from '../copy/wallet-watcher.js';
import { CopyTrader } from '../copy/copy-trader.js';
import { marketCapFromState } from '../watchlist/curve-poller.js';
import type { PriceSource } from '../execution/pricing.js';
import type { Executor, TokenCandidate } from '../types.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('bot');

export type BotId = 'screener' | 'sniper' | 'copy';

export interface BotStats {
  seen: number;
  evaluated: number;
  rejected: number;
  bought: number;
  skipped: number;
}

export interface BotDeps {
  cfg: Config;
  dataDir: string;
  executor: Executor;
  prices: PriceSource;
  connection: Connection;
  walletBalance: () => Promise<number>;
  killSwitchPath: string;
  /**
   * Shared live SOL/USD. One feed for the whole process, so the screener's
   * thresholds, the entry stamps and the dashboard header can never disagree
   * about what a dollar is.
   */
  solPrice: { readonly usd: number; readonly isLive: boolean };
  /** Feed hooks, wired by the supervisor. Only the screener uses them. */
  trackTrades: (mints: string[]) => void;
  untrackTrades: (mints: string[]) => void;
}

/**
 * One strategy, with its own books.
 *
 * Each bot gets a separate Store, RiskManager and PositionManager. That
 * separation is the whole point of running several: sharing them would mean one
 * strategy's losing streak trips the breaker on the others, one strategy's
 * positions fill the concurrency cap for the others, and — worst — a single
 * blended P&L that cannot answer "which of these actually works".
 *
 * The executor and the wallet are shared, because there is only one wallet.
 */
export class TradingBot {
  readonly store: Store;
  readonly risk: RiskManager;
  readonly positions: PositionManager;

  /** Set for the screener bot. */
  readonly ai: AiOrchestrator | null = null;
  /** Set for the copy bot. */
  readonly watcher: WalletWatcher | null = null;
  readonly copy: CopyTrader | null = null;
  /** Set for the sniper bot. */
  private readonly safety: SafetyEngine | null = null;

  private stats: BotStats = { seen: 0, evaluated: 0, rejected: 0, bought: 0, skipped: 0 };
  private entryInFlight = false;
  private started = false;

  constructor(
    readonly id: BotId,
    readonly name: string,
    private readonly deps: BotDeps,
  ) {
    const { cfg } = deps;
    this.store = new Store(deps.dataDir, id);
    this.risk = new RiskManager(cfg, this.store, deps.killSwitchPath);
    this.positions = new PositionManager(cfg, this.store, deps.executor, this.risk);

    if (id === 'screener') {
      this.ai = new AiOrchestrator({
        cfg,
        store: this.store,
        executor: deps.executor,
        risk: this.risk,
        positions: this.positions,
        walletBalance: deps.walletBalance,
        trackTrades: deps.trackTrades,
        untrackTrades: deps.untrackTrades,
        connection: deps.connection,
        solPrice: deps.solPrice,
      });
    } else if (id === 'sniper') {
      this.safety = new SafetyEngine(cfg, deps.connection, this.store);
    } else {
      this.copy = new CopyTrader({
        cfg,
        store: this.store,
        executor: deps.executor,
        risk: this.risk,
        positions: this.positions,
        prices: deps.prices,
        walletBalance: deps.walletBalance,
        solUsd: () => deps.solPrice.usd,
      });
      this.watcher = new WalletWatcher(deps.connection, cfg, (t) => this.copy!.onWalletTrade(t));
    }
  }

  get paused(): boolean {
    return this.risk.isPaused;
  }

  setPaused(paused: boolean): void {
    this.risk.setPaused(paused);
    log.info(`${this.name} ${paused ? 'PAUSED' : 'RESUMED'}`);
  }

  snapshotStats(): BotStats {
    return { ...this.stats };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ai?.start();
    this.watcher?.start();
  }

  stop(): void {
    this.started = false;
    this.ai?.stop();
    this.watcher?.stop();
  }

  get running(): boolean {
    return this.started;
  }

  /** Re-prices open positions and runs exits. Every bot needs this. */
  async tickPositions(): Promise<void> {
    await this.positions.tick();
  }

  /** Slower loop: watchlist maintenance and analyst review. */
  async tickStrategy(): Promise<void> {
    await this.ai?.tick();
  }

  /** A new launch off the discovery feed. */
  onCandidate(candidate: TokenCandidate): void {
    this.stats.seen += 1;
    if (this.id === 'screener') {
      this.ai?.observe(candidate);
      return;
    }
    if (this.id !== 'sniper') return;
    void this.considerCandidate(candidate).catch((err) =>
      log.error(`${this.name}: candidate handling failed for ${candidate.mint}: ${errMessage(err)}`),
    );
  }

  /**
   * The original creation-time sniper: run the safety battery, buy if it passes.
   *
   * Kept as its own bot rather than deleted, because it answers a different
   * question from the screener — "is this launch structurally sound" rather
   * than "has this launch already started moving" — and running both makes
   * that comparison with real numbers instead of an argument.
   */
  private async considerCandidate(candidate: TokenCandidate): Promise<void> {
    const { cfg } = this.deps;
    const label = candidate.symbol ?? candidate.mint.slice(0, 8);

    if (this.store.hasTraded(candidate.mint) || this.entryInFlight) {
      this.stats.skipped += 1;
      return;
    }
    if (Date.now() - candidate.detectedAt > cfg.MAX_CANDIDATE_AGE_MS) {
      this.stats.skipped += 1;
      return;
    }

    const risk = this.risk.canOpen(await this.deps.walletBalance());
    if (!risk.allowed) {
      this.stats.skipped += 1;
      log.debug(`${this.name}: skip ${label} — ${risk.reason}`);
      return;
    }

    this.store.recordCreatorLaunch(candidate.creator, candidate.mint);
    this.stats.evaluated += 1;

    const verdict = await this.safety!.evaluate(candidate);
    if (!verdict.passed) {
      this.stats.rejected += 1;
      log.info(`REJECT ${label} — ${formatVerdict(verdict)} (${verdict.elapsedMs}ms)`);
      return;
    }

    log.info(`PASS ${label} — ${formatVerdict(verdict)} (${verdict.elapsedMs}ms), buying`);
    this.entryInFlight = true;
    try {
      // The safety battery took time; a slot may have gone in the meantime.
      const recheck = this.risk.canOpen(await this.deps.walletBalance());
      if (!recheck.allowed) {
        log.info(`Aborting entry for ${label}: ${recheck.reason}`);
        return;
      }

      const size = this.risk.sizeFor(verdict.score);
      const fill = await this.deps.executor.buy(candidate, size);
      if (!fill.ok) {
        log.warn(`Buy failed for ${label}: ${fill.error ?? 'unknown'}`);
        if (fill.spentSol > 0) this.risk.recordOutcome(-fill.spentSol);
        return;
      }

      this.stats.bought += 1;
      const position = this.positions.open(candidate, fill, verdict.score);
      position.notionalSol = size;
      position.managedBy = 'sniper';
      await this.stampMarketCap(position.mint, position, this.deps.solPrice.usd);
      this.store.savePosition(position);
    } finally {
      this.entryInFlight = false;
    }
  }

  /** Records what the token was worth when we bought it, for the positions table. */
  private async stampMarketCap(
    mint: string,
    position: { entryMarketCapSol?: number; entryMarketCapUsd?: number },
    solUsd = 0,
  ): Promise<void> {
    try {
      const curve = await this.deps.prices.curve(mint);
      if (!curve) return;
      const capSol = marketCapFromState(curve);
      if (capSol <= 0) return;
      position.entryMarketCapSol = capSol;
      if (solUsd > 0) position.entryMarketCapUsd = capSol * solUsd;
    } catch {
      // A missing entry cap is cosmetic; never let it fail a buy.
    }
  }
}
