import { existsSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import { logger } from '../logger.js';

const log = logger('risk');

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * The layer that decides whether the bot is allowed to open a position at all,
 * independent of how good the token looks.
 *
 * Sniping is a negative-skew game played at high frequency: the failure mode is
 * not one bad trade, it is forty bad trades in an hour while nobody is watching.
 * Every limit here exists to bound that.
 */
export class RiskManager {
  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    /** Path to a sentinel file; if it exists, all trading halts. */
    private readonly killSwitchPath = 'STOP',
  ) {}

  /** Per-bot pause, toggled from the dashboard. Separate from the kill switch. */
  private paused = false;

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Checked before every buy. Cheap, synchronous, no I/O beyond a stat. */
  canOpen(walletBalanceSol: number): RiskDecision {
    // Pausing stops NEW entries only. Open positions keep being managed, since
    // abandoning them mid-flight is how a paused bot turns into a stuck bag.
    if (this.paused) return { allowed: false, reason: 'bot paused' };

    if (existsSync(this.killSwitchPath)) {
      return { allowed: false, reason: `kill switch present (${this.killSwitchPath})` };
    }

    const now = Date.now();
    if (now < this.store.breakerUntil) {
      const mins = Math.ceil((this.store.breakerUntil - now) / 60_000);
      return { allowed: false, reason: `circuit breaker active for another ${mins}m` };
    }

    const open = this.store.openPositions().length;
    if (open >= this.cfg.MAX_CONCURRENT_POSITIONS) {
      return {
        allowed: false,
        reason: `at position limit (${open}/${this.cfg.MAX_CONCURRENT_POSITIONS})`,
      };
    }

    const todayPnl = this.store.todayPnl();
    if (todayPnl <= -this.cfg.DAILY_LOSS_LIMIT_SOL) {
      return {
        allowed: false,
        reason: `daily loss limit hit (${todayPnl.toFixed(3)} SOL today, limit -${this.cfg.DAILY_LOSS_LIMIT_SOL})`,
      };
    }

    const hourSpend = this.store.spendLastHour();
    if (hourSpend + this.cfg.BUY_AMOUNT_SOL > this.cfg.HOURLY_SPEND_CAP_SOL) {
      return {
        allowed: false,
        reason: `hourly spend cap reached (${hourSpend.toFixed(3)}/${this.cfg.HOURLY_SPEND_CAP_SOL} SOL)`,
      };
    }

    const needed = this.cfg.BUY_AMOUNT_SOL + this.cfg.MIN_WALLET_RESERVE_SOL;
    if (walletBalanceSol < needed) {
      return {
        allowed: false,
        reason: `insufficient balance: ${walletBalanceSol.toFixed(4)} SOL, need ${needed.toFixed(4)} (incl. reserve)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Called after every closed position. Trips the breaker on a losing streak —
   * a run of losses usually means market conditions changed, not that the next
   * trade is due to win.
   */
  recordOutcome(pnlSol: number): void {
    this.store.recordRealisedPnl(pnlSol);

    if (this.store.consecutiveLosses >= this.cfg.MAX_CONSECUTIVE_LOSSES) {
      const until = Date.now() + this.cfg.BREAKER_COOLDOWN_SECONDS * 1000;
      this.store.tripBreaker(until);
      log.warn(
        `Circuit breaker tripped after ${this.cfg.MAX_CONSECUTIVE_LOSSES} consecutive losses. ` +
          `Paused until ${new Date(until).toISOString()}`,
      );
    }

    const today = this.store.todayPnl();
    if (today <= -this.cfg.DAILY_LOSS_LIMIT_SOL) {
      log.warn(`Daily loss limit reached (${today.toFixed(3)} SOL). No new entries today.`);
    }
  }

  /** Position size. Flat by default; the hook is here for future scaling. */
  sizeFor(_safetyScore: number): number {
    return this.cfg.BUY_AMOUNT_SOL;
  }
}
