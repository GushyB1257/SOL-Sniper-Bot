import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../logger.js';

const log = logger('rpc');

/**
 * Marks the calls that must not wait behind background polling.
 *
 * A rate limiter is fair, and fairness is the wrong policy here: a sell queued
 * behind eighty curve reads is a worse price, while a curve read queued behind
 * a sell costs nothing at all. AsyncLocalStorage carries the flag across every
 * await inside the wrapped function, so a call site opts in once and everything
 * underneath it inherits — no plumbing through the executor interface.
 */
const priorityContext = new AsyncLocalStorage<true>();

/**
 * Runs `fn` with its RPC calls at the front of the queue.
 *
 * Use it for the trade path — buys, and above all sells. Do NOT use it for
 * polling: if everything is priority, nothing is.
 */
export function withRpcPriority<T>(fn: () => Promise<T>): Promise<T> {
  return priorityContext.run(true, fn);
}

const isPriority = (): boolean => priorityContext.getStore() === true;

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
  /**
   * Requests by JSON-RPC method.
   *
   * "You are being rate limited" is not actionable on its own — the useful
   * question is which subsystem is spending the quota, and the method name
   * answers it: getParsedTokenAccountsByOwner is the copy watcher,
   * getMultipleAccounts is the curve poller, getSignaturesForAddress is the
   * sniper's provenance checks. Read off the body, so no call site has to
   * cooperate.
   */
  byMethod: Record<string, number>;
  /** Requests that jumped the queue because they were on the trade path. */
  priority: number;
}

const stats: RpcThrottleStats = {
  requests: 0,
  rateLimited: 0,
  retries: 0,
  givenUp: 0,
  waitedMs: 0,
  peakInFlight: 0,
  byMethod: {},
  priority: 0,
};

export function rpcStats(): RpcThrottleStats {
  return { ...stats, byMethod: { ...stats.byMethod } };
}

/** Methods in the request, biggest spender first. */
export function topMethods(limit = 3): Array<{ method: string; calls: number; pct: number }> {
  const total = Object.values(stats.byMethod).reduce((a, n) => a + n, 0);
  if (total === 0) return [];
  return Object.entries(stats.byMethod)
    .sort((a, blk) => blk[1] - a[1])
    .slice(0, limit)
    .map(([method, calls]) => ({ method, calls, pct: (calls / total) * 100 }));
}

/**
 * The JSON-RPC method out of a request body, without paying to parse it.
 *
 * A regex rather than JSON.parse: this runs on every RPC call the process
 * makes, and the field sits near the front of a body that can be large when a
 * batch of accounts is being read.
 */
function methodOf(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') return 'unknown';
  const m = /"method"\s*:\s*"([^"]+)"/.exec(body);
  return m?.[1] ?? 'unknown';
}

export function resetRpcStatsForTests(): void {
  Object.assign(stats, {
    requests: 0,
    rateLimited: 0,
    retries: 0,
    givenUp: 0,
    waitedMs: 0,
    peakInFlight: 0,
    byMethod: {},
    priority: 0,
  });
}

/**
 * How far a priority request may drive the token balance negative.
 *
 * Small on purpose: it is enough for a sell and its confirmation to go straight
 * through, and not enough for a burst of them to meaningfully overshoot the
 * provider's limit.
 */
const PRIORITY_BORROW = 8;

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

  /**
   * Waits until a token is available, then consumes it.
   *
   * A priority request borrows instead of waiting: it goes through immediately
   * and drives the balance negative, which the refill then works off. The debt
   * is bounded, so a burst of them cannot turn into an unbounded overshoot of
   * the provider's limit — it just means the next few background reads wait a
   * little longer, which is exactly the trade worth making.
   */
  async take(priority = false): Promise<number> {
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
      if (priority && this.tokens > -PRIORITY_BORROW) {
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
  /** Trade-path waiters. Always served first. */
  private urgent: Array<() => void> = [];
  private normal: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(priority = false): Promise<number> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      stats.peakInFlight = Math.max(stats.peakInFlight, this.inFlight);
      return 0;
    }
    const started = Date.now();
    await new Promise<void>((resolve) => {
      (priority ? this.urgent : this.normal).push(resolve);
    });
    this.inFlight += 1;
    stats.peakInFlight = Math.max(stats.peakInFlight, this.inFlight);
    return Date.now() - started;
  }

  release(): void {
    this.inFlight -= 1;
    // Strict priority. Background polling is unbounded in volume, so anything
    // fairer than this lets a busy poller delay a sell indefinitely.
    const next = this.urgent.shift() ?? this.normal.shift();
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

  const share = stats.requests > 0 ? (stats.rateLimited / stats.requests) * 100 : 0;
  const top = topMethods(3)
    .map((m) => `${m.method} ${m.pct.toFixed(0)}%`)
    .join(', ');

  log.warn(
    `RPC rate limited ${stats.rateLimited} of ${stats.requests} requests ` +
      `(${share.toFixed(1)}%) — absorbing it with backoff.`,
  );
  // Naming the loudest method is the difference between advice and a shrug:
  // it points at the exact subsystem to turn down.
  if (top) log.warn(`  Busiest calls: ${top}`);
  log.warn(`  ${adviceFor()}`);
}

/** Which knob to reach for, chosen by what is actually making the calls. */
function adviceFor(): string {
  const worst = topMethods(1)[0];
  switch (worst?.method) {
    case 'getParsedTokenAccountsByOwner':
      return 'Most of it is the copy trader reading tracked wallets. Raise COPY_POLL_INTERVAL_MS (2000 is plenty) or track fewer wallets.';
    case 'getMultipleAccounts':
      return 'Most of it is the screener polling bonding curves. Lower SCREEN_POLL_MAX_TOKENS or raise SCREEN_POLL_INTERVAL_MS.';
    case 'getSignaturesForAddress':
      return 'Most of it is the sniper provenance checks. Set MIN_CREATOR_AGE_MINUTES=0 and MAX_LAUNCH_BUNDLE_TXS=0 to switch those off, or lower SNIPER_MAX_CONCURRENT_CHECKS.';
    case 'getTokenLargestAccounts':
    case 'getTokenSupply':
    case 'getParsedAccountInfo':
      return 'Most of it is the sniper safety battery. Lower SNIPER_MAX_CONCURRENT_CHECKS, or stop the sniper while you tune the other bots.';
    default:
      return 'Lower RPC_MAX_REQUESTS_PER_SEC to your provider tier so calls queue instead of failing — a free endpoint is usually 10/s or less.';
  }
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
    const urgent = isPriority();
    if (urgent) stats.priority += 1;

    for (let attempt = 0; ; attempt++) {
      stats.waitedMs += await bucket.take(urgent);
      stats.waitedMs += await gate.acquire(urgent);

      let res: Response;
      try {
        stats.requests += 1;
        const method = methodOf(init);
        stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
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
