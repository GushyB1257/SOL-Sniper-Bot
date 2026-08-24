import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatCopyWallets, loadConfig, type Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('settings');

/**
 * Live, editable configuration.
 *
 * Config was a boot-time snapshot: to change a threshold you edited `.env` and
 * restarted, which throws away the watchlist and every open position's
 * bookkeeping. That is a bad trade for changing one number.
 *
 * The mechanism is deliberately narrow. Overrides are stored as raw strings —
 * exactly what an env var is — and every change is re-parsed through the SAME
 * `loadConfig` the process boots with, so a value typed into a web form gets
 * identical validation and cross-field checking to one written in `.env`. A
 * patch that fails validation is rejected whole and the previous config keeps
 * running; there is no path to a half-applied state.
 *
 * The accepted result is then copied ONTO the live config object rather than
 * replacing it. Every component already holds a reference to that object, so
 * they all observe the change on their next read with no wiring, no event bus
 * and no restart. The cost is that `Config` is no longer immutable, which is
 * why nothing else in the codebase is allowed to write to it.
 */

/** Values that must never be settable from a web form. */
const LOCKED = new Set([
  // Changing where money comes from, or whether it is real, is not a dashboard
  // decision — it is the one thing that should require touching the machine.
  'MODE',
  'EXECUTOR',
  'WALLET_PRIVATE_KEY',
  'RPC_HTTP_URL',
  'RPC_WS_URL',
  'ANTHROPIC_API_KEY',
  'DATA_DIR',
  'DASHBOARD_HOST',
  'DASHBOARD_PORT',
  'DASHBOARD_ENABLED',
  // The trade endpoint returns the transaction bytes we then sign. Repointing
  // it is repointing what gets signed, which is not a dashboard decision and
  // certainly not an automated one — `assertSafeToSign` is a last line of
  // defence, not a reason to hand out the address.
  'PUMPPORTAL_TRADE_URL',
  'PUMPPORTAL_WS_URL',
]);

export type FieldKind = 'number' | 'boolean' | 'enum' | 'text';

export interface FieldSpec {
  key: string;
  label: string;
  /** Which dashboard tab this belongs to. */
  bot: 'screener' | 'sniper' | 'copy' | 'arb' | 'btc' | 'shared';
  group: string;
  kind: FieldKind;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Free text where a placeholder helps more than a label. */
  placeholder?: string;
}

/**
 * Every setting the dashboard exposes, in display order.
 *
 * This is a hand-written list rather than something derived from the zod
 * schema, because the schema knows types but not intent: which tab a setting
 * belongs to, what it means in one sentence, and whether a user should be
 * touching it at all.
 */
