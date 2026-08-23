import type { Config } from '../config.js';
import type { TradeJournalEntry } from '../types.js';
import { breakevenGrossPct, costModel, roundTripCostSol } from '../strategy/costs.js';

/**
 * The attribution the tuner reasons over.
 *
 * Deliberately the same breakdown `npm run report` prints, because a change
 * the model makes should be one you could have justified yourself from the
 * terminal. If the two ever disagree, the model is working from something you
 * cannot check, and that is worse than not tuning at all.
 */
export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  pnlSol: number;
}

export interface Evidence {
  bot: string;
  trades: number;
  wins: number;
  winRatePct: number;
  netSol: number;
  deployedSol: number;
  profitFactor: number | null;
  avgWinPct: number;
  avgLossPct: number;
  /** Win rate this winner/loser pair needs just to break even. */
  requiredWinRatePct: number;
  /** Total fees paid across these trades. */
  feesSol: number;
  /** P&L before fees. Positive here with a negative net means sizing, not picks. */
  grossSol: number;
  /** Gross move needed to break even at the average position size. */
  breakevenPct: number;
  /** Losses that would have been wins without fees. */
  feeKilled: number;
  exitReasons: Bucket[];
  byEntryMcap: Bucket[];
  byEntryVolume: Bucket[];
  byEntryAge: Bucket[];
  bySocials: Bucket[];
  byHoldTime: Bucket[];
  /**
   * Sniper entry characteristics, from the safety battery's own measurements.
   *
   * These are the breakdown that makes entry-filter tuning something other than
   * guesswork. Empty for a bot whose entries do not run the battery.
   */
  byDevBuy: Bucket[];
  byHolders: Bucket[];
  byBundle: Bucket[];
  byDeployerBalance: Bucket[];
  byCreatorAge: Bucket[];
  byConfirmMove: Bucket[];
  /**
   * How well stop-triggered exits actually landed.
   *
   * `undefined` when no closed trade recorded both a trigger and a realised
   * move — a bot with no price stops, or a journal written before exits carried
   * the detail.
   *
   * This exists because the tuner could see that stop exits lost heavily and
   * could not see WHY. A stop is the level at which the bot decides to sell,
   * not the level it sells at, and the difference splits two ways with opposite
   * fixes: a trigger set too loose, or a bot that looked too late. Everything
   * above is silent on which, so the model was left inferring it from average
   * loss size — and, correctly, hedging.
   */
  exitQuality?: ExitQuality;
}

/** One poll-gap band, and how far past its trigger the average exit in it landed. */
export interface GapBucket {
  key: string;
  trades: number;
  avgOvershootPct: number;
  pnlSol: number;
}

export interface ExitQuality {
  /** Stop exits that recorded both the trigger and the move realised. */
  samples: number;
  /** Mean trigger across them, so the overshoot has something to sit against. */
  avgTriggerPct: number;
  /** Mean move actually realised at the moment of the decision. */
  avgRealisedPct: number;
  /** Points past the trigger, on average. The whole quantity in question. */
  avgOvershootPct: number;
  /** Exits that also recorded a poll gap. Older journal rows will not have one. */
  gapSamples: number;
  medianGapSeconds: number;
  p90GapSeconds: number;
  /**
   * Overshoot banded by how long the position went unpriced.
   *
   * The decisive table: overshoot that climbs with the gap is the bot arriving
   * late, and overshoot flat across the bands is the market moving inside a
   * single tick — in which case the trigger is what wants changing, not the
   * cadence.
   */
  byPollGap: GapBucket[];
}

