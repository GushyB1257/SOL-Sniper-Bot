import { Connection, PublicKey } from '@solana/web3.js';
import type { Discovery, TokenCandidate } from '../types.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('discovery:rpc');

/** pump.fun bonding-curve program. */
export const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Anchor account order for the pump.fun `create` instruction. */
const CREATE_ACCOUNT_INDEX = {
  mint: 0,
  bondingCurve: 2,
  /** The signer paying for the launch — the deployer. */
  user: 7,
} as const;

/**
 * Detects launches straight from your own RPC node's log stream.
 *
 * Slower to implement but strictly better than a shared public feed: the only
 * hop between the validator and you is your own node, and nobody else is
 * reading the same socket. `logsSubscribe` fires on `processed` commitment, so
 * we see the create before it is confirmed.
 *
 * The log line alone does not carry the mint, so each hit costs one
 * `getTransaction` round-trip. On a fast node that is ~50-150ms.
 */
export class RpcDiscovery implements Discovery {
  readonly name = 'rpc';

  private subId: number | null = null;
  private stopped = false;
  /** Signatures already dispatched, to survive duplicate log deliveries. */
  private seen = new Set<string>();

  constructor(private readonly conn: Connection) {}

  async start(onCandidate: (c: TokenCandidate) => void): Promise<void> {
    this.stopped = false;
    this.subId = this.conn.onLogs(
      PUMP_FUN_PROGRAM,
      (logs) => {
        if (this.stopped || logs.err) return;
        if (!logs.logs.some((l) => l.includes('Instruction: Create'))) return;
        if (this.seen.has(logs.signature)) return;

        this.seen.add(logs.signature);
        if (this.seen.size > 5000) {
          // Cheap bounded cache: drop the oldest half.
          this.seen = new Set([...this.seen].slice(-2500));
        }

        void this.hydrate(logs.signature)
          .then((c) => {
            if (c) onCandidate(c);
          })
          .catch((err) => log.debug(`Hydrate failed for ${logs.signature}: ${errMessage(err)}`));
      },
      'processed',
    );
    log.info(`Subscribed to pump.fun program logs (sub ${this.subId})`);
  }

  /** Pulls the transaction and reads mint + deployer out of the create ix. */
  private async hydrate(signature: string): Promise<TokenCandidate | null> {
    const tx = await this.conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx || tx.meta?.err) return null;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });

    for (const ix of tx.transaction.message.compiledInstructions) {
      const programId = keys.get(ix.programIdIndex);
      if (!programId?.equals(PUMP_FUN_PROGRAM)) continue;
      if (ix.accountKeyIndexes.length <= CREATE_ACCOUNT_INDEX.user) continue;

      const mint = keys.get(ix.accountKeyIndexes[CREATE_ACCOUNT_INDEX.mint]!);
      const curve = keys.get(ix.accountKeyIndexes[CREATE_ACCOUNT_INDEX.bondingCurve]!);
      const user = keys.get(ix.accountKeyIndexes[CREATE_ACCOUNT_INDEX.user]!);
      if (!mint || !user) continue;

      return {
        mint: mint.toBase58(),
        creator: user.toBase58(),
        bondingCurveKey: curve?.toBase58(),
        pool: 'pump',
        signature,
        // blockTime is seconds; fall back to now for unconfirmed blocks.
        detectedAt: Date.now(),
        source: this.name,
      };
    }
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.subId !== null) {
      try {
        await this.conn.removeOnLogsListener(this.subId);
      } catch {
        /* connection may already be torn down */
      }
      this.subId = null;
    }
  }
}
