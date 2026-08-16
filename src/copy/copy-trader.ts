import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { PositionManager } from '../strategy/position-manager.js';
import type { Executor, Pool, TokenCandidate } from '../types.js';
import type { PriceSource } from '../execution/pricing.js';
import { curveSpotPrice } from '../execution/bonding-curve.js';
import { marketCapFromState } from '../watchlist/curve-poller.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';
import type { WalletTrade } from './wallet-watcher.js';

const log = logger('copy');

export interface CopyStats {
  seen: number;
  bought: number;
  sold: number;
  /** Rejections keyed by the filter responsible, same shape as the screener. */
  skips: Record<string, number>;
  lastSkipReason?: string;
}

export interface CopyDeps {
  cfg: Config;
  store: Store;
  executor: Executor;
  risk: RiskManager;
  positions: PositionManager;
  prices: PriceSource;
  walletBalance: () => Promise<number>;
  solUsd: () => number;
}

/**
 * Mirrors what a tracked wallet does.
 *
 * Two asymmetries drive the design.
 *
 * Buys are filtered, because not every buy is a position. Wallets routinely
 * make dust purchases to push a token up a screener's volume ranking, and a
 * copy trader that follows those ends up holding things the wallet never
 * actually committed to. `COPY_MIN_BUY_SOL` is the filter that matters most
 * here, and it is enforced on the SOL value of their buy — priced through the
 * bonding curve — rather than on token count, which means nothing across
 * tokens with different supplies.
 *
 * Sells are not filtered at all, and mirror the FRACTION rather than the
 * amount. If they dump 40% of their bag we sell 40% of ours, whatever the two
 * positions are worth. Any filter on the sell side is a way to still be holding
 * after the person you are following has left.
 */
export class CopyTrader {
  private stats: CopyStats = { seen: 0, bought: 0, sold: 0, skips: {} };
  /** Serialises entries so two wallets buying at once cannot both clear the cap. */
  private chain: Promise<void> = Promise.resolve();
  private entering = false;

  constructor(private readonly deps: CopyDeps) {}

  snapshotStats(): CopyStats {
    return { ...this.stats, skips: { ...this.stats.skips } };
  }

  private skip(bucket: string, reason: string, quiet = false): void {
    this.stats.skips[bucket] = (this.stats.skips[bucket] ?? 0) + 1;
    this.stats.lastSkipReason = reason;
    if (!quiet) log.info(`SKIP ${reason}`);
  }

  /** Entry point from the watcher. Never throws into the poll loop. */
  onWalletTrade(trade: WalletTrade): void {
    this.stats.seen += 1;
    if (trade.side === 'sell') {
      this.chain = this.chain
        .then(() => this.mirrorSell(trade))
        .catch((err) => log.error(`Mirror sell failed for ${trade.mint}: ${errMessage(err)}`));
      return;
    }
    this.chain = this.chain
      .then(() => this.mirrorBuy(trade))
      .catch((err) => log.error(`Mirror buy failed for ${trade.mint}: ${errMessage(err)}`));
  }

