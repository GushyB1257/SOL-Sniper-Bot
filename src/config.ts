import 'dotenv/config';
import { z } from 'zod';

/**
 * Config is validated once at boot. A bot that trades real money should refuse
 * to start on a malformed config rather than fall back to a default that
 * silently sizes positions wrong.
 */

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const num = (min: number, max: number) =>
  z.coerce.number().refine((n) => Number.isFinite(n) && n >= min && n <= max, {
    message: `must be a number between ${min} and ${max}`,
  });

/** Parses "60:40,150:30,400:20" into ladder tiers. */
const ladderSchema = z
  .string()
  .transform((raw, ctx) => {
    const tiers = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [g, s] = pair.split(':');
        return { gainPct: Number(g), sellPctOfOriginal: Number(s) };
      });

    if (tiers.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EXIT_LADDER is empty' });
      return z.NEVER;
    }
    for (const t of tiers) {
      if (!Number.isFinite(t.gainPct) || !Number.isFinite(t.sellPctOfOriginal)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `EXIT_LADDER entries must be "gain:sellPct" numbers, got "${raw}"`,
        });
        return z.NEVER;
      }
      if (t.sellPctOfOriginal <= 0 || t.sellPctOfOriginal > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `EXIT_LADDER sell percentages must be in (0,100], got ${t.sellPctOfOriginal}`,
        });
        return z.NEVER;
      }
    }

    // Tiers must ascend, otherwise a single price move fills them out of order
    // and the "sell some, keep some" shape breaks down.
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i]!.gainPct <= tiers[i - 1]!.gainPct) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'EXIT_LADDER gain thresholds must strictly ascend',
        });
        return z.NEVER;
      }
    }

    const totalSold = tiers.reduce((a, t) => a + t.sellPctOfOriginal, 0);
    if (totalSold > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `EXIT_LADDER sells ${totalSold}% of the position, which exceeds 100%`,
      });
      return z.NEVER;
    }
    return tiers;
  });

const POOLS = ['pump', 'pump-amm', 'raydium', 'raydium-cpmm', 'launchlab', 'bonk', 'auto'] as const;

