/**
 * Trade journal report.
 *
 *   npm run report            every bot
 *   npm run report screener   just one
 *
 * This used to read only `state.json`, which is the screener's file — so the
 * sniper's and the copy trader's results were invisible no matter how long they
 * ran. Each bot keeps its own journal precisely so they can be compared, and a
 * report that shows one of them defeats the point.
 */
import { config } from '../config.js';
import { Store } from '../state/store.js';
import {
  breakevenGrossPct,
  costModel,
  netPnlSol,
  roundTripCostSol,
} from '../strategy/costs.js';
import type { Config } from '../config.js';
import type { TradeJournalEntry } from '../types.js';

const BOTS = ['screener', 'sniper', 'copy'] as const;
type BotId = (typeof BOTS)[number];

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

/** Pulls a number back out of the entry note the orchestrator wrote. */
function numberFrom(note: string | undefined, re: RegExp): number | null {
  const m = note?.match(re);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Labels a value by which of the given cut points it falls between. */
function band(v: number, cuts: number[], unit: string): string {
  for (let i = 0; i < cuts.length; i++) {
    if (v < cuts[i]!) return i === 0 ? `< ${cuts[0]}${unit}` : `${cuts[i - 1]}-${cuts[i]}${unit}`;
  }
  return `${cuts[cuts.length - 1]}${unit}+`;
}

/**
 * Groups closed trades by some property of the entry and prints PnL per group.
 *
 * A single blended win rate cannot tell you which threshold to move. Split the
 * same trades by the conditions they were taken under and the answer usually
 * falls out: one band is carrying the strategy and another is bleeding.
 */
function bucketReport(
  title: string,
  journal: readonly TradeJournalEntry[],
  keyOf: (t: TradeJournalEntry) => string | null,
): void {
  const buckets = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const t of journal) {
    const key = keyOf(t);
    if (key === null) continue;
    const cur = buckets.get(key) ?? { n: 0, wins: 0, pnl: 0 };
    cur.n += 1;
    if (t.pnlSol > 0) cur.wins += 1;
    cur.pnl += t.pnlSol;
    buckets.set(key, cur);
  }
  if (buckets.size < 2) return; // one bucket compares with nothing

  console.log(`\n${title}:`);
  const rows = [...buckets].sort((a, b) => b[1].n - a[1].n);
  for (const [key, v] of rows) {
    const colour = v.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    const thin = v.n < 10 ? '  (thin)' : '';
    console.log(
      `  ${pad(key, 16)}${String(v.n).padStart(4)} trades  ` +
        `${String(Math.round((v.wins / v.n) * 100)).padStart(3)}% win  ` +
        `${colour}${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(4)} SOL\x1b[0m${thin}`,
    );
  }
}

/**
 * Where the money actually went.
 *
 * A strategy that loses money can lose it two very different ways: it picks
 * badly, or it picks fine and hands the edge to fees. Those need opposite
 * fixes — one is a filter change, the other is a size or hold-time change —
 * and the blended P&L cannot tell them apart. This splits them.
 */
function feeReport(journal: readonly TradeJournalEntry[], cfg: Config): void {
  const fees = journal.reduce(
    (a, t) => a + roundTripCostSol(costModel(cfg, t.costSol)),
    0,
  );
  const net = journal.reduce((a, t) => a + t.pnlSol, 0);
  const gross = net + fees;

  // A trade whose price move cleared the fee bar but whose net was still
  // negative was killed by costs, not by the entry.
  let feeKilled = 0;
  for (const t of journal) {
    const model = costModel(cfg, t.costSol);
    if (t.pnlSol <= 0 && t.pnlSol + roundTripCostSol(model) > 0) feeKilled += 1;
  }

  const avgSize = journal.reduce((a, t) => a + t.costSol, 0) / journal.length;
  const be = breakevenGrossPct(costModel(cfg, avgSize));

  console.log('\nWhat fees cost:');
  console.log(`  Round trips        ${journal.length} at an average ${avgSize.toFixed(4)} SOL`);
  console.log(`  Breakeven move     ${be.toFixed(2)}% gross at that size`);
  console.log(`  Paid in fees       ${fees.toFixed(5)} SOL`);
  console.log(
    `  Before fees        ${gross >= 0 ? '+' : ''}${gross.toFixed(5)} SOL` +
      `   after fees ${net >= 0 ? '+' : ''}${net.toFixed(5)} SOL`,
  );
  if (feeKilled > 0) {
    console.log(
      `  Losses that were wins before fees: ${feeKilled}` +
        `  (${((feeKilled / journal.length) * 100).toFixed(0)}% of all trades)`,
    );
  }
  if (gross > 0 && net <= 0) {
    console.log(
      '\n  \x1b[33mThe entries are not the problem — the size is.\x1b[0m Price moves were net\n' +
        '  positive and fees took all of it. Raising position size lowers the fee\n' +
        `  drag (the fixed priority fee stops dominating): at 0.5 SOL breakeven is\n` +
        `  ${breakevenGrossPct(costModel(cfg, 0.5)).toFixed(2)}%, at 1 SOL it is ` +
        `${breakevenGrossPct(costModel(cfg, 1)).toFixed(2)}%. Holding for larger moves does\n` +
        '  the same job without risking more per trade.',
    );
  } else if (gross <= 0) {
    console.log(
      '\n  \x1b[33mFees are not the problem — the entries are.\x1b[0m The trades lost money\n' +
        '  before a single fee was charged. Tighten the entry filter using the\n' +
        '  buckets above; no amount of sizing fixes a negative gross edge.',
    );
  }

  // What the average winner and loser look like, in the cost model's terms.
  const wins = journal.filter((t) => t.pnlSol > 0);
  const losses = journal.filter((t) => t.pnlSol <= 0);
  if (wins.length > 0 && losses.length > 0) {
    const avgWinPct = wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length;
    const avgLossPct = losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length;
    const needed = (-avgLossPct / (avgWinPct - avgLossPct)) * 100;
    const actual = (wins.length / journal.length) * 100;
    console.log(
      `\n  Average winner ${avgWinPct >= 0 ? '+' : ''}${avgWinPct.toFixed(1)}%, ` +
        `average loser ${avgLossPct.toFixed(1)}%`,
    );
    console.log(
      `  Win rate needed for that pair to break even: ${needed.toFixed(1)}%  ` +
        `(actual ${actual.toFixed(1)}%)`,
    );
    console.log(
      actual >= needed
        ? '  The shape works. Anything above this line is edge.'
        : '  \x1b[31mThe shape does not work.\x1b[0m Either winners must run further before the\n' +
            '  exit closes them, or losers must be cut sooner. Changing the entry filter\n' +
            '  alone will not close a gap this size.',
    );
  }
}

