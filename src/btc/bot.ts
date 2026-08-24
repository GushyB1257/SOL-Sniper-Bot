import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { Store } from '../state/store.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { BtcData, HOUR_MS, type Candle } from './data.js';
import { buildCatalogue, type Strategy } from './strategies.js';
import { runBacktest, sweep, type BtcBacktestResult, type SweepRow } from './backtest.js';

const log = logger('btc');

/**
 * The Bitcoin strategy lab: backtest the classics, forward-test the winners.
 *
 * The other four bots trade a market where backtesting is impossible — every
 * memecoin's history is one launch long. Bitcoin is the opposite: a year of
 * hourly candles is free, so here the loop can be the right way round. The
 * catalogue is swept over history first, ranked on a train window, sanity-read
 * on a withheld test window, and only the winners graduate to spending time in
 * the forward paper test — which is the only number that was produced without
 * any ability to peek.
 *
 * There is deliberately NO Claude in this loop, and that is a design decision
 * rather than an omission. The tuner exists for the memecoin bots because
 * their evidence is scarce and expensive — forty trades of context an LLM must
 * squeeze. Here the evidence is 8,760 candles and the sweep tests the entire
 * parameter grid against all of it in about a second, every day, for free. A
 * proposer that suggests one change per measurement window cannot compete with
 * an optimizer that tries everything per day; adding the API bill back into
 * that loop would be paying for a worse search.
 */

/** One strategy's live forward-test state. */
interface ForwardState {
  id: string;
  /** Position through the most recently processed candle. */
  pos: -1 | 0 | 1;
  /** Price of the fill that opened the current position. */
  entryPrice: number;
  equityUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  startedAt: number;
  /** Open time of the last candle this strategy has decided on. */
  lastCandleT: number;
}

interface Fill {
  at: number;
  id: string;
  /** The position moved FROM -> TO, e.g. "flat -> long". */
  move: string;
  price: number;
  equityUsd: number;
}

interface LabFile {
  v: 1;
  sweepAt: number;
  rows: SweepRow[];
  benchmark: { train: BtcBacktestResult; test: BtcBacktestResult } | null;
  trainBars: number;
  testBars: number;
  top: string[];
  forward: Record<string, ForwardState>;
  fills: Fill[];
}

const EMPTY_LAB: LabFile = {
  v: 1,
  sweepAt: 0,
  rows: [],
  benchmark: null,
  trainBars: 0,
  testBars: 0,
  top: [],
  forward: {},
  fills: [],
};

