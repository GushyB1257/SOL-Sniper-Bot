import type { TokenCandidate } from '../types.js';
import type { Config } from '../config.js';

/** A single trade observed on a watched token. */
export interface ObservedTrade {
  mint: string;
  trader: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  vSolInCurve?: number;
  marketCapSol?: number;
  at: number;
}

export interface PriceSample {
  at: number;
  /** Virtual SOL in the curve — a monotonic proxy for price on pump.fun. */
  vSol: number;
}

/** Live traction state for one watched token. */
export interface TrackedToken {
  candidate: TokenCandidate;
  firstSeen: number;
  lastTradeAt: number;

  buyCount: number;
  sellCount: number;
  buyVolumeSol: number;
  sellVolumeSol: number;

  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  /** Buyers seen in the most recent window, for detecting a stalling wave. */
  recentBuyers: Array<{ trader: string; at: number }>;

  samples: PriceSample[];
  latestVSol: number;
  peakVSol: number;

  /** True once the deployer has been observed selling. */
  deployerSold: boolean;
  deployerSoldSol: number;

  /** Set once this token has been sent to the analyst, so it is not re-sent. */
  analysed: boolean;
}

export interface TractionMetrics {
  ageSeconds: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  /** Buy volume ÷ sell volume. Infinity when nothing has sold yet. */
  volumeRatio: number;
  /** Unique buyers arriving in the last 60s. The wave, measured. */
  buyersLast60s: number;
  /** Unique buyers in the 60s before that, for the trend. */
  buyersPrev60s: number;
  /** Percent change in price since we started watching. */
  priceChangePct: number;
  /** Percent below the peak we have seen. */
  drawdownFromPeakPct: number;
  /** SOL currently in the curve. */
  curveSol: number;
  /** Rough progress toward graduation (~85 virtual SOL). */
  curveProgressPct: number;
  deployerSold: boolean;
  deployerSoldSol: number;
  /** Average SOL per buy — large averages mean few whales, not a crowd. */
  avgBuySizeSol: number;
}

const GRADUATION_VSOL = 85;
const RECENT_WINDOW_MS = 60_000;

/**
 * Tracks freshly-launched tokens and surfaces the ones showing real traction.
 *
 * This is the architectural core of the strategy. Buying at creation is a
 * latency race that a laptop loses. Instead every launch goes on a watchlist,
 * its trades are tracked, and only tokens that survive their first minutes AND
 * show organic interest are promoted for analysis. That is a judgment problem
 * rather than a speed problem — which is the shape an LLM can actually help
 * with, and where a two-second inference delay costs nothing.
 *
 * The deterministic gate here matters for cost as well as quality: thousands of
 * launches a day reach the watchlist, and only the handful that clear these
 * thresholds are ever worth an API call.
 */
export class Watchlist {
  private tokens = new Map<string, TrackedToken>();

  constructor(private readonly cfg: Config) {}

  get size(): number {
    return this.tokens.size;
  }

  has(mint: string): boolean {
    return this.tokens.has(mint);
  }

  get(mint: string): TrackedToken | undefined {
    return this.tokens.get(mint);
  }

  /** All mints currently watched, for the trade-feed subscription. */
  mints(): string[] {
    return [...this.tokens.keys()];
  }

  add(candidate: TokenCandidate): boolean {
    if (this.tokens.has(candidate.mint)) return false;
    if (this.tokens.size >= this.cfg.WATCHLIST_MAX_SIZE) return false;

    const now = Date.now();
    const vSol = candidate.vSolInBondingCurve ?? 30;
    this.tokens.set(candidate.mint, {
      candidate,
      firstSeen: now,
      lastTradeAt: now,
      buyCount: 0,
      sellCount: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      uniqueBuyers: new Set(),
      uniqueSellers: new Set(),
      recentBuyers: [],
      samples: [{ at: now, vSol }],
      latestVSol: vSol,
      peakVSol: vSol,
      deployerSold: false,
      deployerSoldSol: 0,
      analysed: false,
    });
    return true;
  }

  recordTrade(trade: ObservedTrade): void {
    const t = this.tokens.get(trade.mint);
    if (!t) return;

    t.lastTradeAt = trade.at;

    if (trade.side === 'buy') {
      t.buyCount += 1;
      t.buyVolumeSol += trade.solAmount;
      t.uniqueBuyers.add(trade.trader);
      t.recentBuyers.push({ trader: trade.trader, at: trade.at });
      // Two windows' worth is all the trend calculation needs.
      const cutoff = trade.at - RECENT_WINDOW_MS * 2;
      if (t.recentBuyers.length > 400) {
        t.recentBuyers = t.recentBuyers.filter((b) => b.at >= cutoff);
      }
    } else {
      t.sellCount += 1;
      t.sellVolumeSol += trade.solAmount;
      t.uniqueSellers.add(trade.trader);
      // The deployer selling is the single most important event on a launch.
      if (trade.trader === t.candidate.creator) {
        t.deployerSold = true;
        t.deployerSoldSol += trade.solAmount;
      }
    }

    if (trade.vSolInCurve !== undefined && trade.vSolInCurve > 0) {
      t.latestVSol = trade.vSolInCurve;
      if (trade.vSolInCurve > t.peakVSol) t.peakVSol = trade.vSolInCurve;
      t.samples.push({ at: trade.at, vSol: trade.vSolInCurve });
      if (t.samples.length > 300) t.samples = t.samples.slice(-300);
    }
  }

