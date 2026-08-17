import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArbBot,
  arbNote,
  categoriseReject,
  edgeBucket,
  lamportsToSol,
  solToLamports,
} from '../src/arb/bot.js';
import { JupiterClient, NoRouteError } from '../src/arb/jupiter.js';
import {
  ATA_RENT_LAMPORTS,
  breakEvenSize,
  estimateCosts,
  evaluateCycle,
} from '../src/arb/profit.js';
import { PaperArbExecutor } from '../src/arb/paper.js';
import { ArbRiskManager } from '../src/arb/risk.js';
import { Scanner } from '../src/arb/scanner.js';
import { resolveToken, WSOL } from '../src/arb/tokens.js';
import { fromBaseUnits, toBaseUnits, toBps } from '../src/arb/decimal.js';
import { TUNABLE_BY_KEY, vetProposal } from '../src/tuner/limits.js';
import { buildEvidence } from '../src/tuner/evidence.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Opportunity, Quote, Token } from '../src/arb/types.js';

const USDC: Token = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  decimals: 6,
};

let dir: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    BOT_ARB_ENABLED: 'true',
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function quote(over: Partial<Quote> = {}): Quote {
  return {
    inputMint: WSOL.mint,
    outputMint: USDC.mint,
    inAmount: 1_000_000_000n,
    outAmount: 200_000_000n,
    otherAmountThreshold: 199_000_000n,
    priceImpactPct: 0.0005,
    slippageBps: 50,
    marketLabels: ['Orca'],
    fetchedAt: 1_000,
    ...over,
  };
}

/** A round trip returning `outBps` more SOL than it started with, before costs. */
function cycle(inLamports: bigint, outBps: number, at = 1_000): Quote[] {
  const out = (inLamports * BigInt(10_000 + outBps)) / 10_000n;
  return [
    quote({ inAmount: inLamports, outAmount: 200_000_000n, fetchedAt: at }),
    quote({
      inputMint: USDC.mint,
      outputMint: WSOL.mint,
      inAmount: 200_000_000n,
      outAmount: out,
      otherAmountThreshold: (out * 9_950n) / 10_000n,
      fetchedAt: at,
    }),
  ];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arb-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fixed-point amounts', () => {
  it('never loses precision converting SOL to lamports and back', () => {
    // Every amount here is a bigint in base units for exactly this reason: an
    // arbitrage edge is basis points on a round trip, which is the same order as
    // float error at nine decimals.
    expect(solToLamports(0.5)).toBe(500_000_000n);
    expect(solToLamports(1e-7)).toBe(100n);
    expect(lamportsToSol(500_000_000n)).toBe(0.5);
    expect(toBaseUnits('0.000000001', 9)).toBe(1n);
  });

  it('truncates rather than rounding up', () => {
    // Over-reporting an input we do not have produces a transaction that fails
    // on-chain, so the rounding direction is not a matter of taste.
    expect(toBaseUnits('1.9999999999', 9)).toBe(1_999_999_999n);
  });

  it('renders base units without exponent notation', () => {
    expect(fromBaseUnits(1n, 9, 9)).toBe('0.000000001');
    expect(fromBaseUnits(-500_000_000n, 9, 4)).toBe('-0.5');
  });

  it('measures basis points against the input', () => {
    expect(toBps(100n, 10_000n)).toBeCloseTo(100, 6);
    expect(toBps(-50n, 10_000n)).toBeCloseTo(-50, 6);
  });
});

