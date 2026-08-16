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
]);

export type FieldKind = 'number' | 'boolean' | 'enum' | 'text';

export interface FieldSpec {
  key: string;
  label: string;
  /** Which dashboard tab this belongs to. */
  bot: 'screener' | 'sniper' | 'copy' | 'shared';
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
  { key: 'MAX_DEV_BUY_PCT', label: 'Max dev buy', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 1, help: '% of supply in the creation transaction.' },
  { key: 'MAX_TOP10_HOLDER_PCT', label: 'Max top-10 holders', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 100, step: 1 },
  { key: 'MIN_DEPLOYER_BALANCE_SOL', label: 'Min deployer balance', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1000, step: 0.05 },
  { key: 'MAX_DEPLOYER_RUG_RATE', label: 'Max deployer rug rate', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'REQUIRE_SOCIALS', label: 'Require socials', bot: 'sniper', group: 'Safety', kind: 'boolean' },
  { key: 'DUPLICATE_NAME_WINDOW_MINUTES', label: 'Copycat window', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 0, max: 1440, step: 5 },
  { key: 'MAX_CANDIDATE_AGE_MS', label: 'Max candidate age', bot: 'sniper', group: 'Safety',
    kind: 'number', min: 100, max: 600_000, step: 100, help: 'ms. Older than this is not a snipe.' },

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
    for (const key of [...FIELDS.map((f) => f.key), ...CONTROL_KEYS]) {
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
      if (!spec && !CONTROL_KEYS.has(key)) {
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
