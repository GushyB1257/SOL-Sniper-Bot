import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import type { BuyResult, Executor, Position, SellResult, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage, retry, withTimeout } from '../util/async.js';
import { lamportsToSol } from '../util/solana.js';
import { curveSpotPrice, fetchBondingCurve } from './bonding-curve.js';

const log = logger('exec:onchain');

/**
 * Non-custodial on-chain executor.
 *
 * Transaction *construction* is delegated to PumpPortal's `trade-local`
 * endpoint, which returns an unsigned serialized transaction. Signing and
 * broadcasting happen here, against your own RPC — the remote service never
 * sees the private key and cannot move funds. The trade-off is a dependency on
 * a third party for correct instruction encoding; if it returns a malformed or
 * malicious transaction the signature is still yours, so the pre-sign
 * validation below is not optional.
 */
export class OnchainExecutor implements Executor {
  readonly name = 'onchain';

  constructor(
    private readonly cfg: Config,
    private readonly conn: Connection,
    private readonly wallet: Keypair,
  ) {}

  async buy(candidate: TokenCandidate, amountSol: number): Promise<BuyResult> {
    const before = await this.balance(candidate.mint);
    const solBefore = await this.conn.getBalance(this.wallet.publicKey, 'confirmed');

    try {
      const sig = await this.trade({
        action: 'buy',
        mint: candidate.mint,
        amount: amountSol,
        denominatedInSol: 'true',
        slippage: this.cfg.BUY_SLIPPAGE_PCT,
        pool: candidate.pool === 'auto' ? 'auto' : candidate.pool,
      });

      // Settle against reality rather than trusting the quote: the fill is
      // whatever actually landed in the token account.
      const after = await this.confirmBalanceChange(candidate.mint, before ?? 0);
      const solAfter = await this.conn.getBalance(this.wallet.publicKey, 'confirmed');

      const receivedQty = after - (before ?? 0);
      const spentSol = lamportsToSol(solBefore - solAfter);

      if (receivedQty <= 0) {
        return {
          ok: false,
          signature: sig,
          spentSol,
          receivedQty: 0,
          price: 0,
          error: 'transaction landed but no tokens were received',
        };
      }

      return { ok: true, signature: sig, spentSol, receivedQty, price: spentSol / receivedQty };
    } catch (err) {
      return { ok: false, spentSol: 0, receivedQty: 0, price: 0, error: errMessage(err) };
    }
  }

  async sell(position: Position, qty: number, closeAll: boolean): Promise<SellResult> {
    const before = (await this.balance(position.mint)) ?? 0;
    if (before <= 0) {
      return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: 'no token balance' };
    }
    const solBefore = await this.conn.getBalance(this.wallet.publicKey, 'confirmed');
    const sellQty = closeAll ? before : Math.min(qty, before);

