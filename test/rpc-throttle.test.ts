import { describe, it, expect, beforeEach } from 'vitest';
import {
  createThrottledFetch,
  rpcBackpressureMs,
  rpcStats,
  resetRpcStatsForTests,
  topMethods,
  withRpcPriority,
} from '../src/util/rpc-throttle.js';

/** Minimal stand-in for a fetch Response; only status and headers are read. */
function reply(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  } as unknown as Response;
}

beforeEach(() => resetRpcStatsForTests());

describe('RPC throttling', () => {
  it('holds requests in flight to the configured limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const transport = async (): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return reply(200);
    };

    const f = createThrottledFetch(
      { maxConcurrent: 3, maxPerSecond: 0, maxRetries: 0 },
      transport as unknown as typeof fetch,
    );

    await Promise.all(Array.from({ length: 12 }, () => f('http://rpc.test')));
    expect(peak).toBe(3);
    expect(rpcStats().requests).toBe(12);
  });

  it('caps sustained rate so a busy minute does not trip the provider limit', async () => {
    const f = createThrottledFetch(
      { maxConcurrent: 64, maxPerSecond: 20, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );

    const started = Date.now();
    // The bucket opens at half the ceiling — 10 go instantly and the rest are
    // paced at ~10/s, so 30 requests cannot possibly land inside a second.
    await Promise.all(Array.from({ length: 30 }, () => f('http://rpc.test')));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(300);
    expect(rpcStats().requests).toBe(30);
  });

  it('opens below the configured ceiling rather than discovering it with 429s', async () => {
    // Starting at the ceiling means the first seconds of every run are a burst
    // of rate limiting while the controller learns the number was optimistic —
    // and those are the seconds all three bots come up in.
    createThrottledFetch(
      { maxConcurrent: 8, maxPerSecond: 30, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    expect(rpcStats().rateNow).toBe(15);
    expect(rpcStats().rateCeiling).toBe(30);
  });

  it('backs off the rate itself when the provider says no, instead of only retrying', async () => {
    // The 19%-rate-limited session this fixes: retrying at a rate the endpoint
    // has already refused just re-earns the 429, and each one costs a request
    // slot on the way to being retried, so the overshoot feeds itself.
    const f = createThrottledFetch(
      { maxConcurrent: 8, maxPerSecond: 40, maxRetries: 0 },
      (async () => reply(429)) as unknown as typeof fetch,
    );

    const before = rpcStats().rateNow;
    await f('http://rpc.test');
    const afterOne = rpcStats().rateNow;
    expect(afterOne).toBeLessThan(before);

    // Cuts are one-per-burst: the requests already in flight when the limit was
    // breached all come back 429, and treating that as twenty separate signals
    // would collapse straight to the floor.
    await Promise.all(Array.from({ length: 10 }, () => f('http://rpc.test')));
    expect(rpcStats().rateNow).toBe(afterOne);
  });

  it('will not throttle itself below a workable floor', async () => {
    // A relentlessly 429ing endpoint must not leave the bot unable to issue the
    // one call that matters, which is the sell. A ceiling of 8 opens at 4, so
    // the first cut lands on the floor and the second has to hold it.
    const f = createThrottledFetch(
      { maxConcurrent: 8, maxPerSecond: 8, maxRetries: 0 },
      (async () => reply(429)) as unknown as typeof fetch,
    );
    expect(rpcStats().rateNow).toBe(4);

    await f('http://rpc.test');
    expect(rpcStats().rateNow).toBe(3);

    // Past the per-burst cooldown, so this is a second genuine cut.
    await new Promise((r) => setTimeout(r, 1600));
    await f('http://rpc.test');
    expect(rpcStats().rateNow).toBe(3);
  });

  it('reports how long requests are waiting, so deadlines can allow for it', async () => {
    // A check that dies while its request is still queued reports a slow
    // endpoint when the truth is a full queue. Callers add this to their budget.
    expect(rpcBackpressureMs()).toBe(0);

    const f = createThrottledFetch(
      { maxConcurrent: 1, maxPerSecond: 0, maxRetries: 0 },
      (async () => {
        await new Promise((r) => setTimeout(r, 40));
        return reply(200);
      }) as unknown as typeof fetch,
    );

    await Promise.all(Array.from({ length: 6 }, () => f('http://rpc.test')));
    // The last one waited behind five 40ms requests.
    expect(rpcBackpressureMs()).toBeGreaterThan(100);
  });

  it('retries a 429 instead of surfacing it as a failed sell', async () => {
    // This is the failure that matters: an unhandled 429 on the exit path is a
    // sell that did not happen, which is a position we are stuck holding.
    let calls = 0;
    const transport = async (): Promise<Response> => {
      calls += 1;
      return calls < 3 ? reply(429) : reply(200);
    };

    const f = createThrottledFetch(
      { maxConcurrent: 4, maxPerSecond: 0, maxRetries: 4 },
      transport as unknown as typeof fetch,
    );

    const res = await f('http://rpc.test');
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(rpcStats().rateLimited).toBe(2);
    expect(rpcStats().retries).toBe(2);
  });

  it('honours Retry-After when the provider sends one', async () => {
    let calls = 0;
    const transport = async (): Promise<Response> => {
      calls += 1;
      return calls === 1 ? reply(429, { 'retry-after': '0.2' }) : reply(200);
    };

    const f = createThrottledFetch(
      { maxConcurrent: 4, maxPerSecond: 0, maxRetries: 2 },
      transport as unknown as typeof fetch,
    );

    const started = Date.now();
    await f('http://rpc.test');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('gives the caller the real response once retries are exhausted', async () => {
    // Retrying forever would hide a genuinely dead endpoint behind a hang.
    const f = createThrottledFetch(
      { maxConcurrent: 4, maxPerSecond: 0, maxRetries: 1 },
      (async () => reply(429)) as unknown as typeof fetch,
    );

    const res = await f('http://rpc.test');
    expect(res.status).toBe(429);
    expect(rpcStats().givenUp).toBe(1);
  });

  it('reports which calls are spending the quota', async () => {
    // "You are being rate limited" is not actionable on its own. The method
    // name maps straight onto a subsystem, so it is the difference between
    // advice and a shrug.
    const f = createThrottledFetch(
      { maxConcurrent: 8, maxPerSecond: 0, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    const call = (method: string) =>
      f('http://rpc.test', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method }) });

    await Promise.all([
      ...Array.from({ length: 7 }, () => call('getParsedTokenAccountsByOwner')),
      ...Array.from({ length: 2 }, () => call('getMultipleAccounts')),
      call('getSignaturesForAddress'),
    ]);

    const top = topMethods(3);
    expect(top[0]?.method).toBe('getParsedTokenAccountsByOwner');
    expect(top[0]?.calls).toBe(7);
    expect(top[0]?.pct).toBeCloseTo(70, 0);
    expect(rpcStats().byMethod.getMultipleAccounts).toBe(2);
  });

  it('does not fall over on a body it cannot read', async () => {
    const f = createThrottledFetch(
      { maxConcurrent: 2, maxPerSecond: 0, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    await f('http://rpc.test');
    await f('http://rpc.test', { method: 'POST', body: '<not json>' });
    expect(rpcStats().byMethod.unknown).toBe(2);
    expect(rpcStats().requests).toBe(2);
  });

  it('sends a trade-path call ahead of queued background reads', async () => {
    // Fairness is the wrong policy here. A sell queued behind eighty curve
    // reads is a worse price; a curve read queued behind a sell costs nothing.
    const order: string[] = [];
    const transport = async (_i: unknown, init?: RequestInit): Promise<Response> => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(String(init?.body ?? '?'));
      return reply(200);
    };
    const f = createThrottledFetch(
      { maxConcurrent: 1, maxPerSecond: 0, maxRetries: 0 },
      transport as unknown as typeof fetch,
    );

    // Fill the single slot, queue several background reads behind it, then a
    // sell — which must overtake all of them.
    const inflight = f('http://rpc.test', { body: 'first' });
    const background = ['bg1', 'bg2', 'bg3'].map((b) => f('http://rpc.test', { body: b }));
    await new Promise((r) => setTimeout(r, 1));
    const sell = withRpcPriority(() => f('http://rpc.test', { body: 'SELL' }));

    await Promise.all([inflight, ...background, sell]);
    expect(order[0]).toBe('first');
    expect(order[1]).toBe('SELL');
    expect(rpcStats().priority).toBe(1);
  });

  it('lets a trade-path call borrow against the rate cap rather than wait', async () => {
    // The bucket is the other place a sell can be held up. Priority borrows and
    // the refill works the debt off, so the next background reads wait instead.
    const f = createThrottledFetch(
      { maxConcurrent: 8, maxPerSecond: 5, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    await Promise.all(Array.from({ length: 5 }, () => f('http://rpc.test'))); // drain

    const started = Date.now();
    await withRpcPriority(() => f('http://rpc.test', { body: 'SELL' }));
    expect(Date.now() - started).toBeLessThan(80); // would be ~200ms queued
  });

  it('bounds how far priority can overshoot the provider limit', async () => {
    // If priority could borrow without limit, a burst of exits would breach the
    // provider's cap outright and every one of them would 429.
    const f = createThrottledFetch(
      { maxConcurrent: 32, maxPerSecond: 5, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    await Promise.all(Array.from({ length: 5 }, () => f('http://rpc.test'))); // drain

    const started = Date.now();
    await withRpcPriority(() =>
      Promise.all(Array.from({ length: 12 }, () => f('http://rpc.test'))),
    );
    // Borrowing is capped, so the tail waits for the refill to work the debt
    // off rather than sailing past the provider's limit.
    expect(Date.now() - started).toBeGreaterThan(1200);
  });

  it('passes an ordinary error straight through without retrying', async () => {
    // A 400 is our bug, not congestion. Retrying it wastes the rate budget.
    let calls = 0;
    const f = createThrottledFetch(
      { maxConcurrent: 4, maxPerSecond: 0, maxRetries: 3 },
      (async () => {
        calls += 1;
        return reply(400);
      }) as unknown as typeof fetch,
    );

    expect((await f('http://rpc.test')).status).toBe(400);
    expect(calls).toBe(1);
  });

  it('releases the concurrency slot when the transport throws', async () => {
    // A leaked slot degrades into a total stall after enough failures.
    const f = createThrottledFetch(
      { maxConcurrent: 1, maxPerSecond: 0, maxRetries: 0 },
      (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    );

    for (let i = 0; i < 3; i++) {
      await expect(f('http://rpc.test')).rejects.toThrow(/socket hang up/);
    }
    // Still able to run: the semaphore did not lose its only slot.
    const ok = createThrottledFetch(
      { maxConcurrent: 1, maxPerSecond: 0, maxRetries: 0 },
      (async () => reply(200)) as unknown as typeof fetch,
    );
    expect((await ok('http://rpc.test')).status).toBe(200);
  });
});
