/** Shared domain types. */

/**
 * Venue a token trades on. Mirrors PumpPortal's `pool` parameter.
 *
 * `unknown` is not a venue — it means the feed named one we do not recognise.
 * It exists so that an unrecognised launchpad can be *said*, because the
 * alternative was calling it `pump` and letting it through every gate meant to
 * keep it out.
 */
export type Pool =
  | 'pump'
  | 'pump-amm'
  | 'raydium'
  | 'raydium-cpmm'
  | 'launchlab'
  | 'bonk'
  | 'auto'
  | 'unknown';

/**
 * Whether a venue is on an allow-list.
 *
 * `unknown` is deliberately not a configurable value, so it can never appear in
 * one of these lists and this always answers false for it. That is the whole
 * point of having it: a venue we could not identify is not one we trade, and
 * there is no setting that makes it one.
 */
export function poolAllowed(allowed: readonly string[], pool: Pool): boolean {
  return allowed.includes(pool);
}

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
  /** Numbers this check measured. See `CheckOutcome.metrics`. */
  metrics?: Record<string, number>;
}

export interface SafetyVerdict {
  score: number;
  passed: boolean;
  results: CheckResult[];
  /** Which check vetoed the buy, if any. */
  rejectedBy?: string;
  elapsedMs: number;
  /**
   * True when the free checks alone settled it and the RPC-costing ones were
   * never run. The verdict is the same either way; `results` is shorter.
   */
  shortCircuited?: boolean;
  /** Every number the checks measured, merged. See `CheckOutcome.metrics`. */
  metrics: Record<string, number>;
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
  /** SOL notional committed, excluding fees. Drives the fee-aware target. */
  notionalSol?: number;
  /** Token quantity received on entry (UI units). */
  originalQty: number;
  /** Token quantity still held. */
  remainingQty: number;
  /** SOL per token at entry. */
  entryPrice: number;
  /** Market cap in SOL at the moment of the buy. */
  entryMarketCapSol?: number;
  /** Market cap in USD at the moment of the buy, at the SOL price then. */
  entryMarketCapUsd?: number;
  entryTx?: string;
  openedAt: number;

  /**
   * Which bot owns this position. The exit planner defers entirely to the copy
   * trader for its positions — a mechanical exit firing underneath it would
   * break the "sell when they sell" contract.
   */
  managedBy?: 'screener' | 'sniper' | 'copy';
  /** Copy trading: the wallet whose buy this position mirrors. */
  copiedFrom?: string;

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

  /** Consecutive failed sell attempts; resets on a successful sell. */
  exitFailures?: number;
  /** Epoch ms before which no further sell should be attempted. */
  nextExitAttemptAt?: number;

  /**
   * Ratchet bookkeeping. The exit asks one question every CHECKPOINT_SECONDS:
   * is the price higher than it was at the last checkpoint? These record where
   * the current window started so that question has an answer after a restart.
   */
  checkpointAt?: number;
  checkpointPrice?: number;
  /**
   * True once enough has been sold to return the original stake. Everything
   * still held after that is house money, which is what lets the ratchet drop
   * the stop entirely.
   */
  costRecovered?: boolean;

  /** Analyst's expected upside, when the AI strategy opened this position. */
  aiTargetGainPct?: number;
  /**
   * Drawdown at which the analyst's thesis is disproven. Used as the stop when
   * it is TIGHTER than the configured one — the mechanical stop is a floor the
   * model is never allowed to widen.
   */
  aiInvalidationPct?: number;
}

export type ExitReason =
  | 'ladder'
  | 'stop_loss'
  | 'trailing_stop'
  | 'moonbag_trailing_stop'
  /**
   * Held past `TIME_STOP_SECONDS` without going anywhere. Ladder mode only.
   *
   * The three timed exits below used to share this one label, which made the
   * journal unable to say which parameter had produced an exit — three
   * different knobs, in three different exit modes, with defaults an order of
   * magnitude apart, all reported the same way. Any read of "how are the timed
   * exits doing" was really a read of all of them blended together, and the
   * auto-tuner cannot attribute what it cannot distinguish.
   */
  | 'time_stop'
  /**
   * Ratchet: below breakeven at the FIRST checkpoint, so the entry never
   * started. Governed by `RATCHET_FIRST_CHECKPOINT_SECONDS`. This is the
   * dead-entry cut, and how long it waits is how much a non-starter bleeds.
   */
  | 'dead_entry'
  /**
   * Ratchet: below breakeven at a LATER checkpoint — it was working and
   * stopped. Governed by `CHECKPOINT_SECONDS`. A different question from
   * `dead_entry`, and a different parameter.
   */
  | 'checkpoint_cut'
  /** Scalp: flat past `SCALP_TIME_STOP_SECONDS`. Its own parameter again. */
  | 'scalp_time_stop'
  | 'max_hold'
  | 'rug_detected'
  | 'manual'
  | 'ai_exit'
  | 'ai_trim'
  | 'shutdown'
  /** Sold just enough to return the original stake. The rest rides free. */
  | 'cost_recovery'
  /** Skimmed a slice off a moonbag that is still climbing. */
  | 'moonbag_trim'
  /** A checkpoint passed without a new high, so the move is over. */
  | 'ratchet_stall'
  /**
   * No price could be read for long enough to give up. Deliberately distinct
   * from `rug_detected`: one means the token is worthless, the other means we
   * could not see it, and conflating them writes off tradeable positions.
   */
  | 'unpriceable';

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
  /**
   * What the entry filter looked like at the moment of the buy. Without this
   * the journal records outcomes but not the conditions that produced them,
   * which makes tuning the thresholds guesswork.
   */
  entryNote?: string;
  /**
   * The wallet this trade mirrored, when the copy bot opened it. Stored as the
   * ADDRESS, not the name — names are resolved from config at render time, so
   * renaming a wallet relabels its whole history instead of only new trades.
   */
  copiedFrom?: string;
}
