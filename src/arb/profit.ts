import { toBps } from './decimal.js';
import type { Quote, Token } from './types.js';

/** Solana charges a flat 5000 lamports per signature. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Rent-exempt minimum for a 165-byte SPL token account. */
export const ATA_RENT_LAMPORTS = 2_039_280n;

export interface CostInputs {
  /** Transactions the strategy submits — one per swap leg. */
  legs: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  /** Charge one-off rent for an intermediate token account. */
  includeAtaRent: boolean;
  signaturesPerTransaction?: number;
}

export interface CostBreakdown {
  readonly baseFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly rentLamports: bigint;
  readonly totalLamports: bigint;
}

/**
 * Transaction cost for a multi-leg strategy.
 *
 * Both legs of a cycle are separate transactions — the aggregator rejects a
 * quote whose input and output mint match — so fees are charged per leg, not
 * once for the round trip. Halving this is the single most common reason a
 * "profitable" scanner loses money in production.
 */
export function estimateCosts(inputs: CostInputs): CostBreakdown {
  if (!Number.isInteger(inputs.legs) || inputs.legs < 1) {
    throw new RangeError(`legs must be a positive integer, got ${inputs.legs}`);
  }

  const legs = BigInt(inputs.legs);
  const signatures = BigInt(inputs.signaturesPerTransaction ?? 1);
  const baseFeeLamports = LAMPORTS_PER_SIGNATURE * signatures * legs;

  // Priority fee is quoted in micro-lamports per compute unit.
  const perLeg = BigInt(
    Math.ceil((inputs.priorityFeeMicroLamports * inputs.computeUnitLimit) / 1_000_000),
  );
  const priorityFeeLamports = perLeg * legs;
  const rentLamports = inputs.includeAtaRent ? ATA_RENT_LAMPORTS : 0n;

  return {
    baseFeeLamports,
    priorityFeeLamports,
    rentLamports,
    totalLamports: baseFeeLamports + priorityFeeLamports + rentLamports,
  };
}

export interface CycleEvaluation {
  readonly amountIn: bigint;
  readonly grossOut: bigint;
  readonly costLamports: bigint;
  readonly netProfit: bigint;
  readonly netProfitBps: number;
  readonly worstCaseOut: bigint;
  readonly worstCaseNetProfit: bigint;
  readonly maxPriceImpactPct: number;
  readonly profitable: boolean;
  readonly rejectReason: string | null;
}

export interface EvaluateCycleParams {
  readonly baseToken: Token;
  readonly legs: readonly Quote[];
  readonly costs: CostBreakdown;
  readonly minProfitBps: number;
  readonly maxPriceImpactPct: number;
  /**
   * Require the WORST case to clear the floor too, not just the expected case.
   *
   * The expected output is what the pool would pay if nothing moves; the
   * `otherAmountThreshold` is what the swap will actually accept on-chain. On a
   * thin route those differ by more than the whole edge, which means a trade
   * that is modelled profitable can only ever land at a loss.
   */
  readonly requireWorstCaseProfit?: boolean;
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Evaluate a closed cycle.
 *
 * Returns a verdict rather than throwing, so the scanner can log near-misses —
 * the distribution of REJECTED edges is the most useful thing here. A run that
 * only records what it traded cannot tell you whether the floor is set in the
 * right place.
 */
export function evaluateCycle(params: EvaluateCycleParams): CycleEvaluation {
  const { baseToken, legs, costs, minProfitBps, maxPriceImpactPct } = params;

  if (legs.length === 0) throw new Error('cycle must contain at least one leg');

  const first = legs[0]!;
  const last = legs[legs.length - 1]!;

  if (first.inputMint !== baseToken.mint) {
    throw new Error(`cycle must start in ${baseToken.symbol}, starts in ${first.inputMint}`);
  }
  if (last.outputMint !== baseToken.mint) {
    throw new Error(`cycle must end in ${baseToken.symbol}, ends in ${last.outputMint}`);
  }
  for (let index = 1; index < legs.length; index += 1) {
    if (legs[index - 1]!.outputMint !== legs[index]!.inputMint) {
      throw new Error(`cycle legs are not contiguous at index ${index}`);
    }
  }
  if (baseToken.mint !== WSOL_MINT) {
    // Costs are incurred in SOL whatever we trade, so a non-SOL base would need
    // a conversion this bot has no price source for. Refuse rather than guess.
    throw new Error(`base token must be SOL, got ${baseToken.symbol}`);
  }

  const amountIn = first.inAmount;
  const grossOut = last.outAmount;

  const netProfit = grossOut - amountIn - costs.totalLamports;
  const netProfitBps = toBps(netProfit, amountIn);

  const worstCaseOut = last.otherAmountThreshold;
  const worstCaseNetProfit = worstCaseOut - amountIn - costs.totalLamports;

  const maxImpact = legs.reduce((peak, leg) => Math.max(peak, leg.priceImpactPct), 0);

  let rejectReason: string | null = null;
  if (netProfit <= 0n) {
    rejectReason = 'negative net edge after costs';
  } else if (netProfitBps < minProfitBps) {
    rejectReason = `edge ${netProfitBps.toFixed(2)}bps below floor ${minProfitBps}bps`;
  } else if (maxImpact > maxPriceImpactPct / 100) {
    rejectReason = `price impact ${(maxImpact * 100).toFixed(3)}% exceeds ${maxPriceImpactPct}%`;
  } else if (params.requireWorstCaseProfit && worstCaseNetProfit <= 0n) {
    rejectReason =
      `worst case loses ${(-worstCaseNetProfit).toString()} lamports — ` +
      'the slippage tolerance is wider than the edge';
  }

  return {
    amountIn,
    grossOut,
    costLamports: costs.totalLamports,
    netProfit,
    netProfitBps,
    worstCaseOut,
    worstCaseNetProfit,
    maxPriceImpactPct: maxImpact,
    profitable: rejectReason === null,
    rejectReason,
  };
}

/**
 * Break-even trade size given a fixed cost and an expected edge.
 *
 * Fees are constant per attempt while the edge scales with size, so below this
 * threshold the strategy is structurally unprofitable no matter how good the
 * routing is — the bot loses money on WINNING trades. This is the number to
 * check before funding anything. Returns lamports, or null if the edge is not
 * positive.
 */
export function breakEvenSize(costLamports: bigint, edgeBps: number): bigint | null {
  if (edgeBps <= 0) return null;
  return (costLamports * 10_000n) / BigInt(Math.round(edgeBps));
}
