import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuleset, decideCustomExit, metricsFor } from '../src/strategy/custom-exit.js';
import { decideExit } from '../src/strategy/exit-planner.js';
import { vetProposal, TUNABLE_BY_KEY } from '../src/tuner/limits.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Position } from '../src/types.js';

let dir: string;
let cfg: Config;

const RULES = JSON.stringify([
  { when: [{ metric: 'gainPct', op: '<=', value: -20 }], sell: 'all', label: 'hard_stop' },
  {
    when: [
      { metric: 'gainPct', op: '>=', value: 100 },
      { metric: 'heldSeconds', op: '<=', value: 20 },
    ],
    sell: 50,
    label: 'fast_double',
  },
  {
    when: [{ metric: 'secondsSincePeak', op: '>=', value: 45 }],
    sell: 'all',
    label: 'stopped_climbing',
  },
]);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function position(over: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'p1',
    mint: 'M',
    creator: 'D',
    status: 'open',
    costSol: 0.25,
    notionalSol: 0.25,
    originalQty: 1000,
    remainingQty: 1000,
    entryPrice: 1e-7,
    openedAt: now - 10_000,
    peakPrice: 1e-7,
    lastPrice: 1e-7,
    lastPriceAt: now,
    ladder: [],
    moonbagArmed: false,
    realizedSol: 0,
    safetyScore: 80,
    notes: [],
    ...over,
  } as Position;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-custom-'));
  cfg = loadConfig(env());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ruleset validation', () => {
  it('accepts a well-formed strategy', () => {
    const r = checkRuleset(RULES);
    expect(r.ok).toBe(true);
    expect(r.ruleset).toHaveLength(3);
  });

  it('refuses partial sells adding up to more than the position', () => {
    const bad = JSON.stringify([
      { when: [{ metric: 'gainPct', op: '>=', value: 50 }], sell: 70, label: 'a' },
      { when: [{ metric: 'gainPct', op: '>=', value: 90 }], sell: 60, label: 'b' },
    ]);
    // Shares are of the ORIGINAL position, so the second rule would find
    // nothing left and the strategy running would not be the one measured.
    expect(checkRuleset(bad).error).toMatch(/exceeds 100%/);
  });

  it('refuses an unknown metric rather than silently never firing', () => {
    const bad = JSON.stringify([
      { when: [{ metric: 'rsi', op: '>', value: 70 }], sell: 'all', label: 'a' },
    ]);
    expect(checkRuleset(bad).ok).toBe(false);
  });

  it('refuses duplicate labels, which would make exits indistinguishable', () => {
    const bad = JSON.stringify([
      { when: [{ metric: 'gainPct', op: '>=', value: 50 }], sell: 10, label: 'same' },
      { when: [{ metric: 'gainPct', op: '>=', value: 90 }], sell: 10, label: 'same' },
    ]);
    expect(checkRuleset(bad).error).toMatch(/share a label/);
  });

  it('refuses an empty condition list, which would fire immediately', () => {
    const bad = JSON.stringify([{ when: [], sell: 'all', label: 'now' }]);
    expect(checkRuleset(bad).ok).toBe(false);
  });

  it('warns rather than refuses when a strategy has no downside rule', () => {
    const noStop = JSON.stringify([
      { when: [{ metric: 'gainPct', op: '>=', value: 60 }], sell: 'all', label: 'tp' },
    ]);
    const r = checkRuleset(noStop);
    // A stopless strategy is a real choice the config already allows elsewhere
    // (RATCHET_STOP_LOSS_PCT=0 is exactly it). Refusing here would be this
    // module deciding which strategies are permissible, which is what it is
    // explicitly not for — so it is surfaced, not blocked.
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/nothing here cuts a loser/);
  });

  it('warns when a rule shadows everything below it', () => {
    const shadowed = JSON.stringify([
      { when: [{ metric: 'heldSeconds', op: '>=', value: 1 }], sell: 'all', label: 'always' },
      { when: [{ metric: 'gainPct', op: '>=', value: 500 }], sell: 'all', label: 'never_runs' },
    ]);
    expect(checkRuleset(shadowed).warnings.join(' ')).toMatch(/only ever run when this one does not/);
  });
});

