import type { BotId } from '../bots/bot.js';

/**
 * What the auto-tuner is allowed to touch, and how far.
 *
 * This file is the safety boundary of the whole feature. A model proposing
 * changes to its own trading parameters is useful; a model that can widen its
 * own risk limits is a way to lose everything while the dashboard shows green.
 * So the split is deliberate and not negotiable at runtime:
 *
 *  - **Strategy knobs are tunable.** Entry thresholds, exit timing, how much
 *    of a moonbag to skim. Getting these wrong costs some trades.
 *  - **Risk limits are not, ever.** Position size, concurrent positions, the
 *    daily loss limit, the hourly spend cap, the loss-streak breaker, the
 *    wallet reserve, slippage, the mode and the executor. Getting these wrong
 *    costs the account, and no evidence pack justifies handing them over.
 *
 * `BUY_AMOUNT_SOL` sits in the second group even though position size is one of
 * the strongest levers on profitability, because "the analysis said to bet
 * more" is the failure mode that ends accounts. The tuner can *recommend* a
 * size change in its notes; a human types it in.
 *
 * Every bound here is tighter than the config schema's. The schema stops
 * nonsense; this stops a plausible-looking walk into somewhere useless over
 * many rounds.
 */
export interface Tunable {
  key: string;
  /** Which bot's evidence justifies moving it. */
  bot: BotId | 'shared';
  min: number;
  max: number;
  /** Largest single-round move, as a share of the current value. */
  maxStepPct: number;
  /** Told to the model, so it knows what the number does. */
  what: string;
}

export const TUNABLES: Tunable[] = [
  // --- Screener entry filters -------------------------------------------
  {
    key: 'SCREEN_MIN_VOLUME_USD',
    bot: 'screener',
    min: 500,
    max: 100_000,
    maxStepPct: 50,
    what: 'Minimum traded volume before a token is bought. Higher = fewer, busier tokens.',
  },
  {
    key: 'SCREEN_MIN_MCAP_USD',
    bot: 'screener',
    min: 2000,
    max: 100_000,
    maxStepPct: 50,
    what: 'Minimum market cap. Higher = later entries on tokens that already moved.',
  },
  {
    key: 'SCREEN_MAX_MCAP_USD',
    bot: 'screener',
    min: 0,
    max: 500_000,
    maxStepPct: 60,
    what: 'Maximum market cap; 0 disables. Lower = refuses to buy tops.',
  },
  {
    key: 'SCREEN_MIN_SOCIALS',
    bot: 'screener',
    min: 0,
    max: 3,
    maxStepPct: 100,
    what: 'Minimum social links declared in metadata (0-3).',
  },
  {
    key: 'SCREEN_MAX_AGE_SECONDS',
    bot: 'screener',
    min: 30,
    max: 3600,
    maxStepPct: 50,
    what: 'Oldest a token can be at entry. Lower = only fresh launches.',
  },
  {
    key: 'SCREEN_MIN_AGE_SECONDS',
    bot: 'screener',
    min: 0,
    max: 600,
    maxStepPct: 100,
    what: 'Youngest a token can be at entry. Higher = lets the first spike pass first.',
  },
  {
    key: 'SCREEN_MIN_BUYERS',
    bot: 'screener',
    min: 0,
    max: 100,
    maxStepPct: 100,
    what: 'Distinct buyers required; 0 disables. Higher = demands real participation.',
  },

  // --- Sniper -----------------------------------------------------------
  {
    key: 'MIN_SAFETY_SCORE',
    bot: 'sniper',
    min: 40,
    max: 95,
    maxStepPct: 20,
    what: 'Safety score a launch must clear. Higher = fewer, structurally cleaner launches.',
  },
  {
    key: 'MAX_CANDIDATE_AGE_MS',
    bot: 'sniper',
    min: 1000,
    max: 60_000,
    maxStepPct: 50,
    what: 'How stale a launch can be before the sniper ignores it.',
  },

  // --- Copy trader ------------------------------------------------------
  {
    key: 'COPY_MIN_BUY_SOL',
    bot: 'copy',
    min: 0.05,
    max: 25,
    maxStepPct: 50,
    what: 'Ignore their buys below this SOL value — the volume-bump filter.',
  },
  {
    key: 'COPY_MAX_BUY_SOL',
    bot: 'copy',
    min: 0,
    max: 500,
    maxStepPct: 60,
    what: 'Ignore their buys above this; 0 disables.',
  },
  {
    key: 'COPY_SELL_MULTIPLIER',
    bot: 'copy',
    min: 0.5,
    max: 3,
    maxStepPct: 40,
    what: 'Multiplier on the fraction they sell. Above 1 exits faster than they do.',
  },
  {
    key: 'COPY_FULL_EXIT_AT_PCT',
    bot: 'copy',
    min: 50,
    max: 100,
    maxStepPct: 25,
    what: 'Close fully once they have sold this share of their holding.',
  },
  {
    key: 'COPY_MAX_HOLD_SECONDS',
    bot: 'copy',
    min: 300,
    max: 604_800,
    maxStepPct: 60,
    what: 'Backstop exit for a wallet that goes quiet holding a dead token.',
  },

  // --- Shared exit timing -----------------------------------------------
  {
    key: 'CHECKPOINT_SECONDS',
    bot: 'shared',
    min: 20,
    max: 600,
    maxStepPct: 40,
    what: 'How often the ratchet asks whether the price is higher than last time.',
  },
  {
    key: 'RATCHET_FIRST_CHECKPOINT_SECONDS',
    bot: 'shared',
    min: 10,
    max: 300,
    maxStepPct: 50,
    what: 'Length of the first window only — how long a dead entry is given.',
  },
  {
    key: 'RECOVER_AT_GAIN_PCT',
    bot: 'shared',
    min: 25,
    max: 300,
    maxStepPct: 40,
    what: 'Gain at which the stake comes off the table and the rest rides free.',
  },
  {
    key: 'RATCHET_GIVEBACK_PCT',
    bot: 'shared',
    min: 0,
    max: 80,
    maxStepPct: 50,
    what: 'Close if this share of the best GAIN is handed back. Never fires on a loser.',
  },
  {
    key: 'MOONBAG_TRIM_PCT',
    bot: 'shared',
    min: 0,
    max: 60,
    maxStepPct: 50,
    what: 'Share of a surviving moonbag skimmed at each checkpoint.',
  },
  {
    key: 'RATCHET_MIN_PROGRESS_PCT',
    bot: 'shared',
    min: 0,
    max: 25,
    maxStepPct: 100,
    what: 'How much higher than the last checkpoint counts as still rising.',
  },
  {
    key: 'MAX_HOLD_SECONDS',
    bot: 'shared',
    min: 300,
    max: 604_800,
    maxStepPct: 60,
    what: 'Absolute backstop on how long any position is held.',
  },
];

