import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Executor, LadderTier, Position, TokenCandidate } from '../types.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { PositionManager } from '../strategy/position-manager.js';
import { Watchlist, type ObservedTrade } from '../watchlist/watchlist.js';
import { fetchSocials, type TokenSocials } from '../watchlist/metadata.js';
import { TokenAnalyst } from './analyst.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { pctChange } from '../util/solana.js';
import { momentumSignal } from '../strategy/momentum.js';
import { screenerSignal } from '../strategy/screener.js';
import { SolPrice } from '../util/solprice.js';

const log = logger('ai-strategy');

export interface AiStats {
  watching: number;
  graduated: number;
  evaluated: number;
  bought: number;
  passed: number;
  reviews: number;
  budgetBlocked: number;
  /** Tokens that cleared every filter, whether or not the buy then landed. */
  screenMatched: number;
  /** Metadata fetches issued — only for tokens that cleared everything else. */
  socialsFetched: number;
  /** Matches a risk limit refused. The gap between matched and bought. */
  blockedByRisk: number;
  /** Matches where the buy itself failed. */
  buyFailed: number;
  /** Why the most recent match did not become a position. */
  lastBlockReason?: string;
  /**
   * Why tokens were turned away, keyed by the failing filter. This is the
   * tuning instrument: "nothing is trading" and "everything is trading" are
   * both answered by looking at which line dominates.
   */
  screenRejects: Record<string, number>;
}

