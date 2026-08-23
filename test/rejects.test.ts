import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '@solana/web3.js';
import { AftermathTracker } from '../src/strategy/aftermath.js';
import { Store } from '../src/state/store.js';
import { renderRejects } from '../src/tuner/evidence.js';
import { loadConfig, type Config } from '../src/config.js';
import type { RejectedCandidate } from '../src/types.js';
import { encodeCurveForTests } from './helpers/curve.js';

let dir: string;
let cfg: Config;
let store: Store;

const MINT = 'So11111111111111111111111111111111111111112';
const PRICE = 1e-7;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-rej-'));
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    AFTERMATH_WINDOW_MINUTES: '30',
  } as unknown as NodeJS.ProcessEnv);
  store = new Store(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reject = (over: Partial<RejectedCandidate> = {}): RejectedCandidate => ({
  mint: MINT,
  symbol: 'T',
  reason: 'min_holders',
  at: Date.now(),
  price: PRICE,
  ...over,
});

const conn = (multiple: number | null): Connection =>
  ({
    getMultipleAccountsInfo: async (keys: unknown[]) =>
      keys.map(() =>
        multiple === null ? null : { data: encodeCurveForTests(PRICE * multiple) },
      ),
  }) as unknown as Connection;

const tracker = (c: Connection): AftermathTracker =>
  new AftermathTracker(c, cfg, new Map([['sniper', store]]));

describe('following what the filters turned down', () => {
  it('records how far a rejected launch ran', async () => {
    store.recordReject(reject());
    await tracker(conn(2.5)).poll();
    expect(store.rejects()[0]!.peakPct).toBeCloseTo(150, 0);
  });

  it('keeps the high-water mark, not the latest price', async () => {
    store.recordReject(reject());
    await tracker(conn(4)).poll();
    await tracker(conn(1.1)).poll();
    expect(store.rejects()[0]!.peakPct).toBeCloseTo(300, 0);
  });

  it('closes a flat window at zero rather than dropping it', async () => {
    store.recordReject(reject({ at: Date.now() - 31 * 60_000 }));
    await tracker(conn(0.5)).poll();

    const row = store.rejects()[0]!;
    expect(row.done).toBe(true);
    // "It went nowhere either" is the finding that VINDICATES a filter.
    // Discarding those rows would leave the table made only of rejects that
    // ran, which would indict every filter the bot has.
    expect(row.peakPct).toBe(0);
  });

  it('treats a vanished curve on a reject as a migration, not a dead end', async () => {
    store.recordReject(reject());
    await tracker(conn(null)).poll();
    // A token whose curve is gone graduated to an AMM — it made it all the way
    // off the bonding curve after we turned it down. That is a result, and the
    // opposite of the "nothing to see" it means for a token we sold.
    expect(store.rejects()[0]!.done).toBe(true);
  });

  it('shares one batched read with the trade tracking', async () => {
    for (let i = 0; i < 25; i++) store.recordReject(reject({ at: Date.now() - i }));
    let calls = 0;
    const c = {
      getMultipleAccountsInfo: async (keys: unknown[]) => {
        calls += 1;
        return keys.map(() => ({ data: encodeCurveForTests(PRICE * 1.2) }));
      },
    } as unknown as Connection;

    await tracker(c).poll();
    expect(calls).toBe(1);
  });

  it('keeps a rolling window rather than a history', () => {
    for (let i = 0; i < 900; i++) store.recordReject(reject({ at: i }));
    // Rejections outnumber trades by orders of magnitude; this is a sample for
    // comparing buckets, not an audit trail, and it must not grow the state
    // file without bound.
    expect(store.rejects().length).toBe(600);
    expect(store.rejects()[0]!.at).toBe(300);
  });
});

describe('what the tuner is told about it', () => {
  const done = (reason: string, peakPct: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      store.recordReject(reject({ reason, at: Date.now() - i * 1000, peakPct, done: true, peakSeconds: 60 }));
    }
  };

  it('ranks filters by how often their rejects ran', () => {
    done('min_holders', 220, 14); // throwing away winners
    done('freeze_authority', 0, 18); // doing its job
    const text = renderRejects(store.rejects());

    expect(text).toMatch(/What the filters REJECTED/);
    // The filter whose rejects doubled must sort first — that is the finding.
    expect(text.indexOf('min_holders')).toBeLessThan(text.indexOf('freeze_authority'));
    expect(text).toMatch(/throwing away winners/);
  });

  it('warns that a doubling reject is not a forgone trade', () => {
    done('min_holders', 300, 25);
    // A token that doubled might still have been unsellable, or a honeypot the
    // filter was right about. The sample cannot see that, and the table has to
    // say so or it argues for switching every safety check off.
    expect(renderRejects(store.rejects())).toMatch(/not free trades|not be sellable|unsellable/);
  });

  it('says nothing until there is enough to read', () => {
    done('min_holders', 200, 5);
    const text = renderRejects(store.rejects());
    expect(text).toMatch(/not enough/);
    expect(text).not.toMatch(/doubled/);
  });

  it('excludes windows still open', () => {
    done('min_holders', 100, 22);
    store.recordReject(reject({ reason: 'pending', peakPct: 40 })); // no done flag
    expect(renderRejects(store.rejects())).not.toMatch(/pending/);
  });
});
