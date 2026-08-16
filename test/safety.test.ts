import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { SafetyEngine } from '../src/safety/engine.js';
import type { Check } from '../src/safety/types.js';
import { freezeAuthorityCheck, mintAuthorityCheck } from '../src/safety/checks/authorities.js';
import { devBuyCheck } from '../src/safety/checks/supply.js';
import { deployerHistoryCheck } from '../src/safety/checks/deployer.js';
import { metadataSanityCheck, socialsCheck } from '../src/safety/checks/metadata.js';
import { createThrottledFetch, rpcBackpressureMs } from '../src/util/rpc-throttle.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TokenCandidate } from '../src/types.js';

const BASE_ENV = {
  RPC_HTTP_URL: 'https://rpc.example.com',
  RPC_WS_URL: 'wss://rpc.example.com',
  MODE: 'paper',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  MIN_SAFETY_SCORE: '70',
  MAX_DEV_BUY_PCT: '8',
} as unknown as NodeJS.ProcessEnv;

let dir: string;
let store: Store;
let cfg: Config;
const fakeConn = {} as Connection;

function candidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    mint: 'Mint1111111111111111111111111111111111111',
    creator: 'Dev11111111111111111111111111111111111111',
    name: 'Test Token',
    symbol: 'TEST',
    pool: 'pump',
    detectedAt: Date.now(),
    source: 'test',
    ...overrides,
  };
}

function ctxFor(c: TokenCandidate) {
  return { candidate: c, conn: fakeConn, cfg, store, cache: new Map<string, unknown>() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-safety-'));
  cfg = loadConfig({ ...BASE_ENV, DATA_DIR: dir });
  store = new Store(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('devBuyCheck', () => {
  it('passes when the deployer takes nothing', async () => {
    const r = await devBuyCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('passes a modest deployer stake', async () => {
    // 2% of the 1B supply.
    const r = await devBuyCheck.run(ctxFor(candidate({ initialBuyTokens: 20_000_000 })));
    expect(r.passed).toBe(true);
  });

  it('rejects a deployer who front-loads a large slice of supply', async () => {
    // 25% of supply — everyone who buys after this is exit liquidity.
    const r = await devBuyCheck.run(ctxFor(candidate({ initialBuyTokens: 250_000_000 })));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/25\.0% of supply/);
  });

  it('is fatal, so it vetoes regardless of score', () => {
    expect(devBuyCheck.severity).toBe('fatal');
  });
});

describe('deployerHistoryCheck', () => {
  it('is permissive without a meaningful sample', async () => {
    store.recordCreatorLaunch('Dev11111111111111111111111111111111111111', 'm1');
    store.recordCreatorOutcome('Dev11111111111111111111111111111111111111', true);
    const r = await deployerHistoryCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('rejects a deployer with a proven rug rate', async () => {
    const dev = 'Dev11111111111111111111111111111111111111';
    for (let i = 0; i < 5; i++) store.recordCreatorLaunch(dev, `m${i}`);
    for (let i = 0; i < 4; i++) store.recordCreatorOutcome(dev, true);
    store.recordCreatorOutcome(dev, false);

    const r = await deployerHistoryCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/rugged 4\/5/);
  });
});

describe('metadataSanityCheck', () => {
  it('accepts an ordinary ticker', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate()));
    expect(r.passed).toBe(true);
  });

  it('rejects Cyrillic homoglyph impersonation', async () => {
    // "ВОNK" — the В and О are Cyrillic, so it renders as BONK in a list.
    const r = await metadataSanityCheck.run(ctxFor(candidate({ symbol: 'ВОNK' })));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/homoglyph/);
  });

  it('rejects zero-width character padding', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate({ name: 'Sol​ana' })));
    expect(r.passed).toBe(false);
  });

  it('rejects an absurdly long name', async () => {
    const r = await metadataSanityCheck.run(ctxFor(candidate({ name: 'x'.repeat(200) })));
    expect(r.passed).toBe(false);
  });
});