describe('cost model', () => {
  it('charges fees PER LEG, because a cycle is two transactions', () => {
    // The aggregator refuses a quote whose input and output mint match, so the
    // round trip cannot be one transaction. Charging once is the single most
    // common reason a scanner reports an edge it does not have.
    const one = estimateCosts({
      legs: 1,
      priorityFeeMicroLamports: 50_000,
      computeUnitLimit: 300_000,
      includeAtaRent: false,
    });
    const two = estimateCosts({
      legs: 2,
      priorityFeeMicroLamports: 50_000,
      computeUnitLimit: 300_000,
      includeAtaRent: false,
    });
    expect(two.totalLamports).toBe(one.totalLamports * 2n);
    expect(two.baseFeeLamports).toBe(10_000n);
    expect(two.priorityFeeLamports).toBe(30_000n);
  });

  it('adds token-account rent once, not per leg', () => {
    const withRent = estimateCosts({
      legs: 2,
      priorityFeeMicroLamports: 0,
      computeUnitLimit: 300_000,
      includeAtaRent: true,
    });
    expect(withRent.rentLamports).toBe(ATA_RENT_LAMPORTS);
  });

  it('gives the size below which winning trades still lose money', () => {
    // Fees are fixed per attempt and the edge scales with size, so there is a
    // size below which the strategy is structurally unprofitable however good
    // the routing is. This is the number to check before funding anything.
    const cost = 40_000n;
    expect(breakEvenSize(cost, 30)).toBe((cost * 10_000n) / 30n);
    expect(breakEvenSize(cost, 0)).toBeNull();
    expect(breakEvenSize(cost, -5)).toBeNull();
  });
});

describe('cycle evaluation', () => {
  const costs = estimateCosts({
    legs: 2,
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 300_000,
    includeAtaRent: false,
  });

  const evaluate = (legs: Quote[], over: Record<string, unknown> = {}) =>
    evaluateCycle({
      baseToken: WSOL,
      legs,
      costs,
      minProfitBps: 30,
      maxPriceImpactPct: 0.5,
      ...over,
    });

  it('accepts a loop that clears the floor after costs', () => {
    const v = evaluate(cycle(1_000_000_000n, 100));
    expect(v.profitable).toBe(true);
    expect(v.netProfitBps).toBeGreaterThan(30);
  });

  it('rejects a loop that only profits before costs', () => {
    // 2bps gross on 1 SOL is 200,000 lamports against 40,000 of fees, so this
    // one does clear — 1bps does not. The point is the fee is subtracted first.
    const v = evaluate(cycle(1_000_000_000n, 1));
    expect(v.profitable).toBe(false);
    expect(v.rejectReason).toMatch(/below floor|negative net edge/);
  });

  it('rejects a loop whose price impact exceeds the cap', () => {
    const legs = cycle(1_000_000_000n, 200);
    const v = evaluate([legs[0]!, { ...legs[1]!, priceImpactPct: 0.02 }]);
    expect(v.profitable).toBe(false);
    expect(v.rejectReason).toMatch(/price impact/);
  });

  it('can require the WORST case to profit, not just the expected case', () => {
    // The addition that turns a scanner into a bot. On a thin route the expected
    // output and the on-chain minimum differ by more than the whole edge, so the
    // trade is modelled profitable and can only ever land at a loss.
    const legs = cycle(1_000_000_000n, 60);
    const thin = [legs[0]!, { ...legs[1]!, otherAmountThreshold: 900_000_000n }];

    expect(evaluate(thin).profitable).toBe(true);
    const strict = evaluate(thin, { requireWorstCaseProfit: true });
    expect(strict.profitable).toBe(false);
    expect(strict.rejectReason).toMatch(/worst case/);
  });

  it('refuses a cycle that does not close', () => {
    expect(() => evaluate([quote()])).toThrow(/must end in SOL/);
  });

  it('refuses non-contiguous legs', () => {
    const legs = cycle(1_000_000_000n, 60);
    expect(() =>
      evaluate([legs[0]!, { ...legs[1]!, inputMint: 'SomeOtherMint11111111111111' }]),
    ).toThrow(/not contiguous/);
  });

  it('refuses a base token that is not SOL', () => {
    // Costs are incurred in SOL whatever is traded, and this bot has no price
    // source to convert them. Refusing beats silently mispricing every cycle.
    expect(() =>
      evaluateCycle({
        baseToken: USDC,
        legs: [
          quote({ inputMint: USDC.mint, outputMint: WSOL.mint }),
          quote({ inputMint: WSOL.mint, outputMint: USDC.mint }),
        ],
        costs,
        minProfitBps: 30,
        maxPriceImpactPct: 0.5,
      }),
    ).toThrow(/must be SOL/);
  });
});

