import { PublicKey } from '@solana/web3.js';
import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';

interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: number;
  decimals: number;
}

/** Reads and normalises the SPL mint account. Shared by several checks. */
export async function fetchMintInfo(ctx: CheckContext): Promise<MintInfo> {
  return cached(ctx, `mint:${ctx.candidate.mint}`, async () => {
    const info = await ctx.conn.getParsedAccountInfo(new PublicKey(ctx.candidate.mint));
    const value = info.value;
    if (!value || !('parsed' in value.data)) {
      throw new Error('mint account not found or not an SPL mint');
    }
    const parsed = value.data.parsed as {
      info?: {
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        supply?: string;
        decimals?: number;
      };
    };
    const i = parsed.info ?? {};
    return {
      mintAuthority: i.mintAuthority ?? null,
      freezeAuthority: i.freezeAuthority ?? null,
      supply: Number(i.supply ?? '0'),
      decimals: i.decimals ?? 6,
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
