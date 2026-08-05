/**
 * Duplicate detection.
 *
 * Two independent axes:
 *   - **What identifies a record?** The whole record, a chosen set of key
 *     fields, or its source URL.
 *   - **How is the seen-set stored?** An exact `Set` (precise, memory grows
 *     linearly) or a Bloom filter (fixed memory, small false-positive rate —
 *     appropriate above a few million records).
 *
 * The seen-set can be persisted, which makes incremental runs possible: point
 * two runs at the same store and the second only emits records it hasn't seen.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bumped whenever the record→hash mapping changes. A persisted store from a
 * different version cannot be reused: every key would differ, so nothing would
 * match and the whole dataset would be re-emitted.
 *
 * 2 — leaf values are normalised inside nested structures, so `case_sensitive`
 *     and `trim_whitespace` now apply to object-valued records.
 */
const KEY_VERSION = 2;

/**
 * Fixed-memory probabilistic set. Never reports a false negative, so it can
 * only ever *over*-count duplicates — the safe direction for a scraper.
 */
export class BloomFilter {
  /**
   * @param {number} expectedItems
   * @param {number} [falsePositiveRate=0.001]
   */
  constructor(expectedItems = 1_000_000, falsePositiveRate = 0.001) {
    // Optimal sizing: m = -n·ln(p)/ln(2)², k = (m/n)·ln2
    const bits = Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
    this.bits = Math.max(1024, bits);
    this.hashCount = Math.max(1, Math.round((this.bits / expectedItems) * Math.LN2));
    this.buffer = new Uint8Array(Math.ceil(this.bits / 8));
    this.count = 0;
  }

  #indices(value) {
    // Kirsch–Mitzenmacher: two real hashes simulate k hashes.
    const digest = createHash('sha256').update(value).digest();
    const h1 = digest.readUInt32BE(0);
    const h2 = digest.readUInt32BE(4) | 1;
    const out = new Array(this.hashCount);
    for (let i = 0; i < this.hashCount; i += 1) {
      out[i] = ((h1 + i * h2) >>> 0) % this.bits;
    }
    return out;
  }

  add(value) {
    let existed = true;
    for (const index of this.#indices(value)) {
      const byte = index >> 3;
      const mask = 1 << (index & 7);
      if ((this.buffer[byte] & mask) === 0) {
        existed = false;
        this.buffer[byte] |= mask;
      }
    }
    if (!existed) this.count += 1;
    return existed;
  }

  has(value) {
    for (const index of this.#indices(value)) {
      if ((this.buffer[index >> 3] & (1 << (index & 7))) === 0) return false;
    }
    return true;
  }

  get size() {
    return this.count;
  }

  get memoryBytes() {
    return this.buffer.byteLength;
  }
}

/**
 * Stable stringification — key order must not affect the hash.
 *
 * `normalizeLeaf` is applied to every primitive *inside* the structure. It has
 * to happen here rather than to the finished string: normalising afterwards
 * would fold the JSON punctuation too, and normalising only at the top level
 * (the previous behaviour) silently ignored `case_sensitive` and
 * `trim_whitespace` for every object-valued record.
 */
function stableStringify(value, normalizeLeaf = null) {
  if (value === null || typeof value !== 'object') {
    const leaf = normalizeLeaf ? normalizeLeaf(value) : value;
    return JSON.stringify(leaf) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, normalizeLeaf)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], normalizeLeaf)}`).join(',')}}`;
}

/** Normalise a value before hashing so trivial differences don't defeat dedupe. */
function normalizeForKey(value, options) {
  if (value == null) return '';
  const leaf = (v) => {
    if (v == null || typeof v !== 'string') return v;
    let s = v;
    if (options.trimWhitespace) s = s.replace(/\s+/g, ' ').trim();
    if (!options.caseSensitive) s = s.toLowerCase();
    return s;
  };
  if (typeof value === 'object') return stableStringify(value, leaf);
  return String(leaf(String(value)));
}

export class Deduplicator {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {'record'|'fields'|'url'} [options.strategy='record']
   * @param {string[]} [options.keyFields]   Required for `strategy: 'fields'`.
   * @param {string[]} [options.ignoreFields] Excluded from `record` hashing —
   *        use for volatile fields like `scraped_at`.
   * @param {'set'|'bloom'} [options.store='set']
   * @param {number} [options.expectedItems=1000000]  Bloom sizing.
   * @param {string} [options.persistPath]  File to load/save the seen-set.
   * @param {boolean}[options.caseSensitive=false]
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.strategy = options.strategy ?? 'record';
    this.keyFields = options.keyFields ?? null;
    this.ignoreFields = new Set(options.ignoreFields ?? []);
    this.caseSensitive = options.caseSensitive === true;
    this.trimWhitespace = options.trimWhitespace !== false;
    this.persistPath = options.persistPath ?? null;

    this.storeType = options.store ?? 'set';
    this.store = this.storeType === 'bloom'
      ? new BloomFilter(options.expectedItems ?? 1_000_000, options.falsePositiveRate ?? 0.001)
      : new Set();

