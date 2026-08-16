import { describe, it, expect, beforeEach } from 'vitest';
import {
  creatorAgeCheck,
  deployerStillHoldsCheck,
  holderCountCheck,
  launchBundleCheck,
} from '../src/safety/checks/provenance.js';
import { loadConfig, type Config } from '../src/config.js';
import type { CheckContext } from '../src/safety/types.js';
import type { TokenCandidate } from '../src/types.js';

// Real base58 keys: these are passed to PublicKey, which validates them.
const MINT = 'So11111111111111111111111111111111111111112';
const DEV = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CANDIDATE: TokenCandidate = {
  mint: MINT,
  creator: DEV,
  symbol: 'TEST',
  pool: 'pump',
  detectedAt: Date.now(),
  source: 'test',
  initialBuyTokens: 10_000_000,
};

/** Only the handful of RPC methods these checks call. */
interface FakeConn {
  largest: Array<{ amount: string }>;
  supply: string;
  devHeld: number;
  creatorSigs: Array<{ blockTime: number | null; slot: number }>;
  mintSigs: Array<{ slot: number }>;
  calls: string[];
}

function conn(over: Partial<FakeConn> = {}): FakeConn & Record<string, unknown> {
  const state: FakeConn = {
    largest: Array.from({ length: 12 }, () => ({ amount: '1000' })),
    supply: '1000000000',
    devHeld: 10_000_000,
    creatorSigs: [{ blockTime: Math.floor(Date.now() / 1000) - 86_400, slot: 1 }],
    mintSigs: [{ slot: 100 }, { slot: 101 }, { slot: 102 }],
    calls: [],
    ...over,
  };
  return {
    ...state,
    async getTokenLargestAccounts() {
      state.calls.push('largest');
      return { value: state.largest };
    },
    async getTokenSupply() {
      state.calls.push('supply');
      return { value: { amount: state.supply } };
    },
    async getParsedTokenAccountsByOwner() {
      state.calls.push('owner');
      return {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: state.devHeld } } } } } },
        ],
      };
    },
    async getSignaturesForAddress(addr: { toBase58(): string }) {
      const which = addr.toBase58() === DEV ? 'creatorSigs' : 'mintSigs';
      state.calls.push(which);
      return which === 'creatorSigs' ? state.creatorSigs : state.mintSigs;
    },
  } as FakeConn & Record<string, unknown>;
}

let cfg: Config;

function ctx(c: unknown, overrides: Record<string, string> = {}): CheckContext {
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
  return {
    candidate: CANDIDATE,
    conn: c as never,
    cfg,
    store: {} as never,
    cache: new Map<string, unknown>(),
  };
}

beforeEach(() => {
  cfg = loadConfig({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  } as unknown as NodeJS.ProcessEnv);
});

describe('the provenance checks at their defaults', () => {
  it('lets an ordinary fresh launch through', async () => {
    // The real hazard in turning these on is rejecting EVERYTHING, which looks
    // exactly like the bot being broken. A launch with a couple of holders, a
    // deployer still holding, a half-hour-old wallet and an unbundled creation
    // slot has to pass on the shipped defaults.
    const fresh = conn({
      largest: [{ amount: '900000000' }, { amount: '50000000' }, { amount: '10000000' }],
      devHeld: 10_000_000,
      creatorSigs: [{ blockTime: Math.floor(Date.now() / 1000) - 3600, slot: 1 }],
      mintSigs: [{ slot: 100 }, { slot: 100 }, { slot: 101 }, { slot: 104 }],
    });
    const shared = ctx(fresh);

    for (const check of [
      holderCountCheck,
      deployerStillHoldsCheck,
      creatorAgeCheck,
      launchBundleCheck,
    ]) {
      const res = await check.run(shared);
      expect(res.passed, `${check.id} rejected an ordinary launch: ${res.detail}`).toBe(true);
    }
  });

  it('can each be switched off, and then costs nothing', async () => {
    // Three of the four cost an RPC call on the entry path, and the sniper is
    // already the heaviest consumer — so turning one off has to stop the call,
    // not just ignore the answer.
    const off = {
      MIN_HOLDERS: '0',
      REJECT_IF_DEPLOYER_EXITED: 'false',
      MIN_CREATOR_AGE_MINUTES: '0',
      MAX_LAUNCH_BUNDLE_TXS: '0',
    };
    for (const check of [
      holderCountCheck,
      deployerStillHoldsCheck,
      creatorAgeCheck,
      launchBundleCheck,
    ]) {
      const c = conn();
      const res = await check.run(ctx(c, off));
      expect(res.passed, `${check.id} should pass when off`).toBe(true);
      expect(c.calls, `${check.id} should make no RPC call when off`).toEqual([]);
    }
  });

  it('spends at most three RPC calls per candidate across all four', async () => {
    // Budgeted deliberately: holder count rides along on a read the
    // concentration check already makes, so only three are new.
    const c = conn();
    const shared = ctx(c);
    for (const check of [
      holderCountCheck,
      deployerStillHoldsCheck,
      creatorAgeCheck,
      launchBundleCheck,
    ]) {
      await check.run(shared);
    }
    const distinct = new Set(c.calls);
    expect(distinct.has('owner')).toBe(true);
    expect(distinct.has('creatorSigs')).toBe(true);
    expect(distinct.has('mintSigs')).toBe(true);
    // largest + supply are the shared read, counted once between them.
    expect(c.calls.filter((x) => x === 'largest')).toHaveLength(1);
  });
});

