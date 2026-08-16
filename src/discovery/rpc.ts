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

/** Anchor puts an 8-byte instruction discriminator before the arguments. */
const ANCHOR_DISCRIMINATOR_BYTES = 8;

/**
 * Longest string worth reading out of instruction data.
 *
 * The length prefix is attacker-controlled, so it is a claim rather than a
 * fact. Anything past this is either corrupt or someone trying to make us
 * allocate — and a legitimate name, symbol or metadata URI is far shorter.
 */
const MAX_BORSH_STRING = 512;

/**
 * Reads a Borsh string: a u32 little-endian length, then that many UTF-8 bytes.
 *
 * Returns null rather than throwing on anything malformed, because this runs on
 * every launch off the log stream and one odd transaction must not stop the
 * feed.
 */
function readBorshString(data: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset + 4 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(offset, true);
  if (len > MAX_BORSH_STRING) return null;

  const start = offset + 4;
  const end = start + len;
  if (end > data.length) return null;
  return {
    value: new TextDecoder().decode(data.subarray(start, end)),
    next: end,
  };
}

/**
 * Pulls name, symbol and metadata URI out of the create instruction's arguments.
 *
 * These are not derivable from the account list, and without them the safety
 * battery is judging a launch it cannot see: `metadata_sanity` fails for having
 * no name (-35) and `socials` fails for having no URI to fetch (-20), so every
 * launch off this feed scored 45 against a threshold of 70 and the sniper could
 * never buy anything at all. They are already in the transaction we fetched to
 * find the mint, so reading them costs nothing.
 *
 * Arguments are Borsh-encoded after the discriminator: name, symbol, uri.
 */
export function readCreateArgs(data: Uint8Array): { name?: string; symbol?: string; uri?: string } {
  const name = readBorshString(data, ANCHOR_DISCRIMINATOR_BYTES);
  if (!name) return {};
  const symbol = readBorshString(data, name.next);
  if (!symbol) return { name: name.value };
  const uri = readBorshString(data, symbol.next);
  return { name: name.value, symbol: symbol.value, uri: uri?.value };
}

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

      const { name, symbol, uri } = readCreateArgs(ix.data);

      return {
        mint: mint.toBase58(),
        creator: user.toBase58(),
        name,
        symbol,
        uri,
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