export const FIELDS: FieldSpec[] = [
  // --- Screener --------------------------------------------------------
  { key: 'ENTRY_MODE', label: 'Entry mode', bot: 'screener', group: 'Strategy', kind: 'enum',
    options: ['screener', 'fast', 'ai', 'rules'],
    help: 'screener applies the filter below; fast uses the momentum trigger.' },
  { key: 'SCREEN_ALLOWED_POOLS', label: 'Venues', bot: 'screener', group: 'Filter', kind: 'text',
    placeholder: 'pump', help: 'Comma separated. "pump" alone is pump.fun standard coins.' },
  { key: 'SNIPE_ALLOWED_POOLS', label: 'Venues', bot: 'sniper', group: 'Filter', kind: 'text',
    placeholder: 'pump', help: 'Comma separated. "pump" alone is pump.fun standard coins — ' +
      'anything else is a different launchpad.' },
  { key: 'SCREEN_MIN_MCAP_USD', label: 'Min market cap', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 100_000_000, step: 500, help: 'USD. Launches start near $5-6k.' },
  { key: 'SCREEN_MAX_MCAP_USD', label: 'Max market cap', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 100_000_000, step: 500, help: 'USD. 0 disables the ceiling.' },
  { key: 'SCREEN_MIN_VOLUME_USD', label: 'Min volume', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 100_000_000, step: 500, help: 'USD, both sides, since launch.' },
  { key: 'SCREEN_MIN_SOCIALS', label: 'Min socials', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 3, step: 1 },
  { key: 'SCREEN_ON_SOCIALS_UNAVAILABLE', label: 'If metadata unreadable', bot: 'screener',
    group: 'Filter', kind: 'enum', options: ['allow', 'deny'],
    help: 'IPFS gateways are often slow; denying on that rejects real matches.' },
  { key: 'SCREEN_MIN_BUYERS', label: 'Min distinct buyers', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 10_000, step: 1, help: '0 disables. Guards manufactured volume.' },
  { key: 'SCREEN_MIN_AGE_SECONDS', label: 'Min age', bot: 'screener', group: 'Filter',
    kind: 'number', min: 0, max: 86_400, step: 5 },
  { key: 'SCREEN_MAX_AGE_SECONDS', label: 'Max age', bot: 'screener', group: 'Filter',
    kind: 'number', min: 5, max: 86_400, step: 30 },
  { key: 'SCREEN_DATA_SOURCE', label: 'Data source', bot: 'screener', group: 'Data',
    kind: 'enum', options: ['both', 'curve', 'feed'],
    help: 'curve reads bonding curves over your RPC and works on the first read.' },
  { key: 'SCREEN_POLL_INTERVAL_MS', label: 'Curve poll interval', bot: 'screener', group: 'Data',
    kind: 'number', min: 250, max: 60_000, step: 250 },
  { key: 'SCREEN_POLL_MAX_TOKENS', label: 'Curves per poll', bot: 'screener', group: 'Data',
    kind: 'number', min: 0, max: 5000, step: 50, help: '100 per RPC call.' },
  { key: 'SOL_USD_FALLBACK', label: 'SOL/USD fallback', bot: 'screener', group: 'Data',
    kind: 'number', min: 1, max: 100_000, step: 1, help: 'Only used if the live price feed fails.' },

  // --- Sniper ----------------------------------------------------------
  { key: 'MIN_SAFETY_SCORE', label: 'Min safety score', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 5 },
  { key: 'MIN_DEV_BUY_PCT', label: 'Min dev buy', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 0.5,
    help: 'Skin in the game: reject a deployer who took LESS than this at creation. ' +
      '0 disables. Must stay below Max dev buy. Only applied when the feed reports ' +
      'the creation buy — PumpPortal does, the RPC discovery path does not.' },
  { key: 'MAX_DEV_BUY_PCT', label: 'Max dev buy', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 1, help: '% of supply in the creation transaction.' },
  { key: 'MAX_TOP10_HOLDER_PCT', label: 'Max top-10 holders', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 1 },
  { key: 'MIN_DEPLOYER_BALANCE_SOL', label: 'Min deployer balance', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1000, step: 0.05 },
  { key: 'MAX_DEPLOYER_BALANCE_SOL', label: 'Max deployer balance', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100_000, step: 0.1,
    help: 'SOL. 0 = off. Rejects WELL-FUNDED deployers — the opposite of the ' +
      'floor above, and together they make a band.' },
  { key: 'MAX_DEPLOYER_RUG_RATE', label: 'Max deployer rug rate', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'REQUIRE_SOCIALS', label: 'Require socials', bot: 'sniper', group: 'Safety', kind: 'boolean' },
  { key: 'DUPLICATE_NAME_WINDOW_MINUTES', label: 'Copycat window', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1440, step: 5 },
  { key: 'SNIPE_CONFIRM_MS', label: 'Confirm move for', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 60_000, step: 250,
    help: 'ms. 0 = off. Waits, re-reads the price, and only buys if it held or ' +
      'rose — the one check that asks whether anyone else is buying.' },
  { key: 'SNIPE_CONFIRM_MIN_GAIN_PCT', label: 'Confirm min move', bot: 'sniper', group: 'Safety',
    kind: 'number', min: -20, max: 100, step: 1,
    help: '% over the window above. 0 = "must not be down".' },
  { key: 'MAX_CANDIDATE_AGE_MS', label: 'Max candidate age', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 100, max: 600_000, step: 100, help: 'ms. Older than this is not a snipe.' },

  // --- Arbitrage -------------------------------------------------------
  { key: 'ARB_TOKENS', label: 'Route through', bot: 'arb', group: 'Routes', kind: 'text',
    placeholder: 'USDC,USDT,JUP',
    help: 'Comma separated. Built-in symbols, or mint:decimals for anything else — ' +
      'guessing decimals would mis-scale every amount.' },
  { key: 'ARB_STRATEGIES', label: 'Strategies', bot: 'arb', group: 'Routes', kind: 'text',
    placeholder: 'cycle',
    help: 'cycle = aggregated route both ways. cross-dex = best single venue per ' +
      'leg, which finds dislocations the aggregator hides but costs a quote per venue.' },
  { key: 'ARB_VENUES', label: 'Cross-dex venues', bot: 'arb', group: 'Routes', kind: 'text',
    placeholder: 'Orca V2,Raydium', help: 'Only used by the cross-dex strategy.' },
  { key: 'ARB_TRADE_SIZE_SOL', label: 'Size per attempt', bot: 'arb', group: 'Edge',
    kind: 'number', min: 0.001, max: 1000, step: 0.05,
    help: 'SOL. Fees are fixed per attempt, so below the break-even size shown ' +
      'above the strategy loses money on winning trades.' },
  { key: 'ARB_MIN_PROFIT_BPS', label: 'Min edge', bot: 'arb', group: 'Edge',
    kind: 'number', min: 0, max: 10_000, step: 5,
    help: 'Basis points, net of every modelled cost. The parameter that decides ' +
      'whether anything trades at all.' },
  { key: 'ARB_MAX_PRICE_IMPACT_PCT', label: 'Max price impact', bot: 'arb', group: 'Edge',
    kind: 'number', min: 0.01, max: 100, step: 0.05,
    help: '% — our own trade moving the pool. On a thin route it moves it past ' +
      'the edge we came for.' },
  { key: 'ARB_REQUIRE_WORST_CASE', label: 'Require worst case to profit', bot: 'arb',
    group: 'Edge', kind: 'boolean',
    help: 'Off means trading routes whose on-chain minimum output is a loss.' },
  { key: 'ARB_SLIPPAGE_BPS', label: 'Slippage tolerance', bot: 'arb', group: 'Execution',
    kind: 'number', min: 1, max: 5000, step: 5, help: 'Basis points, per leg.' },
  { key: 'ARB_QUOTE_MAX_AGE_MS', label: 'Max quote age', bot: 'arb', group: 'Execution',
    kind: 'number', min: 200, max: 60_000, step: 250,
    help: 'ms. Legs are quoted in sequence, so leg one is always the stale one.' },
  { key: 'ARB_PRIORITY_FEE_MICROLAMPORTS', label: 'Priority fee', bot: 'arb',
    group: 'Execution', kind: 'number', min: 0, max: 10_000_000, step: 5000,
    help: 'Micro-lamports per compute unit, per leg. Raises landing odds AND the ' +
      'break-even size.' },
  { key: 'ARB_COMPUTE_UNIT_LIMIT', label: 'Compute units', bot: 'arb', group: 'Execution',
    kind: 'number', min: 10_000, max: 1_400_000, step: 10_000,
    help: 'Per leg. Multiplies the priority fee.' },
  { key: 'ARB_ASSUME_ATA_RENT', label: 'Charge token-account rent', bot: 'arb',
    group: 'Execution', kind: 'boolean', help: 'Conservative when on.' },
  { key: 'ARB_POLL_INTERVAL_MS', label: 'Scan interval', bot: 'arb', group: 'Data',
    kind: 'number', min: 500, max: 600_000, step: 500 },
  { key: 'ARB_QUOTE_INTERVAL_MS', label: 'Gap between quotes', bot: 'arb', group: 'Data',
    kind: 'number', min: 100, max: 10_000, step: 50,
    help: 'Jupiter\'s free tier meters per second. Lowering this earns 429s, and a ' +
      '429 costs more time than the spacing saved.' },
  { key: 'ARB_MAX_TRADES_PER_HOUR', label: 'Trades per hour', bot: 'arb', group: 'Risk',
    kind: 'number', min: 1, max: 10_000, step: 1,
    help: 'Bounds the fast-loop failure mode: the same bad trade, hundreds of times.' },
  { key: 'ARB_ROUTE_COOLDOWN_MS', label: 'Route cooldown', bot: 'arb', group: 'Risk',
    kind: 'number', min: 0, max: 3_600_000, step: 5000,
    help: 'ms. A dislocation that was not real still looks real on the next scan.' },
  { key: 'ARB_MAX_DAILY_LOSS_SOL', label: 'Daily loss limit', bot: 'arb', group: 'Risk',
    kind: 'number', min: 0.001, max: 1000, step: 0.05 },
  { key: 'ARB_MAX_CONSECUTIVE_FAILURES', label: 'Failure streak halt', bot: 'arb',
    group: 'Risk', kind: 'number', min: 1, max: 100, step: 1 },
  { key: 'ARB_MIN_RESERVE_SOL', label: 'Reserve', bot: 'arb', group: 'Risk',
    kind: 'number', min: 0, max: 100, step: 0.01, help: 'SOL never committed.' },
  { key: 'ARB_PAPER_ADVERSE_SLIPPAGE_BPS', label: 'Paper: adverse slippage', bot: 'arb',
    group: 'Paper realism', kind: 'number', min: 0, max: 1000, step: 1,
    help: 'Per leg. The quote is not the fill. Raise to be more pessimistic.' },
  { key: 'ARB_PAPER_LEG_FAILURE_RATE', label: 'Paper: leg failure rate', bot: 'arb',
    group: 'Paper realism', kind: 'number', min: 0, max: 1, step: 0.01,
    help: '0-1. A failed leg still pays its fee.' },
  { key: 'ARB_PAPER_UNWIND_RECOVERY_PCT', label: 'Paper: unwind recovery', bot: 'arb',
    group: 'Paper realism', kind: 'number', min: 0, max: 100, step: 1,
    help: '% recovered when leg TWO fails and you are left holding the middle ' +
      'token. The outcome that makes a non-atomic cycle dangerous.' },

  // --- Copy ------------------------------------------------------------
  { key: 'COPY_WALLETS', label: 'Wallets to track', bot: 'copy', group: 'Wallets', kind: 'text',
    placeholder: 'Address, or Address=Name',
    help: 'Comma separated. Add "=Name" after an address to label it — the name ' +
      'then shows on every position and trade from that wallet, including past ones.' },
  { key: 'COPY_MIN_BUY_SOL', label: 'Ignore buys under', bot: 'copy', group: 'Filter',
    kind: 'number', min: 0, max: 1000, step: 0.05,
    help: 'SOL. Filters the dust buys wallets use to bump volume.' },
  { key: 'COPY_MAX_BUY_SOL', label: 'Ignore buys over', bot: 'copy', group: 'Filter',
    kind: 'number', min: 0, max: 100_000, step: 1, help: 'SOL. 0 disables.' },
  { key: 'COPY_ALLOWED_POOLS', label: 'Venues', bot: 'copy', group: 'Filter', kind: 'text' },
  { key: 'COPY_SKIP_PREEXISTING', label: 'Skip existing holdings', bot: 'copy', group: 'Filter',
    kind: 'boolean', help: 'Only follow tokens they buy after tracking starts.' },
  { key: 'COPY_SIZE_MODE', label: 'Sizing', bot: 'copy', group: 'Sizing', kind: 'enum',
    options: ['fixed', 'proportional'] },
  { key: 'COPY_BUY_AMOUNT_SOL', label: 'Fixed size', bot: 'copy', group: 'Sizing',
    kind: 'number', min: 0.0001, max: 100, step: 0.05 },
  { key: 'COPY_RATIO', label: 'Proportional ratio', bot: 'copy', group: 'Sizing',
    kind: 'number', min: 0.0001, max: 100, step: 0.01, help: 'Fraction of what they spent.' },
  { key: 'COPY_MAX_POSITION_SOL', label: 'Max position', bot: 'copy', group: 'Sizing',
    kind: 'number', min: 0.0001, max: 100, step: 0.05 },
  { key: 'COPY_SELL_MULTIPLIER', label: 'Sell multiplier', bot: 'copy', group: 'Exit',
    kind: 'number', min: 0.1, max: 5, step: 0.1,
    help: '1 mirrors them exactly. Above 1 exits faster than they do.' },
  { key: 'COPY_FULL_EXIT_AT_PCT', label: 'Full exit when they are out by', bot: 'copy',
    group: 'Exit', kind: 'number', min: 0, max: 100, step: 5, help: '% of their peak holding.' },
  { key: 'COPY_MAX_HOLD_SECONDS', label: 'Max hold', bot: 'copy', group: 'Exit',
    kind: 'number', min: 60, max: 604_800, step: 60, help: 'Backstop if they never sell.' },
  { key: 'COPY_POLL_INTERVAL_MS', label: 'Wallet poll interval', bot: 'copy', group: 'Data',
    kind: 'number', min: 300, max: 60_000, step: 100,
    help: 'How late you are to their trades. Wallets are polled in parallel, so this is the whole lag. Under ~800ms most RPC endpoints rate-limit.' },

  // --- Flow signals (screener) -----------------------------------------
  { key: 'SCREEN_MAX_SECONDS_SINCE_TRADE', label: 'Max quiet time', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 3600, step: 5, help: 'Reject if nothing traded for this long. 0 = off.' },
  { key: 'SCREEN_MAX_DRAWDOWN_PCT', label: 'Max off peak', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 99, step: 5, help: 'Refuse to buy this far below the high. 0 = off.' },
  { key: 'SCREEN_MIN_BUYER_ACCEL', label: 'Min buyer acceleration', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 100, step: 0.1, help: 'Buyers last 60s ÷ the 60s before. Above 1 = building. 0 = off.' },
  { key: 'SCREEN_MIN_NET_FLOW_SOL', label: 'Min net flow', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 10_000, step: 0.1, help: 'Buy volume minus sell volume, in SOL. 0 = off.' },
  { key: 'SCREEN_MIN_AVG_BUY_SOL', label: 'Min average buy', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 1000, step: 0.05, help: 'Filters dust participation. 0 = off.' },
  { key: 'SCREEN_MAX_AVG_BUY_SOL', label: 'Max average buy', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 1000, step: 0.5, help: 'Catches one whale posing as a crowd. 0 = off.' },
  { key: 'SCREEN_MIN_LARGEST_BUY_SOL', label: 'Min largest buy', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 10_000, step: 0.1, help: 'Someone taking real size. 0 = off.' },
  { key: 'SCREEN_MIN_REPEAT_BUYERS', label: 'Min repeat buyers', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 1000, step: 1, help: 'Wallets that bought twice. 0 = off.' },
  { key: 'SCREEN_MIN_CURVE_PROGRESS_PCT', label: 'Min curve progress', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 100, step: 5, help: '% toward graduating off the curve.' },
  { key: 'SCREEN_MAX_CURVE_PROGRESS_PCT', label: 'Max curve progress', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 100, step: 5, help: '0 = off.' },
  { key: 'SCREEN_MIN_COPY_HOLDERS', label: 'Tracked wallets holding', bot: 'screener', group: 'Flow',
    kind: 'number', min: 0, max: 100, step: 1,
    help: 'Require this many of your copy-tracked wallets to hold it. Free signal — needs the copy bot running. 0 = off.' },

  // --- Provenance (sniper) ---------------------------------------------
  { key: 'MIN_HOLDERS', label: 'Min holders', bot: 'sniper', group: 'Provenance',
    kind: 'number', min: 0, max: 20, step: 1, help: 'Free — reuses an existing read. 0 = off.' },
  { key: 'REJECT_IF_DEPLOYER_EXITED', label: 'Reject if dev sold out', bot: 'sniper', group: 'Provenance',
    kind: 'boolean', help: 'Costs one RPC call per candidate.' },
  { key: 'MIN_CREATOR_AGE_MINUTES', label: 'Min creator wallet age', bot: 'sniper', group: 'Provenance',
    kind: 'number', min: 0, max: 525_600, step: 30, help: 'Minutes. Catches a funded throwaway. One RPC call. 0 = off.' },
  { key: 'MAX_LAUNCH_BUNDLE_TXS', label: 'Max creation-slot txs', bot: 'sniper', group: 'Provenance',
    kind: 'number', min: 0, max: 100, step: 1, help: 'Bundled launches land together. One RPC call. 0 = off.' },

  // --- Auto-tuning -----------------------------------------------------
  // --- Bitcoin lab -----------------------------------------------------
  { key: 'BTC_HISTORY_DAYS', label: 'History window', bot: 'btc', group: 'Data',
    kind: 'number', min: 30, max: 730, step: 5,
    help: 'Days of hourly candles the sweep backtests over. More history favours ' +
      'strategies that survive regimes; less favours ones tuned to now.' },
  { key: 'BTC_FEE_BPS', label: 'Exchange fee', bot: 'btc', group: 'Data',
    kind: 'number', min: 0, max: 100, step: 1,
    help: 'Taker fee in basis points (10 = 0.1%). Set to what your exchange charges — ' +
      'every number on this tab is net of it.' },
  { key: 'BTC_SLIPPAGE_BPS', label: 'Modelled slippage', bot: 'btc', group: 'Data',
    kind: 'number', min: 0, max: 100, step: 1 },
  { key: 'BTC_ALLOW_SHORTS', label: 'Allow shorts', bot: 'btc', group: 'Strategy',
    kind: 'boolean',
    help: 'Off maps every short signal to flat rather than dropping those strategies, ' +
      'so the long-only halves stay on the leaderboard for comparison.' },
  { key: 'BTC_TOP_STRATEGIES', label: 'Forward-test top', bot: 'btc', group: 'Strategy',
    kind: 'number', min: 1, max: 20, step: 1,
    help: 'How many of the top-ranked strategies paper-trade live at once.' },
  { key: 'BTC_SWEEP_HOURS', label: 'Re-sweep every', bot: 'btc', group: 'Strategy',
    kind: 'number', min: 1, max: 168, step: 1, help: 'Hours between full catalogue backtests.' },
  { key: 'BTC_PAPER_NOTIONAL_USD', label: 'Paper notional', bot: 'btc', group: 'Sizing',
    kind: 'number', min: 10, max: 1_000_000, step: 100,
    help: 'Virtual USD each forward-tested strategy trades with, independently.' },
  { key: 'BTC_POLL_INTERVAL_MS', label: 'Poll interval', bot: 'btc', group: 'Data',
    kind: 'number', min: 5000, max: 600_000, step: 5000,
    help: 'How often to check for a newly closed candle. They close hourly, so ' +
      'faster polling only tightens how quickly a close is noticed.' },

  { key: 'AUTO_TUNE_ENABLED', label: 'Auto-tune strategies', bot: 'shared', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Let Claude adjust strategy settings from each bot\'s own results. Never touches position size or a risk limit. Every change is measured and reverted if it does not beat its baseline.' },
  { key: 'TUNER_SCREENER_ENABLED', label: 'Auto-tune this bot', bot: 'screener', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Auto-tune THIS bot. The master switch above gates everything; this narrows it, ' +
      'so one bot can be frozen for a clean measurement week while the others keep learning.' },
  { key: 'TUNER_SNIPER_ENABLED', label: 'Auto-tune this bot', bot: 'sniper', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Auto-tune THIS bot. The master switch above gates everything; this narrows it, ' +
      'so one bot can be frozen for a clean measurement week while the others keep learning.' },
  { key: 'TUNER_COPY_ENABLED', label: 'Auto-tune this bot', bot: 'copy', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Auto-tune THIS bot. The master switch above gates everything; this narrows it, ' +
      'so one bot can be frozen for a clean measurement week while the others keep learning.' },
  { key: 'TUNER_ARB_ENABLED', label: 'Auto-tune this bot', bot: 'arb', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Auto-tune THIS bot. The master switch above gates everything; this narrows it, ' +
      'so one bot can be frozen for a clean measurement week while the others keep learning.' },
  { key: 'TUNER_BTC_ENABLED', label: 'Auto-tune this bot', bot: 'btc', group: 'Auto-tune',
    kind: 'boolean',
    help: 'Present for symmetry, but the Bitcoin lab is not in the tuner\'s loop at all: ' +
      'its own daily sweep already tests the whole catalogue against a year of data, ' +
      'which no per-window proposer can improve on.' },
  { key: 'TUNER_INTERVAL_MINUTES', label: 'Min gap between changes', bot: 'shared', group: 'Auto-tune',
    kind: 'number', min: 1, max: 10_080, step: 5,
    help: 'A floor on how often a bot can change, not a schedule — reviews are triggered by trade count. Timed from the last change, so measuring it counts toward the gap rather than adding to it.' },
  { key: 'TUNER_MIN_TRADES', label: 'Trades before acting', bot: 'shared', group: 'Auto-tune',
    kind: 'number', min: 10, max: 5000, step: 5,
    help: 'What actually decides when to act. Raise this if your bots trade quickly — 150 trades is a far better read than 40 and costs only time.' },
  { key: 'TUNER_MAX_CHANGES_PER_ROUND', label: 'Changes per round', bot: 'shared', group: 'Auto-tune',
    kind: 'number', min: 1, max: 8, step: 1,
    help: 'Keep low — changing several things at once makes the result unattributable.' },
  { key: 'TUNER_MAX_STEP_PCT', label: 'Max step', bot: 'shared', group: 'Auto-tune',
    kind: 'number', min: 1, max: 100, step: 5, help: '% a parameter may move in one round.' },

  // --- Shared ----------------------------------------------------------
  { key: 'BUY_AMOUNT_SOL', label: 'Position size', bot: 'shared', group: 'Sizing',
    kind: 'number', min: 0.0001, max: 100, step: 0.05,
    help: 'SOL. Smaller is NOT safer here — fixed fees raise the move needed to break even.' },
  { key: 'MAX_CONCURRENT_POSITIONS', label: 'Max concurrent positions', bot: 'shared',
    group: 'Sizing', kind: 'number', min: 1, max: 50, step: 1, help: 'Per bot.' },
  { key: 'MIN_WALLET_RESERVE_SOL', label: 'Wallet reserve', bot: 'shared', group: 'Sizing',
    kind: 'number', min: 0, max: 100, step: 0.05 },
  { key: 'EXIT_MODE', label: 'Exit mode', bot: 'shared', group: 'Exit', kind: 'enum',
    options: ['ratchet', 'scalp', 'ladder'], help: 'ratchet has no stop loss.' },
  { key: 'EXIT_RULES', label: 'Custom exit strategy (JSON)', bot: 'shared',
    group: 'Exit', kind: 'text',
    help: 'Only used when the exit mode is "custom". An ordered list of rules: ' +
      'conditions over the position, and how much of it to sell. First match wins ' +
      'and each rule fires once. This is what lets the auto-tuner propose a STRATEGY ' +
      'rather than only a setting — it is measured and reverted like any other change.' },
  { key: 'CHECKPOINT_SECONDS', label: 'Checkpoint', bot: 'shared', group: 'Exit',
    kind: 'number', min: 5, max: 3600, step: 5, help: 'Must beat the last check within this.' },
  { key: 'RATCHET_FIRST_CHECKPOINT_SECONDS', label: 'First checkpoint', bot: 'shared', group: 'Exit',
    kind: 'number', min: 5, max: 3600, step: 5,
    help: 'The first question comes sooner than the rest, so dead entries are cut faster. Set equal to Checkpoint for one length throughout.' },
  { key: 'RECOVER_AT_GAIN_PCT', label: 'Take stake back at', bot: 'shared', group: 'Exit',
    kind: 'number', min: 10, max: 10_000, step: 10,
    help: '% gain at which the stake comes off the table. Lower converts more trades into risk-free ones; 100 = a double.' },
  { key: 'RATCHET_GIVEBACK_PCT', label: 'Give-back limit', bot: 'shared', group: 'Exit',
    kind: 'number', min: 0, max: 100, step: 5,
    help: 'Close if this share of the best GAIN is handed back. Never fires on a losing position. 0 = off.' },
  { key: 'MOONBAG_TRIM_PCT', label: 'Moonbag trim', bot: 'shared', group: 'Exit',
    kind: 'number', min: 0, max: 90, step: 5, help: '% skimmed at each surviving checkpoint.' },
  { key: 'RATCHET_MIN_PROGRESS_PCT', label: 'Min progress', bot: 'shared', group: 'Exit',
    kind: 'number', min: 0, max: 100, step: 1, help: '% above the last check that counts as rising.' },
  { key: 'RATCHET_STOP_LOSS_PCT', label: 'Stop loss', bot: 'shared', group: 'Exit',
    kind: 'number', min: 0, max: 99, step: 5, help: '0 = none. This is the whole risk decision.' },
  { key: 'MAX_HOLD_SECONDS', label: 'Absolute max hold', bot: 'shared', group: 'Exit',
    kind: 'number', min: 60, max: 604_800, step: 60 },
  { key: 'EXIT_MAX_ATTEMPTS', label: 'Sell retries', bot: 'shared', group: 'Exit',
    kind: 'number', min: 1, max: 200, step: 1,
    help: 'Attempts before a position is written off as unsellable.' },
  { key: 'EXIT_RETRY_SECONDS', label: 'Retry gap', bot: 'shared', group: 'Exit',
    kind: 'number', min: 1, max: 3600, step: 5 },
  { key: 'PRICE_STALE_SECONDS', label: 'Give up when unpriceable for', bot: 'shared',
    group: 'Exit', kind: 'number', min: 30, max: 86_400, step: 30,
    help: 'Cannot READ a price is not the same as worthless. Be generous here.' },
  { key: 'POSITION_TICK_INTERVAL_MS', label: 'Position poll interval', bot: 'shared',
    group: 'Exit', kind: 'number', min: 250, max: 30_000, step: 250,
    help: 'How often each open position is re-priced. This is the floor on how ' +
      'late a stop can fire: the loss you realise is the trigger plus whatever ' +
      'the price did since the last look.' },
  { key: 'REJECT_TRACK_SAMPLE_PCT', label: 'Follow rejected launches', bot: 'shared',
    group: 'Exit', kind: 'number', min: 0, max: 100, step: 5,
    help: 'Percent of REJECTED launches to keep watching, to find out whether the ' +
      'filters were right. Everything else the bot learns from is a trade it took, ' +
      'so a filter quietly rejecting the winners is otherwise invisible. 0 disables.' },
  { key: 'AFTERMATH_ENABLED', label: 'Track tokens after selling', bot: 'shared',
    group: 'Exit', kind: 'boolean',
    help: 'Keeps watching a token after the position closes and records the best it ' +
      'did. This is what tells you whether an exit rule is cutting winners — the ' +
      'journal alone cannot separate a good exit from a lucky one. Costs about one ' +
      'RPC call per poll however many tokens are being followed.' },
  { key: 'AFTERMATH_WINDOW_MINUTES', label: 'Watch for', bot: 'shared',
    group: 'Exit', kind: 'number', min: 1, max: 1440, step: 5,
    help: 'How long after the exit to keep watching. Longer catches later peaks and ' +
      'takes longer before a trade counts toward the table.' },
  { key: 'POSITION_PRICE_TIMEOUT_MS', label: 'Price read timeout', bot: 'shared',
    group: 'Exit', kind: 'number', min: 500, max: 30_000, step: 250,
    help: 'A read that takes longer than this has missed the beat it was for. ' +
      'Abandoning it gets a current price sooner than waiting for a stale one.' },
  { key: 'PAPER_STARTING_BALANCE_SOL', label: 'Paper wallet balance', bot: 'shared',
    group: 'Risk', kind: 'number', min: 0.01, max: 100_000, step: 0.5,
    help: 'Paper mode only, and what every risk check sizes against. Changing it ' +
      'moves the balance now and keeps the run\'s P&L. Resets to this on restart.' },
  { key: 'DAILY_LOSS_LIMIT_SOL', label: 'Daily loss limit', bot: 'shared', group: 'Risk',
    kind: 'number', min: 0, max: 1000, step: 0.1, help: 'Per bot. Stops new entries for the day.' },
  { key: 'MAX_CONSECUTIVE_LOSSES', label: 'Loss streak breaker', bot: 'shared', group: 'Risk',
    kind: 'number', min: 1, max: 100, step: 1 },
  { key: 'BREAKER_COOLDOWN_SECONDS', label: 'Breaker cooldown', bot: 'shared', group: 'Risk',
    kind: 'number', min: 0, max: 86_400, step: 60 },
  { key: 'HOURLY_SPEND_CAP_SOL', label: 'Hourly spend cap', bot: 'shared', group: 'Risk',
    kind: 'number', min: 0, max: 1000, step: 0.5 },
  { key: 'BUY_SLIPPAGE_PCT', label: 'Buy slippage', bot: 'shared', group: 'Execution',
    kind: 'number', min: 0.1, max: 100, step: 1 },
  { key: 'SELL_SLIPPAGE_PCT', label: 'Sell slippage', bot: 'shared', group: 'Execution',
    kind: 'number', min: 0.1, max: 100, step: 1 },
  { key: 'PRIORITY_FEE_SOL', label: 'Priority fee', bot: 'shared', group: 'Execution',
    kind: 'number', min: 0, max: 1, step: 0.0001 },
  { key: 'LOG_LEVEL', label: 'Log level', bot: 'shared', group: 'Execution', kind: 'enum',
    options: ['debug', 'info', 'warn', 'error'] },
];

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/**
 * Settings that are changed by a control rather than a form field.
 *
 * These are not in FIELDS because they have their own buttons — rendering a
 * "bot enabled" dropdown next to a Start button is two ways to say the same
 * thing. But they still have to be *accepted* here, because this is the only
 * path that writes config. Leaving them out made every Start and Stop button
 * fail with "unknown setting".
 */
