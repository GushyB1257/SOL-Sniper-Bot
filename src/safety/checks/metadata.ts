import type { Check, CheckContext } from '../types.js';
import { cached } from '../types.js';
import { withTimeout } from '../../util/async.js';

interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  createdOn?: string;
}

/** Only these hosts are fetched — the URI is attacker-controlled. */
const ALLOWED_METADATA_HOSTS = [
  'ipfs.io',
  'cf-ipfs.com',
  'nftstorage.link',
  'pinata.cloud',
  'arweave.net',
  'pump.mypinata.cloud',
];

function isSafeMetadataUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // No plaintext, no file://, no gopher://, and no fetching from an arbitrary
  // host the deployer picked — that would let any launch point us at an
  // internal address (SSRF) or a tarpit that stalls the snipe.
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_METADATA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return allowed ? url : null;
}

async function fetchMetadata(ctx: CheckContext): Promise<TokenMetadata | null> {
  return cached(ctx, `meta:${ctx.candidate.mint}`, async () => {
    const raw = ctx.candidate.uri;
    if (!raw) return null;
    const url = isSafeMetadataUrl(raw);
    if (!url) return null;

    const res = await withTimeout(
      fetch(url, { redirect: 'error', headers: { accept: 'application/json' } }),
      2000,
      'metadata fetch',
    );
    if (!res.ok) return null;

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > 256_000) return null; // don't swallow a huge body on the hot path

    const text = await withTimeout(res.text(), 1500, 'metadata body');
    if (text.length > 256_000) return null;
    return JSON.parse(text) as TokenMetadata;
  });
}

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
  failClosed: false,
  async run(ctx) {
    if (!ctx.cfg.REQUIRE_SOCIALS) {
      return { passed: true, detail: 'socials check disabled' };
    }
    const meta = await fetchMetadata(ctx);
    if (!meta) {
      return { passed: false, detail: 'metadata did not resolve from an allowed host' };
    }
    const socials = [meta.twitter, meta.telegram, meta.website].filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
    if (socials.length === 0) {
      return { passed: false, detail: 'no twitter/telegram/website in metadata' };
    }
    if (!meta.image) {
      return { passed: false, detail: 'metadata has socials but no image' };
    }
    return { passed: true, detail: `${socials.length} social link(s) present` };
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
