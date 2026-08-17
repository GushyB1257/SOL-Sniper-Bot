import type { BuyResult, Executor, Position, SellResult, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import { reservesOf, solOut, tokensOut, type PriceSource } from './pricing.js';

const log = logger('exec:paper');

/**
 * Paper executor — a forward test, not a simulation.
 *
 * Everything except the transaction is real: real launches off the live feed,
 * real safety checks against real chain state, and **real prices** read from the
 * token's own bonding curve on every tick. Fills are computed with the same
 * constant-product maths the pump.fun program runs, against the reserves that
 * actually existed at that moment. So if a token you "bought" rugs, your paper
 * position rugs with it.
 *
 * What it still cannot tell you — and these all bias results OPTIMISTIC:
 *
 *  1. **Whether your buy would have landed.** The real race is won on latency
 *     and priority fees. Paper mode assumes you got the price you saw.
 *  2. **Whether anyone would have bought your exit.** Sells are priced off the
 *     curve, which always quotes. In a real rug the bid vanishes and a stop
 *     loss fills far worse than modelled, or not at all.
 *  3. **Your own market impact.** Your buy would have nudged the curve and
 *     every later fill; here it does not.
 *
 * Treat a paper profit factor as a ceiling. If it is below 1.0 here, live will
 * be worse — that result is decisive and worth acting on.
 */
export class PaperExecutor implements Executor {
  readonly name = 'paper';

  private balances = new Map<string, number>();
  /**
   * Net SOL moved by simulated trades, rather than an absolute balance.
   *
   * Holding the drift instead of the total is what lets the starting balance be
   * edited while the bot is running. `RuntimeSettings` writes accepted changes
   * onto the live config object every component already holds a reference to, so
   * a new `PAPER_STARTING_BALANCE_SOL` shows up on the next read of
   * `simulatedWalletSol` and moves the balance by exactly the delta — the run's
   * own P&L is preserved, because it lives in this number and not in the total.
   */
  private driftSol = 0;

  constructor(
    private readonly cfg: Config,
    private readonly prices: PriceSource,
  ) {}

  async buy(candidate: TokenCandidate, amountSol: number): Promise<BuyResult> {
    try {
      const curve = await this.prices.curve(candidate.mint);
      if (!curve) {
        return {
          ok: false,
          spentSol: 0,
          receivedQty: 0,
          price: 0,
          error: 'no bonding curve on chain — could not have priced this buy',
        };
      }
      if (curve.complete) {
        return {
          ok: false,
          spentSol: 0,
          receivedQty: 0,
          price: 0,
          error: 'curve already graduated — not a fresh launch',
        };
      }

      const received = tokensOut(reservesOf(curve), amountSol);
      if (received <= 0) {
        return { ok: false, spentSol: 0, receivedQty: 0, price: 0, error: 'curve returned no tokens' };
      }

      // pump.fun takes 1%; the priority fee is what you would really have paid
      // to compete for the slot.
      const fee = amountSol * 0.01 + this.cfg.PRIORITY_FEE_SOL;
      const spent = amountSol + fee;

      this.balances.set(candidate.mint, (this.balances.get(candidate.mint) ?? 0) + received);
      this.driftSol -= spent;

      const price = amountSol / received;
      log.info(
        `PAPER BUY ${candidate.symbol ?? candidate.mint.slice(0, 8)} ` +
          `${amountSol} SOL -> ${received.toFixed(0)} tokens @ ${price.toExponential(3)}`,
      );

      return {
        ok: true,
        signature: `paper-buy-${candidate.mint.slice(0, 8)}-${Date.now()}`,
        spentSol: spent,
        receivedQty: received,
        price,
      };
    } catch (err) {
      return { ok: false, spentSol: 0, receivedQty: 0, price: 0, error: errMessage(err) };
    }
  }

  async sell(position: Position, qty: number, closeAll: boolean): Promise<SellResult> {
    const held = this.balances.get(position.mint) ?? 0;

    // `closeAll` means "exit THIS POSITION", never "sell every token of this
    // mint the wallet holds". The three bots run against one wallet and one
    // balance per mint, so they routinely end up holding the same token at the
    // same time — and selling the pooled balance to close one position empties
    // the others, which then fail with "no balance to sell" and get booked at
    // -100% despite the token being perfectly tradeable.
    const want = closeAll ? position.remainingQty : Math.min(qty, position.remainingQty);
    const sellQty = Math.min(want, held);
    if (sellQty <= 0) {
      return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: 'no balance to sell' };
    }

    try {
      const curve = await this.prices.curve(position.mint);
      let gross: number;

      if (curve && !curve.complete) {
        // Price the exit against live reserves, including our own impact — a
        // large sell into a thin curve gets a materially worse average price.
        gross = solOut(reservesOf(curve), sellQty);
      } else {
        // Graduated (or unreadable): fall back to spot on the AMM. No impact
        // modelling here, so this branch is the optimistic one.
        const spot = await this.prices.price(position.mint);
        if (spot === null) {
          return {
            ok: false,
            soldQty: 0,
            receivedSol: 0,
            price: 0,
            error: 'no price available — in live trading this is where you are stuck holding',
          };
        }
        gross = spot * sellQty;
      }

      if (gross <= 0) {
        return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: 'curve returned no SOL' };
      }

      const fee = gross * 0.01 + this.cfg.PRIORITY_FEE_SOL;
      const net = Math.max(0, gross - fee);

      this.balances.set(position.mint, held - sellQty);
      this.driftSol += net;

      const price = gross / sellQty;
      log.info(
        `PAPER SELL ${position.symbol ?? position.mint.slice(0, 8)} ` +
          `${sellQty.toFixed(0)} tokens -> ${net.toFixed(5)} SOL @ ${price.toExponential(3)}`,
      );

      return {
        ok: true,
        signature: `paper-sell-${position.mint.slice(0, 8)}-${Date.now()}`,
        soldQty: sellQty,
        receivedSol: net,
        price,
      };
    } catch (err) {
      return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: errMessage(err) };
    }
  }

  /** Live price of the real token. This is what makes the test meaningful. */
  async price(position: Position): Promise<number | null> {
    return this.prices.price(position.mint);
  }

  async balance(mint: string): Promise<number | null> {
    return this.balances.get(mint) ?? 0;
  }

  /**
   * Restores a holding for a position resumed from disk.
   *
   * Paper balances live in memory, but positions are persisted — so after a
   * restart the store believes we hold tokens the executor has never heard of,
   * and every sell fails with "no balance". The position record is the truth
   * about what a paper run holds, so it seeds the executor on startup.
   */
  seedBalance(mint: string, qty: number): void {
    if (qty > 0) this.balances.set(mint, qty);
  }

  /**
   * The paper wallet right now: the configured starting balance plus whatever
   * the simulated trades have done to it.
   *
   * In-memory by design. A paper run starts from the configured balance every
   * time the process boots — the trade journal on disk is the record worth
   * keeping, not a pretend wallet total.
   */
  get simulatedWalletSol(): number {
    return this.cfg.PAPER_STARTING_BALANCE_SOL + this.driftSol;
  }

  /** What the simulated trades have done to the balance, ignoring the setting. */
  get simulatedPnlSol(): number {
    return this.driftSol;
  }
}
