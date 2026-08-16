import { describe, it, expect, beforeEach } from 'vitest';
import { createThrottledFetch, rpcStats, resetRpcStatsForTests } from '../src/util/rpc-throttle.js';

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
    // The bucket starts full, so 20 go instantly and the next 10 wait ~500ms.
    await Promise.all(Array.from({ length: 30 }, () => f('http://rpc.test')));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(300);
    expect(rpcStats().requests).toBe(30);
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
