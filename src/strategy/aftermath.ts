import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { TradeJournalEntry } from '../types.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { bondingCurvePda, decodeBondingCurve } from '../execution/bonding-curve.js';
import { PUMP_TOKEN_DECIMALS } from '../execution/pricing.js';
import { curveSpotPrice } from '../execution/bonding-curve.js';
import { PUMP_TOTAL_SUPPLY } from './position-manager.js';

const log = logger('aftermath');

/**
 * Watches tokens for a while after we sell them, and records the best they did.
 *
 * The journal says what a trade made. That alone cannot tell a good exit from a
 * lucky one: closing at +20% is a fine decision if the token then collapsed and
 * a bad one if it went on to 5x, and the two are indistinguishable in every
 * field the journal holds. Every exit rule in the bot is a guess about which of
 * those is happening, and until now nothing measured whether the guess was
 * right.
 *
 * Three things keep the cost near zero, which matters because the RPC budget is
 * already the binding constraint some of the time:
 *
 *  - One `getMultipleAccountsInfo` covers 100 mints, so tracking fifty closed
 *    tokens is ONE call per poll, not fifty.
 *  - The poll is slow by default. This measures a peak over minutes; there is
 *    nothing to race and no decision waiting on it.
 *  - It never takes the priority lane, and a failed poll is simply skipped. A
 *    measurement about the past must never compete with a live sell.
 *
 * State lives in the journal rather than in memory, so a restart resumes
 * tracking rather than losing every window that was open.
 */
export class AftermathTracker {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly pdas = new Map<string, PublicKey>();
  private lastErrorAt = 0;

  private stats = { polls: 0, tracked: 0, completed: 0, gone: 0, errors: 0 };

  constructor(
    private readonly conn: Connection,
    private readonly cfg: Config,
    private readonly stores: Map<string, Store>,
  ) {}

  get snapshot(): { polls: number; tracked: number; completed: number; gone: number; errors: number } {
    return { ...this.stats };
  }

