import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../logger.js';

const log = logger('tuner');

/** One parameter the tuner moved, and what it was before. */
export interface Change {
  key: string;
  /** Values are typed as written: a number, an enum string, or a boolean. */
  from: number | string | boolean;
  to: number | string | boolean;
  /** True when this parameter moves capital at risk rather than selection. */
  risk?: boolean;
  /** The model's stated reason, in its own words. */
  why: string;
  /** Set when the proposal had to be trimmed to stay inside the limits. */
  clamped?: string;
}

export type ExperimentStatus = 'running' | 'kept' | 'reverted' | 'abandoned';

/**
 * A change plus the measurement that decides whether it stays.
 *
 * This is the part that makes the loop honest. Without it, the tuner changes
 * something every cycle and the resulting data is a blend of every setting it
 * has ever tried — which means nothing can be attributed to anything and the
 * whole exercise is a random walk dressed up as learning. So: change one thing,
 * hold it still, measure the same statistic over the trades that follow, and
 * keep it only if it beat the baseline.
 */
export interface Experiment {
  id: string;
  bot: string;
  startedAt: number;
  changes: Change[];
  /** Expectancy in SOL per trade over the window BEFORE the change. */
  baselineExpectancy: number;
  baselineTrades: number;
  /** Journal length at the moment of the change, so the window is unambiguous. */
  journalAtStart: number;
  status: ExperimentStatus;
  /** Expectancy over the trades since, filled in when the verdict lands. */
  resultExpectancy?: number;
  resultTrades?: number;
  decidedAt?: number;
  verdict?: string;
  /** Things the model wanted changed but is not allowed to touch. */
  notes?: string[];
}

interface LedgerFile {
  version: 1;
  experiments: Experiment[];
}

const EMPTY: LedgerFile = { version: 1, experiments: [] };

/**
 * Append-only record of every change the tuner has made.
 *
 * Kept in its own file rather than a bot's store: it spans all three bots, and
 * it is the audit trail for software that edits its own trading parameters. If
 * you cannot answer "what changed, when, why, and did it help" from disk, the
 * feature should not be running.
 */
export class TuningLedger {
  private data: LedgerFile;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'tuning.json');
    mkdirSync(dirname(this.file), { recursive: true });
    this.data = this.read();
  }

  private read(): LedgerFile {
    if (!existsSync(this.file)) return { ...EMPTY, experiments: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
      return { version: 1, experiments: parsed.experiments ?? [] };
    } catch (err) {
      // Losing tuning history is survivable in a way that losing positions is
      // not, so this warns and carries on rather than refusing to start.
      log.warn(`Tuning ledger unreadable, starting a fresh one: ${String(err)}`);
      return { ...EMPTY, experiments: [] };
    }
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  all(): readonly Experiment[] {
    return this.data.experiments;
  }

  /** The experiment currently under measurement for a bot, if any. */
  running(bot: string): Experiment | undefined {
    return this.data.experiments.find((e) => e.bot === bot && e.status === 'running');
  }

  add(e: Experiment): void {
    this.data.experiments.push(e);
    // Keeping every experiment forever is fine in principle but the file is
    // read on every dashboard snapshot; a few hundred is plenty of history.
    if (this.data.experiments.length > 400) {
      this.data.experiments = this.data.experiments.slice(-400);
    }
    this.flush();
  }

  update(id: string, patch: Partial<Experiment>): void {
    const found = this.data.experiments.find((e) => e.id === id);
    if (!found) return;
    Object.assign(found, patch);
    this.flush();
  }
}
