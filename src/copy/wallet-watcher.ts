import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('copy-watch');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** A change in a tracked wallet's holding of one token. */
export interface WalletTrade {
  wallet: string;
  mint: string;
  side: 'buy' | 'sell';
  /** Tokens gained or lost, in UI units, always positive. */
  tokenDelta: number;
  /** Their holding after the change. */
  balanceAfter: number;
  /**
   * For a sell, the share of their holding they just disposed of — which is
   * the number the copy trader mirrors. For a buy, the share of their new
   * position that this purchase represents.
   */
  fraction: number;
  /** True the first time we see them hold this token at all. */
  isNewPosition: boolean;
  at: number;
}

interface WalletState {
  /** mint -> UI balance at the last poll. */
  balances: Map<string, number>;
  /** mint -> largest balance ever seen, for "how far out are they" maths. */
  peak: Map<string, number>;
  /** True once the first poll has completed, so we know what they held before. */
  primed: boolean;
}

/**
 * Watches tracked wallets by reading their token balances.
 *
 * The obvious implementation is a websocket subscription to their trades, and
 * that is what a copy trader normally uses. This does not, for two reasons.
 * The feed we would subscribe to has already been observed to stop delivering
 * silently, and — more fundamentally — a trade stream tells you what happened
 * while you were listening, whereas a balance tells you the truth right now. A
 * missed message costs a trade; a missed balance costs one poll interval.
 *
 * Reading balances also gives the one number that matters most for mirroring an
 * exit: the FRACTION of their holding they sold. That is directly observable
 * from a balance delta and would otherwise have to be reconstructed from a
 * stream of partial fills.
 *
 * The cost is latency — you react a poll interval late rather than in the same
 * block. For following a wallet's position that is acceptable; for racing them
 * into a launch it is not, and this does not pretend otherwise.
 */
export class WalletWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state = new Map<string, WalletState>();
  private stats = { polls: 0, errors: 0, tradesSeen: 0, walletsPrimed: 0 };
  private lastErrorAt = 0;

  constructor(
    private readonly conn: Connection,
    private readonly cfg: Config,
    private readonly onTrade: (t: WalletTrade) => void,
  ) {}

  get snapshot() {
    return { ...this.stats, tracking: this.cfg.COPY_WALLETS.length };
  }

  /** Current holdings of a tracked wallet, for the dashboard. */
  holdingsOf(wallet: string): Array<{ mint: string; balance: number }> {
    const st = this.state.get(wallet);
    if (!st) return [];
    return [...st.balances]
      .filter(([, b]) => b > 0)
      .map(([mint, balance]) => ({ mint, balance }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => log.error(`Poll failed: ${errMessage(err)}`));
    }, this.cfg.COPY_POLL_INTERVAL_MS);
    this.timer.unref?.();

    if (this.cfg.COPY_WALLETS.length === 0) {
      // Running with nothing to track is a valid state — you start the bot and
      // then paste addresses in — but it is worth saying once, because
      // otherwise a bot that will never trade looks identical to a broken one.
      log.warn('Copy trader started with NO wallets. Add them on the Copy tab under Settings.');
      return;
    }
    log.info(
      `Tracking ${this.cfg.COPY_WALLETS.length} wallet(s) every ${this.cfg.COPY_POLL_INTERVAL_MS}ms`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forgets a wallet's state, so re-adding it primes again rather than firing. */
  forget(wallet: string): void {
    this.state.delete(wallet);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    const wallets = this.cfg.COPY_WALLETS;
    if (wallets.length === 0) return;

    this.polling = true;
    try {
      this.stats.polls += 1;
      for (const wallet of wallets) {
        await this.pollWallet(wallet.address);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollWallet(wallet: string): Promise<void> {
    let balances: Map<string, number>;
    try {
      balances = await this.readBalances(wallet);
    } catch (err) {
      this.stats.errors += 1;
      if (Date.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = Date.now();
        log.warn(`Could not read ${wallet.slice(0, 8)}: ${errMessage(err)}`);
      }
      return;
    }

    let st = this.state.get(wallet);
    if (!st) {
      st = { balances: new Map(), peak: new Map(), primed: false };
      this.state.set(wallet, st);
    }

    // First read establishes what they already held. Emitting buys for those
    // would have us pile into every bag they are already stuck in.
    if (!st.primed) {
      st.balances = balances;
      for (const [mint, bal] of balances) st.peak.set(mint, bal);
      st.primed = true;
      this.stats.walletsPrimed += 1;
      log.info(
        `Primed ${wallet.slice(0, 8)}… with ${balances.size} existing holding(s)` +
          (this.cfg.COPY_SKIP_PREEXISTING ? ' (will not be copied)' : ''),
      );
      if (!this.cfg.COPY_SKIP_PREEXISTING) {
        for (const [mint, bal] of balances) {
          this.emit(wallet, mint, 'buy', bal, bal, 1, true);
        }
      }
      return;
    }

    const now = Date.now();
    const mints = new Set([...st.balances.keys(), ...balances.keys()]);
    for (const mint of mints) {
      const before = st.balances.get(mint) ?? 0;
      const after = balances.get(mint) ?? 0;
      if (after === before) continue;

      const peak = Math.max(st.peak.get(mint) ?? 0, after, before);
      st.peak.set(mint, peak);

      if (after > before) {
        const delta = after - before;
        this.emit(wallet, mint, 'buy', delta, after, after > 0 ? delta / after : 1, before === 0, now);
      } else {
        const delta = before - after;
        // Fraction OF THEIR HOLDING, which is what gets mirrored — not a
        // fraction of the original position, so a wallet unwinding in three
        // equal-looking sells produces three increasing fractions.
        this.emit(wallet, mint, 'sell', delta, after, before > 0 ? delta / before : 1, false, now);
      }
    }

    st.balances = balances;
  }

  private emit(
    wallet: string,
    mint: string,
    side: 'buy' | 'sell',
    tokenDelta: number,
    balanceAfter: number,
    fraction: number,
    isNewPosition: boolean,
    at = Date.now(),
  ): void {
    this.stats.tradesSeen += 1;
    try {
      this.onTrade({ wallet, mint, side, tokenDelta, balanceAfter, fraction, isNewPosition, at });
    } catch (err) {
      log.error(`Copy handler threw for ${mint}: ${errMessage(err)}`);
    }
  }

  /** All SPL token balances a wallet holds, in UI units. */
  private async readBalances(wallet: string): Promise<Map<string, number>> {
    const owner = new PublicKey(wallet);
    const out = new Map<string, number>();

    // Both token programs: a growing share of new mints are Token-2022, and
    // missing those would silently make some wallets look inactive.
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const res = await this.conn.getParsedTokenAccountsByOwner(owner, { programId }, 'processed');
      for (const { account } of res.value) {
        const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
        const mint = typeof info?.mint === 'string' ? info.mint : null;
        const amount = (info?.tokenAmount as { uiAmount?: number | null } | undefined)?.uiAmount;
        if (!mint || typeof amount !== 'number' || !Number.isFinite(amount)) continue;
        if (amount <= 0) continue;
        out.set(mint, (out.get(mint) ?? 0) + amount);
      }
    }
    return out;
  }
}
