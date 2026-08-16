import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyTrader } from '../src/copy/copy-trader.js';
import { PositionManager } from '../src/strategy/position-manager.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { decideExit } from '../src/strategy/exit-planner.js';
import { formatCopyWallets, loadConfig, walletLabel, type Config } from '../src/config.js';
import type { PriceSource } from '../src/execution/pricing.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import type { WalletTrade } from '../src/copy/wallet-watcher.js';
import type { Position } from '../src/types.js';
import { walletPnl } from '../src/server/snapshot.js';

const WALLET = 'FoLLoW1111111111111111111111111111111111111';
const OTHER = 'oTHeR22222222222222222222222222222222222222';
const MINT = 'Mint1111111111111111111111111111111111111';
const OTHER_MINT = 'Mint2222222222222222222222222222222222222';

/** Curve with 45 vSOL — one token is worth about 6.3e-8 SOL. */
class StubPrices implements PriceSource {
  complete = false;
  missing = false;
  vSol = 45;
  /** Stalls the curve read for one mint, standing in for a slow RPC. */
  curveDelayMs = 0;
  curveDelayMint: string | null = null;

  async curve(mint: string): Promise<BondingCurveState | null> {
    if (this.curveDelayMs > 0 && mint === this.curveDelayMint) {
      await new Promise((r) => setTimeout(r, this.curveDelayMs));
    }
    if (this.missing) return null;
    const k = 30 * 1_073_000_000;
    return {
      virtualSolReserves: BigInt(Math.round(this.vSol * 1e9)),
      virtualTokenReserves: BigInt(Math.round((k / this.vSol) * 1e6)),
      realSolReserves: 15_000_000_000n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: this.complete,
    };
  }
  async price(): Promise<number | null> {
    const k = 30 * 1_073_000_000;
    return this.vSol / (k / this.vSol);
  }
}

let dir: string;
let cfg: Config;
let store: Store;
let prices: StubPrices;
let trader: CopyTrader;
let positions: PositionManager;

function build(overrides: Record<string, string> = {}): void {
  dir = mkdtempSync(join(tmpdir(), 'sniper-copy-'));
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    BOT_COPY_ENABLED: 'true',
    COPY_WALLETS: WALLET,
    DATA_DIR: dir,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);

  store = new Store(dir, 'copy');
  prices = new StubPrices();
  const exec = new PaperExecutor(cfg, prices);
  const risk = new RiskManager(cfg, store, join(dir, 'nostop'));
  positions = new PositionManager(cfg, store, exec, risk);

  trader = new CopyTrader({
    cfg,
    store,
    executor: exec,
    risk,
    positions,
    prices,
    walletBalance: async () => 10,
    solUsd: () => 200,
  });
}

/** Their buy of `tokens`, which at the stub curve is tokens x ~6.3e-8 SOL. */
function theirBuy(tokens: number, wallet = WALLET): WalletTrade {
  return {
    wallet,
    mint: MINT,
    side: 'buy',
    tokenDelta: tokens,
    balanceAfter: tokens,
    fraction: 1,
    isNewPosition: true,
    at: Date.now(),
  };
}

function theirSell(fraction: number, balanceAfter: number, wallet = WALLET): WalletTrade {
  return {
    wallet,
    mint: MINT,
    side: 'sell',
    tokenDelta: 1,
    balanceAfter,
    fraction,
    isNewPosition: false,
    at: Date.now(),
  };
}

