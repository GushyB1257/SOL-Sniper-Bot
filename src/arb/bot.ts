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
