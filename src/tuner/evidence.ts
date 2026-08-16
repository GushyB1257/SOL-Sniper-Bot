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
}

function numberFrom(note: string | undefined, re: RegExp): number | null {
  const m = note?.match(re);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
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
  };
}

/** Compact enough to sit in a prompt without burying the signal. */
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
    b('Entry market cap', e.byEntryMcap) +
    b('Entry volume', e.byEntryVolume) +
    b('Age at entry', e.byEntryAge) +
    b('Socials at entry', e.bySocials) +
    b('Hold time', e.byHoldTime)
  );
}