describe('holder count', () => {
  it('rejects a token almost nobody holds', async () => {
    const res = await holderCountCheck.run(
      ctx(conn({ largest: [{ amount: '1' }, { amount: '1' }] }), { MIN_HOLDERS: '5' }),
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/only 1 holders/); // the curve itself does not count
  });

  it('passes once enough wallets hold it', async () => {
    const res = await holderCountCheck.run(ctx(conn(), { MIN_HOLDERS: '5' }));
    expect(res.passed).toBe(true);
  });

  it('shares its read with the concentration check rather than paying twice', async () => {
    const c = conn();
    const shared = ctx(c, { MIN_HOLDERS: '5' });
    await holderCountCheck.run(shared);
    await holderCountCheck.run(shared);
    expect(c.calls.filter((x) => x === 'largest')).toHaveLength(1);
  });
});

describe('deployer exited', () => {
  it('rejects when the deployer has already sold out', async () => {
    // The clearest possible statement about what happens next, and invisible
    // to any check that only reads the creation transaction.
    const res = await deployerStillHoldsCheck.run(
      ctx(conn({ devHeld: 0 }), { REJECT_IF_DEPLOYER_EXITED: 'true' }),
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/already sold/);
  });

  it('treats a dust remainder as an exit', async () => {
    const res = await deployerStillHoldsCheck.run(
      ctx(conn({ devHeld: 100 }), { REJECT_IF_DEPLOYER_EXITED: 'true' }),
    );
    expect(res.passed).toBe(false);
  });

  it('passes a deployer still holding their stake', async () => {
    const res = await deployerStillHoldsCheck.run(
      ctx(conn(), { REJECT_IF_DEPLOYER_EXITED: 'true' }),
    );
    expect(res.passed).toBe(true);
  });
});

describe('creator age', () => {
  it('rejects a wallet minted minutes ago', async () => {
    const res = await creatorAgeCheck.run(
      ctx(conn({ creatorSigs: [{ blockTime: Math.floor(Date.now() / 1000) - 600, slot: 1 }] }), {
        MIN_CREATOR_AGE_MINUTES: '60',
      }),
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/10m old/);
  });

  it('passes an established wallet', async () => {
    const res = await creatorAgeCheck.run(ctx(conn(), { MIN_CREATOR_AGE_MINUTES: '60' }));
    expect(res.passed).toBe(true);
  });

  it('treats a full page of history as old enough without paginating', async () => {
    const many = Array.from({ length: 1000 }, () => ({ blockTime: null, slot: 1 }));
    const res = await creatorAgeCheck.run(
      ctx(conn({ creatorSigs: many }), { MIN_CREATOR_AGE_MINUTES: '60' }),
    );
    expect(res.passed).toBe(true);
  });

  it('rejects a wallet with no history at all', async () => {
    const res = await creatorAgeCheck.run(
      ctx(conn({ creatorSigs: [] }), { MIN_CREATOR_AGE_MINUTES: '60' }),
    );
    expect(res.passed).toBe(false);
  });
});

describe('launch bundle', () => {
  it('rejects a launch whose first buys all landed together', async () => {
    const bundled = Array.from({ length: 8 }, () => ({ slot: 100 }));
    const res = await launchBundleCheck.run(
      ctx(conn({ mintSigs: [...bundled, { slot: 105 }] }), { MAX_LAUNCH_BUNDLE_TXS: '4' }),
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/8 transactions in the creation slot/);
  });

  it('passes interest that arrived across slots', async () => {
    const spread = Array.from({ length: 20 }, (_, i) => ({ slot: 100 + i }));
    const res = await launchBundleCheck.run(
      ctx(conn({ mintSigs: spread }), { MAX_LAUNCH_BUNDLE_TXS: '4' }),
    );
    expect(res.passed).toBe(true);
  });
});
