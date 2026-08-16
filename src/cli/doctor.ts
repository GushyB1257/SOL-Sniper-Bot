/**
 * Pre-flight check. Run this before ever setting MODE=live.
 *
 *   npm run doctor
 */
import { config } from '../config.js';
import { connection, lamportsToSol, loadKeypair } from '../util/solana.js';
import { errMessage } from '../util/async.js';
import {
  breakevenGrossPct,
  costModel,
  requiredWinRatePct,
  targetGrossPct,
} from '../strategy/costs.js';

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

async function main(): Promise<void> {
  console.log('\nSOL Sniper — pre-flight\n');
  let fatal = 0;

  const cfg = (() => {
    try {
      const c = config();
      ok(`config parsed (mode=${c.MODE}, executor=${c.EXECUTOR})`);
      return c;
    } catch (err) {
      bad(`config invalid:\n${errMessage(err)}`);
      process.exit(1);
    }
  })();

  // --- RPC ---------------------------------------------------------------
  const conn = connection(cfg);
  try {
    const started = Date.now();
    const slot = await conn.getSlot('confirmed');
    const latency = Date.now() - started;
    ok(`RPC reachable, slot ${slot}, ${latency}ms round-trip`);
    if (latency > 400) {
      warn(`${latency}ms is slow for sniping — expect to lose races to faster bots`);
    }
    if (cfg.RPC_HTTP_URL.includes('api.mainnet-beta.solana.com')) {
      warn('using the public RPC endpoint; it is rate-limited and will drop you mid-trade');
    }
  } catch (err) {
    bad(`RPC unreachable: ${errMessage(err)}`);
    fatal++;
  }

  // --- wallet ------------------------------------------------------------
  if (cfg.MODE === 'live') {
    try {
      const kp = loadKeypair(cfg.WALLET_PRIVATE_KEY);
      const balance = lamportsToSol(await conn.getBalance(kp.publicKey, 'confirmed'));
      ok(`wallet ${kp.publicKey.toBase58()} holds ${balance.toFixed(4)} SOL`);

      const needed = cfg.BUY_AMOUNT_SOL + cfg.MIN_WALLET_RESERVE_SOL;
      if (balance < needed) {
        bad(`balance below ${needed.toFixed(4)} SOL needed for one snipe plus reserve`);
        fatal++;
      }
      const snipes = Math.floor((balance - cfg.MIN_WALLET_RESERVE_SOL) / cfg.BUY_AMOUNT_SOL);
      ok(`funds ${snipes} snipe(s) at ${cfg.BUY_AMOUNT_SOL} SOL each`);

      if (balance > 5) {
        warn(`${balance.toFixed(2)} SOL in a hot wallet — this key sits in a .env file on disk`);
      }
    } catch (err) {
      bad(`wallet unusable: ${errMessage(err)}`);
      fatal++;
    }
  } else {
    ok('paper mode — no wallet needed, no transactions will be sent');
  }

  // --- fee arithmetic ----------------------------------------------------
  // The single most decisive number for a quick in-and-out strategy, and the
  // one most people never compute.
  if (cfg.SCALP_MODE) {
    const m = costModel(cfg);
    const be = breakevenGrossPct(m);
    const target = targetGrossPct(m, cfg.SCALP_TARGET_NET_PCT);
    const winRate = requiredWinRatePct(m, cfg.SCALP_TARGET_NET_PCT, cfg.SCALP_STOP_LOSS_PCT);

    console.log('');
    ok(`round-trip fees cost ${be.toFixed(2)}% at ${cfg.BUY_AMOUNT_SOL} SOL per position`);
    ok(`needs a ${target.toFixed(1)}% gross move to net +${cfg.SCALP_TARGET_NET_PCT}%`);
    ok(`needs >${winRate.toFixed(0)}% of trades to win, against a ${cfg.SCALP_STOP_LOSS_PCT}% stop`);

    if (be > 8) {
      warn(
        `breakeven is ${be.toFixed(1)}% — fixed priority fees dominate at this size. ` +
          `Raise BUY_AMOUNT_SOL (0.25+) or lower PRIORITY_FEE_SOL.`,
      );
    }
    if (cfg.SCALP_TARGET_NET_PCT < be / 2) {
      warn(
        `target +${cfg.SCALP_TARGET_NET_PCT}% net is small next to ${be.toFixed(1)}% fees — ` +
          'most of each winner is paid to the program and the validator',
      );
    }
    if (winRate > 75) {
      warn(
        `a ${winRate.toFixed(0)}% win rate is a demanding bar. Widen the target or ` +
          'tighten the stop to improve the risk/reward.',
      );
    }
  }

  // --- ladder sanity (long-hold strategy only) ---------------------------
  if (cfg.SCALP_MODE) {
    console.log(
      fatal === 0
        ? '\n\x1b[32mReady.\x1b[0m Start in paper mode and let it gather trades before judging it.\n'
        : `\n\x1b[31m${fatal} blocking problem(s).\x1b[0m Fix them before running.\n`,
    );
    process.exit(fatal === 0 ? 0 : 1);
  }

  const sold = cfg.EXIT_LADDER.reduce((a, t) => a + t.sellPctOfOriginal, 0);
  ok(`ladder sells ${sold}% across ${cfg.EXIT_LADDER.length} rungs, ${100 - sold}% moonbag`);

  // Where does the original stake come back? Find the rung at which cumulative
  // proceeds cover the entry, assuming the modelled gains are realised.
  let cumulative = 0;
  let breakEvenRung: number | null = null;
  for (let i = 0; i < cfg.EXIT_LADDER.length; i++) {
    const t = cfg.EXIT_LADDER[i]!;
    cumulative += (t.sellPctOfOriginal / 100) * (1 + t.gainPct / 100);
    if (cumulative >= 1 && breakEvenRung === null) breakEvenRung = i + 1;
  }
  if (breakEvenRung) {
    ok(`stake fully recovered at rung ${breakEvenRung} (+${cfg.EXIT_LADDER[breakEvenRung - 1]!.gainPct}%)`);
  } else {
    warn(
      `ladder never recovers the stake (${(cumulative * 100).toFixed(0)}% of it at best) — ` +
        'every trade depends on the moonbag to break even',
    );
  }

  // Expectancy floor: what win rate does this ladder need to survive?
  const worstCase = -1;
  const ladderCase = cumulative - 1;
  if (ladderCase > 0) {
    const needed = (-worstCase / (ladderCase - worstCase)) * 100;
    ok(`needs >${needed.toFixed(0)}% of trades to reach the full ladder just to break even`);
  }

  console.log(
    fatal === 0
      ? '\n\x1b[32mReady.\x1b[0m Start in paper mode and leave it running a few hours before going live.\n'
      : `\n\x1b[31m${fatal} blocking problem(s).\x1b[0m Fix them before running.\n`,
  );
  process.exit(fatal === 0 ? 0 : 1);
}

void main();