export const TUNABLE_BY_KEY = new Map(TUNABLES.map((t) => [t.key, t]));

/**
 * Clamps a proposal to what is allowed, or rejects it.
 *
 * Returns the value to apply plus a note when it had to be trimmed, so the
 * audit trail records that the model asked for more than it got rather than
 * silently showing the trimmed number as its idea.
 */
export function vetProposal(
  key: string,
  current: number,
  proposed: number,
  maxStepPctOverride?: number,
): { ok: true; value: number; clamped?: string } | { ok: false; reason: string } {
  const spec = TUNABLE_BY_KEY.get(key);
  if (!spec) return { ok: false, reason: `${key} is not tunable` };
  if (!Number.isFinite(proposed)) return { ok: false, reason: `${key}: not a number` };

  let value = proposed;
  const notes: string[] = [];

  if (value < spec.min) {
    notes.push(`raised to the floor ${spec.min}`);
    value = spec.min;
  }
  if (value > spec.max) {
    notes.push(`cut to the ceiling ${spec.max}`);
    value = spec.max;
  }

  // Step limiting is what stops a series of individually reasonable rounds
  // from walking a parameter somewhere no single round would have proposed.
  const stepPct = maxStepPctOverride ?? spec.maxStepPct;
  if (current > 0) {
    const room = current * (stepPct / 100);
    const lo = current - room;
    const hi = current + room;
    if (value < lo) {
      notes.push(`step limited from ${proposed} to ${lo.toFixed(4)}`);
      value = lo;
    } else if (value > hi) {
      notes.push(`step limited from ${proposed} to ${hi.toFixed(4)}`);
      value = hi;
    }
  }

  if (value === current) return { ok: false, reason: `${key}: no change after limits` };
  return notes.length > 0 ? { ok: true, value, clamped: notes.join('; ') } : { ok: true, value };
}
