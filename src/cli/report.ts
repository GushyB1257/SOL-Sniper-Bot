/**
 * Trade journal report.
 *
 *   npm run report
 */
import { config } from '../config.js';
import { Store } from '../state/store.js';

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function main(): void {
  const cfg = config();
  const store = new Store(cfg.DATA_DIR);
  const journal = [...store.journal()];

  if (journal.length === 0) {
    console.log('\nNo closed trades yet.\n');
    return;
  }

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

  // --- the part that actually answers "is this working" -------------------

  // A position only reaches these exits after clearing the first rung, so this
  // is the share of entries that went anywhere at all.
  const REACHED = ['ladder', 'trailing_stop', 'moonbag_trailing_stop', 'max_hold'];
  const reached = journal.filter((t) =>
    REACHED.some((r) => t.closeReason.startsWith(r)),
  ).length;
  const reachedPct = (reached / journal.length) * 100;

  console.log('\n' + '═'.repeat(88));
  console.log('VERDICT');
  console.log('═'.repeat(88));
  console.log(
    `Reached the first rung   ${reachedPct.toFixed(1)}% of entries (${reached}/${journal.length})`,
  );
  console.log(
    '  This is the number the whole strategy rests on. The ladder only pays if\n' +
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

main();
