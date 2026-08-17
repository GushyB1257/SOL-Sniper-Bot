import { logger } from '../logger.js';
import { errMessage, sleep, withTimeout } from '../util/async.js';
import type { Quote } from './types.js';

const log = logger('arb:jupiter');

/**
 * Quote hosts, tried in order.
 *
 * The same list the price source uses, and for the same reason: Jupiter has
 * moved this endpoint more than once, and a single hard-coded URL going stale is
 * indistinguishable from every pair having no route. On an arbitrage bot that
 * failure is quiet — it just reports no opportunities forever.
 *
 * None of these need an API key. The free tier meters per second, which is why
 * the pacing below matters more than concurrency.
 */
export const QUOTE_HOSTS = [
  'https://lite-api.jup.ag/swap/v1',
  'https://api.jup.ag/swap/v1',
  'https://quote-api.jup.ag/v6',
] as const;

/** The aggregator has no route for this pair. Expected, not an outage. */
export class NoRouteError extends Error {
  constructor(inputMint: string, outputMint: string) {
    super(`no route ${inputMint.slice(0, 6)} -> ${outputMint.slice(0, 6)}`);
    this.name = 'NoRouteError';
  }
}

/** HTTP 429, carrying the server's own reset hint when it gives one. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  /** Restrict routing to specific venues, e.g. ["Orca V2"]. */
  dexes?: readonly string[];
  onlyDirectRoutes?: boolean;
  signal?: AbortSignal;
}

export interface JupiterOptions {
  timeoutMs?: number;
  /**
   * Minimum gap between outbound requests, in ms.
   *
   * The free tier meters per second, so spacing is the thing that keeps us
   * inside it. Concurrency without spacing just delivers the same burst.
   */
  minRequestIntervalMs?: number;
  maxRetries?: number;
  hosts?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface JupiterQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string | number;
  slippageBps?: number;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

/**
 * Quote client for the free Jupiter aggregator.
 *
 * Serialised behind one gate rather than run concurrently. That looks like a
 * self-imposed tax on a latency-sensitive strategy, and it is the opposite: on
 * the free tier a burst earns a 429, the 429 costs a retry, and the retry
 * arrives after the quote it was racing for has already gone. Spacing requests
 * is how the scan finishes at all.
 */
export class JupiterClient {
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly hosts: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** Tail of the serialised request chain. */
  private gate: Promise<void> = Promise.resolve();
  private lastSentAt = 0;
  private preferredHost: string | null = null;
  private warnedRateLimit = false;
  private rateLimitHits = 0;

  constructor(options: JupiterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.minIntervalMs = options.minRequestIntervalMs ?? 1_100;
    this.maxRetries = options.maxRetries ?? 3;
    this.hosts = options.hosts ?? QUOTE_HOSTS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('no fetch implementation available (Node 18+ required)');
    }
  }

  get rateLimited(): number {
    return this.rateLimitHits;
  }

  async quote(request: QuoteRequest): Promise<Quote> {
    if (request.inputMint === request.outputMint) {
      // Jupiter rejects this, and it is worth naming: it is exactly why a cycle
      // cannot be one atomic transaction here.
      throw new Error('quote requires distinct input and output mints');
    }
    if (request.amount <= 0n) {
      throw new Error(`quote amount must be positive, got ${request.amount}`);
    }

    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount.toString(),
      slippageBps: String(Math.round(request.slippageBps)),
      // Keep intermediate hops to liquid tokens. A route through something
      // illiquid quotes well and lands badly.
      restrictIntermediateTokens: 'true',
    });
    if (request.onlyDirectRoutes) params.set('onlyDirectRoutes', 'true');
    if (request.dexes && request.dexes.length > 0) params.set('dexes', request.dexes.join(','));

    const payload = await this.request(`/quote?${params.toString()}`, request.signal);

    if (payload.outAmount === undefined || payload.inAmount === undefined) {
      throw new NoRouteError(request.inputMint, request.outputMint);
    }

    return {
      inputMint: payload.inputMint ?? request.inputMint,
      outputMint: payload.outputMint ?? request.outputMint,
      inAmount: BigInt(payload.inAmount),
      outAmount: BigInt(payload.outAmount),
      otherAmountThreshold: BigInt(payload.otherAmountThreshold ?? payload.outAmount),
      priceImpactPct: Number(payload.priceImpactPct ?? 0),
      slippageBps: Number(payload.slippageBps ?? request.slippageBps),
      marketLabels: (payload.routePlan ?? []).map((step) => step.swapInfo?.label ?? 'agg'),
      fetchedAt: this.now(),
    };
  }

  /**
   * One request, paced and retried, across whichever host answers.
   *
   * The host that worked is remembered, so the fallback costs one round trip
   * rather than being paid on every quote for the rest of the run.
   */
  private async request(path: string, signal?: AbortSignal): Promise<JupiterQuoteResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.pace(signal);

      let lastError: unknown = null;
      const order = this.preferredHost
        ? [this.preferredHost, ...this.hosts.filter((h) => h !== this.preferredHost)]
        : this.hosts;

      for (const host of order) {
        try {
          const res = await withTimeout(
            this.fetchImpl(`${host}${path}`, { signal }),
            this.timeoutMs,
            'jupiter quote',
          );

          if (res.status === 429) {
            this.rateLimitHits += 1;
            this.warnRateLimit();
            throw new RateLimitError('jupiter rate limited', retryAfterMs(res));
          }
          // A wrong host answers 404; a broken one answers 5xx. Either way, try
          // the next one rather than concluding the pair has no route.
          if (res.status === 404 || res.status >= 500) {
            lastError = new Error(`host ${host} returned ${res.status}`);
            continue;
          }

          this.preferredHost = host;
          if (!res.ok) throw new NoRouteError('?', '?');
          return (await res.json()) as JupiterQuoteResponse;
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          if (err instanceof NoRouteError) throw err;
          if (signal?.aborted) throw err;
          lastError = err;
        }
      }

      // Every host failed for a transient-looking reason.
      if (attempt >= this.maxRetries) {
        throw new Error(`no jupiter host answered: ${errMessage(lastError)}`);
      }
      await sleep(backoffMs(attempt));
    }
  }

  /** Serialises requests and holds them at least `minIntervalMs` apart. */
  private pace(signal?: AbortSignal): Promise<void> {
    const wait = this.gate.then(async () => {
      if (signal?.aborted) throw new Error('aborted');
      const since = this.now() - this.lastSentAt;
      const gap = this.minIntervalMs - since;
      if (gap > 0) await sleep(gap);
      this.lastSentAt = this.now();
    });
    // Errors must not poison the chain for every later caller.
    this.gate = wait.then(
      () => undefined,
      () => undefined,
    );
    return wait;
  }

  private warnRateLimit(): void {
    if (this.warnedRateLimit) return;
    this.warnedRateLimit = true;
    log.warn(
      'Jupiter is rate limiting the scan. Raise ARB_POLL_INTERVAL_MS or ' +
        'ARB_QUOTE_INTERVAL_MS, or scan fewer tokens with ARB_TOKENS — the free ' +
        'tier meters per second and a burst costs more time than it saves.',
    );
  }
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(4_000, 400 * 2 ** attempt);
  return base + Math.random() * base * 0.3;
}
