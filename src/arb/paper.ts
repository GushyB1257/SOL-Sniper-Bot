import { logger } from '../logger.js';
import { applyBpsDiscount } from './decimal.js';
import { describeRoute } from './scanner.js';
import type { ArbTradeResult, LegFill, Opportunity } from './types.js';

const log = logger('arb:paper');

export interface PaperArbOptions {
  /** Additional adverse slippage applied to each leg, in bps. */
  adverseSlippageBps: number;
  /** Probability in [0,1] that a leg fails to land at all. */
  legFailureRate: number;
  /**
   * What the intermediate token is worth when leg two never lands, as a share
   * of what leg one paid for it. Below 1 because the reason leg two failed is
   * usually that the price moved against us.
   */
  unwindRecoveryPct: number;
  /** Injectable RNG so simulations are reproducible in tests. */
  random?: () => number;
  now?: () => number;
}

/**
 * Simulated arbitrage executor.
 *
 * Its job is to be pessimistic, not optimistic. A paper run that assumes quoted
 * prices are achievable and every transaction lands reports an edge that does
 * not survive contact with mainnet, and that is precisely how people talk
 * themselves into funding a losing bot.
 *
 * Three frictions are modelled, and the third is the one the original omitted:
 *
 *  1. **Adverse fill slippage** — the quote is not the fill.
 *  2. **Outright landing failure** — the transaction was included and paid its
 *     fee, but did not execute.
 *  3. **A half-completed round trip.** Leg one lands, leg two does not, and the
 *     bot is left holding the intermediate token at whatever it is now worth.
 *     The original simulator could only produce "nothing happened" or "both legs
 *     filled", so its worst modelled outcome was losing the fees — which
 *     understates the strategy's real risk by the size of the whole position.
 *     A two-leg cycle is not atomic; this is the outcome that makes it dangerous.
 */
export class PaperArbExecutor {
  readonly mode = 'paper' as const;

  private readonly random: () => number;
  private readonly now: () => number;
  /** Net lamports moved by simulated trades. See ArbBot for the balance. */
  private driftLamports = 0n;

  constructor(private readonly options: PaperArbOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  get drift(): bigint {
    return this.driftLamports;
  }

  async execute(opportunity: Opportunity): Promise<ArbTradeResult> {
    const startedAt = this.now();
    const route = describeRoute(opportunity.baseToken, opportunity.quoteToken, opportunity.legs);
    const cost = opportunity.costLamports;

    const base = {
      opportunityId: opportunity.id,
      strategy: opportunity.strategy,
      route,
      quoteSymbol: opportunity.quoteToken.symbol,
      quoteMint: opportunity.quoteToken.mint,
      amountIn: opportunity.amountIn,
      costLamports: cost,
      expectedProfit: opportunity.netProfit,
      expectedBps: opportunity.netProfitBps,
      maxPriceImpactPct: opportunity.maxPriceImpactPct,
      quoteAgeMs: opportunity.quoteAgeMs,
      startedAt,
    };

    const fills: LegFill[] = [];
    let carried = opportunity.amountIn;

    for (let index = 0; index < opportunity.legs.length; index += 1) {
      const leg = opportunity.legs[index]!;

      if (this.random() < this.options.legFailureRate) {
        // Leg one never landed: we paid the fee and nothing else happened.
        if (index === 0) {
          this.driftLamports -= cost;
          log.warn(`PAPER ARB FAILED ${route} — leg 1 did not land, -${cost} lamports`);
          return {
            ...base,
            status: 'failed',
            amountOut: 0n,
            realisedProfit: -cost,
            fills,
            finishedAt: this.now(),
            error: 'simulated: leg 1 did not land',
          };
        }

        // Leg two never landed, so we are holding `carried` of the intermediate
        // token. Value it below what we paid: the reason the leg failed is
        // usually that the price moved, and it moved against us.
        const recovered = applyBpsDiscount(
          opportunity.amountIn,
          Math.round((1 - clamp01(this.options.unwindRecoveryPct / 100)) * 10_000),
        );
        const realised = recovered - opportunity.amountIn - cost;
        this.driftLamports += realised;
        log.warn(
          `PAPER ARB PARTIAL ${route} — leg 2 did not land, holding ` +
            `${opportunity.quoteToken.symbol}, realised ${realised} lamports`,
        );
        return {
          ...base,
          status: 'partial-unwound',
          amountOut: recovered,
          realisedProfit: realised,
          fills,
          finishedAt: this.now(),
          error: `simulated: leg 2 did not land, unwound ${opportunity.quoteToken.symbol} at ${this.options.unwindRecoveryPct}%`,
        };
      }

      const modelled = applyBpsDiscount(
        scaleOutput(leg.outAmount, leg.inAmount, carried),
        this.options.adverseSlippageBps,
      );
      fills.push({
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        inAmount: carried,
        outAmount: modelled,
        signature: null,
      });
      carried = modelled;
    }

    const realisedProfit = carried - opportunity.amountIn - cost;
    this.driftLamports += realisedProfit;

    log.info(
      `PAPER ARB FILLED ${route} — expected ${opportunity.netProfit} realised ${realisedProfit} lamports`,
    );
    return {
      ...base,
      status: 'filled',
      amountOut: carried,
      realisedProfit,
      fills,
      finishedAt: this.now(),
    };
  }
}

/**
 * Rescale a quoted output to a different input size.
 *
 * Linear scaling understates price impact for larger inputs, so this is only
 * sound because the carried amount is always at or below what was quoted — each
 * leg discounts it further.
 */
function scaleOutput(quotedOut: bigint, quotedIn: bigint, actualIn: bigint): bigint {
  if (quotedIn === 0n) return 0n;
  if (actualIn === quotedIn) return quotedOut;
  return (quotedOut * actualIn) / quotedIn;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