describe('the paper simulator', () => {
  const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
    id: 'opp-1',
    strategy: 'cycle',
    baseToken: WSOL,
    quoteToken: USDC,
    legs: cycle(1_000_000_000n, 100),
    amountIn: 1_000_000_000n,
    grossOut: 1_010_000_000n,
    costLamports: 40_000n,
    netProfit: 9_960_000n,
    netProfitBps: 99.6,
    worstCaseNetProfit: 5_000_000n,
    maxPriceImpactPct: 0.0005,
    quoteAgeMs: 500,
    discoveredAt: 1_000,
    ...over,
  });

  const executor = (over: Record<string, number> = {}, random = () => 1) =>
    new PaperArbExecutor({
      adverseSlippageBps: 10,
      legFailureRate: 0,
      unwindRecoveryPct: 97,
      random,
      now: () => 2_000,
      ...over,
    });

  it('fills below the quote, because the quote is not the fill', async () => {
    const r = await executor().execute(opportunity());
    expect(r.status).toBe('filled');
    expect(r.realisedProfit).toBeLessThan(opportunity().netProfit);
  });

  it('charges the fee when leg one never lands', async () => {
    const r = await executor({ legFailureRate: 1 }, () => 0).execute(opportunity());
    expect(r.status).toBe('failed');
    expect(r.realisedProfit).toBe(-40_000n);
    expect(r.fills).toHaveLength(0);
  });

  it('models a HALF-COMPLETED round trip, which is the outcome that hurts', async () => {
    // The original simulator could only produce "nothing happened" or "both legs
    // filled", so its worst modelled loss was the fees. A two-leg cycle is not
    // atomic: leg one lands, leg two does not, and the bot is holding the
    // intermediate token. That risks the whole position, not the fee.
    let call = 0;
    const exec = executor({ legFailureRate: 0.5, unwindRecoveryPct: 90 }, () =>
      call++ === 0 ? 0.9 : 0.1,
    );
    const r = await exec.execute(opportunity());

    expect(r.status).toBe('partial-unwound');
    // 10% of a 1 SOL position, plus the fees — two orders of magnitude worse
    // than the fee-only failure above.
    expect(r.realisedProfit).toBeLessThan(-90_000_000n);
    expect(r.error).toMatch(/leg 2 did not land/);
  });

  it('tracks its own drift, so the paper balance can move with the config', async () => {
    const exec = executor();
    const before = exec.drift;
    await exec.execute(opportunity());
    expect(exec.drift).toBeGreaterThan(before);
  });
});