function reportOne(bot: BotId, cfg: Config): boolean {
  const store = new Store(cfg.DATA_DIR, bot);
  const journal = [...store.journal()];

  console.log(`\n\n${'█'.repeat(88)}`);
  console.log(`  ${bot.toUpperCase()}`);
  console.log('█'.repeat(88));

  if (journal.length === 0) {
    console.log('\nNo closed trades yet.\n');
    store.close();
    return false;
  }
  reportJournal(journal, cfg);
  store.close();
  return true;
}

function reportJournal(journal: readonly TradeJournalEntry[], cfg: Config): void {

  console.log(`\n${pad('SYMBOL', 12)}${pad('PNL SOL', 12)}${pad('PNL %', 10)}${pad('HELD', 9)}REASON`);
  console.log('─'.repeat(88));
  for (const t of journal.slice(-40)) {
    const sign = t.pnlSol >= 0 ? '+' : '';
    const colour = t.pnlSol >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(
      pad(t.symbol ?? t.mint.slice(0, 8), 12) +
        colour +
        pad(`${sign}${t.pnlSol.toFixed(5)}`, 12) +
        pad(`${sign}${t.pnlPct.toFixed(1)}%`, 10) +
        '\x1b[0m' +
        pad(`${Math.round(t.holdSeconds)}s`, 9) +
        t.closeReason,
    );
  }

  const net = journal.reduce((a, t) => a + t.pnlSol, 0);
  const wins = journal.filter((t) => t.pnlSol > 0);
  const losses = journal.filter((t) => t.pnlSol <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0));
  const deployed = journal.reduce((a, t) => a + t.costSol, 0);

  console.log('─'.repeat(88));
  console.log(`Trades        ${journal.length}`);
  console.log(`Win rate      ${((wins.length / journal.length) * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`Net PnL       ${net >= 0 ? '+' : ''}${net.toFixed(5)} SOL on ${deployed.toFixed(4)} SOL deployed`);
  console.log(`Return        ${deployed > 0 ? ((net / deployed) * 100).toFixed(1) : '0'}%`);
  console.log(
    `Profit factor ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞'}` +
      '   (gross wins ÷ gross losses; below 1.0 means the strategy loses money)',
  );
  if (wins.length > 0) {
    console.log(`Avg winner    +${(grossWin / wins.length).toFixed(5)} SOL`);
  }
  if (losses.length > 0) {
    console.log(`Avg loser     -${(grossLoss / losses.length).toFixed(5)} SOL`);
  }

  // Exit-reason breakdown answers the question that actually matters: is the
  // ladder ever reached, or is everything dying on the time stop?
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of journal) {
    const key = t.closeReason.split(':')[0] ?? 'unknown';
    const cur = byReason.get(key) ?? { n: 0, pnl: 0 };
    cur.n += 1;
    cur.pnl += t.pnlSol;
    byReason.set(key, cur);
  }
  console.log('\nExits by reason:');
  for (const [reason, v] of [...byReason].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${pad(reason, 24)}${String(v.n).padStart(4)}  ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(4)} SOL`);
  }

  // Entry-condition breakdown. The exit reasons say how trades ended; this says
  // which entries were worth taking. Move the threshold whose worst bucket is
  // both large and negative — that is the whole tuning loop, and it needs data
  // rather than opinion.
  bucketReport('Entry market cap', journal, (t) => {
    const v = numberFrom(t.entryNote, /\$([\d.]+)k mcap/);
    return v === null ? null : band(v, [8, 12, 18], 'k');
  });
  bucketReport('Entry volume', journal, (t) => {
    const v = numberFrom(t.entryNote, /\$([\d.]+)k volume/);
    return v === null ? null : band(v, [5, 10, 20], 'k');
  });
  bucketReport('Age at entry', journal, (t) => {
    const v = numberFrom(t.entryNote, /(\d+)s old/);
    return v === null ? null : band(v, [15, 45, 120], 's');
  });
  bucketReport('Socials', journal, (t) => {
    const v = numberFrom(t.entryNote, /(\d+) socials?/);
    return v === null ? null : `${v} social${v === 1 ? '' : 's'}`;
  });
  bucketReport('Hold time', journal, (t) => band(t.holdSeconds, [15, 45, 120], 's'));

  feeReport(journal, cfg);

  // --- the part that actually answers "is this working" -------------------

  // The share of entries that went anywhere at all. Which exits count depends
  // on the mode: under the ladder it is clearing the first rung, under the
  // ratchet it is getting far enough to bank something. Reporting the ladder's
  // reasons while running the ratchet prints 0% forever and reads as a
  // catastrophe when it only means the metric is the wrong one.
  const ratchet = cfg.EXIT_MODE === 'ratchet';
  const REACHED = ratchet
    ? ['cost_recovery', 'moonbag_trim', 'ratchet_stall', 'trailing_stop']
    : ['ladder', 'trailing_stop', 'moonbag_trailing_stop', 'max_hold'];
  const reached = journal.filter((t) =>
    REACHED.some((r) => t.closeReason.startsWith(r)),
  ).length;
  const reachedPct = (reached / journal.length) * 100;

  console.log('\n' + '═'.repeat(88));
  console.log('VERDICT');
  console.log('═'.repeat(88));
  console.log(
    `${ratchet ? 'Got into profit        ' : 'Reached the first rung '}  ` +
      `${reachedPct.toFixed(1)}% of entries (${reached}/${journal.length})`,
  );
  console.log(
    ratchet
      ? '  Everything else was cut at a checkpoint for not clearing fees. This is\n' +
        '  the number the whole strategy rests on.'
      : '  This is the number the whole strategy rests on. The ladder only pays if\n' +
        '  enough entries survive to the first take-profit.',
  );

  // Sample size. A handful of trades tells you nothing: memecoin returns are
  // dominated by rare large winners, so a small sample either missed them
  // (looks terrible) or caught one (looks amazing). Neither generalises.
  console.log('');
  if (journal.length < 30) {
    console.log(`Sample size              ${journal.length} trades — NOT ENOUGH TO CONCLUDE ANYTHING.`);
    console.log('  Keep running. Under ~30 trades this is noise, whatever it says.');
  } else if (journal.length < 100) {
    console.log(`Sample size              ${journal.length} trades — early read, treat as provisional.`);
    console.log('  Aim for 100+ before you take the profit factor seriously.');
  } else if (journal.length < 300) {
    console.log(`Sample size              ${journal.length} trades — rough read.`);
    console.log('  Usable signal, but one big winner still moves the result a lot.');
  } else {
    console.log(`Sample size              ${journal.length} trades — reasonable sample.`);
  }

  console.log('');
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  if (journal.length < 30) {
    console.log('Bottom line              Too early to say. Do not go live on this.');
  } else if (pf < 1) {
    console.log('Bottom line              LOSING on paper. Live would be worse — paper cannot');
    console.log('                         simulate losing the race or finding no bid on exit.');
    console.log('                         Do not fund this. Change the strategy or stop.');
  } else if (pf < 1.3) {
    console.log('Bottom line              Marginal. A profit factor this thin does not survive');
    console.log('                         real-world slippage and missed fills. Not fundable yet.');
  } else {
    console.log('Bottom line              Profitable on paper. Remember paper is a CEILING:');
    console.log('                         it assumes every buy landed and every sell found a bid.');
    console.log('                         If you go live, start at the smallest size you can.');
  }
  console.log();
}

function main(): void {
  const cfg = config();
  const asked = process.argv[2]?.toLowerCase();

  if (asked && !BOTS.includes(asked as BotId)) {
    console.log(`\nUnknown bot "${asked}". Use one of: ${BOTS.join(', ')}\n`);
    return;
  }

  const wanted = asked ? [asked as BotId] : BOTS;
  let any = false;
  for (const bot of wanted) any = reportOne(bot, cfg) || any;

  if (!any) {
    console.log(
      '\nNothing has closed yet on any bot. Run for a while, then come back.\n' +
        'Journals live in ' +
        cfg.DATA_DIR +
        ' (state.json = screener, state-sniper.json, state-copy.json).\n',
    );
  }
}

main();