/** Lets the serialised entry chain drain. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => build());
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mirroring a buy', () => {
  it('follows a real position', async () => {
    // 32M tokens x 6.3e-8 ≈ 2 SOL, comfortably over the 0.5 SOL floor.
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();

    const open = store.openPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.managedBy).toBe('copy');
    expect(open[0]!.copiedFrom).toBe(WALLET);
    expect(open[0]!.costSol).toBeGreaterThan(0);
  });

  it('ignores a dust buy used to bump volume', async () => {
    // The filter that matters most: a wallet nudging a token up a screener's
    // volume ranking has not taken a position, and following it means holding
    // something they never committed to.
    trader.onWalletTrade(theirBuy(1_000_000)); // ~0.06 SOL
    await settle();

    expect(store.openPositions()).toHaveLength(0);
    expect(trader.snapshotStats().skips.too_small).toBe(1);
    expect(trader.snapshotStats().lastSkipReason).toMatch(/volume bump/);
  });

  it('prices the filter in SOL, not token count', async () => {
    // Same token count is a different amount of money on a different curve.
    prices.vSol = 31; // barely moved off launch, so tokens are cheap
    trader.onWalletTrade(theirBuy(10_000_000));
    await settle();
    expect(store.openPositions()).toHaveLength(0);

    build();
    prices.vSol = 80; // far up the curve, same count is worth much more
    trader.onWalletTrade(theirBuy(10_000_000));
    await settle();
    expect(store.openPositions()).toHaveLength(1);
  });

  it('ignores a buy bigger than the ceiling', async () => {
    build({ COPY_MAX_BUY_SOL: '1' });
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    expect(trader.snapshotStats().skips.too_large).toBe(1);
  });

  it('sizes a fixed position regardless of theirs', async () => {
    build({ COPY_BUY_AMOUNT_SOL: '0.3' });
    trader.onWalletTrade(theirBuy(50_000_000));
    await settle();
    expect(store.openPositions()[0]!.notionalSol).toBeCloseTo(0.3);
  });

  it('sizes proportionally when asked, capped', async () => {
    build({ COPY_SIZE_MODE: 'proportional', COPY_RATIO: '0.5', COPY_MAX_POSITION_SOL: '0.4' });
    trader.onWalletTrade(theirBuy(32_000_000)); // ~2 SOL x 0.5 = 1, capped to 0.4
    await settle();
    expect(store.openPositions()[0]!.notionalSol).toBeCloseTo(0.4);
  });

  it('stamps the market cap it entered at', async () => {
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    const p = store.openPositions()[0]!;
    expect(p.entryMarketCapSol).toBeGreaterThan(0);
    expect(p.entryMarketCapUsd).toBeCloseTo(p.entryMarketCapSol! * 200);
  });

  it('does not chase a token it already holds', async () => {
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    expect(store.openPositions()).toHaveLength(1);
    expect(trader.snapshotStats().skips.already_held).toBe(1);
  });

  it('will not follow them off the curve', async () => {
    prices.complete = true;
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    expect(trader.snapshotStats().skips.graduated).toBe(1);
  });

  it('skips a token it cannot price rather than guessing', async () => {
    prices.missing = true;
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    expect(store.openPositions()).toHaveLength(0);
    expect(trader.snapshotStats().skips.no_curve).toBe(1);
  });
});

describe('mirroring a sell', () => {
  async function openOne(): Promise<Position> {
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    return store.openPositions()[0]!;
  }

  it('sells the same fraction of our bag that they sold of theirs', async () => {
    const p = await openOne();
    const before = p.remainingQty;

    trader.onWalletTrade(theirSell(0.4, 19_200_000));
    await settle();

    const after = store.getPosition(p.id)!;
    expect(after.status).toBe('open');
    expect(after.remainingQty / before).toBeCloseTo(0.6, 1);
  });

  it('closes fully once they are essentially out', async () => {
    const p = await openOne();
    trader.onWalletTrade(theirSell(0.95, 100));
    await settle();
    expect(store.getPosition(p.id)!.status).toBe('closed');
  });

  it('closes fully when their balance hits zero', async () => {
    const p = await openOne();
    trader.onWalletTrade(theirSell(0.5, 0));
    await settle();
    expect(store.getPosition(p.id)!.status).toBe('closed');
  });

  it('can exit faster than they do', async () => {
    build({ COPY_SELL_MULTIPLIER: '2' });
    const p = await openOne();
    const before = p.remainingQty;

    trader.onWalletTrade(theirSell(0.3, 20_000_000));
    await settle();
    // 30% of theirs mirrors as 60% of ours.
    expect(store.getPosition(p.id)!.remainingQty / before).toBeCloseTo(0.4, 1);
  });

  it('ignores a different tracked wallet selling the same token', async () => {
    // We entered on one wallet's signal; another's exit is not that signal.
    const p = await openOne();
    trader.onWalletTrade(theirSell(1, 0, OTHER));
    await settle();
    expect(store.getPosition(p.id)!.status).toBe('open');
  });

  it('ignores a sell in a token we never copied', async () => {
    trader.onWalletTrade(theirSell(1, 0));
    await settle();
    expect(store.openPositions()).toHaveLength(0);
  });
});

describe('the exit planner leaves copied positions alone', () => {
  it('holds through a crash that would trip every other rule', async () => {
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    const p = store.openPositions()[0]!;

    // Down 95%, an hour old, well past every checkpoint. Still held, because
    // the wallet we are following has not sold.
    const order = decideExit({
      position: p,
      price: p.entryPrice * 0.05,
      cfg,
      now: p.openedAt + 3_600_000,
    });
    expect(order).toBeNull();
  });

  it('still has a backstop if the wallet never sells', async () => {
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    const p = store.openPositions()[0]!;

    const order = decideExit({
      position: p,
      price: p.entryPrice,
      cfg,
      now: p.openedAt + (cfg.COPY_MAX_HOLD_SECONDS + 60) * 1000,
    });
    expect(order?.reason).toBe('max_hold');
    expect(order?.closeAll).toBe(true);
  });
});

describe('config guards', () => {
  it('starts with no wallets rather than refusing to run', () => {
    // The dashboard is the config surface, so "start it, then paste the
    // wallets in" is the natural order. Refusing to start would look like a
    // broken button; the bot is simply inert until wallets exist.
    expect(() => build({ COPY_WALLETS: '' })).not.toThrow();
    expect(cfg.COPY_WALLETS).toEqual([]);
  });

  it('rejects an address that is not base58', () => {
    expect(() => build({ COPY_WALLETS: 'not-a-wallet' })).toThrow(/base58/);
  });

  it('rejects a size window nothing can pass', () => {
    expect(() => build({ COPY_MIN_BUY_SOL: '5', COPY_MAX_BUY_SOL: '1' })).toThrow(/must be below/);
  });
});

describe('naming wallets', () => {
  it('parses a bare address and a named one from the same field', () => {
    build({ COPY_WALLETS: WALLET + '=Insider, ' + OTHER });
    expect(cfg.COPY_WALLETS).toEqual([
      { address: WALLET, label: 'Insider' },
      { address: OTHER },
    ]);
  });

  it('tolerates whitespace, newlines and duplicates', () => {
    build({ COPY_WALLETS: `  ${WALLET} = Alpha Whale \n, ${OTHER},\n${WALLET}` });
    expect(cfg.COPY_WALLETS).toHaveLength(2);
    expect(cfg.COPY_WALLETS[0]).toEqual({ address: WALLET, label: 'Alpha Whale' });
  });

  it('treats an empty name as no name', () => {
    build({ COPY_WALLETS: WALLET + '=' });
    expect(cfg.COPY_WALLETS).toEqual([{ address: WALLET }]);
  });

  it('still rejects a bad address, name or not', () => {
    expect(() => build({ COPY_WALLETS: 'nope=Friend' })).toThrow(/base58/);
  });

  it('falls back to a truncated address when unnamed', () => {
    build({ COPY_WALLETS: WALLET });
    expect(walletLabel(cfg, WALLET)).toBe(WALLET.slice(0, 4) + '…' + WALLET.slice(-4));
  });

  it('uses the name once one is set', () => {
    build({ COPY_WALLETS: WALLET + '=Insider' });
    expect(walletLabel(cfg, WALLET)).toBe('Insider');
  });

  it('round-trips through the form value without losing names', () => {
    // values() feeds the settings box; a lossy render here would wipe every
    // name the next time anything was saved.
    build({ COPY_WALLETS: WALLET + '=Insider, ' + OTHER });
    const text = formatCopyWallets(cfg.COPY_WALLETS);
    expect(text).toBe(WALLET + '=Insider, ' + OTHER);

    build({ COPY_WALLETS: text });
    expect(cfg.COPY_WALLETS).toEqual([{ address: WALLET, label: 'Insider' }, { address: OTHER }]);
  });

  it('does not make an exit wait behind an entry that is still in flight', async () => {
    // Buys are serialised because they contend for the position and spend caps.
    // Sells contend for nothing, and queueing one behind a slow buy means being
    // late out of a position the wallet has already left.
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    expect(store.openPositions()).toHaveLength(1);

    prices.curveDelayMint = OTHER_MINT; // only the new entry's read stalls
    prices.curveDelayMs = 300;
    trader.onWalletTrade({ ...theirBuy(32_000_000), mint: OTHER_MINT });
    trader.onWalletTrade(theirSell(1, 0));

    // Well inside the stalled entry: the exit must already be done.
    await new Promise((r) => setTimeout(r, 60));
    expect(store.openPositions().some((p) => p.mint === MINT)).toBe(false);
    expect(store.journal()).toHaveLength(1);

    prices.curveDelayMs = 0;
    await new Promise((r) => setTimeout(r, 400));
  });

  it('reports what copying each wallet has made', async () => {
    build({ COPY_WALLETS: `${WALLET}=Insider, ${OTHER}=Quiet` });

    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    prices.vSol = 90; // their token doubles
    trader.onWalletTrade(theirSell(1, 0));
    await settle();

    const good = walletPnl(store, WALLET);
    expect(good.trades).toBe(1);
    expect(good.wins).toBe(1);
    expect(good.realizedSol).toBeGreaterThan(0);
    expect(good.netSol).toBeCloseTo(good.realizedSol + good.unrealizedSol, 12);

    // A wallet we have not copied yet reads as zero rather than borrowing the
    // other one's numbers.
    expect(walletPnl(store, OTHER)).toEqual({
      realizedSol: 0,
      unrealizedSol: 0,
      netSol: 0,
      trades: 0,
      wins: 0,
      openPositions: 0,
    });
  });

  it('marks a still-open copied position to market rather than ignoring it', async () => {
    build({ COPY_WALLETS: WALLET + '=Insider' });
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();

    const open = store.openPositions()[0]!;
    open.lastPrice = open.entryPrice * 3;
    store.savePosition(open);

    const pnl = walletPnl(store, WALLET);
    expect(pnl.trades).toBe(0);
    expect(pnl.openPositions).toBe(1);
    expect(pnl.unrealizedSol).toBeGreaterThan(0);
    expect(pnl.netSol).toBe(pnl.unrealizedSol);
  });

  it('records the wallet on the trade journal so history can be labelled', async () => {
    build({ COPY_WALLETS: WALLET + '=Insider' });
    trader.onWalletTrade(theirBuy(32_000_000));
    await settle();
    trader.onWalletTrade(theirSell(1, 0));
    await settle();

    const entry = store.journal()[0]!;
    expect(entry.copiedFrom).toBe(WALLET);
    // The ADDRESS is stored, not the name — so renaming relabels history too.
    expect(walletLabel(cfg, entry.copiedFrom)).toBe('Insider');
    build({ COPY_WALLETS: WALLET + '=Renamed' });
    expect(walletLabel(cfg, WALLET)).toBe('Renamed');
  });
});
