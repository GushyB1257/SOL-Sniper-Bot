import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ClaudeAnalyst } from '../src/ai/client.js';
import { loadConfig, type Config } from '../src/config.js';

function config(extra: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'sniper-ai-'));
  try {
    return loadConfig({
      RPC_HTTP_URL: 'https://rpc.example.com',
      RPC_WS_URL: 'wss://rpc.example.com',
      MODE: 'paper',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      DATA_DIR: dir,
      ...extra,
    } as unknown as NodeJS.ProcessEnv);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };
const validator = z.object({ ok: z.boolean() });

/** Replaces the SDK call with one that throws, and records what it was given. */
function analystThatThrows(cfg: Config, err: unknown): { ai: ClaudeAnalyst; seen: unknown[] } {
  const ai = new ClaudeAnalyst(cfg);
  const seen: unknown[] = [];
  // The client is private and deliberately so — this reaches past it because
  // the thing under test is how a thrown SDK error is described, and there is
  // no other seam between the two.
  (ai as unknown as { client: { beta: { messages: { create: unknown } } } }).client = {
    beta: {
      messages: {
        create: (body: unknown, opts: unknown) => {
          seen.push(opts);
          return Promise.reject(err);
        },
      },
    },
  } as never;
  return { ai, seen };
}

const ASK = { label: 'test', system: 's', userContent: 'u', jsonSchema: SCHEMA };

describe('analyst error classification', () => {
  it('reports a client-side timeout as a timeout, not as a connection failure', async () => {
    // The bug this pins: APIConnectionTimeoutError EXTENDS APIConnectionError,
    // so testing the base class first swallowed the subclass and every blown
    // deadline was reported as "connection failed" — sending the reader to
    // check their internet over a config value.
    const { ai } = analystThatThrows(
      config(),
      new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }),
    );

    const res = await ai.ask(ASK, validator);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
    expect(res.error).not.toMatch(/connection failed/);
  });

  it('names the deadline that was actually applied to the call', async () => {
    const { ai } = analystThatThrows(
      config({ AI_TUNER_TIMEOUT_MS: '240000' }),
      new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }),
    );

    const res = await ai.ask({ ...ASK, timeoutMs: 240_000 }, validator);

    // 240s, not the 60s client default — otherwise the advice to raise the
    // timeout points at a number that is not the one that expired.
    expect(res.error).toMatch(/240s/);
  });

  it('still reports a real connection failure as one', async () => {
    const { ai } = analystThatThrows(
      config(),
      new Anthropic.APIConnectionError({ message: 'socket hang up' }),
    );

    const res = await ai.ask(ASK, validator);

    expect(res.error).toBe('connection failed');
  });
});

describe('per-call timeouts', () => {
  it('passes the override to the SDK rather than the client-wide default', async () => {
    const { ai, seen } = analystThatThrows(config(), new Error('boom'));

    await ai.ask({ ...ASK, timeoutMs: 300_000 }, validator);

    expect(seen[0]).toEqual({ timeout: 300_000 });
  });

  it('falls back to AI_TIMEOUT_MS when no override is given', async () => {
    const cfg = config({ AI_TIMEOUT_MS: '45000' });
    const { ai, seen } = analystThatThrows(cfg, new Error('boom'));

    await ai.ask(ASK, validator);

    expect(seen[0]).toEqual({ timeout: 45_000 });
  });

  it('gives tuning calls a longer deadline than trade decisions', () => {
    const cfg = config();
    // A trade verdict is worthless if it is late, so that deadline stays short.
    // A tuning round is not on anyone's clock, so it gets room to think. If
    // these are ever equal, the tuner is back to tripping a deadline set for a
    // different kind of call.
    expect(cfg.AI_TUNER_TIMEOUT_MS).toBeGreaterThan(cfg.AI_TIMEOUT_MS);
  });
});
