import { PublicKey } from '@solana/web3.js';
import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';

/**
 * Checks about where a launch came from, rather than what it looks like.
 *
 * The existing battery reads the token: its authorities, its supply split, its
 * metadata. These read the *provenance* — who made it, whether they are still
 * in it, and whether the first buyers arrived organically or all at once. Each
 * costs an RPC call on the entry path, which is why they are all off by
 * default: turn one on when you want it, and watch the rate-limit chip.
 */

/**
 * How many distinct wallets hold the token at all.
 *
 * Free: it reuses the same largest-accounts read the concentration check
 * already makes, so the number is there whether this check runs or not. It is
 * capped at 20 by what `getTokenLargestAccounts` returns, which is fine — the
 * question being asked is "more than a handful?", not "exactly how many?".
 */
export const holderCountCheck: Check = {
  id: 'holder_count',
  severity: 'major',
  penalty: 20,
  timeoutMs: 1500,
  failClosed: false,
  async run(ctx) {
    const min = ctx.cfg.MIN_HOLDERS;
    if (min <= 0) return { passed: true, detail: 'holder count not checked' };

    const stats = await cached(ctx, `holders:${ctx.candidate.mint}`, async () => {
      const largest = await ctx.conn.getTokenLargestAccounts(new PublicKey(ctx.candidate.mint));
      const supplyResp = await ctx.conn.getTokenSupply(new PublicKey(ctx.candidate.mint));
      const total = Number(supplyResp.value.amount);
      if (!Number.isFinite(total) || total <= 0) throw new Error('token supply unavailable');
      const accounts = largest.value ?? [];
      const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
      return { top10Pct: (top10 / total) * 100, holders: accounts.length };
    });

    // The curve's own account is a holder by the chain's reckoning but not by
    // any useful one, so it does not count toward participation.
    const holders = Math.max(0, stats.holders - 1);
    if (holders < min) {
      return { passed: false, detail: `only ${holders} holders (need ${min})` };
    }
    return { passed: true, detail: `${holders}+ holders` };
  },
};

/**
 * Is the deployer still in their own token?
 *
 * `dev_buy_share` asks how much they took at creation. This asks whether they
 * still hold it — a deployer who has already exited between the launch and our
 * look is the clearest possible statement about what happens next, and it is
 * invisible to any check that only reads the creation transaction.
 */
export const deployerStillHoldsCheck: Check = {
  id: 'deployer_exited',
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 2000,
  failClosed: false,
  async run(ctx) {
    if (!ctx.cfg.REJECT_IF_DEPLOYER_EXITED) {
      return { passed: true, detail: 'deployer holdings not checked' };
    }
    // Nothing to have exited from.
    const bought = ctx.candidate.initialBuyTokens ?? 0;
    if (bought <= 0) return { passed: true, detail: 'deployer never held any' };

    const held = await cached(ctx, `devheld:${ctx.candidate.mint}`, async () => {
      const res = await ctx.conn.getParsedTokenAccountsByOwner(
        new PublicKey(ctx.candidate.creator),
        { mint: new PublicKey(ctx.candidate.mint) },
        'processed',
      );
      let total = 0;
      for (const { account } of res.value) {
        const parsed = account.data.parsed as {
          info?: { tokenAmount?: { uiAmount?: number | null } };
        };
        total += parsed.info?.tokenAmount?.uiAmount ?? 0;
      }
      return total;
    });

    // Dust is an exit. Selling 99% and keeping a rounding error is not holding.
    const keptPct = bought > 0 ? (held / bought) * 100 : 0;
    if (keptPct < 5) {
      return {
        passed: false,
        detail: `deployer has already sold — holds ${keptPct.toFixed(1)}% of what they bought`,
      };
    }
    return { passed: true, detail: `deployer still holds ${keptPct.toFixed(0)}% of their buy` };
  },
};

/**
 * How old the deployer's wallet is.
 *
 * A wallet funded twenty minutes ago that has done nothing but deploy this
 * token is a throwaway. `deployer_balance` catches the cheap version of that;
 * this catches the funded one. Age is taken from the oldest signature the RPC
 * will return in one page — if there are fewer than a page of them, the oldest
 * really is the wallet's first transaction.
 */
export const creatorAgeCheck: Check = {
  id: 'creator_age',
  severity: 'major',
  penalty: 25,
  timeoutMs: 3000,
  failClosed: false,
  async run(ctx) {
    const minMinutes = ctx.cfg.MIN_CREATOR_AGE_MINUTES;
    if (minMinutes <= 0) return { passed: true, detail: 'creator age not checked' };

    const oldest = await cached(ctx, `age:${ctx.candidate.creator}`, async () => {
      const sigs = await ctx.conn.getSignaturesForAddress(new PublicKey(ctx.candidate.creator), {
        limit: 1000,
      });
      if (sigs.length === 0) return null;
      // A full page means the wallet is older than this page can show, which
      // is already older than any threshold worth setting.
      if (sigs.length >= 1000) return 0;
      return sigs[sigs.length - 1]?.blockTime ?? null;
    });

    if (oldest === null) {
      return { passed: false, detail: 'creator wallet has no transaction history' };
    }
    if (oldest === 0) return { passed: true, detail: 'creator wallet is well established' };

    const ageMinutes = (Date.now() / 1000 - oldest) / 60;
    if (ageMinutes < minMinutes) {
      return {
        passed: false,
        detail: `creator wallet is ${ageMinutes.toFixed(0)}m old (need ${minMinutes}m)`,
      };
    }
    return { passed: true, detail: `creator wallet ${(ageMinutes / 60).toFixed(1)}h old` };
  },
};

/**
 * Were the first buys bundled?
 *
 * Organic interest arrives across slots as people see the launch. A bundle
 * lands several transactions in the same slot as creation, which is the
 * signature of a coordinated launch where the buyers are the deployer's own
 * wallets — and everyone who buys afterwards is exit liquidity for them.
 *
 * Counted from signatures alone, without fetching a single transaction: the
 * question is how many landed in the creation slot, not who signed them.
 */
export const launchBundleCheck: Check = {
  id: 'launch_bundle',
  severity: 'fatal',
  penalty: 100,
  timeoutMs: 3000,
  failClosed: false,
  async run(ctx) {
    const max = ctx.cfg.MAX_LAUNCH_BUNDLE_TXS;
    if (max <= 0) return { passed: true, detail: 'bundling not checked' };

    const inFirstSlot = await cached(ctx, `bundle:${ctx.candidate.mint}`, async () => {
      const sigs = await ctx.conn.getSignaturesForAddress(new PublicKey(ctx.candidate.mint), {
        limit: 50,
      });
      if (sigs.length === 0) return 0;
      const slots = sigs.map((s) => s.slot).filter((s) => Number.isFinite(s));
      if (slots.length === 0) return 0;
      const creation = Math.min(...slots);
      return slots.filter((s) => s === creation).length;
    });

    if (inFirstSlot > max) {
      return {
        passed: false,
        detail: `${inFirstSlot} transactions in the creation slot (max ${max}) — bundled launch`,
      };
    }
    return { passed: true, detail: `${inFirstSlot} transaction(s) in the creation slot` };
  },
};

export const provenanceChecks: Check[] = [
  holderCountCheck,
  deployerStillHoldsCheck,
  creatorAgeCheck,
  launchBundleCheck,
];

export type { CheckContext };
