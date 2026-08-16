/** Small async helpers used across the bot. */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Caps how long a promise may take. Safety checks run on the hot path of a
 * snipe — a check that hangs on a slow RPC must not cost us the entry, so every
 * check is wrapped in one of these.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
  onRetry?: (attempt: number, err: unknown) => void;
}

/** Retry with exponential backoff and jitter. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseMs = 250, maxMs = 4000, onRetry } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      onRetry?.(i + 1, err);
      const backoff = Math.min(maxMs, baseMs * 2 ** i);
      // Jitter keeps parallel retries from stampeding the RPC in lockstep.
      await sleep(backoff * (0.5 + Math.random() * 0.5));
    }
  }
  throw lastErr;
}

/**
 * Serialises calls sharing a key, so two price ticks can't both decide to sell
 * the same position and double-spend the balance.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run regardless of whether the previous holder resolved or threw.
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Drop the entry once we are the last waiter, to bound map growth.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get depth(): number {
    return this.tails.size;
  }
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
