import type { Token } from './types.js';

/**
 * Mint addresses and decimals are consensus facts about mainnet-beta, so they
 * are pinned here rather than fetched. A wrong `decimals` value silently
 * mis-scales every amount by orders of magnitude, so treat edits with care.
 */
export const WSOL: Token = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  decimals: 9,
};

export const KNOWN_TOKENS: readonly Token[] = [
  WSOL,
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', decimals: 9 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', decimals: 9 },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH', decimals: 8 },
];

const BY_SYMBOL = new Map(KNOWN_TOKENS.map((token) => [token.symbol.toUpperCase(), token]));
const BY_MINT = new Map(KNOWN_TOKENS.map((token) => [token.mint, token]));

export function tokenBySymbol(symbol: string): Token | undefined {
  return BY_SYMBOL.get(symbol.trim().toUpperCase());
}

export function tokenByMint(mint: string): Token | undefined {
  return BY_MINT.get(mint.trim());
}

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Resolve a user-supplied token reference. Accepts a known symbol, or a raw
 * mint with explicit decimals in `mint:decimals` form for tokens not pinned
 * above — guessing decimals is never safe.
 */
export function resolveToken(reference: string): Token {
  const text = reference.trim();
  const bySymbol = tokenBySymbol(text);
  if (bySymbol) return bySymbol;

  const byMint = tokenByMint(text);
  if (byMint) return byMint;

  const [mint = '', decimalsText] = text.split(':');
  if (BASE58_MINT.test(mint) && decimalsText !== undefined) {
    const decimals = Number(decimalsText);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`invalid decimals for mint ${mint}: ${decimalsText}`);
    }
    return { mint, symbol: `${mint.slice(0, 4)}…`, decimals };
  }

  if (BASE58_MINT.test(text)) {
    throw new Error(
      `unknown mint ${text}: specify decimals as "${text}:<decimals>" (guessing decimals would mis-scale every amount)`,
    );
  }
  throw new Error(`unknown token reference: ${JSON.stringify(reference)}`);
}
