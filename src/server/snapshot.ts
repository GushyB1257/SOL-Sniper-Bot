import { walletLabel, type Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Position, TradeJournalEntry } from '../types.js';
import { recentLogs, type LogEntry } from '../logger.js';
import { rpcStats, topMethods } from '../util/rpc-throttle.js';
import type { ArbView } from '../arb/bot.js';
import { pctChange } from '../util/solana.js';

export interface SessionStats {
  seen: number;
  evaluated: number;
  rejected: number;
  bought: number;
  skipped: number;
}

export interface PositionView {
  id: string;
  mint: string;
  symbol: string;
  name?: string;
  pool: string;
  ageSeconds: number;
  costSol: number;
  entryPrice: number;
  lastPrice: number;
  peakPrice: number;
  gainPct: number;
  drawdownFromPeakPct: number;
  realizedSol: number;
  unrealizedSol: number;
  pnlSol: number;
  pnlPct: number;
  originalQty: number;
  remainingQty: number;
  remainingPct: number;
  moonbagArmed: boolean;
  safetyScore: number;
  ladder: { gainPct: number; sellPctOfOriginal: number; filled: boolean }[];
  /** Price at which the hard stop fires. */
  stopPrice: number;
  /** Price at which the active trailing stop fires, if one is armed. */
  trailPrice: number | null;
  /** How far price must fall, in percent, before the nearest stop triggers. */
  distanceToStopPct: number;
  /** True when no price-based stop exists at all (EXIT_MODE=ratchet). */
  noStopLoss: boolean;
  /** Seconds until the next ratchet checkpoint, or null outside that mode. */
  nextCheckpointSeconds: number | null;
  /** Price the next checkpoint has to beat, or null outside that mode. */
  checkpointPrice: number | null;
  /** True once the stake has been taken back out and the rest is house money. */
  costRecovered: boolean;
  /** Market cap at the moment of the buy — the number you screened on. */
  entryMarketCapUsd: number | null;
  entryMarketCapSol: number | null;
  /** Market cap right now, so the pair reads as a before/after. */
  marketCapUsd: number | null;
  /** Wallet this was copied from, when the copy bot opened it. */
  copiedFrom: string | null;
  /** That wallet's name, resolved from config so a rename is retroactive. */
  copiedFromLabel: string | null;
  notes: string[];
}

/** A closed trade, with the tracked wallet's name resolved for display. */
export type JournalRow = TradeJournalEntry & { copiedFromLabel?: string };

/**
 * Every closed position in one token, rolled into a single line.
 *
 * A position that is unwound in stages produces one journal row per position,
 * but a token bought, partly sold and bought again produces several — and read
 * leg by leg those look like losses even when the token made money overall,
 * because each leg carries its own full cost against partial proceeds. The
 * trades table shows these instead of raw rows so the number on screen is the
 * result for the token, which is the only figure that means anything.
 */
export interface TradeGroup {
  mint: string;
  symbol?: string;
  /** How many closed positions are folded into this row. */
  legs: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  /** First entry across the legs. */
  openedAt: number;
  /** Last exit across the legs. */
  closedAt: number;
  /** Entry to final exit, so a re-entry does not read as one long hold. */
  holdSeconds: number;
  /** The last leg's reason; `reasons` has them all. */
  closeReason: string;
  reasons: string[];
  safetyScore: number;
  copiedFrom?: string;
  copiedFromLabel?: string;
}

/** How a single tracked wallet has done for us, in SOL. */
export interface WalletPnl {
  /** Booked, from closed positions copied from this wallet. */
  realizedSol: number;
  /** Mark-to-market on positions copied from it that are still open. */
  unrealizedSol: number;
  netSol: number;
  /** Closed trades copied from this wallet. */
  trades: number;
  wins: number;
  openPositions: number;
}

