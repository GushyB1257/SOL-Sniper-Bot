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
  tokenAmount?: unknown;
}

/** A buy or sell on a token we asked the feed to stream. */
export interface TradeEvent {
  mint: string;
  trader: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  vSolInCurve?: number;
  marketCapSol?: number;
  at: number;
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

/** Unrecognised venues already reported, so the warning fires once each. */
const reportedPools = new Set<string>();

/**
 * The venue the feed named, or `unknown` if it named one we do not have.
 *
 * The old version fell back to `pump` for anything it did not recognise, which
 * was safe while PumpPortal only carried pump.fun and became a real problem when
 * it started carrying every other launchpad on Solana. A launch off Mayhem or
 * Bags arrived stamped `pump` and then sailed through every gate meant to stop
 * it: the screener's `SCREEN_ALLOWED_POOLS` matched, `holder_concentration`
 * waived itself on the grounds that bonding-curve concentration means nothing,
 * `dev_buy_share` measured the stake against pump.fun's fixed 1B supply, and the
 * executor asked PumpPortal to build a pump.fun swap for a token that is not on
 * pump.fun. Guessing `pump` was not a neutral default; it was the answer that
 * disabled the checks.
 *
 * An *absent* field still means pump, because that is what the feed's own
 * history says it means and reading it any other way would stop the bot dead.
 * A field that is present and unrecognised is the case that gets named.
 */
export function poolOf(raw: string | undefined): Pool {
  if (raw === undefined) return 'pump';
  const normalised = raw.trim().toLowerCase();
  if (KNOWN_POOLS.includes(normalised as Pool)) return normalised as Pool;

  if (!reportedPools.has(normalised)) {
    reportedPools.add(normalised);
    log.warn(
      `Feed is sending launches from "${normalised}", which is not pump.fun. ` +
        'They are marked unknown and will not be sniped. Add it to ' +
        'SNIPE_ALLOWED_POOLS/SCREEN_ALLOWED_POOLS only if you want that venue.',
    );
  }
  return 'unknown';
}

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

  /** Mints we are streaming trades for, so they can be re-subscribed on reconnect. */
  private tracked = new Set<string>();
  private onTrade: ((t: TradeEvent) => void) | null = null;

  constructor(private readonly url: string) {}

  async start(onCandidate: (c: TokenCandidate) => void): Promise<void> {
    this.stopped = false;
    void this.connectLoop(onCandidate);
  }

  /** Registers the handler for trades on tracked tokens. */
  onTradeEvent(handler: (t: TradeEvent) => void): void {
    this.onTrade = handler;
  }

  /**
   * Streams trades for these mints.
   *
   * Batched because the feed is metered per event and a subscribe call per
   * token would be both chattier and slower. Subscriptions are remembered and
   * replayed after a reconnect — otherwise a dropped socket silently stops the
   * traction data for everything already being watched, and the watchlist goes
   * quietly blind rather than erroring.
   */
  trackTrades(mints: string[]): void {
    const fresh = mints.filter((m) => !this.tracked.has(m));
    if (fresh.length === 0) return;
    for (const m of fresh) this.tracked.add(m);
    this.sendSubscribe(fresh);
  }

  untrackTrades(mints: string[]): void {
    const known = mints.filter((m) => this.tracked.has(m));
    if (known.length === 0) return;
    for (const m of known) this.tracked.delete(m);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: known }));
    }
  }

  private sendSubscribe(mints: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN || mints.length === 0) return;
    // Chunked: a single enormous keys array risks being rejected outright.
    for (let i = 0; i < mints.length; i += 100) {
      this.ws.send(
        JSON.stringify({ method: 'subscribeTokenTrade', keys: mints.slice(i, i + 100) }),
      );
    }
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
        // Restore trade subscriptions the previous socket was carrying.
        if (this.tracked.size > 0) {
          log.info(`Re-subscribing to trades for ${this.tracked.size} tracked token(s)`);
          this.sendSubscribe([...this.tracked]);
        }
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

        const txType = str(msg.txType);
        if (txType === 'buy' || txType === 'sell') {
          const trade = this.toTrade(msg, txType);
          if (trade && this.onTrade) {
            try {
              this.onTrade(trade);
            } catch (err) {
              log.error(`Trade handler threw for ${trade.mint}: ${errMessage(err)}`);
            }
          }
          return;
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

  private toTrade(msg: NewTokenMessage, side: 'buy' | 'sell'): TradeEvent | null {
    const mint = str(msg.mint);
    const trader = str(msg.traderPublicKey);
    if (!mint || !trader || !this.tracked.has(mint)) return null;
    return {
      mint,
      trader,
      side,
      solAmount: numOrUndef(msg.solAmount) ?? 0,
      tokenAmount: numOrUndef(msg.tokenAmount) ?? 0,
      vSolInCurve: numOrUndef(msg.vSolInBondingCurve),
      marketCapSol: numOrUndef(msg.marketCapSol),
      at: Date.now(),
    };
  }

  private toCandidate(msg: NewTokenMessage): TokenCandidate | null {
    if (str(msg.txType) !== 'create') return null;

    const mint = str(msg.mint);
    const creator = str(msg.traderPublicKey);
    if (!mint || !creator || !isValidMint(mint)) return null;

    const pool = poolOf(str(msg.pool));

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
