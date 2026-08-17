import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { Store } from '../state/store.js';
import { errMessage, sleep } from '../util/async.js';
import { fromBaseUnits, toBaseUnits } from './decimal.js';
import { JupiterClient } from './jupiter.js';
import { PaperArbExecutor } from './paper.js';
import { breakEvenSize } from './profit.js';
import { ArbRiskManager } from './risk.js';
import { Scanner, type EvaluatedCycle, type ScanResult } from './scanner.js';
import { resolveToken, WSOL } from './tokens.js';
import type { ArbStats, ArbStrategy, ArbTradeResult, Opportunity, Token } from './types.js';

const log = logger('arb');

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** What the dashboard needs from any bot, so the arb bot can be a fourth tab. */
export interface ArbBotDeps {
  cfg: Config;
  dataDir: string;
  killSwitchPath: string;
  now?: () => number;
  /** Injectable so tests never touch the network. */
  client?: JupiterClient;
  random?: () => number;
}

/**
 * SOL → TOKEN → SOL arbitrage, as a fourth strategy alongside the other three.
 *
 * It is deliberately NOT a `TradingBot`. That class is built around a launch
 * feed, a position held over time and an exit planner; an arbitrage round trip
 * has none of those — it opens and closes inside one cycle, and its outcome is a
 * realised number rather than a position to manage. Forcing it into that shape
 * would mean faking a ladder and a ratchet for a trade that has neither.
 *
 * What it DOES share is the `Store`, and that is the important part: every round
 * trip is written as a `TradeJournalEntry`, which is exactly what the auto-tuner
 * reads. So the tuner measures and tunes this strategy through the same
 * change-measure-keep-or-revert loop as the others, with no special casing —
 * and the dashboard renders its tab from the same snapshot shape.
 */
export class ArbBot {
  readonly id = 'arb' as const;
  readonly name = 'Arbitrage';
  readonly store: Store;
  readonly risk: ArbRiskManager;

  /** The other bots expose these; arb has no AI or copy surface. */
  readonly ai = null;
  readonly copy = null;
  readonly watcher = null;
  readonly positions = null;

  private readonly client: JupiterClient;
  private readonly executor: PaperArbExecutor;
  private readonly now: () => number;
  private readonly cfg: Config;

  private stats: ArbStats;
  private started = false;
  private pausedFlag = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;

  /** Last scan's rejected-edge distribution, for the dashboard. */
  private lastEvaluated: readonly EvaluatedCycle[] = [];
  private lastScanAt = 0;
  private lastScanMs = 0;

  /**
   * Why routes were turned down, and how big their edges were, across the whole
   * session rather than the last scan.
   *
   * "Nothing has qualified for a long time" is the expected outcome here, and
   * without this it is also an unanswerable one: the tab showed the last twelve
   * routes and a single best-ever number, which cannot distinguish "the floor is
   * ten times too high" from "there is no edge on this pair at any floor". These
   * two counters are what turn the floor from a guess into a reading.
   */
  private rejectCounts = new Map<string, number>();
  private edgeBuckets = new Map<string, number>();
  private routesPriced = 0;

  constructor(private readonly deps: ArbBotDeps) {
    this.cfg = deps.cfg;
    this.now = deps.now ?? Date.now;
    this.store = new Store(deps.dataDir, 'arb');
    this.client = deps.client ?? new JupiterClient({
      minRequestIntervalMs: this.cfg.ARB_QUOTE_INTERVAL_MS,
      now: this.now,
    });
    this.executor = new PaperArbExecutor({
      adverseSlippageBps: this.cfg.ARB_PAPER_ADVERSE_SLIPPAGE_BPS,
      legFailureRate: this.cfg.ARB_PAPER_LEG_FAILURE_RATE,
      unwindRecoveryPct: this.cfg.ARB_PAPER_UNWIND_RECOVERY_PCT,
      random: deps.random,
      now: this.now,
    });
    this.risk = new ArbRiskManager(this.limits(), this.now);
    this.stats = {
      scans: 0,
      quotesFetched: 0,
      evaluated: 0,
      opportunitiesSeen: 0,
      tradesAttempted: 0,
      tradesFilled: 0,
      tradesFailed: 0,
      bestBps: 0,
      quoteErrors: 0,
      startedAt: this.now(),
    };
  }

