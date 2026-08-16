import { logger } from '../logger.js';

const log = logger('rpc');

/**
 * Rate limiting and 429 recovery for every RPC call the bot makes.
 *
 * This sits under `Connection` as its `fetch` implementation, which is the only
 * place that sees all of them: the safety battery, position pricing, balance
 * reads, curve polling and transaction sends all funnel through here whatever
 * code path they came from. Throttling any one caller would just move the
 * problem to the next one.
 *
 * Two mechanisms, because they solve different failures:
 *
 *  - A **token bucket** caps sustained request rate. Providers meter per second,
 *    so this is what stops a busy minute from tripping the limit at all.
 *  - A **concurrency semaphore** caps requests in flight. A burst of thirty
 *    parallel reads can breach a limit even when the per-second average is
 *    fine, and it also queues them behind each other at the socket layer.
 *
 * When a 429 lands anyway it is retried with exponential backoff, honouring
 * `Retry-After` when the provider sends one. That matters because the
 * alternative — surfacing the error — turns a transient limit into a failed
 * sell, and a failed sell is a position we are stuck holding.
 */
export interface RpcThrottleOptions {
  /** Maximum requests in flight at once. */
  maxConcurrent: number;
  /** Sustained requests per second. 0 disables the rate cap. */
  maxPerSecond: number;
  /** How many times a rate-limited or 5xx request is retried. */
  maxRetries: number;
}

export interface RpcThrottleStats {
  requests: number;
  /** Responses that came back 429. */
  rateLimited: number;
  /** Requests retried for any reason. */
  retries: number;
  /** Requests that exhausted every retry and were handed back as errors. */
  givenUp: number;
  /** Total ms spent waiting on the bucket, the semaphore or a backoff. */
  waitedMs: number;
  /** Largest number of requests in flight at once since start. */
  peakInFlight: number;
}

const stats: RpcThrottleStats = {
  requests: 0,
  rateLimited: 0,
  retries: 0,
  givenUp: 0,
  waitedMs: 0,
  peakInFlight: 0,
};

export function rpcStats(): RpcThrottleStats {
  return { ...stats };
}

export function resetRpcStatsForTests(): void {
  Object.assign(stats, {
    requests: 0,
    rateLimited: 0,
    retries: 0,
    givenUp: 0,
    waitedMs: 0,
    peakInFlight: 0,
  });
}

/** Status codes worth retrying: rate limits and transient gateway failures. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A token bucket that refills continuously rather than in ticks.
 *
 * Refilling on a timer produces a sawtooth — every caller wakes at the same
 * instant and fires together, which is exactly the burst the limiter exists to
 * prevent. Computing the level from elapsed time spreads them out instead.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  /** Waits until a token is available, then consumes it. */
  async take(): Promise<number> {
    if (this.perSecond <= 0) return 0;
    let waited = 0;

    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.perSecond,
        this.tokens + ((now - this.lastRefill) / 1000) * this.perSecond,
      );
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return waited;
      }

      const needed = ((1 - this.tokens) / this.perSecond) * 1000;
      const pause = Math.max(5, Math.ceil(needed));
      await sleep(pause);
      waited += pause;
    }
  }
}

/** Bounds how many requests are in flight, without spinning. */
class Semaphore {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<number> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      stats.peakInFlight = Math.max(stats.peakInFlight, this.inFlight);
      return 0;
    }
    const started = Date.now();
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
    stats.peakInFlight = Math.max(stats.peakInFlight, this.inFlight);
    return Date.now() - started;
  }

  release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Seconds or an HTTP date, per RFC 9110. Returns ms, or null if unusable. */
function retryAfterMs(res: { headers: { get(name: string): string | null } }): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);

  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), 30_000);
  return null;
}

let lastWarnAt = 0;

/** Says something useful at most once a minute, rather than per 429. */
function warnThrottled(): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  log.warn(
    `RPC rate limited ${stats.rateLimited} time(s) so far — absorbing it with backoff. ` +
      'If this is constant, lower RPC_MAX_REQUESTS_PER_SEC to match your provider tier, ' +
      'or raise MIN_SAFETY_SCORE / lower MAX_CONCURRENT_POSITIONS so fewer calls are made.',
  );
}

/**
 * Builds the `fetch` handed to `Connection`.
 *
 * Kept as a factory rather than a singleton so tests can build one with tiny
 * limits and a stub transport.
 */
export function createThrottledFetch(
  opts: RpcThrottleOptions,
  transport: typeof fetch = fetch,
): typeof fetch {
  const bucket = new TokenBucket(opts.maxPerSecond);
  const gate = new Semaphore(Math.max(1, opts.maxConcurrent));

  return async function throttledFetch(input, init) {
    for (let attempt = 0; ; attempt++) {
      stats.waitedMs += await bucket.take();
      stats.waitedMs += await gate.acquire();

      let res: Response;
      try {
        stats.requests += 1;
        res = await transport(input, init);
      } finally {
        gate.release();
      }

      if (!RETRYABLE.has(res.status)) return res;
      if (res.status === 429) {
        stats.rateLimited += 1;
        warnThrottled();
      }

      if (attempt >= opts.maxRetries) {
        stats.givenUp += 1;
        return res; // hand the caller the real response; it decides what to do
      }

      // Jitter matters more than the base delay here: without it every queued
      // caller retries on the same beat and re-creates the burst that caused
      // the limit.
      const backoff = Math.min(4000, 250 * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.3;
      stats.retries += 1;
      const wait = retryAfterMs(res) ?? backoff + jitter;
      stats.waitedMs += wait;
      await sleep(wait);
    }
  };
}