export interface PnlSummary {
  netSol: number;
  todaySol: number;
  realizedSol: number;
  unrealizedSol: number;
  deployedSol: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  /** Gross wins ÷ gross losses. Below 1.0 means the strategy loses money. */
  profitFactor: number | null;
  avgWinSol: number;
  avgLossSol: number;
  bestSol: number;
  worstSol: number;
  returnPct: number;
}

export interface RiskView {
  killSwitch: boolean;
  breakerActive: boolean;
  breakerUntil: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  todayPnlSol: number;
  dailyLossLimitSol: number;
  spendLastHourSol: number;
  hourlySpendCapSol: number;
  openPositions: number;
  maxConcurrentPositions: number;
  walletBalanceSol: number | null;
  minWalletReserveSol: number;
}

export interface ConfigRow {
  group: string;
  key: string;
  value: string;
}

export interface AiView {
  enabled: boolean;
  model: string;
  entryMode: string;
  watching: number;
  evaluated: number;
  bought: number;
  passed: number;
  reviews: number;
  budgetBlocked: number;
  calls: number;
  refusals: number;
  errors: number;
  estimatedCostUsd: number;
  dailyBudgetUsd: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens that cleared every screener filter. */
  screenMatched: number;
  socialsFetched: number;
  /** Matches a risk limit refused — the gap between matched and bought. */
  blockedByRisk: number;
  buyFailed: number;
  lastBlockReason?: string;
  /** Rejections by failing filter — the knob-tuning instrument. */
  screenRejects: Record<string, number>;
  solUsd: number;
  solPriceLive: boolean;
}

/** The auto-tuner's audit trail, newest first. */
export interface TunerView {
  enabled: boolean;
  intervalMinutes: number;
  minTrades: number;
  lastRunAt: number;
  /** When the next review is due, so "is it alive" has a visible answer. */
  nextRunAt: number;
  /** Where each bot sits in the gather -> change -> measure cycle. */
  byBot: Record<string, { phase: string; trades: number; needed: number; since?: number }>;
  lastError?: string;
  /** When it happened — a stale error and a recurring one read the same without it. */
  lastErrorAt?: number;
  costUsd: number;
  experiments: Array<{
    id: string;
    bot: string;
    startedAt: number;
    status: string;
    changes: Array<{
      key: string;
      from: number | string | boolean;
      to: number | string | boolean;
      why: string;
      clamped?: string;
      /** Moves capital at risk rather than what gets traded. */
      risk?: boolean;
    }>;
    baselineExpectancy: number;
    resultExpectancy?: number;
    resultTrades?: number;
    verdict?: string;
    notes?: string[];
  }>;
}

/** What the copy bot is doing, for its tab. */
export interface CopyView {
  /**
   * One row per tracked wallet. `label` is the user's name for it, or '' when
   * it has none; `pnl` is what copying that wallet has actually earned, which
   * is the only way to tell a wallet worth following from one that is not.
   */
  wallets: Array<{ address: string; label: string; holdings: number; pnl: WalletPnl }>;
  /** Wallets whose first balance read has completed — i.e. actually watched. */
  primed: number;
  tracking: number;
  polls: number;
  errors: number;
  tradesSeen: number;
  bought: number;
  sold: number;
  skips: Record<string, number>;
  lastSkipReason?: string;
}

/** One bot's own books. Nothing here is shared with another bot. */
export interface BotView {
  id: string;
  name: string;
  /** Configured to run. */
  enabled: boolean;
  /** Actually ticking right now. */
  running: boolean;
  /** New entries suspended, existing positions still managed. */
  paused: boolean;
  stats: SessionStats;
  pnl: PnlSummary;
  risk: RiskView;
  positions: PositionView[];
  journal: JournalRow[];
  /** The journal folded per token — what the trades table shows. */
  trades: TradeGroup[];
  equity: { t: number; cum: number; pnl: number; symbol: string }[];
  exitReasons: { reason: string; count: number; pnlSol: number }[];
  creatorsTracked: number;
  /** Screener funnel and analyst spend. Only the screener bot has one. */
  ai: AiView | null;
  /** Only the copy bot has one. */
  copy: CopyView | null;
  arb: ArbView | null;
}

