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
 *
 * The opposite edge matters too, and is the reason there is a floor as well as
 * a ceiling. A deployer who takes nothing at all has no position to defend and
 * nothing to lose by abandoning the token the moment it stops trending — which
 * is most of them. "A few percent is normal (they need a stake)" was always the
 * theory; a floor is what lets it be enforced rather than assumed.
 */
export const devBuyCheck: Check = {
  id: 'dev_buy_share',
  rugCritical: true,
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 200,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const tokens = ctx.candidate.initialBuyTokens;

    // "We do not know" and "we know it was nothing" used to share this branch,
    // and share a `passed: true` with no metric attached. That was harmless
    // while the only rule was a ceiling — both are safely under it — and it is
    // wrong in two ways the moment there is a floor.
    //
    // They are opposite cases for a floor: a deployer who took nothing has no
    // skin in the game and is exactly what a floor exists to reject, while an
    // unmeasured launch must not be assumed to be zero or the floor rejects
    // every candidate from a feed that does not report the field. Only
    // PumpPortal populates it; the RPC discovery path never does.
    //
    // And returning no metric meant the zero cohort was invisible downstream:
    // the entry note carries `devBuyPct` into the trade journal, and the
    // tuner's dev-buy breakdown parses it back out of that note. A launch with
    // no metric is dropped from the breakdown entirely, so the bucket that
    // reads as "<1%" has never included the true zeros — the group a floor is
    // aimed squarely at. It is measured now.
    if (tokens === undefined) {
      return { passed: true, detail: 'deployer buy not reported by this feed' };
    }

    const supply = PUMP_TOTAL_SUPPLY;
    const pct = tokens <= 0 ? 0 : (tokens / supply) * 100;
    const { MIN_DEV_BUY_PCT: min, MAX_DEV_BUY_PCT: max } = ctx.cfg;

    const metrics = { devBuyPct: pct };
    if (pct > max) {
      return {
        passed: false,
        detail: `deployer bought ${pct.toFixed(1)}% of supply at creation (limit ${max}%)`,
        metrics,
      };
    }
    // The floor is a quality filter, not a rug fail-safe, so buy-everything
    // mode ignores it. The ceiling above stays: a pre-loaded dump is a rug
    // setup in any mode.
    if (min > 0 && pct < min && ctx.cfg.SNIPE_MODE !== 'all') {
      return {
        passed: false,
        detail:
          pct === 0
            ? `deployer took no tokens at creation (floor ${min}%)`
            : `deployer bought only ${pct.toFixed(2)}% of supply (floor ${min}%)`,
        metrics,
      };
    }
    return {
      passed: true,
      detail:
        pct === 0
          ? 'deployer took no tokens at creation'
          : `deployer holds ${pct.toFixed(2)}% of supply`,
      metrics,
    };
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
  rugCritical: true,
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
