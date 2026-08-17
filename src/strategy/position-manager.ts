import { randomUUID } from 'node:crypto';
import type {
  BuyResult,
  Executor,
  ExitOrder,
  Position,
  TokenCandidate,
} from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { RiskManager } from '../risk/risk-manager.js';
import { logger } from '../logger.js';
import { KeyedMutex, errMessage } from '../util/async.js';
import { withRpcPriority } from '../util/rpc-throttle.js';
import { buildLadder, checkpointElapsed, decideExit, positionPnl } from './exit-planner.js';
import { pctChange } from '../util/solana.js';

const log = logger('positions');


/**
 * Owns the lifecycle of every open position: entry bookkeeping, the monitoring
 * tick, exit execution and the trade journal.
 */
export class PositionManager {
  /** One in-flight action per position; a tick must never race an exit. */
  private readonly locks = new KeyedMutex();
  private ticking = false;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly executor: Executor,
    private readonly risk: RiskManager,
  ) {}

  /** Records a filled entry and starts tracking it. */
  open(candidate: TokenCandidate, fill: BuyResult, safetyScore: number): Position {
    const now = Date.now();
    const position: Position = {
      id: randomUUID(),
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      creator: candidate.creator,
      pool: candidate.pool,
      status: 'open',
      costSol: fill.spentSol,
      originalQty: fill.receivedQty,
      remainingQty: fill.receivedQty,
      entryPrice: fill.price,
      entryTx: fill.signature,
      openedAt: now,
      peakPrice: fill.price,
      lastPrice: fill.price,
      lastPriceAt: now,
      ladder: buildLadder(this.cfg),
      moonbagArmed: false,
      realizedSol: 0,
      checkpointAt: now,
      checkpointPrice: fill.price,
      costRecovered: false,
      safetyScore,
      notes: [`entry ${fill.spentSol.toFixed(5)} SOL @ ${fill.price.toExponential(3)}`],
    };

    this.store.savePosition(position);
    this.store.recordSpend(fill.spentSol);
    log.info(
      `OPEN ${position.symbol ?? position.mint.slice(0, 8)} ` +
        `${fill.spentSol.toFixed(4)} SOL, safety ${safetyScore}/100, tx ${fill.signature ?? 'n/a'}`,
    );
    return position;
  }

  /**
   * One monitoring pass over every open position. Positions are processed in
   * parallel — a stuck RPC read on one must not delay the stop loss on another.
   */
  async tick(): Promise<void> {
    if (this.ticking) return; // skip overlapping ticks rather than queueing them
    this.ticking = true;
    try {
      const open = this.store.openPositions();
      await Promise.all(open.map((p) => this.tickPosition(p.id)));
    } finally {
      this.ticking = false;
    }
  }

  private tickPosition(positionId: string): Promise<void> {
    return this.locks.run(positionId, async () => {
      const p = this.store.getPosition(positionId);
      if (!p || p.status !== 'open') return;

      // The backoff is checked FIRST, before pricing. It used to sit after the
      // price read, which meant an unpriceable position skipped it entirely and
      // burned all its sell attempts at tick rate — twelve retries in eighteen
      // seconds instead of over three minutes.
      const inBackoff = p.nextExitAttemptAt !== undefined && Date.now() < p.nextExitAttemptAt;

      const price = await this.executor.price(p);
      if (price === null || !Number.isFinite(price) || price <= 0) {
        // Being unable to READ a price is a data problem, not a market one.
        // This used to write the position off as a rug after two minutes, then
        // fail the sell (no price to sell at) and book -100% — on tokens that
        // were perfectly tradeable and that the wallet we were copying sold
        // just fine. Wait far longer, say what is actually happening, and when
        // giving up call it what it is.
        const staleSeconds = (Date.now() - p.lastPriceAt) / 1000;
        if (inBackoff) return;
        if (staleSeconds > this.cfg.PRICE_STALE_SECONDS) {
          p.notes.push(`no readable price for ${Math.round(staleSeconds)}s`);
          await this.closeOut(
            p,
            'unpriceable',
            `no price could be read for ${Math.round(staleSeconds)}s ` +
              `(limit ${this.cfg.PRICE_STALE_SECONDS}s)`,
          );
        } else if (staleSeconds > 30) {
          log.warn(
            `${p.symbol ?? p.mint.slice(0, 8)}: no price for ${Math.round(staleSeconds)}s — ` +
              `still holding, giving up at ${this.cfg.PRICE_STALE_SECONDS}s`,
          );
        }
        return;
      }

      p.lastPrice = price;
      p.lastPriceAt = Date.now();
      if (price > p.peakPrice) p.peakPrice = price;

      // A readable price is worth recording even while backing off, so the
      // position's mark-to-market keeps updating between sell attempts.
      if (inBackoff) {
        this.store.savePosition(p);
        return;
      }

      const now = Date.now();
      const order = decideExit({ position: p, price, cfg: this.cfg, now });

      // The ratchet's window advances AFTER the decision, so the planner always
      // judges the window that just closed. Doing it before would compare the
      // price against itself and nothing would ever stall out.
      const advance = this.cfg.EXIT_MODE === 'ratchet' && checkpointElapsed(p, this.cfg, now);
      if (advance) {
        p.checkpointAt = now;
        p.checkpointPrice = price;
      }

      if (!order) {
        this.store.savePosition(p);
        return;
      }

      await this.executeExit(p, order);
    });
  }

  private async executeExit(p: Position, order: ExitOrder): Promise<void> {
    const label = p.symbol ?? p.mint.slice(0, 8);
    log.info(`EXIT ${label} [${order.reason}] ${order.detail}`);

    // The sell goes to the front of the RPC queue. A sell delayed behind a
    // hundred background curve reads is a worse price, and on a token that is
    // falling it is a materially worse one; a curve read delayed behind a sell
    // costs nothing. Everything the sell does underneath — the balance reads,
    // the blockhash, the send, the confirmation — inherits the flag.
    const result = await withRpcPriority(() => this.executor.sell(p, order.qty, order.closeAll));

    if (!result.ok) {
      p.notes.push(`sell failed (${order.reason}): ${result.error ?? 'unknown'}`);
      log.warn(`Sell failed for ${label}: ${result.error ?? 'unknown'}`);

      // Reconcile before deciding what the failure means. If the executor says
      // we hold nothing, our accounting is stale — the tokens are gone (sold
      // elsewhere, or a paper run restarted with an in-memory balance we no
      // longer have). Retrying can never succeed, so book it closed instead of
      // spinning on it every tick.
      const held = await this.executor.balance(p.mint);
      if (held !== null && held <= 0) {
        log.warn(`${label}: executor holds 0 tokens — closing stale position`);
        p.remainingQty = 0;
        p.status = 'closed';
        p.closedAt = Date.now();
        p.closeReason = `${order.reason}: position no longer held (${result.error ?? 'unknown'})`;
        this.finalise(p, false);
        return;
      }

      // EVERY reason retries, including stop_loss and rug_detected. Those two
      // used to be written off on the first failure on the theory that a failed
      // stop means the token cannot be sold — but that is precisely the case
      // that deserves another attempt, and giving up immediately turns a
      // transient RPC error or rate limit into a fabricated total loss.
      p.exitFailures = (p.exitFailures ?? 0) + 1;
      p.nextExitAttemptAt = Date.now() + this.cfg.EXIT_RETRY_SECONDS * 1000;

      if (p.exitFailures >= this.cfg.EXIT_MAX_ATTEMPTS) {
        log.error(
          `${label}: gave up after ${p.exitFailures} sell attempts over ` +
            `${Math.round((p.exitFailures * this.cfg.EXIT_RETRY_SECONDS) / 60)} minutes — ${result.error ?? 'unknown'}`,
        );
        p.status = 'failed';
        p.closedAt = Date.now();
        p.closeReason = `${order.reason}: ${p.exitFailures} failed sells — ${result.error ?? 'unknown'}`;
        // Only blame the deployer when the token itself was the problem. A
        // pricing outage on our side says nothing about who launched it.
        this.finalise(p, true, order.reason !== 'unpriceable');
        return;
      }

      log.warn(
        `${label}: sell attempt ${p.exitFailures}/${this.cfg.EXIT_MAX_ATTEMPTS} failed, ` +
          `retrying in ${this.cfg.EXIT_RETRY_SECONDS}s`,
      );
      this.store.savePosition(p);
      return;
    }

    // A sell that worked clears the backoff.
    p.exitFailures = 0;
    p.nextExitAttemptAt = undefined;

    p.remainingQty = Math.max(0, p.remainingQty - result.soldQty);
    p.realizedSol += result.receivedSol;

    for (const idx of order.tierIndexes) {
      const tier = p.ladder[idx];
      if (!tier) continue;
      tier.filled = true;
      tier.filledAt = Date.now();
      tier.filledPrice = result.price;
    }
    if (p.ladder.every((t) => t.filled) && p.remainingQty > 0) {
      if (!p.moonbagArmed) {
        p.moonbagArmed = true;
        log.info(
          `MOONBAG ${label}: ladder complete, holding ${p.remainingQty.toFixed(0)} tokens ` +
            `with a ${this.cfg.MOONBAG_TRAILING_STOP_PCT}% trailing stop`,
        );
      }
    }

    // The stake is back. From here the position cannot lose money, so the
    // ratchet stops asking whether it is profitable and only asks whether it is
    // still going up. The window restarts so the moonbag gets a clean run
    // rather than being judged against a price from before the sell.
    if (order.reason === 'cost_recovery' && p.remainingQty > 0) {
      p.costRecovered = true;
      p.moonbagArmed = true;
      p.checkpointAt = Date.now();
      p.checkpointPrice = result.price;
      log.info(
        `DE-RISKED ${label}: ${p.realizedSol.toFixed(5)} SOL banked against a ` +
          `${p.costSol.toFixed(5)} SOL stake — ${p.remainingQty.toFixed(0)} tokens now ride free`,
      );
    }

    p.notes.push(
      `${order.reason}: sold ${result.soldQty.toFixed(0)} for ${result.receivedSol.toFixed(5)} SOL`,
    );

    // Reconcile against the chain — dust and rounding mean our arithmetic
    // drifts from the real balance, and selling a quantity we do not hold fails.
    //
    // With one exception. A partial sell that comes back reading ZERO while our
    // own arithmetic says a real remainder is still there is not believable: an
    // RPC that has not caught up, or a read that missed the token account,
    // looks exactly like this. Trusting it books the position closed on partial
    // proceeds against the FULL cost, which is how a trade that was only
    // trimmed shows up in the journal as a loss. Keep our own number and let
    // the next tick reconcile once the chain agrees.
    //
    // And it only ever reconciles DOWNWARD. The balance is per mint across the
    // whole wallet, so when two bots hold the same token it is larger than this
    // position's share — adopting it would have one position claim the other's
    // tokens and try to sell them.
    const onchain = await this.executor.balance(p.mint);
    const expected = p.remainingQty;
    const dust = p.originalQty * 0.01;
    if (onchain !== null && !(onchain <= 0 && !order.closeAll && expected > dust)) {
      p.remainingQty = Math.min(p.remainingQty, onchain);
    } else if (onchain !== null && onchain <= 0) {
      log.warn(
        `${label}: balance read says 0 after a partial sell but ${expected.toFixed(0)} tokens ` +
          'should remain — keeping our own count and re-checking next tick',
      );
    }

    const closed = order.closeAll || p.remainingQty <= 0;
    if (closed) {
      p.status = 'closed';
      p.closedAt = Date.now();
      p.closeReason = `${order.reason}: ${order.detail}`;
      this.finalise(p, false);
    } else {
      this.store.savePosition(p);
      const pnl = positionPnl(p, result.price);
      log.info(
        `  ${label} now ${p.remainingQty.toFixed(0)} tokens left, ` +
          `realised ${p.realizedSol.toFixed(5)} SOL, PnL ${pnl.sol >= 0 ? '+' : ''}${pnl.sol.toFixed(5)} SOL`,
      );
    }
  }

  /**
   * Exit entry point for callers OUTSIDE the tick loop — the AI reviewer, the
   * dashboard. Takes the per-position lock, so an externally-driven sell can
   * never interleave with a stop loss firing on the same position and sell the
   * same tokens twice.
   *
   * `closeOut` deliberately does not lock: its callers already hold it, and the
   * mutex is not reentrant.
   *
   * Pass `qty` to trim; omit it to close the whole position.
   */
  async externalExit(
    p: Position,
    reason: ExitOrder['reason'],
    detail: string,
    qty?: number,
  ): Promise<void> {
    await this.locks.run(p.id, async () => {
      // Re-read under the lock: the position may have closed while we waited.
      const current = this.store.getPosition(p.id);
      if (!current || current.status !== 'open') return;

      const closeAll = qty === undefined;
      const sellQty = closeAll ? current.remainingQty : Math.min(qty, current.remainingQty);
      if (sellQty <= 0) return;

      await this.executeExit(current, {
        mint: current.mint,
        positionId: current.id,
        qty: sellQty,
        reason,
        closeAll,
        tierIndexes: [],
        detail,
      });
    });
  }

  /** Force-sells everything, e.g. on shutdown or a detected rug. */
  async closeOut(p: Position, reason: ExitOrder['reason'], detail: string): Promise<void> {
    await this.executeExit(p, {
      mint: p.mint,
      positionId: p.id,
      qty: p.remainingQty,
      reason,
      closeAll: true,
      tierIndexes: [],
      detail,
    });
  }

  /**
   * Closes the books on a position: journal, PnL accounting, reputation.
   *
   * `blameCreator` exists because a -100% result is not always the token's
   * fault. When we simply could not read a price, the loss is booked (the
   * capital really is unrecoverable to us) but the deployer's record is left
   * alone — otherwise our own outage teaches the safety engine to distrust
   * honest launches.
   */
  private finalise(p: Position, failed: boolean, blameCreator = true): void {
    const pnlSol = p.realizedSol - p.costSol;
    const pnlPct = p.costSol > 0 ? (pnlSol / p.costSol) * 100 : 0;
    const holdSeconds = ((p.closedAt ?? Date.now()) - p.openedAt) / 1000;

    this.store.savePosition(p);
    this.store.appendJournal({
      positionId: p.id,
      mint: p.mint,
      symbol: p.symbol,
      creator: p.creator,
      openedAt: p.openedAt,
      closedAt: p.closedAt ?? Date.now(),
      costSol: p.costSol,
      proceedsSol: p.realizedSol,
      pnlSol,
      pnlPct,
      closeReason: p.closeReason ?? 'unknown',
      safetyScore: p.safetyScore,
      holdSeconds,
      entryNote: p.notes.find(
        (n) => n.startsWith('screen:') || n.startsWith('momentum:') || n.startsWith('snipe:'),
      ),
      copiedFrom: p.copiedFrom,
    });

    this.risk.recordOutcome(pnlSol);

    // Feed the outcome back into deployer reputation. A total loss or an
    // unsellable position is what we call a rug for scoring purposes.
    if (blameCreator) {
      const rugged = failed || pnlPct <= -80;
      this.store.recordCreatorOutcome(p.creator, rugged);
    }

    const sign = pnlSol >= 0 ? '+' : '';
    log.info(
      `CLOSED ${p.symbol ?? p.mint.slice(0, 8)} ${sign}${pnlSol.toFixed(5)} SOL ` +
        `(${sign}${pnlPct.toFixed(1)}%) after ${Math.round(holdSeconds)}s — ${p.closeReason}`,
    );
    this.store.flush();
  }

  /** Sells every open position. Used on SIGINT so nothing is left unattended. */
  async closeAll(reason: ExitOrder['reason'] = 'shutdown'): Promise<void> {
    const open = this.store.openPositions();
    if (open.length === 0) return;
    log.warn(`Closing ${open.length} open position(s): ${reason}`);
    for (const p of open) {
      try {
        await this.closeOut(p, reason, 'bot shutting down');
      } catch (err) {
        log.error(`Failed to close ${p.mint}: ${errMessage(err)}`);
      }
    }
    this.store.flush();
  }

  summary(): string {
    const journal = this.store.journal();
    if (journal.length === 0) return 'no closed trades yet';
    const wins = journal.filter((j) => j.pnlSol > 0).length;
    const total = journal.reduce((a, j) => a + j.pnlSol, 0);
    const winRate = (wins / journal.length) * 100;
    return (
      `${journal.length} trades, ${wins} winners (${winRate.toFixed(0)}%), ` +
      `net ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`
    );
  }
}

export { pctChange };
