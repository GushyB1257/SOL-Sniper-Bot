import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Executor, LadderTier, TokenCandidate } from '../types.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { PositionManager } from '../strategy/position-manager.js';
import { Watchlist, type ObservedTrade } from '../watchlist/watchlist.js';
import { TokenAnalyst } from './analyst.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { pctChange } from '../util/solana.js';

const log = logger('ai-strategy');

export interface AiStats {
  watching: number;
  graduated: number;
  evaluated: number;
  bought: number;
  passed: number;
  reviews: number;
  budgetBlocked: number;
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

  private stats: AiStats = {
    watching: 0,
    graduated: 0,
    evaluated: 0,
    bought: 0,
    passed: 0,
    reviews: 0,
    budgetBlocked: 0,
  };

  /** Timestamps of analyst calls, for the rolling hourly cap. */
  private callLog: number[] = [];
  private lastReview = new Map<string, number>();
  private evaluating = false;
  private subscribed = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.watchlist = new Watchlist(deps.cfg);
    this.analyst = new TokenAnalyst(deps.cfg, deps.store);
  }

  get usage() {
    return this.analyst.usage;
  }

  snapshotStats(): AiStats {
    return { ...this.stats, watching: this.watchlist.size };
  }

  /** Every new launch goes on the watchlist; none are bought at creation. */
  observe(candidate: TokenCandidate): void {
    if (this.deps.store.hasTraded(candidate.mint)) return;
    this.watchlist.add(candidate);
  }

  recordTrade(trade: ObservedTrade): void {
    this.watchlist.recordTrade(trade);
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

    await this.reviewOpenPositions();
    await this.evaluateGraduates();
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
