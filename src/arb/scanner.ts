import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import type { JupiterClient } from './jupiter.js';
import { estimateCosts, evaluateCycle, type CostBreakdown } from './profit.js';
import type { ArbStrategy, Opportunity, Quote, Token } from './types.js';

const log = logger('arb:scan');

/** Venues quoted independently by the cross-dex strategy. */
export const DEFAULT_VENUES = ['Orca V2', 'Raydium', 'Meteora DLMM'] as const;

export interface ScannerOptions {
  client: JupiterClient;
  baseToken: Token;
  candidateTokens: readonly Token[];
  tradeSize: bigint;
  slippageBps: number;
  minProfitBps: number;
  maxPriceImpactPct: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  assumeAtaCreation: boolean;
  quoteMaxAgeMs: number;
  requireWorstCaseProfit: boolean;
  strategies: readonly ArbStrategy[];
  venues?: readonly string[];
  now?: () => number;
}

export interface EvaluatedCycle {
  readonly strategy: ArbStrategy;
  readonly route: string;
  readonly quoteSymbol: string;
  readonly netProfitBps: number;
  readonly netProfit: bigint;
  readonly maxPriceImpactPct: number;
  readonly rejectReason: string | null;
}

export interface ScanResult {
  readonly opportunities: readonly Opportunity[];
  /** Every evaluated cycle, rejects included. The rejects are the useful part. */
  readonly evaluated: readonly EvaluatedCycle[];
  readonly quotesFetched: number;
  readonly errors: readonly string[];
  readonly durationMs: number;
}

/**
 * Prices closed loops and reports which ones clear the floor.
 *
 * Routes are evaluated SEQUENTIALLY, not in parallel. The original ran them all
 * at once, which is the right shape for a paid endpoint and the wrong one here:
 * the free Jupiter tier meters per second, so a fan-out earns a wall of 429s and
 * the scan finishes slower than if it had queued. The client paces requests, and
 * fanning out just queues them somewhere less visible.
 */
export class Scanner {
  private readonly now: () => number;
  private quotesFetched = 0;

