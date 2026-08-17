import type { Config } from '../config.js';
import { poolAllowed, type Pool } from '../types.js';
import { volumeOf, type TrackedToken } from '../watchlist/watchlist.js';

/**
 * The screener entry.
 *
 * This is a direct translation of the filter a human sits and watches: pump
 * standard coins only, above a volume floor, above a market-cap floor, with at
 * least one social. The observed behaviour of tokens crossing that filter is
 * that they pop for a few seconds and then do one of three things — crash,
 * stall and then crash, or bond. So the job here is to be *in* at the crossing,
 * and the exit's job is to be out before the crash. Nothing in this file is
 * predictive; it is a stopwatch on a condition.
 *
 * It is a pure function over already-collected state, so it runs on every trade
 * event in microseconds. The one thing it cannot answer locally is socials —
 * that needs an HTTP fetch — so it reports `needs-socials` instead of guessing,
 * and the caller kicks off the fetch. Ordering the checks so socials come last
 * means the fetch is only ever paid for by tokens that already cleared
 * everything else, which is a few dozen a day rather than thousands.
 */

export interface ScreenSnapshot {
  pool: Pool;
  ageSeconds: number;
  volumeSol: number;
  volumeUsd: number;
  marketCapSol: number;
  marketCapUsd: number;
  /** Distinct wallets that have bought since we started watching. */
  buyers: number;
  socials: number;
  socialsChecked: boolean;
  /** The metadata could not be read at all, as opposed to having no links. */
  socialsUnavailable: boolean;
  deployerSold: boolean;

  // --- flow and shape, all free: computed from state already collected ---
  /** Seconds since any trade. Volume with no flow behind it is a dead token. */
  secondsSinceTrade: number;
  /** Percent below the highest price seen. Negative or zero. */
  drawdownFromPeakPct: number;
  /** Buyers in the last 60s over the 60s before. Above 1 means still building. */
  buyerAcceleration: number;
  /** Buy volume minus sell volume, in SOL. */
  netFlowSol: number;
  /** Average SOL per buy. */
  avgBuySol: number;
  /** Largest single buy, in SOL. */
  largestBuySol: number;
  /** Wallets that bought more than once. */
  repeatBuyers: number;
  /** Progress toward graduating off the bonding curve, 0-100. */
  curveProgressPct: number;
  /**
   * How many of the wallets the copy trader tracks are holding this token.
   *
   * The copy bot already reads those balances every second, so this costs
   * nothing — and it is the one signal here that is genuinely not available to
   * anyone screening the same public data.
   */
  copyHolders: number;
}

/**
 * `needs-socials` is deliberately distinct from `reject`: the token has passed
 * everything measurable and the only unknown is one HTTP call away, so the
 * caller should fetch rather than move on.
 */
export type ScreenOutcome = 'fire' | 'reject' | 'needs-socials';

export interface ScreenVerdict {
  outcome: ScreenOutcome;
  fire: boolean;
  /** Human-readable trigger, or the first filter that failed. */
  reason: string;
  snapshot: ScreenSnapshot;
}