describe('the risk gate', () => {
  const limits = {
    maxDailyLossLamports: 100_000_000n,
    maxConsecutiveFailures: 3,
    routeCooldownMs: 60_000,
    maxTradesPerHour: 2,
    minReserveLamports: 50_000_000n,
    tradeSizeLamports: 1_000_000_000n,
  };

  const opp: Opportunity = {
    id: 'o',
    strategy: 'cycle',
    baseToken: WSOL,
    quoteToken: USDC,
    legs: cycle(1_000_000_000n, 100),
    amountIn: 1_000_000_000n,
    grossOut: 1_010_000_000n,
    costLamports: 40_000n,
    netProfit: 9_960_000n,
    netProfitBps: 99.6,
    worstCaseNetProfit: 1n,
    maxPriceImpactPct: 0.001,
    quoteAgeMs: 100,
    discoveredAt: 0,
  };

  it('requires the size plus the reserve to be covered', () => {
    const risk = new ArbRiskManager(limits, () => 0);
    expect(risk.check(opp, 1_049_000_000n).allowed).toBe(false);
    expect(risk.check(opp, 1_050_000_000n).allowed).toBe(true);
  });

  it('cools a route down after trading it', () => {
    // The limit that matters most: a dislocation that looked profitable and was
    // not will still look profitable on the very next scan, so without this the
    // bot repeats one bad trade as fast as it can quote it.
    let now = 0;
    const risk = new ArbRiskManager(limits, () => now);
    risk.record({
      opportunityId: 'o',
      strategy: 'cycle',
      route: 'r',
      quoteSymbol: 'USDC',
      quoteMint: USDC.mint,
      status: 'filled',
      amountIn: 1_000_000_000n,
      amountOut: 1_000_000_000n,
      realisedProfit: 1n,
      costLamports: 40_000n,
      expectedProfit: 1n,
      expectedBps: 1,
      maxPriceImpactPct: 0,
      quoteAgeMs: 0,
      fills: [],
      startedAt: 0,
      finishedAt: 0,
    });

    expect(risk.check(opp, 10_000_000_000n).allowed).toBe(false);
    now = 60_001;
    expect(risk.check(opp, 10_000_000_000n).allowed).toBe(true);
  });

  it('halts on a failure streak and does not un-halt with the calendar', () => {
    let now = 0;
    const risk = new ArbRiskManager(limits, () => now);
    const failure = {
      opportunityId: 'o',
      strategy: 'cycle' as const,
      route: 'r',
      quoteSymbol: 'USDC',
      quoteMint: USDC.mint,
      status: 'failed' as const,
      amountIn: 0n,
      amountOut: 0n,
      realisedProfit: -1n,
      costLamports: 0n,
      expectedProfit: 0n,
      expectedBps: 0,
      maxPriceImpactPct: 0,
      quoteAgeMs: 0,
      fills: [],
      startedAt: 0,
      finishedAt: 0,
    };
    for (let k = 0; k < 3; k++) risk.record(failure);
    expect(risk.halted).toBe(true);

    // A streak usually means a broken assumption, and time does not fix that.
    now = 25 * 60 * 60 * 1000;
    expect(risk.check(opp, 10_000_000_000n).allowed).toBe(false);
  });

  it('caps attempts per hour', () => {
    const risk = new ArbRiskManager(limits, () => 0);
    risk.recordAttempt();
    risk.recordAttempt();
    expect(risk.check(opp, 10_000_000_000n).allowed).toBe(false);
  });
});

describe('the scanner', () => {
  /** A client that answers from a table, so no network is involved. */
  function stubClient(outFor: (input: string, output: string, amount: bigint) => bigint | null) {
    return {
      rateLimited: 0,
      quote: async (req: {
        inputMint: string;
        outputMint: string;
        amount: bigint;
        slippageBps: number;
      }): Promise<Quote> => {
        const out = outFor(req.inputMint, req.outputMint, req.amount);
        if (out === null) throw new NoRouteError(req.inputMint, req.outputMint);
        return quote({
          inputMint: req.inputMint,
          outputMint: req.outputMint,
          inAmount: req.amount,
          outAmount: out,
          otherAmountThreshold: (out * 9_990n) / 10_000n,
          fetchedAt: 1_000,
        });
      },
    } as unknown as JupiterClient;
  }

  const options = (over: Record<string, unknown> = {}) => ({
    baseToken: WSOL,
    candidateTokens: [USDC],
    tradeSize: 1_000_000_000n,
    slippageBps: 50,
    minProfitBps: 30,
    maxPriceImpactPct: 0.5,
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 300_000,
    assumeAtaCreation: false,
    quoteMaxAgeMs: 5_000,
    requireWorstCaseProfit: false,
    strategies: ['cycle'] as const,
    now: () => 1_000,
    ...over,
  });

  it('finds a loop that pays after costs', async () => {
    const client = stubClient((input, _output, amount) =>
      input === WSOL.mint ? 200_000_000n : (amount * 1_010n) / 200n,
    );
    const scan = await new Scanner({ ...options(), client } as never).scan();

    expect(scan.opportunities).toHaveLength(1);
    expect(scan.opportunities[0]!.netProfitBps).toBeGreaterThan(30);
    expect(scan.quotesFetched).toBe(2);
  });

  it('records the rejects, which is what says where the floor belongs', async () => {
    const client = stubClient((input, _output, amount) =>
      input === WSOL.mint ? 200_000_000n : (amount * 1_000n) / 200n,
    );
    const scan = await new Scanner({ ...options(), client } as never).scan();

    expect(scan.opportunities).toHaveLength(0);
    expect(scan.evaluated).toHaveLength(1);
    expect(scan.evaluated[0]!.rejectReason).toBeTruthy();
  });

  it('discards a loop whose quotes aged out before the profit was believed', async () => {
    // Staleness is checked BEFORE the verdict is trusted. Legs are quoted in
    // sequence and the free tier spaces them over a second, so on this endpoint
    // an aged leg is the common case rather than the rare one.
    const client = stubClient((input, _output, amount) =>
      input === WSOL.mint ? 200_000_000n : (amount * 1_100n) / 200n,
    );
    const scan = await new Scanner({
      ...options({ quoteMaxAgeMs: 100, now: () => 9_000 }),
      client,
    } as never).scan();

    expect(scan.opportunities).toHaveLength(0);
    expect(scan.evaluated[0]!.rejectReason).toMatch(/stale/);
  });

  it('treats a pair with no route as ordinary, not as an error', async () => {
    const client = stubClient(() => null);
    const scan = await new Scanner({ ...options(), client } as never).scan();
    expect(scan.opportunities).toHaveLength(0);
    expect(scan.errors).toHaveLength(1);
  });
});