  // ---- the shape the dashboard reads -----------------------------------

  get paused(): boolean {
    return this.pausedFlag;
  }

  get running(): boolean {
    return this.started;
  }

  setPaused(paused: boolean): void {
    this.pausedFlag = paused;
    log.info(`${this.name} ${paused ? 'PAUSED' : 'RESUMED'}`);
  }

  /**
   * Arb counters mapped onto the shared bot-stats shape.
   *
   * The dashboard renders every tab from one template, so the arb tab reuses the
   * same five counters rather than growing a special case. The mapping is the
   * honest one: a scan is a look, an evaluated route is a candidate priced, a
   * rejected route is one that did not clear the floor.
   */
  snapshotStats(): {
    seen: number;
    evaluated: number;
    rejected: number;
    bought: number;
    skipped: number;
  } {
    return {
      seen: this.stats.scans,
      evaluated: this.stats.evaluated,
      rejected: Math.max(0, this.stats.evaluated - this.stats.opportunitiesSeen),
      bought: this.stats.tradesFilled,
      skipped: this.stats.tradesFailed,
    };
  }

  arbStats(): ArbStats {
    return { ...this.stats };
  }

  /** Everything the arb tab shows that the shared template does not cover. */
  view(): ArbView {
    const costs = this.scanner().cycleCosts;
    const breakEven = breakEvenSize(costs.totalLamports, this.cfg.ARB_MIN_PROFIT_BPS);
    return {
      halted: this.risk.halted,
      haltedBecause: this.risk.haltedBecause,
      tradesLastHour: this.risk.tradesLastHour,
      failureStreak: this.risk.failureStreak,
      dailyPnlSol: lamportsToSol(this.risk.dailyPnlLamports),
      costPerAttemptSol: lamportsToSol(costs.totalLamports),
      breakEvenSizeSol: breakEven === null ? null : lamportsToSol(breakEven),
      tradeSizeSol: this.cfg.ARB_TRADE_SIZE_SOL,
      minProfitBps: this.cfg.ARB_MIN_PROFIT_BPS,
      bestBps: this.stats.bestBps,
      quoteErrors: this.stats.quoteErrors,
      rateLimited: this.client.rateLimited,
      lastScanAt: this.lastScanAt,
      lastScanMs: this.lastScanMs,
      tokens: this.tokens().map((t) => t.symbol),
      strategies: this.strategies(),
      routesPriced: this.routesPriced,
      rejectCounts: Object.fromEntries(
        [...this.rejectCounts].sort((a, b) => b[1] - a[1]),
      ),
      edgeBuckets: EDGE_BUCKETS.map((key) => ({ key, count: this.edgeBuckets.get(key) ?? 0 })),
      routes: this.lastEvaluated.slice(0, 12).map((e) => ({
        route: e.route,
        symbol: e.quoteSymbol,
        strategy: e.strategy,
        bps: e.netProfitBps,
        impactPct: e.maxPriceImpactPct * 100,
        reason: e.rejectReason,
      })),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal).catch((err) =>
      log.error(`arbitrage loop died: ${errMessage(err)}`),
    );
    log.info(
      `Arbitrage started — ${this.cfg.ARB_TRADE_SIZE_SOL} SOL per attempt across ` +
        `${this.tokens().length} tokens, floor ${this.cfg.ARB_MIN_PROFIT_BPS}bps`,
    );
    this.warnAboutBreakEven();
  }

  stop(): void {
    this.started = false;
    this.abort?.abort();
    this.abort = null;
  }

