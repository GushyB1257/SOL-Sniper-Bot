import { logger } from '../logger.js';
import { withTimeout } from './async.js';

const log = logger('solprice');

/**
 * SOL/USD, refreshed periodically.
 *
 * The screener's thresholds are in dollars because that is how every screener
 * displays them, but the feed reports market cap and volume in SOL. One number
 * bridges the two, and getting it wrong silently scales every filter — so it is
 * fetched rather than assumed, with the configured value as a fallback and a
 * loud warning when the fetch never succeeds.
 */
export class SolPrice {
  private price: number;
  private lastFetch = 0;
  private everSucceeded = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    fallbackUsd: number,
    private readonly refreshMs = 300_000,
  ) {
    this.price = fallbackUsd;
  }

  /** Current price. Never blocks — refreshes in the background. */
  get usd(): number {
    if (Date.now() - this.lastFetch > this.refreshMs) void this.refresh();
    return this.price;
  }

  get isLive(): boolean {
    return this.everSucceeded;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastFetch = Date.now();

    this.inFlight = (async () => {
      try {
        const res = await withTimeout(
          fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
            headers: { accept: 'application/json' },
          }),
          5000,
          'sol price',
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = (await res.json()) as { solana?: { usd?: number } };
        const usd = body.solana?.usd;
        if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
          throw new Error('unexpected response shape');
        }

        const first = !this.everSucceeded;
        this.price = usd;
        this.everSucceeded = true;
        if (first) log.info(`SOL price live: $${usd.toFixed(2)}`);
      } catch (err) {
        if (!this.everSucceeded) {
          log.warn(
            `SOL price fetch failed (${String(err)}). Using SOL_USD_FALLBACK=$${this.price} — ` +
              'USD thresholds will be wrong if that is stale.',
          );
        }
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  solToUsd(sol: number): number {
    return sol * this.usd;
  }

  usdToSol(usd: number): number {
    return this.usd > 0 ? usd / this.usd : 0;
  }
}
