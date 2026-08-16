import { z } from 'zod';

/**
 * Structured decision contracts.
 *
 * Two representations of the same shape, deliberately:
 *  - a JSON Schema sent to the API as `output_config.format`, which constrains
 *    generation so the model cannot emit anything unparseable;
 *  - a Zod schema used to validate what comes back, because a schema the model
 *    honoured is still worth checking before it sizes a position.
 *
 * The JSON Schema sticks to the supported subset: no numeric bounds, no string
 * length constraints, `additionalProperties: false` on every object, and every
 * property listed in `required`.
 */

export const ENTRY_ACTIONS = ['buy', 'pass'] as const;
export const CONVICTIONS = ['low', 'medium', 'high'] as const;

export const entryDecisionSchema = z.object({
  action: z.enum(ENTRY_ACTIONS),
  /** 0-100. Drives position size, so it has to be a number, not a vibe. */
  confidence: z.number(),
  conviction: z.enum(CONVICTIONS),
  /** One sentence: why this token, right now. */
  thesis: z.string(),
  /** Concrete things that would falsify the thesis. */
  risks: z.array(z.string()),
  /** Signals that supported the call, so the journal can be audited later. */
  supporting_signals: z.array(z.string()),
  /** How long the thesis is expected to take to play out. */
  expected_hold_seconds: z.number(),
  /** Gain at which the model expects to be substantially out. */
  target_gain_pct: z.number(),
  /** Loss at which the thesis is dead. */
  invalidation_loss_pct: z.number(),
});

export type EntryDecision = z.infer<typeof entryDecisionSchema>;

export const ENTRY_DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ENTRY_ACTIONS] },
    confidence: {
      type: 'integer',
      description: '0-100. How strongly the evidence supports acting now.',
    },
    conviction: { type: 'string', enum: [...CONVICTIONS] },
    thesis: {
      type: 'string',
      description: 'One sentence on why this token, right now. Empty string if passing.',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete observations that would falsify the thesis.',
    },
    supporting_signals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific evidence used, each citing a number from the pack.',
    },
    expected_hold_seconds: {
      type: 'integer',
      description: 'How long the thesis needs to play out. 0 when passing.',
    },
    target_gain_pct: {
      type: 'integer',
      description: 'Percent gain at which most of the position should be out. 0 when passing.',
    },
    invalidation_loss_pct: {
      type: 'integer',
      description: 'Positive percent drawdown at which the thesis is dead. 0 when passing.',
    },
  },
  required: [
    'action',
    'confidence',
    'conviction',
    'thesis',
    'risks',
    'supporting_signals',
    'expected_hold_seconds',
    'target_gain_pct',
    'invalidation_loss_pct',
  ],
  additionalProperties: false,
} as const;

export const REVIEW_ACTIONS = ['hold', 'trim', 'exit'] as const;

export const reviewDecisionSchema = z.object({
  action: z.enum(REVIEW_ACTIONS),
  /** Percent of the remaining position to sell. Ignored unless action is trim. */
  trim_pct: z.number(),
  reason: z.string(),
  /** Whether the original thesis still holds. */
  thesis_intact: z.boolean(),
});

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const REVIEW_DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...REVIEW_ACTIONS] },
    trim_pct: {
      type: 'integer',
      description: 'Percent of the REMAINING position to sell. 0 unless action is trim.',
    },
    reason: { type: 'string', description: 'One sentence, citing what changed.' },
    thesis_intact: {
      type: 'boolean',
      description: 'Whether the original entry thesis still holds.',
    },
  },
  required: ['action', 'trim_pct', 'reason', 'thesis_intact'],
  additionalProperties: false,
} as const;

/** Clamps a validated decision into ranges the executor can act on safely. */
export function sanitiseEntry(d: EntryDecision): EntryDecision {
  return {
    ...d,
    confidence: clamp(d.confidence, 0, 100),
    expected_hold_seconds: clamp(d.expected_hold_seconds, 0, 86_400),
    target_gain_pct: clamp(d.target_gain_pct, 0, 100_000),
    invalidation_loss_pct: clamp(Math.abs(d.invalidation_loss_pct), 0, 95),
    risks: d.risks.slice(0, 12),
    supporting_signals: d.supporting_signals.slice(0, 12),
  };
}

export function sanitiseReview(d: ReviewDecision): ReviewDecision {
  return { ...d, trim_pct: clamp(d.trim_pct, 0, 100) };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