  constructor(private readonly options: ScannerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Cost model for a two-leg cycle, held constant across a scan. */
  get cycleCosts(): CostBreakdown {
    return estimateCosts({
      legs: 2,
      priorityFeeMicroLamports: this.options.priorityFeeMicroLamports,
      computeUnitLimit: this.options.computeUnitLimit,
      includeAtaRent: this.options.assumeAtaCreation,
    });
  }

  async scan(signal?: AbortSignal): Promise<ScanResult> {
    const startedAt = this.now();
    this.quotesFetched = 0;

    const errors: string[] = [];
    const evaluated: EvaluatedCycle[] = [];
    const opportunities: Opportunity[] = [];

    for (const token of this.options.candidateTokens) {
      for (const strategy of this.options.strategies) {
        if (signal?.aborted) break;
        try {
          const outcome = await this.evaluateToken(strategy, token, signal);
          if (!outcome) continue;
          evaluated.push(outcome.summary);
          if (outcome.opportunity) opportunities.push(outcome.opportunity);
        } catch (err) {
          errors.push(`${strategy} ${token.symbol}: ${errMessage(err)}`);
          log.debug(`route evaluation failed for ${token.symbol}: ${errMessage(err)}`);
        }
      }
    }

    opportunities.sort((a, b) => b.netProfitBps - a.netProfitBps);
    evaluated.sort((a, b) => b.netProfitBps - a.netProfitBps);

    return {
      opportunities,
      evaluated,
      quotesFetched: this.quotesFetched,
      errors,
      durationMs: this.now() - startedAt,
    };
  }

  private async evaluateToken(
    strategy: ArbStrategy,
    token: Token,
    signal?: AbortSignal,
  ): Promise<{ summary: EvaluatedCycle; opportunity: Opportunity | null } | null> {
    const legs =
      strategy === 'cycle'
        ? await this.quoteCycle(token, signal)
        : await this.quoteCrossDex(token, signal);
    if (!legs) return null;

    const evaluation = evaluateCycle({
      baseToken: this.options.baseToken,
      legs,
      costs: this.cycleCosts,
      minProfitBps: this.options.minProfitBps,
      maxPriceImpactPct: this.options.maxPriceImpactPct,
      requireWorstCaseProfit: this.options.requireWorstCaseProfit,
    });

    const route = describeRoute(this.options.baseToken, token, legs);
    const quoteAgeMs = this.stalenessMs(legs);

    // Staleness is checked BEFORE the profit verdict is trusted, not after. A
    // quote that aged out while its sibling leg was in flight priced against
    // pool state that is already gone — and on the free tier, where legs are
    // more than a second apart, that is the common case rather than the rare one.
    const stale = quoteAgeMs > this.options.quoteMaxAgeMs;

    const summary: EvaluatedCycle = {
      strategy,
      route,
      quoteSymbol: token.symbol,
      netProfitBps: evaluation.netProfitBps,
      netProfit: evaluation.netProfit,
      maxPriceImpactPct: evaluation.maxPriceImpactPct,
      rejectReason: stale
        ? `quote stale by ${quoteAgeMs - this.options.quoteMaxAgeMs}ms`
        : evaluation.rejectReason,
    };

    if (stale || !evaluation.profitable) {
      log.debug(
        `${route} rejected — ${summary.rejectReason} (${evaluation.netProfitBps.toFixed(2)}bps)`,
      );
      return { summary, opportunity: null };
    }

    const opportunity: Opportunity = {
      id: randomUUID(),
      strategy,
      baseToken: this.options.baseToken,
      quoteToken: token,
      legs,
      amountIn: evaluation.amountIn,
      grossOut: evaluation.grossOut,
      costLamports: evaluation.costLamports,
      netProfit: evaluation.netProfit,
      netProfitBps: evaluation.netProfitBps,
      worstCaseNetProfit: evaluation.worstCaseNetProfit,
      maxPriceImpactPct: evaluation.maxPriceImpactPct,
      quoteAgeMs,
      discoveredAt: this.now(),
    };

    log.info(`OPPORTUNITY ${route} — ${evaluation.netProfitBps.toFixed(2)}bps net`);
    return { summary, opportunity };
  }

  /** SOL -> token -> SOL, letting the aggregator route each leg freely. */
  private async quoteCycle(token: Token, signal?: AbortSignal): Promise<Quote[] | null> {
    const outbound = await this.quote({
      inputMint: this.options.baseToken.mint,
      outputMint: token.mint,
      amount: this.options.tradeSize,
      signal,
    });
    if (outbound.outAmount <= 0n) return null;

    const inbound = await this.quote({
      inputMint: token.mint,
      outputMint: this.options.baseToken.mint,
      amount: outbound.outAmount,
      signal,
    });
    return [outbound, inbound];
  }

  /**
   * Quote each leg on individual venues and keep the best of each.
   *
   * This finds genuine cross-venue dislocations that a single aggregated route
   * hides, because the aggregator has already netted them out internally. It
   * costs one quote per venue per leg, so it is the expensive strategy.
   */
  private async quoteCrossDex(token: Token, signal?: AbortSignal): Promise<Quote[] | null> {
    const venues = this.options.venues ?? DEFAULT_VENUES;

    const outbound = await this.bestAcrossVenues(
      { inputMint: this.options.baseToken.mint, outputMint: token.mint, amount: this.options.tradeSize },
      venues,
      signal,
    );
    if (!outbound || outbound.outAmount <= 0n) return null;

    const inbound = await this.bestAcrossVenues(
      { inputMint: token.mint, outputMint: this.options.baseToken.mint, amount: outbound.outAmount },
      venues,
      signal,
    );
    if (!inbound) return null;

    return [outbound, inbound];
  }

  private async bestAcrossVenues(
    leg: { inputMint: string; outputMint: string; amount: bigint },
    venues: readonly string[],
    signal?: AbortSignal,
  ): Promise<Quote | null> {
    let best: Quote | null = null;
    for (const venue of venues) {
      if (signal?.aborted) break;
      try {
        const quote = await this.quote({ ...leg, dexes: [venue], onlyDirectRoutes: true, signal });
        if (!best || quote.outAmount > best.outAmount) best = quote;
      } catch {
        // A venue with no pool for this pair is the normal case, not an error.
      }
    }
    return best;
  }

  private async quote(request: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    dexes?: readonly string[];
    onlyDirectRoutes?: boolean;
    signal?: AbortSignal;
  }): Promise<Quote> {
    this.quotesFetched += 1;
    return this.options.client.quote({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      slippageBps: this.options.slippageBps,
      dexes: request.dexes,
      onlyDirectRoutes: request.onlyDirectRoutes,
      signal: request.signal,
    });
  }

  private stalenessMs(legs: readonly Quote[]): number {
    const oldest = Math.min(...legs.map((leg) => leg.fetchedAt));
    return this.now() - oldest;
  }
}

export function describeRoute(
  baseToken: Token,
  quoteToken: Token,
  legs: readonly Quote[],
): string {
  const venues = legs.map((leg) => (leg.marketLabels.length > 0 ? leg.marketLabels.join('+') : 'agg'));
  return `${baseToken.symbol} -${venues[0] ?? '?'}-> ${quoteToken.symbol} -${venues[1] ?? '?'}-> ${baseToken.symbol}`;
}
