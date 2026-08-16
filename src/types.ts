/** Shared domain types. */

/** Venue a token trades on. Mirrors PumpPortal's `pool` parameter. */
export type Pool =
  | 'pump'
  | 'pump-amm'
  | 'raydium'
  | 'raydium-cpmm'
  | 'launchlab'
  | 'bonk'
  | 'auto';

/** A freshly-detected launch, before any safety work has been done. */
export interface TokenCandidate {
  mint: string;
  creator: string;
  name?: string;
  symbol?: string;
  uri?: string;
  pool: Pool;
  signature?: string;
  bondingCurveKey?: string;
  /** SOL the deployer spent in the creation transaction. */
  initialBuySol?: number;
  /** Tokens the deployer received in the creation transaction. */
  initialBuyTokens?: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  /** ms epoch at which *we* saw it, not when it was minted. */
  detectedAt: number;
  source: string;
}

export type CheckSeverity = 'fatal' | 'major' | 'minor';

/** Result of a single safety check. */
export interface CheckResult {
  id: string;
  passed: boolean;
  severity: CheckSeverity;
  /** Points deducted from 100 when the check fails. Ignored for `fatal`. */
  penalty: number;
  detail: string;
  /** Set when the check could not complete (RPC error, timeout, ...). */
  errored?: boolean;
}

export interface SafetyVerdict {
  score: number;
  passed: boolean;
  results: CheckResult[];
  /** Which check vetoed the buy, if any. */
  rejectedBy?: string;
  elapsedMs: number;
}

export type PositionStatus = 'open' | 'closing' | 'closed' | 'failed';

/** One take-profit rung. */
export interface LadderTier {
  /** Trigger: percent gain over entry price. */
  gainPct: number;
  /** How much of the ORIGINAL token quantity to sell. */
  sellPctOfOriginal: number;
  filled: boolean;
  filledAt?: number;
  filledPrice?: number;
  proceedsSol?: number;
}

export interface Position {
  id: string;
  mint: string;
  symbol?: string;
  name?: string;
  creator: string;
  pool: Pool;
  status: PositionStatus;

  /** SOL actually spent on entry, including fees. */
  costSol: number;
  /** Token quantity received on entry (UI units). */
  originalQty: number;
  /** Token quantity still held. */
  remainingQty: number;
  /** SOL per token at entry. */
  entryPrice: number;
  entryTx?: string;
  openedAt: number;

  /** Best price seen since entry, for trailing stops. */
  peakPrice: number;
  lastPrice: number;
  lastPriceAt: number;

  ladder: LadderTier[];
  /** True once the ladder is exhausted and only the moonbag remains. */
  moonbagArmed: boolean;

  realizedSol: number;
  closedAt?: number;
  closeReason?: string;
  safetyScore: number;
  /** Free-form notes appended over the position's life, for the trade journal. */
  notes: string[];
}

export type ExitReason =
  | 'ladder'
  | 'stop_loss'
  | 'trailing_stop'
  | 'moonbag_trailing_stop'
  | 'time_stop'
  | 'max_hold'
  | 'rug_detected'
  | 'manual'
  | 'shutdown';

/** An instruction produced by the strategy for the executor to carry out. */
export interface ExitOrder {
  mint: string;
  positionId: string;
  /** Token quantity to sell (UI units). */
  qty: number;
  reason: ExitReason;
  /** Sell the entire remaining balance rather than a computed quantity. */
  closeAll: boolean;
  /**
   * Ladder rungs this order fills. A gap up can cross several at once, so they
   * are batched into one sell rather than one transaction per rung.
   */
  tierIndexes: number[];
  /** Human-readable trigger, for the log and the trade journal. */
  detail: string;
}

export interface BuyResult {
  ok: boolean;
  signature?: string;
  /** SOL actually spent. */
  spentSol: number;
  /** Token quantity actually received (UI units). */
  receivedQty: number;
  /** Effective SOL-per-token fill price. */
  price: number;
  error?: string;
}

export interface SellResult {
  ok: boolean;
  signature?: string;
  /** Token quantity actually sold (UI units). */
  soldQty: number;
  /** SOL actually received. */
  receivedSol: number;
  price: number;
  error?: string;
}

/** Pluggable trade backend: paper, on-chain, or a third-party terminal. */
export interface Executor {
  readonly name: string;
  buy(candidate: TokenCandidate, amountSol: number): Promise<BuyResult>;
  sell(position: Position, qty: number, closeAll: boolean): Promise<SellResult>;
  /** Current SOL-per-token price, or null if unavailable. */
  price(position: Position): Promise<number | null>;
  /** Real on-chain token balance (UI units); used to detect partial fills. */
  balance(mint: string): Promise<number | null>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** Pluggable source of new launches. */
export interface Discovery {
  readonly name: string;
  start(onCandidate: (c: TokenCandidate) => void): Promise<void>;
  stop(): Promise<void>;
}

/** Rolling record of a deployer's past launches, used to score new ones. */
export interface CreatorRecord {
  address: string;
  launches: number;
  rugs: number;
  wins: number;
  firstSeen: number;
  lastSeen: number;
  /** Mints we have traded from this creator. */
  mints: string[];
}

export interface TradeJournalEntry {
  positionId: string;
  mint: string;
  symbol?: string;
  creator: string;
  openedAt: number;
  closedAt: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  closeReason: string;
  safetyScore: number;
  holdSeconds: number;
}
