import type { Connection } from '@solana/web3.js';
import type { CheckResult, SafetyVerdict, TokenCandidate } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Check, CheckContext } from './types.js';
import { logger } from '../logger.js';
import { errMessage, withTimeout } from '../util/async.js';
import { rpcBackpressureMs } from '../util/rpc-throttle.js';

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
import {
  creatorAgeCheck,
  deployerStillHoldsCheck,
  holderCountCheck,
  launchBundleCheck,
} from './checks/provenance.js';

const log = logger('safety');

export const DEFAULT_CHECKS: readonly Check[] = [
  // Fatal — any one of these vetoes the buy outright.
  freezeAuthorityCheck,
  mintAuthorityCheck,
  devBuyCheck,
  deployerHistoryCheck,
  // Provenance: who launched it, whether they are still in it, and whether the
  // first buys were bundled. Each is inert until its threshold is set, because
  // each costs an RPC call on the entry path.
  deployerStillHoldsCheck,
  launchBundleCheck,
  // Scored.
  deployerBalanceCheck,
  deployerSpamCheck,
  metadataSanityCheck,
  socialsCheck,
  duplicateNameCheck,
  curveSanityCheck,
  holderConcentrationCheck,
  holderCountCheck,
  creatorAgeCheck,
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

    // SNIPE_MODE=all: buy everything that is not a rug setup. Only the checks
    // marked rugCritical run — revocable authorities, a pre-loaded dev buy, a
    // deployer who already sold or has a rug history, bundled first buys, and
    // curve freshness (buying late voids the whole buy-at-the-start premise).
    // The quality filters do not run at all, which also makes each candidate
    // cheaper: at buy-everything volume the battery's RPC cost is the
    // throughput ceiling.
    const buyEverything = this.cfg.SNIPE_MODE === 'all';
    const active = buyEverything ? this.checks.filter((c) => c.rugCritical) : this.checks;

    // Free checks first, and stop here if they have already decided. Nothing is
    // skipped that could have changed the answer: the remaining checks can only
    // subtract from the score, so a launch that cannot reach the threshold on
    // the free evidence alone cannot reach it on the paid evidence either. What
    // this saves is the four RPC calls that would have gone into confirming a
    // rejection we had already made — which at peak is most of them.
    const free = active.filter((c) => (c.cost ?? 'rpc') === 'local');
    const paid = active.filter((c) => (c.cost ?? 'rpc') !== 'local');

    const results = await Promise.all(free.map((c) => this.runOne(c, ctx)));
    let shortCircuited = false;

    if (this.decidedBy(results, buyEverything) === 'reject') {
      shortCircuited = true;
    } else {
      results.push(...(await Promise.all(paid.map((c) => this.runOne(c, ctx)))));
    }

    // Everything the checks measured, whether they passed or failed. The
    // decision does not use these; the trade journal does, so the tuner can ask
    // which launch characteristic the losing entries had in common.
    const metrics: Record<string, number> = {};
    for (const r of results) Object.assign(metrics, r.metrics);

    // A fatal failure is a veto regardless of how good the rest looks.
    const fatal = results.find((r) => !r.passed && r.severity === 'fatal');

    let score = 100;
    for (const r of results) {
      if (!r.passed && r.severity !== 'fatal') score -= r.penalty;
    }
    score = Math.max(0, Math.min(100, score));

    const elapsedMs = Date.now() - started;
    // In buy-everything mode ANY failed check vetoes, whatever its severity:
    // the checks that ran are all fail-safes, and a mode with no score has no
    // meaningful "non-fatal". In filtered mode the scored gate applies as ever.
    const anyFailed = results.find((r) => !r.passed);
    const passed = buyEverything
      ? anyFailed === undefined
      : !fatal && score >= this.cfg.MIN_SAFETY_SCORE;

    const verdict: SafetyVerdict = {
      score,
      passed,
      results,
      rejectedBy: buyEverything
        ? anyFailed?.id
        : (fatal?.id ?? (passed ? undefined : 'score_threshold')),
      elapsedMs,
      shortCircuited,
      metrics,
    };

    if (!passed) {
      const failed = buyEverything ? anyFailed : fatal;
      const reason = failed
        ? `${failed.id}: ${failed.detail}`
        : `score ${score} < ${this.cfg.MIN_SAFETY_SCORE}`;
      log.debug(`REJECT ${candidate.symbol ?? candidate.mint.slice(0, 8)} — ${reason}`);
    }
    return verdict;
  }

  /**
   * Whether the results so far settle it, given that every check still to run
   * can only lower the score.
   */
  private decidedBy(
    results: readonly CheckResult[],
    buyEverything = false,
  ): 'reject' | 'undecided' {
    // Buy-everything: every check that runs is a fail-safe, so any failure
    // settles it — and the score can never settle it, since it does not gate.
    if (buyEverything) {
      return results.some((r) => !r.passed) ? 'reject' : 'undecided';
    }
    if (results.some((r) => !r.passed && r.severity === 'fatal')) return 'reject';

    const best = results.reduce(
      (score, r) => (!r.passed && r.severity !== 'fatal' ? score - r.penalty : score),
      100,
    );
    return best < this.cfg.MIN_SAFETY_SCORE ? 'reject' : 'undecided';
  }

  private async runOne(check: Check, ctx: CheckContext): Promise<CheckResult> {
    // A check that talks to the endpoint is not slow when the queue is deep —
    // it has not started yet. Charging it for the wait is how a healthy mint
    // read ends up reported as "mint_authority timed out after 1500ms", and
    // because that check fails closed, that reads as a rejected launch.
    const budget =
      check.timeoutMs + ((check.cost ?? 'rpc') === 'rpc' ? rpcBackpressureMs() : 0);
    try {
      const outcome = await withTimeout(check.run(ctx), budget, check.id);
      return {
        id: check.id,
        passed: outcome.passed,
        severity: check.severity,
        penalty: check.penalty,
        detail: outcome.detail,
        ...(outcome.metrics && { metrics: outcome.metrics }),
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
  // Say when the paid checks never ran, so a short results list reads as a
  // saving rather than as checks that quietly went missing.
  const how = v.shortCircuited ? ' [free checks only, no RPC spent]' : '';
  return `score ${v.score}/100${how} — ${failed.map((f) => `${f.id}(${f.detail})`).join('; ')}`;
}