  /** Nothing to tick: the arb loop drives itself. Kept for the bot interface. */
  async tickPositions(): Promise<void> {}
  async tickStrategy(): Promise<void> {}

  // ---- the loop --------------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.started) {
      if (!this.pausedFlag) {
        try {
          await this.tick(signal);
        } catch (err) {
          log.error(`scan cycle failed: ${errMessage(err)}`);
        }
      }
      await sleep(this.cfg.ARB_POLL_INTERVAL_MS);
    }
  }

  /** One scan, and at most one trade. Exposed so tests can drive it directly. */
  async tick(signal?: AbortSignal): Promise<ArbTradeResult | null> {
    // Limits are re-read every cycle so a dashboard edit lands without a restart.
    this.risk.setLimits(this.limits());

    let scan: ScanResult;
    try {
      scan = await this.scanner().scan(signal);
    } catch (err) {
      log.error(`scan failed: ${errMessage(err)}`);
      return null;
    }

    this.stats.scans += 1;
    this.stats.quotesFetched += scan.quotesFetched;
    this.stats.evaluated += scan.evaluated.length;
    this.stats.opportunitiesSeen += scan.opportunities.length;
    this.stats.quoteErrors += scan.errors.length;
    this.lastEvaluated = scan.evaluated;
    this.lastScanAt = this.now();
    this.lastScanMs = scan.durationMs;

    for (const route of scan.evaluated) {
      this.routesPriced += 1;
      const reason = categoriseReject(route.rejectReason);
      this.rejectCounts.set(reason, (this.rejectCounts.get(reason) ?? 0) + 1);
      const bucket = edgeBucket(route.netProfitBps);
      this.edgeBuckets.set(bucket, (this.edgeBuckets.get(bucket) ?? 0) + 1);
    }

    const best = scan.evaluated[0];
    if (best && best.netProfitBps > this.stats.bestBps) this.stats.bestBps = best.netProfitBps;

    // Only the single best opportunity is acted on. Firing several from one
    // snapshot means competing with yourself for the same pool liquidity, which
    // turns a modelled edge into realised slippage.
    const candidate = scan.opportunities[0];
    if (!candidate) return null;

    return this.attempt(candidate);
  }

  private async attempt(opportunity: Opportunity): Promise<ArbTradeResult | null> {
    const decision = this.risk.check(opportunity, this.balanceLamports());
    if (!decision.allowed) {
      log.info(`Arb trade blocked — ${decision.reason}`);
      return null;
    }

    this.risk.recordAttempt();
    this.stats.tradesAttempted += 1;

    let result: ArbTradeResult;
    try {
      result = await this.executor.execute(opportunity);
    } catch (err) {
      log.error(`arb executor threw: ${errMessage(err)}`);
      this.stats.tradesFailed += 1;
      return null;
    }

    if (result.status === 'filled') this.stats.tradesFilled += 1;
    else this.stats.tradesFailed += 1;

    this.risk.record(result);
    this.journal(result);
    return result;
  }

  /**
   * Writes the round trip to the shared journal.
   *
   * This is the whole integration. The auto-tuner reads `Store.journal()` per
   * bot and knows nothing about arbitrage, so recording results in the shared
   * shape is what puts this strategy inside the same measure-and-revert loop as
   * the others. The entry note carries the arb-specific numbers — edge, impact,
   * quote age, size — so the tuner can bucket by them exactly as it buckets the
   * sniper's launch characteristics.
   */
  private journal(result: ArbTradeResult): void {
    const costSol = lamportsToSol(result.amountIn);
    const pnlSol = lamportsToSol(result.realisedProfit);

    this.store.appendJournal({
      positionId: result.opportunityId,
      mint: result.quoteMint,
      symbol: result.quoteSymbol,
      // Not a deployer — an arb trade has none. The venue pair is the closest
      // thing to a counterparty identity, and it is what a losing route has in
      // common with the next one.
      creator: result.route,
      openedAt: result.startedAt,
      closedAt: result.finishedAt,
      costSol,
      proceedsSol: lamportsToSol(result.amountOut),
      pnlSol,
      pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : 0,
      closeReason:
        result.status === 'filled'
          ? `arb_filled: ${result.expectedBps.toFixed(1)}bps expected`
          : `arb_${result.status.replace('-', '_')}: ${result.error ?? 'unknown'}`,
      // Arb has no safety battery. 100 rather than 0 so it does not read as a
      // failed safety check on the shared trade table.
      safetyScore: 100,
      holdSeconds: Math.max(0, (result.finishedAt - result.startedAt) / 1000),
      entryNote: arbNote(result),
    });
    this.store.recordRealisedPnl(pnlSol);
  }

  // ---- configuration ---------------------------------------------------

  private scanner(): Scanner {
    return new Scanner({
      client: this.client,
      baseToken: WSOL,
      candidateTokens: this.tokens(),
      tradeSize: solToLamports(this.cfg.ARB_TRADE_SIZE_SOL),
      slippageBps: this.cfg.ARB_SLIPPAGE_BPS,
      minProfitBps: this.cfg.ARB_MIN_PROFIT_BPS,
      maxPriceImpactPct: this.cfg.ARB_MAX_PRICE_IMPACT_PCT,
      priorityFeeMicroLamports: this.cfg.ARB_PRIORITY_FEE_MICROLAMPORTS,
      computeUnitLimit: this.cfg.ARB_COMPUTE_UNIT_LIMIT,
      assumeAtaCreation: this.cfg.ARB_ASSUME_ATA_RENT,
      quoteMaxAgeMs: this.cfg.ARB_QUOTE_MAX_AGE_MS,
      requireWorstCaseProfit: this.cfg.ARB_REQUIRE_WORST_CASE,
      strategies: this.strategies(),
      venues: splitList(this.cfg.ARB_VENUES),
      now: this.now,
    });
  }

  private limits() {
    return {
      maxDailyLossLamports: solToLamports(this.cfg.ARB_MAX_DAILY_LOSS_SOL),
      maxConsecutiveFailures: this.cfg.ARB_MAX_CONSECUTIVE_FAILURES,
      routeCooldownMs: this.cfg.ARB_ROUTE_COOLDOWN_MS,
      maxTradesPerHour: this.cfg.ARB_MAX_TRADES_PER_HOUR,
      minReserveLamports: solToLamports(this.cfg.ARB_MIN_RESERVE_SOL),
      tradeSizeLamports: solToLamports(this.cfg.ARB_TRADE_SIZE_SOL),
    };
  }

  private tokens(): Token[] {
    const out: Token[] = [];
    for (const reference of splitList(this.cfg.ARB_TOKENS)) {
      try {
        const token = resolveToken(reference);
        // SOL -> SOL is not a cycle, and the aggregator refuses it outright.
        if (token.mint !== WSOL.mint) out.push(token);
      } catch (err) {
        log.warn(`Ignoring ARB_TOKENS entry "${reference}": ${errMessage(err)}`);
      }
    }
    return out;
  }

  private strategies(): ArbStrategy[] {
    const wanted = splitList(this.cfg.ARB_STRATEGIES).map((s) => s.toLowerCase());
    const out = wanted.filter((s): s is ArbStrategy => s === 'cycle' || s === 'cross-dex');
    return out.length > 0 ? out : ['cycle'];
  }

  /** Paper balance: the configured start plus whatever trading has done to it. */
  private balanceLamports(): bigint {
    return solToLamports(this.cfg.PAPER_STARTING_BALANCE_SOL) + this.executor.drift;
  }

  /**
   * Says out loud when the configured size cannot clear its own fees.
   *
   * Below the break-even size the bot loses money on winning trades, and that is
   * invisible in a log of individually plausible near-misses.
   */
  private warnAboutBreakEven(): void {
    const costs = this.scanner().cycleCosts;
    const needed = breakEvenSize(costs.totalLamports, this.cfg.ARB_MIN_PROFIT_BPS);
    if (needed === null) return;

    const size = solToLamports(this.cfg.ARB_TRADE_SIZE_SOL);
    const cost = fromBaseUnits(costs.totalLamports, 9, 6);
    if (size < needed) {
      log.warn(
        `ARB_TRADE_SIZE_SOL is ${this.cfg.ARB_TRADE_SIZE_SOL} but a ` +
          `${this.cfg.ARB_MIN_PROFIT_BPS}bps edge needs at least ` +
          `${fromBaseUnits(needed, 9, 6)} SOL to cover ${cost} SOL of fees. ` +
          'Below that the strategy loses money on winning trades.',
      );
    } else {
      log.info(
        `Arb cost per attempt ${cost} SOL; break-even size at ` +
          `${this.cfg.ARB_MIN_PROFIT_BPS}bps is ${fromBaseUnits(needed, 9, 6)} SOL.`,
      );
    }
  }
}

