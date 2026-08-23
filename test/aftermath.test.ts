import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '@solana/web3.js';
import { AftermathTracker } from '../src/strategy/aftermath.js';
import { Store } from '../src/state/store.js';
import { buildEvidence, renderEvidence } from '../src/tuner/evidence.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TradeJournalEntry } from '../src/types.js';
import { encodeCurveForTests } from './helpers/curve.js';

let dir: string;
let cfg: Config;
let store: Store;

const MINT = 'So11111111111111111111111111111111111111112';
const EXIT_PRICE = 1e-7;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    AFTERMATH_WINDOW_MINUTES: '30',
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function closed(over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  return {
    positionId: 'p1',
    mint: MINT,
    symbol: 'TEST',
    creator: 'D',
    openedAt: Date.now() - 120_000,
    closedAt: Date.now() - 60_000,
    costSol: 0.25,
    proceedsSol: 0.3,
    pnlSol: 0.05,
    pnlPct: 20,
    closeReason: 'take_profit: tier 1',
    safetyScore: 80,
    holdSeconds: 60,
    exitPrice: EXIT_PRICE,
    exitMcapSol: EXIT_PRICE * 1_000_000_000,
    ...over,
  };
}

/** A connection whose batched read returns a curve at `priceMultiple` x exit. */
function connAt(multiple: number | null): Connection {
  return {
    getMultipleAccountsInfo: async (keys: unknown[]) =>
      keys.map(() => (multiple === null ? null : { data: encodeCurveForTests(EXIT_PRICE * multiple) })),
  } as unknown as Connection;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-aftermath-'));
  cfg = loadConfig(env());
  store = new Store(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const trackerWith = (conn: Connection, c: Config = cfg): AftermathTracker =>
  new AftermathTracker(conn, c, new Map([['screener', store]]));

describe('post-exit tracking', () => {
  it('records how far above the exit the token went', async () => {
    store.appendJournal(closed());
    await trackerWith(connAt(2.2)).poll();

    const row = store.journal()[0]!;
    // Sold at 50k mcap, ran to 110k: the number the whole feature exists for.
    expect(row.peakAfterExitPct).toBeCloseTo(120, 0);
    expect(row.peakMcapSol! / row.exitMcapSol!).toBeCloseTo(2.2, 1);
  });

  it('keeps the high-water mark rather than the latest reading', async () => {
    store.appendJournal(closed());
    await trackerWith(connAt(3)).poll();
    await trackerWith(connAt(1.1)).poll();

    // The field is the PEAK since exit. A later, lower price must not erase it
    // — otherwise a token that spiked and round-tripped reads as if it never
    // moved, which is the exact case that indicts an exit rule.
    expect(store.journal()[0]!.peakAfterExitPct).toBeCloseTo(200, 0);
  });

  it('leaves the window open until it has actually elapsed', async () => {
    store.appendJournal(closed());
    await trackerWith(connAt(1.5)).poll();
    expect(store.journal()[0]!.aftermathDone).toBeUndefined();
  });

  it('closes the window once it elapses, recording a flat run as zero', async () => {
    // Closed 31 minutes ago with a 30 minute window, and never traded higher.
    store.appendJournal(closed({ closedAt: Date.now() - 31 * 60_000 }));
    await trackerWith(connAt(0.4)).poll();

    const row = store.journal()[0]!;
    expect(row.aftermathDone).toBe(true);
    // Zero, not undefined. "It never went higher" is a real measurement, and
    // the most informative one there is about an exit rule — dropping it would
    // leave the averages made only of tokens that ran.
    expect(row.peakAfterExitPct).toBe(0);
  });

  it('closes the window when the curve is gone rather than chasing an AMM', async () => {
    store.appendJournal(closed());
    await trackerWith(connAt(null)).poll();

    // Migrated or closed. Following it to Jupiter costs one un-batched HTTP
    // call per token per poll, which spends the entire cost advantage of the
    // feature on a nice-to-have.
    expect(store.journal()[0]!.aftermathDone).toBe(true);
  });

  it('stops looking at trades past the window', async () => {
    store.appendJournal(closed({ positionId: 'old', closedAt: Date.now() - 5 * 3600_000 }));
    let calls = 0;
    const conn = {
      getMultipleAccountsInfo: async (keys: unknown[]) => {
        calls += 1;
        return keys.map(() => null);
      },
    } as unknown as Connection;

    await trackerWith(conn).poll();
    expect(calls).toBe(0);
  });

  it('reads one batch for many tokens, not one call each', async () => {
    for (let i = 0; i < 40; i++) {
      store.appendJournal(closed({ positionId: 'p' + i }));
    }
    let calls = 0;
    const conn = {
      getMultipleAccountsInfo: async (keys: unknown[]) => {
        calls += 1;
        expect(keys.length).toBe(40);
        return keys.map(() => ({ data: encodeCurveForTests(EXIT_PRICE * 1.5) }));
      },
    } as unknown as Connection;

    await trackerWith(conn).poll();
    // The cost argument for the whole feature. Forty tracked tokens is ONE RPC
    // call, so this never competes with anything on the trade path.
    expect(calls).toBe(1);
  });

  it('ignores trades with no exit price to measure against', async () => {
    store.appendJournal(closed({ exitPrice: undefined }));
    let calls = 0;
    const conn = {
      getMultipleAccountsInfo: async (keys: unknown[]) => {
        calls += 1;
        return keys.map(() => null);
      },
    } as unknown as Connection;

    await trackerWith(conn).poll();
    expect(calls).toBe(0);
  });
});

describe('what the tuner sees', () => {
  const done = (over: Partial<TradeJournalEntry>): TradeJournalEntry =>
    closed({ aftermathDone: true, peakAfterExitSeconds: 45, ...over });

  it('groups the upside given up by which exit rule fired', () => {
    // A take-profit that keeps selling into runs, and a stop that keeps
    // getting out of tokens that were genuinely finished.
    for (let i = 0; i < 12; i++) {
      store.appendJournal(
        done({ positionId: 'tp' + i, closeReason: 'take_profit: tier 1', peakAfterExitPct: 180 }),
      );
    }
    for (let i = 0; i < 14; i++) {
      store.appendJournal(
        done({ positionId: 'sl' + i, closeReason: 'stop_loss: down -20%', peakAfterExitPct: 0 }),
      );
    }

    const a = buildEvidence('screener', store.journal(), cfg).aftermath!;
    const tp = a.byExitReason.find((r) => r.key === 'take_profit')!;
    const sl = a.byExitReason.find((r) => r.key === 'stop_loss')!;

    expect(tp.medianPeakPct).toBe(180);
    // 180% above the exit — all twelve went on to nearly triple after we sold.
    expect(tp.doubled).toBe(12);
    // The decisive contrast: the stop is doing its job, the take-profit is not.
    expect(sl.neverHigher).toBe(14);
    expect(sl.medianPeakPct).toBe(0);

    const text = renderEvidence(buildEvidence('screener', store.journal(), cfg));
    expect(text).toMatch(/What the token did AFTER each exit/);
    expect(text).toMatch(/cutting winners/);
  });

  it('excludes windows that have not finished forming', () => {
    store.appendJournal(done({ positionId: 'a', peakAfterExitPct: 200 }));
    store.appendJournal(closed({ positionId: 'b' })); // still tracking

    const a = buildEvidence('screener', store.journal(), cfg).aftermath!;
    // A peak still forming is not a peak. Averaging half-measured trades in
    // would bias every number toward zero — in exactly the direction that
    // argues for selling even earlier.
    expect(a.samples).toBe(1);
    expect(a.pending).toBe(1);
  });

  it('reports a median, so one moonshot cannot speak for a whole bucket', () => {
    for (let i = 0; i < 9; i++) {
      store.appendJournal(done({ positionId: 'x' + i, peakAfterExitPct: 5 }));
    }
    store.appendJournal(done({ positionId: 'moon', peakAfterExitPct: 4000 }));

    const a = buildEvidence('screener', store.journal(), cfg).aftermath!;
    const b = a.byExitReason[0]!;
    expect(b.medianPeakPct).toBe(5);
    expect(b.avgPeakPct).toBeGreaterThan(400); // what a mean would have claimed
    expect(b.doubled).toBe(1);
  });

  it('says nothing at all until a window has completed', () => {
    store.appendJournal(closed());
    expect(buildEvidence('screener', store.journal(), cfg).aftermath).toBeUndefined();
    expect(renderEvidence(buildEvidence('screener', store.journal(), cfg))).not.toMatch(
      /AFTER each exit/,
    );
  });
});
