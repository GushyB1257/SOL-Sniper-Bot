import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionManager } from '../src/strategy/position-manager.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PriceSource } from '../src/execution/pricing.js';
import type { BondingCurveState } from '../src/execution/bonding-curve.js';
import type { BuyResult, Executor, Position, SellResult, TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ENTRY_MODE: 'fast',
  EXIT_MODE: 'ladder',
  BUY_AMOUNT_SOL: '0.05',
  EXIT_LADDER: '60:40,150:30,400:20',
  STOP_LOSS_PCT: '20',
  POSITION_PRICE_TIMEOUT_MS: '500',
} as unknown as NodeJS.ProcessEnv;

class Curve implements PriceSource {
  vSol = 30;
  vTokens = 1_073_000_000;
  async curve(): Promise<BondingCurveState | null> {
    return {
      virtualSolReserves: BigInt(Math.round(this.vSol * 1e9)),
      virtualTokenReserves: BigInt(Math.round(this.vTokens * 1e6)),
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    };
  }
  async price(): Promise<number | null> {
    return this.vSol / this.vTokens;
  }
  /** Moves the curve so spot becomes `multiple` x `from`. */
  setMultiple(from: number, multiple: number): void {
    const k = this.vSol * this.vTokens;
    this.vSol = Math.sqrt(from * multiple * k);
    this.vTokens = k / this.vSol;
  }
}

/**
 * A paper executor whose price read can be made to hang for chosen mints —
 * standing in for an RPC read stuck behind the throttle's retry chain.
 */
class StallingExecutor implements Executor {
  readonly name = 'stalling';
  /** Mints whose price read never resolves. */
  readonly stalled = new Set<string>();
  /** Price reads served, per mint. */
  readonly reads = new Map<string, number>();

  constructor(private readonly inner: PaperExecutor) {}

  buy(c: TokenCandidate, amountSol: number): Promise<BuyResult> {
    return this.inner.buy(c, amountSol);
  }
  sell(p: Position, qty: number, closeAll: boolean): Promise<SellResult> {
    return this.inner.sell(p, qty, closeAll);
  }
  balance(mint: string): Promise<number | null> {
    return this.inner.balance(mint);
  }
  price(p: Position): Promise<number | null> {
    this.reads.set(p.mint, (this.reads.get(p.mint) ?? 0) + 1);
    if (this.stalled.has(p.mint)) return new Promise<number | null>(() => {});
    return this.inner.price(p);
  }
}

const candidate = (mint: string): TokenCandidate => ({
  mint,
  creator: 'Dev11111111111111111111111111111111111111',
  symbol: mint.slice(0, 4),
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
  vSolInBondingCurve: 30,
  vTokensInBondingCurve: 1_073_000_000,
});

const SLOW = 'S1owwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
const FAST = 'F4stttttttttttttttttttttttttttttttttttttt';

let dir: string;
let cfg: Config;
let store: Store;
let prices: Curve;
let exec: StallingExecutor;
let manager: PositionManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-cadence-'));
  cfg = loadConfig({ ...BASE_ENV, DATA_DIR: dir });
  store = new Store(dir);
  prices = new Curve();
  exec = new StallingExecutor(new PaperExecutor(cfg, prices));
  manager = new PositionManager(cfg, store, exec, new RiskManager(cfg, store, join(dir, 'nostop')));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function open(mint: string): Promise<Position> {
  const fill = await exec.buy(candidate(mint), 0.05);
  return manager.open(candidate(mint), fill, 80);
}

/** Fires `n` timer beats `everyMs` apart WITHOUT waiting for each to finish —
 *  which is what the real interval timer does (`void bot.tickPositions()`). */
async function beats(n: number, everyMs: number, fn: () => Promise<void>): Promise<void> {
  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    inFlight.push(fn());
    if (i < n - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  await Promise.all(inFlight);
}

describe('position poll cadence', () => {
  it('keeps polling a healthy position while another one is stuck', async () => {
    await open(SLOW);
    await open(FAST);
    exec.stalled.add(SLOW);

    // Three beats, 50ms apart, while the stalled read sits there unresolved for
    // its full 500ms deadline. All three beats land inside that window.
    await beats(3, 50, () => manager.tick());

    // The whole point: the healthy position was read on every beat. Under the
    // old single `ticking` flag plus `Promise.all`, the first tick had not
    // resolved when beats two and three arrived, so both were dropped for BOTH
    // positions — one stuck RPC read set the stop-loss cadence for the whole
    // book, and it did so hardest during the launch bursts that saturate the
    // RPC lane, which are the same bursts the dumps happen in.
    expect(exec.reads.get(FAST)).toBe(3);
  });

  it('does not stack ticks on top of a position that is still mid-read', async () => {
    await open(SLOW);
    exec.stalled.add(SLOW);

    await beats(4, 50, () => manager.tick());

    // KeyedMutex QUEUES rather than drops, so leaving this to the lock would
    // chain four beats behind the stuck read and then run them back to back
    // against a price already minutes old. Skipping a missed beat is the right
    // response: the next read gets a current price, the only one worth acting
    // on. One read for four beats, because all four fell inside its deadline.
    expect(exec.reads.get(SLOW)).toBe(1);
  });

  it('abandons a price read that blows its deadline instead of holding the tick', async () => {
    const p = await open(SLOW);
    exec.stalled.add(SLOW);

    const started = Date.now();
    await manager.tick();
    const elapsed = Date.now() - started;

    // POSITION_PRICE_TIMEOUT_MS is 500ms here (the schema floor). Before the
    // deadline existed the curve read was a bare getAccountInfo with no bound
    // of its own, so this call would simply never return.
    expect(elapsed).toBeGreaterThanOrEqual(480);
    expect(elapsed).toBeLessThan(2000);
    // A read that timed out is a data problem, not a market one: the position
    // is still held and still open.
    expect(store.getPosition(p.id)?.status).toBe('open');
  });

  it('retries on the next beat once a stalled read has been abandoned', async () => {
    await open(SLOW);
    exec.stalled.add(SLOW);

    await manager.tick(); // times out after 500ms
    await manager.tick();

    // Skipping is per beat, not a lockout. A position whose read failed must be
    // tried again immediately — it is precisely the one that might need to sell.
    expect(exec.reads.get(SLOW)).toBe(2);
  });
});

describe('attributing an oversized loser', () => {
  it('records how long the position went unpriced on the exit that fired', async () => {
    const p = await open(FAST);
    await manager.tick(); // establish a baseline reading

    // Fall straight through the 20% stop while nobody is looking.
    prices.setMultiple(p.entryPrice, 0.5);
    await manager.tick();

    const closed = store.getPosition(p.id);
    expect(closed?.status).toBe('closed');
    // The stop says 20%; this fired at 50% down. Without the gap on the record
    // there is no way to tell a market that moved in one tick from a bot that
    // arrived late, and those have different fixes.
    expect(closed?.closeReason).toMatch(/stop_loss/);
    expect(closed?.closeReason).toMatch(/unpriced/);
  });
});
