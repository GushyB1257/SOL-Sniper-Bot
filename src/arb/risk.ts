import { logger } from '../logger.js';
import type { ArbTradeResult, Opportunity } from './types.js';

const log = logger('arb:risk');

export interface ArbRiskLimits {
  /** Cumulative loss over a rolling day that halts trading. Positive lamports. */
  readonly maxDailyLossLamports: bigint;
  readonly maxConsecutiveFailures: number;
  readonly routeCooldownMs: number;
  readonly maxTradesPerHour: number;
  /** Lamports that must remain untouched, for fees and rent. */
  readonly minReserveLamports: bigint;
  readonly tradeSizeLamports: bigint;
}

export type ArbRiskDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Pre-trade gate and post-trade bookkeeping.
 *
 * Deliberately conservative. An arbitrage bot's failure mode is not one bad
 * trade — it is a fast loop repeating the same bad trade hundreds of times
 * before anyone looks. Every limit here exists to bound that loop, and the route
 * cooldown is the one that matters most: a dislocation that looked profitable
 * and was not will still look profitable on the very next scan.
 */
export class ArbRiskManager {
  private consecutiveFailures = 0;
  private realisedToday = 0n;
  private dayStart: number;
  private readonly routeCooldowns = new Map<string, number>();
  private readonly recentTrades: number[] = [];
  private haltReason: string | null = null;

  constructor(
    private limits: ArbRiskLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.dayStart = this.now();
  }

  /** Limits are read live from config, so a dashboard edit takes effect at once. */
  setLimits(limits: ArbRiskLimits): void {
    this.limits = limits;
  }

  get halted(): boolean {
    return this.haltReason !== null;
  }

  get haltedBecause(): string | null {
    return this.haltReason;
  }

  get dailyPnlLamports(): bigint {
    return this.realisedToday;
  }

  get failureStreak(): number {
    return this.consecutiveFailures;
  }

  get tradesLastHour(): number {
    this.pruneTradeWindow();
    return this.recentTrades.length;
  }

  halt(reason: string): void {
    this.haltReason = reason;
    log.warn(`Arbitrage halted: ${reason}`);
  }

  resume(): void {
    this.haltReason = null;
    this.consecutiveFailures = 0;
    log.info('Arbitrage resumed');
  }

  check(opportunity: Opportunity, balanceLamports: bigint | null): ArbRiskDecision {
    this.rolloverDay();

    if (this.haltReason) return { allowed: false, reason: `halted: ${this.haltReason}` };

    if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      this.halt(`${this.consecutiveFailures} consecutive failures`);
      return { allowed: false, reason: `halted: ${this.haltReason}` };
    }

    if (this.realisedToday <= -this.limits.maxDailyLossLamports) {
      this.halt(`daily loss limit reached (${this.realisedToday} lamports)`);
      return { allowed: false, reason: `halted: ${this.haltReason}` };
    }

    const cooldownUntil = this.routeCooldowns.get(routeKey(opportunity));
    if (cooldownUntil !== undefined && this.now() < cooldownUntil) {
      return { allowed: false, reason: `route cooling down for ${cooldownUntil - this.now()}ms` };
    }

    this.pruneTradeWindow();
    if (this.recentTrades.length >= this.limits.maxTradesPerHour) {
      return { allowed: false, reason: `hourly trade cap (${this.limits.maxTradesPerHour}) reached` };
    }

    if (opportunity.amountIn > this.limits.tradeSizeLamports) {
      return {
        allowed: false,
        reason: `size ${opportunity.amountIn} exceeds configured ${this.limits.tradeSizeLamports}`,
      };
    }

    if (balanceLamports !== null) {
      const required = opportunity.amountIn + this.limits.minReserveLamports;
      if (balanceLamports < required) {
        return {
          allowed: false,
          reason: `balance ${balanceLamports} below required ${required} (size + reserve)`,
        };
      }
    }

    if (opportunity.netProfit <= 0n) {
      return { allowed: false, reason: 'net profit is not positive' };
    }

    return { allowed: true };
  }

  /** Recorded when an attempt is dispatched, for the hourly cap. */
  recordAttempt(): void {
    this.recentTrades.push(this.now());
  }

  record(result: ArbTradeResult): void {
    this.rolloverDay();
    this.realisedToday += result.realisedProfit;

    if (result.status === 'filled') {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
        this.halt(`${this.consecutiveFailures} consecutive failures`);
      }
    }

    if (this.limits.routeCooldownMs > 0) {
      this.routeCooldowns.set(`${result.strategy}:${result.quoteMint}`, this.now() + this.limits.routeCooldownMs);
    }

    if (this.realisedToday <= -this.limits.maxDailyLossLamports) {
      this.halt(`daily loss limit reached (${this.realisedToday} lamports)`);
    }
  }

  private rolloverDay(): void {
    const DAY_MS = 24 * 60 * 60 * 1_000;
    if (this.now() - this.dayStart >= DAY_MS) {
      this.dayStart = this.now();
      this.realisedToday = 0n;
      // A new day clears the loss halt but NOT a failure-streak halt: repeated
      // failures usually mean a broken config, which time does not fix.
      if (this.haltReason?.startsWith('daily loss limit')) this.haltReason = null;
    }
  }

  private pruneTradeWindow(): void {
    const cutoff = this.now() - 60 * 60 * 1_000;
    while (this.recentTrades.length > 0 && this.recentTrades[0]! < cutoff) {
      this.recentTrades.shift();
    }
  }
}

function routeKey(opportunity: Opportunity): string {
  return `${opportunity.strategy}:${opportunity.quoteToken.mint}`;
}