export interface BtcBotDeps {
  cfg: Config;
  dataDir: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class BtcBot {
  readonly id = 'btc' as const;
  readonly name = 'Bitcoin Lab';
  readonly store: Store;

  /** The shared dashboard template's surfaces this bot has no use for. */
  readonly ai = null;
  readonly copy = null;
  readonly watcher = null;
  readonly positions = null;

  private readonly cfg: Config;
  private readonly now: () => number;
  private readonly data: BtcData;
  private readonly file: string;
  private lab: LabFile = { ...EMPTY_LAB, forward: {}, fills: [] };
  private strategies: Strategy[] = [];

  private started = false;
  private pausedFlag = false;
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private lastTickError = '';

  constructor(private readonly deps: BtcBotDeps) {
    this.cfg = deps.cfg;
    this.now = deps.now ?? Date.now;
    this.store = new Store(deps.dataDir, 'btc');
    this.data = new BtcData({
      dataDir: deps.dataDir,
      symbol: this.cfg.BTC_SYMBOL,
      fetchFn: deps.fetchFn,
      now: this.now,
    });
    this.file = join(deps.dataDir, 'btc-lab.json');
    this.load();
  }

  // ---- the shape the dashboard reads -----------------------------------

  get paused(): boolean {
    return this.pausedFlag;
  }

  get running(): boolean {
    return this.started;
  }

  setPaused(paused: boolean): void {
    this.pausedFlag = paused;
    log.info(`${this.name} ${paused ? 'PAUSED' : 'RESUMED'}`);
  }

  snapshotStats(): { seen: number; evaluated: number; rejected: number; bought: number; skipped: number } {
    return {
      seen: this.data.all().length,
      evaluated: this.lab.rows.length,
      rejected: Math.max(0, this.lab.rows.length - this.lab.top.length),
      bought: Object.values(this.lab.forward).reduce((a, f) => a + f.trades, 0),
      skipped: 0,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.error(`btc tick failed: ${errMessage(err)}`));
    }, this.cfg.BTC_POLL_INTERVAL_MS);
    this.timer.unref?.();
    log.info(
      `Bitcoin lab started: ${this.cfg.BTC_HISTORY_DAYS}d of ${this.cfg.BTC_SYMBOL} 1h candles, ` +
        `re-sweeping every ${this.cfg.BTC_SWEEP_HOURS}h, forward-testing top ${this.cfg.BTC_TOP_STRATEGIES}`,
    );
    void this.tick().catch((err) => log.error(`btc first tick failed: ${errMessage(err)}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  async tickPositions(): Promise<void> {
    /* positions advance on the candle clock, in tick() */
  }

  async tickStrategy(): Promise<void> {
    /* nothing on this cadence */
  }

  // ---- the loop ---------------------------------------------------------

  async tick(): Promise<void> {
    if (this.working || this.pausedFlag) return;
    this.working = true;
    try {
      await this.data.refresh(this.cfg.BTC_HISTORY_DAYS);
      const candles = this.data.closed();
      if (candles.length < 500) {
        this.lastTickError = this.data.lastError || `only ${candles.length} candles so far`;
        return;
      }
      this.lastTickError = this.data.lastError;

      this.rebuildStrategies(candles);

      if (this.now() - this.lab.sweepAt > this.cfg.BTC_SWEEP_HOURS * HOUR_MS) {
        this.runSweep(candles);
      }
      this.advanceForward(candles);
      this.save();
    } finally {
      this.working = false;
    }
  }

  /**
   * The catalogue closes over the candle array, so it is rebuilt whenever the
   * array identity changes. Cheap: indicator arrays are memoised inside it and
   * computed lazily, so an unused family costs nothing.
   */
  private candlesRef: readonly Candle[] | null = null;
  private rebuildStrategies(candles: readonly Candle[]): void {
    if (this.candlesRef === candles && this.strategies.length > 0) return;
    this.candlesRef = candles;
    this.strategies = buildCatalogue(
      { candles, closes: candles.map((c) => c.c) },
      this.cfg.BTC_ALLOW_SHORTS,
    );
  }

  private runSweep(candles: readonly Candle[]): void {
    const startedAt = this.now();
    const result = sweep(candles, this.strategies, {
      feeBps: this.cfg.BTC_FEE_BPS,
      slippageBps: this.cfg.BTC_SLIPPAGE_BPS,
    });

    // 'hold' never graduates to the forward test: it is the benchmark, and a
    // slot spent confirming that buy-and-hold holds is a slot wasted.
    const top = result.rows
      .filter((r) => r.id !== 'hold')
      .slice(0, this.cfg.BTC_TOP_STRATEGIES)
      .map((r) => r.id);

    this.lab.sweepAt = startedAt;
    this.lab.rows = result.rows;
    this.lab.benchmark = result.benchmark;
    this.lab.trainBars = result.trainBars;
    this.lab.testBars = result.testBars;
    this.lab.top = top;

    // New entrants start forward-testing now; incumbents keep their record.
    // A re-sweep must never reset a forward test — its whole value is that it
    // accumulates on data nobody could pick.
    for (const id of top) {
      if (!this.lab.forward[id]) {
        this.lab.forward[id] = {
          id,
          pos: 0,
          entryPrice: 0,
          equityUsd: this.cfg.BTC_PAPER_NOTIONAL_USD,
          peakEquityUsd: this.cfg.BTC_PAPER_NOTIONAL_USD,
          maxDrawdownPct: 0,
          trades: 0,
          wins: 0,
          startedAt,
          lastCandleT: candles[candles.length - 1]!.t,
        };
      }
    }

    log.info(
      `sweep: ${result.rows.length} strategies over ${candles.length} candles in ` +
        `${this.now() - startedAt}ms — best ${result.rows[0]!.label} ` +
        `(train ${result.rows[0]!.train.netPct.toFixed(1)}%, test ${result.rows[0]!.test.netPct.toFixed(1)}%)`,
    );
  }

  /**
   * Advances every forward tester over candles it has not yet decided on.
   *
   * Same signal function, same fill rule, same costs as the backtest — the
   * forward test IS the backtest run on candles that did not exist when the
   * strategy was picked, which is the only difference that matters.
   */
  private advanceForward(candles: readonly Candle[]): void {
    const costPerUnit = (this.cfg.BTC_FEE_BPS + this.cfg.BTC_SLIPPAGE_BPS) / 10_000;
    const indexOf = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) indexOf.set(candles[i]!.t, i);

    for (const f of Object.values(this.lab.forward)) {
      const strat = this.strategies.find((s) => s.id === f.id);
      if (!strat) continue;

      let i = (indexOf.get(f.lastCandleT) ?? -1) + 1;
      // A tester that was offline for longer than the cache window restarts
      // from the oldest candle held — with its position intact, marked to the
      // first price it sees. Better a small mark gap than a fabricated replay.
      if (i === 0) i = Math.max(strat.warmup, candles.length - 1);

      for (; i < candles.length; i++) {
        const c = candles[i]!;
        const prevClose = i > 0 ? candles[i - 1]!.c : c.o;

        // Mark to market over the hour just closed.
        if (f.pos !== 0) {
          f.equityUsd *= 1 + f.pos * ((c.c - prevClose) / prevClose);
        }

        const target = strat.signal(i, f.pos);
        if (target !== f.pos) {
          f.equityUsd *= 1 - Math.abs(target - f.pos) * costPerUnit;
          if (f.pos !== 0) {
            f.trades += 1;
            const won = f.pos === 1 ? c.c > f.entryPrice : c.c < f.entryPrice;
            if (won) f.wins += 1;
          }
          if (target !== 0) f.entryPrice = c.c;
          this.lab.fills.push({
            at: c.t + HOUR_MS,
            id: f.id,
            move: `${posName(f.pos)} -> ${posName(target)}`,
            price: c.c,
            equityUsd: f.equityUsd,
          });
          f.pos = target;
        }

        f.peakEquityUsd = Math.max(f.peakEquityUsd, f.equityUsd);
        f.maxDrawdownPct = Math.max(
          f.maxDrawdownPct,
          ((f.peakEquityUsd - f.equityUsd) / f.peakEquityUsd) * 100,
        );
        f.lastCandleT = c.t;
      }
    }

    if (this.lab.fills.length > 200) this.lab.fills = this.lab.fills.slice(-200);
  }

  // ---- persistence ------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LabFile>;
      if (parsed.v === 1) {
        this.lab = { ...EMPTY_LAB, ...parsed, forward: parsed.forward ?? {}, fills: parsed.fills ?? [] };
      }
    } catch (err) {
      log.warn(`lab state unreadable, starting fresh: ${errMessage(err)}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.lab), 'utf8');
    renameSync(tmp, this.file);
  }

  // ---- the tab ----------------------------------------------------------

  view(): BtcView {
    const candles = this.data.all();
    const last = candles[candles.length - 1];
    const price = last?.c ?? 0;

    const forward = Object.values(this.lab.forward)
      .map((f) => {
        const row = this.lab.rows.find((r) => r.id === f.id);
        return {
          id: f.id,
          label: row?.label ?? f.id,
          inTop: this.lab.top.includes(f.id),
          pos: posName(f.pos),
          equityUsd: f.equityUsd,
          netPct: (f.equityUsd / this.cfg.BTC_PAPER_NOTIONAL_USD - 1) * 100,
          maxDrawdownPct: f.maxDrawdownPct,
          trades: f.trades,
          winRatePct: f.trades > 0 ? (f.wins / f.trades) * 100 : 0,
          days: (this.now() - f.startedAt) / 86_400_000,
        };
      })
      .sort((a, b) => b.netPct - a.netPct);

    return {
      symbol: this.cfg.BTC_SYMBOL,
      priceUsd: price,
      candles: candles.length,
      firstCandleAt: candles[0]?.t ?? 0,
      lastCandleAt: last?.t ?? 0,
      source: this.data.lastHost,
      dataError: this.lastTickError,
      sweepAt: this.lab.sweepAt,
      nextSweepAt: this.lab.sweepAt + this.cfg.BTC_SWEEP_HOURS * HOUR_MS,
      trainBars: this.lab.trainBars,
      testBars: this.lab.testBars,
      benchmark: this.lab.benchmark,
      notionalUsd: this.cfg.BTC_PAPER_NOTIONAL_USD,
      feeBps: this.cfg.BTC_FEE_BPS + this.cfg.BTC_SLIPPAGE_BPS,
      // The whole table is large; the tab shows the interesting end of it.
      leaderboard: this.lab.rows.slice(0, 15).map((r) => ({
        id: r.id,
        label: r.label,
        family: r.family,
        inTop: this.lab.top.includes(r.id),
        trainNetPct: r.train.netPct,
        trainMaxDdPct: r.train.maxDrawdownPct,
        trainTrades: r.train.trades,
        testNetPct: r.test.netPct,
        testTrades: r.test.trades,
      })),
      forward,
      fills: this.lab.fills.slice(-25).reverse(),
    };
  }
}

function posName(p: -1 | 0 | 1): string {
  return p === 1 ? 'long' : p === -1 ? 'short' : 'flat';
}

export interface BtcView {
  symbol: string;
  priceUsd: number;
  candles: number;
  firstCandleAt: number;
  lastCandleAt: number;
  source: string;
  dataError: string;
  sweepAt: number;
  nextSweepAt: number;
  trainBars: number;
  testBars: number;
  benchmark: { train: BtcBacktestResult; test: BtcBacktestResult } | null;
  notionalUsd: number;
  feeBps: number;
  leaderboard: Array<{
    id: string;
    label: string;
    family: string;
    inTop: boolean;
    trainNetPct: number;
    trainMaxDdPct: number;
    trainTrades: number;
    testNetPct: number;
    testTrades: number;
  }>;
  forward: Array<{
    id: string;
    label: string;
    inTop: boolean;
    pos: string;
    equityUsd: number;
    netPct: number;
    maxDrawdownPct: number;
    trades: number;
    winRatePct: number;
    days: number;
  }>;
  fills: Array<{ at: number; id: string; move: string; price: number; equityUsd: number }>;
}
