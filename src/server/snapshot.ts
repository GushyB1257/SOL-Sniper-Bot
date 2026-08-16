import type { Config } from '../config.js';
import type { Store } from '../state/store.js';
import type { Position, TradeJournalEntry } from '../types.js';
import { recentLogs, type LogEntry } from '../logger.js';
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
  notes: string[];
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

export interface Snapshot {
  now: number;
  startedAt: number;
  uptimeSeconds: number;
  mode: string;
  executor: string;
  discovery: string;
  stats: SessionStats;
  pnl: PnlSummary;
  risk: RiskView;
  positions: PositionView[];
  journal: TradeJournalEntry[];
  /** Cumulative realised PnL after each closed trade, for the equity curve. */
  equity: { t: number; cum: number; pnl: number; symbol: string }[];
  exitReasons: { reason: string; count: number; pnlSol: number }[];
  config: ConfigRow[];
  log: LogEntry[];
  creatorsTracked: number;
  ai: AiView | null;
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
  'Scalp exit': [
    'SCALP_MODE',
    'SCALP_TARGET_NET_PCT',
    'SCALP_STOP_LOSS_PCT',
    'SCALP_GIVEBACK_PCT',
    'SCALP_TIME_STOP_SECONDS',
    'SCALP_RUNNER_PCT',
    'SCALP_RUNNER_TRAILING_STOP_PCT',
    'PROGRAM_FEE_PCT',
    'ROUTER_FEE_PCT',
  ],
  Exits: [
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

function view(p: Position, cfg: Config, now: number): PositionView {
  const price = p.lastPrice;
  const gainPct = pctChange(p.entryPrice, price);
  const unrealized = p.remainingQty * price;
  const pnlSol = p.realizedSol + unrealized - p.costSol;

  const stopPrice = p.entryPrice * (1 - cfg.STOP_LOSS_PCT / 100);
  const anyFilled = p.ladder.some((t) => t.filled);
  const trailPct = p.moonbagArmed
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
    distanceToStopPct: price > 0 ? Math.min(0, pctChange(price, nearestStop)) : 0,
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

export interface SnapshotInput {
  cfg: Config;
  store: Store;
  stats: SessionStats;
  startedAt: number;
  discovery: string;
  killSwitch: boolean;
  walletBalanceSol: number | null;
  ai: AiView | null;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { cfg, store, stats, startedAt, discovery, killSwitch, walletBalanceSol, ai } = input;
  const now = Date.now();

  const open = store.openPositions();
  const journal = [...store.journal()];

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
    now,
    startedAt,
    uptimeSeconds: (now - startedAt) / 1000,
    mode: cfg.MODE,
    executor: cfg.EXECUTOR,
    discovery,
    stats,
    pnl: summarisePnl(journal, open, store.todayPnl()),
    risk: {
      killSwitch,
      breakerActive: now < store.breakerUntil,
      breakerUntil: store.breakerUntil,
      consecutiveLosses: store.consecutiveLosses,
      maxConsecutiveLosses: cfg.MAX_CONSECUTIVE_LOSSES,
      todayPnlSol: store.todayPnl(),
      dailyLossLimitSol: cfg.DAILY_LOSS_LIMIT_SOL,
      spendLastHourSol: store.spendLastHour(),
      hourlySpendCapSol: cfg.HOURLY_SPEND_CAP_SOL,
      openPositions: open.length,
      maxConcurrentPositions: cfg.MAX_CONCURRENT_POSITIONS,
      walletBalanceSol,
      minWalletReserveSol: cfg.MIN_WALLET_RESERVE_SOL,
    },
    positions: open
      .map((p) => view(p, cfg, now))
      .sort((a, b) => a.ageSeconds - b.ageSeconds),
    journal: journal.slice(-100).reverse(),
    equity,
    exitReasons: [...reasons]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.count - a.count),
    config: configRows(cfg),
    log: [...recentLogs(150)].reverse(),
    creatorsTracked: store.creatorCount(),
    ai,
  };
}
