/**
 * Domain types for the arbitrage bot.
 *
 * Every monetary amount here is a `bigint` in the token's smallest base unit
 * (lamports for SOL, 1e-6 for USDC). Amounts never touch `number` except at the
 * display boundary. The rest of this codebase uses SOL-denominated `number`,
 * which is fine for a position whose size is a config value — but an arbitrage
 * edge is measured in basis points on a round trip, and float error at that
 * scale is the same order as the edge being measured.
 */

export interface Token {
  /** SPL mint address (base58). */
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** A single swap leg quoted by an aggregator. */
export interface Quote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  /** Expected output before slippage. */
  readonly outAmount: bigint;
  /** Worst-case output the aggregator will accept on-chain. */
  readonly otherAmountThreshold: bigint;
  /** Aggregate price impact across the route, as a fraction (0.01 = 1%). */
  readonly priceImpactPct: number;
  readonly slippageBps: number;
  /** Human-readable venue labels, in route order, e.g. ["Orca", "Meteora"]. */
  readonly marketLabels: readonly string[];
  /** Milliseconds since epoch when this quote was received. */
  readonly fetchedAt: number;
}

export type ArbStrategy = 'cycle' | 'cross-dex';

/** A closed loop that starts and ends in the same mint. */
export interface Opportunity {
  readonly id: string;
  readonly strategy: ArbStrategy;
  /** The mint we start and end in — always SOL here. */
  readonly baseToken: Token;
  /** The asset we route through. */
  readonly quoteToken: Token;
  readonly legs: readonly Quote[];
  readonly amountIn: bigint;
  /** Expected base units returned, before transaction costs. */
  readonly grossOut: bigint;
  readonly costLamports: bigint;
  /** grossOut - amountIn - costLamports. May be negative. */
  readonly netProfit: bigint;
  readonly netProfitBps: number;
  /** Worst-case out across both legs' on-chain minimums. */
  readonly worstCaseNetProfit: bigint;
  readonly maxPriceImpactPct: number;
  /** How stale the oldest leg was when the opportunity was formed. */
  readonly quoteAgeMs: number;
  readonly discoveredAt: number;
}

/**
 * `partial-unwound` is the one that matters, and the one a naive simulator
 * never produces: leg one landed, leg two did not, and the bot is holding the
 * intermediate token at whatever it is worth now. A two-leg cycle is not
 * atomic, so this is a real outcome rather than a theoretical one.
 */
export type ArbFillStatus = 'filled' | 'failed' | 'partial-unwound';

export interface LegFill {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  /** Actual amount received. Modelled, not observed, in paper mode. */
  readonly outAmount: bigint;
  readonly signature: string | null;
}

export interface ArbTradeResult {
  readonly opportunityId: string;
  readonly strategy: ArbStrategy;
  readonly route: string;
  readonly quoteSymbol: string;
  readonly quoteMint: string;
  readonly status: ArbFillStatus;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Realised profit in lamports, net of all costs. Negative on a loss. */
  readonly realisedProfit: bigint;
  readonly costLamports: bigint;
  /** The edge the scanner expected, so realised-vs-modelled can be compared. */
  readonly expectedProfit: bigint;
  readonly expectedBps: number;
  readonly maxPriceImpactPct: number;
  readonly quoteAgeMs: number;
  readonly fills: readonly LegFill[];
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly error?: string;
}

export interface ArbStats {
  scans: number;
  quotesFetched: number;
  /** Routes priced, whether they cleared the floor or not. */
  evaluated: number;
  opportunitiesSeen: number;
  tradesAttempted: number;
  tradesFilled: number;
  tradesFailed: number;
  /** Best net edge seen this session, in bps. Can be negative. */
  bestBps: number;
  /** Quotes refused by the rate limiter or the aggregator. */
  quoteErrors: number;
  startedAt: number;
}
