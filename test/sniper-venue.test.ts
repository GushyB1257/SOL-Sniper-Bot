import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingBot } from '../src/bots/bot.js';
import { PaperExecutor } from '../src/execution/paper.js';
import { SolPrice } from '../src/util/solprice.js';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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

/**
 * A revoked SPL mint, so the two fatal authority checks pass.
 *
 * They are the one part of the battery that cannot be switched off by config,
 * and they fail CLOSED — so without this the battery vetoes every launch and
 * anything downstream of it is untestable.
 */
function revokedMint(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 1, rentEpoch: 0 };
}

/** Everything the battery needs to reach a verdict, and nothing more. */
const passingConn = { getAccountInfo: async () => revokedMint() } as unknown as Connection;

/** A fresh pump.fun curve, so the paper executor can actually fill a buy. */
const freshCurve = () => ({
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
});

function sniperFor(cfg: Config, price: () => Promise<number | null> = async () => null): TradingBot {
  // A gated run has to be able to reach a fill, or the gate's own effect cannot
  // be told apart from the executor refusing everything.
  const gated = cfg.SNIPE_CONFIRM_MS > 0;
  const prices = { curve: async () => (gated ? freshCurve() : null), price };
  return new TradingBot('sniper', 'Sniper', {
    cfg,
    dataDir: dir,
    executor: new PaperExecutor(cfg, prices),
    prices,
    // The venue gate is meant to run before a single request is spent, so most
    // tests here would fail loudly if anything touched RPC.
    connection: (cfg.SNIPE_CONFIRM_MS > 0 ? passingConn : ({} as never)) as never,
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

describe('sniper entry confirmation', () => {
  /**
   * 87 of 156 trades exited as `dead_entry` for -2.74 SOL, and BOTH directions
   * of RATCHET_FIRST_CHECKPOINT_SECONDS were measured and reverted — so the loss
   * is not in how long a non-starter is held. Every check in the battery asks
   * whether the token is structurally sound; none asks whether anyone else is
   * buying it. This is the cheapest form of that question.
   */
  const CONFIRM = {
    SNIPE_CONFIRM_MS: '60',
    SNIPE_CONFIRM_MIN_GAIN_PCT: '5',
    // Off, so the battery reaches a verdict from the mint read and the free
    // checks alone. What is under test is the gate, not the battery.
    MIN_HOLDERS: '0',
    MIN_CREATOR_AGE_MINUTES: '0',
    MAX_LAUNCH_BUNDLE_TXS: '0',
    REJECT_IF_DEPLOYER_EXITED: 'false',
    MIN_DEPLOYER_BALANCE_SOL: '0',
    REQUIRE_SOCIALS: 'false',
  };

  it('is off by default, so nothing waits', async () => {
    const bot = sniperFor(loadConfig(env(dir)));
    const started = Date.now();
    bot.onCandidate(launch('pump'));
    await settle();
    expect(Date.now() - started).toBeLessThan(80);
    expect(bot.snapshotStats().evaluated).toBe(1);
    bot.store.close();
  });

  it('refuses a launch whose price did not move', async () => {
    const bot = sniperFor(loadConfig(env(dir, CONFIRM)), async () => 100);
    bot.onCandidate(launch('pump'));
    await new Promise((r) => setTimeout(r, 400));

    expect(bot.snapshotStats().rejected).toBe(1);
    expect(bot.snapshotStats().bought).toBe(0);
    bot.store.close();
  });

  it('buys a launch that ticked up past the threshold', async () => {
    let call = 0;
    const bot = sniperFor(loadConfig(env(dir, CONFIRM)), async () => (call++ === 0 ? 100 : 120));
    bot.onCandidate(launch('pump'));
    await new Promise((r) => setTimeout(r, 400));

    expect(bot.snapshotStats().bought).toBe(1);
    expect(bot.snapshotStats().rejected).toBe(0);
    bot.store.close();
  });

  it('records what it saw, so the gate can be measured rather than believed', async () => {
    let call = 0;
    const bot = sniperFor(loadConfig(env(dir, CONFIRM)), async () => (call++ === 0 ? 100 : 120));
    bot.onCandidate(launch('pump'));
    await new Promise((r) => setTimeout(r, 400));

    const note = bot.store.allPositions()[0]?.notes.find((n) => n.startsWith('snipe:'));
    expect(note).toMatch(/20\.0% confirm move/);
    bot.store.close();
  });

  it('fails OPEN when the price cannot be read', async () => {
    // A price we cannot fetch says nothing about the launch. Letting our own
    // outage turn the gate into a blanket veto is the same mistake as charging a
    // token for a slow IPFS gateway.
    const bot = sniperFor(loadConfig(env(dir, CONFIRM)), async () => null);
    bot.onCandidate(launch('pump'));
    await new Promise((r) => setTimeout(r, 400));

    expect(bot.snapshotStats().rejected).toBe(0);
    expect(bot.snapshotStats().bought).toBe(1);
    bot.store.close();
  });
});
