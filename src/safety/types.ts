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
  /** Hard cap on runtime. The whole battery must fit inside the snipe window. */
  readonly timeoutMs: number;
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