describe('rule evaluation', () => {
  const run = (p: Position, price: number, now = Date.now()) =>
    decideCustomExit(checkRuleset(RULES).ruleset!, p, price, cfg, now);

  it('fires the first matching rule, not the best one', () => {
    // Down 30%: both the stop and (were it reachable) nothing else applies.
    const order = run(position(), 0.7e-7);
    expect(order?.ruleLabel).toBe('hard_stop');
    expect(order?.closeAll).toBe(true);
  });

  it('sells the stated share of the ORIGINAL position, not of what is left', () => {
    const p = position({ openedAt: Date.now() - 10_000, remainingQty: 800 });
    const order = run(p, 2.1e-7);
    expect(order?.ruleLabel).toBe('fast_double');
    expect(order?.qty).toBe(500); // 50% of 1000, not of 800
    expect(order?.closeAll).toBe(false);
  });

  it('respects a condition that combines two metrics', () => {
    // Same +110%, but slowly. fast_double requires it inside 20 seconds.
    const slow = position({ openedAt: Date.now() - 120_000 });
    expect(run(slow, 2.1e-7)?.ruleLabel).not.toBe('fast_double');
  });

  it('does not fire a rule twice', () => {
    const p = position({ firedRules: [1] });
    // fast_double already fired; at +110% inside 20s nothing else matches.
    expect(run(p, 2.1e-7)).toBeNull();
  });

  it('measures time since the last new high, not since entry', () => {
    const now = Date.now();
    const p = position({
      openedAt: now - 300_000,
      peakPrice: 3e-7,
      peakAt: now - 50_000,
      firedRules: [1],
    });
    // 50s since the peak, over the 45s the rule asks for, while the position
    // is still up on entry — a shape the ratchet can only approximate.
    expect(run(p, 2.5e-7, now)?.ruleLabel).toBe('stopped_climbing');
  });

  it('treats a position that never made a high as stale from open, not fresh', () => {
    const now = Date.now();
    const p = position({ openedAt: now - 60_000, firedRules: [1] });
    // No peakAt. Falling back to 0 would read as "it just made a new high",
    // which is the opposite of the truth.
    expect(metricsFor(p, 1e-7, cfg, now).secondsSincePeak).toBeCloseTo(60, 0);
  });

  it('holds when nothing matches', () => {
    expect(run(position(), 1.05e-7)).toBeNull();
  });
});

describe('as a whole strategy', () => {
  const custom = (extra: Record<string, string> = {}) =>
    loadConfig(env({ EXIT_MODE: 'custom', EXIT_RULES: RULES, ...extra }));

  it('runs through decideExit when EXIT_MODE=custom', () => {
    const order = decideExit({
      position: position(),
      price: 0.7e-7,
      cfg: custom(),
      now: Date.now(),
    });
    expect(order?.ruleLabel).toBe('hard_stop');
  });

  it('still closes at MAX_HOLD_SECONDS whatever the rules say', () => {
    const c = custom({ MAX_HOLD_SECONDS: '60' });
    const p = position({ openedAt: Date.now() - 120_000 });
    // The one guarantee a ruleset cannot waive. Without it a strategy whose
    // conditions never come true holds a bag until the process restarts, and
    // the tuner measures a window that never ends.
    const order = decideExit({ position: p, price: 1.02e-7, cfg: c, now: Date.now() });
    expect(order?.reason).toBe('max_hold');
  });

  it('refuses to start on a custom mode with an unreadable strategy', () => {
    expect(() => loadConfig(env({ EXIT_MODE: 'custom', EXIT_RULES: '{oops' }))).toThrow(
      /EXIT_RULES/,
    );
    expect(() => loadConfig(env({ EXIT_MODE: 'custom', EXIT_RULES: '[]' }))).toThrow(/EXIT_RULES/);
  });

  it('leaves the built-in modes untouched', () => {
    // EXIT_RULES is ignored unless the mode selects it, so a half-written
    // strategy sitting in config cannot affect a running ratchet.
    const c = loadConfig(env({ EXIT_MODE: 'ratchet', EXIT_RULES: '[]' }));
    expect(c.EXIT_MODE).toBe('ratchet');
    expect(decideExit({ position: position(), price: 1e-7, cfg: c, now: Date.now() })).toBeDefined();
  });
});

