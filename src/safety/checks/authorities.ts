import { PublicKey } from '@solana/web3.js';
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';

interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
}

/** Both token programs mint on pump.fun, and their mint layouts share a prefix. */
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/**
 * How long to wait before looking a second time for a mint that is not there.
 *
 * One slot is ~400ms; this is a little under, because the account either
 * appears almost immediately or it was never coming.
 */
const MINT_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Reads and normalises the SPL mint account. Shared by several checks.
 *
 * Two things here are deliberate and were both bugs before.
 *
 * **`processed`, not the connection default of `confirmed`.** Discovery detects
 * launches at `processed` — that is the whole point of it, and the log stream
 * says so — so reading the mint at `confirmed` asks the node about an account it
 * has not admitted to yet. It answers "no such account", and because the two
 * authority checks fail closed, that reads as a rug and vetoes the buy. The
 * inversion is the bad part: the faster we saw the launch, the more certain the
 * rejection, so the filter was strictest on exactly the launches worth having.
 * Reading at `processed` costs nothing in accuracy for this question — pump.fun
 * revokes both authorities inside the create transaction and they can never come
 * back — and it matches what the deployer checks already do.
 *
 * **Decoded here rather than by the node.** `jsonParsed` depends on the endpoint
 * recognising the program, which not every endpoint does for Token-2022; when it
 * does not, the account comes back as raw base64 and the old code called a
 * perfectly ordinary mint "not an SPL mint" and vetoed it. Unpacking the bytes
 * ourselves works on any endpoint, covers both token programs, and puts less on
 * the wire — which matters when this is the single busiest call the bot makes.
 */
export async function fetchMintInfo(ctx: CheckContext): Promise<MintInfo> {
  return cached(ctx, `mint:${ctx.candidate.mint}`, async () => {
    const key = new PublicKey(ctx.candidate.mint);

    let info = await ctx.conn.getAccountInfo(key, 'processed');
    if (!info) {
      // A feed running off someone else's node can be a slot ahead of ours, so
      // "not there" on a seconds-old launch is worth asking twice before it
      // becomes a veto. Only the missing case retries; a malformed account will
      // still be malformed.
      await sleep(MINT_SETTLE_MS);
      info = await ctx.conn.getAccountInfo(key, 'processed');
    }
    if (!info) {
      throw new Error(
        `mint account does not exist ${MINT_SETTLE_MS}ms after the launch was seen — ` +
          'this node has not caught up, or the feed reported a mint that never landed',
      );
    }

    const programId = TOKEN_PROGRAMS.find((p) => p.equals(info!.owner));
    if (!programId) {
      throw new Error(`mint is owned by ${info.owner.toBase58()}, which is not a token program`);
    }

    const mint = unpackMint(key, info, programId);
    return {
      mintAuthority: mint.mintAuthority?.toBase58() ?? null,
      freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
      supply: mint.supply,
      decimals: mint.decimals,
    };
  });
}

/**
 * A live freeze authority lets the deployer freeze your token account, which is
 * the cleanest honeypot there is: you can buy, you simply cannot ever sell.
 * There is no legitimate reason for a fair memecoin launch to keep it.
 */
export const freezeAuthorityCheck: Check = {
  id: 'freeze_authority',
  rugCritical: true,
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 2500,
  cost: 'rpc',
  failClosed: true,
  async run(ctx) {
    const mint = await fetchMintInfo(ctx);
    if (mint.freezeAuthority === null) {
      return { passed: true, detail: 'freeze authority revoked' };
    }
    return {
      passed: false,
      detail: `freeze authority still held by ${mint.freezeAuthority} — can freeze your tokens`,
    };
  },
};

/**
 * A live mint authority lets the deployer print unlimited supply and dilute
 * holders to zero. Pump.fun revokes this inside the create transaction, so on a
 * genuine pump launch this passes; if it does not, the token is not what the
 * feed claims it is.
 */
export const mintAuthorityCheck: Check = {
  id: 'mint_authority',
  rugCritical: true,
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 2500,
  cost: 'rpc',
  failClosed: true,
  async run(ctx) {
    const mint = await fetchMintInfo(ctx);
    if (mint.mintAuthority === null) {
      return { passed: true, detail: 'mint authority revoked, supply is fixed' };
    }
    return {
      passed: false,
      detail: `mint authority still held by ${mint.mintAuthority} — supply can be inflated`,
    };
  },
};
