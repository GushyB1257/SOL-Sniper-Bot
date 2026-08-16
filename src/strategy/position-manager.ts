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
import { buildLadder, decideExit, positionPnl } from './exit-planner.js';
import { pctChange } from '../util/solana.js';

const log = logger('positions');

/** Wait between retries after a failed sell, so failures don't spin the loop. */
const EXIT_RETRY_COOLDOWN_MS = 30_000;

/** Consecutive failed sells before a position is written off. */
const MAX_EXIT_FAILURES = 5;

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

      const price = await this.executor.price(p);
      if (price === null || !Number.isFinite(price) || price <= 0) {
        // No price is itself a signal: liquidity may have been pulled. Give it
        // a grace window, then treat a persistently unpriceable token as a rug.
        const staleMs = Date.now() - p.lastPriceAt;
        if (staleMs > 120_000) {
          p.notes.push(`no price for ${Math.round(staleMs / 1000)}s — treating as rugged`);
          await this.closeOut(p, 'rug_detected', 'price feed dead for over 2 minutes');
        }
        return;
      }

      p.lastPrice = price;
      p.lastPriceAt = Date.now();
      if (price > p.peakPrice) p.peakPrice = price;

      // Respect the post-failure backoff: keep pricing the position, but do
      // not re-attempt a sell that just failed.
      if (p.nextExitAttemptAt !== undefined && Date.now() < p.nextExitAttemptAt) {
        this.store.savePosition(p);
        return;
      }

      const order = decideExit({ position: p, price, cfg: this.cfg, now: Date.now() });
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

    const result = await this.executor.sell(p, order.qty, order.closeAll);

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

      // A failed sell on a stop loss is the dangerous case — it usually means
      // the token cannot be sold at all. Mark it so we stop counting it as
      // recoverable value and stop trusting this deployer.
      if (order.reason === 'stop_loss' || order.reason === 'rug_detected') {
        p.status = 'failed';
        p.closedAt = Date.now();
        p.closeReason = `${order.reason}: sell failed — ${result.error ?? 'unknown'}`;
        this.finalise(p, true);
        return;
      }

      // Otherwise back off and cap the attempts. Without this a persistently
      // failing sell retries at the tick rate forever, floods the log, and
      // holds a position slot that the risk manager will never release.
      p.exitFailures = (p.exitFailures ?? 0) + 1;
      p.nextExitAttemptAt = Date.now() + EXIT_RETRY_COOLDOWN_MS;

      if (p.exitFailures >= MAX_EXIT_FAILURES) {
        log.error(
          `${label}: ${p.exitFailures} consecutive failed sells — giving up and marking failed`,
        );
        p.status = 'failed';
        p.closedAt = Date.now();
        p.closeReason = `${order.reason}: ${p.exitFailures} failed sells — ${result.error ?? 'unknown'}`;
        this.finalise(p, true);
        return;
      }

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

    p.notes.push(
      `${order.reason}: sold ${result.soldQty.toFixed(0)} for ${result.receivedSol.toFixed(5)} SOL`,
    );

    // Reconcile against the chain — dust and rounding mean our arithmetic
    // drifts from the real balance, and selling a quantity we do not hold fails.
    const onchain = await this.executor.balance(p.mint);
    if (onchain !== null) p.remainingQty = onchain;

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

  /** Closes the books on a position: journal, PnL accounting, reputation. */
  private finalise(p: Position, failed: boolean): void {
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
      entryNote: p.notes.find((n) => n.startsWith('screen:') || n.startsWith('momentum:')),
    });

    this.risk.recordOutcome(pnlSol);

    // Feed the outcome back into deployer reputation. A total loss or an
    // unsellable position is what we call a rug for scoring purposes.
    const rugged = failed || pnlPct <= -80;
    this.store.recordCreatorOutcome(p.creator, rugged);

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
