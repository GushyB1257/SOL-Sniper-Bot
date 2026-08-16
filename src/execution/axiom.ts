import type { BuyResult, Executor, Position, SellResult, TokenCandidate } from '../types.js';

/**
 * Axiom adapter — intentionally unimplemented.
 *
 * Axiom.trade does not publish a trading API. Everything circulating as an
 * "Axiom API" is a reverse-engineered wrapper around the private endpoints
 * their web app calls, authenticated by replaying a browser session. Building
 * the bot on that would mean:
 *
 *   - Automating a platform whose terms do not permit it, with your funded
 *     account as the thing at risk.
 *   - Depending on undocumented endpoints that change without notice — and the
 *     failure mode for a sniper is not an error page, it is an open position
 *     that cannot be sold.
 *   - Handing a third party custody of the session that can move your money,
 *     for no execution advantage: Axiom routes to the same pump.fun, PumpSwap
 *     and Raydium pools `OnchainExecutor` already trades against directly.
 *
 * Trading on-chain yourself is strictly better here — lower latency, no
 * intermediary, no account to lose. This class exists so the seam is explicit:
 * if Axiom ever ships a real API, implement these five methods and set
 * `EXECUTOR=axiom`. Nothing else in the bot needs to change.
 */
export class AxiomExecutor implements Executor {
  readonly name = 'axiom';

  private notImplemented(): never {
    throw new Error(
      'EXECUTOR=axiom is not implemented: Axiom.trade has no public trading API. ' +
        'Use EXECUTOR=onchain, which routes to the same liquidity directly. ' +
        'See src/execution/axiom.ts for the rationale.',
    );
  }

  async buy(_candidate: TokenCandidate, _amountSol: number): Promise<BuyResult> {
    this.notImplemented();
  }

  async sell(_position: Position, _qty: number, _closeAll: boolean): Promise<SellResult> {
    this.notImplemented();
  }

  async price(_position: Position): Promise<number | null> {
    this.notImplemented();
  }

  async balance(_mint: string): Promise<number | null> {
    this.notImplemented();
  }
}
