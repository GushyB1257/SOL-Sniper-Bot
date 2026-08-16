import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchSocials, allowedHost, parseSocials } from '../src/watchlist/metadata.js';

/**
 * The metadata URI is chosen by the token's deployer, so it is attacker
 * controlled. These tests pin the two properties that follow from that: only
 * allowlisted hosts are ever contacted, and a redirect cannot be used to walk
 * off the allowlist.
 */

let server: Server;
let hits: string[];

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ twitter: 'https://x.com/a', telegram: 'https://t.me/a' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function localUrl(path = '/meta.json'): string {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}${path}`;
}

describe('fetchSocials', () => {
  it('reports "checked, none" for a missing URI rather than blocking forever', async () => {
    const s = await fetchSocials(undefined);
    expect(s.checked).toBe(true);
    expect(s.count).toBe(0);
  });

  it('never contacts a host outside the allowlist', async () => {
    const s = await fetchSocials(localUrl());
    expect(s.checked).toBe(true);
    expect(s.count).toBe(0);
    // The decisive assertion: the local server was never reached at all.
    expect(hits).toHaveLength(0);
  });

  it('refuses plain http even on an allowlisted host', async () => {
    await fetchSocials('http://ipfs.io/ipfs/abc');
    expect(hits).toHaveLength(0);
  });

  it('rejects a host that merely ends with an allowlisted name', async () => {
    // "evil-ipfs.io" must not pass as "ipfs.io"; only exact match or subdomain.
    await fetchSocials('https://evil-ipfs.io/ipfs/abc');
    await fetchSocials('https://ipfs.io.attacker.test/ipfs/abc');
    expect(hits).toHaveLength(0);
  });

  it('rejects a malformed URI without throwing', async () => {
    await expect(fetchSocials('not a url')).resolves.toEqual({
      checked: true,
      failed: true,
      count: 0,
    });
  });

  it('separates "no metadata declared" from "could not read it"', async () => {
    // A deployer who declared no URI genuinely has no socials. A gateway that
    // timed out tells us nothing — conflating the two rejects real matches.
    await expect(fetchSocials(undefined)).resolves.toEqual({
      checked: true,
      failed: false,
      count: 0,
    });
    expect((await fetchSocials('https://ipfs.io/ipfs/unreachable-in-tests')).failed).toBe(true);
  });

});

describe('allowedHost', () => {
  it('accepts an allowlisted host and its subdomains', () => {
    expect(allowedHost('ipfs.io')).toBe(true);
    expect(allowedHost('IPFS.IO')).toBe(true);
    expect(allowedHost('gateway.pinata.cloud')).toBe(true);
  });

  it('rejects lookalikes, internal names and IPs', () => {
    // This function also guards every redirect hop, so a suffix match here
    // would be an SSRF primitive handed to whoever deployed the token.
    for (const h of [
      'evil-ipfs.io',
      'ipfs.io.attacker.test',
      'notarweave.net',
      'localhost',
      '169.254.169.254',
      '127.0.0.1',
    ]) {
      expect(allowedHost(h), h).toBe(false);
    }
  });
});

describe('parseSocials', () => {
  it('counts distinct social links and ignores the image', () => {
    const s = parseSocials(
      JSON.stringify({ twitter: 'https://x.com/a', website: 'https://a.com', image: 'ipfs://x' }),
    );
    expect(s.count).toBe(2);
    expect(s.image).toBe('ipfs://x');
  });

  it('does not count blank or non-string fields', () => {
    expect(parseSocials(JSON.stringify({ twitter: '   ', telegram: 42, website: null })).count).toBe(0);
  });

  it('treats malformed and non-object documents as unreadable', () => {
    for (const body of ['not json', '[]', 'null', '"a string"', '']) {
      const s = parseSocials(body);
      expect(s.checked).toBe(true);
      expect(s.failed).toBe(true);
      expect(s.count).toBe(0);
    }
  });

  it('reports a valid document with no links as read, not failed', () => {
    const s = parseSocials(JSON.stringify({ name: 'Coin', symbol: 'C' }));
    expect(s.failed).toBe(false);
    expect(s.count).toBe(0);
  });

  it('refuses an oversized document rather than parsing it', () => {
    expect(parseSocials('x'.repeat(300_000)).count).toBe(0);
  });
});
