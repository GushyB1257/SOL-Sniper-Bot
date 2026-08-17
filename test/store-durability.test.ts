import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/state/store.js';
import type { Position } from '../src/types.js';

/**
 * Closing an editor should never cost you your open positions.
 *
 * The reported failure was a corrupt `state-sniper.json` on every unclean
 * shutdown, and a refusal to start that had to be repaired by hand. Two causes:
 * the write was atomic but not DURABLE (rename published content still sitting
 * in the page cache), and there was no previous-good copy to fall back on.
 */

let dir: string;

function position(over: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'p1',
    mint: 'Mint1',
    symbol: 'TEST',
    creator: 'Dev1',
    pool: 'pump',
    status: 'open',
    costSol: 0.25,
    originalQty: 1_000_000,
    remainingQty: 1_000_000,
    entryPrice: 1e-7,
    openedAt: now,
    peakPrice: 1e-7,
    lastPrice: 1e-7,
    lastPriceAt: now,
    ladder: [],
    moonbagArmed: false,
    realizedSol: 0,
    safetyScore: 88,
    notes: [],
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-dur-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('surviving an unclean shutdown', () => {
  it('keeps a previous-good copy alongside the live file', () => {
    const a = new Store(dir, 'sniper');
    a.savePosition(position({ id: 'first' }));
    a.close();

    const b = new Store(dir, 'sniper');
    b.savePosition(position({ id: 'second' }));
    b.close();

    // The backup is what turns a corrupt read from a dead end into a recovery.
    expect(existsSync(join(dir, 'state-sniper.json'))).toBe(true);
    expect(existsSync(join(dir, 'state-sniper.json.bak'))).toBe(true);
  });

  it('recovers from the backup instead of refusing to start', () => {
    const a = new Store(dir, 'sniper');
    a.savePosition(position({ id: 'keeper' }));
    a.close();
    // Second write, so a .bak exists holding the first.
    const b = new Store(dir, 'sniper');
    b.savePosition(position({ id: 'later' }));
    b.close();

    // Exactly what a hard kill leaves behind: a rename that published content
    // the page cache never wrote.
    writeFileSync(join(dir, 'state-sniper.json'), '', 'utf8');

    const recovered = new Store(dir, 'sniper');
    expect(recovered.getPosition('keeper')).toBeTruthy();
    recovered.close();
  });

  it('treats a zero-length file as truncation, not as corruption to explain', () => {
    // An empty file is the SIGNATURE of the failure being guarded against, so it
    // is not an error to report — it is a reason to reach for the backup. With no
    // backup and nothing to lose, starting clean is correct.
    writeFileSync(join(dir, 'state-sniper.json'), '', 'utf8');
    const store = new Store(dir, 'sniper');
    expect(store.openPositions()).toEqual([]);
    // Nothing was quarantined, because there was nothing worth quarantining.
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    store.close();
  });

  it('recovers from the backup when half-written JSON lands in the live file', () => {
    const a = new Store(dir, 'sniper');
    a.savePosition(position({ id: 'keeper' }));
    a.close();
    const b = new Store(dir, 'sniper');
    b.savePosition(position({ id: 'later' }));
    b.close();

    writeFileSync(join(dir, 'state-sniper.json'), '{"version":1,"positions":{"p', 'utf8');

    const recovered = new Store(dir, 'sniper');
    expect(recovered.getPosition('keeper')).toBeTruthy();
    recovered.close();
  });

  it('still refuses to start when damaged with NO usable backup', () => {
    // The original instinct was right and is kept: never silently start blank
    // while positions might be holding real tokens. It just no longer fires for
    // a case the backup can cover.
    writeFileSync(join(dir, 'state-sniper.json'), '{"positions": BROKEN', 'utf8');
    expect(() => new Store(dir, 'sniper')).toThrow(/no recoverable backup/);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length).toBe(1);
  });

  it('recovers when the live file is missing but the backup is not', () => {
    // The flush window between demoting the old file and promoting the new one.
    const a = new Store(dir, 'sniper');
    a.savePosition(position({ id: 'keeper' }));
    a.close();
    const b = new Store(dir, 'sniper');
    b.savePosition(position({ id: 'later' }));
    b.close();

    rmSync(join(dir, 'state-sniper.json'));

    const recovered = new Store(dir, 'sniper');
    expect(recovered.getPosition('keeper')).toBeTruthy();
    recovered.close();
  });

  it('clears a leftover temp file rather than carrying it forward', () => {
    writeFileSync(join(dir, 'state-sniper.json.tmp'), 'half a write', 'utf8');
    const store = new Store(dir, 'sniper');
    expect(existsSync(join(dir, 'state-sniper.json.tmp'))).toBe(false);
    store.close();
  });

  it('writes valid JSON that round-trips', () => {
    const store = new Store(dir, 'sniper');
    store.savePosition(position({ id: 'x', symbol: 'ROUND' }));
    store.close();

    const raw = JSON.parse(readFileSync(join(dir, 'state-sniper.json'), 'utf8')) as {
      positions: Record<string, Position>;
    };
    expect(raw.positions.x!.symbol).toBe('ROUND');
  });

  it('keeps each bot in its own file, so one corruption is not four', () => {
    const sniper = new Store(dir, 'sniper');
    const arb = new Store(dir, 'arb');
    sniper.savePosition(position({ id: 's' }));
    arb.savePosition(position({ id: 'a' }));
    sniper.close();
    arb.close();

    writeFileSync(join(dir, 'state-sniper.json'), '', 'utf8');
    // The arb store is untouched by the sniper's bad day.
    const reopened = new Store(dir, 'arb');
    expect(reopened.getPosition('a')).toBeTruthy();
    reopened.close();
  });
});