function numberFrom(note: string | undefined, re: RegExp): number | null {
  const m = note?.match(re);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pulls the exit detail back apart: `stop_loss: down -31.2% (stop -15.75%)
 * after 6.4s unpriced`.
 *
 * The gap is optional on purpose — trades closed before exits started recording
 * it still carry a usable trigger and realised move, and dropping them would
 * throw away most of the history on the first run after the change.
 */
function exitDetail(
  t: TradeJournalEntry,
): { realisedPct: number; triggerPct: number; gapSeconds: number | null } | null {
  const move = t.closeReason.match(/down (-?[\d.]+)% \(stop (-?[\d.]+)%\)/);
  if (!move?.[1] || !move[2]) return null;
  const realisedPct = Number(move[1]);
  const triggerPct = Number(move[2]);
  if (!Number.isFinite(realisedPct) || !Number.isFinite(triggerPct)) return null;
  const gap = numberFrom(t.closeReason, /after ([\d.]+)s unpriced/);
  return { realisedPct, triggerPct, gapSeconds: gap };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

function buildExitQuality(journal: readonly TradeJournalEntry[]): ExitQuality | undefined {
  const rows = journal
    .map((t) => {
      const d = exitDetail(t);
      return d === null ? null : { ...d, pnlSol: t.pnlSol };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return undefined;

  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  // Both are negative percentages, so the overshoot is how much further the
  // realised move fell past the trigger: |realised| - |trigger|.
  const overshoot = (r: { realisedPct: number; triggerPct: number }): number =>
    Math.abs(r.realisedPct) - Math.abs(r.triggerPct);

  const withGap = rows.filter((r) => r.gapSeconds !== null);
  const gaps = withGap.map((r) => r.gapSeconds!);

  const bands = new Map<string, { trades: number; overshoot: number; pnlSol: number }>();
  for (const r of withGap) {
    const key = band(r.gapSeconds!, [1, 3, 6], 's');
    const cur = bands.get(key) ?? { trades: 0, overshoot: 0, pnlSol: 0 };
    cur.trades += 1;
    cur.overshoot += overshoot(r);
    cur.pnlSol += r.pnlSol;
    bands.set(key, cur);
  }

  return {
    samples: rows.length,
    avgTriggerPct: mean(rows.map((r) => r.triggerPct)),
    avgRealisedPct: mean(rows.map((r) => r.realisedPct)),
    avgOvershootPct: mean(rows.map(overshoot)),
    gapSamples: withGap.length,
    medianGapSeconds: median(gaps),
    p90GapSeconds: percentile(gaps, 0.9),
    byPollGap: [...bands.entries()]
      .map(([key, v]) => ({
        key,
        trades: v.trades,
        avgOvershootPct: v.overshoot / v.trades,
        pnlSol: v.pnlSol,
      }))
      // Ascending by band, not by trade count: the shape of the relationship is
      // the finding, and it only reads as a trend in order.
      .sort((a, b) => parseFloat(a.key.replace('<', '')) - parseFloat(b.key.replace('<', ''))),
  };
}

function band(v: number, cuts: number[], unit: string): string {
  for (let i = 0; i < cuts.length; i++) {
    if (v < cuts[i]!) return i === 0 ? `<${cuts[0]}${unit}` : `${cuts[i - 1]}-${cuts[i]}${unit}`;
  }
  return `${cuts[cuts.length - 1]}${unit}+`;
}

function bucketise(
  journal: readonly TradeJournalEntry[],
  keyOf: (t: TradeJournalEntry) => string | null,
): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of journal) {
    const key = keyOf(t);
    if (key === null) continue;
    const cur = map.get(key) ?? { key, trades: 0, wins: 0, pnlSol: 0 };
    cur.trades += 1;
    if (t.pnlSol > 0) cur.wins += 1;
    cur.pnlSol += t.pnlSol;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.trades - a.trades);
}

export function buildEvidence(
  bot: string,
  journal: readonly TradeJournalEntry[],
  cfg: Config,
): Evidence {
  const wins = journal.filter((t) => t.pnlSol > 0);
  const losses = journal.filter((t) => t.pnlSol <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0));
  const netSol = journal.reduce((a, t) => a + t.pnlSol, 0);
  const deployedSol = journal.reduce((a, t) => a + t.costSol, 0);
  const feesSol = journal.reduce((a, t) => a + roundTripCostSol(costModel(cfg, t.costSol)), 0);

  const avgWinPct = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct =
    losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const spread = avgWinPct - avgLossPct;

  let feeKilled = 0;
  for (const t of journal) {
    if (t.pnlSol <= 0 && t.pnlSol + roundTripCostSol(costModel(cfg, t.costSol)) > 0) feeKilled += 1;
  }

  const avgSize = journal.length > 0 ? deployedSol / journal.length : cfg.BUY_AMOUNT_SOL;

  return {
    bot,
    trades: journal.length,
    wins: wins.length,
    winRatePct: journal.length > 0 ? (wins.length / journal.length) * 100 : 0,
    netSol,
    deployedSol,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinPct,
    avgLossPct,
    requiredWinRatePct: spread > 0 ? (-avgLossPct / spread) * 100 : 100,
    feesSol,
    grossSol: netSol + feesSol,
    breakevenPct: breakevenGrossPct(costModel(cfg, avgSize)),
    feeKilled,
    exitReasons: bucketise(journal, (t) => t.closeReason.split(':')[0]?.trim() || 'unknown'),
    exitQuality: buildExitQuality(journal),
    byEntryMcap: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /\$([\d.]+)k mcap/);
      return v === null ? null : band(v, [8, 12, 18], 'k');
    }),
    byEntryVolume: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /\$([\d.]+)k volume/);
      return v === null ? null : band(v, [5, 10, 20], 'k');
    }),
    byEntryAge: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(\d+)s old/);
      return v === null ? null : band(v, [15, 45, 120], 's');
    }),
    bySocials: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(\d+) socials?/);
      return v === null ? null : `${v}`;
    }),
    byHoldTime: bucketise(journal, (t) => band(t.holdSeconds, [15, 45, 120], 's')),
    // Sniper entries, from the safety battery's own measurements. Each maps
    // straight onto one parameter, which is the point: a losing bucket names the
    // knob to move instead of leaving a choice between equally plausible ones.
    byDevBuy: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /([\d.]+)% dev buy/);
      return v === null ? null : band(v, [1, 3, 5], '%');
    }),
    byHolders: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(\d+) holders/);
      return v === null ? null : band(v, [2, 4, 8], '');
    }),
    byBundle: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(\d+) bundled/);
      return v === null ? null : band(v, [2, 3, 5], ' txs');
    }),
    byDeployerBalance: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /([\d.]+) SOL dev balance/);
      return v === null ? null : band(v, [0.1, 0.5, 2], ' SOL');
    }),
    byConfirmMove: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(-?[\d.]+)% confirm move/);
      return v === null ? null : band(v, [0, 2, 8], '%');
    }),
    byCreatorAge: bucketise(journal, (t) => {
      const v = numberFrom(t.entryNote, /(\d+)m creator age/);
      return v === null ? null : band(v, [30, 180, 1440], 'm');
    }),
  };
}