/** Parses "pump,pump-amm" into a list of venues the screener will accept. */
const poolListSchema = z.string().transform((raw, ctx) => {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SCREEN_ALLOWED_POOLS is empty' });
    return z.NEVER;
  }
  for (const p of parts) {
    if (!(POOLS as readonly string[]).includes(p)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown pool "${p}"; valid values are ${POOLS.join(', ')}`,
      });
      return z.NEVER;
    }
  }
  return parts as unknown as Array<(typeof POOLS)[number]>;
});

const schema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),

  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),

  WALLET_PRIVATE_KEY: z.string().default(''),

  /**
   * Position size is the single most decisive parameter in a scalp strategy,
   * because the priority fee is FIXED per transaction and therefore a larger
   * share of a smaller position. At 0.05 SOL the round-trip breakeven move is
   * 6.3%; at 0.25 SOL it is 3.7%. Sizing down does not reduce risk here so much
   * as it raises the bar the trade has to clear to be worth taking at all.
   */
  BUY_AMOUNT_SOL: num(0.0001, 100).default(0.25),
  MAX_CONCURRENT_POSITIONS: num(1, 50).default(8),
  MIN_WALLET_RESERVE_SOL: num(0, 100).default(0.1),

  BUY_SLIPPAGE_PCT: num(0.1, 100).default(15),
  SELL_SLIPPAGE_PCT: num(0.1, 100).default(25),
  PRIORITY_FEE_SOL: num(0, 1).default(0.0008),
  JITO_TIP_SOL: num(0, 1).default(0),

  EXIT_LADDER: ladderSchema.default('60:40,150:30,400:20'),
  STOP_LOSS_PCT: num(1, 99).default(35),
  TRAILING_STOP_PCT: num(1, 99).default(45),
  MOONBAG_TRAILING_STOP_PCT: num(1, 99).default(70),
  TIME_STOP_SECONDS: num(5, 86400).default(180),
  TIME_STOP_MIN_GAIN_PCT: z.coerce.number().default(10),
  MAX_HOLD_SECONDS: num(60, 604800).default(86400),

  MAX_DEV_BUY_PCT: num(0, 100).default(8),
  MAX_TOP10_HOLDER_PCT: num(0, 100).default(65),
  MIN_DEPLOYER_BALANCE_SOL: num(0, 1000).default(0.15),
  MAX_DEPLOYER_RUG_RATE: num(0, 1).default(0.34),
  MIN_SAFETY_SCORE: num(0, 100).default(70),
  REQUIRE_SOCIALS: bool.default('true'),
  DUPLICATE_NAME_WINDOW_MINUTES: num(0, 1440).default(60),

  DAILY_LOSS_LIMIT_SOL: num(0, 1000).default(1.5),
  MAX_CONSECUTIVE_LOSSES: num(1, 100).default(6),
  BREAKER_COOLDOWN_SECONDS: num(0, 86400).default(900),
  HOURLY_SPEND_CAP_SOL: num(0, 1000).default(5),

  // === Entry path ===
  /**
   * screener : the filter a human watches, applied automatically — pool,
   *            volume, market cap, socials. Enters the instant a token matches.
   * fast     : deterministic momentum trigger on the trade stream.
   * ai       : Claude decides entries. Slower — the model thinks for seconds, so
   *            moves that complete in seconds are gone before it answers.
   * rules    : original creation-time sniper.
   */
  ENTRY_MODE: z.enum(['screener', 'fast', 'ai', 'rules']).default('screener'),

  // === Screener entry (ENTRY_MODE=screener) ===
  /** Venues to accept. "pump" alone means pump.fun standard coins only. */
  SCREEN_ALLOWED_POOLS: poolListSchema.default('pump'),
  /** Total traded volume, both sides, including the deployer's creation buy. */
  SCREEN_MIN_VOLUME_USD: num(0, 100_000_000).default(3000),
  SCREEN_MIN_MCAP_USD: num(0, 100_000_000).default(6000),
  /**
   * Optional ceiling on entry market cap. OFF by default, because it is not
   * part of the filter as specified — a token above it has matched, and
   * refusing to buy a match is the behaviour that makes the bot look broken.
   * Turn it on once the report shows high-cap entries losing money.
   */
  SCREEN_MAX_MCAP_USD: num(0, 100_000_000).default(0),
  /** Distinct social links (twitter/telegram/website) in the token metadata. */
  SCREEN_MIN_SOCIALS: num(0, 3).default(1),
  /**
   * What to do when the metadata cannot be read at all — a slow or
   * rate-limited IPFS gateway, not a token without socials. `allow` lets it
   * through, because failing closed on someone else's outage silently rejects
   * tokens that DO have socials. `deny` is the strict reading of the filter.
   */
  SCREEN_ON_SOCIALS_UNAVAILABLE: z.enum(['allow', 'deny']).default('allow'),
  SCREEN_MIN_AGE_SECONDS: num(0, 86_400).default(0),
  SCREEN_MAX_AGE_SECONDS: num(5, 86_400).default(600),
  /**
   * Optional minimum of distinct buying wallets. OFF by default for the same
   * reason as the cap ceiling: it is a tightener, not part of the filter.
   */
  SCREEN_MIN_BUYERS: num(0, 10_000).default(0),
  /**
   * Where the screener gets market cap and volume.
   *
   * curve : read each watched token's bonding curve over your own RPC. Exact
   *         market cap, and volume that is correct on the FIRST read of a
   *         token — the trade feed can only ever tell you about trades that
   *         happened after you subscribed.
   * feed  : PumpPortal's per-token trade stream only. Lower RPC load, but the
   *         whole strategy then depends on a free shared websocket honouring a
   *         subscription for every launch.
   * both  : the default. Whichever source saw more volume wins.
   */
  SCREEN_DATA_SOURCE: z.enum(['curve', 'feed', 'both']).default('both'),
  /** How often watched curves are re-read. */
  SCREEN_POLL_INTERVAL_MS: num(250, 60_000).default(1500),
  /**
   * Ceiling on tokens read per poll, youngest first. Each RPC call covers 100,
   * so 300 tokens every 1.5s is ~2 requests a second — comfortable on a free
   * Helius tier. Raise it if your node can take it.
   */
  SCREEN_POLL_MAX_TOKENS: num(0, 5000).default(300),
  /** Used to convert SOL to USD when the live price feed is unreachable. */
  SOL_USD_FALLBACK: num(1, 100_000).default(190),
  /**
   * Buys are serialised so two matches cannot both clear the position cap. A
   * match that waits longer than this behind other entries is dropped rather
   * than filled, because by then it is a different setup from the one that
   * matched.
   */
  ENTRY_QUEUE_MAX_WAIT_SECONDS: num(1, 300).default(20),

  // === Momentum trigger (ENTRY_MODE=fast) ===
  MOMENTUM_WINDOW_SECONDS: num(5, 600).default(30),
  MOMENTUM_MIN_AGE_SECONDS: num(0, 3600).default(15),
  MOMENTUM_MAX_AGE_SECONDS: num(10, 86400).default(900),
  MOMENTUM_MIN_GAIN_PCT: num(0.1, 10000).default(12),
  MOMENTUM_MIN_BUYERS: num(1, 1000).default(6),
  MOMENTUM_MIN_VOLUME_SOL: num(0, 10000).default(1.5),
  MOMENTUM_MIN_BUY_SELL_RATIO: num(0.1, 1000).default(1.8),
  /** Refuse to chase a token already up this much since first seen. */
  MOMENTUM_MAX_CHASE_PCT: num(0, 100000).default(250),
  /** Cooldown after a fill before the same token can trigger again. */
  MOMENTUM_REENTRY_COOLDOWN_SECONDS: num(0, 86400).default(600),

  // === Fee model (drives the scalp target) ===
  PROGRAM_FEE_PCT: num(0, 10).default(1),
  ROUTER_FEE_PCT: num(0, 10).default(0.5),

  // === Scalp exit ===
  /** true: exit on a fee-aware net target instead of the long ladder. */
  SCALP_MODE: bool.default('true'),
  /** Net profit target as a percent of the SOL committed, AFTER all fees. */
  SCALP_TARGET_NET_PCT: num(0.1, 1000).default(8),
  SCALP_STOP_LOSS_PCT: num(0.5, 95).default(18),
  SCALP_TIME_STOP_SECONDS: num(5, 3600).default(60),
  /** Once gross gain clears breakeven by this much, the stop moves to breakeven. */
  SCALP_BREAKEVEN_ARM_PCT: num(0, 100).default(3),
  /**
   * Percent of the peak GAIN that may be given back before exiting, once the
   * trade is meaningfully green. This is the one that matters for tokens that
   * pop for a few seconds and then crash: waiting for a +30% trade to fall all
   * the way back to breakeven hands back every point it made.
   */
  SCALP_GIVEBACK_PCT: num(1, 100).default(40),
  /** Percent of the position kept running after the target fills. */
  SCALP_RUNNER_PCT: num(0, 60).default(20),
  SCALP_RUNNER_TRAILING_STOP_PCT: num(1, 99).default(35),

  // === AI analyst ===
  /** ai: Claude decides entries and exits. rules: the original deterministic sniper. */
  STRATEGY: z.enum(['ai', 'rules']).default('ai'),
  ANTHROPIC_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  AI_TIMEOUT_MS: num(5_000, 300_000).default(60_000),
  /** Minimum confidence (0-100) the analyst must return before we act. */
  AI_MIN_CONFIDENCE: num(0, 100).default(65),
  /** Seconds between re-reviews of each open position. */
  AI_REVIEW_INTERVAL_SECONDS: num(15, 3600).default(90),
  /** Hard ceiling on analyst calls per hour, so a bad night can't run up a bill. */
  AI_MAX_CALLS_PER_HOUR: num(1, 10_000).default(60),
  /** Stop making calls once estimated spend for the UTC day exceeds this. */
  AI_DAILY_BUDGET_USD: num(0, 10_000).default(10),
  /**
   * Let Claude review and exit open positions. Off by default: the screener
   * strategy holds for under a minute, so a review on a 90-second cadence never
   * arrives before the mechanical exit does. Turn it on for longer holds.
   */
  AI_MANAGE_EXITS: bool.default('false'),

  // === Watchlist / traction gate ===
  /**
   * pump.fun launches tens of tokens a minute, and the screener has to be
   * streaming a token's trades from launch to see the volume that makes it
   * match. Sized for the screener's age window; when full, the oldest entry is
   * evicted so the list always holds the freshest launches.
   */
  WATCHLIST_MAX_SIZE: num(10, 50_000).default(6000),
  WATCH_MIN_AGE_SECONDS: num(5, 3600).default(20),
  WATCH_MAX_AGE_SECONDS: num(30, 86_400).default(1800),
  MIN_UNIQUE_BUYERS: num(1, 10_000).default(8),
  MIN_BUY_VOLUME_SOL: num(0, 10_000).default(1.5),
  MIN_PRICE_CHANGE_PCT: z.coerce.number().default(-10),
  MIN_RECENT_BUYERS: num(0, 1000).default(2),

  DISCOVERY_SOURCE: z.enum(['pumpportal', 'rpc']).default('pumpportal'),
  PUMPPORTAL_WS_URL: z.string().url().default('wss://pumpportal.fun/api/data'),
  MAX_CANDIDATE_AGE_MS: num(100, 600000).default(5000),

  EXECUTOR: z.enum(['paper', 'onchain', 'axiom']).default('paper'),
  PUMPPORTAL_TRADE_URL: z.string().url().default('https://pumpportal.fun/api/trade-local'),

  DASHBOARD_ENABLED: bool.default('true'),
  /** 0 asks the OS for an ephemeral port. */
  DASHBOARD_PORT: num(0, 65535).default(4321),
  // Loopback only by default. This UI can liquidate positions; exposing it on
  // 0.0.0.0 hands that to anyone who can reach the port.
  DASHBOARD_HOST: z.string().default('127.0.0.1'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATA_DIR: z.string().default('./data'),
});

export type Config = z.infer<typeof schema>;

function crossValidate(cfg: Config): string[] {
  const errors: string[] = [];

  if (cfg.MODE === 'live') {
    if (!cfg.WALLET_PRIVATE_KEY) {
      errors.push('MODE=live requires WALLET_PRIVATE_KEY');
    }
    if (cfg.EXECUTOR === 'paper') {
      errors.push('MODE=live with EXECUTOR=paper is contradictory; set a real EXECUTOR');
    }
    if (cfg.RPC_HTTP_URL.includes('api.mainnet-beta.solana.com')) {
      errors.push(
        'MODE=live with the public RPC endpoint will not land competitive snipes. ' +
          'Set RPC_HTTP_URL/RPC_WS_URL to a paid node.',
      );
    }
  }

  const usesAi = cfg.STRATEGY === 'ai' && (cfg.ENTRY_MODE === 'ai' || cfg.AI_MANAGE_EXITS);
  if (usesAi && !cfg.ANTHROPIC_API_KEY) {
    errors.push(
      'This config uses Claude (ENTRY_MODE=ai or AI_MANAGE_EXITS=true) but ' +
        'ANTHROPIC_API_KEY is empty. Get one at console.anthropic.com, or set ' +
        'AI_MANAGE_EXITS=false and ENTRY_MODE=fast to run fully deterministically.',
    );
  }

  if (cfg.SCALP_MODE && cfg.SCALP_RUNNER_PCT >= 100) {
    errors.push('SCALP_RUNNER_PCT must be below 100 — something has to be sold at the target');
  }

  if (cfg.SCREEN_MIN_AGE_SECONDS >= cfg.SCREEN_MAX_AGE_SECONDS) {
    errors.push(
      `SCREEN_MIN_AGE_SECONDS (${cfg.SCREEN_MIN_AGE_SECONDS}) must be below ` +
        `SCREEN_MAX_AGE_SECONDS (${cfg.SCREEN_MAX_AGE_SECONDS}); nothing would ever match`,
    );
  }

  if (cfg.SCREEN_MAX_MCAP_USD > 0 && cfg.SCREEN_MIN_MCAP_USD >= cfg.SCREEN_MAX_MCAP_USD) {
    errors.push(
      `SCREEN_MIN_MCAP_USD (${cfg.SCREEN_MIN_MCAP_USD}) must be below ` +
        `SCREEN_MAX_MCAP_USD (${cfg.SCREEN_MAX_MCAP_USD}); nothing would ever match`,
    );
  }

  // ENTRY_MODE only has an effect inside the watchlist orchestrator, which is
  // only built for STRATEGY=ai. Silently running the creation-time sniper
  // instead would look like the screener working and finding nothing.
  if (cfg.ENTRY_MODE !== 'rules' && cfg.STRATEGY !== 'ai') {
    errors.push(
      `ENTRY_MODE=${cfg.ENTRY_MODE} runs inside the watchlist, which only exists ` +
        'for STRATEGY=ai. Set STRATEGY=ai (no API key is needed unless ' +
        'ENTRY_MODE=ai or AI_MANAGE_EXITS=true), or set ENTRY_MODE=rules.',
    );
  }

  // The screener is a stopwatch on a filter, not a judgment call — pairing it
  // with the long ladder means holding a scalp entry for hours.
  if (cfg.ENTRY_MODE === 'screener' && !cfg.SCALP_MODE) {
    errors.push(
      'ENTRY_MODE=screener enters on a filter crossing, which is a scalp setup. ' +
        'Running it with SCALP_MODE=false holds those entries against the long ' +
        'ladder instead. Set SCALP_MODE=true, or pick a different ENTRY_MODE.',
    );
  }

  if (cfg.WATCH_MIN_AGE_SECONDS >= cfg.WATCH_MAX_AGE_SECONDS) {
    errors.push(
      `WATCH_MIN_AGE_SECONDS (${cfg.WATCH_MIN_AGE_SECONDS}) must be below ` +
        `WATCH_MAX_AGE_SECONDS (${cfg.WATCH_MAX_AGE_SECONDS}); nothing would ever graduate`,
    );
  }

  // A trailing stop looser than the hard stop is dead code: the hard stop always
  // fires first.
  if (cfg.TRAILING_STOP_PCT < cfg.STOP_LOSS_PCT) {
    errors.push(
      `TRAILING_STOP_PCT (${cfg.TRAILING_STOP_PCT}) is tighter than STOP_LOSS_PCT ` +
        `(${cfg.STOP_LOSS_PCT}); the trailing stop would fire on entry noise`,
    );
  }

  const laddered = cfg.EXIT_LADDER.reduce((a, t) => a + t.sellPctOfOriginal, 0);
  if (laddered >= 100) {
    errors.push(
      'EXIT_LADDER sells 100% of the position, leaving no moonbag. ' +
        'Lower the tier percentages if you want to keep a runner.',
    );
  }

  return errors;
}

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }

  const cfg = parsed.data;
  // Belt and braces: paper mode must never reach a signing code path.
  if (cfg.MODE === 'paper') cfg.EXECUTOR = 'paper';

  const errors = crossValidate(cfg);
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  }
  return cfg;
}

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam. */
export function __setConfigForTests(cfg: Config | null): void {
  cached = cfg;
}
