import type { BotId } from '../bots/bot.js';

/**
 * What the auto-tuner is allowed to touch, and how far.
 *
 * This is the safety boundary of the whole feature, and it is deliberately a
 * source file rather than config: it cannot be widened from `.env`, from the
 * dashboard, or by the tuner itself. Editing it and restarting is the only way.
 *
 * The list is now broad by request — every strategy, filter, exit, safety,
 * execution and risk parameter the bot has. What that means, stated plainly:
 * the tuner can change **how much money is at stake per trade** and **how much
 * you can lose in a day**. In paper mode that is free. In live mode it is not,
 * and the bounds below are the only thing standing between a bad inference and
 * a bad afternoon. They are all tighter than the config schema allows.
 *
 * Four things are still excluded, each for a reason that is not about taste:
 *
 *  - **The tuner's own settings** (`AUTO_TUNE_ENABLED`, `TUNER_*`). They are
 *    the enforcement mechanism. A system that can relax its own step cap or
 *    its own minimum sample has no step cap and no minimum sample. They are
 *    also read mid-experiment to decide baselines, so changing them corrupts
 *    the measurement that decides whether a change survives.
 *  - **The fee constants** (`PROGRAM_FEE_PCT`, `ROUTER_FEE_PCT`) and
 *    `SOL_USD_FALLBACK`. These are not choices, they are measurements of the
 *    world. The breakeven the ratchet exits on is computed from them, so
 *    "tuning" them does not change what a trade costs — it only makes the bot
 *    wrong about it, and it will then hold losers below true breakeven.
 *  - **`BOT_*_ENABLED`.** Turning a bot off stops the data the tuner learns
 *    from; turning one on spends money on a strategy you switched off. They
 *    are controls, not parameters, and they go through a different code path.
 *  - **`COPY_WALLETS`.** That is your list of people to follow — an input, not
 *    a parameter. Nothing should be able to quietly drop a wallet from it.
 *  - **`PAPER_STARTING_BALANCE_SOL`.** The size of the simulated bankroll, and
 *    so the denominator every paper result is measured against. Position sizing,
 *    `MIN_WALLET_RESERVE_SOL` and the loss limits all derive from the balance, so
 *    a tuner able to raise it could improve its own expectancy by loosening the
 *    checks rather than by trading better. That is not tuning, it is marking its
 *    own homework.
 *  - **`LOG_LEVEL`.** Terminal verbosity, with — in the tuner's own words when
 *    it changed it — "no trading effect". It was reached for as a way to see the
 *    reject breakdown, which is a fair thing to want and the wrong way to get it:
 *    the tuner cannot read the terminal, only the evidence block, so the change
 *    bought nothing. Worse, it costs one of TUNER_MAX_CHANGES_PER_ROUND and rides
 *    in the same experiment as a real change, so a revert reverts both and the
 *    real one is measured against a slot it had to share. The reject breakdown
 *    belongs in the evidence, and now is.
 *  - **The arbitrage paper frictions** (`ARB_PAPER_ADVERSE_SLIPPAGE_BPS`,
 *    `ARB_PAPER_LEG_FAILURE_RATE`, `ARB_PAPER_UNWIND_RECOVERY_PCT`). These are
 *    the simulator's pessimism, not the strategy's behaviour. A tuner able to
 *    lower them would improve every measured result without the strategy getting
 *    better at anything — the same "marking its own homework" as raising the
 *    paper balance, and worse here, because the whole point of the arbitrage tab
 *    is that its paper numbers can be trusted.
 *  - **`ARB_TOKENS` and `ARB_VENUES`.** Which assets and venues to look at is
 *    your input, the same as `COPY_WALLETS`. Nothing should quietly drop a route
 *    from the list it is being measured on.
 *  - **`DISCOVERY_SOURCE`.** Read once, at construction. Changing it at runtime
 *    does nothing until a restart — which is worse than not offering it, since
 *    the tuner would spend a whole measurement window on a change that had no
 *    effect and then draw a conclusion from the noise.
 *
 * Locked keys are refused one layer down by RuntimeSettings regardless of what
 * appears here: mode, executor, the wallet key, RPC URLs, the dashboard, the
 * data directory, and the PumpPortal endpoints. That last pair matters more
 * than it looks — the trade endpoint returns the transaction bytes we sign, so
 * repointing it is repointing what gets signed.
 *
 * A test walks every key in the config schema and fails if it is not tunable,
 * locked, or on the excluded list above. "Everything is reachable" is therefore
 * checked rather than asserted.
 */
export type TunableKind = 'number' | 'boolean' | 'enum' | 'text';

