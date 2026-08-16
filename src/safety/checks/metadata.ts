import type { Check } from '../types.js';
import { fetchSocials, metadataUrl } from '../../watchlist/metadata.js';

/**
 * The sniper reuses the screener's metadata fetcher rather than keeping its own.
 *
 * There were two implementations of this, and they had drifted: the screener's
 * followed IPFS redirects with the allowlist re-checked at every hop, retried a
 * slow gateway, and knew the difference between a document that loaded with no
 * links and one that never loaded — while the sniper's refused redirects
 * outright, allowed four fewer gateways, and collapsed every one of those cases
 * into a single 20-point penalty. Two copies of a security-relevant allowlist is
 * one too many in any case.
 */

/** Characters used to impersonate a legitimate ticker (Ｓ vs S, С vs C, ...). */
// eslint-disable-next-line no-misleading-character-class
const SUSPICIOUS_CHARS = /[Ѐ-ӿ＀-￯​-‏⁠-⁯︀-️]/;

/**
 * Impersonation filter. A launch whose name mixes Cyrillic or full-width
 * lookalikes into a Latin ticker is trying to pass as a different token in a
 * list view. That is never accidental.
 */
export const metadataSanityCheck: Check = {
  id: 'metadata_sanity',
  severity: 'major',
  penalty: 35,
  timeoutMs: 200,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const { name = '', symbol = '' } = ctx.candidate;
    if (!name || !symbol) {
      return { passed: false, detail: 'launch has no name or symbol' };
    }
    if (name.length > 48 || symbol.length > 12) {
      return { passed: false, detail: `implausible name/symbol length (${name.length}/${symbol.length})` };
    }
    if (SUSPICIOUS_CHARS.test(name) || SUSPICIOUS_CHARS.test(symbol)) {
      return {
        passed: false,
        detail: 'name/symbol contains homoglyph or zero-width characters — impersonation attempt',
      };
    }
    return { passed: true, detail: `${name} (${symbol})` };
  },
};

/**
 * Requires the off-chain metadata to resolve and to carry at least one social
 * link. Not proof of legitimacy — a scammer can add a dead Twitter link in ten
 * seconds — but it costs them something, and the pure-spam tail of launches
 * never bothers.
 */
export const socialsCheck: Check = {
  id: 'socials',
  severity: 'major',
  penalty: 20,
  timeoutMs: 2500,
  cost: 'http',
  failClosed: false,
  async run(ctx) {
    if (!ctx.cfg.REQUIRE_SOCIALS) {
      return { passed: true, detail: 'socials check disabled' };
    }

    // Say which of these happened. One message covered four different failures,
    // which is why "metadata did not resolve from an allowed host" turned up on
    // launches that declared no URI at all and on ones whose gateway was busy.
    const raw = ctx.candidate.uri;
    if (!raw) {
      return { passed: false, detail: 'launch declares no metadata URI' };
    }
    if (!metadataUrl(raw)) {
      return {
        passed: false,
        detail: `metadata URI is not an allowed https gateway: ${raw.slice(0, 80)}`,
      };
    }

    const socials = await fetchSocials(raw);

    // Could not read it. That is a fact about the gateway, not about the token,
    // and charging the launch 20 points for it makes the filter stricter the
    // worse our connectivity is — the same inversion as reading a mint before
    // the node has it. Public IPFS gateways rate-limit constantly, so this is
    // the common case, not the rare one.
    //
    // It does mean a deployer who parks metadata on a gateway that always fails
    // dodges the requirement. That is worth it: the alternative penalises every
    // honest launch whenever ipfs.io is having a bad hour.
    if (socials.failed) {
      return { passed: true, detail: 'metadata gateway did not answer — not held against the launch' };
    }
    if (socials.count === 0) {
      return { passed: false, detail: 'no twitter/telegram/website in metadata' };
    }
    if (!socials.image) {
      return { passed: false, detail: 'metadata has socials but no image' };
    }
    return { passed: true, detail: `${socials.count} social link(s) present` };
  },
};

/**
 * Copycat filter. When a ticker trends, dozens of identical launches appear
 * within minutes hoping someone buys the wrong one. The first is a gamble; the
 * twentieth is a farm.
 */
export const duplicateNameCheck: Check = {
  id: 'duplicate_name',
  severity: 'major',
  penalty: 25,
  timeoutMs: 50,
  cost: 'local',
  failClosed: false,
  async run(ctx) {
    const windowMin = ctx.cfg.DUPLICATE_NAME_WINDOW_MINUTES;
    if (windowMin <= 0) return { passed: true, detail: 'duplicate check disabled' };

    const key = normaliseTicker(ctx.candidate.symbol ?? ctx.candidate.name ?? '');
    if (!key) return { passed: true, detail: 'no ticker to compare' };

    const count = recentTickers.count(key, windowMin * 60_000);
    recentTickers.record(key);

    if (count >= 3) {
      return {
        passed: false,
        detail: `${count} launches with ticker "${key}" in the last ${windowMin}m — copycat wave`,
      };
    }
    return { passed: true, detail: `ticker "${key}" seen ${count}x recently` };
  },
};

function normaliseTicker(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** In-memory sliding window of tickers seen. Deliberately not persisted. */
class TickerWindow {
  private seen = new Map<string, number[]>();

  record(key: string): void {
    const list = this.seen.get(key) ?? [];
    list.push(Date.now());
    this.seen.set(key, list);
    if (this.seen.size > 20_000) this.prune(3_600_000);
  }

  count(key: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return (this.seen.get(key) ?? []).filter((t) => t >= cutoff).length;
  }

  private prune(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, times] of this.seen) {
      const kept = times.filter((t) => t >= cutoff);
      if (kept.length === 0) this.seen.delete(key);
      else this.seen.set(key, kept);
    }
  }
}

export const recentTickers = new TickerWindow();
