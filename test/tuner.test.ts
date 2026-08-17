import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutoTuner,
  JSON_SCHEMA as SCHEMA_FOR_TEST,
  proposalSchema as PROPOSAL_SCHEMA_FOR_TEST,
  SYSTEM_PROMPT as SYSTEM_PROMPT_FOR_TEST,
} from '../src/tuner/auto-tuner.js';
import { RISK_KEYS, TUNABLES, TUNABLE_BY_KEY, vetProposal } from '../src/tuner/limits.js';
import { TuningLedger } from '../src/tuner/ledger.js';
import { snipeNote } from '../src/bots/bot.js';
import { buildEvidence, renderEvidence } from '../src/tuner/evidence.js';
import { RuntimeSettings } from '../src/settings/runtime.js';
import { Store } from '../src/state/store.js';
import { loadConfig, type Config } from '../src/config.js';
import type { TradeJournalEntry } from '../src/types.js';

const ENV = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
    AUTO_TUNE_ENABLED: 'true',
    TUNER_MIN_TRADES: '10',
    ...extra,
  }) as unknown as NodeJS.ProcessEnv;

let dir: string;
let cfg: Config;
let settings: RuntimeSettings;
let store: Store;

function trade(over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  const now = Date.now();
  return {
    positionId: 'p' + Math.random(),
    mint: 'M' + Math.random(),
    symbol: 'T',
    creator: 'D',
    openedAt: now - 90_000,
    closedAt: now,
    costSol: 0.25,
    proceedsSol: 0.2,
    pnlSol: -0.05,
    pnlPct: -20,
    closeReason: 'time_stop: below breakeven',
    safetyScore: 80,
    holdSeconds: 60,
    entryNote: 'screen: $12.6k mcap, $3.7k volume, 1 socials, 5s old',
    ...over,
  };
}