describe('token resolution', () => {
  it('accepts a known symbol', () => {
    expect(resolveToken('usdc').mint).toBe(USDC.mint);
  });

  it('refuses a bare mint rather than guessing decimals', () => {
    // A wrong decimals value silently mis-scales every amount by orders of
    // magnitude, which is the worst kind of bug this codebase can have.
    expect(() => resolveToken(USDC.mint.replace('EPjF', 'AAAA'))).toThrow(/specify decimals/);
  });

  it('accepts mint:decimals for anything unlisted', () => {
    const token = resolveToken(`${USDC.mint.replace('EPjF', 'AAAA')}:9`);
    expect(token.decimals).toBe(9);
  });
});

describe('the arbitrage bot', () => {
  it('starts disabled, and says nothing is configured for SOL alone', () => {
    const bot = new ArbBot({ cfg: loadConfig(env({ ARB_TOKENS: 'SOL' })), dataDir: dir, killSwitchPath: 'STOP' });
    // SOL -> SOL is not a cycle and the aggregator refuses it outright.
    expect(bot.view().tokens).toEqual([]);
    bot.store.close();
  });

  it('reports the break-even size so an unfundable config is visible', () => {
    const bot = new ArbBot({
      cfg: loadConfig(env({ ARB_TRADE_SIZE_SOL: '0.01', ARB_MIN_PROFIT_BPS: '30' })),
      dataDir: dir,
      killSwitchPath: 'STOP',
    });
    const view = bot.view();
    expect(view.breakEvenSizeSol).not.toBeNull();
    // 0.01 SOL cannot cover two legs of priority fee at a 30bps edge.
    expect(view.breakEvenSizeSol!).toBeGreaterThan(view.tradeSizeSol);
    bot.store.close();
  });

  it('writes each round trip to the shared journal, which is what the tuner reads', async () => {
    // The whole integration. The tuner knows nothing about arbitrage — it reads
    // Store.journal() per bot — so recording in the shared shape is what puts
    // this strategy inside the same measure-and-revert loop as the others.
    const cfg = loadConfig(env({ ARB_MIN_PROFIT_BPS: '10', ARB_TRADE_SIZE_SOL: '1' }));
    const bot = new ArbBot({
      cfg,
      dataDir: dir,
      killSwitchPath: 'STOP',
      random: () => 1, // never fail a leg
      client: {
        rateLimited: 0,
        quote: async (req: { inputMint: string; amount: bigint }) =>
          quote({
            inputMint: req.inputMint,
            outputMint: req.inputMint === WSOL.mint ? USDC.mint : WSOL.mint,
            inAmount: req.amount,
            outAmount:
              req.inputMint === WSOL.mint ? 200_000_000n : (req.amount * 1_020n) / 200n,
            otherAmountThreshold:
              req.inputMint === WSOL.mint ? 199_000_000n : (req.amount * 1_010n) / 200n,
            fetchedAt: Date.now(),
          }),
      } as unknown as JupiterClient,
    });

    const result = await bot.tick();
    expect(result?.status).toBe('filled');

    const journal = bot.store.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0]!.closeReason).toMatch(/^arb_filled/);
    expect(journal[0]!.symbol).toBe('USDC');
    expect(journal[0]!.entryNote).toMatch(/bps edge/);

    // And the evidence builder reads it without knowing what arbitrage is.
    const evidence = buildEvidence('arb', journal, cfg);
    expect(evidence.trades).toBe(1);
    expect(evidence.exitReasons[0]!.key).toBe('arb_filled');
    bot.store.close();
  });

  it('maps its counters onto the shared bot-stats shape', () => {
    const bot = new ArbBot({ cfg: loadConfig(env()), dataDir: dir, killSwitchPath: 'STOP' });
    const stats = bot.snapshotStats();
    expect(Object.keys(stats).sort()).toEqual(
      ['bought', 'evaluated', 'rejected', 'seen', 'skipped'].sort(),
    );
    bot.store.close();
  });

  it('puts the arb numbers in the entry note, one per parameter', () => {
    const note = arbNote({
      opportunityId: 'o',
      strategy: 'cross-dex',
      route: 'r',
      quoteSymbol: 'USDC',
      quoteMint: USDC.mint,
      status: 'filled',
      amountIn: 500_000_000n,
      amountOut: 501_000_000n,
      realisedProfit: 960_000n,
      costLamports: 40_000n,
      expectedProfit: 1_000_000n,
      expectedBps: 20.5,
      maxPriceImpactPct: 0.0031,
      quoteAgeMs: 1234,
      fills: [],
      startedAt: 0,
      finishedAt: 0,
    });
    expect(note).toContain('20.5bps edge');
    expect(note).toContain('0.5000 SOL size');
    expect(note).toContain('0.310% impact');
    expect(note).toContain('1234ms quote age');
    expect(note).toContain('cross-dex');
  });
});

