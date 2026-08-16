import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettings, FIELDS } from '../src/settings/runtime.js';
import { loadConfig, type Config } from '../src/config.js';

let dir: string;
let cfg: Config;
let env: NodeJS.ProcessEnv;

function baseEnv(): NodeJS.ProcessEnv {
  return {
    RPC_HTTP_URL: 'https://rpc.example.com',
    RPC_WS_URL: 'wss://rpc.example.com',
    MODE: 'paper',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DATA_DIR: dir,
  } as unknown as NodeJS.ProcessEnv;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniper-settings-'));
  env = baseEnv();
  cfg = loadConfig(env);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('applying a patch', () => {
  it('updates the SAME config object every component already holds', () => {
    // This is the whole mechanism: components captured `cfg` at construction,
    // so a new object would leave them running the old values forever.
    const settings = new RuntimeSettings(cfg, env, dir);
    const held = cfg;

    expect(settings.apply({ SCREEN_MIN_MCAP_USD: '9000' }).ok).toBe(true);
    expect(held.SCREEN_MIN_MCAP_USD).toBe(9000);
  });

  it('reports which keys actually changed', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    const r = settings.apply({
      SCREEN_MIN_MCAP_USD: String(cfg.SCREEN_MIN_MCAP_USD),
      CHECKPOINT_SECONDS: '45',
    });
    expect(r.changed).toEqual(['CHECKPOINT_SECONDS']);
  });

  it('coerces booleans and lists', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    expect(settings.apply({ REQUIRE_SOCIALS: false }).ok).toBe(true);
    expect(cfg.REQUIRE_SOCIALS).toBe(false);

    expect(settings.apply({ SCREEN_ALLOWED_POOLS: 'pump, pump-amm' }).ok).toBe(true);
    expect(cfg.SCREEN_ALLOWED_POOLS).toEqual(['pump', 'pump-amm']);
  });
});

describe('rejection', () => {
  it('runs the same validation the process boots with', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    const r = settings.apply({ SCREEN_MIN_MCAP_USD: 'not a number' });
    expect(r.ok).toBe(false);
    expect(cfg.SCREEN_MIN_MCAP_USD).toBe(6000);
  });

  it('enforces cross-field rules, not just per-field ones', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    const r = settings.apply({ SCREEN_MIN_AGE_SECONDS: '900', SCREEN_MAX_AGE_SECONDS: '60' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be below/);
  });

  it('applies nothing at all when any part of the patch fails', () => {
    // Half-applying is worse than rejecting: settings cross-validate, so the
    // surviving half can produce a combination nobody asked for.
    const settings = new RuntimeSettings(cfg, env, dir);
    settings.apply({ CHECKPOINT_SECONDS: '45' });
    const r = settings.apply({ CHECKPOINT_SECONDS: '90', SCREEN_MIN_MCAP_USD: 'garbage' });
    expect(r.ok).toBe(false);
    expect(cfg.CHECKPOINT_SECONDS).toBe(45);
  });

  it('refuses settings that could move real money or leak a key', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    for (const key of ['MODE', 'EXECUTOR', 'WALLET_PRIVATE_KEY', 'RPC_HTTP_URL']) {
      const r = settings.apply({ [key]: 'x' });
      expect(r.ok, key).toBe(false);
    }
    expect(cfg.MODE).toBe('paper');
    expect(cfg.EXECUTOR).toBe('paper');
  });

  it('refuses a key that is not an exposed setting', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    expect(settings.apply({ NOT_A_SETTING: '1' }).ok).toBe(false);
  });

  it('refuses an enum value outside its options', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    expect(settings.apply({ EXIT_MODE: 'sideways' }).ok).toBe(false);
    expect(cfg.EXIT_MODE).toBe('ratchet');
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    new RuntimeSettings(cfg, env, dir).apply({ CHECKPOINT_SECONDS: '30' });

    const fresh = loadConfig(baseEnv());
    expect(fresh.CHECKPOINT_SECONDS).toBe(60);
    new RuntimeSettings(fresh, baseEnv(), dir);
    expect(fresh.CHECKPOINT_SECONDS).toBe(30);
  });

  it('discards a stored patch that no longer validates rather than failing to boot', () => {
    // A renamed key or a tightened bound must not brick the bot.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CHECKPOINT_SECONDS: '999999' }));
    const fresh = loadConfig(baseEnv());
    expect(() => new RuntimeSettings(fresh, baseEnv(), dir)).not.toThrow();
    expect(fresh.CHECKPOINT_SECONDS).toBe(60);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('ignores a corrupt settings file', () => {
    writeFileSync(join(dir, 'settings.json'), 'not json');
    const fresh = loadConfig(baseEnv());
    expect(() => new RuntimeSettings(fresh, baseEnv(), dir)).not.toThrow();
  });

  it('reset goes back to what .env says', () => {
    const settings = new RuntimeSettings(cfg, env, dir);
    settings.apply({ CHECKPOINT_SECONDS: '30' });
    expect(settings.reset().ok).toBe(true);
    expect(cfg.CHECKPOINT_SECONDS).toBe(60);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
  });
});

describe('the exposed field list', () => {
  it('only names settings that exist', () => {
    for (const f of FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(cfg, f.key), f.key).toBe(true);
    }
  });

  it('gives every field a tab, a group and a label', () => {
    for (const f of FIELDS) {
      expect(f.label, f.key).toBeTruthy();
      expect(f.group, f.key).toBeTruthy();
      expect(['screener', 'sniper', 'copy', 'shared']).toContain(f.bot);
    }
  });

  it('has no duplicate keys', () => {
    const keys = FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports current values for every field', () => {
    const values = new RuntimeSettings(cfg, env, dir).values();
    for (const f of FIELDS) expect(values[f.key], f.key).toBeDefined();
    expect(values.SCREEN_ALLOWED_POOLS).toBe('pump');
  });

  it('covers every wallet-tracking setting the copy bot needs', () => {
    const copyKeys = FIELDS.filter((f) => f.bot === 'copy').map((f) => f.key);
    expect(copyKeys).toContain('COPY_WALLETS');
    expect(copyKeys).toContain('COPY_MIN_BUY_SOL');
  });
});
