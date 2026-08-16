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
  'nftstorage.link',
  'pinata.cloud',
  'arweave.net',
  'pump.mypinata.cloud',
];

export interface TokenSocials {
  /** The fetch has completed (successfully or not). */
  checked: boolean;
  twitter?: string;
  telegram?: string;
  website?: string;
  image?: string;
  /** How many distinct social links resolved. */
  count: number;
}

export const UNCHECKED: TokenSocials = { checked: false, count: 0 };

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
  if (text.length > 256_000) return { checked: true, count: 0 };

  let meta: { twitter?: unknown; telegram?: unknown; website?: unknown; image?: unknown };
  try {
    meta = JSON.parse(text) as typeof meta;
  } catch {
    return { checked: true, count: 0 };
  }
  if (typeof meta !== 'object' || meta === null) return { checked: true, count: 0 };

  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  const twitter = str(meta.twitter);
  const telegram = str(meta.telegram);
  const website = str(meta.website);

  return {
    checked: true,
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

export async function fetchSocials(uri: string | undefined): Promise<TokenSocials> {
  if (!uri) return { checked: true, count: 0 };
  const url = safeUrl(uri);
  if (!url) return { checked: true, count: 0 };

  try {
    const res = await fetchAllowlisted(url);
    if (!res) return { checked: true, count: 0 };

    const text = await withTimeout(res.text(), 3000, 'metadata body');
    return parseSocials(text);
  } catch {
    return { checked: true, count: 0 };
  }
}