    try {
      const sig = await this.trade({
        action: 'sell',
        mint: position.mint,
        // A percentage string makes the program compute the exact amount, which
        // avoids dust left behind by decimal rounding on a full exit.
        amount: closeAll ? '100%' : sellQty,
        denominatedInSol: 'false',
        slippage: this.cfg.SELL_SLIPPAGE_PCT,
        pool: position.pool === 'auto' ? 'auto' : position.pool,
      });

      const after = (await this.balance(position.mint)) ?? 0;
      const solAfter = await this.conn.getBalance(this.wallet.publicKey, 'confirmed');

      const soldQty = Math.max(0, before - after);
      const receivedSol = lamportsToSol(solAfter - solBefore);

      if (soldQty <= 0) {
        return {
          ok: false,
          signature: sig,
          soldQty: 0,
          receivedSol: 0,
          price: 0,
          error: 'sell landed but balance did not change — token may be a honeypot',
        };
      }

      return { ok: true, signature: sig, soldQty, receivedSol, price: receivedSol / soldQty };
    } catch (err) {
      return { ok: false, soldQty: 0, receivedSol: 0, price: 0, error: errMessage(err) };
    }
  }

  /** Builds, validates, signs and sends one trade. */
  private async trade(params: {
    action: 'buy' | 'sell';
    mint: string;
    amount: number | string;
    denominatedInSol: 'true' | 'false';
    slippage: number;
    pool: string;
  }): Promise<string> {
    const res = await withTimeout(
      fetch(this.cfg.PUMPPORTAL_TRADE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.wallet.publicKey.toBase58(),
          action: params.action,
          mint: params.mint,
          amount: params.amount,
          denominatedInSol: params.denominatedInSol,
          slippage: params.slippage,
          priorityFee: this.cfg.PRIORITY_FEE_SOL,
          pool: params.pool,
        }),
      }),
      5000,
      'trade build',
    );

    if (!res.ok) {
      throw new Error(`trade build failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    const tx = VersionedTransaction.deserialize(buf);

    this.assertSafeToSign(tx, params.mint);

    // Rebuild against a fresh blockhash: a stale one from the build round-trip
    // is the single most common cause of a snipe silently never landing.
    const { blockhash, lastValidBlockHeight } =
      await this.conn.getLatestBlockhash('confirmed');
    tx.message.recentBlockhash = blockhash;
    tx.sign([this.wallet]);

    const sig = await retry(
      () =>
        this.conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true, // preflight costs ~200ms we do not have
          maxRetries: 0, // we drive our own retries
        }),
      { attempts: 3, baseMs: 150, label: 'sendRawTransaction' },
    );

    const confirmation = await this.conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    log.info(`${params.action} confirmed: ${sig}`);
    return sig;
  }

  /**
   * Last line of defence before we put a signature on someone else's bytes.
   *
   * We only ever intend to trade one specific mint through known programs. If
   * the returned transaction touches an unexpected program, the signature would
   * still authorise it — so anything unrecognised is refused rather than signed.
   */
  private assertSafeToSign(tx: VersionedTransaction, expectedMint: string): void {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());

    if (!keys.includes(this.wallet.publicKey.toBase58())) {
      throw new Error('built transaction does not involve our wallet');
    }
    if (!keys.includes(expectedMint)) {
      throw new Error(`built transaction does not reference the expected mint ${expectedMint}`);
    }
    // Address-table lookups can hide accounts from static inspection; for a
    // simple swap there is no legitimate need for them.
    if (tx.message.addressTableLookups.length > 0) {
      throw new Error('built transaction uses address lookup tables — refusing to sign blind');
    }

    const programIds = new Set(
      tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex] ?? '<unknown>'),
    );
    for (const pid of programIds) {
      if (!ALLOWED_PROGRAMS.has(pid)) {
        throw new Error(`built transaction invokes unexpected program ${pid} — refusing to sign`);
      }
    }
  }

  /**
   * Polls until the token balance reflects the fill. RPC reads can lag the
   * confirmation, and reading zero too early would mis-record the position size.
   */
  private async confirmBalanceChange(mint: string, before: number): Promise<number> {
    for (let i = 0; i < 8; i++) {
      const now = (await this.balance(mint)) ?? 0;
      if (now > before) return now;
      await new Promise((r) => setTimeout(r, 250));
    }
    return (await this.balance(mint)) ?? before;
  }

  async price(position: Position): Promise<number | null> {
    try {
      const curve = await fetchBondingCurve(this.conn, position.mint);
      if (curve && !curve.complete) return curveSpotPrice(curve);
      // Graduated to an AMM: curve reserves are frozen and no longer price it.
      return await this.ammPrice(position.mint);
    } catch (err) {
      log.debug(`price lookup failed for ${position.mint}: ${errMessage(err)}`);
      return null;
    }
  }

  /** Price via a Jupiter quote, used once a token has left the bonding curve. */
  private async ammPrice(mint: string): Promise<number | null> {
    try {
      // Quote selling a nominal amount to get an executable price rather than
      // a mid-price that no one will actually fill.
      const url =
        `https://quote-api.jup.ag/v6/quote?inputMint=${mint}` +
        `&outputMint=So11111111111111111111111111111111111111112` +
        `&amount=1000000&slippageBps=${Math.round(this.cfg.SELL_SLIPPAGE_PCT * 100)}`;
      const res = await withTimeout(fetch(url), 3000, 'jupiter quote');
      if (!res.ok) return null;
      const quote = (await res.json()) as { outAmount?: string };
      if (!quote.outAmount) return null;
      // 1e6 base units in, lamports out.
      return Number(quote.outAmount) / 1e9;
    } catch {
      return null;
    }
  }

  async balance(mint: string): Promise<number | null> {
    try {
      const accounts = await this.conn.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(mint) },
        'processed',
      );
      let total = 0;
      for (const { account } of accounts.value) {
        const parsed = account.data.parsed as {
          info?: { tokenAmount?: { uiAmount?: number | null } };
        };
        total += parsed.info?.tokenAmount?.uiAmount ?? 0;
      }
      return total;
    } catch (err) {
      log.debug(`balance lookup failed for ${mint}: ${errMessage(err)}`);
      return null;
    }
  }
}

/** Programs a legitimate pump.fun / PumpSwap / Raydium swap may invoke. */
const ALLOWED_PROGRAMS = new Set([
  '11111111111111111111111111111111', // System
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
]);
