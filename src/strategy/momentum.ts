import type { Config } from '../config.js';
import type { TrackedToken } from '../watchlist/watchlist.js';

/**
 * Fast, deterministic entry trigger.
 *
 * This exists because an LLM cannot be in the entry path for moves that
 * complete in seconds. A thinking model takes seconds to answer; a 2k→12k
 * market-cap move is over by then. So entry is a pure function over the trade
 * stream — it runs in microseconds on every trade event, with no network call
 * and no model.
 *
 * The AI does not disappear; it moves to where its latency is affordable —
 * managing exits and reviewing which patterns actually made money. Judgment
 * where there is time for it, reflexes where there is not.
 */

export interface MomentumWindow {
  /** Percent price change across the window. */
  gainPct: number;
  /** Distinct wallets that bought inside the window. */
  buyers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  /** Buy volume ÷ sell volume inside the window. */
  ratio: number;
  /** Percent change from the token's first observed price. */
  totalGainPct: number;
  ageSeconds: number;
}

export interface MomentumSignal {
  fire: boolean;
  reason: string;
  window: MomentumWindow;
}

/**
 * Measures the last `windowSeconds` of activity.
 *
 * Price is derived from the curve's virtual SOL reserves, which move as a
 * square on a constant-product curve — so the reserve ratio is squared to get
 * the price ratio.
 */
export function measureWindow(
  t: TrackedToken,
  windowSeconds: number,
  now = Date.now(),
): MomentumWindow {
  const cutoff = now - windowSeconds * 1000;

  // Oldest sample at or before the cutoff is the window's opening price.
  let openVSol = t.samples[0]?.vSol ?? 30;
  for (const s of t.samples) {
    if (s.at <= cutoff) openVSol = s.vSol;
    else break;
  }

  const firstVSol = t.samples[0]?.vSol ?? 30;
  const buyers = new Set<string>();
  for (const b of t.recentBuyers) if (b.at >= cutoff) buyers.add(b.trader);

  return {
    gainPct: openVSol > 0 ? ((t.latestVSol / openVSol) ** 2 - 1) * 100 : 0,
    buyers: buyers.size,
    buyVolumeSol: t.buyVolumeSol,
    sellVolumeSol: t.sellVolumeSol,
    ratio: t.sellVolumeSol > 0 ? t.buyVolumeSol / t.sellVolumeSol : Infinity,
    totalGainPct: firstVSol > 0 ? ((t.latestVSol / firstVSol) ** 2 - 1) * 100 : 0,
    ageSeconds: (now - t.firstSeen) / 1000,
  };
}

/**
 * Should we buy this token right now?
 *
 * Every condition is a cheap comparison. The ordering matters only for the
 * quality of the rejection reason, which is what makes the log useful when
 * nothing is firing.
 */
export function momentumSignal(
  t: TrackedToken,
  cfg: Config,
  now = Date.now(),
): MomentumSignal {
  const w = measureWindow(t, cfg.MOMENTUM_WINDOW_SECONDS, now);
  const no = (reason: string): MomentumSignal => ({ fire: false, reason, window: w });

  if (w.ageSeconds < cfg.MOMENTUM_MIN_AGE_SECONDS) return no('too young');
  if (w.ageSeconds > cfg.MOMENTUM_MAX_AGE_SECONDS) return no('too old');

  // The deployer selling ends the thesis instantly, whatever the chart says.
  if (t.deployerSold) return no('deployer sold');

  // A real wave has distinct wallets arriving, not one whale round-tripping.
  if (w.buyers < cfg.MOMENTUM_MIN_BUYERS) {
    return no(`only ${w.buyers} buyers in window (need ${cfg.MOMENTUM_MIN_BUYERS})`);
  }

  if (w.buyVolumeSol < cfg.MOMENTUM_MIN_VOLUME_SOL) {
    return no(`volume ${w.buyVolumeSol.toFixed(2)} SOL below ${cfg.MOMENTUM_MIN_VOLUME_SOL}`);
  }

  if (w.ratio < cfg.MOMENTUM_MIN_BUY_SELL_RATIO) {
    return no(`buy/sell ratio ${w.ratio.toFixed(2)} below ${cfg.MOMENTUM_MIN_BUY_SELL_RATIO}`);
  }

  // The move itself.
  if (w.gainPct < cfg.MOMENTUM_MIN_GAIN_PCT) {
    return no(`up ${w.gainPct.toFixed(1)}% in window (need ${cfg.MOMENTUM_MIN_GAIN_PCT}%)`);
  }

  // Do not chase. Past this point the easy money has been made and we would be
  // buying from the people who caught it — the single most expensive mistake
  // available in this strategy.
  if (w.totalGainPct > cfg.MOMENTUM_MAX_CHASE_PCT) {
    return no(`already up ${w.totalGainPct.toFixed(0)}% — too late to chase`);
  }

  return {
    fire: true,
    reason:
      `+${w.gainPct.toFixed(1)}% in ${cfg.MOMENTUM_WINDOW_SECONDS}s on ${w.buyers} buyers, ` +
      `${w.buyVolumeSol.toFixed(2)} SOL volume, ratio ${
        Number.isFinite(w.ratio) ? w.ratio.toFixed(1) : '∞'
      }`,
    window: w,
  };
}