const CONTROL_KEYS = new Set([
  'BOT_SCREENER_ENABLED',
  'BOT_SNIPER_ENABLED',
  'BOT_COPY_ENABLED',
]);

/**
 * Every key the config schema knows about.
 *
 * Built from a default parse rather than written out by hand, so it cannot
 * drift from the schema. This is the difference between "settable" and
 * "rendered as a form field": the dashboard shows FIELDS, but the auto-tuner
 * reaches parameters that have no field, and those still have to be writable.
 */
/**
 * Never rendered into a settings payload, whatever asks for it.
 *
 * `values()` now walks every config key rather than a curated list, so the
 * exclusion has to live here rather than being implicit in what the list
 * happened to contain.
 */
const SECRET_KEYS = new Set(['WALLET_PRIVATE_KEY', 'ANTHROPIC_API_KEY']);

const KNOWN_KEYS = new Set(
  Object.keys(
    loadConfig({
      RPC_HTTP_URL: 'https://placeholder.invalid',
      RPC_WS_URL: 'wss://placeholder.invalid',
      MODE: 'paper',
      ANTHROPIC_API_KEY: '',
    } as unknown as NodeJS.ProcessEnv),
  ),
);

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** Keys that actually changed value. */
  changed: string[];
}

export class RuntimeSettings {
  private overrides: Record<string, string>;
  private readonly file: string;

