import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { bondingCurvePda, decodeBondingCurve, type BondingCurveState } from '../execution/bonding-curve.js';
import type { Watchlist } from './watchlist.js';

const log = logger('curve-poll');

/**
 * Reads watched tokens' bonding curves straight off the chain.
 *
 * The screener originally got market cap and volume from PumpPortal's
 * per-token trade stream, which meant the whole strategy was gated on a free
 * shared websocket honouring a subscription for every launch. When it quietly
 * stops delivering — and it does — the bot watches hundreds of tokens and
 * screens none of them, which looks identical to being broken.
 *
 * Everything the filter needs is in the curve account:
 *
 *   market cap = (virtualSol / virtualTokens) x totalSupply     — exact
 *   volume     ~ realSolReserves, plus movement seen since      — lower bound
 *
 * So this polls the accounts directly. One `getMultipleAccounts` covers 100
 * tokens, which makes watching a few hundred young launches a handful of RPC
 * calls per second — and it works on the first read of a token we have never
 * seen a trade for, which is the case the trade feed can never cover.
 */
export class CurvePoller {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private pdas = new Map<string, PublicKey>();

  private stats = { polls: 0, accounts: 0, decoded: 0, missing: 0, errors: 0 };
  private lastErrorAt = 0;

  constructor(
    private readonly conn: Connection,
    private readonly cfg: Config,
    private readonly watchlist: Watchlist,
    /** Called for each token whose curve moved, so it can be re-screened. */
    private readonly onUpdate: (mint: string) => void,
  ) {}

  get snapshot() {
    return { ...this.stats };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => log.error(`Poll failed: ${errMessage(err)}`));
    }, this.cfg.SCREEN_POLL_INTERVAL_MS);
    this.timer.unref?.();
    log.info(
      `Polling bonding curves every ${this.cfg.SCREEN_POLL_INTERVAL_MS}ms ` +
        `for up to ${this.cfg.SCREEN_POLL_MAX_TOKENS} tokens`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Cached PDA derivation. `findProgramAddressSync` hashes in a loop, and at a
   * few hundred mints per second that is real CPU on the same thread the
   * screener runs on.
   */
  private pdaFor(mint: string): PublicKey | null {
    const hit = this.pdas.get(mint);
    if (hit) return hit;
    try {
      const pda = bondingCurvePda(new PublicKey(mint));
      this.pdas.set(mint, pda);
      if (this.pdas.size > 20_000) this.pdas.clear();
      return pda;
    } catch {
      return null;
    }
  }

  async poll(): Promise<void> {
    // Overlapping polls would multiply the RPC load exactly when the node is
    // already slow, which is the worst possible time to do it.
    if (this.polling) return;

    const mints = this.watchlist.pollable(this.cfg.SCREEN_POLL_MAX_TOKENS);
    if (mints.length === 0) return;

    this.polling = true;
    try {
      this.stats.polls += 1;
      for (let i = 0; i < mints.length; i += 100) {
        const batch = mints.slice(i, i + 100);
        const keys = batch.map((m) => this.pdaFor(m));
        const valid = batch.filter((_, idx) => keys[idx] !== null);
        const pdas = keys.filter((k): k is PublicKey => k !== null);
        if (pdas.length === 0) continue;

        const infos = await this.conn.getMultipleAccountsInfo(pdas, 'processed');
        this.stats.accounts += pdas.length;

        for (let j = 0; j < infos.length; j++) {
          const mint = valid[j]!;
          const info = infos[j];
          if (!info) {
            // Not a pump.fun bonding curve, or already migrated and closed.
            this.stats.missing += 1;
            this.watchlist.markCurveMissing(mint);
            continue;
          }
          const state = decodeBondingCurve(info.data);
          if (!state) continue;
          this.stats.decoded += 1;
          if (this.watchlist.recordCurve(mint, state)) this.onUpdate(mint);
        }
      }
    } catch (err) {
      this.stats.errors += 1;
      // One line a minute, not one per failed batch — a rate-limited node
      // fails every batch and would otherwise bury the log.
      if (Date.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = Date.now();
        log.warn(
          `Curve poll failed: ${errMessage(err)}. If this is a rate limit, raise ` +
            'SCREEN_POLL_INTERVAL_MS or lower SCREEN_POLL_MAX_TOKENS.',
        );
      }
    } finally {
      this.polling = false;
    }
  }
}

/** Market cap in SOL implied by a curve's reserves. Exact, not derived. */
export function marketCapFromState(state: BondingCurveState): number {
  if (state.virtualTokenReserves === 0n) return 0;
  const sol = Number(state.virtualSolReserves) / 1e9;
  const tokens = Number(state.virtualTokenReserves) / 1e6;
  const supply = Number(state.tokenTotalSupply) / 1e6;
  if (tokens <= 0 || supply <= 0) return 0;
  return (sol / tokens) * supply;
}