export function screenSnapshot(
  t: TrackedToken,
  solUsd: number,
  now = Date.now(),
  copyHolders = 0,
): ScreenSnapshot {
  const volumeSol = volumeOf(t);
  const marketCapSol = t.latestMarketCapSol;

  const recentCut = now - 60_000;
  const prevCut = now - 120_000;
  const recent = new Set<string>();
  const prev = new Set<string>();
  for (const b of t.recentBuyers) {
    if (b.at >= recentCut) recent.add(b.trader);
    else if (b.at >= prevCut) prev.add(b.trader);
  }
  let repeatBuyers = 0;
  for (const count of t.buysPerWallet.values()) if (count > 1) repeatBuyers += 1;

  return {
    pool: t.candidate.pool,
    ageSeconds: (now - t.firstSeen) / 1000,
    volumeSol,
    volumeUsd: volumeSol * solUsd,
    marketCapSol,
    marketCapUsd: marketCapSol * solUsd,
    buyers: t.uniqueBuyers.size,
    socials: t.socials.count,
    socialsChecked: t.socials.checked,
    socialsUnavailable: t.socials.failed,
    deployerSold: t.deployerSold,

    secondsSinceTrade: t.lastTradeAt > 0 ? (now - t.lastTradeAt) / 1000 : (now - t.firstSeen) / 1000,
    // Price on a constant-product curve scales with vSol², so the reserve
    // ratio squared is the price ratio.
    drawdownFromPeakPct: t.peakVSol > 0 ? ((t.latestVSol / t.peakVSol) ** 2 - 1) * 100 : 0,
    buyerAcceleration: prev.size > 0 ? recent.size / prev.size : recent.size > 0 ? Infinity : 0,
    netFlowSol: t.buyVolumeSol - t.sellVolumeSol,
    avgBuySol: t.buyCount > 0 ? t.buyVolumeSol / t.buyCount : 0,
    largestBuySol: t.largestBuySol,
    repeatBuyers,
    curveProgressPct: Math.min(100, (t.latestVSol / 85) * 100),
    copyHolders,
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '\u221e';
}

function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Does this token match the filter right now?
 *
 * Checks are ordered cheapest-and-most-selective first. The order does not
 * change the verdict, only which rejection reason is reported — which is the
 * whole value of the debug log when nothing is firing.
 */
export function screenerSignal(
  t: TrackedToken,
  cfg: Config,
  solUsd: number,
  now = Date.now(),
  copyHolders = 0,
): ScreenVerdict {
  const s = screenSnapshot(t, solUsd, now, copyHolders);
  const reject = (reason: string): ScreenVerdict => ({
    outcome: 'reject',
    fire: false,
    reason,
    snapshot: s,
  });

  if (!poolAllowed(cfg.SCREEN_ALLOWED_POOLS, s.pool)) {
    return reject(`pool ${s.pool} not in ${cfg.SCREEN_ALLOWED_POOLS.join('/')}`);
  }

  // The deployer selling ends it regardless of what the numbers say. This is
  // not part of the user-facing filter; it is the one disqualifier that a human
  // watching a screener would also act on instantly.
  if (s.deployerSold) return reject('deployer sold');

  if (s.ageSeconds < cfg.SCREEN_MIN_AGE_SECONDS) {
    return reject(`${s.ageSeconds.toFixed(0)}s old (min ${cfg.SCREEN_MIN_AGE_SECONDS}s)`);
  }
  if (s.ageSeconds > cfg.SCREEN_MAX_AGE_SECONDS) {
    return reject(`${s.ageSeconds.toFixed(0)}s old (max ${cfg.SCREEN_MAX_AGE_SECONDS}s)`);
  }

  if (s.marketCapUsd < cfg.SCREEN_MIN_MCAP_USD) {
    return reject(`mcap ${usd(s.marketCapUsd)} below ${usd(cfg.SCREEN_MIN_MCAP_USD)}`);
  }
  // Above the ceiling the move being screened for has already happened, and
  // buying here means buying from the people who caught it.
  if (cfg.SCREEN_MAX_MCAP_USD > 0 && s.marketCapUsd > cfg.SCREEN_MAX_MCAP_USD) {
    return reject(`mcap ${usd(s.marketCapUsd)} above ${usd(cfg.SCREEN_MAX_MCAP_USD)}`);
  }

  if (s.volumeUsd < cfg.SCREEN_MIN_VOLUME_USD) {
    return reject(`volume ${usd(s.volumeUsd)} below ${usd(cfg.SCREEN_MIN_VOLUME_USD)}`);
  }

  if (s.buyers < cfg.SCREEN_MIN_BUYERS) {
    return reject(`${s.buyers} buyers (need ${cfg.SCREEN_MIN_BUYERS})`);
  }

  // --- flow filters -----------------------------------------------------
  //
  // Every one of these is OFF at its default, so adding them changed nothing
  // about what the bot trades until a number is put in. They exist because a
  // volume threshold cannot tell a token that is still moving from one that
  // stopped, or fifty buyers from one whale, and those are different trades.

  if (cfg.SCREEN_MAX_SECONDS_SINCE_TRADE > 0 && s.secondsSinceTrade > cfg.SCREEN_MAX_SECONDS_SINCE_TRADE) {
    return reject(
      `no trade for ${s.secondsSinceTrade.toFixed(0)}s (max ${cfg.SCREEN_MAX_SECONDS_SINCE_TRADE}s)`,
    );
  }

  // Buying a token already well off its high is buying the second half of a
  // move. The number is negative, so the comparison is against the negated cap.
  if (cfg.SCREEN_MAX_DRAWDOWN_PCT > 0 && s.drawdownFromPeakPct < -cfg.SCREEN_MAX_DRAWDOWN_PCT) {
    return reject(
      `${s.drawdownFromPeakPct.toFixed(0)}% off peak (max -${cfg.SCREEN_MAX_DRAWDOWN_PCT}%)`,
    );
  }

  if (cfg.SCREEN_MIN_BUYER_ACCEL > 0 && s.buyerAcceleration < cfg.SCREEN_MIN_BUYER_ACCEL) {
    return reject(
      `buyer acceleration ${fmt(s.buyerAcceleration)} (need ${cfg.SCREEN_MIN_BUYER_ACCEL})`,
    );
  }

  if (cfg.SCREEN_MIN_NET_FLOW_SOL > 0 && s.netFlowSol < cfg.SCREEN_MIN_NET_FLOW_SOL) {
    return reject(
      `net flow ${s.netFlowSol.toFixed(2)} SOL (need ${cfg.SCREEN_MIN_NET_FLOW_SOL})`,
    );
  }

  if (cfg.SCREEN_MIN_AVG_BUY_SOL > 0 && s.avgBuySol < cfg.SCREEN_MIN_AVG_BUY_SOL) {
    return reject(`avg buy ${s.avgBuySol.toFixed(3)} SOL (need ${cfg.SCREEN_MIN_AVG_BUY_SOL})`);
  }
  // A very high average is one wallet, not a crowd — the opposite failure.
  if (cfg.SCREEN_MAX_AVG_BUY_SOL > 0 && s.avgBuySol > cfg.SCREEN_MAX_AVG_BUY_SOL) {
    return reject(`avg buy ${s.avgBuySol.toFixed(3)} SOL (max ${cfg.SCREEN_MAX_AVG_BUY_SOL})`);
  }

  if (cfg.SCREEN_MIN_LARGEST_BUY_SOL > 0 && s.largestBuySol < cfg.SCREEN_MIN_LARGEST_BUY_SOL) {
    return reject(
      `largest buy ${s.largestBuySol.toFixed(2)} SOL (need ${cfg.SCREEN_MIN_LARGEST_BUY_SOL})`,
    );
  }

  if (cfg.SCREEN_MIN_REPEAT_BUYERS > 0 && s.repeatBuyers < cfg.SCREEN_MIN_REPEAT_BUYERS) {
    return reject(`${s.repeatBuyers} repeat buyers (need ${cfg.SCREEN_MIN_REPEAT_BUYERS})`);
  }

  if (s.curveProgressPct < cfg.SCREEN_MIN_CURVE_PROGRESS_PCT) {
    return reject(
      `curve ${s.curveProgressPct.toFixed(0)}% (need ${cfg.SCREEN_MIN_CURVE_PROGRESS_PCT}%)`,
    );
  }
  if (cfg.SCREEN_MAX_CURVE_PROGRESS_PCT > 0 && s.curveProgressPct > cfg.SCREEN_MAX_CURVE_PROGRESS_PCT) {
    return reject(
      `curve ${s.curveProgressPct.toFixed(0)}% (max ${cfg.SCREEN_MAX_CURVE_PROGRESS_PCT}%)`,
    );
  }

  if (cfg.SCREEN_MIN_COPY_HOLDERS > 0 && s.copyHolders < cfg.SCREEN_MIN_COPY_HOLDERS) {
    return reject(
      `${s.copyHolders} tracked wallets holding (need ${cfg.SCREEN_MIN_COPY_HOLDERS})`,
    );
  }

  if (cfg.SCREEN_MIN_SOCIALS > 0) {
    if (!s.socialsChecked) {
      return { outcome: 'needs-socials', fire: false, reason: 'socials not fetched yet', snapshot: s };
    }
    // A gateway that timed out is not evidence about the token. Failing closed
    // on it rejects tokens that do have socials, and does so invisibly — which
    // is indistinguishable from the bot being broken.
    if (s.socialsUnavailable) {
      if (cfg.SCREEN_ON_SOCIALS_UNAVAILABLE === 'deny') {
        return reject('socials unavailable (metadata unreadable)');
      }
    } else if (s.socials < cfg.SCREEN_MIN_SOCIALS) {
      return reject(`${s.socials} socials (need ${cfg.SCREEN_MIN_SOCIALS})`);
    }
  }

  return {
    outcome: 'fire',
    fire: true,
    reason:
      `${usd(s.marketCapUsd)} mcap, ${usd(s.volumeUsd)} volume, ` +
      `${s.socialsUnavailable ? 'socials unknown' : `${s.socials} social${s.socials === 1 ? '' : 's'}`}, ` +
      `${s.buyers} buyers, ${s.ageSeconds.toFixed(0)}s old` +
      (s.copyHolders > 0 ? `, ${s.copyHolders} tracked wallet(s) holding` : ''),
    snapshot: s,
  };
}
