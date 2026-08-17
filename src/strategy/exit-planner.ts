import type { ExitOrder, LadderTier, Position } from '../types.js';
import type { Config } from '../config.js';
import { pctChange } from '../util/solana.js';
import { breakevenGrossPct, costModel, targetGrossPct, type CostModel } from './costs.js';

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

  // Copy positions belong to the wallet being followed, not to a price rule.
  // A ratchet or a stop firing underneath one would exit on our schedule while
  // the person we are copying is still holding — which is the one thing a copy
  // trader must never do.
  if (p.managedBy === 'copy') return decideFollowExit(ctx);

  if (cfg.EXIT_MODE === 'ratchet') return decideRatchetExit(ctx);
  if (cfg.EXIT_MODE === 'scalp') return decideScalpExit(ctx);

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
      // SCALP_TIME_STOP_SECONDS, not TIME_STOP_SECONDS — a different parameter
      // with a different default, and worth being able to tell apart.
      'scalp_time_stop',
      `flat at ${gainPct.toFixed(1)}% after ${Math.round(heldSeconds)}s (below ${breakeven.toFixed(1)}% breakeven)`,
    );
  }

  return null;
}

/**
 * Quantity that has to be sold at `price` to get the original stake back.
 *
 * Sizing this by eye — "sell half at 2x" — leaves the stake short by the fees
 * on both legs, so the position is not actually de-risked and the moonbag is
 * quietly funded out of capital. Solving it properly:
 *
 *   net proceeds = qty x price x (1 - f) - priorityFee  >=  outstanding cost
 *
 * gives the quantity below. At a clean 2x that works out to a little over half
 * the position, and what remains is genuinely free.
 */
export function costRecoveryQty(p: Position, price: number, m: CostModel): number {
  const outstanding = Math.max(0, p.costSol - p.realizedSol);
  if (outstanding <= 0 || price <= 0) return 0;
  const denom = price * (1 - m.perSideFee);
  if (denom <= 0) return Infinity;
  return (outstanding + m.priorityFeeSol) / denom;
}

/**
 * Whether the position is still inside its opening window.
 *
 * The first window is its own length: a launch that is going nowhere should not
 * get the same leash as one that has already proved something. Which window a
 * position is in decides which parameter governs it, so it also decides which
 * parameter an exit taken here should be attributed to.
 */
function inFirstWindow(p: Position): boolean {
  return (p.checkpointAt ?? p.openedAt) <= p.openedAt;
}

/** True when the current ratchet window has run its course. */
export function checkpointElapsed(p: Position, cfg: Config, now: number): boolean {
  const startedAt = p.checkpointAt ?? p.openedAt;
  const window = inFirstWindow(p)
    ? cfg.RATCHET_FIRST_CHECKPOINT_SECONDS
    : cfg.CHECKPOINT_SECONDS;
  return (now - startedAt) / 1000 >= window;
}

/**
 * The ratchet exit: no stop loss, one question on a timer.
 *
 * A stop loss cuts a position at its worst moment, which on a token that then
 * recovers is the most expensive possible time to sell. This replaces it with a
 * deadline instead of a price: every CHECKPOINT_SECONDS the position has to be
 * higher than it was at the last checkpoint, or it is over. A token that dumps
 * and comes back within the window is held; a token that dumps and stays down
 * is sold at the checkpoint rather than at the bottom of the wick.
 *
 * The trade-off is explicit and worth stating plainly: **the most a losing
 * trade can now cost is the entire position**, because nothing sells on price.
 * What pays for that is the recovery rule — on a double, exactly enough is sold
 * to return the stake, and everything held after that is house money. So the
 * strategy needs a real rate of doubles to work; it is not free.
 *
 * Four rules, first match wins:
 *
 *   1. Recover the stake the moment the position doubles (not on the timer —
 *      a 2x can happen inside one window and giving it back is the failure
 *      this whole design exists to avoid).
 *   2. At a checkpoint, before recovery: below breakeven, it has not worked.
 *   3. At a checkpoint, either phase: no new high, the move is over.
 *   4. At a checkpoint, after recovery and still climbing: skim a slice and
 *      let the rest run.
 */