/** The filter each rejection reason belongs to, for the tuning breakdown. */
const REJECT_BUCKETS: ReadonlyArray<[RegExp, string]> = [
  [/^pool /, 'pool'],
  [/^deployer sold/, 'deployer_sold'],
  [/old \(min/, 'too_young'],
  [/old \(max/, 'too_old'],
  [/^mcap .* below/, 'mcap_low'],
  [/^mcap .* above/, 'mcap_high'],
  [/^volume /, 'volume'],
  [/buyers \(need/, 'buyers'],
  [/socials unavailable/, 'socials_unavailable'],
  [/socials \(need/, 'socials'],
];

/** Human labels for the rejection buckets, for the periodic summary. */
const BUCKET_LABELS: Record<string, string> = {
  pool: 'wrong venue',
  deployer_sold: 'deployer sold',
  too_young: 'too young',
  too_old: 'too old',
  mcap_low: 'mcap below floor',
  mcap_high: 'mcap above ceiling',
  volume: 'volume below floor',
  buyers: 'too few buyers',
  socials: 'no socials',
  socials_unavailable: 'metadata unreadable',
  other: 'other',
};

function bucketOf(reason: string): string {
  for (const [re, name] of REJECT_BUCKETS) if (re.test(reason)) return name;
  return 'other';
}

export interface OrchestratorDeps {
  cfg: Config;
  store: Store;
  executor: Executor;
  risk: RiskManager;
  positions: PositionManager;
  walletBalance: () => Promise<number>;
  /** Subscribe/unsubscribe the trade feed for these mints. */
  trackTrades: (mints: string[]) => void;
  untrackTrades: (mints: string[]) => void;
  /** Test seam: stand in for the off-chain metadata fetch. */
  socialsFetcher?: (uri: string | undefined) => Promise<TokenSocials>;
  /** Test seam: stand in for the live SOL/USD feed. */
  solPrice?: { readonly usd: number; readonly isLive: boolean };
}

/**
 * The AI trading loop.
 *
 * Deliberately a funnel, because analyst calls cost real money and most tokens
 * are not worth one:
 *
 *   every launch  →  watchlist (free, on-chain flow only)
 *                 →  deterministic traction gate (free)
 *                 →  Claude entry decision (paid, a few per hour)
 *                 →  risk sizing + execution (free)
 *                 →  Claude position review on a slow cadence (paid)
 *
 * Mechanical stops run underneath the model at all times. The analyst can
 * decide to exit early, but it cannot decide to hold through a stop loss —
 * that authority stays with deterministic code, because a model that talks
 * itself into holding a rug is exactly the failure this design has to survive.
 */
export class AiOrchestrator {
  readonly watchlist: Watchlist;
  private readonly analyst: TokenAnalyst;
  private readonly solPrice: { readonly usd: number; readonly isLive: boolean };
  private readonly socialsFetcher: (uri: string | undefined) => Promise<TokenSocials>;

  private stats: AiStats = {
    watching: 0,
    graduated: 0,
    evaluated: 0,
    bought: 0,
    passed: 0,
    reviews: 0,
    budgetBlocked: 0,
    screenMatched: 0,
    socialsFetched: 0,
    blockedByRisk: 0,
    buyFailed: 0,
    screenRejects: {},
  };

  /** Mirrors stats.lastBlockReason; kept separate so the setter reads cleanly. */
  private set lastBlockReason(reason: string) {
    this.stats.lastBlockReason = reason;
  }

  /** Timestamps of analyst calls, for the rolling hourly cap. */
  private callLog: number[] = [];
  private lastReview = new Map<string, number>();
  private evaluating = false;
  private entering = false;
  /** Serialises buys without dropping any. See queueEntry. */
  private entryChain: Promise<void> = Promise.resolve();
  private subscribed = new Set<string>();
  private subscribeTimer: NodeJS.Timeout | null = null;
  private lastSummaryAt = Date.now();

  constructor(private readonly deps: OrchestratorDeps) {
    this.watchlist = new Watchlist(deps.cfg);
    this.analyst = new TokenAnalyst(deps.cfg, deps.store);
    this.solPrice = deps.solPrice ?? new SolPrice(deps.cfg.SOL_USD_FALLBACK);
    this.socialsFetcher = deps.socialsFetcher ?? fetchSocials;
    // Warm the price before the first launch arrives. Reading it lazily would
    // screen the first tokens of a run against the fallback rate, which is the
    // one case where a wrong number is invisible.
    if (deps.cfg.ENTRY_MODE === 'screener') void this.solPrice.usd;
  }

  get usage() {
    return this.analyst.usage;
  }

  get solUsd(): number {
    return this.solPrice.usd;
  }

  get solPriceIsLive(): boolean {
    return this.solPrice.isLive;
  }

  snapshotStats(): AiStats {
    return {
      ...this.stats,
      watching: this.watchlist.size,
      screenRejects: { ...this.stats.screenRejects },
    };
  }

  /** Every new launch goes on the watchlist; none are bought at creation. */
  observe(candidate: TokenCandidate): void {
    if (this.deps.store.hasTraded(candidate.mint)) return;
    if (!this.watchlist.add(candidate)) return;

    // The screener cannot see a token's volume until the trade feed is
    // streaming it, and waiting for the next 10s sweep to subscribe means
    // missing the first ten seconds of every launch — which for a filter that
    // trips within a minute is most of the signal. Subscribe on a short
    // debounce instead, batching the launches that arrive together.
    if (this.deps.cfg.ENTRY_MODE === 'screener' && !this.subscribeTimer) {
      this.subscribeTimer = setTimeout(() => {
        this.subscribeTimer = null;
        this.syncSubscriptions();
      }, 250);
      this.subscribeTimer.unref?.();
    }
  }

  /**
   * Every trade on a watched token, straight off the websocket.
   *
   * The momentum check runs HERE rather than on the timer, because the moves
   * worth catching complete in seconds — waiting for the next 10s tick means
   * arriving after they are over. This path does no I/O and no model call, so
   * the cost of running it on every trade is microseconds.
   */
  recordTrade(trade: ObservedTrade): void {
    this.watchlist.recordTrade(trade);

    const mode = this.deps.cfg.ENTRY_MODE;
    if (mode === 'screener') {
      this.screenTrade(trade);
      return;
    }
    if (mode !== 'fast') return;
    if (trade.side !== 'buy') return;

    const token = this.watchlist.get(trade.mint);
    if (!token || token.analysed) return;

    const signal = momentumSignal(token, this.deps.cfg, trade.at);
    if (!signal.fire) return;

    // Claim it synchronously so a burst of trades cannot fire twice.
    this.watchlist.markAnalysed(trade.mint);
    this.stats.graduated += 1;

    void this.fastEntry(token.candidate, signal.reason).catch((err) =>
      log.error(`Fast entry failed for ${trade.mint}: ${errMessage(err)}`),
    );
  }

  /**
   * Re-runs the screener on every trade for a watched token.
   *
   * A filter crossing is an event, not a state — the tokens worth catching sit
   * above the thresholds for seconds. So the check runs on the same event that
   * moved the numbers, rather than on a timer that would sample the condition
   * after it had already passed.
   */
  private screenTrade(trade: ObservedTrade): void {
    this.screenToken(trade.mint, trade.at);
  }

  /** Runs the filter over one watched token and acts on the verdict. */
  private screenToken(mint: string, at = Date.now()): void {
    const token = this.watchlist.get(mint);
    if (!token || token.analysed) return;

    const verdict = screenerSignal(token, this.deps.cfg, this.solPrice.usd, at);

    if (verdict.outcome === 'needs-socials') {
      // Everything measurable already passed; the only unknown is one HTTP
      // request away. These are the near-misses worth seeing in the log —
      // there are only a handful an hour, and if the fetch is what is blocking
      // entries this is where it shows.
      if (this.watchlist.claimSocialsFetch(mint)) {
        this.stats.socialsFetched += 1;
        log.info(
          `CHECKING ${token.candidate.symbol ?? mint.slice(0, 8)} — ${verdict.reason.replace('socials not fetched yet', 'filters clear, reading metadata')}`,
        );
        void this.socialsFetcher(token.candidate.uri)
          .catch(() => ({ checked: true, failed: true, count: 0 }) as TokenSocials)
          .then((s) => {
            this.watchlist.setSocials(mint, s);
            // Re-screen immediately. Waiting for the next trade event would
            // lose the token entirely if it went quiet during the fetch, which
            // is exactly when a fast mover has already turned over.
            this.screenToken(mint);
          });
      }
      return;
    }

    if (verdict.outcome === 'reject') {
      const bucket = bucketOf(verdict.reason);
      this.stats.screenRejects[bucket] = (this.stats.screenRejects[bucket] ?? 0) + 1;
      return;
    }

    // Claim it synchronously so a burst of trades cannot fire twice.
    this.watchlist.markAnalysed(mint);
    this.stats.screenMatched += 1;
    this.stats.graduated += 1;
    log.info(`MATCH ${token.candidate.symbol ?? mint.slice(0, 8)} — ${verdict.reason}`);

    this.queueEntry(token.candidate, verdict.reason);
  }

  /**
   * Queues an entry instead of dropping it.
   *
   * Buys have to be serialised or two matches land at once and blow through the
   * position cap. The previous version enforced that with a boolean that
   * *discarded* any match arriving mid-buy — and since the token was already
   * marked analysed, it was gone for good. On a strategy whose whole premise is
   * "enter every coin that matches", silently binning simultaneous matches is
   * the bug, not the safeguard.
   *
   * Queued entries still expire: a fill 30 seconds after the filter tripped is
   * buying a different setup from the one that matched.
   */
  private queueEntry(candidate: TokenCandidate, reason: string): void {
    const queuedAt = Date.now();
    const run = async () => {
      const waited = (Date.now() - queuedAt) / 1000;
      if (waited > this.deps.cfg.ENTRY_QUEUE_MAX_WAIT_SECONDS) {
        log.warn(
          `SKIP ${candidate.symbol ?? candidate.mint.slice(0, 8)} — waited ${waited.toFixed(1)}s ` +
            `behind other entries, past ENTRY_QUEUE_MAX_WAIT_SECONDS`,
        );
        return;
      }
      await this.fastEntry(candidate, reason);
    };
    this.entryChain = this.entryChain
      .then(run, run)
      .catch((err) => log.error(`Entry failed for ${candidate.mint}: ${errMessage(err)}`));
  }

  /** Deterministic entry: risk check, then buy. No model in this path. */
  private async fastEntry(candidate: TokenCandidate, reason: string): Promise<void> {
    const label = candidate.symbol ?? candidate.mint.slice(0, 8);
    if (this.deps.store.hasTraded(candidate.mint)) return;
    if (this.entering) {
      log.warn(`SKIP ${label} — another entry was already in flight`);
      return;
    }
    this.entering = true;
    try {
      const risk = this.deps.risk.canOpen(await this.deps.walletBalance());
      if (!risk.allowed) {
        // Loud, not debug. Everything from here down is a reason the bot
        // declined a token that DID match the filter — which is exactly the
        // question you are asking when you watch a matching coin go by
        // untouched. Hiding it below the default log level made the bot look
        // broken when it was doing what it was told.
        this.stats.blockedByRisk += 1;
        this.lastBlockReason = risk.reason ?? 'risk check failed';
        log.warn(`SKIP ${label} — matched the filter but ${risk.reason}`);
        return;
      }

      if (this.deps.cfg.ENTRY_MODE !== 'screener') {
        log.info(`FAST ENTRY ${label} — ${reason}`);
      }
      this.deps.store.recordCreatorLaunch(candidate.creator, candidate.mint);

      const size = this.deps.risk.sizeFor(100);
      const fill = await this.deps.executor.buy(candidate, size);
      if (!fill.ok) {
        this.stats.buyFailed += 1;
        this.lastBlockReason = fill.error ?? 'buy failed';
        log.warn(`BUY FAILED ${label} — ${fill.error}`);
        if (fill.spentSol > 0) this.deps.risk.recordOutcome(-fill.spentSol);
        return;
      }

      this.stats.bought += 1;
      const position = this.deps.positions.open(candidate, fill, 0);
      position.notionalSol = size;
      // The entry condition is written onto the position so the trade journal
      // records what the filter looked like at the moment of the buy. Without
      // that, tuning the thresholds later is guesswork.
      position.notes.push(
        `${this.deps.cfg.ENTRY_MODE === 'screener' ? 'screen' : 'momentum'}: ${reason}`,
      );
      this.deps.store.savePosition(position);
    } finally {
      this.entering = false;
    }
  }

  /**
   * Re-tracks a position resumed from disk.
   *
   * The watchlist is in-memory, so after a restart the reviewer sees no flow
   * for positions we are still holding and — reasonably, given no evidence —
   * exits them. Putting them back on the watchlist restores the data instead,
   * and marking them analysed keeps them out of the entry funnel.
   */
  adoptPosition(p: Position): void {
    if (this.watchlist.has(p.mint)) return;
    this.watchlist.add({
      mint: p.mint,
      creator: p.creator,
      symbol: p.symbol,
      name: p.name,
      pool: p.pool,
      detectedAt: p.openedAt,
      source: 'resumed',
    });
    this.watchlist.markAnalysed(p.mint);
  }

  /**
   * Budget guard. Two independent limits, both hard:
   * a rolling hourly call cap and a daily dollar ceiling.
   */
  private budgetAllows(): { ok: boolean; reason?: string } {
    const now = Date.now();
    this.callLog = this.callLog.filter((t) => t >= now - 3_600_000);

    if (this.callLog.length >= this.deps.cfg.AI_MAX_CALLS_PER_HOUR) {
      return {
        ok: false,
        reason: `hourly analyst cap reached (${this.callLog.length}/${this.deps.cfg.AI_MAX_CALLS_PER_HOUR})`,
      };
    }
    const spend = this.analyst.usage.estimatedCostUsd;
    if (spend >= this.deps.cfg.AI_DAILY_BUDGET_USD) {
      return {
        ok: false,
        reason: `daily AI budget reached ($${spend.toFixed(2)}/$${this.deps.cfg.AI_DAILY_BUDGET_USD})`,
      };
    }
    return { ok: true };
  }

  /** One pass: prune, resync subscriptions, evaluate graduates, review positions. */
  async tick(): Promise<void> {
    this.watchlist.prune();
    this.syncSubscriptions();
    this.logScreenSummary();

    await this.reviewOpenPositions();
    await this.evaluateGraduates();
  }

  /**
   * Periodic one-line answer to "why isn't it buying anything".
   *
   * The dashboard has the same breakdown, but the terminal is where you watch
   * a run, and a bot that prints nothing for ten minutes is indistinguishable
   * from a bot that has silently stopped working.
   */
  private logScreenSummary(): void {
    if (this.deps.cfg.ENTRY_MODE !== 'screener') return;
    const now = Date.now();
    if (now - this.lastSummaryAt < 60_000) return;
    this.lastSummaryAt = now;

    const entries = Object.entries(this.stats.screenRejects).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, n]) => a + n, 0);
    if (total === 0) {
      log.info(
        `SCREEN watching ${this.watchlist.size} tokens, no trades checked yet — ` +
          'if this persists the trade feed is not delivering',
      );
      return;
    }

    const top = entries
      .slice(0, 4)
      .map(([k, n]) => `${BUCKET_LABELS[k] ?? k} ${Math.round((n / total) * 100)}%`)
      .join(', ');
    const s = this.stats;
    log.info(
      `SCREEN ${total.toLocaleString()} checks on ${this.watchlist.size} tokens · ${top} · ` +
        `${s.screenMatched} matched, ${s.bought} bought` +
        (s.blockedByRisk > 0 ? `, ${s.blockedByRisk} blocked (${s.lastBlockReason})` : '') +
        (s.buyFailed > 0 ? `, ${s.buyFailed} buy failures` : ''),
    );
    if (!this.solPrice.isLive) {
      log.warn(
        `SOL/USD feed is not live — every USD threshold is being converted at ` +
          `SOL_USD_FALLBACK=$${this.deps.cfg.SOL_USD_FALLBACK}. If that is wrong, so is the filter.`,
      );
    }
  }

  /** Keeps the trade feed subscribed to exactly what we are watching. */
  private syncSubscriptions(): void {
    const want = new Set(this.watchlist.mints());

    const toAdd = [...want].filter((m) => !this.subscribed.has(m));
    const toDrop = [...this.subscribed].filter((m) => !want.has(m));

    if (toAdd.length > 0) {
      this.deps.trackTrades(toAdd);
      for (const m of toAdd) this.subscribed.add(m);
    }
    if (toDrop.length > 0) {
      this.deps.untrackTrades(toDrop);
      for (const m of toDrop) this.subscribed.delete(m);
    }
  }

  private async evaluateGraduates(): Promise<void> {
    if (this.deps.cfg.ENTRY_MODE !== 'ai') return;
    if (this.evaluating) return;

    const graduates = this.watchlist.graduates();
    if (graduates.length === 0) return;

    this.evaluating = true;
    try {
      for (const { token, metrics } of graduates) {
        const mint = token.candidate.mint;
        if (this.deps.store.hasTraded(mint)) {
          this.watchlist.markAnalysed(mint);
          continue;
        }

        // Check risk BEFORE spending a call — no point paying to analyse a
        // token we could not open a position in anyway.
        const risk = this.deps.risk.canOpen(await this.deps.walletBalance());
        if (!risk.allowed) {
          log.debug(`Holding off on analysis: ${risk.reason}`);
          return;
        }

        const budget = this.budgetAllows();
        if (!budget.ok) {
          this.stats.budgetBlocked += 1;
          log.warn(`Analyst paused: ${budget.reason}`);
          return;
        }

        this.stats.graduated += 1;
        this.watchlist.markAnalysed(mint);
        this.callLog.push(Date.now());
        this.stats.evaluated += 1;

        // Record the launch so deployer reputation accrues from what we see.
        this.deps.store.recordCreatorLaunch(token.candidate.creator, mint);

        const decision = await this.analyst.evaluateEntry(token, metrics);
        if (!decision.ok || !decision.value) continue;

        const d = decision.value;
        if (d.action !== 'buy') {
          this.stats.passed += 1;
          continue;
        }
        if (d.confidence < this.deps.cfg.AI_MIN_CONFIDENCE) {
          this.stats.passed += 1;
          log.info(
            `Skipping ${token.candidate.symbol ?? mint.slice(0, 8)}: ` +
              `confidence ${d.confidence} below threshold ${this.deps.cfg.AI_MIN_CONFIDENCE}`,
          );
          continue;
        }

        await this.openPosition(token.candidate, d);
        return; // one entry per tick keeps the position cap honest
      }
    } finally {
      this.evaluating = false;
    }
  }

  private async openPosition(
    candidate: TokenCandidate,
    d: import('./schema.js').EntryDecision,
  ): Promise<void> {
    const size = this.deps.risk.sizeFor(d.confidence);
    const fill = await this.deps.executor.buy(candidate, size);

    if (!fill.ok) {
      log.warn(`Buy failed for ${candidate.symbol ?? candidate.mint}: ${fill.error}`);
      if (fill.spentSol > 0) this.deps.risk.recordOutcome(-fill.spentSol);
      return;
    }

    this.stats.bought += 1;
    const position = this.deps.positions.open(candidate, fill, d.confidence);
    position.notionalSol = size;

    // Carry the model's plan onto the position so the reviewer can be held to
    // its own thesis, and so the exit planner can use its levels.
    position.notes.push(`thesis: ${d.thesis}`);
    if (d.risks.length > 0) position.notes.push(`risks: ${d.risks.join(' | ')}`);
    position.aiTargetGainPct = d.target_gain_pct > 0 ? d.target_gain_pct : undefined;
    position.aiInvalidationPct = d.invalidation_loss_pct > 0 ? d.invalidation_loss_pct : undefined;
    if (d.target_gain_pct > 0) position.ladder = ladderFromTarget(d.target_gain_pct);
    this.deps.store.savePosition(position);
  }

  private async reviewOpenPositions(): Promise<void> {
    if (!this.deps.cfg.AI_MANAGE_EXITS) return;
    const open = this.deps.store.openPositions();
    if (open.length === 0) return;

    const now = Date.now();
    const intervalMs = this.deps.cfg.AI_REVIEW_INTERVAL_SECONDS * 1000;

    for (const p of open) {
      const last = this.lastReview.get(p.id) ?? p.openedAt;
      if (now - last < intervalMs) continue;

      const budget = this.budgetAllows();
      if (!budget.ok) {
        this.stats.budgetBlocked += 1;
        return;
      }

      this.lastReview.set(p.id, now);
      this.callLog.push(Date.now());
      this.stats.reviews += 1;

      const token = this.watchlist.get(p.mint);
      const metrics = token ? this.watchlist.metrics(token) : undefined;
      const gainPct = pctChange(p.entryPrice, p.lastPrice);

      try {
        // Without live flow there is nothing to judge the thesis against. The
        // model will reasonably exit on "no evidence", which after a restart
        // would liquidate every resumed position for no market reason. Skip the
        // review instead and wait for the feed to repopulate.
        if (!metrics || metrics.buyCount + metrics.sellCount === 0) {
          log.debug(`Skipping review of ${p.symbol ?? p.mint}: no flow data yet`);
          continue;
        }

        const review = await this.analyst.reviewPosition(p, token, metrics, gainPct);
        if (!review.ok || !review.value) continue;

        const r = review.value;
        if (r.action === 'exit') {
          await this.deps.positions.externalExit(p, 'ai_exit', r.reason);
        } else if (r.action === 'trim' && r.trim_pct > 0) {
          const qty = (p.remainingQty * r.trim_pct) / 100;
          if (qty > 0) {
            await this.deps.positions.externalExit(p, 'ai_trim', r.reason, qty);
          }
        }
      } catch (err) {
        log.error(`Review failed for ${p.mint}: ${errMessage(err)}`);
      }
    }

    // Drop review timers for positions that have closed.
    const openIds = new Set(open.map((p) => p.id));
    for (const id of this.lastReview.keys()) {
      if (!openIds.has(id)) this.lastReview.delete(id);
    }
  }
}

/**
 * Turns the analyst's single target into a laddered exit.
 *
 * The model gives one number for where it expects to be substantially out; a
 * ladder around it banks most of the position near that level while leaving a
 * runner, so a call that turns out conservative is not capped at its own guess.
 */
export function ladderFromTarget(targetGainPct: number): LadderTier[] {
  const t = Math.max(5, targetGainPct);
  return [
    { gainPct: Math.round(t * 0.5), sellPctOfOriginal: 35, filled: false },
    { gainPct: Math.round(t), sellPctOfOriginal: 35, filled: false },
    { gainPct: Math.round(t * 2.5), sellPctOfOriginal: 20, filled: false },
  ];
}
