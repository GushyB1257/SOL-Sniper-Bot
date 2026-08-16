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
  /**
   * Ceiling on sustained requests per second. 0 disables the rate cap.
   *
   * A ceiling, not a target: the bucket backs off below this whenever the
   * provider says no, so a value set too high costs a few 429s rather than a
   * sustained 20% failure rate.
   */
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
  /**
   * Requests per second the throttle is currently allowing.
   *
   * This is the adaptive rate, not the configured ceiling. When it sits well
   * below `RPC_MAX_REQUESTS_PER_SEC` for a whole session, the ceiling is
   * fiction and the number here is what the endpoint actually grants.
   */
  rateNow: number;
  /** Ceiling the adaptive rate is allowed to climb back to. */
  rateCeiling: number;
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
  rateNow: 0,
  rateCeiling: 0,
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
    rateNow: 0,
    rateCeiling: 0,
  });
  peakWaitMs = 0;
  peakWaitAt = Date.now();
}

/**
 * How long a request is currently waiting before it reaches the wire.
 *
 * A deadline measured from the moment a check starts is really two budgets
 * added together: the work, and however long the throttle made it queue. Under
 * load the second one dominates, and a 1500ms check that needs 300ms of work
 * dies having never issued its request — the timeout reports a slow endpoint
 * when the truth is a full queue. Callers add this to their own budget so the
 * deadline stays a statement about the work.
 *
 * A decaying peak rather than a mean, because a deadline has to survive the bad
 * case, not the typical one. It halves every 10s of calm so one burst does not
 * inflate every deadline for the rest of the session.
 */
let peakWaitMs = 0;
let peakWaitAt = Date.now();

/**
 * Beyond this, waiting is not something a longer deadline can fix.
 *
 * Sized to cover a full retry chain — the backoff runs 250ms, 500ms, 1s, 2s
 * before the request is given up on — plus the queueing around it. A request
 * that has waited longer than that is not going to arrive in time to be worth
 * anything on a snipe, and extending the deadline further just holds a
 * concurrency slot that a fresher launch could use.
 */
const BACKPRESSURE_CAP_MS = 5000;

function decayedPeak(now: number): number {
  return peakWaitMs * 0.5 ** ((now - peakWaitAt) / 10_000);
}

function observeWait(ms: number): void {
  const now = Date.now();
  peakWaitMs = Math.min(BACKPRESSURE_CAP_MS, Math.max(decayedPeak(now), ms));
  peakWaitAt = now;
}