  start(): void {
    if (this.timer || !this.cfg.AFTERMATH_ENABLED) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => log.error(`Aftermath poll failed: ${errMessage(err)}`));
    }, this.cfg.AFTERMATH_POLL_INTERVAL_MS);
    this.timer.unref?.();
    log.info(
      `Tracking sold tokens for ${this.cfg.AFTERMATH_WINDOW_MINUTES} min after exit, ` +
        `polling every ${Math.round(this.cfg.AFTERMATH_POLL_INTERVAL_MS / 1000)}s ` +
        '(measures whether exits are leaving money on the table)',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Cached PDA derivation — `findProgramAddressSync` hashes in a loop. */
  private pdaFor(mint: string): PublicKey | null {
    const hit = this.pdas.get(mint);
    if (hit) return hit;
    try {
      const pda = bondingCurvePda(new PublicKey(mint));
      this.pdas.set(mint, pda);
      if (this.pdas.size > 5000) this.pdas.clear();
      return pda;
    } catch {
      return null;
    }
  }

  /**
   * Splits recent trades into the ones still worth reading and the ones whose
   * window has run out.
   *
   * These have to be separated rather than filtered as one list. An earlier
   * version stopped scanning at the window edge, which meant a trade that had
   * just passed it was never looked at again — so `aftermathDone` was never
   * set, every row stayed provisional forever, and `buildAftermath` (which only
   * counts completed windows) had nothing to report. The feature would have
   * run, cost RPC, and produced an empty table.
   *
   * Closing a window needs no network at all, which is why it is its own pass.
   *
   * Read from the journal each poll rather than kept in a list, so a restart
   * resumes windows that were open when the process went down.
   */
  private scan(): {
    poll: Array<{ store: Store; entry: TradeJournalEntry }>;
    expired: Array<{ store: Store; entry: TradeJournalEntry }>;
  } {
    const windowMs = this.cfg.AFTERMATH_WINDOW_MINUTES * 60_000;
    const now = Date.now();
    const poll: Array<{ store: Store; entry: TradeJournalEntry }> = [];
    const expired: Array<{ store: Store; entry: TradeJournalEntry }> = [];

    // Bounded by entry count, not by time. A journal of ten thousand rows
    // should not be walked in full every fifteen seconds, and a bound in
    // ENTRIES still finalises windows that elapsed while the process was down
    // — which a bound in time would skip straight past.
    const horizon = this.cfg.AFTERMATH_MAX_TOKENS * 4;

    for (const store of this.stores.values()) {
      const journal = store.journal();
      const stop = Math.max(0, journal.length - horizon);
      for (let i = journal.length - 1; i >= stop; i--) {
        const entry = journal[i]!;
        if (entry.aftermathDone) continue;
        if (entry.exitPrice === undefined || entry.exitPrice <= 0) continue;
        if (now - entry.closedAt > windowMs) expired.push({ store, entry });
        else poll.push({ store, entry });
      }
    }
    return { poll: poll.slice(0, this.cfg.AFTERMATH_MAX_TOKENS), expired };
  }

  /**
   * Closes out finished windows. No RPC.
   *
   * A token that never traded above the exit is recorded as 0, not left
   * undefined. "It never went higher" is a real measurement and the most
   * informative one there is about an exit rule — dropping those rows would
   * leave the averages made up only of tokens that ran, which would make every
   * exit look like it was cutting winners.
   */
  private finaliseExpired(rows: Array<{ store: Store; entry: TradeJournalEntry }>): void {
    for (const { store, entry } of rows) {
      this.stats.completed += 1;
      store.amendJournal(entry.positionId, {
        aftermathDone: true,
        peakAfterExitPct: entry.peakAfterExitPct ?? 0,
        peakAfterExitSeconds: entry.peakAfterExitSeconds ?? 0,
        peakMcapSol: entry.peakMcapSol ?? entry.exitMcapSol,
      });
    }
  }

  async poll(): Promise<void> {
    // Overlapping polls would multiply RPC load exactly when the node is
    // already slow — the worst possible moment.
    if (this.polling) return;

    const { poll: due, expired } = this.scan();
    this.finaliseExpired(expired);

    this.stats.tracked = due.length;
    if (due.length === 0) return;

    this.polling = true;
    try {
      this.stats.polls += 1;

      for (let i = 0; i < due.length; i += 100) {
        const batch = due.slice(i, i + 100);
        const keyed = batch
          .map((b) => ({ ...b, pda: this.pdaFor(b.entry.mint) }))
          .filter((b): b is typeof b & { pda: PublicKey } => b.pda !== null);
        if (keyed.length === 0) continue;

        const infos = await this.conn.getMultipleAccountsInfo(
          keyed.map((k) => k.pda),
          'processed',
        );

        for (let j = 0; j < keyed.length; j++) {
          const { store, entry } = keyed[j]!;
          const info = infos[j];
          const elapsed = Date.now() - entry.closedAt;

          if (!info) {
            // No curve account: migrated to an AMM, or closed. Following it on
            // to Jupiter would cost one un-batched HTTP call per token per
            // poll, which is the entire cost advantage gone for a number that
            // is nice to have. Close the window with what was seen.
            this.stats.gone += 1;
            store.amendJournal(entry.positionId, { aftermathDone: true });
            continue;
          }

          const state = decodeBondingCurve(info.data);
          const price = state ? curveSpotPrice(state, PUMP_TOKEN_DECIMALS) : null;
          if (price !== null && price > 0) {
            const pct = ((price - entry.exitPrice!) / entry.exitPrice!) * 100;
            // Only ever record a NEW high. The field is the peak since exit, so
            // a later, lower reading must not overwrite it.
            if (pct > (entry.peakAfterExitPct ?? 0)) {
              store.amendJournal(entry.positionId, {
                peakAfterExitPct: pct,
                peakAfterExitSeconds: Math.round(elapsed / 1000),
                peakMcapSol: price * PUMP_TOTAL_SUPPLY,
              });
            }
          }

        }
      }
    } catch (err) {
      this.stats.errors += 1;
      // One line a minute. A rate-limited node fails every batch, and this is
      // the least important thing in the process to hear about.
      if (Date.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = Date.now();
        log.warn(`Aftermath poll failed: ${errMessage(err)}`);
      }
    } finally {
      this.polling = false;
    }
  }
}