  private async mirrorBuy(trade: WalletTrade): Promise<void> {
    const { cfg, store } = this.deps;
    const short = `${trade.wallet.slice(0, 6)}…`;
    const mintShort = trade.mint.slice(0, 8);

    if (store.hasOpenPositionFor(trade.mint)) {
      // They added to a position we already mirror. Following that would
      // average us up on their schedule rather than ours.
      this.skip('already_held', `${mintShort}: already holding it`, true);
      return;
    }
    if (store.hasTraded(trade.mint)) {
      this.skip('already_traded', `${mintShort}: already traded once`, true);
      return;
    }

    // Price their buy in SOL. Token counts are meaningless across tokens with
    // different supplies, and the whole point of the size filter is to tell a
    // real position from a volume bump.
    const curve = await this.deps.prices.curve(trade.mint).catch(() => null);
    if (!curve) {
      this.skip('no_curve', `${mintShort}: no readable bonding curve`);
      return;
    }
    if (curve.complete) {
      this.skip('graduated', `${mintShort}: already graduated off the curve`);
      return;
    }

    const price = curveSpotPrice(curve);
    if (price === null || price <= 0) {
      this.skip('no_price', `${mintShort}: could not price the curve`);
      return;
    }

    const theirSol = trade.tokenDelta * price;
    if (theirSol < cfg.COPY_MIN_BUY_SOL) {
      this.skip(
        'too_small',
        `${short} bought only ${theirSol.toFixed(3)} SOL of ${mintShort} ` +
          `(min ${cfg.COPY_MIN_BUY_SOL}) — looks like a volume bump`,
      );
      return;
    }
    if (cfg.COPY_MAX_BUY_SOL > 0 && theirSol > cfg.COPY_MAX_BUY_SOL) {
      this.skip(
        'too_large',
        `${short} bought ${theirSol.toFixed(2)} SOL of ${mintShort} (max ${cfg.COPY_MAX_BUY_SOL})`,
      );
      return;
    }

    const size = this.sizeFor(theirSol);
    if (size <= 0) {
      this.skip('zero_size', `${mintShort}: sizing produced nothing`);
      return;
    }

    if (this.entering) {
      this.skip('busy', `${mintShort}: another entry in flight`);
      return;
    }
    this.entering = true;
    try {
      const risk = this.deps.risk.canOpen(await this.deps.walletBalance());
      if (!risk.allowed) {
        this.skip('risk', `${mintShort}: ${risk.reason}`);
        return;
      }

      const candidate: TokenCandidate = {
        mint: trade.mint,
        // The deployer is not knowable from a balance read, and copy trading
        // does not use deployer reputation. Attributing it to the wallet we are
        // following would poison that data for the other bots.
        creator: 'unknown',
        pool: 'pump' as Pool,
        detectedAt: trade.at,
        source: `copy:${trade.wallet}`,
      };

      log.info(
        `COPY BUY ${mintShort} — ${short} bought ${theirSol.toFixed(2)} SOL, ` +
          `mirroring with ${size.toFixed(3)} SOL`,
      );

      const fill = await this.deps.executor.buy(candidate, size);
      if (!fill.ok) {
        this.skip('buy_failed', `${mintShort}: buy failed — ${fill.error}`);
        if (fill.spentSol > 0) this.deps.risk.recordOutcome(-fill.spentSol);
        return;
      }

      this.stats.bought += 1;
      const position = this.deps.positions.open(candidate, fill, 0);
      position.notionalSol = size;
      position.managedBy = 'copy';
      position.copiedFrom = trade.wallet;
      const capSol = marketCapFromState(curve);
      position.entryMarketCapSol = capSol;
      position.entryMarketCapUsd = capSol * this.deps.solUsd();
      position.notes.push(
        `copy: ${short} bought ${theirSol.toFixed(2)} SOL at ` +
          `$${(capSol * this.deps.solUsd()).toFixed(0)} mcap`,
      );
      store.savePosition(position);
    } finally {
      this.entering = false;
    }
  }

  private sizeFor(theirSol: number): number {
    const { cfg } = this.deps;
    const raw =
      cfg.COPY_SIZE_MODE === 'proportional' ? theirSol * cfg.COPY_RATIO : cfg.COPY_BUY_AMOUNT_SOL;
    return Math.min(raw, cfg.COPY_MAX_POSITION_SOL);
  }

  private async mirrorSell(trade: WalletTrade): Promise<void> {
    const { cfg, store } = this.deps;
    const open = store.openPositions().find((p) => p.mint === trade.mint && p.managedBy === 'copy');
    if (!open) return;

    const short = `${trade.wallet.slice(0, 6)}…`;
    if (open.copiedFrom && open.copiedFrom !== trade.wallet) {
      // Another tracked wallet selling the same token is not the signal we
      // entered on. Acting on it would exit a position on a stranger's timing.
      return;
    }

    // Once they are essentially out, so are we — mirroring a fraction of a
    // fraction leaves a tail behind forever.
    const fullyOut =
      trade.balanceAfter <= 0 ||
      trade.fraction * 100 >= cfg.COPY_FULL_EXIT_AT_PCT ||
      cfg.COPY_FULL_EXIT_AT_PCT === 0;

    if (fullyOut) {
      log.info(`COPY SELL ${trade.mint.slice(0, 8)} — ${short} is out, closing`);
      this.stats.sold += 1;
      await this.deps.positions.externalExit(
        open,
        'manual',
        `copy: ${short} sold ${(trade.fraction * 100).toFixed(0)}% and is out`,
      );
      return;
    }

    const fraction = Math.min(1, trade.fraction * cfg.COPY_SELL_MULTIPLIER);
    const qty = open.remainingQty * fraction;
    if (qty <= 0) return;

    log.info(
      `COPY TRIM ${trade.mint.slice(0, 8)} — ${short} sold ` +
        `${(trade.fraction * 100).toFixed(0)}%, mirroring ${(fraction * 100).toFixed(0)}%`,
    );
    this.stats.sold += 1;
    await this.deps.positions.externalExit(
      open,
      'manual',
      `copy: ${short} sold ${(trade.fraction * 100).toFixed(0)}% of their bag`,
      qty,
    );
  }
}