describe('what the tuner may propose', () => {
  it('accepts a valid strategy from the tuner', () => {
    const r = vetProposal('EXIT_RULES', '[]', RULES);
    expect(r.ok).toBe(true);
    // Validated as written. The text path strips all whitespace for a
    // comma-separated list, which would be the wrong thing to do to JSON.
    expect(r.value).toBe(RULES);
  });

  it('rejects an invalid one with the reason, rather than writing it', () => {
    const r = vetProposal('EXIT_RULES', '[]', '[{"when":[],"sell":"all","label":"x"}]');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/EXIT_RULES/);
  });

  it('rejects a strategy that would sell more than the position', () => {
    const over = JSON.stringify([
      { when: [{ metric: 'gainPct', op: '>=', value: 50 }], sell: 80, label: 'a' },
      { when: [{ metric: 'gainPct', op: '>=', value: 90 }], sell: 80, label: 'b' },
    ]);
    expect(vetProposal('EXIT_RULES', '[]', over).reason).toMatch(/exceeds 100%/);
  });

  it('is reachable at all, and custom is a mode it can select', () => {
    expect(TUNABLE_BY_KEY.has('EXIT_RULES')).toBe(true);
    expect(TUNABLE_BY_KEY.get('EXIT_MODE')?.options).toContain('custom');
  });
});

describe('attributing exits to the rule that caused them', () => {
  it('leads the close reason with the rule label, so tables group per rule', async () => {
    const { PositionManager } = await import('../src/strategy/position-manager.js');
    const { PaperExecutor } = await import('../src/execution/paper.js');
    const { RiskManager } = await import('../src/risk/risk-manager.js');
    const { Store } = await import('../src/state/store.js');
    const { buildEvidence } = await import('../src/tuner/evidence.js');

    const c = loadConfig(env({ EXIT_MODE: 'custom', EXIT_RULES: RULES, BUY_AMOUNT_SOL: '0.05' }));
    const store = new Store(dir);
    const prices = {
      vSol: 30,
      vTokens: 1_073_000_000,
      async curve() {
        return {
          virtualSolReserves: BigInt(Math.round(this.vSol * 1e9)),
          virtualTokenReserves: BigInt(Math.round(this.vTokens * 1e6)),
          realSolReserves: 0n,
          realTokenReserves: 0n,
          tokenTotalSupply: 1_000_000_000_000_000n,
          complete: false,
        };
      },
      async price() {
        return this.vSol / this.vTokens;
      },
    };
    const exec = new PaperExecutor(c, prices as never);
    const mgr = new PositionManager(c, store, exec, new RiskManager(c, store, join(dir, 'nostop')));

    const candidate = {
      mint: 'So11111111111111111111111111111111111111112',
      creator: 'Dev11111111111111111111111111111111111111',
      symbol: 'T',
      pool: 'pump' as const,
      detectedAt: Date.now(),
      source: 'test',
      vSolInBondingCurve: 30,
      vTokensInBondingCurve: 1_073_000_000,
    };
    const fill = await exec.buy(candidate, 0.05);
    const p = mgr.open(candidate, fill, 80);
    await mgr.tick();

    // Drop 30%: the hard_stop rule.
    const k = prices.vSol * prices.vTokens;
    prices.vSol = Math.sqrt(p.entryPrice * 0.7 * k);
    prices.vTokens = k / prices.vSol;
    await mgr.tick();

    const row = store.journal().at(-1)!;
    // Not 'custom_rule'. Every table in the evidence groups on the text before
    // the first colon, so a generic reason would collapse every invented rule
    // into one bucket and the post-exit table could never say WHICH rule was
    // cutting winners — the entire point of letting it invent them.
    expect(row.closeReason.split(':')[0]).toBe('hard_stop');

    const reasons = buildEvidence('screener', store.journal(), c).exitReasons.map((r) => r.key);
    expect(reasons).toContain('hard_stop');
    expect(reasons).not.toContain('custom_rule');
    store.close();
  });
});
