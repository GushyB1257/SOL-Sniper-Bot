import type { ExitOrder, LadderTier, Position } from '../types.js';
import type { Config } from '../config.js';
import { pctChange } from '../util/solana.js';
import { breakevenGrossPct, costModel, targetGrossPct } from './costs.js';

/**
 * Builds the ladder for a new position from config.
 *
 * The shape the user asked for: sell most of it into the first pops so the
 * original stake is off the table, then let a small remainder ride in case the
 * thing actually runs. With the default 60/150/400 ladder, cost basis is fully
 * recovered by the second rung — everything after that is house money.
 */
export function buildLadder(cfg: Config): LadderTier[] {
  return cfg.EXIT_LADDER.map((t) => ({
    gainPct: t.gainPct,
    sellPctOfOriginal: t.sellPctOfOriginal,
    filled: false,
  }));
}

/** Fraction of the original position left once every rung has filled. */
export function moonbagFraction(cfg: Config): number {
  const sold = cfg.EXIT_LADDER.reduce((a, t) => a + t.sellPctOfOriginal, 0);
  return Math.max(0, (100 - sold) / 100);
}

export interface ExitContext {
  position: Position;
  price: number;
  cfg: Config;
  now: number;
}

/**
 * Decides what (if anything) to sell right now. Pure function — no I/O, no
 * mutation — so the whole exit policy is unit-testable without a chain.
 *
 * Precedence is deliberate: capital-preservation exits are evaluated before
 * profit-taking, and the first match wins. Returns null to hold.
 */
