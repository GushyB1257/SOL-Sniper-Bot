import type { Config } from '../config.js';
import type { Pool } from '../types.js';
import type { TrackedToken } from '../watchlist/watchlist.js';

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
  deployerSold: boolean;
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
): ScreenSnapshot {
  const volumeSol = t.seedVolumeSol + t.buyVolumeSol + t.sellVolumeSol;
  const marketCapSol = t.latestMarketCapSol;
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
    deployerSold: t.deployerSold,
  };
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
): ScreenVerdict {
  const s = screenSnapshot(t, solUsd, now);
  const reject = (reason: string): ScreenVerdict => ({
    outcome: 'reject',
    fire: false,
    reason,
    snapshot: s,
  });

  if (!cfg.SCREEN_ALLOWED_POOLS.includes(s.pool)) {
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

  if (cfg.SCREEN_MIN_SOCIALS > 0) {
    if (!s.socialsChecked) {
      return { outcome: 'needs-socials', fire: false, reason: 'socials not fetched yet', snapshot: s };
    }
    if (s.socials < cfg.SCREEN_MIN_SOCIALS) {
      return reject(`${s.socials} socials (need ${cfg.SCREEN_MIN_SOCIALS})`);
    }
  }

  return {
    outcome: 'fire',
    fire: true,
    reason:
      `${usd(s.marketCapUsd)} mcap, ${usd(s.volumeUsd)} volume, ${s.socials} social` +
      `${s.socials === 1 ? '' : 's'}, ${s.buyers} buyers, ${s.ageSeconds.toFixed(0)}s old`,
    snapshot: s,
  };
}
