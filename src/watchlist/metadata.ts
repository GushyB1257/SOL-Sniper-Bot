import { withTimeout } from '../util/async.js';

/**
 * Off-chain token metadata, fetched once per token and cached.
 *
 * Only allowlisted IPFS/Arweave hosts are fetched: the URI is chosen by the
 * token's deployer, so an unrestricted fetch would let any launch point the bot
 * at an internal address (SSRF) or a tarpit that stalls the screener.
 */

const ALLOWED_HOSTS = [
  'ipfs.io',
  'cf-ipfs.com',
  'dweb.link',
  'w3s.link',
  'nftstorage.link',
  'pinata.cloud',
  'mypinata.cloud',
  'ipfs.nftstorage.link',
  'cloudflare-ipfs.com',
  'arweave.net',
  'irys.xyz',
];

export interface TokenSocials {
  /** The fetch has completed (successfully or not). */
  checked: boolean;
  /**
   * The document could not be read — network error, timeout, rate limit, or a
   * host we will not fetch from. Distinct from a document that loaded and
   * genuinely had no links, because treating the two the same silently rejects
   * tokens that DO have socials whenever a public IPFS gateway is slow.
   */
  failed: boolean;
  twitter?: string;
  telegram?: string;
  website?: string;
  image?: string;
  /** How many distinct social links resolved. */
  count: number;
}

export const UNCHECKED: TokenSocials = { checked: false, failed: false, count: 0 };

const NONE: TokenSocials = { checked: true, failed: false, count: 0 };
const FAILED: TokenSocials = { checked: true, failed: true, count: 0 };

/**
 * Exact match or a subdomain of an allowlisted host — never a suffix match,
 * which would let `evil-ipfs.io` pass as `ipfs.io`.
 */
export function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return allowedHost(url.hostname) ? url : null;
}

/** Pulls the social links out of a token metadata document. */
export function parseSocials(text: string): TokenSocials {
  // An unreadable document is a failed read, not a token without socials.
  if (text.length > 256_000) return FAILED;

  let meta: { twitter?: unknown; telegram?: unknown; website?: unknown; image?: unknown };
  try {
    meta = JSON.parse(text) as typeof meta;
  } catch {
    return FAILED;
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return FAILED;

  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  const twitter = str(meta.twitter);
  const telegram = str(meta.telegram);
  const website = str(meta.website);

  return {
    checked: true,
    failed: false,
    twitter,
    telegram,
    website,
    image: str(meta.image),
    count: [twitter, telegram, website].filter(Boolean).length,
  };
}

/**
 * Follows redirects by hand, re-checking the allowlist at every hop.
 *
 * IPFS gateways routinely 301 to a subdomain form, so refusing redirects
 * outright loses most tokens' metadata. Letting `fetch` follow them
 * automatically would hand the deployer an SSRF primitive, since the first hop
 * they control decides where the second goes. Re-validating each `Location` is
 * what keeps both properties.
 */
async function fetchAllowlisted(start: URL): Promise<Response | null> {
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    const res = await withTimeout(
      fetch(url, { redirect: 'manual', headers: { accept: 'application/json' } }),
      4000,
      'metadata fetch',
    );
    if (res.status < 300 || res.status >= 400) return res.ok ? res : null;

    const location = res.headers.get('location');
    if (!location) return null;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return null;
    }
    const checked = safeUrl(next.toString());
    if (!checked) return null;
    url = checked;
  }
  return null;
}

/**
 * Reads a token's metadata and reports which socials it declares.
 *
 * Retries once, because the public IPFS gateways these URIs point at are slow
 * and rate-limited, and a single timeout would otherwise be recorded as "this
 * token has no socials" — quietly rejecting tokens that do.
 */
export async function fetchSocials(uri: string | undefined): Promise<TokenSocials> {
  // No URI at all is a real answer: the deployer declared no metadata.
  if (!uri) return NONE;
  const url = safeUrl(uri);
  if (!url) return FAILED;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchAllowlisted(url);
      if (!res) continue;
      const text = await withTimeout(res.text(), 3000, 'metadata body');
      const parsed = parseSocials(text);
      if (!parsed.failed) return parsed;
    } catch {
      // fall through to the retry
    }
  }
  return FAILED;
}
