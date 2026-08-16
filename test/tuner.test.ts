import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoTuner } from '../src/tuner/auto-tuner.js';
import { TUNABLES, TUNABLE_BY_KEY, vetProposal } from '../src/tuner/limits.js';
import { TuningLedger } from '../src/tuner/ledger.js';
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
  it('refuses anything outside the whitelist', () => {
    // The whole safety story rests on this list. A model that can widen its own
    // risk limits is a way to lose everything with the dashboard showing green.
    for (const key of [
      'BUY_AMOUNT_SOL',
      'MAX_CONCURRENT_POSITIONS',
      'DAILY_LOSS_LIMIT_SOL',
      'HOURLY_SPEND_CAP_SOL',
      'MAX_CONSECUTIVE_LOSSES',
      'MIN_WALLET_RESERVE_SOL',
      'RATCHET_STOP_LOSS_PCT',
      'BUY_SLIPPAGE_PCT',
      'SELL_SLIPPAGE_PCT',
      'MODE',
      'EXECUTOR',
      'WALLET_PRIVATE_KEY',
      'AUTO_TUNE_ENABLED',
    ]) {
      expect(TUNABLE_BY_KEY.has(key), `${key} must not be tunable`).toBe(false);
      expect(vetProposal(key, 1, 2).ok).toBe(false);
    }
  });

  it('only lists keys the config actually has', () => {
    const known = new Set(Object.keys(cfg));
    for (const t of TUNABLES) expect(known.has(t.key), `${t.key} is not a config key`).toBe(true);
  });

  it('clamps to the hard range rather than trusting the model', () => {
    const spec = TUNABLE_BY_KEY.get('MIN_SAFETY_SCORE')!;
    const huge = vetProposal('MIN_SAFETY_SCORE', 70, 10_000, 100);
    expect(huge.ok && huge.value).toBe(spec.max);
    const tiny = vetProposal('MIN_SAFETY_SCORE', 70, -5, 100);
    expect(tiny.ok && tiny.value).toBe(spec.min);
  });

  it('limits how far one round can move a parameter', () => {
    // This is what stops a series of individually reasonable rounds walking a
    // parameter somewhere no single round would have proposed.
    const r = vetProposal('SCREEN_MIN_VOLUME_USD', 3000, 30_000, 30);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeCloseTo(3900, 6);
      expect(r.clamped).toMatch(/step limited/);
    }
  });

  it('rejects a proposal that changes nothing', () => {
    expect(vetProposal('MOONBAG_TRIM_PCT', 25, 25).ok).toBe(false);
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
      changes: [{ key: 'BUY_AMOUNT_SOL', value: 5, why: 'bigger positions clear fees' }],
    });
    await t.tick();

    expect(settings.values().BUY_AMOUNT_SOL).toBe('0.25');
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

  it('settles a verdict without stacking a new change in the same cycle', async () => {
    const t = await runAndSettle(0.1);
    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.status).toBe('kept');
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