describe('SafetyEngine scoring', () => {
  const passing = (id: string, penalty = 20): Check => ({
    id,
    severity: 'major',
    penalty,
    timeoutMs: 100,
    failClosed: false,
    run: async () => ({ passed: true, detail: 'ok' }),
  });
  const failing = (id: string, penalty = 20, severity: Check['severity'] = 'major'): Check => ({
    id,
    severity,
    penalty,
    timeoutMs: 100,
    failClosed: false,
    run: async () => ({ passed: false, detail: 'nope' }),
  });

  it('passes a clean token with a full score', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), passing('b')]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(100);
    expect(v.passed).toBe(true);
  });

  it('deducts penalties and rejects below the threshold', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [failing('a', 20), failing('b', 25)]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(55);
    expect(v.passed).toBe(false);
    expect(v.rejectedBy).toBe('score_threshold');
  });

  it('lets a single minor failure through', async () => {
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), failing('b', 20)]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(80);
    expect(v.passed).toBe(true);
  });

  it('vetoes on a fatal failure even at a perfect score', async () => {
    const fatal: Check = {
      id: 'freeze',
      severity: 'fatal',
      penalty: 0,
      timeoutMs: 100,
      failClosed: true,
      run: async () => ({ passed: false, detail: 'freeze authority live' }),
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [passing('a'), fatal]);
    const v = await engine.evaluate(candidate());
    expect(v.score).toBe(100);
    expect(v.passed).toBe(false);
    expect(v.rejectedBy).toBe('freeze');
  });

  it('treats an errored fail-closed check as a failure', async () => {
    const exploding: Check = {
      id: 'exploding',
      severity: 'fatal',
      penalty: 0,
      timeoutMs: 50,
      failClosed: true,
      run: async () => {
        throw new Error('rpc down');
      },
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [exploding]);
    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(false);
    expect(v.results[0]!.errored).toBe(true);
  });

  it('lets an errored fail-open check degrade to a pass', async () => {
    const flaky: Check = {
      id: 'flaky',
      severity: 'major',
      penalty: 20,
      timeoutMs: 50,
      failClosed: false,
      run: async () => {
        throw new Error('rpc hiccup');
      },
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [flaky]);
    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(true);
    expect(v.results[0]!.errored).toBe(true);
  });

  it('times out a hanging check rather than missing the entry window', async () => {
    const hanging: Check = {
      id: 'hanging',
      severity: 'major',
      penalty: 10,
      timeoutMs: 50,
      failClosed: true,
      run: () => new Promise(() => {}),
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [hanging]);
    const started = Date.now();
    const v = await engine.evaluate(candidate());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(v.results[0]!.passed).toBe(false);
  });
});

