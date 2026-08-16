import type { BuyResult, Executor, Position, SellResult, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('exec:paper');

/** pump.fun constant-product curve defaults (virtual reserves at launch). */
const DEFAULT_VIRTUAL_SOL = 30;
const DEFAULT_VIRTUAL_TOKENS = 1_073_000_000;

interface SimCurve {
  vSol: number;
  vTokens: number;
}

/**
 * Paper executor: full strategy loop, zero transactions.
 *
 * Fills are simulated against the same constant-product curve pump.fun uses, so
 * slippage and price impact behave the way they would live. What it cannot
 * simulate is the part that actually decides whether sniping is profitable:
 * whether your transaction lands before everyone else's, and whether there is
 * a bid on the other side when you try to sell. Treat paper results as an upper
 * bound on live performance, and a generous one.
 */
export class PaperExecutor implements Executor {
  readonly name = 'paper';

  private curves = new Map<string, SimCurve>();
  private balances = new Map<string, number>();
  private walletSol: number;

  constructor(
    private readonly cfg: Config,
    startingBalanceSol = 10,
  ) {
    this.walletSol = startingBalanceSol;
  }

  private curveFor(mint: string, candidate?: TokenCandidate): SimCurve {
    let curve = this.curves.get(mint);
    if (!curve) {
      curve = {
        vSol: candidate?.vSolInBondingCurve ?? DEFAULT_VIRTUAL_SOL,
        vTokens: candidate?.vTokensInBondingCurve ?? DEFAULT_VIRTUAL_TOKENS,
      };
      this.curves.set(mint, curve);
    }
    return curve;
  }

  async buy(candidate: TokenCandidate, amountSol: number): Promise<BuyResult> {
    const curve = this.curveFor(candidate.mint, candidate);

    // x*y=k: spending `amountSol` moves the curve and yields fewer tokens than
    // the spot price implies. That gap is the price impact.
    const k = curve.vSol * curve.vTokens;
    const newVSol = curve.vSol + amountSol;
    const newVTokens = k / newVSol;
    const received = curve.vTokens - newVTokens;

    const fee = amountSol * 0.01 + this.cfg.PRIORITY_FEE_SOL;
    const spent = amountSol + fee;

    if (received <= 0) {
      return { ok: false, spentSol: 0, receivedQty: 0, price: 0, error: 'curve produced no tokens' };
    }

    curve.vSol = newVSol;
    curve.vTokens = newVTokens;
    this.balances.set(candidate.mint, (this.balances.get(candidate.mint) ?? 0) + received);
    this.walletSol -= spent;

    const price = amountSol / received;
    log.info(
      `SIM BUY ${candidate.symbol ?? candidate.mint.slice(0, 8)} ` +
        `${amountSol} SOL -> ${received.toFixed(0)} tokens @ ${price.toExponential(3)}`,
    );

    return {
      ok: true,
      signature: `paper-buy-${candidate.mint.slice(0, 8)}-${Date.now()}`,
      spentSol: spent,
      receivedQty: received,
      price,
    };
  }

  async sell(position: Position, qty: number, closeAll: boolean): Promise<SellResult> {
    const held = this.balances.get(position.mint) ?? 0;
    const sellQty = closeAll ? held : Math.min(qty, held);
    if (sellQty <= 0) {
      return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: 'no balance to sell' };
    }

    const curve = this.curveFor(position.mint);
    const k = curve.vSol * curve.vTokens;
    const newVTokens = curve.vTokens + sellQty;
    const newVSol = k / newVTokens;
    const grossSol = curve.vSol - newVSol;

    const fee = grossSol * 0.01 + this.cfg.PRIORITY_FEE_SOL;
    const net = Math.max(0, grossSol - fee);

    curve.vSol = newVSol;
    curve.vTokens = newVTokens;
    this.balances.set(position.mint, held - sellQty);
    this.walletSol += net;

    const price = grossSol / sellQty;
    log.info(
      `SIM SELL ${position.symbol ?? position.mint.slice(0, 8)} ` +
        `${sellQty.toFixed(0)} tokens -> ${net.toFixed(5)} SOL @ ${price.toExponential(3)}`,
    );

    return {
      ok: true,
      signature: `paper-sell-${position.mint.slice(0, 8)}-${Date.now()}`,
      soldQty: sellQty,
      receivedSol: net,
      price,
    };
  }

  async price(position: Position): Promise<number | null> {
    const curve = this.curves.get(position.mint);
    if (!curve) return null;
    // Spot price on the curve, before impact.
    return curve.vSol / curve.vTokens;
  }

  async balance(mint: string): Promise<number | null> {
    return this.balances.get(mint) ?? 0;
  }

  /**
   * Drives simulated price action so the exit ladder actually gets exercised.
   * Real launches are bimodal: most bleed out, a few run hard. A random walk
   * with a fat right tail reproduces that shape well enough to smoke-test the
   * strategy — it is not a backtest and must not be read as one.
   */
  tickSimulation(): void {
    for (const [mint, curve] of this.curves) {
      if ((this.balances.get(mint) ?? 0) <= 0) continue;
      // Mostly downward drift, occasional sharp pump.
      const roll = Math.random();
      const move = roll > 0.94 ? 1 + Math.random() * 0.5 : 1 - Math.random() * 0.08;
      curve.vSol = Math.max(1, curve.vSol * move);
    }
  }

  get simulatedWalletSol(): number {
    return this.walletSol;
  }
}
