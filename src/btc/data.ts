import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('btc:data');

/**
 * One hourly candle, straight off the exchange.
 *
 * `tb` (taker-buy base volume) is the piece most sources do not carry and the
 * reason Binance's kline feed was chosen: it says how much of the hour's volume
 * was AGGRESSIVE buying — market orders lifting the ask — which is the honest,
 * free approximation of "whale watching". Per-wallet whale feeds are paid
 * products; the aggressor-flow ratio is the same idea measured in aggregate,
 * and it costs nothing.
 */
export interface Candle {
  /** Open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume (BTC). */
  v: number;
  /** Quote-asset volume (USD). */
  qv: number;
  /** Number of trades in the hour. */
  n: number;
  /** Taker-buy base volume — the aggressive-buy share of `v`. */
  tb: number;
}

export const HOUR_MS = 3_600_000;

/**
 * Hosts tried in order. All serve identical public kline data with no API key.
 *
 * `data-api.binance.vision` first: it is Binance's dedicated market-data host,
 * exists precisely so that market data does not need an account, and is not
 * geo-restricted the way the trading hosts can be. The trading hosts are
 * fallbacks for when it is down.
 */
const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api.binance.us',
];

const MAX_PER_REQUEST = 1000;

/** Raw kline row shape: twelve positional fields, numbers as strings. */
type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

export function parseKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error('klines response is not an array');
  return (raw as RawKline[]).map((k) => {
    const candle: Candle = {
      t: k[0],
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5]),
      qv: Number(k[7]),
      n: k[8],
      tb: Number(k[9]),
    };
    if (!Number.isFinite(candle.o) || !Number.isFinite(candle.c) || candle.c <= 0) {
      throw new Error(`malformed kline at ${k[0]}`);
    }
    return candle;
  });
}

interface CacheFile {
  v: 1;
  symbol: string;
  interval: string;
  /** The window start this cache was BUILT for — see the widening check. */
  coversFrom: number;
  candles: Candle[];
}

export interface BtcDataDeps {
  dataDir: string;
  symbol: string;
  /** Injectable for tests; the sandbox this code is written in has no network. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * A year of hourly candles, cached on disk and topped up incrementally.
 *
 * The first fill is ~9 requests (8,760 candles at 1,000 per request); after
 * that each refresh asks only for what is missing since the last cached candle,
 * which is one request an hour in steady state. The cache is a plain JSON file
 * with an atomic write — this is bulk market data, re-fetchable at will, so it
 * does not earn the Store's fsync ceremony.
 */
export class BtcData {
  private candles: Candle[] = [];
  private coversFrom = 0;
  private readonly file: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  /** The host that last answered, so the dashboard can say where data is from. */
  lastHost = '';
  lastError = '';

  constructor(private readonly deps: BtcDataDeps) {
    this.file = join(deps.dataDir, 'btc-candles.json');
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  all(): readonly Candle[] {
    return this.candles;
  }

  /** Only candles whose hour has fully closed — a forming candle is not data. */
  closed(): readonly Candle[] {
    const cutoff = this.now() - HOUR_MS;
    let end = this.candles.length;
    while (end > 0 && this.candles[end - 1]!.t > cutoff) end -= 1;
    return this.candles.slice(0, end);
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CacheFile>;
      if (parsed.v === 1 && parsed.symbol === this.deps.symbol && Array.isArray(parsed.candles)) {
        this.candles = parsed.candles;
        this.coversFrom = parsed.coversFrom ?? parsed.candles[0]?.t ?? 0;
      }
    } catch (err) {
      log.warn(`candle cache unreadable, refetching: ${errMessage(err)}`);
      this.candles = [];
    }
  }

  private save(): void {
    const out: CacheFile = {
      v: 1,
      symbol: this.deps.symbol,
      interval: '1h',
      coversFrom: this.coversFrom,
      candles: this.candles,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), 'utf8');
    renameSync(tmp, this.file);
  }

  /**
   * Brings the cache up to date. Returns how many new candles arrived.
   *
   * Failures return 0 rather than throwing: the caller runs on a timer and the
   * strategies keep working on the candles already held — an hour of stale data
   * degrades the forward test, it does not break it.
   */
  async refresh(historyDays: number): Promise<number> {
    const wantFrom = this.now() - historyDays * 24 * HOUR_MS;

    // Refetch from scratch ONLY when the window has widened — the cache was
    // built for a later start than is now being asked for. The tempting
    // simpler check, "does the cache begin after wantFrom", is wrong in a way
    // that costs the whole feature: a cache that begins late because the
    // exchange had no older data trips it on EVERY poll, wiping and refetching
    // a year of candles once a minute. What the cache covers is what it was
    // asked to cover, so that is what is recorded and compared.
    const widened = this.candles.length > 0 && wantFrom < this.coversFrom - 24 * HOUR_MS;

    // Work on a copy and commit only on success, so a wipe-and-refetch that
    // dies mid-flight cannot leave us with less data than we started with.
    const base = widened ? [] : [...this.candles];
    let from =
      base.length > 0
        ? // Re-request the LAST cached candle, not the hour after it: it may
          // have been cached while its hour was still open, and this is the
          // only chance to replace that provisional close with the real one.
          base[base.length - 1]!.t
        : wantFrom;

    let added = 0;
    let changed = false;
    try {
      // Bounded: a year is 9 requests, so 12 covers it with margin. A busier
      // loop than that means the math is wrong somewhere; stop rather than hammer.
      for (let i = 0; i < 12 && from < this.now(); i++) {
        const batch = await this.fetchBatch(from);
        if (batch.length === 0) break;
        for (const c of batch) {
          const last = base[base.length - 1];
          if (!last || c.t > last.t) {
            base.push(c);
            added += 1;
            changed = true;
          } else if (c.t === last.t && c.c !== last.c) {
            base[base.length - 1] = c;
            changed = true;
          }
        }
        if (batch.length < MAX_PER_REQUEST) break;
        from = batch[batch.length - 1]!.t + HOUR_MS;
      }
      this.candles = base;
      this.coversFrom = wantFrom;
      this.lastError = '';
    } catch (err) {
      this.lastError = errMessage(err);
      log.warn(`candle refresh failed: ${this.lastError}`);
      return 0;
    }

    // Trim to the window so the file cannot grow forever.
    const cut = this.candles.findIndex((c) => c.t >= wantFrom);
    if (cut > 0) {
      this.candles = this.candles.slice(cut);
      changed = true;
    }

    if (changed) this.save();
    return added;
  }

  private async fetchBatch(fromMs: number): Promise<Candle[]> {
    let lastErr: unknown = new Error('no host tried');
    for (const host of this.lastHost ? [this.lastHost, ...HOSTS.filter((h) => h !== this.lastHost)] : HOSTS) {
      try {
        const url =
          `${host}/api/v3/klines?symbol=${this.deps.symbol}&interval=1h` +
          `&startTime=${fromMs}&limit=${MAX_PER_REQUEST}`;
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`${host} returned ${res.status}`);
        const parsed = parseKlines(await res.json());
        this.lastHost = host;
        return parsed;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`no data host answered: ${errMessage(lastErr)}`);
  }
}
