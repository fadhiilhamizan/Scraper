/**
 * Output writers.
 *
 * Every writer implements the same tiny contract:
 *
 *   await writer.open()
 *   await writer.write(items)   // called many times
 *   await writer.close()        // returns a summary
 *
 * Writers stream wherever the format allows it, so a run producing a million
 * records doesn't need a million records' worth of RAM. The two that can't
 * stream (JSON array, XLSX) say so in their docs.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/* ────────────────────────────── base class ──────────────────────────────── */

export class Writer {
  constructor(options = {}) {
    this.options = options;
    this.count = 0;
    this.opened = false;
    this.closed = false;
  }

  async open() { this.opened = true; }
  // eslint-disable-next-line no-unused-vars
  async write(_items) { throw new Error('write() must be implemented'); }
  async close() { this.closed = true; return this.summary(); }

  summary() {
    return { format: this.constructor.name, records: this.count, destination: this.options.path ?? null };
  }

  /** Ensure the parent directory of `this.options.path` exists. */
  async ensureDir() {
    if (!this.options.path) return;
    await fsp.mkdir(path.dirname(path.resolve(this.options.path)), { recursive: true });
  }
}

/** Wrap a write stream so `write()` respects backpressure. */
function createStream(filePath, { append = false, gzip = false } = {}) {
  const flags = append ? 'a' : 'w';
  const fileStream = fs.createWriteStream(filePath, { flags });
  if (!gzip) return { sink: fileStream, done: streamFinished(fileStream) };
  const gzipStream = zlib.createGzip();
  gzipStream.pipe(fileStream);
  return { sink: gzipStream, done: streamFinished(fileStream) };
}

function streamFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });
}

function writeChunk(sink, chunk) {
  return new Promise((resolve, reject) => {
    // Honour backpressure: a fast scraper can easily outrun a slow disk.
    if (sink.write(chunk)) resolve();
    else sink.once('drain', resolve);
    sink.once('error', reject);
  });
}

/* ───────────────────────────── NDJSON / JSONL ───────────────────────────── */

/**
 * Newline-delimited JSON. The best default for large runs: fully streaming,
 * append-safe, and readable by `jq`, pandas, DuckDB and BigQuery directly.
 */
export class NdjsonWriter extends Writer {
  async open() {
    await this.ensureDir();
    const { sink, done } = createStream(this.options.path, {
      append: this.options.append === true,
      gzip: this.options.gzip === true,
    });
    this.sink = sink;
    this.done = done;
    this.opened = true;
  }