describe('why nothing qualified', () => {
  it('names the gate that turned each route down', () => {
    // "Nothing has qualified for a long time" is the expected outcome here, and
    // without a tally it is also unanswerable: a floor ten times too high and a
    // pair with no edge at any floor look identical from the outside.
    expect(categoriseReject(null)).toBe('cleared');
    expect(categoriseReject('edge 4.21bps below floor 30bps')).toBe('below the min edge');
    expect(categoriseReject('negative net edge after costs')).toBe('negative after fees');
    expect(categoriseReject('price impact 0.812% exceeds 0.5%')).toBe('price impact too high');
    expect(categoriseReject('worst case loses 4000 lamports — the slippage tolerance is wider than the edge'))
      .toBe('worst case unprofitable');
    expect(categoriseReject('quote stale by 900ms')).toBe('quotes went stale');
  });

  it('collapses the specific numbers, which are noise in a tally', () => {
    // "edge 4.21bps below floor 30" and "edge 4.19bps below floor 30" are the
    // same finding twice.
    expect(categoriseReject('edge 4.21bps below floor 30bps')).toBe(
      categoriseReject('edge 4.19bps below floor 30bps'),
    );
  });

  it('bands the edges around the decision they inform', () => {
    // Bracketing the 30bps default rather than spacing evenly, because the
    // question is "where does the floor belong".
    expect(edgeBucket(-3)).toBe('<0');
    expect(edgeBucket(0)).toBe('0-5');
    expect(edgeBucket(4.9)).toBe('0-5');
    expect(edgeBucket(12)).toBe('10-20');
    expect(edgeBucket(29.99)).toBe('20-30');
    expect(edgeBucket(30)).toBe('30+');
  });

  it('accumulates the tally across scans, not just the last one', async () => {
    const cfg = loadConfig(env({ ARB_MIN_PROFIT_BPS: '500', ARB_TRADE_SIZE_SOL: '1' }));
    const bot = new ArbBot({
      cfg,
      dataDir: dir,
      killSwitchPath: 'STOP',
      client: {
        rateLimited: 0,
        quote: async (req: { inputMint: string; amount: bigint }) =>
          quote({
            inputMint: req.inputMint,
            outputMint: req.inputMint === WSOL.mint ? USDC.mint : WSOL.mint,
            inAmount: req.amount,
            // A small positive edge — the common real case, and far below a
            // 500bps floor.
            outAmount: req.inputMint === WSOL.mint ? 200_000_000n : (req.amount * 1_002n) / 200n,
            otherAmountThreshold:
              req.inputMint === WSOL.mint ? 199_000_000n : (req.amount * 1_001n) / 200n,
            fetchedAt: Date.now(),
          }),
      } as unknown as JupiterClient,
    });

    await bot.tick();
    await bot.tick();

    const view = bot.view();
    expect(view.routesPriced).toBe(2);
    // The gate that is actually doing the work is named, with a count.
    expect(view.rejectCounts['below the min edge']).toBe(2);
    // And the edges are banded, so the floor can be set from a reading.
    const filled = view.edgeBuckets.filter((b) => b.count > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.key).toBe('10-20');
    bot.store.close();
  });
});