/** Compact enough to sit in a prompt without burying the signal. */
/**
 * The stop-quality section.
 *
 * Written to be read as an argument rather than a table dump, because the
 * conclusion depends on the SHAPE of the last block and a model reading a bare
 * list of bands will not necessarily notice that.
 */
function renderExitQuality(q: ExitQuality | undefined): string {
  if (!q) return '';

  const head =
    `\nStop exits: how far past the trigger they actually landed (${q.samples} trades)\n` +
    `  trigger averaged ${q.avgTriggerPct.toFixed(1)}%, realised move averaged ` +
    `${q.avgRealisedPct.toFixed(1)}%\n` +
    `  overshoot: ${q.avgOvershootPct.toFixed(1)} points past the trigger, on average\n` +
    '  A stop is the level the bot DECIDES to sell at, not the level it sells at.\n' +
    '  Overshoot is everything between the two, and it is not a cost you can\n' +
    '  price in — it is either the trigger sitting too loose or the bot looking\n' +
    '  too late.\n';

  if (q.gapSamples === 0) {
    return (
      head +
      '  No poll-gap data on these trades yet (they closed before exits started\n' +
      '  recording it). Until some accumulates, the split above is unattributed —\n' +
      '  do not move POSITION_TICK_INTERVAL_MS on the overshoot figure alone.\n'
    );
  }

  const rows = q.byPollGap
    .map(
      (r) =>
        `  ${r.key.padEnd(10)} ${String(r.trades).padStart(4)} trades  ` +
        `${r.avgOvershootPct.toFixed(1).padStart(6)} pts past trigger  ` +
        `${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL` +
        (r.trades < 10 ? '  (thin)' : ''),
    )
    .join('\n');

  return (
    head +
    `  time unpriced when the stop fired: median ${q.medianGapSeconds.toFixed(1)}s, ` +
    `p90 ${q.p90GapSeconds.toFixed(1)}s (${q.gapSamples} trades)\n` +
    '\nOvershoot by how long the position went unpriced:\n' +
    rows +
    '\n' +
    '  Read the SHAPE, not the rows. Overshoot that climbs across the bands is\n' +
    '  the bot arriving late -> POSITION_TICK_INTERVAL_MS (and check whether the\n' +
    '  RPC health block shows reads queueing). Overshoot roughly flat across them\n' +
    '  is the market moving inside a single tick, which a faster poll cannot\n' +
    '  catch -> the trigger itself is what wants changing, or the entry that put\n' +
    '  you in front of that move. Lowering the tick interval costs RPC load on\n' +
    '  every position, so it needs the climbing shape to justify it.\n'
  );
}

