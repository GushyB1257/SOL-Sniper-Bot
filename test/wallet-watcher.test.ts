import { describe, it, expect, beforeEach } from 'vitest';
import { WalletWatcher, type WalletTrade } from '../src/copy/wallet-watcher.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Connection } from '@solana/web3.js';

const A = 'AaAaAa1111111111111111111111111111111111111';
const B = 'BbBbBb2222222222222222222222222222222222222';
const MINT = 'Mint1111111111111111111111111111111111111';

/**
 * Stands in for the RPC. Records when each read starts and finishes so the
 * test can tell concurrent reads from sequential ones, and hands back whatever
 * balances the test has staged.
 */
class StubConnection {
  /** wallet -> mint -> UI balance. */
  holdings = new Map<string, Map<string, number>>();
  delayMs = 0;
  calls = 0;
  /** [start, end] for every read, in ms since the poll began. */
  windows: Array<[number, number]> = [];
  private origin = Date.now();

  reset(): void {
    this.origin = Date.now();
    this.windows = [];
    this.calls = 0;
  }

  async getParsedTokenAccountsByOwner(
    owner: { toBase58(): string },
    filter: { programId: { toBase58(): string } },
  ): Promise<{ value: Array<{ account: { data: unknown } }> }> {
    const started = Date.now() - this.origin;
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.windows.push([started, Date.now() - this.origin]);

    // Staged holdings live under the classic token program; Token-2022 is read
    // too and comes back empty, exactly as it does for most pump.fun mints.
    const classic = filter.programId.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const held = classic
      ? (this.holdings.get(owner.toBase58()) ?? new Map<string, number>())
      : new Map<string, number>();
    return {
      value: [...held].map(([mint, uiAmount]) => ({
        account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount } } } } },
      })),
    };
  }
}

let cfg: Config;
let conn: StubConnection;
let trades: WalletTrade[];
let watcher: WalletWatcher;

function build(wallets: string[]): void {
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    COPY_WALLETS: wallets.join(','),
    COPY_SKIP_PREEXISTING: 'true',
  } as unknown as NodeJS.ProcessEnv);

  conn = new StubConnection();
  trades = [];
  watcher = new WalletWatcher(conn as unknown as Connection, cfg, (t) => trades.push(t));
}

beforeEach(() => build([A, B]));

describe('reading tracked wallets', () => {
  it('polls every wallet at once rather than one after another', async () => {
    // Polled in sequence, the last wallet in the list is seen a round trip per
    // wallet late — which is latency paid for nothing, since the reads are
    // independent.
    conn.delayMs = 60;
    conn.reset();
    const started = Date.now();
    await watcher.poll();
    const elapsed = Date.now() - started;

    // Two wallets x two token programs = four reads, all overlapping.
    expect(conn.calls).toBe(4);
    expect(elapsed).toBeLessThan(60 * 4 * 0.6);

    const latestStart = Math.max(...conn.windows.map(([s]) => s));
    const earliestEnd = Math.min(...conn.windows.map(([, e]) => e));
    expect(latestStart).toBeLessThan(earliestEnd);
  });

  it('primes on the first read and reports a later buy', async () => {
    conn.holdings.set(A, new Map([[MINT, 0]]));
    await watcher.poll();
    expect(trades).toHaveLength(0);

    conn.holdings.set(A, new Map([[MINT, 5_000_000]]));
    await watcher.poll();

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ wallet: A, mint: MINT, side: 'buy', tokenDelta: 5_000_000 });
  });

  it('reports the fraction sold, which is what gets mirrored', async () => {
    conn.holdings.set(B, new Map([[MINT, 1_000_000]]));
    await watcher.poll(); // prime with the holding
    conn.holdings.set(B, new Map([[MINT, 250_000]]));
    await watcher.poll();

    const sell = trades.find((t) => t.side === 'sell')!;
    expect(sell.wallet).toBe(B);
    expect(sell.fraction).toBeCloseTo(0.75, 6);
    expect(sell.balanceAfter).toBe(250_000);
  });

  it('keeps polling the other wallet when one read throws', async () => {
    conn.holdings.set(B, new Map([[MINT, 10]]));
    await watcher.poll();

    const good = conn.getParsedTokenAccountsByOwner.bind(conn);
    conn.getParsedTokenAccountsByOwner = async (
      owner: { toBase58(): string },
      filter: { programId: { toBase58(): string } },
    ) => {
      if (owner.toBase58() === A) throw new Error('429 rate limited');
      return good(owner, filter);
    };
    conn.holdings.set(B, new Map([[MINT, 40]]));
    await watcher.poll();

    expect(watcher.snapshot.errors).toBeGreaterThan(0);
    expect(trades.some((t) => t.wallet === B && t.side === 'buy')).toBe(true);
  });
});