export interface Snapshot {
  now: number;
  startedAt: number;
  uptimeSeconds: number;
  mode: string;
  executor: string;
  discovery: string;
  killSwitch: boolean;
  walletBalanceSol: number | null;
  solUsd: number;
  solPriceLive: boolean;
  bots: BotView[];
  /** What the auto-tuner has changed, and whether it worked. Null when off. */
  tuner: TunerView | null;
  /** RPC health. Non-zero rate limiting is the thing worth seeing at a glance. */
  rpc: {
    requests: number;
    rateLimited: number;
    retries: number;
    givenUp: number;
    /** Requests per second the throttle has settled on, and its configured cap. */
    rateNow: number;
    rateCeiling: number;
    /** Busiest JSON-RPC methods — which subsystem is spending the quota. */
    top: Array<{ method: string; calls: number; pct: number }>;
  };
  /** Read-only view of everything the bot is running with. */
  config: ConfigRow[];
  /** Editable settings: the field specs and their current values. */
  settings: { fields: unknown[]; values: Record<string, string> };
  log: LogEntry[];
}

/** Settings whose values must never reach the browser. */
const SECRET_KEYS = new Set(['WALLET_PRIVATE_KEY']);

/**
 * Endpoints frequently carry an API key in the query string or subdomain
 * (Helius, QuickNode, Triton all do). The dashboard is a web page — showing the
 * raw URL there would leak a paid credential into a browser tab, screenshots,
 * and screen shares.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.search || url.username || url.password) {
      return `${url.protocol}//${url.host}/…(credentials redacted)`;
    }
    // QuickNode-style keys live in the hostname itself.
    const parts = url.hostname.split('.');
    if (parts.length > 2 && (parts[0]?.length ?? 0) >= 16) {
      return `${url.protocol}//…redacted….${parts.slice(1).join('.')}${url.pathname}`;
    }
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

const CONFIG_GROUPS: Record<string, string[]> = {
  Mode: ['MODE', 'ENTRY_MODE', 'EXECUTOR', 'DISCOVERY_SOURCE'],
  Screener: [
    'SCREEN_ALLOWED_POOLS',
    'SCREEN_MIN_MCAP_USD',
    'SCREEN_MAX_MCAP_USD',
    'SCREEN_MIN_VOLUME_USD',
    'SCREEN_MIN_SOCIALS',
    'SCREEN_ON_SOCIALS_UNAVAILABLE',
    'SCREEN_MIN_BUYERS',
    'SCREEN_MIN_AGE_SECONDS',
    'SCREEN_MAX_AGE_SECONDS',
    'SOL_USD_FALLBACK',
  ],
  Sizing: ['BUY_AMOUNT_SOL', 'MAX_CONCURRENT_POSITIONS', 'MIN_WALLET_RESERVE_SOL'],
  Execution: [
    'BUY_SLIPPAGE_PCT',
    'SELL_SLIPPAGE_PCT',
    'PRIORITY_FEE_SOL',
    'JITO_TIP_SOL',
    'MAX_CANDIDATE_AGE_MS',
  ],
  Exit: [
    'EXIT_MODE',
    'EXIT_MAX_ATTEMPTS',
    'EXIT_RETRY_SECONDS',
    'PRICE_STALE_SECONDS',
    'POSITION_TICK_INTERVAL_MS',
    'POSITION_PRICE_TIMEOUT_MS',
  ],
  Ratchet: [
    'CHECKPOINT_SECONDS',
    'RECOVER_AT_GAIN_PCT',
    'MOONBAG_TRIM_PCT',
    'RATCHET_MIN_PROGRESS_PCT',
    'RATCHET_STOP_LOSS_PCT',
    'PROGRAM_FEE_PCT',
    'ROUTER_FEE_PCT',
  ],
  'Scalp exit': [
    'SCALP_TARGET_NET_PCT',
    'SCALP_STOP_LOSS_PCT',
    'SCALP_GIVEBACK_PCT',
    'SCALP_TIME_STOP_SECONDS',
    'SCALP_RUNNER_PCT',
    'SCALP_RUNNER_TRAILING_STOP_PCT',
  ],
  'Ladder exit': [
    'EXIT_LADDER',
    'STOP_LOSS_PCT',
    'TRAILING_STOP_PCT',
    'MOONBAG_TRAILING_STOP_PCT',
    'TIME_STOP_SECONDS',
    'TIME_STOP_MIN_GAIN_PCT',
    'MAX_HOLD_SECONDS',
  ],
  Safety: [
    'MIN_SAFETY_SCORE',
    'MIN_DEV_BUY_PCT',
    'MAX_DEV_BUY_PCT',
    'MAX_TOP10_HOLDER_PCT',
    'MIN_DEPLOYER_BALANCE_SOL',
    'MAX_DEPLOYER_RUG_RATE',
    'REQUIRE_SOCIALS',
    'DUPLICATE_NAME_WINDOW_MINUTES',
  ],
  Risk: [
    'DAILY_LOSS_LIMIT_SOL',
    'MAX_CONSECUTIVE_LOSSES',
    'BREAKER_COOLDOWN_SECONDS',
    'HOURLY_SPEND_CAP_SOL',
  ],
  Connection: ['RPC_HTTP_URL', 'RPC_WS_URL', 'PUMPPORTAL_WS_URL', 'PUMPPORTAL_TRADE_URL'],
};

export function configRows(cfg: Config): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const [group, keys] of Object.entries(CONFIG_GROUPS)) {
    for (const key of keys) {
      if (SECRET_KEYS.has(key)) continue;
      const raw = (cfg as unknown as Record<string, unknown>)[key];
      if (raw === undefined) continue;

      let value: string;
      if (key === 'EXIT_LADDER' && Array.isArray(raw)) {
        value = (raw as { gainPct: number; sellPctOfOriginal: number }[])
          .map((t) => `+${t.gainPct}% → sell ${t.sellPctOfOriginal}%`)
          .join(', ');
      } else if (key.endsWith('_URL')) {
        value = redactUrl(String(raw));
      } else if (Array.isArray(raw)) {
        value = raw.join(', ');
      } else if (key.endsWith('_USD') && typeof raw === 'number') {
        value = raw === 0 ? 'off' : `$${raw.toLocaleString('en-US')}`;
      } else {
        value = String(raw);
      }
      rows.push({ group, key, value });
    }
  }
  return rows;
}

function view(p: Position, cfg: Config, now: number, solUsd: number): PositionView {
  const price = p.lastPrice;
  const gainPct = pctChange(p.entryPrice, price);
  const unrealized = p.remainingQty * price;
  const pnlSol = p.realizedSol + unrealized - p.costSol;

  // In ratchet mode there is deliberately no price-based stop. Rendering one
  // anyway would put a number on the screen that nothing in the bot will act
  // on, which is worse than showing nothing.
  const ratchet = cfg.EXIT_MODE === 'ratchet';
  const stopPct = ratchet ? cfg.RATCHET_STOP_LOSS_PCT : cfg.STOP_LOSS_PCT;
  const stopPrice = stopPct > 0 ? p.entryPrice * (1 - stopPct / 100) : 0;
  const anyFilled = p.ladder.some((t) => t.filled);
  const trailPct = ratchet
    ? null
    : p.moonbagArmed
      ? cfg.MOONBAG_TRAILING_STOP_PCT
      : anyFilled
        ? cfg.TRAILING_STOP_PCT
        : null;
  const trailPrice = trailPct === null ? null : p.peakPrice * (1 - trailPct / 100);

  // Whichever stop is nearest is the one that will actually fire.
  const nearestStop = trailPrice === null ? stopPrice : Math.max(stopPrice, trailPrice);

  return {
    id: p.id,
    mint: p.mint,
    symbol: p.symbol ?? p.mint.slice(0, 6),
    name: p.name,
    pool: p.pool,
    ageSeconds: (now - p.openedAt) / 1000,
    costSol: p.costSol,
    entryPrice: p.entryPrice,
    lastPrice: price,
    peakPrice: p.peakPrice,
    gainPct,
    drawdownFromPeakPct: p.peakPrice > 0 ? pctChange(p.peakPrice, price) : 0,
    realizedSol: p.realizedSol,
    unrealizedSol: unrealized,
    pnlSol,
    pnlPct: p.costSol > 0 ? (pnlSol / p.costSol) * 100 : 0,
    originalQty: p.originalQty,
    remainingQty: p.remainingQty,
    remainingPct: p.originalQty > 0 ? (p.remainingQty / p.originalQty) * 100 : 0,
    moonbagArmed: p.moonbagArmed,
    safetyScore: p.safetyScore,
    ladder: p.ladder.map((t) => ({
      gainPct: t.gainPct,
      sellPctOfOriginal: t.sellPctOfOriginal,
      filled: t.filled,
    })),
    stopPrice,
    trailPrice,
    // Negative: how far price has to fall to hit the nearest stop. Clamped at
    // 0 for the moment where the stop is already breached and about to fire.
    distanceToStopPct:
      price > 0 && stopPrice > 0 ? Math.min(0, pctChange(price, nearestStop)) : 0,
    noStopLoss: ratchet && cfg.RATCHET_STOP_LOSS_PCT === 0,
    nextCheckpointSeconds: ratchet
      ? Math.max(0, cfg.CHECKPOINT_SECONDS - (now - (p.checkpointAt ?? p.openedAt)) / 1000)
      : null,
    checkpointPrice: ratchet ? (p.checkpointPrice ?? p.entryPrice) : null,
    costRecovered: p.costRecovered === true,
    entryMarketCapUsd: p.entryMarketCapUsd ?? null,
    entryMarketCapSol: p.entryMarketCapSol ?? null,
    // Current cap scales with price on a constant-product curve, so the entry
    // cap times the price ratio is exact without a second chain read.
    marketCapUsd:
      p.entryMarketCapSol !== undefined && p.entryPrice > 0
        ? p.entryMarketCapSol * (price / p.entryPrice) * solUsd
        : null,
    copiedFrom: p.copiedFrom ?? null,
    copiedFromLabel: p.copiedFrom ? walletLabel(cfg, p.copiedFrom) : null,
    notes: p.notes.slice(-6),
  };
}

export function summarisePnl(
  journal: readonly TradeJournalEntry[],
  open: readonly Position[],
  todaySol: number,
): PnlSummary {
  const wins = journal.filter((t) => t.pnlSol > 0);
  const losses = journal.filter((t) => t.pnlSol <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0));
  const realized = journal.reduce((a, t) => a + t.pnlSol, 0);
  const deployed = journal.reduce((a, t) => a + t.costSol, 0);

  // Open positions contribute mark-to-market, net of what they cost.
  const unrealized = open.reduce(
    (a, p) => a + (p.realizedSol + p.remainingQty * p.lastPrice - p.costSol),
    0,
  );

  return {
    netSol: realized + unrealized,
    todaySol,
    realizedSol: realized,
    unrealizedSol: unrealized,
    deployedSol: deployed,
    trades: journal.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: journal.length > 0 ? (wins.length / journal.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    avgWinSol: wins.length > 0 ? grossWin / wins.length : 0,
    avgLossSol: losses.length > 0 ? -grossLoss / losses.length : 0,
    bestSol: journal.reduce((m, t) => Math.max(m, t.pnlSol), 0),
    worstSol: journal.reduce((m, t) => Math.min(m, t.pnlSol), 0),
    returnPct: deployed > 0 ? (realized / deployed) * 100 : 0,
  };
}

/**
 * Folds the journal into one row per token, newest first.
 *
 * Legs are summed rather than averaged: cost is everything put in, proceeds is
 * everything taken out, and the percentage is computed from those totals. That
 * is what makes a token whose first leg was trimmed at a paper loss and whose
 * second leg ran read as the single winner it was.
 */
