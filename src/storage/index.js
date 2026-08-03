/**
 * Output registry and fan-out.
 *
 * A run can write to several destinations at once (`--output data.csv --output
 * data.json`), so the engine always talks to a `MultiWriter` and never cares
 * how many real writers sit behind it.
 */

import path from 'node:path';

import {
  Writer, NdjsonWriter, JsonWriter, CsvWriter, XlsxWriter, SqliteWriter,
  ConsoleWriter, NullWriter,
} from './writers.js';

/** Extension → format, so `--output data.csv` needs no `--format`. */
const EXTENSION_FORMATS = {
  '.json': 'json',
  '.ndjson': 'ndjson',
  '.jsonl': 'ndjson',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.txt': 'ndjson',
  '.xlsx': 'xlsx',
  '.db': 'sqlite',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
};

export const FORMATS = {
  json: JsonWriter,
  ndjson: NdjsonWriter,
  jsonl: NdjsonWriter,
  csv: CsvWriter,
  tsv: CsvWriter,
  xlsx: XlsxWriter,
  excel: XlsxWriter,
  sqlite: SqliteWriter,
  db: SqliteWriter,
  console: ConsoleWriter,
  stdout: ConsoleWriter,
  none: NullWriter,
  null: NullWriter,
};

/** Infer a format from a file path, honouring a `.gz` suffix. */
export function formatFromPath(filePath) {
  if (!filePath) return null;
  let base = filePath;
  let gzip = false;
  if (base.endsWith('.gz')) {
    gzip = true;
    base = base.slice(0, -3);
  }
  const format = EXTENSION_FORMATS[path.extname(base).toLowerCase()] ?? null;
  return format ? { format, gzip } : null;
}

/**
 * Build a writer from an output spec.
 *
 * @param {string|object} spec  A path (`'out/data.csv'`), or
 *        `{ format, path, ...formatOptions }`.
 * @returns {Writer}
 */
export function createWriter(spec) {
  const config = typeof spec === 'string' ? { path: spec } : { ...spec };

  if (!config.format) {
    if (!config.path || config.path === '-' || config.path === 'stdout') {
      config.format = 'console';
    } else {
      const inferred = formatFromPath(config.path);
      if (!inferred) {
        throw new Error(
          `Cannot infer an output format from '${config.path}'. ` +
          `Add \`format:\` explicitly. Supported: ${Object.keys(FORMATS).join(', ')}.`,
        );
      }
      config.format = inferred.format;
      config.gzip ??= inferred.gzip;
    }
  }

  const key = String(config.format).toLowerCase();
  const WriterClass = FORMATS[key];
  if (!WriterClass) {
    throw new Error(`Unknown output format '${config.format}'. Supported: ${Object.keys(FORMATS).join(', ')}.`);
  }

  if (key === 'tsv') config.delimiter ??= '\t';
  return new WriterClass(config);
}

/** Writes every batch to several writers, tolerating a single failure. */
export class MultiWriter extends Writer {
  /**
   * @param {(string|object|Writer)[]} specs
   * @param {object} [options]
   * @param {object} [options.logger]
   */
  constructor(specs = [], options = {}) {
    super(options);
    this.logger = options.logger ?? null;
    this.writers = specs.map((spec) => (spec instanceof Writer ? spec : createWriter(spec)));
    this.failed = new Map();
  }

  get isEmpty() {
    return this.writers.length === 0;
  }

  async open() {
    await Promise.all(this.writers.map(async (writer) => {
      try {
        await writer.open();
      } catch (error) {
        this.failed.set(writer, error);
        this.logger?.error('output failed to open', {
          format: writer.summary().format, error: error.message,
        });
      }
    }));
    // If every destination failed there is nowhere for data to go — stop now
    // rather than after a long crawl.
    if (this.writers.length > 0 && this.failed.size === this.writers.length) {
      const [firstError] = this.failed.values();
      throw firstError;
    }
    this.opened = true;
  }

  async write(items) {
    if (!items?.length) return;
    await Promise.all(this.writers.map(async (writer) => {
      if (this.failed.has(writer)) return;
      try {
        await writer.write(items);
      } catch (error) {
        // One broken sink shouldn't lose the data going to the others.
        this.failed.set(writer, error);
        this.logger?.error('output write failed — this destination is now disabled', {
          format: writer.summary().format, error: error.message,
        });
      }
    }));
    this.count += items.length;
  }

  async close() {
    const summaries = [];
    for (const writer of this.writers) {
      try {
        summaries.push(await writer.close());
      } catch (error) {
        summaries.push({ format: writer.summary().format, error: error.message });
      }
    }
    this.closed = true;
    return summaries;
  }

  summary() {
    return this.writers.map((w) => w.summary());
  }
}

/**
 * Batches records so writers get useful chunk sizes instead of one call per
 * item, and flushes on a timer so a slow crawl still produces output promptly.
 */
export class BufferedSink {
  /**
   * @param {MultiWriter} writer
   * @param {object} [options]
   * @param {number} [options.batchSize=100]
   * @param {number} [options.flushIntervalMs=5000]
   */
  constructor(writer, options = {}) {
    this.writer = writer;
    this.batchSize = options.batchSize ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.buffer = [];
    this.timer = null;
    this.flushing = null;
    this.total = 0;
  }

  async open() {
    await this.writer.open();
    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  async push(items) {
    const list = Array.isArray(items) ? items : [items];
    if (list.length === 0) return;
    this.buffer.push(...list);
    this.total += list.length;
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    // Serialise flushes so the timer and a full buffer can't interleave.
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length === 0) return;
    }
    const batch = this.buffer;
    this.buffer = [];
    this.flushing = this.writer.write(batch).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    return this.writer.close();
  }
}

export * from './writers.js';
