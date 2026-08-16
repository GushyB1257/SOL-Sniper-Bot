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
  console.log();
}

main();
