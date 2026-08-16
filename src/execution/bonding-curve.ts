import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM } from '../discovery/rpc.js';

/**
 * Decoded pump.fun `BondingCurve` account.
 *
 * Layout after the 8-byte Anchor discriminator, all little-endian u64:
 *   virtualTokenReserves, virtualSolReserves,
 *   realTokenReserves,    realSolReserves,
 *   tokenTotalSupply,     then a 1-byte `complete` flag.
 */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** True once the curve has graduated to an AMM; curve pricing no longer applies. */
  complete: boolean;
}

const CURVE_DATA_LEN = 8 + 8 * 5 + 1;

export function bondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBytes()],
    PUMP_FUN_PROGRAM,
  );
  return pda;
}

export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  if (data.length < CURVE_DATA_LEN) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) === 1,
  };
}

export async function fetchBondingCurve(
  conn: Connection,
  mint: string,
): Promise<BondingCurveState | null> {
  const pda = bondingCurvePda(new PublicKey(mint));
  const info = await conn.getAccountInfo(pda, 'processed');
  if (!info) return null;
  return decodeBondingCurve(info.data);
}

/**
 * Spot price in SOL per whole token, derived from virtual reserves.
 *
 * Reserves are in base units: lamports for SOL (1e9) and 1e6 for pump.fun
 * tokens. Both scales have to be undone or the price is off by 1e3.
 */
export function curveSpotPrice(state: BondingCurveState, tokenDecimals = 6): number | null {
  if (state.virtualTokenReserves === 0n) return null;
  const sol = Number(state.virtualSolReserves) / 1e9;
  const tokens = Number(state.virtualTokenReserves) / 10 ** tokenDecimals;
  if (tokens <= 0) return null;
  return sol / tokens;
}