export function aggregateTrades(
  journal: readonly TradeJournalEntry[],
  cfg: Config,
): TradeGroup[] {
  const byMint = new Map<string, TradeGroup>();

  for (const t of journal) {
    const g = byMint.get(t.mint);
    if (!g) {
      byMint.set(t.mint, {
        mint: t.mint,
        symbol: t.symbol,
        legs: 1,
        costSol: t.costSol,
        proceedsSol: t.proceedsSol,
        pnlSol: t.pnlSol,
        pnlPct: t.pnlPct,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        holdSeconds: t.holdSeconds,
        closeReason: t.closeReason,
        reasons: [t.closeReason],
        safetyScore: t.safetyScore,
        copiedFrom: t.copiedFrom,
        copiedFromLabel: t.copiedFrom ? walletLabel(cfg, t.copiedFrom) : undefined,
      });
      continue;
    }
    g.legs += 1;
    g.costSol += t.costSol;
    g.proceedsSol += t.proceedsSol;
    g.pnlSol += t.pnlSol;
    g.pnlPct = g.costSol > 0 ? (g.pnlSol / g.costSol) * 100 : 0;
    g.openedAt = Math.min(g.openedAt, t.openedAt);
    g.closedAt = Math.max(g.closedAt, t.closedAt);
    // Wall-clock from first entry to last exit. Summing the legs' hold times
    // would double-count the gap between them.
    g.holdSeconds = (g.closedAt - g.openedAt) / 1000;
    g.closeReason = t.closedAt >= g.closedAt ? t.closeReason : g.closeReason;
    g.reasons.push(t.closeReason);
    g.safetyScore = Math.max(g.safetyScore, t.safetyScore);
    g.copiedFrom ??= t.copiedFrom;
    if (g.copiedFrom && !g.copiedFromLabel) g.copiedFromLabel = walletLabel(cfg, g.copiedFrom);
  }

  return [...byMint.values()].sort((a, b) => b.closedAt - a.closedAt);
}

