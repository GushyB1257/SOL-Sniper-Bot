import type { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage, withTimeout } from '../util/async.js';
import { curveSpotPrice, fetchBondingCurve, type BondingCurveState } from './bonding-curve.js';

const log = logger('pricing');

/** pump.fun mints are always 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;

/**
 * Where price comes from. Extracted behind an interface so the paper executor
 * can be driven by real chain state in production and by a stub in tests.
 */
export interface PriceSource {
  /** Current SOL-per-token price, or null if it cannot be determined. */
  price(mint: string): Promise<number | null>;
  /** Live bonding-curve reserves, or null once graduated / not a pump token. */
  curve(mint: string): Promise<BondingCurveState | null>;
}

/**
 * Reads live prices off the chain.
 *
 * While a token is on the bonding curve its price is a pure function of the
 * curve's reserves, so one account read gives an exact price with no oracle and
 * no third party. After it graduates the reserves freeze and we fall back to a
 * Jupiter quote for the AMM pool.
 */
export class ChainPriceSource implements PriceSource {
  /**
   * Very short TTL. The tick loop and the dashboard both ask for the same
   * mints within milliseconds of each other; without this that is two RPC
   * reads per position per second for no extra information.
   */
  private cache = new Map<string, { at: number; curve: BondingCurveState | null }>();
  private static readonly TTL_MS = 500;

  constructor(
    private readonly conn: Connection,
    private readonly cfg: Config,
  ) {}

  async curve(mint: string): Promise<BondingCurveState | null> {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < ChainPriceSource.TTL_MS) return hit.curve;

    const curve = await fetchBondingCurve(this.conn, mint);
    this.cache.set(mint, { at: Date.now(), curve });
    if (this.cache.size > 500) {
      // Bounded: drop everything older than the TTL rather than tracking LRU.
      const cutoff = Date.now() - ChainPriceSource.TTL_MS;
      for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
    }
    return curve;
  }

  async price(mint: string): Promise<number | null> {
    try {
      const curve = await this.curve(mint);
      if (curve && !curve.complete) return curveSpotPrice(curve, PUMP_TOKEN_DECIMALS);
      return await this.ammPrice(mint);
    } catch (err) {
      log.debug(`price lookup failed for ${mint}: ${errMessage(err)}`);
      return null;
    }
  }

  /** Executable price from a Jupiter quote, once the token has left the curve. */
  private async ammPrice(mint: string): Promise<number | null> {
    try {
      // Quote a nominal sell rather than reading a mid-price, so the number
      // reflects what someone would actually pay us.
      const url =
        `https://quote-api.jup.ag/v6/quote?inputMint=${mint}` +
        `&outputMint=So11111111111111111111111111111111111111112` +
        `&amount=1000000&slippageBps=${Math.round(this.cfg.SELL_SLIPPAGE_PCT * 100)}`;
      const res = await withTimeout(fetch(url), 3000, 'jupiter quote');
      if (!res.ok) return null;
      const quote = (await res.json()) as { outAmount?: string };
      if (!quote.outAmount) return null;
      // 1e6 token base units in, lamports out.
      return Number(quote.outAmount) / 1e9;
    } catch {
      return null;
    }
  }
}

/** Curve reserves in whole SOL / whole tokens. */
export interface Reserves {
  vSol: number;
  vTokens: number;
}

export function reservesOf(curve: BondingCurveState): Reserves {
  return {
    vSol: Number(curve.virtualSolReserves) / 1e9,
    vTokens: Number(curve.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS,
  };
}

/**
 * Constant-product fill: tokens received for `amountSol` against these reserves.
 * This is the same maths the pump.fun program runs, so a simulated fill against
 * live reserves matches what the real swap would have returned.
 */
export function tokensOut(r: Reserves, amountSol: number): number {
  if (amountSol <= 0 || r.vSol <= 0 || r.vTokens <= 0) return 0;
  const k = r.vSol * r.vTokens;
  return r.vTokens - k / (r.vSol + amountSol);
}

/** Constant-product fill: SOL received for selling `qty` tokens. */
export function solOut(r: Reserves, qty: number): number {
  if (qty <= 0 || r.vSol <= 0 || r.vTokens <= 0) return 0;
  const k = r.vSol * r.vTokens;
  return r.vSol - k / (r.vTokens + qty);
}
