/**
 * Structured, leveled logger.
 *
 * Two output modes:
 *   - `pretty` (default when stderr is a TTY) — human readable, colourised.
 *   - `json`   — one JSON object per line, for shipping to a log aggregator.
 *
 * Logs always go to **stderr** so that `harvest run ... > data.json` keeps
 * stdout clean for piping data.
 */

import { inspect } from 'node:util';

export const LEVELS = { silent: 100, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };

const COLORS = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[35m',
  trace: '\x1b[90m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

/** Keys whose values are masked before they ever reach a log sink. */
const SECRET_KEYS = /^(pass(word)?|secret|token|api[-_]?key|authorization|cookie|set-cookie|auth)$/i;

function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, code: value.code, stack: value.stack };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '«redacted»' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Mask credentials inside a proxy/URL string: http://user:pw@host -> http://user:***@host */
export function maskUrlCredentials(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/(\/\/[^:/@\s]+):([^@/\s]+)@/g, '$1:***@');
}

export class Logger {
  #level;
  #format;
  #bindings;
  #write;

  constructor({ level = 'info', format = null, bindings = {}, write = null } = {}) {
    this.#level = LEVELS[level] ?? LEVELS.info;
    this.#format = format || (process.stderr.isTTY ? 'pretty' : 'json');
    this.#bindings = bindings;
    this.#write = write || ((line) => process.stderr.write(line + '\n'));
  }

  get level() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === this.#level) ?? 'info';
  }

  setLevel(level) {
    if (LEVELS[level] != null) this.#level = LEVELS[level];
    return this;
  }

  /** Create a sub-logger that stamps every record with extra fields. */
  child(bindings) {
    return new Logger({
      level: this.level,
      format: this.#format,
      bindings: { ...this.#bindings, ...bindings },
      write: this.#write,
    });
  }

  isEnabled(level) {
    return (LEVELS[level] ?? 0) >= this.#level;
  }

  #log(level, msg, meta) {
    if (!this.isEnabled(level)) return;
    const record = {
      time: new Date().toISOString(),
      level,
      msg: typeof msg === 'string' ? msg : inspect(msg, { depth: 3 }),
      ...this.#bindings,
      ...(meta ? redact(meta) : {}),
    };

    if (this.#format === 'json') {
      this.#write(JSON.stringify(record));
      return;
    }

    const color = process.stderr.isTTY ? COLORS[level] || '' : '';
    const reset = process.stderr.isTTY ? COLORS.reset : '';
    const dim = process.stderr.isTTY ? COLORS.dim : '';
    const time = record.time.slice(11, 23);
    const tag = level.toUpperCase().padEnd(5);

    const extras = { ...this.#bindings, ...(meta ? redact(meta) : {}) };
    let suffix = '';
    const parts = [];
    for (const [k, v] of Object.entries(extras)) {
      if (v === undefined) continue;
      if (k === 'stack') continue;
      parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    if (parts.length) suffix = ` ${dim}${parts.join(' ')}${reset}`;

    this.#write(`${dim}${time}${reset} ${color}${tag}${reset} ${record.msg}${suffix}`);
    if (extras.stack && this.isEnabled('debug')) this.#write(`${dim}${extras.stack}${reset}`);
  }

  error(msg, meta) { this.#log('error', msg, meta); }
  warn(msg, meta) { this.#log('warn', msg, meta); }
  info(msg, meta) { this.#log('info', msg, meta); }
  debug(msg, meta) { this.#log('debug', msg, meta); }
  trace(msg, meta) { this.#log('trace', msg, meta); }
}

export function createLogger(options) {
  return new Logger(options);
}

/** A logger that swallows everything — handy in tests. */
export const nullLogger = new Logger({ level: 'silent', write: () => {} });