describe('socialsCheck', () => {
  // No network is reachable from these, which is the point: every case below is
  // decided before a request would be made, or by a request that cannot succeed.
  const ctxWithUri = (uri?: string) => ({
    candidate: candidate({ uri }),
    conn: fakeConn,
    cfg,
    store,
    cache: new Map(),
  });

  it('says the launch declared nothing, rather than blaming the host', async () => {
    // This was the reported message. It read as "your allowlist rejected the
    // host" on launches that had never named one — and on `DISCOVERY_SOURCE=rpc`
    // that was every single launch, because the feed did not carry the URI.
    const r = await socialsCheck.run(ctxWithUri(undefined));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/declares no metadata URI/);
  });

  it('names the host when the deployer picked one we will not fetch', async () => {
    const r = await socialsCheck.run(ctxWithUri('https://evil.example.com/meta.json'));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not an allowed https gateway/);
  });

  it('refuses plain http even on an allowlisted gateway', async () => {
    const r = await socialsCheck.run(ctxWithUri('http://ipfs.io/ipfs/abc'));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not an allowed https gateway/);
  });

  it('rejects a host that merely ends with an allowlisted name', async () => {
    const r = await socialsCheck.run(ctxWithUri('https://evil-ipfs.io/ipfs/abc'));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not an allowed https gateway/);
  });

  it('does not penalise a launch for a gateway that will not answer', async () => {
    // The inversion this fixes: charging the token 20 points because a public
    // IPFS gateway rate-limited us makes the filter stricter the worse our own
    // connectivity is, which is exactly backwards.
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    try {
      const r = await socialsCheck.run(ctxWithUri('https://ipfs.io/ipfs/abc'));
      expect(r.passed).toBe(true);
      expect(r.detail).toMatch(/not held against the launch/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('penalises a document that loaded and genuinely has no links', async () => {
    // The other side of the same coin: a gateway that answered is evidence, and
    // "read it, there is nothing there" must stay a failure.
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ description: 'nothing here' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const r = await socialsCheck.run(ctxWithUri('https://ipfs.io/ipfs/abc'));
      expect(r.passed).toBe(false);
      expect(r.detail).toMatch(/no twitter\/telegram\/website/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('stays out of the way entirely when the requirement is off', async () => {
    const off = loadConfig({ ...BASE_ENV, DATA_DIR: dir, REQUIRE_SOCIALS: 'false' });
    const r = await socialsCheck.run({
      candidate: candidate(),
      conn: fakeConn,
      cfg: off,
      store,
      cache: new Map(),
    });
    expect(r.passed).toBe(true);
  });
});

describe('authority checks', () => {
  // A real base58 key: unlike the other fixtures, this one is turned into a
  // PublicKey by the code under test.
  const MINT = '6ChE3ZP9BjmGXBTzQLcRDZ72bpmTLmHsgYdCCpdLqunF';

  /** A real 82-byte SPL mint account, so the decode path is genuinely exercised. */
  function mintAccount(
    opts: { mintAuthority?: PublicKey | null; freezeAuthority?: PublicKey | null } = {},
    owner: PublicKey = TOKEN_PROGRAM_ID,
  ): AccountInfo<Buffer> {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: opts.mintAuthority ? 1 : 0,
        mintAuthority: opts.mintAuthority ?? PublicKey.default,
        supply: 1_000_000_000_000_000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
        freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
      },
      data,
    );
    return { owner, data, executable: false, lamports: 1, rentEpoch: 0 };
  }

  /** Connection stub that counts reads and records the commitment asked for. */
  function connReturning(...responses: Array<AccountInfo<Buffer> | null>) {
    const commitments: unknown[] = [];
    let calls = 0;
    const conn = {
      getAccountInfo: async (_k: PublicKey, commitment?: unknown) => {
        commitments.push(commitment);
        return responses[Math.min(calls++, responses.length - 1)] ?? null;
      },
    } as unknown as Connection;
    return { conn, commitments, reads: () => calls };
  }

  function ctxWith(conn: Connection) {
    return { candidate: candidate({ mint: MINT }), conn, cfg, store, cache: new Map() };
  }

  it('reads the mint at processed, because that is where discovery found it', async () => {
    // Discovery subscribes at `processed` on purpose. Reading back at the
    // connection default of `confirmed` asks the node about an account it has
    // not admitted to yet — and since these checks fail closed, "no such
    // account" vetoed the buy. The faster we saw the launch, the more certain
    // the rejection.
    const { conn, commitments } = connReturning(mintAccount());
    const r = await freezeAuthorityCheck.run(ctxWith(conn));
    expect(r.passed).toBe(true);
    expect(commitments[0]).toBe('processed');
  });

  it('looks a second time before calling a fresh mint missing', async () => {
    // A feed running off someone else's node can be a slot ahead of ours.
    const { conn, reads } = connReturning(null, mintAccount());
    const r = await mintAuthorityCheck.run(ctxWith(conn));
    expect(r.passed).toBe(true);
    expect(reads()).toBe(2);
  });

  it('fails closed on a mint that never appears, and says why', async () => {
    const { conn } = connReturning(null, null);
    await expect(freezeAuthorityCheck.run(ctxWith(conn))).rejects.toThrow(/does not exist/);
  });

  it('reads a Token-2022 mint the endpoint may not parse', async () => {
    // jsonParsed depends on the endpoint recognising the program. When it does
    // not, the account arrives as raw base64 and the old code called an
    // ordinary mint "not an SPL mint" and vetoed it.
    const { conn } = connReturning(mintAccount({}, TOKEN_2022_PROGRAM_ID));
    const r = await freezeAuthorityCheck.run(ctxWith(conn));
    expect(r.passed).toBe(true);
  });

  it('catches a live freeze authority — the cleanest honeypot there is', async () => {
    const attacker = new PublicKey('So11111111111111111111111111111111111111112');
    const { conn } = connReturning(mintAccount({ freezeAuthority: attacker }));
    const r = await freezeAuthorityCheck.run(ctxWith(conn));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/freeze/);
  });

  it('catches a live mint authority', async () => {
    const attacker = new PublicKey('So11111111111111111111111111111111111111112');
    const { conn } = connReturning(mintAccount({ mintAuthority: attacker }));
    const r = await mintAuthorityCheck.run(ctxWith(conn));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/inflated/);
  });

  it('rejects an address that is not a token account at all', async () => {
    const notAMint = {
      owner: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.alloc(0),
      executable: false,
      lamports: 1,
      rentEpoch: 0,
    };
    const { conn } = connReturning(notAMint);
    await expect(freezeAuthorityCheck.run(ctxWith(conn))).rejects.toThrow(/not a token program/);
  });

  it('reads the mint once for both checks', async () => {
    // Two fatal checks, one account. The shared cache is what keeps the battery
    // at four RPC calls rather than five.
    const { conn, reads } = connReturning(mintAccount());
    const ctx = ctxWith(conn);
    await Promise.all([freezeAuthorityCheck.run(ctx), mintAuthorityCheck.run(ctx)]);
    expect(reads()).toBe(1);
  });
});

describe('SafetyEngine cost control', () => {
  const local = (id: string, passed: boolean, penalty = 20): Check => ({
    id,
    severity: 'major',
    penalty,
    timeoutMs: 50,
    failClosed: false,
    cost: 'local',
    run: async () => ({ passed, detail: passed ? 'ok' : 'nope' }),
  });

  /** Records whether it ran at all — the whole point of the phase split. */
  const paid = (id: string, ran: { yes: boolean }): Check => ({
    id,
    severity: 'major',
    penalty: 10,
    timeoutMs: 50,
    failClosed: false,
    cost: 'rpc',
    run: async () => {
      ran.yes = true;
      return { passed: true, detail: 'ok' };
    },
  });

  it('spends no RPC on a launch the free checks have already rejected', async () => {
    // At peak, pump.fun deploys several tokens a second and most are copycat or
    // serial-launcher spam the local checks already condemn. Paying four RPC
    // calls to confirm a rejection we had made takes quota straight from the
    // sells of positions we are actually holding.
    const ran = { yes: false };
    const engine = new SafetyEngine(cfg, fakeConn, store, [
      local('duplicate_name', false, 25),
      local('deployer_spam', false, 30),
      paid('mint_authority', ran),
    ]);

    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(false);
    expect(v.shortCircuited).toBe(true);
    expect(ran.yes).toBe(false);
    expect(v.results).toHaveLength(2);
  });

  it('still runs the paid checks when the free ones leave it open', async () => {
    const ran = { yes: false };
    const engine = new SafetyEngine(cfg, fakeConn, store, [
      local('duplicate_name', true),
      paid('mint_authority', ran),
    ]);

    const v = await engine.evaluate(candidate());
    expect(v.passed).toBe(true);
    expect(v.shortCircuited).toBeFalsy();
    expect(ran.yes).toBe(true);
  });

  it('does not short-circuit on a penalty the threshold can absorb', async () => {
    // The rule is only sound because the remaining checks can only subtract. A
    // launch still able to clear the threshold has not been decided yet.
    const ran = { yes: false };
    const engine = new SafetyEngine(cfg, fakeConn, store, [
      local('duplicate_name', false, 100 - cfg.MIN_SAFETY_SCORE),
      paid('mint_authority', ran),
    ]);

    const v = await engine.evaluate(candidate());
    expect(ran.yes).toBe(true);
    expect(v.score).toBe(cfg.MIN_SAFETY_SCORE);
    expect(v.passed).toBe(true);
  });

  it('short-circuits immediately on a fatal free check', async () => {
    const ran = { yes: false };
    const engine = new SafetyEngine(cfg, fakeConn, store, [
      { ...local('dev_buy_share', false), severity: 'fatal', penalty: 100 },
      paid('creator_age', ran),
    ]);

    const v = await engine.evaluate(candidate());
    expect(v.rejectedBy).toBe('dev_buy_share');
    expect(ran.yes).toBe(false);
  });

  it('treats an unclassified check as costing something', async () => {
    // Conservative default: a check that has not said what it costs must not be
    // promoted into the free phase, where a stray RPC call would be spent on
    // every launch including the ones being thrown away.
    const ran = { yes: false };
    const unclassified: Check = {
      id: 'legacy',
      severity: 'major',
      penalty: 10,
      timeoutMs: 50,
      failClosed: false,
      run: async () => {
        ran.yes = true;
        return { passed: true, detail: 'ok' };
      },
    };
    const engine = new SafetyEngine(cfg, fakeConn, store, [
      local('duplicate_name', false, 100),
      unclassified,
    ]);

    await engine.evaluate(candidate());
    expect(ran.yes).toBe(false);
  });

  it('gives a queued RPC check the time it spent waiting, on top of its budget', async () => {
    // The reported failure: "mint_authority timed out after 1500ms" on a mint
    // read that never got to leave the queue. Charging a check for the
    // throttle's backlog turns congestion into a fail-closed rejection.
    const f = createThrottledFetch(
      { maxConcurrent: 1, maxPerSecond: 0, maxRetries: 0 },
      (async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { status: 200, headers: { get: () => null } } as unknown as Response;
      }) as unknown as typeof fetch,
    );
    // Build a backlog so there is measurable backpressure to allow for.
    await Promise.all(Array.from({ length: 8 }, () => f('http://rpc.test')));
    expect(rpcBackpressureMs()).toBeGreaterThan(150);

    const slow: Check = {
      id: 'mint_authority',
      severity: 'fatal',
      penalty: 100,
      timeoutMs: 60,
      failClosed: true,
      cost: 'rpc',
      run: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { passed: true, detail: 'revoked' };
      },
    };

    const v = await new SafetyEngine(cfg, fakeConn, store, [slow]).evaluate(candidate());
    // 120ms of work against a 60ms budget: without the allowance this is a
    // timeout, and because it fails closed, a rejected launch.
    expect(v.results[0]!.errored).toBeFalsy();
    expect(v.passed).toBe(true);
  });
});
