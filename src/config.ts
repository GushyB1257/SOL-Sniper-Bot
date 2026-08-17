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
    // Three settings share this schema, so name whichever one is being parsed
    // rather than the one it was first written for.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ctx.path.join('.')} is empty` });
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

/** A wallet the copy trader follows, with an optional human name. */
export interface CopyWallet {
  address: string;
  /** What you call them. Falls back to a truncated address in the UI. */
  label?: string;
}

/**
 * Parses tracked wallets, each optionally named.
 *
 *   Addr1, Addr2=Insider, Addr3 = Whale two
 *
 * The name lives on the same line as the address rather than in a second
 * setting, so there is no way to have one without the other and no address
 * typed twice.
 */
const walletListSchema = z.string().transform((raw, ctx) => {
  const out: CopyWallet[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(/[,\n]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf('=');
    const address = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    const label = eq === -1 ? undefined : trimmed.slice(eq + 1).trim() || undefined;

    // Length and alphabet only — a full curve check needs web3.js and this
    // module is imported by everything, including tests with no chain.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${address}" is not a base58 Solana address`,
      });
      return z.NEVER;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(label ? { address, label } : { address });
  }
  return out;
});

const schema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),
  /**
   * SOL the paper wallet starts each run with.
   *
   * Paper mode has no wallet to read, so this is the number every risk check
   * measures against: position sizing, `MIN_WALLET_RESERVE_SOL`, the daily loss
   * limit as a share of the balance. Set it to what you would actually fund the
   * bot with — a paper run on 10 SOL that sizes at 0.25 is answering a different
   * question from the same strategy on 1 SOL, and the second one is the question
   * most people are really asking.
   *
   * Editable while running, and takes effect immediately: the balance moves by
   * the delta and the run's simulated P&L is preserved. In-memory either way, so
   * a restart begins again from this number.
   */
  PAPER_STARTING_BALANCE_SOL: num(0.01, 100_000).default(10),

  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),

  /**
   * Sustained RPC requests per second, across every caller. 0 disables the cap.
   *
   * The sniper is the reason this exists: it runs the safety battery on every
   * launch off the feed, four RPC calls apiece, and pump.fun launches several
   * tokens a second at peak. Left uncapped that alone will rate-limit a
   * consumer endpoint. Set this to your provider's documented limit — 10 for a
   * typical free tier, higher on a paid plan.
   */
  RPC_MAX_REQUESTS_PER_SEC: num(0, 10_000).default(20),
  /**
   * Maximum RPC requests in flight at once. A burst can breach a per-second
   * limit even when the average is comfortably inside it.
   */
  RPC_MAX_CONCURRENT: num(1, 256).default(8),
  /** Retries for a 429 or a 5xx, with exponential backoff and jitter. */
  RPC_MAX_RETRIES: num(0, 10).default(4),
  /**
   * How many launches the sniper runs the safety battery on at once. Beyond
   * this, candidates are dropped rather than queued: a launch that has been
   * waiting in line is one we are too late to buy anyway, and queueing them
   * converts a burst into a backlog that never drains.
   */
  SNIPER_MAX_CONCURRENT_CHECKS: num(1, 64).default(4),

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
  /**
   * Reject a deployer holding MORE than this. 0 disables.
   *
   * The counterintuitive half of the pair, and the sniper's own numbers are what
   * asked for it: deployers holding 0.1-0.5 SOL were the profitable cohort (39
   * trades, 26% win, +1.92 SOL) while 0.5-2 SOL (41 trades, 5% win, -2.44) and
   * 2 SOL+ (65 trades, 14% win, -2.24) both lost. A floor alone cannot express
   * that — it can only cut the bottom band, which was the one making money.
   *
   * A plausible mechanism is that a well-funded deployer is a professional
   * operation with the capital to bundle the launch and the patience to dump
   * into it, while a nearly-empty wallet is someone doing this once. That is a
   * story, not a finding. The pair of bounds is what lets it be tested.
   */
  MAX_DEPLOYER_BALANCE_SOL: num(0, 100_000).default(0),
  MAX_DEPLOYER_RUG_RATE: num(0, 1).default(0.34),
  MIN_SAFETY_SCORE: num(0, 100).default(70),
  REQUIRE_SOCIALS: bool.default('true'),
  DUPLICATE_NAME_WINDOW_MINUTES: num(0, 1440).default(60),

  // --- Provenance checks. All OFF by default; each costs an RPC call on the
  // entry path, and the sniper is already the heaviest RPC consumer. ------
  /**
   * Distinct holders required, excluding the bonding curve's own account.
   *
   * FREE — reuses the largest-accounts read the concentration check already
   * makes. Capped at 20 by what the RPC returns.
   *
   * Kept low on purpose. The sniper buys at creation, where the only holders
   * are the curve and the deployer, so anything above 2 or 3 rejects every
   * fresh launch — which looks exactly like the bot being broken.
   */
  MIN_HOLDERS: num(0, 20).default(2),
  /**
   * Reject when the deployer has already sold out of their own token.
   *
   * MAX_DEV_BUY_PCT asks what they took at creation; this asks whether they
   * are still in it, which is invisible to any check that only reads the
   * creation transaction. One RPC call per candidate.
   */
  REJECT_IF_DEPLOYER_EXITED: bool.default('true'),
  /**
   * Minimum age of the deployer's wallet, in minutes.
   *
   * Catches a funded throwaway, which a balance check alone does not. This is
   * the most aggressive of the four: plenty of legitimate deployers use a
   * fresh wallet per launch, so a high value here rejects a lot. 30 minutes
   * removes the wallet created moments before the launch without taking a
   * position on anything older. One RPC call.
   */
  MIN_CREATOR_AGE_MINUTES: num(0, 525_600).default(30),
  /**
   * Reject when more than this many transactions landed in the creation slot.
   *
   * Organic interest arrives across slots; a bundle lands together, which is
   * the signature of a launch whose first buyers are the deployer's own
   * wallets. One RPC call, signatures only. 0 disables.
   *
   * A normal creation slot holds the create transaction and the deployer's own
   * buy — two, sometimes three. Six leaves room for genuinely fast organic
   * buyers while still catching a coordinated launch.
   */
  MAX_LAUNCH_BUNDLE_TXS: num(0, 100).default(6),

  DAILY_LOSS_LIMIT_SOL: num(0, 1000).default(1.5),
  MAX_CONSECUTIVE_LOSSES: num(1, 100).default(6),
  BREAKER_COOLDOWN_SECONDS: num(0, 86400).default(900),
  HOURLY_SPEND_CAP_SOL: num(0, 1000).default(5),

  // === Which bots run ===
  // Each runs independently with its own positions, P&L and risk counters, so
  // one strategy's bad day cannot spend another's budget or muddy its numbers.
  BOT_SCREENER_ENABLED: bool.default('true'),
  BOT_SNIPER_ENABLED: bool.default('false'),
  BOT_COPY_ENABLED: bool.default('false'),

  // === Copy trading (BOT_COPY_ENABLED) ===
  /** Wallets to mirror. `Address` or `Address=Name`, comma or newline separated. */
  COPY_WALLETS: walletListSchema.default(''),
  /**
   * Ignore buys smaller than this. Wallets routinely make dust buys to bump a
   * token's volume on screeners; following those is how you end up holding
   * something the "insider" never actually took a position in.
   */
  COPY_MIN_BUY_SOL: num(0, 1000).default(0.5),
  /** Ignore buys larger than this — a whale's size is not your size. */
  COPY_MAX_BUY_SOL: num(0, 100_000).default(0),
  /**
   * fixed        : always buy COPY_BUY_AMOUNT_SOL.
   * proportional : buy COPY_RATIO x whatever they spent, clamped by the caps.
   */
  COPY_SIZE_MODE: z.enum(['fixed', 'proportional']).default('fixed'),
  COPY_BUY_AMOUNT_SOL: num(0.0001, 100).default(0.25),
  COPY_RATIO: num(0.0001, 100).default(0.1),
  /** Hard ceiling on a single copied position, whatever the sizing says. */
  COPY_MAX_POSITION_SOL: num(0.0001, 100).default(0.5),
  /** Venues to follow them into. */
  COPY_ALLOWED_POOLS: poolListSchema.default('pump,pump-amm'),
  /**
   * Multiplier on the fraction they sell. 1 mirrors them exactly; 1.5 exits
   * half again as fast, which front-runs a tracker who unwinds in stages.
   */
  COPY_SELL_MULTIPLIER: num(0.1, 5).default(1),
  /** Close fully once they are below this share of their peak holding. */
  COPY_FULL_EXIT_AT_PCT: num(0, 100).default(90),
  /** Backstop: close a copied position after this long regardless. */
  COPY_MAX_HOLD_SECONDS: num(60, 604_800).default(86_400),
  /**
   * How often tracked wallets' token balances are re-read.
   *
   * This is the dominant term in how late we are to a trade, so it is worth
   * pushing down — wallets are polled concurrently, so the cost is one extra
   * RPC call per wallet per second rather than a longer cycle. Below ~800ms a
   * consumer RPC endpoint starts rate-limiting, which makes you slower, not
   * faster.
   */
  COPY_POLL_INTERVAL_MS: num(300, 60_000).default(1000),
  /** Do not follow a wallet into a token it already held before we started. */
  COPY_SKIP_PREEXISTING: bool.default('true'),

  // === Exit execution ===
  /**
   * How many times a sell is retried before a position is written off.
   *
   * This is not a cosmetic number. A position that cannot be sold is booked as
   * a total loss, so giving up early turns a temporary RPC hiccup or a rate
   * limit into a fabricated -100% trade.
   */
  EXIT_MAX_ATTEMPTS: num(1, 200).default(12),
  /** Wait between sell retries. */
  EXIT_RETRY_SECONDS: num(1, 3600).default(15),
  /**
   * How long a position may be unpriceable before it is written off.
   *
   * Being unable to READ a price is a data problem, not a market one — the
   * token may be perfectly tradeable. Long enough that an outage does not cost
   * a position; short enough that a genuinely dead token frees its slot.
   */
  PRICE_STALE_SECONDS: num(30, 86_400).default(600),

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
  /**
   * Venues the sniper will buy on. Defaults to pump.fun bonding curves only.
   *
   * The screener and copy trader have always had this; the sniper did not, and
   * took whatever the feed handed it. That was invisible while the feed only
   * carried pump.fun.
   */
  SNIPE_ALLOWED_POOLS: poolListSchema.default('pump'),
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

  // --- Flow filters. All OFF by default: 0 disables each one. -------------
  //
  // These read signals the bot already collects but never filtered on. A
  // volume threshold cannot tell a token still moving from one that stopped,
  // fifty buyers from one whale, or the start of a move from its second half.
  /** Reject if nothing has traded for this long. Catches a stalled wave. */
  SCREEN_MAX_SECONDS_SINCE_TRADE: num(0, 3600).default(0),
  /** Reject if price is more than this far below its high since we saw it. */
  SCREEN_MAX_DRAWDOWN_PCT: num(0, 99).default(0),
  /** Buyers in the last 60s over the 60s before. Above 1 = still building. */
  SCREEN_MIN_BUYER_ACCEL: num(0, 100).default(0),
  /** Buy volume minus sell volume, in SOL. A ratio hides the size. */
  SCREEN_MIN_NET_FLOW_SOL: num(0, 10_000).default(0),
  /** Average SOL per buy — a floor filters out dust-sized participation. */
  SCREEN_MIN_AVG_BUY_SOL: num(0, 1000).default(0),
  /** A ceiling on the average catches one whale posing as a crowd. */
  SCREEN_MAX_AVG_BUY_SOL: num(0, 1000).default(0),
  /** Largest single buy. Someone taking real size is a different signal. */
  SCREEN_MIN_LARGEST_BUY_SOL: num(0, 10_000).default(0),
  /** Wallets that bought twice. Conviction rather than a glance. */
  SCREEN_MIN_REPEAT_BUYERS: num(0, 1000).default(0),
  /** Progress toward graduating off the curve, 0-100. */
  SCREEN_MIN_CURVE_PROGRESS_PCT: num(0, 100).default(0),
  SCREEN_MAX_CURVE_PROGRESS_PCT: num(0, 100).default(0),
  /**
   * Require this many of the wallets the copy trader tracks to be holding.
   *
   * The copy bot reads those balances every second anyway, so this is free —
   * and it is the one signal here that is not available to anyone else
   * screening the same public data. Needs the copy bot running with wallets.
   */
  SCREEN_MIN_COPY_HOLDERS: num(0, 100).default(0),
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

  // === Exit ===
  /**
   * ratchet : no stop loss. Every CHECKPOINT_SECONDS the price must be higher
   *           than it was at the last checkpoint, or the position closes. On a
   *           double, sell exactly enough to return the stake and let the rest
   *           ride as house money.
   * scalp   : fee-aware net target with a give-back floor and a hard stop.
   * ladder  : the original multi-rung take-profit with trailing stops.
   */
  EXIT_MODE: z.enum(['ratchet', 'scalp', 'ladder']).default('ratchet'),

  // === Ratchet exit (EXIT_MODE=ratchet) ===
  /** How often the "is it higher than last time?" question gets asked. */
  CHECKPOINT_SECONDS: num(5, 3600).default(60),
  /**
   * Length of the FIRST window only, before the first checkpoint fires.
   *
   * Every position that goes nowhere pays for the full first window before
   * anything can cut it, and on a launch that has already turned over, most of
   * the damage happens in the first thirty seconds. Shortening only the first
   * window cuts the dead entries sooner without shortening the leash on a
   * position that is working. Set it equal to CHECKPOINT_SECONDS for the
   * original behaviour.
   */
  RATCHET_FIRST_CHECKPOINT_SECONDS: num(5, 3600).default(30),
  /**
   * Gain at which the original stake comes back off the table.
   *
   * A double is the intuitive number but it is a high bar: a position has to
   * survive several checkpoints to get there, and everything that stalls at
   * +40% or +70% along the way is still carrying full downside when it turns.
   * Recovering earlier converts far more trades into risk-free ones, and the
   * moonbag still catches the rare token that keeps going.
   */
  RECOVER_AT_GAIN_PCT: num(10, 10_000).default(60),
  /**
   * Close the position if it hands back this share of its best GAIN.
   *
   * This is not a stop loss and cannot act like one: it is measured against the
   * gain above entry, so it can only ever fire on a position that is in profit,
   * and it does nothing at all to one that is down. It plugs the ratchet's
   * biggest leak — between checkpoints, a position that ran to +90% could give
   * every bit of it back and still be holding when the window finally closed.
   * 0 disables it.
   *
   * Tightened from 40 to 25 on the sniper's first 174 closed trades. At 40 a
   * winner keeps about 60% of its peak gain, which produced a +44.5% average
   * winner against a -17.5% average loser — a pair needing a 28.2% win rate to
   * break even, against an actual 16.1%. Keeping 75% of the peak instead moves
   * the requirement to 23.9% without touching the entry at all. Exits come
   * earlier and some runners will be cut short; whether that trade is worth
   * making is exactly what the tuner's measure-and-revert loop decides.
   */
  RATCHET_GIVEBACK_PCT: num(0, 100).default(25),
  /** Share of the remaining moonbag skimmed at each checkpoint it survives. */
  MOONBAG_TRIM_PCT: num(0, 90).default(25),
  /**
   * How much higher than the last checkpoint counts as "still going". 0 means
   * any new high survives; raise it to cut tokens that are merely drifting.
   */
  RATCHET_MIN_PROGRESS_PCT: num(0, 100).default(0),
  /**
   * Optional hard stop, OFF by default. A stop is precisely what cuts a
   * position that then recovers, so the ratchet replaces it with a time-boxed
   * "prove it" test. Set a percentage to put one back.
   */
  RATCHET_STOP_LOSS_PCT: num(0, 99).default(0),
  // === Scalp exit (EXIT_MODE=scalp) ===
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
  /**
   * Wait this long after the safety battery passes, re-read the price, and only
   * buy if it has held or risen. 0 disables the gate.
   *
   * The sniper's problem is not exit timing. 87 of 156 trades exited as
   * `dead_entry` for -2.74 SOL, and BOTH directions of
   * `RATCHET_FIRST_CHECKPOINT_SECONDS` — 21s and 39s — were measured and
   * reverted, so the loss is not in how long a non-starter is held. It is that
   * the launch never started at all, and the battery cannot see that: every
   * check it runs asks whether the token is *structurally* sound, and none asks
   * whether anyone else is buying it.
   *
   * This is the cheapest possible version of that question — did the price tick
   * up at all — and it is a real trade, not a free win. The cost is being this
   * many milliseconds later into every launch we do take, which on the ones that
   * work is upside given away. Whether that is worth it is exactly the kind of
   * thing the measure-and-revert loop can settle, which is why it is a
   * parameter and not a decision.
   */
  SNIPE_CONFIRM_MS: num(0, 60_000).default(0),
  /**
   * How much the price must have risen over `SNIPE_CONFIRM_MS` to buy.
   *
   * 0 means "must not be down", which is the weakest useful form of the gate.
   * Negative tolerates a small dip. Only read when `SNIPE_CONFIRM_MS` > 0.
   */
  SNIPE_CONFIRM_MIN_GAIN_PCT: num(-50, 500).default(0),

  EXECUTOR: z.enum(['paper', 'onchain', 'axiom']).default('paper'),
  PUMPPORTAL_TRADE_URL: z.string().url().default('https://pumpportal.fun/api/trade-local'),

  DASHBOARD_ENABLED: bool.default('true'),
  /** 0 asks the OS for an ephemeral port. */
  DASHBOARD_PORT: num(0, 65535).default(4321),
  // Loopback only by default. This UI can liquidate positions; exposing it on
  // 0.0.0.0 hands that to anyone who can reach the port.
  DASHBOARD_HOST: z.string().default('127.0.0.1'),

  // === Auto-tuning ===
  /**
   * Let Claude adjust the bots' strategy parameters from their own results.
   *
   * OFF by default and deliberately so: it spends API credit on a schedule and
   * it edits the settings you are trading on. What it may touch is fixed in
   * src/tuner/limits.ts — strategy knobs only, never position size and never a
   * risk limit — and every change is measured against the window before it and
   * reverted automatically if it does not beat it.
   */
  AUTO_TUNE_ENABLED: bool.default('false'),
  /**
   * Minimum minutes between reviews OF THE SAME BOT.
   *
   * The trade count is what decides whether a change is justified — 40 trades
   * is 40 trades whether they took two minutes or two days, so gating on the
   * clock just wastes data when a bot is trading fast. This is a floor, not a
   * schedule: it bounds API spend. Each bot has its own; a fast bot never waits
   * on a slow one.
   *
   * Measured from when the last change was *made*, so the time spent measuring
   * it counts toward the floor. It has to: the measurement window is already a
   * wait, and restarting the clock when the evidence arrives means waiting
   * twice for one experiment — idling at the exact moment there is most reason
   * to act. A bot reaching 150 trades in seven minutes settles and proposes
   * again in the same pass.
   *
   * Five minutes caps it at twelve Claude calls an hour per bot, which is the
   * only real cost. Set it to 1 to let the loop run purely at trade speed.
   */
  TUNER_INTERVAL_MINUTES: num(1, 10_080).default(5),
  /**
   * Closed trades required before anything moves, and again before a change is
   * judged. Under a few dozen, memecoin P&L is one or two outliers and any
   * change can be justified from the noise.
   *
   * This is the knob to RAISE if your bots trade quickly. Trades are the
   * currency of statistical confidence and they cost you nothing but time —
   * 150 trades per decision is a far better read than 40, and if you are
   * closing 40 in two minutes it barely slows anything down.
   */
  TUNER_MIN_TRADES: num(10, 5000).default(40),
  /** Parameters that may move in one round. One coherent idea at a time. */
  TUNER_MAX_CHANGES_PER_ROUND: num(1, 8).default(2),
  /** Largest single-round move for any parameter, as a share of its value. */
  TUNER_MAX_STEP_PCT: num(1, 100).default(30),

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

  // A band that excludes everything is the one way this pair can be set wrong,
  // and it fails silently: every launch is rejected and the bot simply stops
  // trading, which looks identical to a quiet market.
  if (
    cfg.MAX_DEPLOYER_BALANCE_SOL > 0 &&
    cfg.MAX_DEPLOYER_BALANCE_SOL <= cfg.MIN_DEPLOYER_BALANCE_SOL
  ) {
    errors.push(
      `MAX_DEPLOYER_BALANCE_SOL (${cfg.MAX_DEPLOYER_BALANCE_SOL}) must be above ` +
        `MIN_DEPLOYER_BALANCE_SOL (${cfg.MIN_DEPLOYER_BALANCE_SOL}); no deployer ` +
        'balance could satisfy both and every launch would be rejected',
    );
  }

  if (cfg.EXIT_MODE === 'scalp' && cfg.SCALP_RUNNER_PCT >= 100) {
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

  // Deliberately NOT an error: the dashboard is the config surface now, so
  // "start the bot, then paste the wallets in" is the natural order. Enabling
  // it with no wallets is inert and the UI says so on the tab; refusing to
  // start would just look like a broken button.

  if (cfg.COPY_MAX_BUY_SOL > 0 && cfg.COPY_MIN_BUY_SOL >= cfg.COPY_MAX_BUY_SOL) {
    errors.push(
      `COPY_MIN_BUY_SOL (${cfg.COPY_MIN_BUY_SOL}) must be below COPY_MAX_BUY_SOL ` +
        `(${cfg.COPY_MAX_BUY_SOL}); no buy would ever qualify`,
    );
  }

  if (!cfg.BOT_SCREENER_ENABLED && !cfg.BOT_SNIPER_ENABLED && !cfg.BOT_COPY_ENABLED) {
    errors.push('every bot is disabled — nothing would run. Enable at least one.');
  }

  // The screener is a stopwatch on a filter, not a judgment call — pairing it
  // with the long ladder means holding a fast entry against hour-long stops.
  if (cfg.ENTRY_MODE === 'screener' && cfg.EXIT_MODE === 'ladder') {
    errors.push(
      'ENTRY_MODE=screener enters on a filter crossing, which plays out in ' +
        'minutes. EXIT_MODE=ladder holds those entries against +60/+150/+400% ' +
        'rungs. Use EXIT_MODE=ratchet (or scalp), or pick a different ENTRY_MODE.',
    );
  }

  // The ratchet's whole safety argument is that a doubled position has already
  // returned its stake. Trimming everything at that point leaves no moonbag and
  // no upside; keeping nothing back makes the rule pointless.
  if (cfg.EXIT_MODE === 'ratchet' && cfg.MOONBAG_TRIM_PCT >= 100) {
    errors.push('MOONBAG_TRIM_PCT must be below 100 — the moonbag is the entire point');
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

/** Serialises tracked wallets back to the `Addr=Name` form the UI edits. */
export function formatCopyWallets(wallets: readonly CopyWallet[]): string {
  return wallets.map((w) => (w.label ? `${w.address}=${w.label}` : w.address)).join(', ');
}

/**
 * What to call a wallet in the UI and the logs.
 *
 * Resolved from config at render time rather than stored on each trade, so
 * renaming a wallet relabels its whole history instead of only new trades.
 */
export function walletLabel(cfg: Config, address: string | undefined | null): string {
  if (!address) return '';
  const found = cfg.COPY_WALLETS.find((w) => w.address === address);
  return found?.label ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
}