export interface ArbView {
  halted: boolean;
  haltedBecause: string | null;
  tradesLastHour: number;
  failureStreak: number;
  dailyPnlSol: number;
  costPerAttemptSol: number;
  breakEvenSizeSol: number | null;
  tradeSizeSol: number;
  minProfitBps: number;
  bestBps: number;
  quoteErrors: number;
  rateLimited: number;
  lastScanAt: number;
  lastScanMs: number;
  tokens: string[];
  strategies: string[];
  /** Routes priced this session, whether they cleared or not. */
  routesPriced: number;
  /** Why they were turned down, commonest first. */
  rejectCounts: Record<string, number>;
  /** How big the edges actually were — the reading the floor is set from. */
  edgeBuckets: Array<{ key: string; count: number }>;
  routes: Array<{
    route: string;
    symbol: string;
    strategy: string;
    bps: number;
    impactPct: number;
    reason: string | null;
  }>;
}

/**
 * The arb-specific numbers, in the shared entry-note format.
 *
 * Same idea as the sniper's `snipe:` note: the journal records outcomes, and
 * without the conditions that produced them the tuner is choosing between
 * equally plausible knobs. Each field here maps onto one parameter.
 */
export function arbNote(result: ArbTradeResult): string {
  return [
    'arb:',
    `${result.expectedBps.toFixed(1)}bps edge,`,
    `${lamportsToSol(result.amountIn).toFixed(4)} SOL size,`,
    `${(result.maxPriceImpactPct * 100).toFixed(3)}% impact,`,
    `${Math.round(result.quoteAgeMs)}ms quote age,`,
    `${result.strategy}`,
  ].join(' ');
}