export interface Tunable {
  key: string;
  /** Which bot's evidence justifies moving it. */
  bot: BotId | 'shared';
  kind: TunableKind;
  /** Numbers only. */
  min?: number;
  max?: number;
  /**
   * Numbers only: largest single-round move as a share of the current value.
   *
   * The effective cap is the tighter of this and `TUNER_MAX_STEP_PCT`, so a
   * parameter can be held stricter than the global setting but never looser.
   * Raise `TUNER_MAX_STEP_PCT` if you want the wider allowances here to be
   * reachable at all — at the default of 30 most of them are not.
   */
  maxStepPct?: number;
  /**
   * Numbers only: this parameter counts things, so fractions are meaningless.
   *
   * A percentage step cap does not work on small integers — 30% of 2 holders is
   * 0.6, which produced `MIN_HOLDERS: 2 -> 2.6`, a threshold that reads as
   * nonsense, cannot be explained back to the model in the terms it proposed,
   * and silently means 3. Integer parameters are rounded and are always allowed
   * to move by at least one whole unit, or they could never move at all.
   */
  integer?: boolean;
  /** Enums only. */
  options?: string[];
  /** Text only: what a valid value looks like. */
  pattern?: RegExp;
  /**
   * True for parameters that decide how much capital is exposed, rather than
   * what gets traded. Surfaced in the log and on the dashboard so a change to
   * one is never quiet.
   */
  risk?: boolean;
  /** Told to the model, so it knows what the value does. */
  what: string;
}

const n = (
  key: string,
  bot: Tunable['bot'],
  min: number,
  max: number,
  maxStepPct: number,
  what: string,
  risk = false,
): Tunable => ({ key, bot, kind: 'number', min, max, maxStepPct, what, ...(risk && { risk }) });

/** A number that counts things: rounded, and always free to move by one. */
const i = (
  key: string,
  bot: Tunable['bot'],
  min: number,
  max: number,
  maxStepPct: number,
  what: string,
  risk = false,
): Tunable => ({ ...n(key, bot, min, max, maxStepPct, what, risk), integer: true });

const b = (key: string, bot: Tunable['bot'], what: string): Tunable => ({
  key,
  bot,
  kind: 'boolean',
  what,
});

const e = (key: string, bot: Tunable['bot'], options: string[], what: string): Tunable => ({
  key,
  bot,
  kind: 'enum',
  options,
  what,
});