export function rpcBackpressureMs(): number {
  return Math.max(0, Math.round(decayedPeak(Date.now())));
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

/** Floor the adaptive rate will not go below. Below this, nothing works at all. */
const MIN_RATE_PER_SEC = 3;
/** Multiplicative decrease. Backing off gently just means backing off repeatedly. */
const DECREASE_FACTOR = 0.7;
/** One cut per round-trip. A burst of 429s is one overshoot, not twenty. */
const DECREASE_COOLDOWN_MS = 1500;
/** Quiet stretch before the rate starts climbing back toward the ceiling. */
const RECOVER_AFTER_MS = 20_000;
/** Then +1/s at a time. Additive increase is what stops it oscillating. */
const RECOVER_STEP_MS = 5_000;
/**
 * Fraction of the ceiling to open at.
 *
 * Starting at the ceiling means the first seconds of every run are a burst of
 * 429s while the controller discovers the ceiling was optimistic — and those are
 * the seconds three bots spend all coming up at once. Opening below it and
 * climbing costs a slow first minute on an endpoint that could have taken more,
 * and costs nothing at all on one that could not.
 */
const OPENING_FRACTION = 0.5;

/**
 * A token bucket that refills continuously rather than in ticks, and that
 * learns the rate it is allowed rather than being told it.
 *
 * Refilling on a timer produces a sawtooth — every caller wakes at the same
 * instant and fires together, which is exactly the burst the limiter exists to
 * prevent. Computing the level from elapsed time spreads them out instead.
 *
 * The configured rate is a ceiling, not a setting to be obeyed. Nobody knows
 * what their endpoint actually grants: the tier is undocumented, shared across
 * three bots and whatever else is on the key, and it changes with load. A fixed
 * rate set above the real one does not fail gracefully — every request over the
 * line is a 429, and each 429 costs a request slot on the way to being retried,
 * so the overshoot feeds itself. Additive-increase/multiplicative-decrease finds
 * the real number in a few seconds and tracks it as it moves: cut hard when the
 * provider objects, then creep back up while it does not.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  /** The adaptive rate. Starts at the ceiling and is corrected downward. */
  private rate: number;
  private lastDecreaseAt = 0;
  private lastIncreaseAt = Date.now();

  constructor(private readonly ceiling: number) {
    this.rate =
      ceiling > 0 ? Math.min(ceiling, Math.max(MIN_RATE_PER_SEC, ceiling * OPENING_FRACTION)) : 0;
    this.tokens = this.rate;
    stats.rateNow = Math.round(this.rate * 10) / 10;
    stats.rateCeiling = ceiling;
  }

  /** Cuts the rate after the provider refuses a request. */
  penalise(): void {
    if (this.ceiling <= 0) return;
    const now = Date.now();
    // Requests already in flight when the limit was breached all come back 429.
    // Cutting once per burst rather than once per response is the difference
    // between backing off and collapsing to the floor.
    if (now - this.lastDecreaseAt < DECREASE_COOLDOWN_MS) return;

    this.lastDecreaseAt = now;
    this.lastIncreaseAt = now;
    this.rate = Math.max(MIN_RATE_PER_SEC, this.rate * DECREASE_FACTOR);
    // Do not carry a surplus across the cut, or the first thing the new,
    // lower rate does is spend a burst at the old one.
    this.tokens = Math.min(this.tokens, this.rate);
    stats.rateNow = Math.round(this.rate * 10) / 10;
  }

  /** Creeps back toward the ceiling while the provider stays quiet. */
  private maybeRecover(now: number): void {
    if (this.rate >= this.ceiling) return;
    if (now - this.lastDecreaseAt < RECOVER_AFTER_MS) return;
    if (now - this.lastIncreaseAt < RECOVER_STEP_MS) return;

    this.lastIncreaseAt = now;
    this.rate = Math.min(this.ceiling, this.rate + 1);
    stats.rateNow = Math.round(this.rate * 10) / 10;
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
    if (this.ceiling <= 0) return 0;
    let waited = 0;

    for (;;) {
      const now = Date.now();
      this.maybeRecover(now);
      this.tokens = Math.min(
        this.rate,
        this.tokens + ((now - this.lastRefill) / 1000) * this.rate,
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

      const needed = ((1 - this.tokens) / this.rate) * 1000;
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
      `(${share.toFixed(1)}%) — throttling down to ${stats.rateNow}/s ` +
      `(ceiling ${stats.rateCeiling}/s) and absorbing the rest with backoff.`,
  );
  // Naming the loudest method is the difference between advice and a shrug:
  // it points at the exact subsystem to turn down.
  if (top) log.warn(`  Busiest calls: ${top}`);
  log.warn(`  ${adviceFor()}`);
}

/**
 * Which knob to reach for, chosen by what is actually making the calls.
 *
 * Every method the bot issues in volume is named here. A method that falls
 * through to the default gets generic advice, which is the one outcome worth
 * avoiding: the whole point is to say which subsystem to turn down.
 */
function adviceFor(): string {
  const worst = topMethods(1)[0];
  switch (worst?.method) {
    case 'getParsedTokenAccountsByOwner':
    case 'getTokenAccountsByOwner':
      return 'Most of it is the copy trader reading tracked wallets. Raise COPY_POLL_INTERVAL_MS (2000 is plenty) or track fewer wallets.';
    case 'getMultipleAccounts':
    case 'getMultipleAccountsInfo':
      return 'Most of it is the screener polling bonding curves. Lower SCREEN_POLL_MAX_TOKENS or raise SCREEN_POLL_INTERVAL_MS.';
    case 'getSignaturesForAddress':
      return 'Most of it is the sniper provenance checks. Set MIN_CREATOR_AGE_MINUTES=0 and MAX_LAUNCH_BUNDLE_TXS=0 to switch those off, or lower SNIPER_MAX_CONCURRENT_CHECKS.';
    case 'getBalance':
      return 'Most of it is the deployer-balance check, one call per launch. Set MIN_DEPLOYER_BALANCE_SOL=0 to skip it, or lower SNIPER_MAX_CONCURRENT_CHECKS so fewer launches are evaluated at once.';
    case 'getAccountInfo':
    case 'getParsedAccountInfo':
    case 'getTokenLargestAccounts':
    case 'getTokenSupply':
      return 'Most of it is the sniper safety battery reading mints. Lower SNIPER_MAX_CONCURRENT_CHECKS, or stop the sniper while you tune the other bots.';
    case 'sendTransaction':
    case 'getSignatureStatuses':
    case 'getLatestBlockhash':
      return 'Most of it is trade execution, which is the one thing worth spending quota on. Turn down polling elsewhere rather than this.';
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

    // Everything this one request spends waiting, so the deadline a caller sets
    // can be told about it. Accumulated across retries on purpose: from the
    // caller's side a request that was 429'd twice really did take that long.
    let waitedHere = 0;

    for (let attempt = 0; ; attempt++) {
      const queued = (await bucket.take(urgent)) + (await gate.acquire(urgent));
      stats.waitedMs += queued;
      waitedHere += queued;

      let res: Response;
      try {
        stats.requests += 1;
        const method = methodOf(init);
        stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
        res = await transport(input, init);
      } finally {
        gate.release();
      }

      if (!RETRYABLE.has(res.status)) {
        observeWait(waitedHere);
        return res;
      }
      if (res.status === 429) {
        stats.rateLimited += 1;
        // The provider has just told us the rate we chose is wrong. Believe it:
        // retrying at the same rate is how 19% of a session ends up rate
        // limited instead of the handful of 429s it takes to find the ceiling.
        bucket.penalise();
        warnThrottled();
      }

      if (attempt >= opts.maxRetries) {
        stats.givenUp += 1;
        observeWait(waitedHere);
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
      waitedHere += wait;
      await sleep(wait);
    }
  };
}
