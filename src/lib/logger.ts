import { getEnv, LOG_LEVELS, type LogLevel } from './env';

/**
 * Structured logging.
 *
 * Deliberately dependency-free: the whole surface is one line of JSON per
 * event, plus child loggers that carry tenant context (workspaceId,
 * businessId, jobId, requestId) so a single scan or campaign can be traced
 * end to end without threading arguments through every call site.
 *
 * Redaction is not a nicety here. This process handles OAuth tokens for
 * live ad accounts and text scraped from arbitrary third-party websites;
 * anything key-matching a secret pattern is replaced before serialisation.
 */

export type LogContext = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/** Key names whose values never get written out, at any nesting depth. */
const REDACTED_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|auth[_-]?secret|encryption[_-]?key|cookie|session[_-]?id|credential|client[_-]?secret)/i;

const REDACTED = '[REDACTED]';

/** Strings longer than this are truncated; scraped page text is unbounded. */
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serialiseError(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

function serialiseError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) out.stack = error.stack;
  if (error.cause !== undefined) out.cause = redact(error.cause, MAX_DEPTH - 1);
  // Carry structured fields from AppError-shaped errors without importing them
  // (errors.ts imports the logger; keeping the dependency one-way avoids a cycle).
  for (const key of ['code', 'status', 'details', 'retryable'] as const) {
    const extra = (error as unknown as Record<string, unknown>)[key];
    if (extra !== undefined) out[key] = redact(extra, MAX_DEPTH - 1);
  }
  return out;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level: LogLevel;
  format: 'json' | 'pretty';
  /** Injected for tests; defaults to writing to stdout/stderr. */
  sink?: (record: LogRecord) => void;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that merges `bindings` into every subsequent record. */
  child(bindings: LogContext): Logger;
}

const PRETTY_COLOURS: Record<LogLevel, string> = {
  trace: '\u001b[90m',
  debug: '\u001b[36m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

function defaultSink(record: LogRecord, format: 'json' | 'pretty'): void {
  const line =
    format === 'pretty'
      ? formatPretty(record)
      : JSON.stringify(record, (_key, value) => (value === undefined ? null : value));

  if (record.level === 'error' || record.level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function formatPretty(record: LogRecord): string {
  const { timestamp, level, message, ...rest } = record;
  const colour = PRETTY_COLOURS[level];
  const head = `${colour}${level.toUpperCase().padEnd(5)}\u001b[0m ${timestamp} ${message}`;
  const keys = Object.keys(rest);
  return keys.length === 0 ? head : `${head} ${JSON.stringify(rest)}`;
}

function createLoggerWithBindings(options: LoggerOptions, bindings: LogContext): Logger {
  const threshold = LEVEL_WEIGHT[options.level];
  const emit = options.sink ?? ((record: LogRecord) => defaultSink(record, options.format));

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const merged = { ...bindings, ...context };
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(redact(merged) as LogContext),
    };
    emit(record);
  };

  const logger: Logger = {
    trace: (message, context) => write('trace', message, context),
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (extra) => createLoggerWithBindings(options, { ...bindings, ...extra }),
  };
  return logger;
}

export function createLogger(options: LoggerOptions): Logger {
  return createLoggerWithBindings(options, {});
}

/** Exported for tests. */
export const __testing = { redact, LEVEL_WEIGHT, LOG_LEVELS };

let rootLogger: Logger | undefined;

/**
 * The process-wide logger. Lazily built so importing this module never forces
 * environment validation (matters for unit tests of unrelated modules).
 */
export function logger(): Logger {
  if (!rootLogger) {
    const env = getEnv();
    rootLogger = createLogger({ level: env.LOG_LEVEL, format: env.LOG_FORMAT });
  }
  return rootLogger;
}

/** Test-only: drop the memoised root logger. */
export function resetLogger(): void {
  rootLogger = undefined;
}