export function renderEvidence(e: Evidence): string {
  const b = (name: string, rows: Bucket[]): string =>
    rows.length < 2
      ? ''
      : `\n${name}:\n` +
        rows
          .map(
            (r) =>
              `  ${r.key.padEnd(14)} ${String(r.trades).padStart(4)} trades  ` +
              `${String(Math.round((r.wins / r.trades) * 100)).padStart(3)}% win  ` +
              `${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL` +
              (r.trades < 10 ? '  (thin)' : ''),
          )
          .join('\n');

  return (
    `BOT: ${e.bot}\n` +
    `Closed trades: ${e.trades}   Win rate: ${e.winRatePct.toFixed(1)}%\n` +
    `Net: ${e.netSol >= 0 ? '+' : ''}${e.netSol.toFixed(5)} SOL on ${e.deployedSol.toFixed(3)} deployed\n` +
    `Profit factor: ${e.profitFactor === null ? 'n/a' : e.profitFactor.toFixed(2)}\n` +
    `Average winner ${e.avgWinPct >= 0 ? '+' : ''}${e.avgWinPct.toFixed(1)}%, ` +
    `average loser ${e.avgLossPct.toFixed(1)}%\n` +
    `Win rate needed for that pair to break even: ${e.requiredWinRatePct.toFixed(1)}% ` +
    `(actual ${e.winRatePct.toFixed(1)}%)\n` +
    `Fees paid: ${e.feesSol.toFixed(5)} SOL. Before fees ${e.grossSol >= 0 ? '+' : ''}` +
    `${e.grossSol.toFixed(5)}, after fees ${e.netSol >= 0 ? '+' : ''}${e.netSol.toFixed(5)}\n` +
    `Breakeven move at the average size: ${e.breakevenPct.toFixed(2)}% gross\n` +
    `Losses that were wins before fees: ${e.feeKilled}\n` +
    b('Exits by reason', e.exitReasons) +
    renderExitQuality(e.exitQuality) +
    // A reason is only useful if it names the parameter behind it. Without
    // this the model has to infer which timer produced an exit from hold times,
    // which is what it was reduced to while three separate timers all reported
    // themselves as `time_stop`.
    'Which parameter each timed exit belongs to:\n' +
    '  dead_entry      -> RATCHET_FIRST_CHECKPOINT_SECONDS (never started)\n' +
    '  checkpoint_cut  -> CHECKPOINT_SECONDS (was working, stopped)\n' +
    '  ratchet_stall   -> CHECKPOINT_SECONDS + RATCHET_MIN_PROGRESS_PCT (no new high)\n' +
    '  time_stop       -> TIME_STOP_SECONDS (ladder mode only)\n' +
    '  scalp_time_stop -> SCALP_TIME_STOP_SECONDS (scalp mode only)\n' +
    '  trailing_stop   -> RATCHET_GIVEBACK_PCT (gave back too much of the peak)\n' +
    '  max_hold        -> MAX_HOLD_SECONDS\n' +
    'Trades closed before this change may still carry the older shared label.\n' +
    b('Entry market cap', e.byEntryMcap) +
    b('Entry volume', e.byEntryVolume) +
    b('Age at entry', e.byEntryAge) +
    b('Socials at entry', e.bySocials) +
    b('Hold time', e.byHoldTime) +
    // Sniper only, and each names the parameter it is evidence about.
    b('Deployer buy % at entry (MAX_DEV_BUY_PCT)', e.byDevBuy) +
    b('Holders at entry (MIN_HOLDERS)', e.byHolders) +
    b('Creation-slot transactions (MAX_LAUNCH_BUNDLE_TXS)', e.byBundle) +
    b('Deployer balance (MIN_DEPLOYER_BALANCE_SOL)', e.byDeployerBalance) +
    b('Creator wallet age (MIN_CREATOR_AGE_MINUTES)', e.byCreatorAge) +
    b('Move during confirmation (SNIPE_CONFIRM_MIN_GAIN_PCT)', e.byConfirmMove)
  );
}
