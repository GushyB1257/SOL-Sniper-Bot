import type { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import { Store } from '../state/store.js';
import { RiskManager } from '../risk/risk-manager.js';
import { PositionManager } from '../strategy/position-manager.js';
import { SafetyEngine, formatVerdict } from '../safety/engine.js';
import { AiOrchestrator } from '../ai/orchestrator.js';
import { WalletWatcher } from '../copy/wallet-watcher.js';
import { withRpcPriority } from '../util/rpc-throttle.js';
import { CopyTrader } from '../copy/copy-trader.js';
import { marketCapFromState } from '../watchlist/curve-poller.js';
import { pctChange } from '../util/solana.js';
import type { PriceSource } from '../execution/pricing.js';
import { poolAllowed, type Executor, type SafetyVerdict, type TokenCandidate } from '../types.js';
import { logger } from '../logger.js';
import { errMessage, sleep } from '../util/async.js';

const log = logger('bot');

export type BotId = 'screener' | 'sniper' | 'copy' | 'arb';

/**
 * What the supervisor and the dashboard need from a bot.
 *
 * The arbitrage strategy is not a `TradingBot` — it has no launch feed, no
 * position held over time and no exit planner — but the dashboard renders every
 * tab from one template, so it satisfies this instead. Keeping the surface small
 * is what let a fourth strategy become a fourth tab without a special case in
 * the snapshot, the settings form or the auto-tuner.
 */
export interface DashboardBot {
  readonly id: BotId;
  readonly name: string;
  readonly store: Store;
  readonly paused: boolean;
  readonly running: boolean;
  setPaused(paused: boolean): void;
  snapshotStats(): BotStats;
  start(): void;
  stop(): void;
  tickPositions(): Promise<void>;
  tickStrategy(): Promise<void>;
  readonly ai: AiOrchestrator | null;
  readonly copy: CopyTrader | null;
  readonly watcher: WalletWatcher | null;
  /** Null for strategies with no manually closeable position. */
  readonly positions: PositionManager | null;
}

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
  /** Cross-bot: how many tracked copy wallets hold a mint. See the screener. */
  copyHolders?: (mint: string) => number;
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
  /** Safety batteries running right now. Bounded — see considerCandidate. */
  private checksInFlight = 0;
  private shedAt = 0;
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
        copyHolders: deps.copyHolders,
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

    // Venue first, before anything is spent on it. The screener and copy trader
    // have always had this gate; the sniper took whatever the feed handed it,
    // which was fine while the feed only carried pump.fun and stopped being fine
    // when it started carrying every launchpad on Solana.
    if (!poolAllowed(cfg.SNIPE_ALLOWED_POOLS, candidate.pool)) {
      this.stats.skipped += 1;
      log.debug(
        `${this.name}: skip ${label} — venue ${candidate.pool} not in ` +
          cfg.SNIPE_ALLOWED_POOLS.join('/'),
      );
      return;
    }
    if (this.store.hasTraded(candidate.mint) || this.entryInFlight) {
      this.stats.skipped += 1;
      return;
    }
    if (Date.now() - candidate.detectedAt > cfg.MAX_CANDIDATE_AGE_MS) {
      this.stats.skipped += 1;
      return;
    }

    // Shed load rather than queue it. The safety battery is four RPC calls per
    // launch and pump.fun deploys several tokens a second at peak, which is
    // enough on its own to rate-limit a consumer endpoint — and the 429s land
    // on the position ticks and sells too, not just on the checks that caused
    // them. A candidate that had to wait its turn is one we are too late to buy
    // anyway, so dropping it costs nothing that queueing would have saved.
    if (this.checksInFlight >= cfg.SNIPER_MAX_CONCURRENT_CHECKS) {
      this.stats.skipped += 1;
      const now = Date.now();
      if (now - this.shedAt > 30_000) {
        this.shedAt = now;
        log.info(
          `${this.name}: shedding launches — ${cfg.SNIPER_MAX_CONCURRENT_CHECKS} safety checks ` +
            'already running. Raise SNIPER_MAX_CONCURRENT_CHECKS if your RPC can take it.',
        );
      }
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

    let verdict;
    this.checksInFlight += 1;
    try {
      verdict = await this.safety!.evaluate(candidate);
    } finally {
      this.checksInFlight -= 1;
    }

    if (!verdict.passed) {
      this.stats.rejected += 1;
      log.info(`REJECT ${label} — ${formatVerdict(verdict)} (${verdict.elapsedMs}ms)`);
      return;
    }

    // Did anyone else actually buy it? The battery asks whether the token is
    // structurally sound; nothing in it asks whether the launch is going
    // anywhere, which is what the dead-entry mass is made of.
    const confirm = await this.confirmMove(candidate, label);
    if (!confirm.ok) {
      this.stats.rejected += 1;
      log.info(`REJECT ${label} — ${confirm.detail}`);
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
      // Front of the RPC queue: an entry that lands a second late on a
      // token that is moving is a different entry.
      const fill = await withRpcPriority(() => this.deps.executor.buy(candidate, size));
      if (!fill.ok) {
        log.warn(`Buy failed for ${label}: ${fill.error ?? 'unknown'}`);
        if (fill.spentSol > 0) this.risk.recordOutcome(-fill.spentSol);
        return;
      }

      this.stats.bought += 1;
      const position = this.positions.open(candidate, fill, verdict.score);
      position.notionalSol = size;
      position.managedBy = 'sniper';
      // What this launch actually looked like, in the journal rather than only
      // in a log line that scrolls away. Without it the sniper's trade history
      // carries the safety score and nothing else, so "116 of 150 died" cannot
      // be turned into "which characteristic did they share" and every entry
      // filter is a guess between equally plausible knobs.
      position.notes.push(snipeNote(verdict, confirm.movedPct));
      await this.stampMarketCap(position.mint, position, this.deps.solPrice.usd);
      this.store.savePosition(position);
    } finally {
      this.entryInFlight = false;
    }
  }

  /**
   * Samples the price twice and reports whether it moved up in between.
   *
   * Two curve reads and a wait, so it only runs on candidates that have already
   * passed the battery — a small fraction of what comes off the feed. An
   * unreadable curve fails OPEN: a price we cannot fetch says nothing about the
   * launch, and letting our own outage quietly switch the gate into a blanket
   * veto is the same mistake as charging a token for a slow IPFS gateway.
   */
  private async confirmMove(
    candidate: TokenCandidate,
    label: string,
  ): Promise<{ ok: boolean; detail: string; movedPct?: number }> {
    const { cfg } = this.deps;
    if (cfg.SNIPE_CONFIRM_MS <= 0) return { ok: true, detail: 'confirmation disabled' };

    const before = await this.priceNow(candidate.mint);
    if (before === null) {
      log.debug(`${this.name}: ${label} — no price to confirm against, buying anyway`);
      return { ok: true, detail: 'price unreadable, gate skipped' };
    }

    await sleep(cfg.SNIPE_CONFIRM_MS);

    const after = await this.priceNow(candidate.mint);
    if (after === null) {
      log.debug(`${this.name}: ${label} — price became unreadable, buying anyway`);
      return { ok: true, detail: 'price unreadable, gate skipped' };
    }

    const movedPct = pctChange(before, after);
    const need = cfg.SNIPE_CONFIRM_MIN_GAIN_PCT;
    if (movedPct < need) {
      return {
        ok: false,
        detail:
          `no move after creation: ${movedPct.toFixed(1)}% over ` +
          `${cfg.SNIPE_CONFIRM_MS}ms (need ${need}%)`,
        movedPct,
      };
    }
    return { ok: true, detail: `${movedPct.toFixed(1)}% over ${cfg.SNIPE_CONFIRM_MS}ms`, movedPct };
  }

  /** Curve price for a mint, or null when it cannot be read. */
  private async priceNow(mint: string): Promise<number | null> {
    try {
      return await this.deps.prices.price(mint);
    } catch {
      return null;
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

/**
 * The launch's measured characteristics, as one journal line.
 *
 * A formatted string rather than structured fields because that is how the
 * screener's entry note already works and how the evidence builder already
 * reads one. Only what was actually measured appears — a check that is switched
 * off or that never ran contributes nothing rather than a zero, which would be
 * indistinguishable from a real measurement of zero.
 */
export function snipeNote(verdict: SafetyVerdict, movedPct?: number): string {
  const m = verdict.metrics;
  const parts: string[] = [`score ${verdict.score}`];
  // What the confirmation gate saw, when it ran. This is the one entry-side
  // number that is about demand rather than structure, so it is the one most
  // likely to separate the dead entries from the rest.
  if (typeof movedPct === 'number' && Number.isFinite(movedPct)) {
    parts.push(`${movedPct.toFixed(1)}% confirm move`);
  }
  const add = (key: string, fmt: (v: number) => string): void => {
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(fmt(v));
  };

  add('devBuyPct', (v) => `${v.toFixed(2)}% dev buy`);
  add('top10Pct', (v) => `${v.toFixed(1)}% top10`);
  add('holders', (v) => `${v} holders`);
  add('bundleTxs', (v) => `${v} bundled`);
  add('deployerSol', (v) => `${v.toFixed(3)} SOL dev balance`);
  add('creatorAgeMinutes', (v) => `${Math.round(v)}m creator age`);

  return `snipe: ${parts.join(', ')}`;
}
