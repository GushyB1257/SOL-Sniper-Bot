import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { CreatorRecord, Position, TradeJournalEntry, RejectedCandidate } from '../types.js';
import { logger } from '../logger.js';

const log = logger('store');

interface Snapshot {
  version: 1;
  positions: Record<string, Position>;
  creators: Record<string, CreatorRecord>;
  journal: TradeJournalEntry[];
  rejects: RejectedCandidate[];
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
  rejects: [],
  dailyPnl: {},
  spendLog: [],
  consecutiveLosses: 0,
  breakerUntil: 0,
};

export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Every store currently open, so an abrupt exit can still flush them.
 *
 * The debounce timer is `unref`'d — it must not hold the process open — which
 * means a mutation followed quickly by an exit had its write silently dropped.
 * An `exit` handler runs synchronously and `writeFileSync` works inside one, so
 * this is the last chance to get those bytes down.
 */
const OPEN_STORES = new Set<Store>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const store of OPEN_STORES) {
      try {
        store.flush();
      } catch {
        // Nothing useful left to do from inside an exit handler.
      }
    }
  });
}

/**
 * Flat-file JSON store. A sniper's state is small (tens of open positions,
 * thousands of journal rows), so a database would be ceremony.
 *
 * **Durability.** Writes go to a temp file that is **fsynced** before being
 * renamed into place. Rename alone is not enough: `writeFileSync` returns once
 * the bytes are in the OS page cache, not on disk, so a hard kill can publish a
 * directory entry pointing at content that was never written — which is exactly
 * how closing an editor produced a zero-length `state.json` and a refusal to
 * start. The fsync is the difference between atomic and durable.
 *
 * The previous good file is kept as `.bak` (a rename, so it costs no I/O), and a
 * read that cannot parse the live file recovers from it rather than giving up.
 * Refusing to start was the right instinct — never silently abandon open
 * positions — but it made every unclean shutdown a manual repair job, when the
 * last known good state was sitting right there.
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

    OPEN_STORES.add(this);
    installExitHook();
  }

  private get backupFile(): string {
    return `${this.file}.bak`;
  }

  /**
   * Loads the live file, falling back to the last good copy.
   *
   * Three states are treated as "nothing usable here" rather than as corruption:
   * absent, empty, and unparseable. An EMPTY file is the signature of exactly
   * the truncation this is guarding against, so it is not an error to explain —
   * it is a reason to reach for the backup.
   */
  private read(): Snapshot {
    // A leftover temp file means a previous write was interrupted. It is not the
    // live state and it is not a backup, so it is only noise on the next read.
    const tmp = `${this.file}.tmp`;
    if (existsSync(tmp)) {
      try {
        rmSync(tmp);
      } catch {
        // Harmless if it cannot be removed; it is never read.
      }
    }

    const live = this.tryRead(this.file);
    if (live) return live;

    const backup = this.tryRead(this.backupFile);
    if (backup) {
      log.warn(
        `${this.file} was missing or unreadable; recovered the previous good copy ` +
          `from ${this.backupFile}. Anything written since that copy is lost — ` +
          'check open positions against the chain.',
      );
      return backup;
    }

    // Nothing readable anywhere. If a live file exists it is genuinely damaged
    // and there is no known-good state to fall back on, so keep it for
    // inspection and refuse: starting blank would abandon open positions
    // holding real tokens.
    if (existsSync(this.file) && this.sizeOf(this.file) > 0) {
      const kept = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, kept);
      log.error(`State file unreadable and no usable backup. Moved to ${kept}.`);
      throw new Error(
        `Corrupt state file with no recoverable backup. Inspect ${kept} for open ` +
          'positions before restarting.',
      );
    }

    return structuredClone(EMPTY);
  }

  private tryRead(path: string): Snapshot | null {
    if (!existsSync(path) || this.sizeOf(path) === 0) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Snapshot>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return { ...structuredClone(EMPTY), ...parsed, version: 1 };
    } catch {
      return null;
    }
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
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

  /**
   * Final flush. Cancels the pending timer first so nothing writes after the
   * caller believes the store is done with — a deferred write into a directory
   * that has since been removed throws from inside a timer, where there is no
   * one left to catch it.
   */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    OPEN_STORES.delete(this);
  }

  flush(): void {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;

    // fsync before the rename, not after. Without it the rename can publish a
    // directory entry for content still sitting in the page cache, and a hard
    // kill then leaves a zero-length file where the state used to be.
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // Demote the current file to the backup before promoting the new one. Two
    // renames, so this costs directory metadata rather than a file copy — which
    // matters because this runs every 250ms while trading.
    //
    // There is a brief window here with no live file. `read()` covers it: a
    // missing live file falls back to the backup rather than starting blank.
    if (existsSync(this.file)) {
      try {
        renameSync(this.file, this.backupFile);
      } catch {
        // Losing the backup is survivable; failing to write is not.
      }
    }
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

  // --- rejected candidates -----------------------------------------------

  /**
   * Records a launch the filters refused, so it can be followed.
   *
   * Bounded hard. Rejections outnumber trades by orders of magnitude — the
   * sniper turns down most of what pump.fun deploys — so this keeps a rolling
   * window rather than a history. It is a sample for answering "are the filters
   * too tight", not an audit trail.
   */
  recordReject(r: RejectedCandidate, cap = 600): void {
    this.data.rejects ??= [];
    this.data.rejects.push(r);
    if (this.data.rejects.length > cap) {
      this.data.rejects = this.data.rejects.slice(-cap);
    }
    this.markDirty();
  }

  rejects(): readonly RejectedCandidate[] {
    return this.data.rejects ?? [];
  }

  amendReject(mint: string, at: number, patch: Partial<RejectedCandidate>): boolean {
    const row = (this.data.rejects ?? []).find((r) => r.mint === mint && r.at === at);
    if (!row) return false;
    Object.assign(row, patch);
    this.markDirty();
    return true;
  }

  /**
   * Amends one journal entry in place.
   *
   * The journal is append-only as a rule, and this is the one exception: what
   * a token did AFTER we sold is not knowable when the row is written, only
   * some minutes later. It amends nothing about the trade itself — no P&L, no
   * reason, no timing — so the record of what happened stays immutable and
   * only the observations that could not exist yet are filled in.
   */
  amendJournal(positionId: string, patch: Partial<TradeJournalEntry>): boolean {
    const entry = this.data.journal.find((t) => t.positionId === positionId);
    if (!entry) return false;
    Object.assign(entry, patch);
    this.markDirty();
    return true;
  }
}