/**
 * Edge bands, chosen to straddle the decision.
 *
 * The question this exists to answer is "where does the floor belong", so the
 * bands bracket the default of 30bps rather than being evenly spaced.
 */
export const EDGE_BUCKETS = ['<0', '0-5', '5-10', '10-20', '20-30', '30+'] as const;

export function edgeBucket(bps: number): string {
  if (bps < 0) return '<0';
  if (bps < 5) return '0-5';
  if (bps < 10) return '5-10';
  if (bps < 20) return '10-20';
  if (bps < 30) return '20-30';
  return '30+';
}

/**
 * Collapses a reject reason to the gate that produced it.
 *
 * The raw strings carry the specific numbers, which is right for one row and
 * useless for a tally — "edge 4.21bps below floor 30bps" and "edge 4.19bps
 * below floor 30bps" are the same finding twice.
 */
export function categoriseReject(reason: string | null): string {
  if (reason === null) return 'cleared';
  if (reason.includes('below floor')) return 'below the min edge';
  if (reason.includes('negative net edge')) return 'negative after fees';
  if (reason.includes('price impact')) return 'price impact too high';
  if (reason.includes('worst case')) return 'worst case unprofitable';
  if (reason.includes('stale')) return 'quotes went stale';
  return 'other';
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function solToLamports(sol: number): bigint {
  return toBaseUnits(sol, 9);
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}
