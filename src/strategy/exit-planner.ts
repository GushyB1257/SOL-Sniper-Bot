import type { ExitOrder, LadderTier, Position } from '../types.js';
import type { Config } from '../config.js';
import { pctChange } from '../util/solana.js';

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
  if (gainPct <= -cfg.STOP_LOSS_PCT) {
    return closeAll('stop_loss', `down ${gainPct.toFixed(1)}% (stop ${-cfg.STOP_LOSS_PCT}%)`);
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
