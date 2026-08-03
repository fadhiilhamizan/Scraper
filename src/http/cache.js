/**
 * On-disk HTTP response cache.
 *
 * Two jobs, both about being a good citizen:
 *   - While you iterate on selectors you re-parse the same pages dozens of
 *     times. The cache means the target server sees one request, not thirty.
 *   - A crashed run can resume without re-fetching everything.
 *
 * Entries are stored as `<sha1>.json` under the cache directory, sharded two
 * levels deep so a large crawl doesn't put 100k files in one folder.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class HttpCache {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=false]
   * @param {string}  [options.dir='.harvester/cache']
   * @param {number}  [options.ttlMs=86400000]  24h default.
   * @param {number[]}[options.cacheableStatuses=[200,203,300,301,404,410]]
   * @param {boolean} [options.respectCacheControl=true] Honour `no-store`.
   */
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.dir = options.dir ?? path.join('.harvester', 'cache');
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.cacheableStatuses = new Set(options.cacheableStatuses ?? [200, 203, 300, 301, 404, 410]);
    this.respectCacheControl = options.respectCacheControl !== false;
    this.maxEntryBytes = options.maxEntryBytes ?? 10 * 1024 * 1024;

    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.#ready = null;
  }

  #ready;

  async #ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  async init() {
    if (!this.enabled) return;
    this.#ready ??= this.#ensureDir(this.dir);
    await this.#ready;
  }

  key({ url, method = 'GET', body = null, vary = null }) {
    const hash = createHash('sha1');
    hash.update(method.toUpperCase());
    hash.update('\0');
    hash.update(url);
    if (body) hash.update(`\0${typeof body === 'string' ? body : JSON.stringify(body)}`);
    if (vary) hash.update(`\0${vary}`);
    return hash.digest('hex');
  }

  #pathFor(key) {
    return path.join(this.dir, key.slice(0, 2), key.slice(2, 4), `${key}.json`);
  }

  /**
   * @returns {Promise<null | {status:number, headers:object, body:string, url:string, cachedAt:number}>}
   */
  async get(request) {
    if (!this.enabled) return null;
    await this.init();

    const key = this.key(request);
    const file = this.#pathFor(key);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const entry = JSON.parse(raw);

      const age = Date.now() - entry.cachedAt;
      const ttl = entry.ttlMs ?? this.ttlMs;
      if (ttl > 0 && age > ttl) {
        this.misses += 1;
        // Stale — drop it so the directory doesn't grow without bound.
        fs.unlink(file).catch(() => {});
        return null;
      }

      this.hits += 1;
      return { ...entry, fromCache: true, ageMs: age };
    } catch {
      this.misses += 1;
      return null;
    }
  }

  async set(request, response) {
    if (!this.enabled) return false;
    if (!this.cacheableStatuses.has(response.status)) return false;
    if (typeof response.body === 'string' && Buffer.byteLength(response.body) > this.maxEntryBytes) return false;

    if (this.respectCacheControl) {
      const cc = String(response.headers?.['cache-control'] ?? '');
      if (/no-store|private/i.test(cc)) return false;
    }

    await this.init();
    const key = this.key(request);
    const file = this.#pathFor(key);

    const entry = {
      key,
      url: response.url ?? request.url,
      requestUrl: request.url,
      method: (request.method ?? 'GET').toUpperCase(),
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      contentType: response.contentType,
      cachedAt: Date.now(),
      ttlMs: this.ttlMs,
    };

    try {
      await this.#ensureDir(path.dirname(file));
      // Write-then-rename keeps readers from seeing a half-written entry.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
      await fs.rename(tmp, file);
      this.writes += 1;
      return true;
    } catch {
      return false;
    }
  }

  async clear() {
    try {
      await fs.rm(this.dir, { recursive: true, force: true });
    } catch { /* nothing to clear */ }
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
  }

  /** Remove entries older than `ttlMs`. Safe to call between runs. */
  async prune() {
    if (!this.enabled) return 0;
    let removed = 0;
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith('.json')) {
          try {
            const stat = await fs.stat(full);
            if (Date.now() - stat.mtimeMs > this.ttlMs) {
              await fs.unlink(full);
              removed += 1;
            }
          } catch { /* raced with another pruner */ }
        }
      }
    };
    await walk(this.dir);
    return removed;
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      hitRate: total ? +((this.hits / total) * 100).toFixed(1) : 0,
    };
  }
}
