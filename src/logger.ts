/** Minimal levelled logger. Structured enough to pipe into jq, no dependency. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let threshold: number = ORDER.info;
let useColor = process.stdout.isTTY === true;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

export function setColor(on: boolean): void {
  useColor = on;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${tag}${RESET}` : tag;
  let line = `${ts} ${head} [${scope}] ${msg}`;
  if (extra !== undefined) {
    line += ` ${typeof extra === 'string' ? extra : safeJson(extra)}`;
  }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(sub: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