function fill(n: number, over: Partial<TradeJournalEntry> = {}): void {
  for (let i = 0; i < n; i++) store.appendJournal(trade(over));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-tuner-'));
  cfg = loadConfig(ENV(dir));
  settings = new RuntimeSettings(cfg, ENV(dir), dir);
  store = new Store(dir, 'screener');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An AutoTuner whose model call is replaced by a canned proposal. */
function tunerWith(proposal: unknown, stores?: Map<string, Store>): AutoTuner {
  const t = new AutoTuner({
    cfg,
    settings,
    stores: stores ?? new Map([['screener', store]]),
    dataDir: dir,
  });
  // The model is the one part that cannot run in a test; everything that makes
  // this feature safe lives on our side of that call, and that is what is under
  // test here.
  (t as unknown as { propose: (bot: string) => Promise<unknown> }).propose = async (bot) =>
    typeof proposal === 'function' ? (proposal as (b: string) => unknown)(bot) : proposal;
  return t;
}

/**
 * Back-dates every experiment so the per-bot cooldown has expired.
 *
 * The cooldown is read from the ledger rather than a field, so that it
 * survives a restart — which means a test cannot skip it by poking a timer.
 */
function cooled(t: AutoTuner): void {
  const ledger = (t as unknown as { ledger: TuningLedger }).ledger;
  const past = Date.now() - 24 * 60 * 60_000;
  for (const e of ledger.all()) {
    ledger.update(e.id, { startedAt: past, ...(e.decidedAt ? { decidedAt: past } : {}) });
  }
}

describe('what the tuner may touch', () => {
  it('still refuses the four things that are excluded on purpose', () => {
    // The list is broad by request, but these four are out for reasons that
    // are not about taste:
    //   - the tuner's own settings ARE the enforcement mechanism
    //   - the fee constants describe the world, not a choice
    //   - BOT_*_ENABLED are controls and go through another path
    //   - COPY_WALLETS is the user's input, not a parameter
    for (const key of [
      'AUTO_TUNE_ENABLED',
      'TUNER_INTERVAL_MINUTES',
      'TUNER_MIN_TRADES',
      'TUNER_MAX_CHANGES_PER_ROUND',
      'TUNER_MAX_STEP_PCT',
      'PROGRAM_FEE_PCT',
      'ROUTER_FEE_PCT',
      'SOL_USD_FALLBACK',
      'BOT_SCREENER_ENABLED',
      'BOT_SNIPER_ENABLED',
      'BOT_COPY_ENABLED',
      'COPY_WALLETS',
      'MODE',
      'EXECUTOR',
      'WALLET_PRIVATE_KEY',
      'RPC_HTTP_URL',
      'DATA_DIR',
    ]) {
      expect(TUNABLE_BY_KEY.has(key), `${key} must not be tunable`).toBe(false);
      expect(vetProposal(key, '1', 2).ok).toBe(false);
    }
  });

  it('can reach every parameter that is not deliberately withheld', () => {
    // "Everything is reachable" is the whole point of the widened list, and it
    // is the kind of claim that quietly stops being true the next time a
    // setting is added. So it is checked rather than asserted: every key in the
    // config schema must be tunable, locked, or on the excluded list — and a
    // new key lands in none of those, so this fails until someone decides.
    const LOCKED_KEYS = new Set([
      'MODE',
      'EXECUTOR',
      'WALLET_PRIVATE_KEY',
      'RPC_HTTP_URL',
      'RPC_WS_URL',
      'ANTHROPIC_API_KEY',
      'DATA_DIR',
      'DASHBOARD_ENABLED',
      'DASHBOARD_PORT',
      'DASHBOARD_HOST',
      // Returns the transaction bytes we sign; repointing it repoints that.
      'PUMPPORTAL_TRADE_URL',
      'PUMPPORTAL_WS_URL',
    ]);
    const EXCLUDED_KEYS = new Set([
      // The enforcement mechanism itself.
      'AUTO_TUNE_ENABLED',
      'TUNER_INTERVAL_MINUTES',
      'TUNER_MIN_TRADES',
      'TUNER_MAX_CHANGES_PER_ROUND',
      'TUNER_MAX_STEP_PCT',
      // Facts about the world, not choices.
      'PROGRAM_FEE_PCT',
      'ROUTER_FEE_PCT',
      'SOL_USD_FALLBACK',
      // Controls, and a different code path.
      'BOT_SCREENER_ENABLED',
      'BOT_SNIPER_ENABLED',
      'BOT_COPY_ENABLED',
      // The user's input, not a knob.
      'COPY_WALLETS',
      // The size of the simulated bankroll, which is the denominator every
      // paper result is measured against. A tuner able to raise it could
      // improve its own numbers by loosening the risk checks that sizing and
      // the loss limits derive from, without the strategy getting better at
      // anything. That is not tuning, it is marking its own homework.
      'PAPER_STARTING_BALANCE_SOL',
      // Terminal verbosity, with no trading effect. The tuner reached for it as
      // a way to see the reject breakdown — a fair thing to want, and the wrong
      // way to get it, since the tuner reads the evidence block and not the
      // terminal. It also cost a change slot and rode in the same experiment as
      // a real change, so a revert would revert both.
      'LOG_LEVEL',
      // A control, not a parameter — same as the other BOT_*_ENABLED.
      'BOT_ARB_ENABLED',
      // The arbitrage simulator's PESSIMISM, not the strategy's behaviour. A
      // tuner able to lower these improves every measured result without the
      // strategy getting better at anything, and the whole value of the arb tab
      // is that its paper numbers can be trusted.
      'ARB_PAPER_ADVERSE_SLIPPAGE_BPS',
      'ARB_PAPER_LEG_FAILURE_RATE',
      'ARB_PAPER_UNWIND_RECOVERY_PCT',
      // Which assets and venues to look at is the user's input, like COPY_WALLETS.
      'ARB_TOKENS',
      'ARB_VENUES',
      // Read once at construction; changing it does nothing until a restart.
      'DISCOVERY_SOURCE',
    ]);

    const unreachable = Object.keys(cfg).filter(
      (k) => !TUNABLE_BY_KEY.has(k) && !LOCKED_KEYS.has(k) && !EXCLUDED_KEYS.has(k),
    );
    expect(unreachable, `not tunable, locked, or excluded: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('only lists keys the config actually has', () => {
    const known = new Set(Object.keys(cfg));
    for (const t of TUNABLES) expect(known.has(t.key), `${t.key} is not a config key`).toBe(true);
  });

  it('keeps every bound inside what the config schema itself allows', () => {
    // A bound wider than the schema's would produce a proposal that passes the
    // tuner and is then refused whole by apply() — a wasted round every time.
    //
    // Each bound is checked against a FRESH config: applying them cumulatively
    // would fail on the cross-field rules (a max age pinned to its floor while
    // a min age is pinned to its ceiling is a genuinely invalid pair, but not
    // one the tuner would ever produce).
    for (const t of TUNABLES) {
      if (t.kind !== 'number') continue;
      for (const [edge, v] of [['min', t.min], ['max', t.max]] as const) {
        const fresh = new RuntimeSettings(loadConfig(ENV(dir)), ENV(dir), dir);
        const res = fresh.apply({ [t.key]: String(v) });
        expect(res.ok, `${t.key} ${edge} ${v} rejected: ${res.error ?? ''}`).toBe(true);
      }
    }
  });

  it('marks the parameters that move capital at risk', () => {
    // These are in scope by request, but a change to one should never be quiet.
    for (const key of [
      'BUY_AMOUNT_SOL',
      'MAX_CONCURRENT_POSITIONS',
      'DAILY_LOSS_LIMIT_SOL',
      'HOURLY_SPEND_CAP_SOL',
      'RATCHET_STOP_LOSS_PCT',
    ]) {
      expect(RISK_KEYS.has(key), `${key} should be flagged as risk`).toBe(true);
    }
    expect(RISK_KEYS.has('SCREEN_MIN_VOLUME_USD')).toBe(false);
  });

  it('clamps to the hard range rather than trusting the model', () => {
    // Both limits apply, so an absurd ask lands inside the range AND inside one
    // step of where it started — it does not reach the bound in a single round.
    // The property that matters is that nothing escapes the range.
    const spec = TUNABLE_BY_KEY.get('MIN_SAFETY_SCORE')!;

    const huge = vetProposal('MIN_SAFETY_SCORE', '70', 10_000, 100);
    expect(huge.ok).toBe(true);
    if (huge.ok) {
      expect(Number(huge.value)).toBeLessThanOrEqual(spec.max!);
      expect(Number(huge.value)).toBeGreaterThan(70);
    }

    const tiny = vetProposal('MIN_SAFETY_SCORE', '70', -5, 100);
    expect(tiny.ok).toBe(true);
    if (tiny.ok) {
      expect(Number(tiny.value)).toBeGreaterThanOrEqual(spec.min!);
      expect(Number(tiny.value)).toBeLessThan(70);
    }
  });

  it('holds a parameter to its own cap even when the global one is looser', () => {
    // The per-parameter caps in limits.ts were dead code: the global override
    // won outright, so every hand-picked value in that column was inert. The
    // effective cap is the tighter of the two, which is what makes both real.
    const spec = TUNABLE_BY_KEY.get('MIN_SAFETY_SCORE')!;
    expect(spec.maxStepPct).toBeLessThan(100);

    const r = vetProposal('MIN_SAFETY_SCORE', '70', 95, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value)).toBeCloseTo(70 * (1 + spec.maxStepPct! / 100), 6);
  });

  it('moves a counted parameter by whole units, never a fraction of one', () => {
    // MIN_HOLDERS: 2 -> 2.6 is what a 30% step cap does to a count of wallets.
    // It reads as nonsense, cannot be explained back in the terms the model
    // proposed, and silently means 3.
    expect(TUNABLE_BY_KEY.get('MIN_HOLDERS')!.integer).toBe(true);

    const r = vetProposal('MIN_HOLDERS', '2', 4, 30);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value)).toBe(3);

    // 30% of 4 is 1.2, so the bound is a whole 5 rather than a reported 5.2 that
    // the value could never have taken.
    const slots = vetProposal('SNIPER_MAX_CONCURRENT_CHECKS', '4', 6, 30);
    expect(slots.ok).toBe(true);
    if (slots.ok) {
      expect(Number(slots.value)).toBe(5);
      expect(slots.clamped).toContain('to 5');
    }
  });

  it('lets a small count move at all, rather than freezing it', () => {
    // Without a one-unit floor, 30% of 1 is 0.3, which rounds back to 1 — the
    // parameter is stuck wherever it happens to sit and every proposal for it is
    // rejected as "no change".
    const r = vetProposal('MIN_HOLDERS', '1', 2, 30);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value)).toBe(2);
  });

  it('says so rather than opening an experiment that changes nothing', () => {
    // Rounding to a whole unit can land back on the current value. Measuring
    // that for 150 trades is a wasted window and a meaningless verdict.
    const r = vetProposal('MIN_HOLDERS', '2', 2.2, 30);
    expect(r.ok).toBe(false);
  });

  it('limits how far one round can move a parameter', () => {
    // This is what stops a series of individually reasonable rounds walking a
    // parameter somewhere no single round would have proposed.
    const r = vetProposal('SCREEN_MIN_VOLUME_USD', '3000', 30_000, 30);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number(r.value)).toBeCloseTo(3900, 6);
      expect(r.clamped).toMatch(/step limited/);
    }
  });

  it('caps position size hard, however the evidence reads', () => {
    // The one number where a runaway is not a bad quarter but a bad afternoon.
    const r = vetProposal('BUY_AMOUNT_SOL', '0.25', 50, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value)).toBeLessThanOrEqual(0.5); // 25% step off 0.25
    const spec = TUNABLE_BY_KEY.get('BUY_AMOUNT_SOL')!;
    expect(spec.max).toBeLessThanOrEqual(2);
  });

  it('handles booleans, enums and lists as well as numbers', () => {
    const bool = vetProposal('REQUIRE_SOCIALS', 'true', false);
    expect(bool.ok && bool.value).toBe('false');

    const enumOk = vetProposal('EXIT_MODE', 'ratchet', 'scalp');
    expect(enumOk.ok && enumOk.value).toBe('scalp');
    expect(vetProposal('EXIT_MODE', 'ratchet', 'nonsense').ok).toBe(false);

    const list = vetProposal('SCREEN_ALLOWED_POOLS', 'pump', 'pump,pump-amm');
    expect(list.ok && list.value).toBe('pump,pump-amm');
    expect(vetProposal('SCREEN_ALLOWED_POOLS', 'pump', 'pump,not-a-venue').ok).toBe(false);

    const ladder = vetProposal('EXIT_LADDER', '60:40,150:30,400:20', '50:50,200:30');
    expect(ladder.ok).toBe(true);
    expect(vetProposal('EXIT_LADDER', '60:40', 'garbage').ok).toBe(false);
  });

  it('lets a value parked outside its range return in one step', () => {
    // The step cap stops drift WITHIN the range. Applied to a setting parked
    // far outside it, it becomes a trap: from 100 against a ceiling of 20, a
    // 30% step reaches 70, then 49, then 34 — five rounds walking back to a
    // bound nobody disputed, each one burning a measurement window.
    const spec = TUNABLE_BY_KEY.get('SCREEN_MAX_MCAP_USD')!;
    expect(spec.risk).toBeFalsy();

    const r = vetProposal('SCREEN_MAX_MCAP_USD', '900000', 40_000, 30);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number(r.value)).toBe(40_000);
      expect(r.clamped).toMatch(/outside the allowed/);
    }

    // Still bounded: it lands inside the range, not wherever it was asked to.
    const far = vetProposal('SCREEN_MAX_MCAP_USD', '900000', 9_999_999, 30);
    expect(far.ok && Number(far.value)).toBe(spec.max);
  });

  it('leaves a RISK parameter where a human parked it, outside range or not', () => {
    // These bounds describe what the tuner may authorise, not what a sane value
    // is. HOURLY_SPEND_CAP_SOL sitting at a hand-set 100 against a tuner ceiling
    // of 50 is a deliberate decision the tuner has no evidence about — dragging
    // it down as a side effect of a proposal about something else is a change to
    // capital exposure nobody asked for, and one-way, since the same rule then
    // stops it coming back.
    expect(TUNABLE_BY_KEY.get('HOURLY_SPEND_CAP_SOL')!.risk).toBe(true);

    const r = vetProposal('HOURLY_SPEND_CAP_SOL', '100', 20, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/risk parameter/);

    // Inside the range it behaves normally — this is about parked values only.
    expect(vetProposal('HOURLY_SPEND_CAP_SOL', '20', 24, 30).ok).toBe(true);
  });

  it('can move a parameter that is currently zero', () => {
    // A percentage step off zero is zero, so without a special case a disabled
    // setting could never be switched on again.
    const r = vetProposal('RATCHET_STOP_LOSS_PCT', '0', 40, 30);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number(r.value)).toBeGreaterThan(0);
  });

  it('rejects a proposal that changes nothing', () => {
    expect(vetProposal('MOONBAG_TRIM_PCT', '25', 25).ok).toBe(false);
    expect(vetProposal('EXIT_MODE', 'ratchet', 'ratchet').ok).toBe(false);
    expect(vetProposal('REQUIRE_SOCIALS', 'true', true).ok).toBe(false);
  });
});

describe('what it is told it may decide', () => {
  const SYSTEM = (): string => {
    // The prompt is the only place "propose it yourself" can be established,
    // and it regressed once already into writing notes about parameters it
    // owned. Pin the two instructions that matter.
    const t = new AutoTuner({ cfg, settings, stores: new Map([['screener', store]]), dataDir: dir });
    return (t as unknown as { claude: unknown }) && SYSTEM_PROMPT_FOR_TEST;
  };

  it('separates exposure from shape, and claims shape as its own', () => {
    const p = SYSTEM();
    expect(p).toMatch(/EXPOSURE/);
    expect(p).toMatch(/SHAPE/);
    // The specific failure: reporting a lever it holds as future work.
    expect(p).toMatch(/PROPOSE THEM/);
    expect(p).toMatch(/next lever is X/);
  });

  it('reserves notes for things it genuinely cannot reach', () => {
    const p = SYSTEM();
    expect(p).toMatch(/Notes are ONLY for things you cannot reach/);
    expect(p).toMatch(/propose it instead/);
  });
});

describe('the call budget', () => {
  it('asks for enough output tokens to actually answer', async () => {
    // With adaptive thinking and a catalogue of a hundred-plus parameters, a
    // tight budget is spent reasoning before a single character of JSON is
    // written — and the round comes back "empty response", which reads like a
    // network fault rather than a budget one.
    let asked: { maxTokens?: number } | null = null;
    const t = new AutoTuner({ cfg, settings, stores: new Map([['screener', store]]), dataDir: dir });
    (t as unknown as { claude: { ask: unknown } }).claude = {
      ask: async (opts: { maxTokens?: number }) => {
        asked = opts;
        return { ok: false, error: 'stubbed', usage: {}, latencyMs: 0 };
      },
      usage: {},
    };

    fill(12);
    await t.tick();
    expect(asked).not.toBeNull();
    expect(asked!.maxTokens ?? 0).toBeGreaterThanOrEqual(8000);
  });

  it('marks parameters that do nothing in the current mode', async () => {
    // Spending a measurement window on a scalp setting while the ratchet is
    // running is a wasted round, and there are too many parameters for the
    // distinction to be obvious from the names.
    let sent = '';
    const t = new AutoTuner({ cfg, settings, stores: new Map([['screener', store]]), dataDir: dir });
    (t as unknown as { claude: { ask: unknown } }).claude = {
      ask: async (opts: { userContent: string }) => {
        sent = opts.userContent;
        return { ok: false, error: 'stubbed', usage: {}, latencyMs: 0 };
      },
      usage: {},
    };

    fill(12);
    await t.tick();
    // Default EXIT_MODE is ratchet, so the scalp and ladder knobs are inert.
    expect(sent).toMatch(/SCALP_TARGET_NET_PCT[^\n]*INERT/);
    expect(sent).toMatch(/STOP_LOSS_PCT[^\n]*INERT/);
    // And the ones that are live are not marked.
    expect(sent).not.toMatch(/RECOVER_AT_GAIN_PCT[^\n]*INERT/);
  });
});

describe('the structured-output schema', () => {
  // A schema the API rejects turns every tuning call into a 400 and the feature
  // silently never runs — which is exactly what happened. These pin the two
  // keywords that were not supported.
  const schema = (AutoTuner as unknown as { prototype: object }) && SCHEMA_FOR_TEST;

  function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    visit(o);
    for (const v of Object.values(o)) walk(v, visit);
  }

  it('uses no array keyword the API refuses', () => {
    walk(schema, (o) => {
      expect(o.maxItems, 'maxItems is not supported on array types').toBeUndefined();
      expect(o.minItems, 'minItems is not supported on array types').toBeUndefined();
    });
  });

  it('never gives a property a union of types', () => {
    walk(schema, (o) => {
      if ('type' in o) expect(Array.isArray(o.type), `type ${JSON.stringify(o.type)}`).toBe(false);
    });
  });

  it('asks for values as strings, since a union is not available', () => {
    const value = (schema as any).properties.changes.items.properties.value;
    expect(value.type).toBe('string');
  });

  it('still enforces the change count after parsing', () => {
    // The cap moved from the schema to our side; it has to actually be there.
    expect(PROPOSAL_SCHEMA_FOR_TEST.safeParse({
      changes: Array.from({ length: 20 }, () => ({ key: 'X', value: '1', why: 'y' })),
    }).success).toBe(false);
  });
});

describe('acting on evidence', () => {
  it('does nothing until there are enough closed trades', async () => {
    fill(5);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 40, why: 'x' }] });
    await t.tick();
    expect(t.history).toHaveLength(0);
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('25');
  });

  it('applies a vetted change and starts measuring it', async () => {
    fill(12);
    const t = tunerWith({
      changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'moonbags are stalling' }],
    });
    await t.tick();

    expect(settings.values().MOONBAG_TRIM_PCT).toBe('30');
    expect(t.history).toHaveLength(1);
    const e = t.history[0]!;
    expect(e.status).toBe('running');
    expect(e.changes[0]).toMatchObject({ key: 'MOONBAG_TRIM_PCT', from: 25, to: 30 });
    expect(e.journalAtStart).toBe(12);
  });

  it('drops a proposal outside the whitelist and applies nothing', async () => {
    fill(12);
    const t = tunerWith({
      changes: [
        // Its own minimum sample size: the thing that decides whether it is
        // allowed to act at all.
        { key: 'TUNER_MIN_TRADES', value: 1, why: 'I could learn faster with less data' },
      ],
    });
    await t.tick();

    expect(settings.values().TUNER_MIN_TRADES).toBe('10');
    expect(t.history).toHaveLength(0);
  });

  it('never applies more than the per-round cap', async () => {
    fill(12);
    cfg.TUNER_MAX_CHANGES_PER_ROUND = 1;
    const t = tunerWith({
      changes: [
        { key: 'MOONBAG_TRIM_PCT', value: 30, why: 'a' },
        { key: 'CHECKPOINT_SECONDS', value: 45, why: 'b' },
        { key: 'RECOVER_AT_GAIN_PCT', value: 70, why: 'c' },
      ],
    });
    await t.tick();
    expect(t.history[0]!.changes).toHaveLength(1);
  });

  it('does nothing at all when the feature is off', async () => {
    fill(50);
    cfg.AUTO_TUNE_ENABLED = false;
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 40, why: 'x' }] });
    await t.tick();
    expect(t.history).toHaveLength(0);
  });
});

describe('what the evidence says about exits', () => {
  it('names the parameter behind each timed exit', () => {
    // The auto-tuner cannot attribute what it cannot distinguish. Three timers
    // — RATCHET_FIRST_CHECKPOINT_SECONDS, TIME_STOP_SECONDS and
    // SCALP_TIME_STOP_SECONDS — all reported themselves as `time_stop`, which
    // left the model inferring which one had fired from hold times. It said so
    // itself, in a note it had no way to act on.
    fill(12);
    const rendered = renderEvidence(buildEvidence('sniper', store.journal(), cfg));
    for (const [reason, param] of [
      ['dead_entry', 'RATCHET_FIRST_CHECKPOINT_SECONDS'],
      ['checkpoint_cut', 'CHECKPOINT_SECONDS'],
      ['time_stop', 'TIME_STOP_SECONDS'],
      ['scalp_time_stop', 'SCALP_TIME_STOP_SECONDS'],
      ['trailing_stop', 'RATCHET_GIVEBACK_PCT'],
    ] as const) {
      expect(rendered, `${reason} must name its parameter`).toContain(reason);
      expect(rendered).toContain(param);
    }
  });

  it('only names parameters the tuner can actually reach', () => {
    // Pointing the model at a knob it cannot turn is worse than silence.
    const rendered = renderEvidence(buildEvidence('sniper', store.journal(), cfg));
    const named = [...rendered.matchAll(/-> ([A-Z_]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(4);
    for (const key of named) {
      expect(TUNABLE_BY_KEY.has(key), `${key} is named but not tunable`).toBe(true);
    }
  });
});

describe('what the sniper entry looked like', () => {
  const verdict = (metrics: Record<string, number>) =>
    ({ score: 85, passed: true, results: [], elapsedMs: 5, metrics }) as never;

  function snipeTrade(devBuyPct: number, holders: number, pnlSol: number): TradeJournalEntry {
    return trade({
      pnlSol,
      pnlPct: (pnlSol / 0.25) * 100,
      proceedsSol: 0.25 + pnlSol,
      closeReason: pnlSol > 0 ? 'ladder' : 'dead_entry: below breakeven',
      entryNote: snipeNote(
        verdict({ devBuyPct, holders, bundleTxs: 2, deployerSol: 1, creatorAgeMinutes: 200 }),
      ),
    });
  }

  it('writes the launch characteristics the battery measured', () => {
    const note = snipeNote(
      verdict({ devBuyPct: 6.2, holders: 1, bundleTxs: 7, deployerSol: 0.04, creatorAgeMinutes: 12 }),
    );
    expect(note).toContain('6.20% dev buy');
    expect(note).toContain('1 holders');
    expect(note).toContain('7 bundled');
    expect(note).toContain('0.040 SOL dev balance');
    expect(note).toContain('12m creator age');
  });

  it('omits a check that did not run rather than recording a zero', () => {
    // A zero from a switched-off check is indistinguishable from a real
    // measurement of zero, and the difference decides whether a bucket means
    // anything at all.
    const note = snipeNote(verdict({ devBuyPct: 1.1 }));
    expect(note).toContain('1.10% dev buy');
    expect(note).not.toContain('holders');
    expect(note).not.toContain('bundled');
  });

  it('turns 150 dead entries into a breakdown that names a parameter', () => {
    // The blocker the tuner reported: the sniper journal carried the safety
    // score and nothing else, so "116 of 150 died" could not be turned into
    // "and here is what they had in common".
    for (let k = 0; k < 30; k++) store.appendJournal(snipeTrade(6.5, 1, -0.05));
    for (let k = 0; k < 12; k++) store.appendJournal(snipeTrade(0.4, 6, 0.3));

    const e = buildEvidence('sniper', store.journal(), cfg);

    const heavy = e.byDevBuy.find((b) => b.key === '5%+')!;
    expect(heavy.trades).toBe(30);
    expect(heavy.wins).toBe(0);
    const light = e.byDevBuy.find((b) => b.key === '<1%')!;
    expect(light.trades).toBe(12);
    expect(light.wins).toBe(12);

    const rendered = renderEvidence(e);
    expect(rendered).toContain('MAX_DEV_BUY_PCT');
    expect(rendered).toContain('MIN_HOLDERS');
  });

  it('leaves the sniper sections out for a bot that does not run the battery', () => {
    // The screener's own note has none of these fields, and a bucket built from
    // absent data would be a row of zeroes reading as a real measurement.
    fill(12); // default entryNote is the screener's
    const e = buildEvidence('screener', store.journal(), cfg);
    expect(e.byDevBuy).toEqual([]);
    expect(e.byHolders).toEqual([]);
    expect(e.byBundle).toEqual([]);
  });
});

describe('changes already in flight', () => {
  it('can still revert a key that has since stopped being tunable', async () => {
    // Removing LOG_LEVEL from the tunable list must not strand the experiment
    // that was measuring it. Reverting goes through settings.apply directly, not
    // through vetProposal, so a key can always be put back where it was even
    // when nothing may propose it again.
    expect(TUNABLE_BY_KEY.has('LOG_LEVEL')).toBe(false);
    expect(settings.apply({ LOG_LEVEL: 'debug' }).ok).toBe(true);
    expect(settings.values().LOG_LEVEL).toBe('debug');
    expect(settings.apply({ LOG_LEVEL: 'info' }).ok).toBe(true);
    expect(settings.values().LOG_LEVEL).toBe('info');
  });

  it('keeps a fractional value the tuner already set, rather than refusing to boot', () => {
    // MIN_HOLDERS=2.6 is live on at least one running bot. Marking the parameter
    // as counted governs what may be PROPOSED next; it must not invalidate a
    // value already sitting in settings.json, or the fix for a cosmetic problem
    // becomes a bot that will not start.
    expect(settings.apply({ MIN_HOLDERS: '2.6' }).ok).toBe(true);
    expect(loadConfig({ ...ENV(dir), MIN_HOLDERS: '2.6' }).MIN_HOLDERS).toBe(2.6);
  });
});

describe('measuring what it changed', () => {
  /** Runs a change, then supplies `after` trades and re-ticks to settle it. */
  async function runAndSettle(afterPnl: number): Promise<AutoTuner> {
    fill(12, { pnlSol: -0.05 }); // baseline expectancy -0.05/trade
    const t = tunerWith({
      changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'test' }],
    });
    await t.tick();

    fill(12, { pnlSol: afterPnl });
    cooled(t);
    await t.tick();
    return t;
  }

  it('keeps a change that beat its baseline', async () => {
    const t = await runAndSettle(0.1);
    const e = t.history[0]!;
    expect(e.status).toBe('kept');
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('30');
  });

  it('reverts a change that did not', async () => {
    // The point of the whole design: the default is the known state, so a
    // change has to earn its place rather than merely survive.
    const t = await runAndSettle(-0.2);
    const e = t.history[0]!;
    expect(e.status).toBe('reverted');
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('25');
    expect(e.verdict).toMatch(/reverted/);
  });

  it('refuses to re-apply something it already reverted', async () => {
    // Propose, revert, propose the same thing again is the loop this feature
    // fails into if nothing stops it. The prompt is told; this enforces it.
    const t = await runAndSettle(-0.2);
    expect(t.history[0]!.status).toBe('reverted');

    fill(12, { pnlSol: -0.05 });
    cooled(t);
    await t.tick(); // same canned proposal as before

    expect(t.history).toHaveLength(1);
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('25');
  });

  it('proposes the next experiment in the same pass that settled the last', async () => {
    // The trades that just decided one experiment are the freshest evidence
    // there is for choosing the next. Settling and then going idle spends that
    // evidence on nothing and waits for it to be replaced by more of the same.
    fill(12, { pnlSol: -0.05 });
    let round = 0;
    const t = tunerWith(() => {
      round += 1;
      return round === 1
        ? { changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'first' }] }
        : { changes: [{ key: 'CHECKPOINT_SECONDS', value: 45, why: 'second' }] };
    });

    await t.tick();
    expect(t.history).toHaveLength(1);

    fill(12, { pnlSol: 0.1 }); // enough to judge, and it beat the baseline
    cooled(t);
    await t.tick();

    expect(t.history).toHaveLength(2);
    expect(t.history[0]!.status).toBe('kept');
    expect(t.history[1]!.status).toBe('running');
    expect(settings.values().CHECKPOINT_SECONDS).toBe('45');
  });

  it('measures the next change against what is actually running now', async () => {
    // After a KEEP, the live configuration is the one just measured, so the bar
    // is what it scored.
    fill(12, { pnlSol: -0.05 });
    let round = 0;
    const t = tunerWith(() => {
      round += 1;
      return round === 1
        ? { changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'first' }] }
        : { changes: [{ key: 'CHECKPOINT_SECONDS', value: 45, why: 'second' }] };
    });
    await t.tick();

    fill(12, { pnlSol: 0.1 });
    cooled(t);
    await t.tick();

    expect(t.history[1]!.baselineExpectancy).toBeCloseTo(0.1, 5);
  });

  it('does not inherit a rejected window as the bar to beat', async () => {
    // After a REVERT the live configuration is the earlier one, so the bar is
    // its measurement — not the window just thrown out for being worse. Carry
    // the rejected number forward and the next change clears it by doing
    // nothing, and the tuner starts keeping noise on the strength of that.
    fill(12, { pnlSol: -0.05 }); // baseline -0.05
    let round = 0;
    const t = tunerWith(() => {
      round += 1;
      return round === 1
        ? { changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'first' }] }
        : { changes: [{ key: 'CHECKPOINT_SECONDS', value: 45, why: 'second' }] };
    });
    await t.tick();

    fill(12, { pnlSol: -0.2 }); // far worse, so it is reverted
    cooled(t);
    await t.tick();

    expect(t.history[0]!.status).toBe('reverted');
    expect(t.history).toHaveLength(2);
    // The bar is the -0.05 we went back to, not the -0.2 we rejected.
    expect(t.history[1]!.baselineExpectancy).toBeCloseTo(-0.05, 5);
  });

  it('leaves a change alone while the window is still filling', async () => {
    fill(12);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'test' }] });
    await t.tick();

    fill(3); // not enough to judge
    cooled(t);
    await t.tick();

    expect(t.history[0]!.status).toBe('running');
    expect(t.history).toHaveLength(1); // and no second change stacked on top
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('30');
  });
});

describe('when it decides to act', () => {
  it('acts as soon as the trades are there, without waiting on a clock', async () => {
    // 40 trades is 40 trades whether they took two minutes or two days. A bot
    // that closes them fast should not sit on the data for hours.
    fill(12);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'x' }] });

    await t.tick(); // first ever tick, no cooldown to serve
    expect(t.history).toHaveLength(1);
    expect(settings.values().MOONBAG_TRIM_PCT).toBe('30');
  });

  it('holds off a second change until the cooldown expires', async () => {
    // The cooldown is not about statistics — it bounds API spend and stops a
    // burst of fast trades producing a run of changes before any of them has
    // had a chance to show an effect.
    fill(12);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'x' }] });
    await t.tick();

    fill(30); // plenty of trades, but the cooldown has not passed
    await t.tick();
    expect(t.history).toHaveLength(1);

    const p = t.progress().screener!;
    expect(p.phase).toBe('measuring');
    expect(p.nextAt).toBeGreaterThan(Date.now());
  });

  it('says which gate is holding it, not just that nothing happened', async () => {
    fill(4);
    const t = tunerWith({ changes: [] });
    expect(t.progress().screener).toMatchObject({ phase: 'gathering', blockedBy: 'trades' });

    fill(8);
    expect(t.progress().screener).toMatchObject({ phase: 'ready', blockedBy: null });
  });

  it('counts the measuring window toward the cooldown, not on top of it', async () => {
    // The measurement window is already a wait, spent gathering the evidence.
    // Restarting the clock when that evidence finally arrives means waiting
    // twice for one experiment, and idling at the moment there is most reason
    // to act — a bot that reaches its trade count in seven minutes then sat
    // still for twenty with a full progress bar.
    fill(12);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'x' }] });
    await t.tick();

    const started = t.history[0]!.startedAt;
    fill(12, { pnlSol: 0.1 });
    await t.tick(); // still inside the cooldown, so nothing settles yet

    const ledger = (t as unknown as { ledger: TuningLedger }).ledger;
    // Back-date only the start, leaving any decision time alone: the cooldown
    // must key off when the change was MADE.
    for (const e of ledger.all()) {
      ledger.update(e.id, { startedAt: started - 24 * 60 * 60_000 });
    }
    await t.tick();
    expect(t.history[0]!.status).toBe('kept');
  });

  it('does not review a bot again just because the process restarted', async () => {
    // The cooldown is read from the ledger for exactly this reason: a bot that
    // restarts every few minutes would otherwise change something every boot.
    fill(12);
    const first = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'x' }] });
    await first.tick();
    expect(first.history).toHaveLength(1);

    fill(30);
    const restarted = tunerWith({ changes: [{ key: 'CHECKPOINT_SECONDS', value: 45, why: 'y' }] });
    await restarted.tick();

    expect(restarted.history).toHaveLength(1); // the one from before, unchanged
    expect(settings.values().CHECKPOINT_SECONDS).toBe('60');
  });

  it('lets a fast bot run without waiting on a slow one', async () => {
    // Per-bot cooldowns: the sniper closing trades in seconds should not be
    // held back by the copy trader closing one an hour.
    const sniperStore = new Store(dir, 'sniper');
    for (let i = 0; i < 12; i++) sniperStore.appendJournal(trade());

    // A different knob per bot — the same one twice would be refused as "no
    // change" on the second bot, which would prove nothing.
    const t = tunerWith(
      (bot: string) => ({
        changes: [
          bot === 'sniper'
            ? { key: 'CHECKPOINT_SECONDS', value: 45, why: 'sniper' }
            : { key: 'MOONBAG_TRIM_PCT', value: 30, why: 'screener' },
        ],
      }),
      new Map([['screener', store], ['sniper', sniperStore]]),
    );

    fill(12);
    await t.tick();

    // Both were ready, and both were reviewed in the same pass.
    expect(t.history.map((e) => e.bot).sort()).toEqual(['screener', 'sniper']);
    sniperStore.close();
  });
});

describe('showing progress', () => {
  it('reports how far off the next decision is', async () => {
    fill(4);
    const t = tunerWith({ changes: [] });
    expect(t.progress().screener).toMatchObject({ phase: 'gathering', trades: 4, needed: 10 });

    fill(8);
    expect(t.progress().screener).toMatchObject({ phase: 'ready', trades: 12 });
  });

  it('switches to measuring once a change is live', async () => {
    fill(12);
    const t = tunerWith({ changes: [{ key: 'MOONBAG_TRIM_PCT', value: 30, why: 'x' }] });
    await t.tick();

    expect(t.progress().screener).toMatchObject({ phase: 'measuring', trades: 0 });
    fill(5);
    expect(t.progress().screener).toMatchObject({ phase: 'measuring', trades: 5, needed: 10 });
  });

  it('publishes when the next review is due', () => {
    const t = tunerWith({ changes: [] });
    // Never run: due immediately, rather than a whole interval after boot.
    expect(t.nextRunAt).toBeLessThanOrEqual(Date.now() + cfg.TUNER_INTERVAL_MINUTES * 60_000);
  });
});

describe('the audit trail', () => {
  it('survives a restart', () => {
    const ledger = new TuningLedger(dir);
    ledger.add({
      id: 'e1',
      bot: 'screener',
      startedAt: Date.now(),
      changes: [{ key: 'MOONBAG_TRIM_PCT', from: 25, to: 30, why: 'because' }],
      baselineExpectancy: -0.05,
      baselineTrades: 40,
      journalAtStart: 40,
      status: 'running',
    });

    expect(existsSync(join(dir, 'tuning.json'))).toBe(true);
    const reopened = new TuningLedger(dir);
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.running('screener')?.id).toBe('e1');

    // Readable on disk without the bot: this is an audit trail for software
    // that edits its own trading settings.
    const raw = JSON.parse(readFileSync(join(dir, 'tuning.json'), 'utf8'));
    expect(raw.experiments[0].changes[0].why).toBe('because');
  });

  it('starts fresh rather than refusing to boot on a corrupt file', () => {
    const ledger = new TuningLedger(dir);
    ledger.add({
      id: 'e1',
      bot: 'screener',
      startedAt: 1,
      changes: [],
      baselineExpectancy: 0,
      baselineTrades: 0,
      journalAtStart: 0,
      status: 'running',
    });
    // Corrupt it, then reopen. Losing tuning history is survivable; refusing to
    // start the trading bot over it is not.
    require('node:fs').writeFileSync(join(dir, 'tuning.json'), '{not json', 'utf8');
    expect(new TuningLedger(dir).all()).toHaveLength(0);
  });
});

describe('the evidence pack', () => {
  it('separates a fee problem from an entry problem', () => {
    // Positive before fees and negative after is a sizing/hold-time problem;
    // negative before fees is an entry problem. The tuner must be able to tell.
    const journal = Array.from({ length: 20 }, () =>
      trade({ pnlSol: -0.002, pnlPct: -0.8, proceedsSol: 0.248 }),
    );
    const e = buildEvidence('screener', journal, cfg);
    expect(e.netSol).toBeLessThan(0);
    expect(e.grossSol).toBeGreaterThan(0);
    expect(e.feeKilled).toBe(20);
  });

  it('computes the win rate the winner/loser pair needs', () => {
    const journal = [
      ...Array.from({ length: 5 }, () => trade({ pnlSol: 0.25, pnlPct: 100 })),
      ...Array.from({ length: 15 }, () => trade({ pnlSol: -0.05, pnlPct: -20 })),
    ];
    const e = buildEvidence('screener', journal, cfg);
    // +100 winners against -20 losers break even at 1 in 6.
    expect(e.requiredWinRatePct).toBeCloseTo(16.67, 1);
    expect(e.winRatePct).toBeCloseTo(25, 6);
  });

  it('renders without leaking anything secret into the prompt', () => {
    fill(12);
    const text = renderEvidence(buildEvidence('screener', store.journal(), cfg));
    expect(text).toContain('BOT: screener');
    expect(text).toContain('Win rate needed');
    expect(text).not.toContain(cfg.RPC_HTTP_URL);
    expect(text).not.toContain('sk-ant');
  });
});
