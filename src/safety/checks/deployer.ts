import { PublicKey } from '@solana/web3.js';
import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';
import { lamportsToSol } from '../../util/solana.js';

async function deployerBalanceSol(ctx: CheckContext): Promise<number> {
  return cached(ctx, `bal:${ctx.candidate.creator}`, async () => {
    const lamports = await ctx.conn.getBalance(new PublicKey(ctx.candidate.creator), 'processed');
    return lamportsToSol(lamports);
  });
}

/**
 * Serial ruggers mint from freshly-funded dust wallets, hundreds per day. A
 * deployer with real SOL behind them has something to lose and is a meaningfully
 * different population from the spam bots.
 *
 * This is a soft signal, not proof — plenty of honest launches come from small
 * wallets, and a determined scammer can fund a wallet. It earns its place by
 * being nearly free to evaluate and by cutting the highest-volume spam.
 */
export const deployerBalanceCheck: Check = {
  id: 'deployer_balance',
  severity: 'major',
  penalty: 25,
  timeoutMs: 2500,
  cost: 'rpc',
  failClosed: false,
  async run(ctx) {
    const bal = await deployerBalanceSol(ctx);
    const min = ctx.cfg.MIN_DEPLOYER_BALANCE_SOL;
    const metrics = { deployerSol: bal };
    if (bal >= min) {
      return { passed: true, detail: `deployer holds ${bal.toFixed(3)} SOL`, metrics };
    }
    return {
      passed: false,
      detail: `deployer holds only ${bal.toFixed(4)} SOL (min ${min}) — likely a throwaway wallet`,
      metrics,
    };
  },
};

/**
 * Local reputation: how often have this deployer's previous launches ended in a
 * loss for us? Starts with no data and gets sharper the longer the bot runs.
 *
 * Deliberately permissive below a sample floor — condemning a wallet on one
 * observation would blacklist half of all deployers on noise alone.
 */
export const deployerHistoryCheck: Check = {
  id: 'deployer_history',
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 100,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const rec = ctx.store.getCreator(ctx.candidate.creator);
    if (!rec || rec.rugs + rec.wins < 3) {
      return { passed: true, detail: 'no meaningful history for this deployer' };
    }
    const settled = rec.rugs + rec.wins;
    const rugRate = rec.rugs / settled;
    if (rugRate > ctx.cfg.MAX_DEPLOYER_RUG_RATE) {
      return {
        passed: false,
        detail:
          `deployer rugged ${rec.rugs}/${settled} previous launches ` +
          `(${(rugRate * 100).toFixed(0)}%, limit ${(ctx.cfg.MAX_DEPLOYER_RUG_RATE * 100).toFixed(0)}%)`,
      };
    }
    return {
      passed: true,
      detail: `deployer history ${rec.wins}W/${rec.rugs}L over ${rec.launches} launches`,
    };
  },
};

/**
 * A wallet that mints token after token in a short window is running a volume
 * scam: spray fifty launches, dump whichever one catches a bid.
 */
export const deployerSpamCheck: Check = {
  id: 'deployer_spam',
  severity: 'major',
  penalty: 30,
  timeoutMs: 100,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const rec = ctx.store.getCreator(ctx.candidate.creator);
    if (!rec) return { passed: true, detail: 'first launch seen from this deployer' };

    const ageHours = (Date.now() - rec.firstSeen) / 3_600_000;
    // Need at least a few launches AND a short window before calling it spam.
    if (rec.launches >= 5 && ageHours < 24) {
      return {
        passed: false,
        detail: `deployer minted ${rec.launches} tokens in ${ageHours.toFixed(1)}h — serial launcher`,
      };
    }
    return { passed: true, detail: `${rec.launches} launches over ${ageHours.toFixed(1)}h` };
  },
};