/**
 * What copying one wallet has actually made us.
 *
 * Open positions are marked to market rather than ignored: a wallet whose last
 * three calls are all still running is not a wallet with no results, and
 * waiting for them to close would leave the card reading zero for hours.
 */
export function walletPnl(store: Store, address: string): WalletPnl {
  let realizedSol = 0;
  let trades = 0;
  let wins = 0;
  for (const t of store.journal()) {
    if (t.copiedFrom !== address) continue;
    realizedSol += t.pnlSol;
    trades += 1;
    if (t.pnlSol > 0) wins += 1;
  }

  let unrealizedSol = 0;
  let openPositions = 0;
  for (const p of store.openPositions()) {
    if (p.copiedFrom !== address) continue;
    unrealizedSol += p.realizedSol + p.remainingQty * p.lastPrice - p.costSol;
    openPositions += 1;
  }

  return {
    realizedSol,
    unrealizedSol,
    netSol: realizedSol + unrealizedSol,
    trades,
    wins,
    openPositions,
  };
}

export interface BotInput {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  paused: boolean;
  store: Store;
  stats: SessionStats;
  ai: AiView | null;
  copy: CopyView | null;
  /** Set only for the arbitrage tab. */
  arb: ArbView | null;
}

export interface SnapshotInput {
  cfg: Config;
  /** Absent when auto-tuning was never constructed. */
  tuner?: TunerView | null;
  bots: BotInput[];
  startedAt: number;
  discovery: string;
  killSwitch: boolean;
  walletBalanceSol: number | null;
  solUsd: number;
  solPriceLive: boolean;
  settings: { fields: unknown[]; values: Record<string, string> };
}

