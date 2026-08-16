import type { Connection } from '@solana/web3.js';
import type { CheckResult, SafetyVerdict, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Check, CheckContext } from './types.js';
import { logger } from '../logger.js';
import { errMessage, withTimeout } from '../util/async.js';

import { freezeAuthorityCheck, mintAuthorityCheck } from './checks/authorities.js';
import {
  deployerBalanceCheck,
  deployerHistoryCheck,
  deployerSpamCheck,
} from './checks/deployer.js';
import {
  curveSanityCheck,
  devBuyCheck,
  holderConcentrationCheck,
} from './checks/supply.js';
import {
  duplicateNameCheck,
  metadataSanityCheck,
  socialsCheck,
} from './checks/metadata.js';

const log = logger('safety');

export const DEFAULT_CHECKS: readonly Check[] = [
  // Fatal — any one of these vetoes the buy outright.
  freezeAuthorityCheck,
  mintAuthorityCheck,
  devBuyCheck,
  deployerHistoryCheck,
  // Scored.
  deployerBalanceCheck,
  deployerSpamCheck,
  metadataSanityCheck,
  socialsCheck,
  duplicateNameCheck,
  curveSanityCheck,
  holderConcentrationCheck,
];

/**
 * Runs the check battery and produces a verdict.
 *
 * Everything runs in parallel with individual timeouts, because the entire
 * evaluation has to complete inside the few seconds a launch is still worth
 * sniping. Slowest check sets the floor, not the sum.
 *
 * No filter set catches every rug. These raise the cost of scamming this bot
 * above the cost of scamming an unfiltered one; they do not make the trade safe.
 */
export class SafetyEngine {
  constructor(
    private readonly cfg: Config,
    private readonly conn: Connection,
    private readonly store: Store,
    private readonly checks: readonly Check[] = DEFAULT_CHECKS,
  ) {}

  async evaluate(candidate: TokenCandidate): Promise<SafetyVerdict> {
    const started = Date.now();
    const ctx: CheckContext = {
      candidate,
      conn: this.conn,
      cfg: this.cfg,
      store: this.store,
      cache: new Map(),
    };

    const results = await Promise.all(this.checks.map((c) => this.runOne(c, ctx)));

    // A fatal failure is a veto regardless of how good the rest looks.
    const fatal = results.find((r) => !r.passed && r.severity === 'fatal');

    let score = 100;
    for (const r of results) {
      if (!r.passed && r.severity !== 'fatal') score -= r.penalty;
    }
    score = Math.max(0, Math.min(100, score));

    const elapsedMs = Date.now() - started;
    const passed = !fatal && score >= this.cfg.MIN_SAFETY_SCORE;

    const verdict: SafetyVerdict = {
      score,
      passed,
      results,
      rejectedBy: fatal?.id ?? (passed ? undefined : 'score_threshold'),
      elapsedMs,
    };

    if (!passed) {
      const reason = fatal
        ? `${fatal.id}: ${fatal.detail}`
        : `score ${score} < ${this.cfg.MIN_SAFETY_SCORE}`;
      log.debug(`REJECT ${candidate.symbol ?? candidate.mint.slice(0, 8)} — ${reason}`);
    }
    return verdict;
  }

  private async runOne(check: Check, ctx: CheckContext): Promise<CheckResult> {
    try {
      const outcome = await withTimeout(check.run(ctx), check.timeoutMs, check.id);
      return {
        id: check.id,
        passed: outcome.passed,
        severity: check.severity,
        penalty: check.penalty,
        detail: outcome.detail,
      };
    } catch (err) {
      const detail = `check errored: ${errMessage(err)}`;
      // fail-closed checks treat "unknown" as "unsafe"; the rest degrade to a
      // pass so one flaky RPC call cannot halt all trading.
      return {
        id: check.id,
        passed: !check.failClosed,
        severity: check.severity,
        penalty: check.penalty,
        detail,
        errored: true,
      };
    }
  }
}

/** One-line summary of a verdict, for logs. */
export function formatVerdict(v: SafetyVerdict): string {
  const failed = v.results.filter((r) => !r.passed);
  if (failed.length === 0) return `score ${v.score}/100, all ${v.results.length} checks passed`;
  return `score ${v.score}/100 — ${failed.map((f) => `${f.id}(${f.detail})`).join('; ')}`;
}
