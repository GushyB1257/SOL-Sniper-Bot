/**
 * Encodes a bonding-curve account whose spot price is `price` SOL per token.
 *
 * Mirrors the on-chain layout so the tracker's real decoder runs in tests
 * rather than a stub standing in for it.
 */
export function encodeCurveForTests(price: number): Buffer {
  const vTokens = 1_000_000_000_000_000n; // 1e9 whole tokens at 6dp
  const vSol = BigInt(Math.round(price * 1e9 * 1e9)); // price x whole tokens, in lamports
  const buf = Buffer.alloc(8 + 8 * 5 + 1);
  let o = 8; // discriminator
  buf.writeBigUInt64LE(vTokens, o); o += 8;
  buf.writeBigUInt64LE(vSol, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeBigUInt64LE(1_000_000_000_000_000n, o); o += 8;
  buf.writeUInt8(0, o);
  return buf;
}
