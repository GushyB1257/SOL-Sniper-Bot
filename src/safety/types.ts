import type { Connection } from '@solana/web3.js';
import type { CheckSeverity, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';

export interface CheckContext {
  candidate: TokenCandidate;
  conn: Connection;
  cfg: Config;
  store: Store;
  /** Shared scratch space so checks can reuse each other's RPC results. */
  cache: Map<string, unknown>;
}

export interface CheckOutcome {
  passed: boolean;
  detail: string;
  /**
   * The numbers this check measured, for the record rather than the decision.
   *
   * A check's `detail` is prose for a human reading a log. The auto-tuner reads
   * the trade journal, and the journal carried only the safety *score* — so a
   * sniper with 116 dead entries out of 150 had no way to ask which launch
   * characteristic predicted death, and every entry-filter proposal was a guess
   * between equally plausible knobs. These get stamped on the position at entry
   * and bucketised in the evidence, the same way the screener's market cap and
   * volume already are.
   */
  metrics?: Record<string, number>;
}

export interface Check {
  readonly id: string;
  /**
   * `fatal`   — failing vetoes the buy outright, whatever the score.
   * `major`   — heavy score penalty.
   * `minor`   — small penalty; informational signals.
   */
  readonly severity: CheckSeverity;
  /** Points off the 100-point score when this check fails (non-fatal only). */
  readonly penalty: number;
  /**
   * True for the checks that detect a RUG SETUP rather than judge quality —
   * the ones SNIPE_MODE=all keeps when it throws every filter away. In that
   * mode these are the only checks that run, and ANY failure vetoes,
   * whatever the severity says: a mode with no score has no non-fatal.
   */
  readonly rugCritical?: boolean;
  /**
   * Hard cap on the check's own work.
   *
   * The engine adds current RPC backpressure on top for checks that make
   * network calls, so this is a budget for the work rather than for the work
   * plus however long the throttle's queue happened to be. The whole battery
   * still has to fit inside the snipe window, which is what keeps these small.
   */
  readonly timeoutMs: number;
  /**
   * What running this check costs.
   *
   * `local` — decided from the candidate, the config or the local store. Free
   * and instant, so it runs first and can reject a launch before a single
   * request is spent on it. At peak, pump.fun deploys several tokens a second
   * and most of them are copycat or serial-launcher spam that the local checks
   * already condemn; paying four RPC calls to confirm that is quota taken
   * directly from the sells of positions we are actually holding.
   *
   * `http` — fetches off-chain metadata. Costs latency but not RPC quota.
   *
   * `rpc`  — costs a call against the endpoint's rate limit.
   *
   * Defaults to `rpc`, the conservative reading: an unclassified check is
   * assumed to cost something and runs in the second phase.
   */
  readonly cost?: 'local' | 'http' | 'rpc';
  /**
   * When true, a check that errors or times out is treated as a FAILURE rather
   * than being skipped. Use for checks whose whole purpose is catching a rug —
   * "I couldn't tell" must not read as "it's fine".
   */
  readonly failClosed: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

/** Helper for memoising an RPC result across checks within one evaluation. */
export function cached<T>(ctx: CheckContext, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = ctx.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;

  // Cache the promise, not the value, so checks running in parallel share one
  // round-trip instead of racing to issue the same RPC call.
  const promise = fn();
  ctx.cache.set(key, promise);
  promise.catch(() => ctx.cache.delete(key));
  return promise;
}