  /**
   * @param live   the shared Config object every component holds a reference to
   * @param baseEnv the environment the process booted with
   */
  constructor(
    private readonly live: Config,
    private readonly baseEnv: NodeJS.ProcessEnv,
    dataDir: string,
  ) {
    this.file = join(dataDir, 'settings.json');
    mkdirSync(dataDir, { recursive: true });
    this.overrides = this.read();

    if (Object.keys(this.overrides).length > 0) {
      const result = this.applyInternal({}, false);
      if (!result.ok) {
        // A stored override that no longer validates (a renamed key, a tightened
        // bound) must not stop the bot from booting. Drop them and say so.
        log.error(`Stored settings are invalid and were discarded: ${result.error}`);
        this.overrides = {};
        this.persist();
      } else {
        log.info(`Applied ${Object.keys(this.overrides).length} saved setting(s) from settings.json`);
      }
    }
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (FIELD_BY_KEY.has(k) || CONTROL_KEYS.has(k))) out[k] = v;
      }
      return out;
    } catch (err) {
      log.warn(`Could not read settings.json (${errMessage(err)}); starting from .env`);
      return {};
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.overrides, null, 2));
    renameSync(tmp, this.file);
  }

  /** Current effective value of every editable field, as display strings. */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    // EVERY known key, not just the ones with a dashboard field. The auto-tuner
    // reads this to see what a setting currently is, and a key missing here
    // reads back as undefined — which its vetting treats as "not a live
    // setting" and drops. Forty-four of its parameters were silently
    // unchangeable for exactly that reason, and the prompt showed them as "?".
    for (const key of [...KNOWN_KEYS, ...CONTROL_KEYS]) {
      if (SECRET_KEYS.has(key)) continue;
      const raw = (this.live as unknown as Record<string, unknown>)[key];
      // Tracked wallets round-trip through their own `Addr=Name` form; the
      // generic array join would render them as [object Object] and the next
      // save would then wipe the list.
      if (key === 'COPY_WALLETS') {
        out[key] = formatCopyWallets(this.live.COPY_WALLETS);
      } else {
        out[key] = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
      }
    }
    return out;
  }

  /**
   * Validates a patch and, only if the WHOLE thing parses, commits it.
   *
   * Rejecting the entire patch rather than the offending key matters: settings
   * cross-validate (a minimum above a maximum, a screener entry against a
   * ladder exit), so applying the half that parses can leave a combination that
   * neither the user asked for nor the validator would have accepted.
   */
  apply(patch: Record<string, unknown>): ApplyResult {
    return this.applyInternal(patch, true);
  }

  private applyInternal(patch: Record<string, unknown>, persist: boolean): ApplyResult {
    const next = { ...this.overrides };

    for (const [key, value] of Object.entries(patch)) {
      if (LOCKED.has(key)) {
        return { ok: false, error: `${key} cannot be changed from the dashboard`, changed: [] };
      }
      const spec = FIELD_BY_KEY.get(key);
      // FIELDS decides what the dashboard RENDERS; it does not decide what is
      // settable. Anything the config schema knows about and LOCKED does not
      // forbid can be written here — the auto-tuner reaches parameters that
      // have no form field, and rejecting those made every such patch fail
      // with "unknown setting". loadConfig below still has the final say.
      if (!spec && !CONTROL_KEYS.has(key) && !KNOWN_KEYS.has(key)) {
        return { ok: false, error: `unknown setting "${key}"`, changed: [] };
      }

      const str =
        typeof value === 'boolean' ? String(value) : value === null ? '' : String(value).trim();
      if (!spec) {
        // A control key: boolean, no field spec to validate against. loadConfig
        // still has the final say below.
        next[key] = str;
        continue;
      }

      if (spec.kind === 'number' && str !== '' && !Number.isFinite(Number(str))) {
        return { ok: false, error: `${spec.label} must be a number`, changed: [] };
      }
      if (spec.kind === 'enum' && spec.options && !spec.options.includes(str)) {
        return {
          ok: false,
          error: `${spec.label} must be one of ${spec.options.join(', ')}`,
          changed: [],
        };
      }
      next[key] = str;
    }

    let candidate: Config;
    try {
      candidate = loadConfig({ ...this.baseEnv, ...next } as NodeJS.ProcessEnv);
    } catch (err) {
      // Exactly the message the process would print at boot, which is the point
      // — one validator, one wording, whether it came from a file or a form.
      return { ok: false, error: errMessage(err), changed: [] };
    }

    const changed: string[] = [];
    for (const key of [...FIELDS.map((f) => f.key), ...CONTROL_KEYS]) {
      const before = (this.live as unknown as Record<string, unknown>)[key];
      const after = (candidate as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(key);
    }

    // Copy onto the shared object rather than swapping the reference, so every
    // component that captured `cfg` sees the new values immediately.
    Object.assign(this.live, candidate);
    this.overrides = next;
    if (persist) this.persist();

    if (changed.length > 0) log.info(`Settings updated: ${changed.join(', ')}`);
    return { ok: true, changed };
  }

  /** Drops every override and returns to what `.env` says. */
  reset(): ApplyResult {
    this.overrides = {};
    const result = this.applyInternal({}, true);
    return result;
  }
}