  async write(items) {
    if (!items?.length) return;
    const chunk = `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
    await writeChunk(this.sink, chunk);
    this.count += items.length;
  }

  async close() {
    this.sink?.end();
    await this.done;
    this.closed = true;
    return this.summary();
  }

  summary() {
    return { format: 'ndjson', records: this.count, destination: this.options.path };
  }
}

/* ─────────────────────────────── JSON array ─────────────────────────────── */

/**
 * A single JSON array. Written incrementally (open bracket, commas, close
 * bracket) so memory stays flat even though the *file* isn't streamable.
 */
export class JsonWriter extends Writer {
  async open() {
    await this.ensureDir();
    const { sink, done } = createStream(this.options.path, { gzip: this.options.gzip === true });
    this.sink = sink;
    this.done = done;
    this.first = true;
    this.indent = this.options.pretty === false ? null : 2;
    await writeChunk(this.sink, this.indent ? '[\n' : '[');
    this.opened = true;
  }

  async write(items) {
    if (!items?.length) return;
    const parts = [];
    for (const item of items) {
      const json = this.indent
        ? JSON.stringify(item, null, this.indent).split('\n').map((l) => `  ${l}`).join('\n')
        : JSON.stringify(item);
      parts.push(this.first ? json : (this.indent ? `,\n${json}` : `,${json}`));
      this.first = false;
    }
    await writeChunk(this.sink, parts.join(''));
    this.count += items.length;
  }

  async close() {
    if (this.sink) {
      await writeChunk(this.sink, this.indent ? '\n]\n' : ']');
      this.sink.end();
      await this.done;
    }
    this.closed = true;
    return this.summary();
  }

  summary() {
    return { format: 'json', records: this.count, destination: this.options.path };
  }
}

/* ────────────────────────────────── CSV ─────────────────────────────────── */

/** Quote a CSV field only when it needs it. */
export function csvEscape(value, delimiter = ',') {
  if (value == null) return '';
  let str;
  if (typeof value === 'object') str = JSON.stringify(value);
  else str = String(value);

  // Strip characters that corrupt a CSV regardless of quoting.
  // NUL and other control bytes break CSV parsers regardless of quoting.
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  const needsQuotes =
    str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r') ||
    str.startsWith(' ') || str.endsWith(' ');

  if (!needsQuotes) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * CSV / TSV.
 *
 * Columns are either given explicitly or inferred from the first
 * `headerSampleSize` records — inference has to buffer that many rows because
 * the header line must be written before any data.
 */
export class CsvWriter extends Writer {
  constructor(options = {}) {
    super(options);
    this.delimiter = options.delimiter ?? (options.format === 'tsv' ? '\t' : ',');
    this.columns = options.columns ?? null;
    this.headerSampleSize = options.headerSampleSize ?? 100;
    this.buffer = [];
    this.headerWritten = false;
    this.droppedKeys = new Set();
    this.flatten = options.flatten !== false;
  }

  async open() {
    await this.ensureDir();
    const { sink, done } = createStream(this.options.path, {
      append: this.options.append === true,
      gzip: this.options.gzip === true,
    });
    this.sink = sink;
    this.done = done;
    // A UTF-8 BOM makes Excel open non-ASCII text correctly instead of as mojibake.
    if (this.options.bom !== false && this.options.append !== true) {
      await writeChunk(this.sink, '﻿');
    }
    this.opened = true;
  }

  #flattenRecord(record, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(record ?? {})) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (this.flatten && value != null && typeof value === 'object' && !Array.isArray(value)) {
        this.#flattenRecord(value, name, out);
      } else if (Array.isArray(value)) {
        out[name] = value.every((v) => v == null || typeof v !== 'object')
          ? value.join('; ')
          : JSON.stringify(value);
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  #row(record) {
    const flat = this.#flattenRecord(record);
    for (const key of Object.keys(flat)) {
      if (!this.columns.includes(key)) this.droppedKeys.add(key);
    }
    return this.columns.map((col) => csvEscape(flat[col], this.delimiter)).join(this.delimiter);
  }

  async #writeHeader() {
    const header = this.columns.map((c) => csvEscape(c, this.delimiter)).join(this.delimiter);
    if (this.options.append !== true || this.options.header !== false) {
      await writeChunk(this.sink, `${header}\n`);
    }
    this.headerWritten = true;
  }

  async write(items) {
    if (!items?.length) return;

    if (!this.headerWritten) {
      if (!this.columns) {
        this.buffer.push(...items);
        if (this.buffer.length < this.headerSampleSize) return;
        this.columns = inferColumns(this.buffer.map((r) => this.#flattenRecord(r)));
      }
      await this.#writeHeader();
      if (this.buffer.length) {
        const pending = this.buffer;
        this.buffer = [];
        await writeChunk(this.sink, `${pending.map((r) => this.#row(r)).join('\n')}\n`);
        this.count += pending.length;
        return;
      }
    }

    await writeChunk(this.sink, `${items.map((r) => this.#row(r)).join('\n')}\n`);
    this.count += items.length;
  }