export function decideRatchetExit(ctx: ExitContext): ExitOrder | null {
  const { position: p, price, cfg, now } = ctx;

  const model = costModel(cfg, p.notionalSol ?? p.costSol);
  const breakeven = breakevenGrossPct(model);
  const gainPct = pctChange(p.entryPrice, price);
  const heldSeconds = (now - p.openedAt) / 1000;
  const recovered = p.costRecovered === true;
  const checkpointPrice = p.checkpointPrice ?? p.entryPrice;

  const closeAll = (reason: ExitOrder['reason'], detail: string): ExitOrder => ({
    mint: p.mint,
    positionId: p.id,
    qty: p.remainingQty,
    reason,
    closeAll: true,
    tierIndexes: [],
    detail,
  });

  // Opt-in stop, off by default. Present so a stop can be restored from config
  // rather than by editing this file.
  if (cfg.RATCHET_STOP_LOSS_PCT > 0 && gainPct <= -cfg.RATCHET_STOP_LOSS_PCT) {
    return closeAll('stop_loss', `down ${gainPct.toFixed(1)}% (stop ${-cfg.RATCHET_STOP_LOSS_PCT}%)`);
  }

  // Absolute backstop. The checkpoint rule already terminates every position —
  // nothing rises forever — but this catches a price feed frozen at a high.
  if (heldSeconds >= cfg.MAX_HOLD_SECONDS) {
    return closeAll('max_hold', `held ${Math.round(heldSeconds)}s (max ${cfg.MAX_HOLD_SECONDS}s)`);
  }

  // 1. Recovery. Deliberately NOT gated on the checkpoint: the entire point is
  //    that once this fires the trade can no longer lose money, so it should
  //    fire the instant it can.
  if (!recovered && gainPct >= cfg.RECOVER_AT_GAIN_PCT) {
    const qty = costRecoveryQty(p, price, model);
    if (qty >= p.remainingQty) {
      // Cannot cover the stake out of what is left — take everything rather
      // than pretend the position is de-risked.
      return closeAll(
        'cost_recovery',
        `+${gainPct.toFixed(0)}% but the remainder cannot cover the stake — closing out`,
      );
    }
    const keptPct = ((p.remainingQty - qty) / p.originalQty) * 100;
    return {
      mint: p.mint,
      positionId: p.id,
      qty,
      reason: 'cost_recovery',
      closeAll: false,
      tierIndexes: [],
      detail:
        `+${gainPct.toFixed(0)}% — taking ${p.costSol.toFixed(4)} SOL stake back, ` +
        `${keptPct.toFixed(0)}% of the position rides free from here`,
    };
  }

  // 1b. Give-back guard, checked BETWEEN checkpoints.
  //
  //     The checkpoint rule only looks up every window, so a position could run
  //     to +90%, round-trip the entire move, and still be holding when the
  //     window finally closed — the single largest leak in the design. This is
  //     measured against the GAIN above entry, never against entry itself, so
  //     it cannot behave like a stop loss: a position that is down has no gain
  //     to give back and this can never fire on it.
  if (cfg.RATCHET_GIVEBACK_PCT > 0) {
    const peakGainPct = pctChange(p.entryPrice, p.peakPrice);
    // Only once the peak was a real gain — otherwise noise around entry, where
    // every launch wobbles, would close positions before they started.
    if (peakGainPct > Math.max(breakeven * 2, 10)) {
      const givenBack = peakGainPct - gainPct;
      const allowed = peakGainPct * (cfg.RATCHET_GIVEBACK_PCT / 100);
      if (givenBack >= allowed) {
        return closeAll(
          'trailing_stop',
          `peaked at +${peakGainPct.toFixed(0)}%, now +${gainPct.toFixed(0)}% — ` +
            `gave back ${((givenBack / peakGainPct) * 100).toFixed(0)}% of the move ` +
            `(limit ${cfg.RATCHET_GIVEBACK_PCT}%)`,
        );
      }
    }
  }

  // Nothing else happens between checkpoints. This is what stops the bot
  // reacting to a wick.
  if (!checkpointElapsed(p, cfg, now)) return null;

  const required = checkpointPrice * (1 + cfg.RATCHET_MIN_PROGRESS_PCT / 100);
  const sinceCheckpointPct = pctChange(checkpointPrice, price);

  if (!recovered) {
    // 2. Sixty seconds in and still not actually in profit once fees are
    //    counted. Being green on the chart is not the test — clearing the
    //    round trip is.
    if (gainPct < breakeven) {
      // Which window this was decides which parameter to blame, and they are
      // different questions. Cut at the FIRST checkpoint means the entry never
      // started — that is RATCHET_FIRST_CHECKPOINT_SECONDS, and the cost of
      // setting it too long is the whole dead-entry bleed. Cut at a LATER one
      // means it was working and stopped, which is CHECKPOINT_SECONDS. Reporting
      // both as `time_stop` put them in the same bucket as TIME_STOP_SECONDS, a
      // third parameter in a different exit mode entirely.
      const first = inFirstWindow(p);
      return closeAll(
        first ? 'dead_entry' : 'checkpoint_cut',
        `${gainPct.toFixed(1)}% after ${Math.round(heldSeconds)}s, below the ` +
          `${breakeven.toFixed(1)}% needed to cover fees ` +
          `(${first ? 'first' : 'later'} checkpoint, ` +
          `${first ? cfg.RATCHET_FIRST_CHECKPOINT_SECONDS : cfg.CHECKPOINT_SECONDS}s window)`,
      );
    }
    // 3. Green, but it stopped going up.
    if (price <= required) {
      return closeAll(
        'ratchet_stall',
        `+${gainPct.toFixed(1)}% but ${sinceCheckpointPct.toFixed(1)}% over the last ` +
          `${cfg.CHECKPOINT_SECONDS}s — banking it`,
      );
    }
    // Still climbing and the stake is still at risk: hold all of it and let the
    // recovery rule do the de-risking.
    return null;
  }

  // 3 (moonbag phase). The free ride ended.
  if (price <= required) {
    return closeAll(
      'ratchet_stall',
      `moonbag ${sinceCheckpointPct.toFixed(1)}% over the last ${cfg.CHECKPOINT_SECONDS}s — closing`,
    );
  }

  // 4. Still climbing on house money: skim and let the rest run.
  const trim = p.remainingQty * (cfg.MOONBAG_TRIM_PCT / 100);
  if (trim <= 0) return null;
  const dust = (p.remainingQty - trim) / p.originalQty < 0.005;
  return {
    mint: p.mint,
    positionId: p.id,
    qty: dust ? p.remainingQty : trim,
    reason: 'moonbag_trim',
    closeAll: dust,
    tierIndexes: [],
    detail:
      `moonbag +${sinceCheckpointPct.toFixed(1)}% over ${cfg.CHECKPOINT_SECONDS}s ` +
      `(+${gainPct.toFixed(0)}% overall) — skimming ${cfg.MOONBAG_TRIM_PCT}%`,
  };
}

/**
 * The only exit a copied position has of its own: a backstop.
 *
 * Everything else is driven by the tracked wallet. This exists because a wallet
 * can go quiet holding a dead token indefinitely, and "mirror them exactly"
 * should not mean holding a zero forever while it occupies a position slot.
 */
export function decideFollowExit(ctx: ExitContext): ExitOrder | null {
  const { position: p, cfg, now } = ctx;
  const heldSeconds = (now - p.openedAt) / 1000;
  if (heldSeconds < cfg.COPY_MAX_HOLD_SECONDS) return null;
  return {
    mint: p.mint,
    positionId: p.id,
    qty: p.remainingQty,
    reason: 'max_hold',
    closeAll: true,
    tierIndexes: [],
    detail:
      `copied position held ${Math.round(heldSeconds)}s without the tracked wallet ` +
      `selling (max ${cfg.COPY_MAX_HOLD_SECONDS}s)`,
  };
}
