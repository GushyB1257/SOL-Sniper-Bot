import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { CreatorRecord, Position, TradeJournalEntry } from '../types.js';
import { logger } from '../logger.js';

const log = logger('store');

interface Snapshot {
  version: 1;
  positions: Record<string, Position>;
  creators: Record<string, CreatorRecord>;
  journal: TradeJournalEntry[];
  /** UTC date string -> realised PnL in SOL, for the daily loss breaker. */
  dailyPnl: Record<string, number>;
  /** Rolling log of buys: [timestampMs, solSpent]. */
  spendLog: [number, number][];
  consecutiveLosses: number;
  breakerUntil: number;
}

const EMPTY: Snapshot = {
  version: 1,
  positions: {},
  creators: {},
  journal: [],
  dailyPnl: {},
  spendLog: [],
  consecutiveLosses: 0,
  breakerUntil: 0,
};

export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Flat-file JSON store. A sniper's state is small (tens of open positions,
 * thousands of journal rows), so a database would be ceremony. Writes are
 * atomic via write-to-temp-then-rename so a crash mid-write cannot leave a
 * truncated file that loses open positions.
 */
export class Store {
  private data: Snapshot;
  private readonly file: string;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * `namespace` keeps each bot's positions, journal and risk counters separate.
   * Without it three strategies share one daily loss limit and one P&L figure,
   * and you cannot tell which of them is actually making money.
   *
   * The screener keeps the original `state.json` filename so an existing run's
   * history survives the move to multiple bots.
   */
  constructor(dataDir: string, namespace = '') {
    const name = namespace && namespace !== 'screener' ? `state-${namespace}.json` : 'state.json';
    this.file = join(dataDir, name);
    mkdirSync(dirname(this.file), { recursive: true });
    this.data = this.read();
  }

  private read(): Snapshot {
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Snapshot>;
      return { ...structuredClone(EMPTY), ...parsed, version: 1 };
    } catch (err) {
      // Never start with a blank slate on a parse error — that would silently
      // abandon open positions holding real tokens.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, backup);
      log.error(`State file unreadable, moved to ${backup}. Refusing to start.`, err);
      throw new Error(
        `Corrupt state file. Inspect ${backup} for open positions before restarting.`,
      );
    }
  }

  /** Coalesces rapid mutations into one write per tick. */
  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  // --- positions ----------------------------------------------------------

  savePosition(p: Position): void {
    this.data.positions[p.id] = p;
    this.markDirty();
  }

  getPosition(id: string): Position | undefined {
    return this.data.positions[id];
  }

  openPositions(): Position[] {
    return Object.values(this.data.positions).filter(
      (p) => p.status === 'open' || p.status === 'closing',
    );
  }

  hasOpenPositionFor(mint: string): boolean {
    return this.openPositions().some((p) => p.mint === mint);
  }

  /** Have we ever touched this mint? Prevents re-buying a token we already dumped. */
  hasTraded(mint: string): boolean {
    return Object.values(this.data.positions).some((p) => p.mint === mint);
  }

  allPositions(): Position[] {
    return Object.values(this.data.positions);
  }

  creatorCount(): number {
    return Object.keys(this.data.creators).length;
  }

  // --- creator reputation -------------------------------------------------

  getCreator(address: string): CreatorRecord | undefined {
    return this.data.creators[address];
  }

  recordCreatorLaunch(address: string, mint: string): CreatorRecord {
    const now = Date.now();
    const rec = this.data.creators[address] ?? {
      address,
      launches: 0,
      rugs: 0,
      wins: 0,
      firstSeen: now,
      lastSeen: now,
      mints: [],
    };
    rec.launches += 1;
    rec.lastSeen = now;
    if (!rec.mints.includes(mint)) {
      rec.mints.push(mint);
      // Bound memory on prolific deployers.
      if (rec.mints.length > 50) rec.mints = rec.mints.slice(-50);
    }
    this.data.creators[address] = rec;
    this.markDirty();
    return rec;
  }

  recordCreatorOutcome(address: string, rugged: boolean): void {
    const rec = this.data.creators[address];
    if (!rec) return;
    if (rugged) rec.rugs += 1;
    else rec.wins += 1;
    this.markDirty();
  }

  // --- risk accounting ----------------------------------------------------

  recordSpend(sol: number): void {
    this.data.spendLog.push([Date.now(), sol]);
    const cutoff = Date.now() - 3_600_000;
    this.data.spendLog = this.data.spendLog.filter(([t]) => t >= cutoff);
    this.markDirty();
  }

  spendLastHour(): number {
    const cutoff = Date.now() - 3_600_000;
    return this.data.spendLog
      .filter(([t]) => t >= cutoff)
      .reduce((sum, [, amount]) => sum + amount, 0);
  }

  recordRealisedPnl(sol: number): void {
    const day = utcDay();
    this.data.dailyPnl[day] = (this.data.dailyPnl[day] ?? 0) + sol;
    if (sol < 0) this.data.consecutiveLosses += 1;
    else this.data.consecutiveLosses = 0;
    this.markDirty();
  }

  todayPnl(): number {
    return this.data.dailyPnl[utcDay()] ?? 0;
  }

  get consecutiveLosses(): number {
    return this.data.consecutiveLosses;
  }

  get breakerUntil(): number {
    return this.data.breakerUntil;
  }

  tripBreaker(untilMs: number): void {
    this.data.breakerUntil = untilMs;
    this.data.consecutiveLosses = 0;
    this.markDirty();
  }

  // --- journal ------------------------------------------------------------

  appendJournal(entry: TradeJournalEntry): void {
    this.data.journal.push(entry);
    this.markDirty();
  }

  journal(): readonly TradeJournalEntry[] {
    return this.data.journal;
  }
}
