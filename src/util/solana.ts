import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Config } from '../config.js';
import { createThrottledFetch } from './rpc-throttle.js';

export { LAMPORTS_PER_SOL };

let conn: Connection | null = null;

export function connection(cfg: Config): Connection {
  if (!conn) {
    conn = new Connection(cfg.RPC_HTTP_URL, {
      commitment: 'confirmed',
      wsEndpoint: cfg.RPC_WS_URL,
      // Snipes are worthless if confirmed late; fail fast and move on.
      confirmTransactionInitialTimeout: 30_000,
      // web3.js has its own 429 retry, and two retry loops stacked on top of
      // each other multiply rather than add: our backoff runs to completion,
      // hands back the 429, and web3.js then does the whole thing again — five
      // more attempts at a fixed 500ms, without honouring Retry-After and
      // without telling the throttle that its rate is too high. That is where
      // the "Retrying after 500ms delay" lines and the multi-second check
      // timeouts come from. Ours is the loop that can actually see the load.
      disableRetryOnRateLimit: true,
      // Every RPC call in the process goes through this, which is the only
      // place that can see the whole load. Rate limiting one caller just moves
      // the 429 to the next one.
      fetch: createThrottledFetch({
        maxConcurrent: cfg.RPC_MAX_CONCURRENT,
        maxPerSecond: cfg.RPC_MAX_REQUESTS_PER_SEC,
        maxRetries: cfg.RPC_MAX_RETRIES,
      }),
    });
  }
  return conn;
}

export function resetConnectionForTests(): void {
  conn = null;
}

/**
 * Accepts a base58 secret key (Phantom export) or a JSON byte array
 * (solana-keygen output), because people paste both.
 */
export function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error('WALLET_PRIVATE_KEY is empty');

  if (trimmed.startsWith('[')) {
    const bytes = JSON.parse(trimmed) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      throw new Error('JSON keypair must be a 64-byte array');
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  const decoded = bs58.decode(trimmed);
  if (decoded.length !== 64) {
    throw new Error(`Expected a 64-byte base58 secret key, got ${decoded.length} bytes`);
  }
  return Keypair.fromSecretKey(decoded);
}

/** A mint just has to be a well-formed 32-byte address; mints are off-curve. */
export function isValidMint(address: string): boolean {
  try {
    return new PublicKey(address).toBytes().length === 32;
  } catch {
    return false;
  }
}

export function toPublicKey(address: string): PublicKey | null {
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

/** Percent change from `from` to `to`. Guards the zero-denominator case. */
export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from <= 0) return 0;
  return ((to - from) / from) * 100;
}
