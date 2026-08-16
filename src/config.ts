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

const schema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),

  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),

  WALLET_PRIVATE_KEY: z.string().default(''),

  BUY_AMOUNT_SOL: num(0.0001, 100).default(0.05),
  MAX_CONCURRENT_POSITIONS: num(1, 50).default(3),
  MIN_WALLET_RESERVE_SOL: num(0, 100).default(0.05),

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

  DAILY_LOSS_LIMIT_SOL: num(0, 1000).default(0.5),
  MAX_CONSECUTIVE_LOSSES: num(1, 100).default(4),
  BREAKER_COOLDOWN_SECONDS: num(0, 86400).default(1800),
  HOURLY_SPEND_CAP_SOL: num(0, 1000).default(0.5),

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

  // === Watchlist / traction gate ===
  WATCHLIST_MAX_SIZE: num(10, 20_000).default(1500),
  WATCH_MIN_AGE_SECONDS: num(5, 3600).default(90),
  WATCH_MAX_AGE_SECONDS: num(30, 86_400).default(1800),
  MIN_UNIQUE_BUYERS: num(1, 10_000).default(25),
  MIN_BUY_VOLUME_SOL: num(0, 10_000).default(3),
  MIN_PRICE_CHANGE_PCT: z.coerce.number().default(-10),
  MIN_RECENT_BUYERS: num(0, 1000).default(4),

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

  if (cfg.STRATEGY === 'ai' && !cfg.ANTHROPIC_API_KEY) {
    errors.push(
      'STRATEGY=ai requires ANTHROPIC_API_KEY. Get one at console.anthropic.com, ' +
        'or set STRATEGY=rules to run the deterministic sniper instead.',
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
