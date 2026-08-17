import { PublicKey } from '@solana/web3.js';
import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';

/** pump.fun mints a fixed 1,000,000,000 tokens per launch. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

/**
 * The single highest-signal pre-buy filter on pump.fun.
 *
 * The deployer can snipe their own token in the create transaction, before
 * anyone else can possibly see it. If they take a large slice of supply at a
 * near-zero price, every subsequent buyer is exit liquidity by construction:
 * the moment the chart moves, they dump a position with an infinite cost-basis
 * advantage. A few percent is normal (they need a stake); double digits is a
 * pre-loaded dump.
 */
export const devBuyCheck: Check = {
  id: 'dev_buy_share',
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 200,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const tokens = ctx.candidate.initialBuyTokens;
    if (tokens === undefined || tokens <= 0) {
      return { passed: true, detail: 'deployer took no tokens at creation' };
    }

    const supply = PUMP_TOTAL_SUPPLY;
    const pct = (tokens / supply) * 100;
    const max = ctx.cfg.MAX_DEV_BUY_PCT;

    const metrics = { devBuyPct: pct };
    if (pct > max) {
      return {
        passed: false,
        detail: `deployer bought ${pct.toFixed(1)}% of supply at creation (limit ${max}%)`,
        metrics,
      };
    }
    return { passed: true, detail: `deployer holds ${pct.toFixed(2)}% of supply`, metrics };
  },
};

interface HolderStats {
  top10Pct: number;
  holders: number;
}

async function holderStats(ctx: CheckContext): Promise<HolderStats> {
  return cached(ctx, `holders:${ctx.candidate.mint}`, async () => {
    const largest = await ctx.conn.getTokenLargestAccounts(new PublicKey(ctx.candidate.mint));
    const supplyResp = await ctx.conn.getTokenSupply(new PublicKey(ctx.candidate.mint));
    const total = Number(supplyResp.value.amount);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('token supply unavailable');
    }
    const accounts = largest.value ?? [];
    const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
    return { top10Pct: (top10 / total) * 100, holders: accounts.length };
  });
}

/**
 * Concentration check. On a brand-new bonding-curve launch the curve itself
 * holds nearly all supply, so this is near-useless at t=0 and is only run for
 * tokens that already have a trading history (migrated / non-pump pools).
 */
export const holderConcentrationCheck: Check = {
  id: 'holder_concentration',
  severity: 'major',
  penalty: 30,
  timeoutMs: 3000,
  cost: 'rpc',
  failClosed: false,
  async run(ctx) {
    // On the bonding curve the "top holder" is the curve PDA; measuring
    // concentration there tells us nothing.
    if (ctx.candidate.pool === 'pump') {
      return { passed: true, detail: 'skipped: bonding-curve launch' };
    }

    const { top10Pct, holders } = await holderStats(ctx);
    const max = ctx.cfg.MAX_TOP10_HOLDER_PCT;
    const metrics = { top10Pct };
    if (top10Pct > max) {
      return {
        passed: false,
        detail: `top 10 holders control ${top10Pct.toFixed(1)}% (limit ${max}%)`,
        metrics,
      };
    }
    return {
      passed: true,
      detail: `top 10 hold ${top10Pct.toFixed(1)}% across ${holders} tracked accounts`,
      metrics,
    };
  },
};

/**
 * Sanity-check the bonding curve reserves reported by the feed against what a
 * fresh pump.fun launch actually looks like (~30 SOL virtual / ~1.07B virtual
 * tokens). A curve far outside that band means either stale data or a token
 * that is not as new as advertised — and buying a "new launch" that is actually
 * ten minutes old means buying someone else's exit.
 */
export const curveSanityCheck: Check = {
  id: 'curve_sanity',
  severity: 'major',
  penalty: 20,
  timeoutMs: 100,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const { vSolInBondingCurve, pool } = ctx.candidate;
    if (pool !== 'pump' || vSolInBondingCurve === undefined) {
      return { passed: true, detail: 'no curve data to validate' };
    }
    // Fresh curve starts at ~30 virtual SOL. Anything well above means real
    // money has already gone in, i.e. we are late.
    if (vSolInBondingCurve > 45) {
      return {
        passed: false,
        detail: `curve already at ${vSolInBondingCurve.toFixed(1)} virtual SOL — launch is not fresh`,
      };
    }
    return { passed: true, detail: `curve at ${vSolInBondingCurve.toFixed(1)} virtual SOL` };
  },
};