/** Builds one bot's slice of the snapshot from its own store. */
export function buildBotView(input: BotInput, cfg: Config, solUsd: number, now: number): BotView {
  const open = input.store.openPositions();
  const journal = [...input.store.journal()];

  let cum = 0;
  const equity = journal.map((t) => {
    cum += t.pnlSol;
    return { t: t.closedAt, cum, pnl: t.pnlSol, symbol: t.symbol ?? t.mint.slice(0, 6) };
  });

  const reasons = new Map<string, { count: number; pnlSol: number }>();
  for (const t of journal) {
    const key = t.closeReason.split(':')[0]?.trim() || 'unknown';
    const cur = reasons.get(key) ?? { count: 0, pnlSol: 0 };
    cur.count += 1;
    cur.pnlSol += t.pnlSol;
    reasons.set(key, cur);
  }

  return {
    id: input.id,
    name: input.name,
    enabled: input.enabled,
    running: input.running,
    paused: input.paused,
    stats: input.stats,
    pnl: summarisePnl(journal, open, input.store.todayPnl()),
    risk: {
      killSwitch: false,
      breakerActive: now < input.store.breakerUntil,
      breakerUntil: input.store.breakerUntil,
      consecutiveLosses: input.store.consecutiveLosses,
      maxConsecutiveLosses: cfg.MAX_CONSECUTIVE_LOSSES,
      todayPnlSol: input.store.todayPnl(),
      dailyLossLimitSol: cfg.DAILY_LOSS_LIMIT_SOL,
      spendLastHourSol: input.store.spendLastHour(),
      hourlySpendCapSol: cfg.HOURLY_SPEND_CAP_SOL,
      openPositions: open.length,
      maxConcurrentPositions: cfg.MAX_CONCURRENT_POSITIONS,
      walletBalanceSol: null,
      minWalletReserveSol: cfg.MIN_WALLET_RESERVE_SOL,
    },
    positions: open
      .map((p) => view(p, cfg, now, solUsd))
      .sort((a, b) => a.ageSeconds - b.ageSeconds),
    journal: journal
      .slice(-100)
      .reverse()
      .map((t) => (t.copiedFrom ? { ...t, copiedFromLabel: walletLabel(cfg, t.copiedFrom) } : t)),
    trades: aggregateTrades(journal.slice(-400), cfg).slice(0, 100),
    equity,
    exitReasons: [...reasons]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.count - a.count),
    creatorsTracked: input.store.creatorCount(),
    ai: input.ai,
    copy: input.copy,
    arb: input.arb,
  };
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const now = Date.now();
  return {
    now,
    startedAt: input.startedAt,
    uptimeSeconds: (now - input.startedAt) / 1000,
    mode: input.cfg.MODE,
    executor: input.cfg.EXECUTOR,
    discovery: input.discovery,
    killSwitch: input.killSwitch,
    walletBalanceSol: input.walletBalanceSol,
    solUsd: input.solUsd,
    solPriceLive: input.solPriceLive,
    bots: input.bots.map((b) => {
      const view = buildBotView(b, input.cfg, input.solUsd, now);
      // The kill switch and the wallet are global, but they are what a bot's
      // risk panel is actually gated on, so each copy carries them.
      view.risk.killSwitch = input.killSwitch;
      view.risk.walletBalanceSol = input.walletBalanceSol;
      return view;
    }),
    tuner: input.tuner ?? null,
    rpc: (({ requests, rateLimited, retries, givenUp, rateNow, rateCeiling }) => ({
      requests,
      rateLimited,
      retries,
      givenUp,
      rateNow,
      rateCeiling,
      top: topMethods(4),
    }))(rpcStats()),
    config: configRows(input.cfg),
    settings: input.settings,
    log: [...recentLogs(150)].reverse(),
  };
}