  async close() {
    // Flush anything still buffered for header inference.
    if (!this.headerWritten && this.buffer.length) {
      this.columns ??= inferColumns(this.buffer.map((r) => this.#flattenRecord(r)));
      await this.#writeHeader();
      await writeChunk(this.sink, `${this.buffer.map((r) => this.#row(r)).join('\n')}\n`);
      this.count += this.buffer.length;
      this.buffer = [];
    }
    this.sink?.end();
    await this.done;
    this.closed = true;
    return this.summary();
  }

  summary() {
    return {
      format: this.delimiter === '\t' ? 'tsv' : 'csv',
      records: this.count,
      destination: this.options.path,
      columns: this.columns?.length ?? 0,
      warning: this.droppedKeys.size
        ? `${this.droppedKeys.size} field(s) appeared after the header was written and were omitted: ${[...this.droppedKeys].slice(0, 5).join(', ')}. Set \`columns\` explicitly to include them.`
        : undefined,
    };
  }
}

/** Union of keys across records, ordered by how often they appear. */
function inferColumns(records) {
  const counts = new Map();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Frequency first (so core fields lead), then first-seen order for stability.
  const order = [...counts.keys()];
  return order.sort((a, b) => (counts.get(b) - counts.get(a)) || order.indexOf(a) - order.indexOf(b));
}

/* ────────────────────────────────── XLSX ────────────────────────────────── */

/**
 * Minimal but valid `.xlsx`, written with no third-party dependency.
 *
 * An XLSX file is a ZIP of XML parts. We emit the four parts Excel requires and
 * build the archive with `zlib.deflateRaw`, which keeps the dependency tree
 * empty. Buffers all rows — spreadsheets are not a streaming format, and
 * anything large enough to matter should be CSV or SQLite anyway.
 */
export class XlsxWriter extends Writer {
  constructor(options = {}) {
    super(options);
    this.rows = [];
    this.columns = options.columns ?? null;
    this.sheetName = (options.sheetName ?? 'Data').slice(0, 31).replace(/[\\/*?:[\]]/g, '_');
    this.maxRows = options.maxRows ?? 1_048_575;
  }

  async open() {
    await this.ensureDir();
    this.opened = true;
  }

  async write(items) {
    if (!items?.length) return;
    for (const item of items) {
      if (this.rows.length >= this.maxRows) break;
      this.rows.push(flattenForSheet(item));
    }
    this.count = this.rows.length;
  }

  async close() {
    const columns = this.columns ?? inferColumns(this.rows);
    const sheetXml = buildSheetXml(columns, this.rows);
    const files = buildXlsxParts(sheetXml, this.sheetName);
    const zip = buildZip(files);
    await fsp.writeFile(this.options.path, zip);
    this.closed = true;
    return this.summary();
  }

  summary() {
    return { format: 'xlsx', records: this.count, destination: this.options.path, sheet: this.sheetName };
  }
}

function flattenForSheet(record, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(record ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) flattenForSheet(value, name, out);
    else if (Array.isArray(value)) out[name] = value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)).join('; ');
    else out[name] = value;
  }
  return out;
}

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 and make Excel refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Convert a zero-based column index to a spreadsheet letter (0 -> A, 26 -> AA). */
function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildSheetXml(columns, rows) {
  const cells = [];

  const headerCells = columns
    .map((col, i) => `<c r="${columnLetter(i)}1" t="inlineStr" s="1"><is><t>${xmlEscape(col)}</t></is></c>`)
    .join('');
  cells.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    const rowCells = columns
      .map((col, colIndex) => {
        const value = row[col];
        if (value == null || value === '') return '';
        const ref = `${columnLetter(colIndex)}${r}`;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return `<c r="${ref}"><v>${value}</v></c>`;
        }
        if (typeof value === 'boolean') {
          return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      })
      .join('');
    cells.push(`<row r="${r}">${rowCells}</row>`);
  });

  const lastCol = columnLetter(Math.max(0, columns.length - 1));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${rows.length + 1}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<sheetData>${cells.join('')}</sheetData>
<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>
</worksheet>`;
}

function buildXlsxParts(sheetXml, sheetName) {
  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
}

/** CRC-32, needed for ZIP entry headers. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Build a ZIP archive (deflate) from `{name, data}` entries. */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const content = Buffer.from(file.data, 'utf8');
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (1 Jan 1996 — deterministic)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    chunks.push(local, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);   // version made by
    centralHeader.writeUInt16LE(20, 6);   // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(0, 38);   // external attributes
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ───────────────────────────────── SQLite ──────────────────────────────── */

/**
 * SQLite via Node's built-in `node:sqlite` (Node >= 22.5) — no native module
 * to compile. Columns are created from the first batch and new columns are
 * added with `ALTER TABLE` as they appear, so a changing shape doesn't break
 * the run.
 */
export class SqliteWriter extends Writer {
  constructor(options = {}) {
    super(options);
    this.table = (options.table ?? 'items').replace(/[^A-Za-z0-9_]/g, '_');
    this.columns = new Set();
    this.db = null;
    this.upsertKey = options.upsertKey ?? null;
  }

  async open() {
    await this.ensureDir();
    let sqlite;
    try {
      sqlite = await import('node:sqlite');
    } catch (error) {
      throw new Error(
        'SQLite output requires Node 22.5 or newer (the built-in `node:sqlite` module).\n' +
        `  This process is running Node ${process.version}. Use --format ndjson instead, or upgrade Node.`,
        { cause: error },
      );
    }

    this.db = new sqlite.DatabaseSync(this.options.path);
    // WAL keeps writes fast and lets you query the file while the run continues.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.opened = true;
  }

  #ensureTable(sample) {
    const keys = Object.keys(sample);
    if (this.columns.size === 0) {
      const definitions = keys.map((k) => `"${k}" ${sqlType(sample[k])}`);
      const unique = this.upsertKey ? `, UNIQUE("${this.upsertKey}")` : '';
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS "${this.table}" (` +
        `_id INTEGER PRIMARY KEY AUTOINCREMENT, ${definitions.join(', ')}${unique})`,
      );
      // Pick up columns from a pre-existing table so appends work.
      for (const row of this.db.prepare(`PRAGMA table_info("${this.table}")`).all()) {
        this.columns.add(row.name);
      }
      for (const k of keys) this.columns.add(k);
      return;
    }

    for (const key of keys) {
      if (this.columns.has(key)) continue;
      this.db.exec(`ALTER TABLE "${this.table}" ADD COLUMN "${key}" ${sqlType(sample[key])}`);
      this.columns.add(key);
    }
  }

  async write(items) {
    if (!items?.length) return;

    const flattened = items.map((item) => flattenForSheet(item));
    for (const row of flattened) this.#ensureTable(row);

    const columns = [...this.columns].filter((c) => c !== '_id');
    const placeholders = columns.map(() => '?').join(', ');
    const verb = this.upsertKey ? 'INSERT OR REPLACE' : 'INSERT';
    const statement = this.db.prepare(
      `${verb} INTO "${this.table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
    );

    // One transaction per batch: roughly 100× faster than per-row commits.
    this.db.exec('BEGIN');
    try {
      for (const row of flattened) {
        statement.run(...columns.map((col) => toSqlValue(row[col])));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.count += items.length;
  }

  async close() {
    this.db?.close();
    this.closed = true;
    return this.summary();
  }

  summary() {
    return { format: 'sqlite', records: this.count, destination: this.options.path, table: this.table };
  }
}

function sqlType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'boolean') return 'INTEGER';
  return 'TEXT';
}

function toSqlValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* ───────────────────────────────── console ─────────────────────────────── */

/** Prints records to stdout — for `--format json` piping and for `--dry-run`. */
export class ConsoleWriter extends Writer {
  constructor(options = {}) {
    super(options);
    this.mode = options.mode ?? 'ndjson';
    this.buffered = [];
  }

  async write(items) {
    if (!items?.length) return;
    this.count += items.length;
    if (this.mode === 'ndjson') {
      for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
    } else {
      this.buffered.push(...items);
    }
  }

  async close() {
    if (this.mode === 'json') {
      process.stdout.write(`${JSON.stringify(this.buffered, null, 2)}\n`);
    } else if (this.mode === 'table' && this.buffered.length) {
      // eslint-disable-next-line no-console
      console.table(this.buffered.slice(0, this.options.limit ?? 50).map((r) => flattenForSheet(r)));
    }
    this.closed = true;
    return this.summary();
  }

  summary() {
    return { format: `console:${this.mode}`, records: this.count, destination: 'stdout' };
  }
}

/** Discards everything — used by `--dry-run`. */
export class NullWriter extends Writer {
  async write(items) { this.count += items?.length ?? 0; }
  summary() { return { format: 'null', records: this.count, destination: null }; }
}
