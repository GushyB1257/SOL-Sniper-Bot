import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backtest, backtestRuleset, actualResult } from '../src/tuner/backtest.js';
import { renderBacktests } from '../src/tuner/auto-tuner.js';
import { samplePath } from '../src/strategy/position-manager.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Position, PricePoint, TradeJournalEntry } from '../src/types.js';

let dir: string;
let cfg: Config;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

const ENTRY = 1e-7;

/** A trade whose price followed `multiples` of the entry, one per second. */
function trade(multiples: number[], over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  const path: PricePoint[] = multiples.map((m, i) => [i, ENTRY * m]);
  return {
    positionId: 'p' + Math.random(),
    mint: 'M',
    symbol: 'T',
    creator: 'D',
    openedAt: 0,
    closedAt: multiples.length * 1000,
    costSol: 0.25,
    proceedsSol: 0.25,
    pnlSol: 0,
    pnlPct: 0,
    closeReason: 'time_stop: flat',
    safetyScore: 80,
    holdSeconds: multiples.length,
    exitPrice: ENTRY * multiples[multiples.length - 1]!,
    path,
    ...over,
  };
}

/** Flat, then a steady climb to 3x — a run a patient strategy should catch. */
const RUNNER = [1, 1, 1.05, 1.2, 1.5, 1.9, 2.3, 2.7, 3, 3, 2.9];
/** Straight down. */
const DUMP = [1, 0.95, 0.8, 0.6, 0.45, 0.3, 0.25, 0.2, 0.2, 0.2, 0.2];

const stopAt = (pct: number) =>
  JSON.stringify([
    { when: [{ metric: 'gainPct', op: '<=', value: -pct }], sell: 'all', label: 'stop' },
  ]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-bt-'));
  cfg = loadConfig(env());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('replaying a strategy over recorded paths', () => {
  it('sells where the rule says, not where the old strategy did', () => {
    const rules = JSON.stringify([
      { when: [{ metric: 'gainPct', op: '>=', value: 100 }], sell: 'all', label: 'double_out' },
    ]);
    const r = backtestRuleset([trade(RUNNER)], cfg, rules).result!;

    expect(r.trades).toBe(1);
    expect(r.byReason['double_out']).toBe(1);
    // Sold at the first sample at or above 2x, which is 2.3x. Proceeds are the
    // whole position at that price, less real fees.
    expect(r.netSol).toBeGreaterThan(0.25 * 1.2);
  });

  it('charges the same costs live trading does', () => {
    // Exits immediately at entry price: a wash before fees, a loss after them.
    const flat = JSON.stringify([
      { when: [{ metric: 'heldSeconds', op: '>=', value: 0 }], sell: 'all', label: 'instant' },
    ]);
    const r = backtestRuleset([trade([1, 1, 1])], cfg, flat).result!;
    // The failure mode that has dominated this bot's results, and the one a
    // naive backtest hides by ignoring fees.
    expect(r.netSol).toBeLessThan(0);
  });

  it('counts a strategy that outlives the data as truncated, not as a win', () => {
    // A stop that never triggers on a runner: the position is still open when
    // the recording ends.
    const r = backtestRuleset([trade(RUNNER)], cfg, stopAt(90)).result!;

    expect(r.truncated).toBe(1);
    expect(r.coveragePct).toBe(0);
    expect(r.byReason['still_holding']).toBe(1);
  });

  it('reports coverage so a result resting on guesses says so', () => {
    // One trade resolves, one runs off the end.
    const r = backtestRuleset([trade(DUMP), trade(RUNNER)], cfg, stopAt(30)).result!;
    expect(r.trades).toBe(2);
    expect(r.coveragePct).toBe(50);
  });

  it('skips trades with no recorded path rather than inventing one', () => {
    const noPath = trade(RUNNER);
    delete noPath.path;
    const r = backtest([noPath, trade(DUMP)], cfg);
    expect(r.trades).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('keeps entries fixed — only the exit is re-decided', () => {
    // Both trades appear in every simulation regardless of outcome. A backtest
    // that also re-picked entries would be selecting trades using knowledge of
    // how they turned out, which is how every backtest becomes profitable.
    const journal = [trade(RUNNER), trade(DUMP)];
    expect(backtestRuleset(journal, cfg, stopAt(20)).result!.trades).toBe(2);
    expect(backtestRuleset(journal, cfg, stopAt(80)).result!.trades).toBe(2);
  });

  it('refuses to simulate an invalid ruleset', () => {
    const r = backtestRuleset([trade(RUNNER)], cfg, '[{"when":[],"sell":"all","label":"x"}]');
    expect(r.ok).toBe(false);
    expect(r.result).toBeUndefined();
  });

  it('distinguishes a tight stop from a loose one on the same trade', () => {
    const tight = backtestRuleset([trade(DUMP)], cfg, stopAt(10)).result!;
    const loose = backtestRuleset([trade(DUMP)], cfg, stopAt(50)).result!;
    // On a token going straight down, cutting sooner keeps more. If this ever
    // inverts, the replay is reading the path backwards.
    expect(tight.netSol).toBeGreaterThan(loose.netSol);
  });
});

describe('comparing against what actually happened', () => {
  it('measures the real trades on the same cost basis', () => {
    const journal = [trade(RUNNER, { pnlSol: 0.05, pnlPct: 20 })];
    const a = actualResult(journal);
    expect(a.trades).toBe(1);
    expect(a.expectancySol).toBeCloseTo(0.05, 5);
    expect(a.coveragePct).toBe(100);
  });

  it('says so plainly when there is not enough history to compare', () => {
    const text = renderBacktests([trade(RUNNER)], cfg);
    expect(text).toMatch(/not yet/);
    expect(text).not.toMatch(/SOL\/trade/);
  });

  it('renders a comparison once there is', () => {
    const journal = Array.from({ length: 30 }, () => trade(RUNNER, { pnlSol: -0.01 }));
    const text = renderBacktests(journal, cfg);

    expect(text).toMatch(/ACTUAL/);
    expect(text).toMatch(/ratchet/);
    expect(text).toMatch(/scalp/);
    // The two caveats that decide whether the table can be trusted.
    expect(text).toMatch(/only the EXIT is re-decided/);
    expect(text).toMatch(/reached a real exit/);
  });
});

describe('recording the path in the first place', () => {
  const position = (over: Partial<Position> = {}): Position =>
    ({
      id: 'p',
      mint: 'M',
      openedAt: 0,
      entryPrice: ENTRY,
      peakPrice: ENTRY,
      ...over,
    }) as Position;

  it('samples at the base interval, not on every tick', () => {
    const p = position();
    for (let ms = 0; ms <= 5000; ms += 100) samplePath(p, ENTRY, ms);
    // One per second across 0..5s inclusive — six samples, not the fifty ticks
    // that produced them.
    expect(p.path!.length).toBe(6);
    expect(p.path!.map((pt) => pt[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('widens the interval instead of growing without limit', () => {
    const p = position();
    for (let s = 0; s < 400; s++) samplePath(p, ENTRY * (1 + s / 100), s * 1000);

    expect(p.path!.length).toBeLessThanOrEqual(121);
    expect(p.pathIntervalSec).toBeGreaterThan(1);
    // Coverage is what must survive, not resolution. A path that kept the first
    // two minutes and dropped the rest would judge every patient strategy on
    // the opening seconds of its trades.
    expect(p.path![p.path!.length - 1]![0]).toBeGreaterThan(390);
    expect(p.path![0]![0]).toBe(0);
  });
});
