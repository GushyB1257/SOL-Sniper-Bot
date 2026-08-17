import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingBot } from '../src/bots/bot.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { SolPrice } from '../src/util/solprice.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Pool, TokenCandidate } from '../src/types.js';

/**
 * The sniper only buys on venues it is actually modelled for.
 *
 * The screener and copy trader have always had a venue gate; the sniper had
 * none and took whatever the feed handed it. That was invisible while
 * PumpPortal carried only pump.fun launches, and became a way to buy coins off
 * half a dozen other launchpads once it did not.
 */

const SECRET = '4NF3TjMxqLpJk8vWqYbVsB2eZzTnR7cXhAaGdKfPmQxV1u9wErTyUiOpAsDfGhJkLzXcVbNmQwErTyUi';

function env(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    WALLET_PRIVATE_KEY: SECRET,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

let dir: string;

function sniperFor(cfg: Config): TradingBot {
  return new TradingBot('sniper', 'Sniper', {
    cfg,
    dataDir: dir,
    executor: new PaperExecutor(cfg),
    prices: { curve: async () => null, price: async () => null },
    // Any RPC use would be a test failure: the venue gate is meant to run
    // before a single request is spent on the launch.
    connection: {} as never,
    walletBalance: async () => 3.5,
    killSwitchPath: join(dir, 'STOP'),
    solPrice: new SolPrice(200),
    trackTrades: () => {},
    untrackTrades: () => {},
  });
}

function launch(pool: Pool): TokenCandidate {
  return {
    mint: '6ChE3ZP9BjmGXBTzQLcRDZ72bpmTLmHsgYdCCpdLqunF',
    creator: '5bW3ahx1MyYSsaji7G1DVxPVKvjngffRVeFSHEouFk3H',
    name: 'Test Token',
    symbol: 'TEST',
    pool,
    detectedAt: Date.now(),
    source: 'test',
  };
}

/** onCandidate dispatches async work; give the microtask queue a turn. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-venue-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sniper venue gate', () => {
  it('drops a launch from an unrecognised launchpad without touching RPC', async () => {
    const bot = sniperFor(loadConfig(env(dir)));
    bot.onCandidate(launch('unknown'));
    await settle();

    const stats = bot.snapshotStats();
    expect(stats.seen).toBe(1);
    expect(stats.skipped).toBe(1);
    // Never reached the safety battery, which is what would have used the
    // connection stub and thrown.
    expect(stats.evaluated).toBe(0);
    bot.store.close();
  });

  it('drops a venue that is real but not on the list', async () => {
    // pump-amm is a genuine venue and a genuine pool value — it is simply not
    // pump.fun's bonding curve, which is the only thing the default allows.
    const bot = sniperFor(loadConfig(env(dir)));
    bot.onCandidate(launch('pump-amm'));
    await settle();

    expect(bot.snapshotStats().skipped).toBe(1);
    expect(bot.snapshotStats().evaluated).toBe(0);
    bot.store.close();
  });

  it('lets a pump.fun launch through to the safety battery', async () => {
    // The gate has to be a filter, not a wall. Getting this far means it passed
    // the venue check and went on to evaluate — where the connection stub then
    // fails it, which is fine and is not what is under test.
    const bot = sniperFor(loadConfig(env(dir)));
    bot.onCandidate(launch('pump'));
    await settle();

    expect(bot.snapshotStats().evaluated).toBe(1);
    bot.store.close();
  });

  it('honours a widened allow-list', async () => {
    const bot = sniperFor(loadConfig(env(dir, { SNIPE_ALLOWED_POOLS: 'pump,pump-amm' })));
    bot.onCandidate(launch('pump-amm'));
    await settle();

    expect(bot.snapshotStats().evaluated).toBe(1);
    bot.store.close();
  });

  it('has no allow-list that admits an unknown venue', async () => {
    // Every configurable value, all at once — an unidentified venue is still
    // refused, because there is deliberately no setting that turns it on.
    const cfg = loadConfig(
      env(dir, { SNIPE_ALLOWED_POOLS: 'pump,pump-amm,raydium,raydium-cpmm,launchlab,bonk,auto' }),
    );
    const bot = sniperFor(cfg);
    bot.onCandidate(launch('unknown'));
    await settle();

    expect(bot.snapshotStats().skipped).toBe(1);
    expect(bot.snapshotStats().evaluated).toBe(0);
    bot.store.close();
  });
});