    this.seenCount = 0;
    this.duplicateCount = 0;
    this.uniqueCount = 0;
    /** Set by `load()` when a persisted store could not be reused. */
    this.incompatibleStore = null;
  }

  /** The identity string for a record, before hashing. */
  keyFor(record, context = {}) {
    switch (this.strategy) {
      case 'url':
        return normalizeForKey(context.url ?? record?.url ?? record?._url ?? '', this);
      case 'fields': {
        if (!this.keyFields?.length) {
          throw new Error("dedupe strategy 'fields' requires `keyFields`");
        }
        return this.keyFields
          .map((field) => `${field}=${normalizeForKey(getField(record, field), this)}`)
          .join('|');
      }
      case 'record':
      default: {
        if (this.ignoreFields.size === 0) return normalizeForKey(record, this);
        const filtered = {};
        for (const [k, v] of Object.entries(record ?? {})) {
          if (!this.ignoreFields.has(k)) filtered[k] = v;
        }
        return normalizeForKey(filtered, this);
      }
    }
  }

  hash(record, context) {
    return createHash('sha1').update(this.keyFor(record, context)).digest('hex');
  }

  /**
   * Record a value and report whether it had been seen.
   * @returns {{duplicate:boolean, hash:string}}
   */
  check(record, context = {}) {
    if (!this.enabled) {
      this.uniqueCount += 1;
      return { duplicate: false, hash: null };
    }

    const hash = this.hash(record, context);

    if (this.store.has(hash)) {
      this.duplicateCount += 1;
      return { duplicate: true, hash };
    }

    this.store.add(hash);
    this.seenCount += 1;
    this.uniqueCount += 1;
    return { duplicate: false, hash };
  }

  /** Non-mutating test. */
  has(record, context = {}) {
    if (!this.enabled) return false;
    return this.store.has(this.hash(record, context));
  }

  /** Filter an array, keeping only the first occurrence of each key. */
  filter(records, contextFor = () => ({})) {
    const out = [];
    for (const record of records) {
      if (!this.check(record, contextFor(record)).duplicate) out.push(record);
    }
    return out;
  }

  get stats() {
    return {
      enabled: this.enabled,
      strategy: this.strategy,
      store: this.storeType,
      unique: this.uniqueCount,
      duplicates: this.duplicateCount,
      duplicateRate: this.uniqueCount + this.duplicateCount
        ? +((this.duplicateCount / (this.uniqueCount + this.duplicateCount)) * 100).toFixed(1)
        : 0,
      memoryBytes: this.store instanceof Set ? this.store.size * 44 : this.store.memoryBytes,
    };
  }

  /**
   * Load a previously persisted seen-set (enables incremental runs).
   *
   * A store written under a different key version is refused rather than
   * loaded. Silently accepting it would look like it worked while every record
   * hashed differently and got re-emitted — the exact failure an incremental
   * job is meant to prevent.
   *
   * @returns {Promise<number>} entries loaded; 0 when absent or incompatible.
   */
  async load(file = this.persistPath) {
    if (!file) return 0;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);

      const version = data.keyVersion ?? 1;
      if (version !== KEY_VERSION) {
        this.incompatibleStore = {
          path: file, found: version, expected: KEY_VERSION,
          message:
            `The de-duplication store at ${file} was written by an older version ` +
            '(record hashing changed so that `case_sensitive` and `trim_whitespace` ' +
            'are honoured). It was ignored, so records seen previously may be ' +
            'emitted again. Delete the file to silence this.',
        };
        return 0;
      }

      if (data.store === 'bloom' && this.store instanceof BloomFilter) {
        this.store.buffer = Uint8Array.from(Buffer.from(data.buffer, 'base64'));
        this.store.bits = data.bits;
        this.store.hashCount = data.hashCount;
        this.store.count = data.count ?? 0;
        return this.store.count;
      }
      if (Array.isArray(data.hashes) && this.store instanceof Set) {
        for (const h of data.hashes) this.store.add(h);
        return data.hashes.length;
      }
      return 0;
    } catch {
      // No prior state is the normal case on a first run.
      return 0;
    }
  }

  async save(file = this.persistPath) {
    if (!file) return false;
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });

    const payload = this.store instanceof BloomFilter
      ? {
          store: 'bloom',
          bits: this.store.bits,
          hashCount: this.store.hashCount,
          count: this.store.count,
          buffer: Buffer.from(this.store.buffer).toString('base64'),
        }
      : { store: 'set', hashes: [...this.store] };

    payload.savedAt = new Date().toISOString();
    payload.strategy = this.strategy;
    payload.keyVersion = KEY_VERSION;

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, file);
    return true;
  }

  clear() {
    if (this.store instanceof Set) this.store.clear();
    else this.store = new BloomFilter();
    this.seenCount = 0;
    this.duplicateCount = 0;
    this.uniqueCount = 0;
  }
}

/** Read `a.b.c` out of a record, for `keyFields`. */
function getField(record, field) {
  if (record == null) return undefined;
  if (!field.includes('.')) return record[field];
  return field.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), record);
}

export function createDeduplicator(options) {
  return new Deduplicator(options);
}