describe('what the tuner may do to the arbitrage bot', () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = loadConfig(env());
  });

  it('can tune the parameters that decide what it trades', () => {
    for (const key of [
      'ARB_MIN_PROFIT_BPS',
      'ARB_SLIPPAGE_BPS',
      'ARB_MAX_PRICE_IMPACT_PCT',
      'ARB_QUOTE_MAX_AGE_MS',
      'ARB_POLL_INTERVAL_MS',
      'ARB_ROUTE_COOLDOWN_MS',
      'ARB_PRIORITY_FEE_MICROLAMPORTS',
      'ARB_REQUIRE_WORST_CASE',
      'ARB_STRATEGIES',
    ]) {
      expect(TUNABLE_BY_KEY.has(key), `${key} should be tunable`).toBe(true);
    }
    // And every one of them is a real config key.
    for (const key of [...TUNABLE_BY_KEY.keys()].filter((k) => k.startsWith('ARB_'))) {
      expect(Object.keys(cfg)).toContain(key);
    }
  });

  it('CANNOT make its own paper simulation more flattering', () => {
    // The most important exclusion here. These are the simulator's pessimism,
    // not the strategy's behaviour — a tuner able to lower them improves every
    // measured result without the strategy getting better at anything, and the
    // entire value of this tab is that its paper numbers can be trusted.
    for (const key of [
      'ARB_PAPER_ADVERSE_SLIPPAGE_BPS',
      'ARB_PAPER_LEG_FAILURE_RATE',
      'ARB_PAPER_UNWIND_RECOVERY_PCT',
    ]) {
      expect(TUNABLE_BY_KEY.has(key), `${key} must not be tunable`).toBe(false);
      expect(vetProposal(key, '10', 1).ok).toBe(false);
    }
  });

  it('cannot drop a route from the list it is being measured on', () => {
    for (const key of ['ARB_TOKENS', 'ARB_VENUES', 'BOT_ARB_ENABLED']) {
      expect(TUNABLE_BY_KEY.has(key), `${key} must not be tunable`).toBe(false);
    }
  });

  it('marks the arbitrage parameters that move capital as risk', () => {
    for (const key of ['ARB_TRADE_SIZE_SOL', 'ARB_MAX_DAILY_LOSS_SOL', 'ARB_MAX_TRADES_PER_HOUR']) {
      expect(TUNABLE_BY_KEY.get(key)?.risk, `${key} should be risk-marked`).toBe(true);
    }
  });

  it('keeps every arbitrage bound inside what the config schema allows', () => {
    // A bound wider than the schema's produces a proposal that passes the tuner
    // and is then refused whole by apply() — a wasted measurement window.
    for (const [key, spec] of TUNABLE_BY_KEY) {
      if (!key.startsWith('ARB_') || spec.kind !== 'number') continue;
      for (const edge of [spec.min!, spec.max!]) {
        expect(() => loadConfig(env({ [key]: String(edge) })), `${key}=${edge}`).not.toThrow();
      }
    }
  });
});