export const TUNABLES: Tunable[] = [
  // === Screener entry filters ==========================================
  n('SCREEN_MIN_VOLUME_USD', 'screener', 500, 100_000, 50,
    'Minimum traded volume before a token is bought. Higher = fewer, busier tokens.'),
  n('SCREEN_MIN_MCAP_USD', 'screener', 2000, 100_000, 50,
    'Minimum market cap. Higher = later entries on tokens that already moved.'),
  n('SCREEN_MAX_MCAP_USD', 'screener', 0, 500_000, 60,
    'Maximum market cap; 0 disables. Lower = refuses to buy tops.'),
  i('SCREEN_MIN_SOCIALS', 'screener', 0, 3, 100, 'Social links required in metadata (0-3).'),
  n('SCREEN_MAX_AGE_SECONDS', 'screener', 30, 3600, 50,
    'Oldest a token can be at entry. Lower = only fresh launches.'),
  n('SCREEN_MIN_AGE_SECONDS', 'screener', 0, 600, 100,
    'Youngest a token can be at entry. Higher = lets the first spike pass first.'),
  i('SCREEN_MIN_BUYERS', 'screener', 0, 100, 100,
    'Distinct buyers required; 0 disables. Higher = demands real participation.'),
  n('SCREEN_POLL_INTERVAL_MS', 'screener', 500, 10_000, 50,
    'How often watched bonding curves are re-read. Lower spots a match sooner and costs RPC.'),
  i('SCREEN_POLL_MAX_TOKENS', 'screener', 50, 2000, 50,
    'How many tokens are watched at once. Higher covers more launches and costs RPC.'),
  n('ENTRY_QUEUE_MAX_WAIT_SECONDS', 'screener', 2, 120, 60,
    'How long a matched token waits behind another entry before it is dropped as stale.'),
  // --- Flow signals. Off at 0; each reads state already collected. -----
  n('SCREEN_MAX_SECONDS_SINCE_TRADE', 'screener', 0, 600, 100,
    'Reject if nothing has traded for this long. Catches a wave that already stalled.'),
  n('SCREEN_MAX_DRAWDOWN_PCT', 'screener', 0, 90, 100,
    'Reject if price is this far below its high. Refuses the second half of a move.'),
  n('SCREEN_MIN_BUYER_ACCEL', 'screener', 0, 10, 100,
    'Buyers in the last 60s over the 60s before. Above 1 means the wave is still building.'),
  n('SCREEN_MIN_NET_FLOW_SOL', 'screener', 0, 100, 100,
    'Buy volume minus sell volume. A ratio hides whether that is 0.2 SOL or 20.'),
  n('SCREEN_MIN_AVG_BUY_SOL', 'screener', 0, 20, 100,
    'Floor on average buy size — filters dust-sized participation.'),
  n('SCREEN_MAX_AVG_BUY_SOL', 'screener', 0, 100, 100,
    'Ceiling on average buy size — catches one whale posing as a crowd.'),
  n('SCREEN_MIN_LARGEST_BUY_SOL', 'screener', 0, 100, 100,
    'Largest single buy. Someone taking real size is a different signal from many small ones.'),
  i('SCREEN_MIN_REPEAT_BUYERS', 'screener', 0, 100, 100,
    'Wallets that bought twice. Conviction rather than a glance.'),
  n('SCREEN_MIN_CURVE_PROGRESS_PCT', 'screener', 0, 95, 100,
    'Progress toward graduating off the bonding curve, 0-100.'),
  n('SCREEN_MAX_CURVE_PROGRESS_PCT', 'screener', 0, 100, 100,
    'Upper bound on curve progress; 0 disables.'),
  n('SCREEN_MIN_COPY_HOLDERS', 'screener', 0, 10, 100,
    'Require this many tracked copy wallets to be holding it. Free signal, and one ' +
      'nobody screening the same public data has. Needs the copy bot running with wallets.'),

  e('SCREEN_ON_SOCIALS_UNAVAILABLE', 'screener', ['allow', 'deny'],
    'What to do when metadata cannot be read: allow the entry or block it.'),
  e('SCREEN_DATA_SOURCE', 'screener', ['both', 'curve', 'feed'],
    'Where screener numbers come from: our own RPC, the trade feed, or both.'),
  {
    key: 'SCREEN_ALLOWED_POOLS',
    bot: 'screener',
    kind: 'text',
    pattern: /^(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk)(,(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk))*$/,
    what: 'Comma-separated venues to trade, e.g. "pump" or "pump,pump-amm".',
  },
  {
    key: 'SNIPE_ALLOWED_POOLS',
    bot: 'sniper',
    kind: 'text',
    pattern: /^(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk)(,(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk))*$/,
    what: 'Comma-separated venues the sniper will buy on. "pump" alone is ' +
      'pump.fun standard launches; every other value is a different launchpad, ' +
      'whose launches the rest of the sniper is not modelled for.',
  },

  // === Momentum entry (ENTRY_MODE=fast) ================================
  n('MOMENTUM_WINDOW_SECONDS', 'screener', 5, 300, 60, 'Window the momentum trigger measures over.'),
  n('MOMENTUM_MIN_AGE_SECONDS', 'screener', 0, 600, 100, 'Youngest a token can be to trigger.'),
  n('MOMENTUM_MAX_AGE_SECONDS', 'screener', 30, 7200, 60, 'Oldest a token can be to trigger.'),
  n('MOMENTUM_MIN_GAIN_PCT', 'screener', 1, 200, 50, 'Gain in the window that counts as momentum.'),
  i('MOMENTUM_MIN_BUYERS', 'screener', 1, 100, 60, 'Distinct buyers in the window.'),
  n('MOMENTUM_MIN_VOLUME_SOL', 'screener', 0, 100, 60, 'SOL volume in the window.'),
  n('MOMENTUM_MIN_BUY_SELL_RATIO', 'screener', 0.5, 10, 40, 'Buys per sell — one-sided flow.'),
  n('MOMENTUM_MAX_CHASE_PCT', 'screener', 20, 5000, 50,
    'Refuse to chase a token already up this much since first seen.'),
  n('MOMENTUM_REENTRY_COOLDOWN_SECONDS', 'screener', 0, 7200, 60,
    'Cooldown before the same token can trigger again.'),

  // === Watchlist traction gate =========================================
  i('WATCHLIST_MAX_SIZE', 'screener', 100, 50_000, 60, 'How many tokens are tracked at once.'),
  n('WATCH_MIN_AGE_SECONDS', 'screener', 5, 600, 100, 'Youngest a token is considered.'),
  n('WATCH_MAX_AGE_SECONDS', 'screener', 900, 7200, 60, 'Oldest a token is considered.'),
  i('MIN_UNIQUE_BUYERS', 'screener', 1, 200, 60, 'Distinct buyers before a token is taken seriously.'),
  n('MIN_BUY_VOLUME_SOL', 'screener', 0, 100, 60, 'Buy volume before a token is taken seriously.'),
  n('MIN_PRICE_CHANGE_PCT', 'screener', -90, 200, 100, 'Price change required since first seen.'),
  i('MIN_RECENT_BUYERS', 'screener', 0, 100, 100, 'Buyers in the most recent window.'),

  // === Sniper: the safety battery ======================================
  n('MIN_SAFETY_SCORE', 'sniper', 40, 95, 20,
    'Safety score a launch must clear. Higher = fewer, structurally cleaner launches.'),
  n('SNIPE_CONFIRM_MS', 'sniper', 0, 30_000, 100,
    'Wait this long after the battery passes, re-read the price, and only buy if ' +
    'it held or rose. 0 SWITCHES THE GATE OFF. This is the only entry check that ' +
    'asks whether anyone else is buying rather than whether the token is ' +
    'structurally sound, which is what the dead_entry mass is made of. Not free: ' +
    'the cost is being this much later into every launch that does work, so it ' +
    'trades upside for fewer non-starters. Costs 2 RPC reads per passing candidate.'),
  n('SNIPE_CONFIRM_MIN_GAIN_PCT', 'sniper', -20, 100, 100,
    'How far the price must have risen over SNIPE_CONFIRM_MS to buy. 0 means ' +
    '"must not be down", the weakest useful form. Negative tolerates a dip. ' +
    'Inert while SNIPE_CONFIRM_MS is 0.'),
  n('MAX_CANDIDATE_AGE_MS', 'sniper', 1000, 60_000, 50,
    'How stale a launch can be before the sniper ignores it.'),
  n('MAX_DEV_BUY_PCT', 'sniper', 1, 50, 40,
    'How much of supply the deployer may buy at creation before it is a red flag.'),
  n('MAX_TOP10_HOLDER_PCT', 'sniper', 20, 95, 30, 'Concentration limit across the top ten holders.'),
  n('MIN_DEPLOYER_BALANCE_SOL', 'sniper', 0, 10, 100,
    'Below this the deployer looks like a throwaway wallet.'),
  n('MAX_DEPLOYER_BALANCE_SOL', 'sniper', 0, 200, 100,
    'Reject a deployer holding MORE than this; 0 SWITCHES THE CHECK OFF. The ' +
    'counterintuitive half of the pair — a well-funded deployer has the capital ' +
    'to bundle a launch and the patience to dump into it, so the profitable ' +
    'cohort can be the nearly-empty wallets. Use with MIN_DEPLOYER_BALANCE_SOL ' +
    'to express a band; the two are cross-validated so a band that excludes ' +
    'everything is refused rather than silently stopping all trading. Free — ' +
    'reuses the balance read MIN_DEPLOYER_BALANCE_SOL already makes.'),
  n('MAX_DEPLOYER_RUG_RATE', 'sniper', 0.05, 1, 50,
    'Share of a deployer past launches that rugged before we refuse them.'),
  n('DUPLICATE_NAME_WINDOW_MINUTES', 'sniper', 0, 720, 60,
    'Window for spotting a copycat wave of the same ticker.'),
  i('SNIPER_MAX_CONCURRENT_CHECKS', 'sniper', 1, 32, 50,
    'Safety batteries run at once. Higher covers more launches and risks RPC rate limits.'),
  b('REQUIRE_SOCIALS', 'sniper', 'Whether a launch must declare socials to pass.'),

  // --- Provenance. Each costs an RPC call on the entry path. ------------
  i('MIN_HOLDERS', 'sniper', 0, 20, 100,
    'Distinct wallets holding, excluding the curve. Whole wallets — 0 SWITCHES THE ' +
      'CHECK OFF. Free: reuses a read the concentration check already makes. Note the ' +
      'sniper buys at creation, where the only holders are the curve and the deployer, ' +
      'so anything above 2 or 3 rejects most fresh launches.'),
  n('MIN_CREATOR_AGE_MINUTES', 'sniper', 0, 10_080, 100,
    'Minimum age of the deployer wallet in minutes; 0 SWITCHES THE CHECK OFF. Catches a ' +
      'funded throwaway, which a balance check alone does not. One RPC call. Movable from ' +
      '0 — the step cap does not trap it there.'),
  i('MAX_LAUNCH_BUNDLE_TXS', 'sniper', 0, 40, 100,
    'Reject when MORE than this many transactions landed in the creation slot — a bundled ' +
      'launch whose first buyers are the deployer. 0 SWITCHES THE CHECK OFF; it does not ' +
      'mean "reject anything bundled". A normal creation slot holds the create transaction ' +
      'and the deployer buy, so 2-3 is the floor worth setting. One RPC call.'),
  b('REJECT_IF_DEPLOYER_EXITED', 'sniper',
    'Reject when the deployer has already sold out of their own token. One RPC call.'),

  // === Copy trader =====================================================
  n('COPY_MIN_BUY_SOL', 'copy', 0.05, 25, 50,
    'Ignore their buys below this SOL value — the volume-bump filter.'),
  n('COPY_MAX_BUY_SOL', 'copy', 0, 500, 60, 'Ignore their buys above this; 0 disables.'),
  n('COPY_SELL_MULTIPLIER', 'copy', 0.5, 3, 40,
    'Multiplier on the fraction they sell. Above 1 exits faster than they do.'),
  n('COPY_FULL_EXIT_AT_PCT', 'copy', 50, 100, 25,
    'Close fully once they have sold this share of their holding.'),
  n('COPY_MAX_HOLD_SECONDS', 'copy', 300, 604_800, 60,
    'Backstop exit for a wallet that goes quiet holding a dead token.'),
  n('COPY_POLL_INTERVAL_MS', 'copy', 300, 10_000, 50,
    'How often tracked wallets are re-read. This is how late you are to their trades.'),
  n('COPY_BUY_AMOUNT_SOL', 'copy', 0.01, 5, 30,
    'SOL per copied position in fixed sizing mode. REAL MONEY in live mode.', true),
  n('COPY_RATIO', 'copy', 0.01, 2, 40,
    'Share of their size to mirror in proportional mode. REAL MONEY in live mode.', true),
  n('COPY_MAX_POSITION_SOL', 'copy', 0.01, 10, 30,
    'Hard ceiling on one copied position. REAL MONEY in live mode.', true),
  e('COPY_SIZE_MODE', 'copy', ['fixed', 'proportional'],
    'Size every copy the same, or scale it to what they spent.'),
  b('COPY_SKIP_PREEXISTING', 'copy', 'Whether to ignore tokens a wallet already held when tracking began.'),
  {
    key: 'COPY_ALLOWED_POOLS',
    bot: 'copy',
    kind: 'text',
    pattern: /^(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk)(,(pump|pump-amm|raydium|raydium-cpmm|launchlab|bonk))*$/,
    what: 'Comma-separated venues to follow them into.',
  },

  // === Ratchet exit ====================================================
  n('CHECKPOINT_SECONDS', 'shared', 20, 600, 40,
    'How often the ratchet asks whether the price is higher than last time.'),
  n('RATCHET_FIRST_CHECKPOINT_SECONDS', 'shared', 10, 300, 50,
    'Length of the first window only — how long a dead entry is given.'),
  n('RECOVER_AT_GAIN_PCT', 'shared', 25, 300, 40,
    'Gain at which the stake comes off the table and the rest rides free.'),
  n('RATCHET_GIVEBACK_PCT', 'shared', 0, 80, 50,
    'Close if this share of the best GAIN is handed back. Never fires on a loser.'),
  n('MOONBAG_TRIM_PCT', 'shared', 0, 60, 50,
    'Share of a surviving moonbag skimmed at each checkpoint.'),
  n('RATCHET_MIN_PROGRESS_PCT', 'shared', 0, 25, 100,
    'How much higher than the last checkpoint counts as still rising.'),
  n('MAX_HOLD_SECONDS', 'shared', 300, 604_800, 60,
    'Absolute backstop on how long any position is held.'),
  n('RATCHET_STOP_LOSS_PCT', 'shared', 0, 90, 100,
    'Hard stop in ratchet mode; 0 means none. THIS IS THE RISK DECISION: with no ' +
      'stop, one trade can lose the entire position.', true),

  // === Ladder exit (EXIT_MODE=ladder) ==================================
  // The pair is cross-validated: the trailing stop must be wider than the hard
  // stop, or it fires on entry noise. Bounds that cannot violate that leave the
  // tuner free to move either one without the patch being refused whole.
  n('STOP_LOSS_PCT', 'shared', 10, 38, 40, 'Hard stop in ladder mode.', true),
  n('TRAILING_STOP_PCT', 'shared', 42, 95, 40, 'Trailing stop once a rung has filled.'),
  n('MOONBAG_TRAILING_STOP_PCT', 'shared', 10, 95, 40, 'Trailing stop on the moonbag.'),
  n('TIME_STOP_SECONDS', 'shared', 10, 3600, 50, 'Cut a position that has gone nowhere by now.'),
  n('TIME_STOP_MIN_GAIN_PCT', 'shared', -50, 200, 100, 'What counts as "gone nowhere".'),
  {
    key: 'EXIT_LADDER',
    bot: 'shared',
    kind: 'text',
    pattern: /^\d+(\.\d+)?:\d+(\.\d+)?(,\d+(\.\d+)?:\d+(\.\d+)?)*$/,
    what: 'Take-profit rungs as gain:sellPct pairs, e.g. "60:40,150:30,400:20".',
  },

  // === Scalp exit (EXIT_MODE=scalp) ====================================
  n('SCALP_TARGET_NET_PCT', 'shared', 1, 200, 50, 'Net profit target after all fees.'),
  n('SCALP_STOP_LOSS_PCT', 'shared', 1, 90, 40, 'Hard stop in scalp mode.', true),
  n('SCALP_TIME_STOP_SECONDS', 'shared', 10, 3600, 50, 'Cut a scalp that has not worked by now.'),
  n('SCALP_BREAKEVEN_ARM_PCT', 'shared', 0, 50, 100, 'Gain at which the stop moves to breakeven.'),
  n('SCALP_GIVEBACK_PCT', 'shared', 5, 90, 50, 'Share of the peak gain that may be handed back.'),
  n('SCALP_RUNNER_PCT', 'shared', 0, 60, 60, 'Share kept back after the target fills.'),
  n('SCALP_RUNNER_TRAILING_STOP_PCT', 'shared', 5, 95, 40, 'Trailing stop on that runner.'),

  // === Which entry and exit machinery runs at all ======================
  e('ENTRY_MODE', 'shared', ['screener', 'fast', 'ai', 'rules'],
    'How entries are decided: the screener filter, a momentum trigger, Claude, or creation-time rules.'),
  e('EXIT_MODE', 'shared', ['ratchet', 'scalp', 'ladder'],
    'Which exit machinery runs. Switching this changes every exit at once.'),

  // === Exit execution ==================================================
  i('EXIT_MAX_ATTEMPTS', 'shared', 3, 60, 50, 'Sell attempts before a position is written off.'),
  n('EXIT_RETRY_SECONDS', 'shared', 2, 300, 60, 'Gap between sell attempts.'),
  n('PRICE_STALE_SECONDS', 'shared', 60, 7200, 60,
    'How long an unreadable price is tolerated before giving up on a position.'),
  // The floor on how late any stop can fire. Every exit rule is evaluated on
  // this beat, so a loss realised is always the trigger plus whatever the price
  // did since the last look — which on a token doing most of its falling in a
  // few seconds is the larger of the two terms.
  n('POSITION_TICK_INTERVAL_MS', 'shared', 250, 30_000, 40,
    'How often open positions are re-priced and checked for an exit. Lower is ' +
      'tighter stops and more RPC load.'),
  n('POSITION_PRICE_TIMEOUT_MS', 'shared', 500, 30_000, 40,
    'Deadline on one position price read before it is abandoned and retried.'),

  // === Trade execution =================================================
  n('BUY_SLIPPAGE_PCT', 'shared', 1, 60, 40,
    'Slippage tolerated on entry. Too low misses fills, too high pays up.', true),
  n('SELL_SLIPPAGE_PCT', 'shared', 1, 80, 40,
    'Slippage tolerated on exit. Too low means the sell does not land.', true),
  n('PRIORITY_FEE_SOL', 'shared', 0, 0.02, 60,
    'Priority fee per transaction. Buys inclusion speed; a fixed cost per trade.', true),
  n('JITO_TIP_SOL', 'shared', 0, 0.02, 100, 'Jito bundle tip, when used.', true),

  // === Risk limits =====================================================
  // These decide how much can be lost, not what gets traded. Included by
  // explicit request; every one is bounded well inside the config schema.
  n('BUY_AMOUNT_SOL', 'shared', 0.01, 2, 25,
    'SOL committed per position. THE most consequential number here: it sets ' +
      'both the fee drag (a fixed priority fee hurts small positions most) and ' +
      'how much a single bad trade costs. REAL MONEY in live mode.', true),
  i('MAX_CONCURRENT_POSITIONS', 'shared', 1, 20, 50,
    'Positions open at once. Multiplies total exposure.', true),
  n('DAILY_LOSS_LIMIT_SOL', 'shared', 0.1, 20, 30,
    'Realised loss that stops trading for the day. The backstop on a bad day.', true),
  n('HOURLY_SPEND_CAP_SOL', 'shared', 0.1, 50, 40,
    'SOL that may be deployed per hour.', true),
  i('MAX_CONSECUTIVE_LOSSES', 'shared', 2, 30, 50,
    'Losing streak that trips the circuit breaker.', true),
  n('BREAKER_COOLDOWN_SECONDS', 'shared', 60, 21_600, 60,
    'How long the breaker stays tripped.', true),
  n('MIN_WALLET_RESERVE_SOL', 'shared', 0, 5, 50,
    'SOL never spent, so fees and exits are always affordable.', true),

  // === Arbitrage ========================================================
  n('ARB_MIN_PROFIT_BPS', 'arb', 5, 500, 50,
    'Minimum net edge in basis points after every modelled cost. THE central ' +
    'parameter: it decides whether anything trades at all. Too low and the bot ' +
    'trades noise that cannot survive real slippage; too high and it watches. ' +
    'The rejected-edge distribution in the evidence is what says where it belongs.'),
  n('ARB_SLIPPAGE_BPS', 'arb', 5, 500, 50,
    'Slippage tolerance sent to the aggregator, per leg. Wider lands more trades ' +
    'and lands them worse; the worst-case gate refuses a route whose tolerance is ' +
    'wider than its own edge.'),
  n('ARB_MAX_PRICE_IMPACT_PCT', 'arb', 0.05, 5, 50,
    'Reject a route whose own price impact exceeds this. Our trade moves the pool, ' +
    'and on a thin route it moves it past the edge we came for.'),
  n('ARB_QUOTE_MAX_AGE_MS', 'arb', 500, 30_000, 60,
    'Discard a loop whose oldest leg is older than this. The two legs are quoted ' +
    'sequentially, so leg one is always the stale one — tighten this and fewer ' +
    'loops survive, but the ones that do priced against live pools.'),
  n('ARB_POLL_INTERVAL_MS', 'arb', 1000, 120_000, 50,
    'Gap between scan cycles. Lower sees more dislocations and spends more quota.'),
  n('ARB_QUOTE_INTERVAL_MS', 'arb', 250, 5000, 50,
    'Minimum gap between Jupiter requests. The free tier meters per second, so ' +
    'lowering this earns 429s — and a 429 costs more time than the spacing saved.'),
  n('ARB_PRIORITY_FEE_MICROLAMPORTS', 'arb', 0, 2_000_000, 60,
    'Priority fee per leg. Raises the chance a leg lands AND raises the fixed cost ' +
    'per attempt, which raises the break-even size. Both directions cost money.'),
  i('ARB_COMPUTE_UNIT_LIMIT', 'arb', 50_000, 1_000_000, 40,
    'Compute units requested per leg. Multiplies the priority fee.'),
  b('ARB_REQUIRE_WORST_CASE', 'arb',
    'Require the WORST case to clear the floor, not just the expected case. Off ' +
    'means trading routes whose on-chain minimum is a loss.'),
  b('ARB_ASSUME_ATA_RENT', 'arb',
    'Charge one-off token-account rent in the cost model. Conservative when on.'),
  n('ARB_ROUTE_COOLDOWN_MS', 'arb', 0, 1_800_000, 100,
    'After trading a route, ignore it for this long. The limit that stops a ' +
    'dislocation that was not real being traded again on the very next scan.'),
  {
    key: 'ARB_STRATEGIES',
    bot: 'arb',
    kind: 'text',
    pattern: /^(cycle|cross-dex)(,(cycle|cross-dex))*$/,
    what: 'Comma-separated: "cycle" quotes an aggregated route both ways; ' +
      '"cross-dex" quotes each leg on individual venues and keeps the best, which ' +
      'finds dislocations the aggregator nets out internally but costs one quote ' +
      'per venue per leg.',
  },
  n('ARB_TRADE_SIZE_SOL', 'arb', 0.05, 20, 40,
    'SOL committed per attempt. Fees are FIXED per attempt while the edge scales ' +
    'with size, so below the break-even size the strategy loses money on winning ' +
    'trades. REAL MONEY in live mode.', true),
  i('ARB_MAX_TRADES_PER_HOUR', 'arb', 1, 500, 50,
    'Attempts per hour. Bounds the fast-loop failure mode.', true),
  n('ARB_MAX_DAILY_LOSS_SOL', 'arb', 0.01, 20, 40,
    'Realised loss that halts arbitrage for the day.', true),
  i('ARB_MAX_CONSECUTIVE_FAILURES', 'arb', 2, 50, 50,
    'Failures in a row before arbitrage halts. A streak usually means a broken ' +
    'assumption rather than bad luck.', true),
  n('ARB_MIN_RESERVE_SOL', 'arb', 0, 5, 50,
    'SOL never committed, so fees stay affordable.', true),

  // === Infrastructure ==================================================
  n('RPC_MAX_REQUESTS_PER_SEC', 'shared', 5, 500, 50,
    'Ceiling on the RPC rate, not the rate itself: the throttle opens at half ' +
    'this and finds the endpoint\'s real limit by backing off whenever it is ' +
    'refused. Lowering it does not fix rate limiting — that is already handled ' +
    'in the loop — it only caps how fast the bot can ever go. Raise it if the ' +
    'dashboard shows the rate pinned at the ceiling with no 429s.'),
  i('RPC_MAX_CONCURRENT', 'shared', 2, 64, 50, 'RPC requests in flight at once.'),
  i('RPC_MAX_RETRIES', 'shared', 1, 10, 100, 'Retries on a 429 or 5xx.'),

  // === AI analyst (ENTRY_MODE=ai) ======================================
  n('AI_MIN_CONFIDENCE', 'shared', 30, 95, 30, 'Confidence the analyst must express to buy.'),
  n('AI_REVIEW_INTERVAL_SECONDS', 'shared', 20, 1800, 50, 'How often the analyst reviews.'),
  n('AI_MAX_CALLS_PER_HOUR', 'shared', 1, 500, 50, 'Hard cap on analyst calls per hour.'),
  n('AI_DAILY_BUDGET_USD', 'shared', 0, 200, 50, 'Daily spend cap for the analyst.'),
  n('AI_TIMEOUT_MS', 'shared', 5000, 300_000, 50, 'How long an analyst call may take.'),
  n('AI_TUNER_TIMEOUT_MS', 'shared', 30_000, 900_000, 50, 'How long a tuning call may take.'),
  b('AI_MANAGE_EXITS', 'shared', 'Whether the analyst may also decide exits.'),
  e('AI_EFFORT', 'shared', ['low', 'medium', 'high'], 'Reasoning effort for analyst calls.'),
  e('STRATEGY', 'shared', ['ai', 'rules'],
    'ai runs the watchlist orchestrator (screener, fast and ai entry modes live inside it); ' +
      'rules is the creation-time sniper path only.'),
  // An enum rather than free text: a name the API does not know fails every
  // call, and this is the model making the call.
  e('AI_MODEL', 'shared',
    ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5-20251001'],
    'Which model the analyst and this tuner use. Changes cost per call materially.'),
];

