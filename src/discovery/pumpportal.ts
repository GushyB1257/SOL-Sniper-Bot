import WebSocket from 'ws';
import type { Discovery, TokenCandidate, Pool } from '../types.js';
import { logger } from '../logger.js';
import { errMessage, sleep } from '../util/async.js';
import { isValidMint } from '../util/solana.js';

const log = logger('discovery:pumpportal');

/** Shape of a `subscribeNewToken` message. All fields treated as untrusted. */
interface NewTokenMessage {
  signature?: unknown;
  mint?: unknown;
  traderPublicKey?: unknown;
  txType?: unknown;
  initialBuy?: unknown;
  solAmount?: unknown;
  bondingCurveKey?: unknown;
  vTokensInBondingCurve?: unknown;
  vSolInBondingCurve?: unknown;
  marketCapSol?: unknown;
  name?: unknown;
  symbol?: unknown;
  uri?: unknown;
  pool?: unknown;
}

const KNOWN_POOLS: readonly Pool[] = [
  'pump',
  'pump-amm',
  'raydium',
  'raydium-cpmm',
  'launchlab',
  'bonk',
  'auto',
];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Streams new pump.fun launches from PumpPortal's free websocket feed.
 *
 * This is the lowest-friction source (no API key, no paid RPC), but you are
 * sharing it with everyone else using it — the same event reaches thousands of
 * bots simultaneously. For a real latency edge use the `rpc` source against a
 * dedicated node, or better, a geyser/gRPC stream.
 */
export class PumpPortalDiscovery implements Discovery {
  readonly name = 'pumpportal';

  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;

  constructor(private readonly url: string) {}

  async start(onCandidate: (c: TokenCandidate) => void): Promise<void> {
    this.stopped = false;
    void this.connectLoop(onCandidate);
  }

  private async connectLoop(onCandidate: (c: TokenCandidate) => void): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce(onCandidate);
      } catch (err) {
        log.warn(`Feed error: ${errMessage(err)}`);
      }
      if (this.stopped) break;

      this.reconnectAttempt += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
      const jittered = delay * (0.5 + Math.random() * 0.5);
      log.warn(`Reconnecting in ${Math.round(jittered)}ms (attempt ${this.reconnectAttempt})`);
      await sleep(jittered);
    }
  }

  private connectOnce(onCandidate: (c: TokenCandidate) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.clearHeartbeat();
        if (err) reject(err);
        else resolve();
      };

      ws.on('open', () => {
        log.info('Connected, subscribing to new token stream');
        this.reconnectAttempt = 0;
        this.lastMessageAt = Date.now();
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        this.startHeartbeat(ws);
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        this.lastMessageAt = Date.now();
        let msg: NewTokenMessage;
        try {
          msg = JSON.parse(raw.toString()) as NewTokenMessage;
        } catch {
          return; // subscription acks and keepalives aren't always JSON
        }
        const candidate = this.toCandidate(msg);
        if (candidate) {
          try {
            onCandidate(candidate);
          } catch (err) {
            // A throwing handler must not kill the feed.
            log.error(`Candidate handler threw for ${candidate.mint}: ${errMessage(err)}`);
          }
        }
      });

      ws.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
      ws.on('close', (code, reason) => {
        log.warn(`Socket closed (${code}) ${reason.toString()}`);
        done();
      });
    });
  }

  /** The feed goes quiet rather than closing when it dies; force a reconnect. */
  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 60_000) {
        log.warn('No messages for 60s, forcing reconnect');
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15_000);
    this.heartbeat.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private toCandidate(msg: NewTokenMessage): TokenCandidate | null {
    if (str(msg.txType) !== 'create') return null;

    const mint = str(msg.mint);
    const creator = str(msg.traderPublicKey);
    if (!mint || !creator || !isValidMint(mint)) return null;

    const rawPool = str(msg.pool);
    const pool: Pool = KNOWN_POOLS.includes(rawPool as Pool) ? (rawPool as Pool) : 'pump';

    return {
      mint,
      creator,
      name: str(msg.name),
      symbol: str(msg.symbol),
      uri: str(msg.uri),
      pool,
      signature: str(msg.signature),
      bondingCurveKey: str(msg.bondingCurveKey),
      initialBuySol: numOrUndef(msg.solAmount),
      initialBuyTokens: numOrUndef(msg.initialBuy),
      vTokensInBondingCurve: numOrUndef(msg.vTokensInBondingCurve),
      vSolInBondingCurve: numOrUndef(msg.vSolInBondingCurve),
      marketCapSol: numOrUndef(msg.marketCapSol),
      detectedAt: Date.now(),
      source: this.name,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}