export function decideExit(ctx: ExitContext): ExitOrder | null {
  const { position: p, price, cfg, now } = ctx;

  if (p.status !== 'open') return null;
  if (p.remainingQty <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  if (cfg.SCALP_MODE) return decideScalpExit(ctx);

  const gainPct = pctChange(p.entryPrice, price);
  const drawdownFromPeak = p.peakPrice > 0 ? pctChange(p.peakPrice, price) : 0;
  const heldSeconds = (now - p.openedAt) / 1000;
  const anyTierFilled = p.ladder.some((t) => t.filled);

  const closeAll = (reason: ExitOrder['reason'], detail: string): ExitOrder => ({
    mint: p.mint,
    positionId: p.id,
    qty: p.remainingQty,
    reason,
    closeAll: true,
    tierIndexes: [],
    detail,
  });

  // 1. Absolute time limit. Even a moonbag is eventually just a dead bag.
  if (heldSeconds >= cfg.MAX_HOLD_SECONDS) {
    return closeAll('max_hold', `held ${Math.round(heldSeconds)}s (max ${cfg.MAX_HOLD_SECONDS}s)`);
  }

  // 2. Hard stop loss. Applies whether or not rungs have filled — if price is
  //    this far below entry the thesis is dead.
  //
  //    When the analyst supplied its own invalidation level, the TIGHTER of the
  //    two wins. The model may cut sooner than the configured stop; it may
  //    never push the stop wider, so no thesis can talk the bot into holding
  //    past the mechanical floor.
  const stopPct =
    p.aiInvalidationPct !== undefined
      ? Math.min(cfg.STOP_LOSS_PCT, p.aiInvalidationPct)
      : cfg.STOP_LOSS_PCT;

  if (gainPct <= -stopPct) {
    return closeAll('stop_loss', `down ${gainPct.toFixed(1)}% (stop ${-stopPct}%)`);
  }

  // 3. Trailing stops, measured from the peak since entry.
  if (p.moonbagArmed) {
    if (drawdownFromPeak <= -cfg.MOONBAG_TRAILING_STOP_PCT) {
      return closeAll(
        'moonbag_trailing_stop',
        `moonbag ${drawdownFromPeak.toFixed(1)}% off peak (limit ${-cfg.MOONBAG_TRAILING_STOP_PCT}%)`,
      );
    }
  } else if (anyTierFilled && drawdownFromPeak <= -cfg.TRAILING_STOP_PCT) {
    return closeAll(
      'trailing_stop',
      `${drawdownFromPeak.toFixed(1)}% off peak (limit ${-cfg.TRAILING_STOP_PCT}%)`,
    );
  }

  // 4. Time stop for positions that never went anywhere. A launch that is flat
  //    after three minutes has failed; the capital is better used elsewhere and
  //    holding only exposes it to the eventual dev dump.
  if (
    !anyTierFilled &&
    heldSeconds >= cfg.TIME_STOP_SECONDS &&
    gainPct < cfg.TIME_STOP_MIN_GAIN_PCT
  ) {
    return closeAll(
      'time_stop',
      `flat at ${gainPct.toFixed(1)}% after ${Math.round(heldSeconds)}s`,
    );
  }

  // 5. Take profit. Batch every rung the price has cleared into one sell.
  const crossed: number[] = [];
  let qty = 0;
  for (let i = 0; i < p.ladder.length; i++) {
    const tier = p.ladder[i]!;
    if (tier.filled) continue;
    if (gainPct < tier.gainPct) continue;
    crossed.push(i);
    qty += (p.originalQty * tier.sellPctOfOriginal) / 100;
  }

  if (crossed.length > 0) {
    // Never try to sell more than we actually hold — fees and partial fills
    // mean remainingQty drifts below the arithmetic ideal.
    const sellQty = Math.min(qty, p.remainingQty);
    if (sellQty <= 0) return null;

    const lastCrossed = crossed[crossed.length - 1]!;
    const isFinalRung = lastCrossed === p.ladder.length - 1;
    // If the last rung would leave behind dust, just close out.
    const leftover = p.remainingQty - sellQty;
    const dust = leftover / p.originalQty < 0.005;

    return {
      mint: p.mint,
      positionId: p.id,
      qty: dust ? p.remainingQty : sellQty,
      reason: 'ladder',
      closeAll: dust,
      tierIndexes: crossed,
      detail:
        `+${gainPct.toFixed(0)}% cleared rung${crossed.length > 1 ? 's' : ''} ` +
        `${crossed.map((i) => `+${p.ladder[i]!.gainPct}%`).join(', ')}` +
        (isFinalRung && !dust ? ' — moonbag armed' : ''),
    };
  }

  return null;
}

/** Realised + unrealised PnL in SOL at the given price. */
export function positionPnl(p: Position, price: number): { sol: number; pct: number } {
  const unrealised = p.remainingQty * price;
  const total = p.realizedSol + unrealised;
  const sol = total - p.costSol;
  return { sol, pct: p.costSol > 0 ? (sol / p.costSol) * 100 : 0 };
}


/**
 * Quick in-and-out exit.
 *
 * The target is computed from the fee model rather than being a round number:
 * you ask for a NET return and the bot works out the gross move that delivers
 * it after both program fees, both router fees and both priority fees. This
 * matters more than it sounds — at 0.05 SOL with a 0.0008 priority fee, the
 * breakeven move is 6.3%, so a "quick 5% scalp" is a guaranteed loss however
 * well it is timed.
 *
 * A runner is kept back after the target fills, so a call that turns out
 * conservative is not capped at its own guess.
 */
export function decideScalpExit(ctx: ExitContext): ExitOrder | null {
  const { position: p, price, cfg, now } = ctx;

  const model = costModel(cfg, p.notionalSol ?? p.costSol);
  const breakeven = breakevenGrossPct(model);
  const target = targetGrossPct(model, cfg.SCALP_TARGET_NET_PCT);

  const gainPct = pctChange(p.entryPrice, price);
  const peakGainPct = pctChange(p.entryPrice, p.peakPrice);
  const heldSeconds = (now - p.openedAt) / 1000;
  const runnerActive = p.moonbagArmed;

  const closeAll = (reason: ExitOrder['reason'], detail: string): ExitOrder => ({
    mint: p.mint,
    positionId: p.id,
    qty: p.remainingQty,
    reason,
    closeAll: true,
    tierIndexes: [],
    detail,
  });

  // 1. Hard stop. The analyst's level wins only when tighter.
  const stopPct =
    p.aiInvalidationPct !== undefined
      ? Math.min(cfg.SCALP_STOP_LOSS_PCT, p.aiInvalidationPct)
      : cfg.SCALP_STOP_LOSS_PCT;
  if (gainPct <= -stopPct) {
    return closeAll('stop_loss', `down ${gainPct.toFixed(1)}% (stop ${-stopPct}%)`);
  }

  // 2. Give-back stop. Once a trade has been meaningfully green it should not
  //    be allowed to become a loser — but "not a loser" is a low bar. These
  //    tokens pop for a few seconds and then crash, so a position that peaked
  //    at +30% and is now at +8% is not a trade still working; it is a trade
  //    already over. The floor is the higher of breakeven and the share of the
  //    peak gain we are willing to hand back, so it ratchets up as the trade
  //    runs and never drops below flat.
  if (!runnerActive && peakGainPct >= breakeven + cfg.SCALP_BREAKEVEN_ARM_PCT) {
    const giveback = peakGainPct * (1 - cfg.SCALP_GIVEBACK_PCT / 100);
    const floor = Math.max(breakeven, giveback);
    if (gainPct <= floor) {
      return closeAll(
        'trailing_stop',
        `gave back to ${gainPct.toFixed(1)}% from a ${peakGainPct.toFixed(1)}% peak ` +
          `(floor ${floor.toFixed(1)}%)`,
      );
    }
  }

  // 3. Runner: trail it once the target has been banked.
  if (runnerActive) {
    const drawdown = p.peakPrice > 0 ? pctChange(p.peakPrice, price) : 0;
    if (drawdown <= -cfg.SCALP_RUNNER_TRAILING_STOP_PCT) {
      return closeAll(
        'trailing_stop',
        `runner ${drawdown.toFixed(1)}% off peak (limit ${-cfg.SCALP_RUNNER_TRAILING_STOP_PCT}%)`,
      );
    }
    if (heldSeconds >= cfg.MAX_HOLD_SECONDS) {
      return closeAll('max_hold', `runner held ${Math.round(heldSeconds)}s`);
    }
    return null;
  }

  // 4. Target hit: bank the position, keep the runner back.
  if (gainPct >= target) {
    const runnerFraction = cfg.SCALP_RUNNER_PCT / 100;
    const sellQty = p.remainingQty * (1 - runnerFraction);
    const dust = runnerFraction <= 0 || sellQty / p.remainingQty > 0.995;
    return {
      mint: p.mint,
      positionId: p.id,
      qty: dust ? p.remainingQty : sellQty,
      reason: 'ladder',
      closeAll: dust,
      tierIndexes: p.ladder.map((_, i) => i),
      detail:
        `+${gainPct.toFixed(1)}% cleared net target (+${cfg.SCALP_TARGET_NET_PCT}% after ` +
        `${breakeven.toFixed(1)}% fees)` + (dust ? '' : `, keeping ${cfg.SCALP_RUNNER_PCT}% runner`),
    };
  }

  // 5. Time stop. Capital turnover is the whole strategy; a position that has
  //    not moved is occupying a slot another setup could use.
  if (heldSeconds >= cfg.SCALP_TIME_STOP_SECONDS && gainPct < breakeven) {
    return closeAll(
      'time_stop',
      `flat at ${gainPct.toFixed(1)}% after ${Math.round(heldSeconds)}s (below ${breakeven.toFixed(1)}% breakeven)`,
    );
  }

  return null;
}