export const TUNABLE_BY_KEY = new Map(TUNABLES.map((t) => [t.key, t]));

/** Keys that move capital at risk rather than trade selection. */
export const RISK_KEYS = new Set(TUNABLES.filter((t) => t.risk).map((t) => t.key));

export type ProposedValue = number | string | boolean;

export type VetResult =
  | { ok: true; value: string; typed: ProposedValue; clamped?: string }
  | { ok: false; reason: string };

/**
 * Clamps a proposal to what is allowed, or rejects it.
 *
 * Returns the string to write (settings are applied as raw strings and
 * re-parsed through the same schema a human's input goes through) plus a note
 * when it had to be trimmed, so the audit trail records that the model asked
 * for more than it got rather than showing the trimmed number as its idea.
 */
export function vetProposal(
  key: string,
  currentRaw: string,
  proposed: ProposedValue,
  maxStepPctOverride?: number,
): VetResult {
  const spec = TUNABLE_BY_KEY.get(key);
  if (!spec) return { ok: false, reason: `${key} is not tunable` };

  if (spec.kind === 'boolean') {
    const want = typeof proposed === 'boolean' ? proposed : String(proposed).toLowerCase() === 'true';
    const now = currentRaw.toLowerCase() === 'true';
    if (want === now) return { ok: false, reason: `${key}: already ${now}` };
    return { ok: true, value: String(want), typed: want };
  }

  if (spec.kind === 'enum') {
    const want = String(proposed).trim();
    if (!spec.options?.includes(want)) {
      return { ok: false, reason: `${key}: "${want}" is not one of ${spec.options?.join(', ')}` };
    }
    if (want === currentRaw) return { ok: false, reason: `${key}: already ${want}` };
    return { ok: true, value: want, typed: want };
  }

  if (spec.kind === 'text') {
    const want = String(proposed).replace(/\s+/g, '');
    if (spec.pattern && !spec.pattern.test(want)) {
      return { ok: false, reason: `${key}: "${want}" is not a valid value` };
    }
    if (want === currentRaw.replace(/\s+/g, '')) return { ok: false, reason: `${key}: unchanged` };
    return { ok: true, value: want, typed: want };
  }

  // --- numbers -----------------------------------------------------------
  const current = Number(currentRaw);
  const asked = Number(proposed);
  if (!Number.isFinite(asked)) return { ok: false, reason: `${key}: not a number` };
  if (!Number.isFinite(current)) return { ok: false, reason: `${key}: no current numeric value` };

  let value = asked;
  const notes: string[] = [];

  if (spec.min !== undefined && value < spec.min) {
    notes.push(`raised to the floor ${spec.min}`);
    value = spec.min;
  }
  if (spec.max !== undefined && value > spec.max) {
    notes.push(`cut to the ceiling ${spec.max}`);
    value = spec.max;
  }

  // A value already OUTSIDE the allowed range is a special case. The step cap
  // exists to stop drift within the range; applied to a setting parked far
  // outside it, it becomes a trap — from 100 against a ceiling of 20, a 30%
  // step reaches 70, then 49, then 34, and five rounds are spent walking back
  // to a bound that was never in dispute. Let it go straight to the nearest
  // bound instead: that is a return to the sanctioned range, not a drift.
  const wasOutside =
    (spec.min !== undefined && current < spec.min) ||
    (spec.max !== undefined && current > spec.max);
  if (wasOutside) {
    // ...unless it is a RISK parameter. Those bounds describe what the tuner may
    // authorise, not what a sane value is, so a value parked outside them is a
    // deliberate human decision the tuner has no evidence about. Dragging
    // HOURLY_SPEND_CAP_SOL from a hand-set 100 down to the tuner's ceiling of 50
    // is a change to capital exposure nobody asked for, made as a side effect of
    // a proposal about something else — and one-way, since the same rule then
    // stops it going back. Decline and say so; the human can move it or the
    // ceiling can be widened deliberately.
    if (spec.risk) {
      return {
        ok: false,
        reason:
          `${key} is ${current}, outside the ${spec.min}..${spec.max} the tuner may set. ` +
          'It is a risk parameter, so it is left where it was put rather than pulled ' +
          'to the nearest bound.',
      };
    }
    return {
      ok: true,
      value: String(round(value)),
      typed: round(value),
      clamped: `${current} was outside the allowed ${spec.min}..${spec.max}; moved straight to ${round(value)}`,
    };
  }

  // Step limiting is what stops a series of individually reasonable rounds
  // from walking a parameter somewhere no single round would have proposed.
  //
  // The tighter of the global setting and this parameter's own allowance. The
  // global used to win outright, which made every hand-picked per-parameter cap
  // in this file dead code — `MIN_HOLDERS` is marked as able to move 100% for a
  // reason, and never could. Taking the minimum keeps the user's global control
  // real while letting a specific parameter be held stricter than it.
  const stepPct = Math.min(maxStepPctOverride ?? Infinity, spec.maxStepPct ?? 30);

  // A percentage of a small integer is not a step. 30% of 2 holders is 0.6, so
  // the cap either produces a fraction — the `MIN_HOLDERS: 2 -> 2.6` that
  // prompted this — or rounds away to no move at all, and the parameter is
  // frozen wherever it happens to sit. One whole unit is the smallest change
  // that means anything, so it is always allowed.
  const minRoom = spec.integer ? 1 : 0;
  if (current > 0) {
    const room = Math.max(current * (stepPct / 100), minRoom);
    let lo = Math.max(spec.min ?? -Infinity, current - room);
    let hi = Math.min(spec.max ?? Infinity, current + room);
    // Round the bounds too, not just the result, or the note explains a limit
    // to a value that was never reachable — "step limited from 6 to 5.2" on a
    // parameter that then becomes 5.
    if (spec.integer) {
      lo = Math.ceil(lo);
      hi = Math.floor(hi);
    }
    if (value < lo) {
      notes.push(`step limited from ${asked} to ${round(lo)}`);
      value = lo;
    } else if (value > hi) {
      notes.push(`step limited from ${asked} to ${round(hi)}`);
      value = hi;
    }
  } else if (current === 0 && spec.max !== undefined) {
    // A step cap is meaningless off zero — a percentage of nothing is nothing,
    // and the parameter could never leave. Allow a move, bounded by the range.
    const ceiling = Math.min(spec.max, Math.max(1, spec.max * 0.25));
    if (value > ceiling) {
      notes.push(`step limited from ${asked} to ${round(ceiling)}`);
      value = ceiling;
    }
  }

  value = spec.integer ? Math.round(value) : round(value);
  // Rounding to a whole unit can land back on the current value — asking for 4
  // holders from 2 with a 0.6 step gives 2.6, which rounds to 3, but asking for
  // 2.4 would give 2. Saying so is better than opening an experiment that
  // changes nothing and then measuring it for 150 trades.
  if (value === current) return { ok: false, reason: `${key}: no change after limits` };
  if (spec.min !== undefined && value < spec.min) value = spec.min;
  if (spec.max !== undefined && value > spec.max) value = spec.max;
  return notes.length > 0
    ? { ok: true, value: String(value), typed: value, clamped: notes.join('; ') }
    : { ok: true, value: String(value), typed: value };
}

/** Trims float noise so the audit trail reads as a decision, not an artefact. */
function round(v: number): number {
  return Number(v.toPrecision(6));
}
