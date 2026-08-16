import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { errMessage } from '../util/async.js';

const log = logger('ai');

export interface AskOptions {
  system: string;
  userContent: string;
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  /** Label used in logs and cost accounting. */
  label: string;
}

export interface AskResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  latencyMs: number;
}

/** Running tally so the dashboard can show what the analyst is costing. */
export interface AiUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  errors: number;
  refusals: number;
  estimatedCostUsd: number;
}

/** Claude Opus 5 list pricing, USD per million tokens. */
const PRICE_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

/**
 * Thin wrapper over the Messages API for structured trading decisions.
 *
 * Three things it does that a bare `messages.create` would not:
 *
 *  - Constrains generation with a JSON schema, so a malformed decision cannot
 *    reach the sizing logic at all.
 *  - Puts a cache breakpoint on the system prompt. The prompt is long and
 *    identical on every call, so after the first it bills at cache-read rates.
 *  - Treats a refusal as a distinct outcome from an error. A refused call is
 *    not a pass and not a retry — it is a decision the model declined to make,
 *    and the caller skips the token rather than guessing.
 */
export class ClaudeAnalyst {
  private readonly client: Anthropic;
  private readonly totals: AiUsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: 0,
    refusals: 0,
    estimatedCostUsd: 0,
  };

  constructor(private readonly cfg: Config) {
    this.client = new Anthropic({
      apiKey: cfg.ANTHROPIC_API_KEY || undefined,
      maxRetries: 2,
      timeout: cfg.AI_TIMEOUT_MS,
    });
  }

  get usage(): AiUsageTotals {
    return { ...this.totals };
  }

  async ask<T>(opts: AskOptions, validator: z.ZodType<T>): Promise<AskResult<T>> {
    const started = Date.now();
    const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    try {
      const response = await this.client.beta.messages.create({
        model: this.cfg.AI_MODEL,
        max_tokens: opts.maxTokens ?? 2048,
        // Thinking is on by default on Opus 5; naming it keeps the intent
        // explicit and survives a model swap to one where it is not.
        thinking: { type: 'adaptive' },
        output_config: {
          effort: this.cfg.AI_EFFORT,
          format: { type: 'json_schema', schema: opts.jsonSchema },
        },
        // Safety classifiers can decline; this re-runs the call on a fallback
        // model server-side rather than losing the decision.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          {
            type: 'text',
            text: opts.system,
            // The system prompt is long, identical every call, and sits at the
            // front of the prefix — the highest-value place for a breakpoint.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: opts.userContent }],
      });

      const usage = {
        input: response.usage.input_tokens ?? 0,
        output: response.usage.output_tokens ?? 0,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      };
      this.record(usage);

      // Check the stop reason before touching content — a refusal returns a
      // 200 with empty or partial content, and indexing into it would throw.
      if (response.stop_reason === 'refusal') {
        this.totals.refusals += 1;
        const category = response.stop_details?.category ?? 'unspecified';
        log.warn(`[${opts.label}] model declined (${category})`);
        return {
          ok: false,
          error: `refused: ${category}`,
          usage,
          latencyMs: Date.now() - started,
        };
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (!text.trim()) {
        return { ok: false, error: 'empty response', usage, latencyMs: Date.now() - started };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: `unparseable JSON: ${text.slice(0, 160)}`,
          usage,
          latencyMs: Date.now() - started,
        };
      }

      // The schema constrained generation, but validate anyway — this output
      // is about to size a position.
      const result = validator.safeParse(parsed);
      if (!result.success) {
        return {
          ok: false,
          error: `schema mismatch: ${result.error.issues.map((i) => i.message).join('; ')}`,
          usage,
          latencyMs: Date.now() - started,
        };
      }

      return { ok: true, value: result.data, usage, latencyMs: Date.now() - started };
    } catch (err) {
      this.totals.errors += 1;
      return {
        ok: false,
        error: this.describe(err),
        usage: empty,
        latencyMs: Date.now() - started,
      };
    }
  }

  /** Typed error handling, so callers can distinguish transient from fatal. */
  private describe(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) {
      return 'authentication failed — check ANTHROPIC_API_KEY';
    }
    if (err instanceof Anthropic.RateLimitError) return 'rate limited';
    if (err instanceof Anthropic.NotFoundError) return 'model not found — check AI_MODEL';
    if (err instanceof Anthropic.APIConnectionError) return 'connection failed';
    if (err instanceof Anthropic.APIError) return `api error ${err.status}: ${err.message}`;
    return errMessage(err);
  }

  private record(u: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    this.totals.calls += 1;
    this.totals.inputTokens += u.input;
    this.totals.outputTokens += u.output;
    this.totals.cacheReadTokens += u.cacheRead;
    this.totals.cacheWriteTokens += u.cacheWrite;
    this.totals.estimatedCostUsd +=
      (u.input * PRICE_PER_MTOK.input +
        u.output * PRICE_PER_MTOK.output +
        u.cacheRead * PRICE_PER_MTOK.cacheRead +
        u.cacheWrite * PRICE_PER_MTOK.cacheWrite) /
      1_000_000;
  }
}
