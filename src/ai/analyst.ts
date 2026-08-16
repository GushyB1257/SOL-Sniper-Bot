import type { Config } from '../config.js';
import type { Position } from '../types.js';
import type { Store } from '../state/store.js';
import type { TrackedToken, TractionMetrics } from '../watchlist/watchlist.js';
import { logger } from '../logger.js';
import { ClaudeAnalyst, type AskResult } from './client.js';
import { ANALYST_SYSTEM, REVIEWER_SYSTEM, renderEvidence } from './prompts.js';
import {
  ENTRY_DECISION_JSON_SCHEMA,
  REVIEW_DECISION_JSON_SCHEMA,
  entryDecisionSchema,
  reviewDecisionSchema,
  sanitiseEntry,
  sanitiseReview,
  type EntryDecision,
  type ReviewDecision,
} from './schema.js';

const log = logger('analyst');

function n(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return 'n/a';
  return v.toFixed(dp);
}

/**
 * Builds the evidence pack and asks Claude for a decision.
 *
 * Everything the model sees is assembled here, and only from measured data —
 * no derived opinions, no pre-chewed conclusions. The prompt states what a good
 * setup looks like; this supplies the numbers and lets the model do the
 * judging. Feeding it our own verdict would just get that verdict back.
 */
export class TokenAnalyst {
  private readonly claude: ClaudeAnalyst;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
  ) {
    this.claude = new ClaudeAnalyst(cfg);
  }

  get usage() {
    return this.claude.usage;
  }

  /** Decide whether to open a position. */
  async evaluateEntry(
    token: TrackedToken,
    m: TractionMetrics,
  ): Promise<AskResult<EntryDecision>> {
    const c = token.candidate;
    const creator = this.store.getCreator(c.creator);

    const deployerHistory = creator
      ? `${creator.launches} prior launches seen, ${creator.wins} profitable / ${creator.rugs} rugged in our records`
      : 'no prior launches from this deployer in our records';

    const buyerTrend =
      m.buyersPrev60s === 0
        ? m.buyersLast60s > 0
          ? 'first buyers arriving now'
          : 'no buyers in the last two minutes'
        : `${m.buyersLast60s} vs ${m.buyersPrev60s} in the previous 60s (${
            m.buyersLast60s >= m.buyersPrev60s ? 'accelerating or steady' : 'slowing'
          })`;

    const evidence = renderEvidence([
      ['Token', `${c.name ?? 'unnamed'} (${c.symbol ?? '?'})`],
      ['Mint', c.mint],
      ['Age since first seen', `${n(m.ageSeconds, 0)}s`],
      ['', ''],
      ['-- Flow --', ''],
      ['Unique buyers', m.uniqueBuyers],
      ['Unique sellers', m.uniqueSellers],
      ['Buy trades', m.buyCount],
      ['Sell trades', m.sellCount],
      ['Buy volume', `${n(m.buyVolumeSol, 3)} SOL`],
      ['Sell volume', `${n(m.sellVolumeSol, 3)} SOL`],
      ['Buy/sell volume ratio', Number.isFinite(m.volumeRatio) ? n(m.volumeRatio) : 'no sells yet'],
      ['Average buy size', `${n(m.avgBuySizeSol, 4)} SOL`],
      ['Unique buyers last 60s', buyerTrend],
      ['', ''],
      ['-- Price --', ''],
      ['Change since first seen', `${m.priceChangePct >= 0 ? '+' : ''}${n(m.priceChangePct, 1)}%`],
      ['Drawdown from peak', `${n(m.drawdownFromPeakPct, 1)}%`],
      ['', ''],
      ['-- Curve --', ''],
      ['Virtual SOL in curve', n(m.curveSol, 2)],
      ['Progress to graduation', `${n(m.curveProgressPct, 1)}%`],
      ['', ''],
      ['-- Deployer --', ''],
      ['Address', c.creator],
      ['Has sold', m.deployerSold ? `yes, ${n(m.deployerSoldSol, 3)} SOL` : 'no'],
      [
        'Stake taken at creation',
        c.initialBuyTokens
          ? `${n((c.initialBuyTokens / 1_000_000_000) * 100, 2)}% of supply`
          : 'none',
      ],
      ['Our records', deployerHistory],
      ['', ''],
      ['-- Metadata --', ''],
      ['Metadata URI', c.uri ?? 'none'],
      ['Pool', c.pool],
    ]);

    const result = await this.claude.ask(
      {
        system: ANALYST_SYSTEM,
        userContent:
          `Evaluate this token for entry.\n\n${evidence}\n\n` +
          `Position size if you buy: ${this.cfg.BUY_AMOUNT_SOL} SOL. ` +
          `Decide: buy or pass.`,
        jsonSchema: ENTRY_DECISION_JSON_SCHEMA as unknown as Record<string, unknown>,
        label: `entry:${c.symbol ?? c.mint.slice(0, 6)}`,
        maxTokens: 2048,
      },
      entryDecisionSchema,
    );

    if (result.ok && result.value) {
      result.value = sanitiseEntry(result.value);
      const d = result.value;
      log.info(
        `${d.action.toUpperCase()} ${c.symbol ?? c.mint.slice(0, 8)} ` +
          `conf ${d.confidence} (${d.conviction}) — ${d.thesis || 'no thesis'} ` +
          `[${result.latencyMs}ms]`,
      );
    } else {
      log.warn(`Entry evaluation failed for ${c.symbol ?? c.mint.slice(0, 8)}: ${result.error}`);
    }
    return result;
  }

  /** Re-evaluate an open position against its original thesis. */
  async reviewPosition(
    position: Position,
    token: TrackedToken | undefined,
    m: TractionMetrics | undefined,
    gainPct: number,
  ): Promise<AskResult<ReviewDecision>> {
    const heldSeconds = (Date.now() - position.openedAt) / 1000;

    const flow = m
      ? renderEvidence([
          ['Unique buyers now', m.uniqueBuyers],
          ['Unique sellers now', m.uniqueSellers],
          ['Buy trades', m.buyCount],
          ['Sell trades', m.sellCount],
          ['Buy volume', `${n(m.buyVolumeSol, 3)} SOL`],
          ['Sell volume', `${n(m.sellVolumeSol, 3)} SOL`],
          [
            'Buy/sell volume ratio',
            Number.isFinite(m.volumeRatio) ? n(m.volumeRatio) : 'no sells yet',
          ],
          ['Unique buyers last 60s', m.buyersLast60s],
          ['Unique buyers previous 60s', m.buyersPrev60s],
          ['Deployer has sold', m.deployerSold ? `yes, ${n(m.deployerSoldSol, 3)} SOL` : 'no'],
          ['Curve progress', `${n(m.curveProgressPct, 1)}%`],
        ])
      : 'Live flow data unavailable — the trade feed is no longer tracking this token.';

    const thesis = position.notes.find((x) => x.startsWith('thesis:')) ?? 'thesis: (not recorded)';

    const evidence = renderEvidence([
      ['Token', position.symbol ?? position.mint.slice(0, 8)],
      ['Held for', `${n(heldSeconds, 0)}s`],
      ['Position P&L', `${gainPct >= 0 ? '+' : ''}${n(gainPct, 1)}%`],
      ['Remaining size', `${n((position.remainingQty / position.originalQty) * 100, 0)}% of entry`],
      ['Realised so far', `${n(position.realizedSol, 4)} SOL`],
      ['', ''],
      ['-- Original thesis --', ''],
      ['', thesis.replace(/^thesis:\s*/, '')],
      ['', ''],
      ['-- Flow now --', ''],
    ]);

    const result = await this.claude.ask(
      {
        system: REVIEWER_SYSTEM,
        userContent: `${evidence}\n${flow}\n\nDecide: hold, trim, or exit.`,
        jsonSchema: REVIEW_DECISION_JSON_SCHEMA as unknown as Record<string, unknown>,
        label: `review:${position.symbol ?? position.mint.slice(0, 6)}`,
        maxTokens: 1024,
      },
      reviewDecisionSchema,
    );

    if (result.ok && result.value) {
      result.value = sanitiseReview(result.value);
      const d = result.value;
      log.info(
        `REVIEW ${position.symbol ?? position.mint.slice(0, 8)} → ${d.action.toUpperCase()}` +
          `${d.action === 'trim' ? ` ${d.trim_pct}%` : ''} — ${d.reason}`,
      );
    }
    return result;
  }
}