  metrics(t: TrackedToken, now = Date.now()): TractionMetrics {
    const ageSeconds = (now - t.firstSeen) / 1000;
    const firstVSol = t.samples[0]?.vSol ?? 30;

    const recentCut = now - RECENT_WINDOW_MS;
    const prevCut = now - RECENT_WINDOW_MS * 2;
    const recent = new Set<string>();
    const prev = new Set<string>();
    for (const b of t.recentBuyers) {
      if (b.at >= recentCut) recent.add(b.trader);
      else if (b.at >= prevCut) prev.add(b.trader);
    }

    return {
      ageSeconds,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      uniqueBuyers: t.uniqueBuyers.size,
      uniqueSellers: t.uniqueSellers.size,
      buyVolumeSol: t.buyVolumeSol,
      sellVolumeSol: t.sellVolumeSol,
      volumeRatio: t.sellVolumeSol > 0 ? t.buyVolumeSol / t.sellVolumeSol : Infinity,
      buyersLast60s: recent.size,
      buyersPrev60s: prev.size,
      // Price on a constant-product curve scales with vSol², so the reserve
      // ratio squared is the price ratio.
      priceChangePct: firstVSol > 0 ? ((t.latestVSol / firstVSol) ** 2 - 1) * 100 : 0,
      drawdownFromPeakPct:
        t.peakVSol > 0 ? ((t.latestVSol / t.peakVSol) ** 2 - 1) * 100 : 0,
      curveSol: t.latestVSol,
      curveProgressPct: Math.min(100, (t.latestVSol / GRADUATION_VSOL) * 100),
      deployerSold: t.deployerSold,
      deployerSoldSol: t.deployerSoldSol,
      avgBuySizeSol: t.buyCount > 0 ? t.buyVolumeSol / t.buyCount : 0,
    };
  }

  /**
   * Tokens that have earned an analyst call.
   *
   * Every threshold here is a cheap deterministic filter standing in front of a
   * paid API call. Loosen them and the bill rises without the hit rate
   * following; tighten them and nothing is ever evaluated.
   */
  graduates(now = Date.now()): Array<{ token: TrackedToken; metrics: TractionMetrics }> {
    const out: Array<{ token: TrackedToken; metrics: TractionMetrics }> = [];

    for (const t of this.tokens.values()) {
      if (t.analysed) continue;

      const m = this.metrics(t, now);

      // Too young to have a signal; too old and the move has happened.
      if (m.ageSeconds < this.cfg.WATCH_MIN_AGE_SECONDS) continue;
      if (m.ageSeconds > this.cfg.WATCH_MAX_AGE_SECONDS) continue;

      // A crowd, not a handful of wallets.
      if (m.uniqueBuyers < this.cfg.MIN_UNIQUE_BUYERS) continue;
      if (m.buyVolumeSol < this.cfg.MIN_BUY_VOLUME_SOL) continue;

      // Still alive: not already dumped below where we started watching.
      if (m.priceChangePct < this.cfg.MIN_PRICE_CHANGE_PCT) continue;

      // Buyers must still be arriving — a stalled wave is not a setup.
      if (m.buyersLast60s < this.cfg.MIN_RECENT_BUYERS) continue;

      // Obvious disqualifiers, checked before spending a call rather than
      // asking the model to notice them.
      if (m.deployerSold) continue;
      if (m.sellCount > m.buyCount) continue;

      out.push({ token: t, metrics: m });
    }

    // Strongest flow first, so the position cap is spent on the best candidates.
    return out.sort((a, b) => b.metrics.buyVolumeSol - a.metrics.buyVolumeSol);
  }

  markAnalysed(mint: string): void {
    const t = this.tokens.get(mint);
    if (t) t.analysed = true;
  }

  /** Drops tokens that are too old to be interesting or have gone silent. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [mint, t] of this.tokens) {
      const ageSeconds = (now - t.firstSeen) / 1000;
      const silentSeconds = (now - t.lastTradeAt) / 1000;
      if (
        ageSeconds > this.cfg.WATCH_MAX_AGE_SECONDS * 2 ||
        (silentSeconds > 120 && t.buyCount === 0)
      ) {
        this.tokens.delete(mint);
        removed += 1;
      }
    }
    return removed;
  }
}
