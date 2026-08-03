/**
 * The URL frontier: what to fetch, in what order, and what already happened.
 *
 * Design notes
 * ------------
 * - Requests are held in **per-host buckets**. The scheduler pulls round-robin
 *   across hosts so one slow domain can't starve the rest, and so per-host
 *   politeness delays overlap with useful work elsewhere.
 * - Each bucket is a priority queue (binary heap). Lower `priority` wins;
 *   ties break on insertion order so a given priority stays FIFO.
 * - `seen` holds canonical URLs. It is the single source of truth for
 *   "have we queued this already", and is what gets checkpointed for resume.
 */

import { canonicalizeUrl, getHostname } from './urlutils.js';

/** Binary min-heap keyed on (priority, sequence). */
class PriorityQueue {
  #heap = [];
  #seq = 0;

  get size() {
    return this.#heap.length;
  }

  push(item, priority = 0) {
    const node = { item, priority, seq: this.#seq++ };
    this.#heap.push(node);
    this.#bubbleUp(this.#heap.length - 1);
  }

  pop() {
    if (this.#heap.length === 0) return undefined;
    const top = this.#heap[0];
    const last = this.#heap.pop();
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#bubbleDown(0);
    }
    return top.item;
  }

  peek() {
    return this.#heap[0]?.item;
  }

  #less(a, b) {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.seq < b.seq;
  }

  #bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(this.#heap[i], this.#heap[parent])) break;
      [this.#heap[i], this.#heap[parent]] = [this.#heap[parent], this.#heap[i]];
      i = parent;
    }
  }

  #bubbleDown(i) {
    const n = this.#heap.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.#less(this.#heap[left], this.#heap[smallest])) smallest = left;
      if (right < n && this.#less(this.#heap[right], this.#heap[smallest])) smallest = right;
      if (smallest === i) break;
      [this.#heap[i], this.#heap[smallest]] = [this.#heap[smallest], this.#heap[i]];
      i = smallest;
    }
  }

  toArray() {
    return this.#heap.map((n) => n.item);
  }
}

/**
 * A unit of work.
 * @typedef {object} ScrapeRequest
 * @property {string}  url        Canonical URL to fetch.
 * @property {string}  [label]    Route label, e.g. 'list' or 'detail'.
 * @property {number}  [depth]    Link distance from a start URL.
 * @property {number}  [priority] Lower runs first.
 * @property {string}  [method]
 * @property {object}  [headers]
 * @property {any}     [body]
 * @property {object}  [meta]     Arbitrary data carried to the extractor.
 * @property {string}  [parentUrl]
 * @property {boolean} [render]   Force/skip headless rendering for this URL.
 * @property {number}  [attempts] Retry counter, managed by the engine.
 */

export class Frontier {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPages=Infinity] Hard cap on dequeued requests.
   * @param {object} [options.urlNormalization]  Passed to `canonicalizeUrl`.
   * @param {boolean}[options.dedupe=true]       Skip URLs already seen.
   */
  constructor(options = {}) {
    const { maxPages = Infinity, urlNormalization = {}, dedupe = true } = options;

    this.maxPages = maxPages;
    this.urlNormalization = urlNormalization;
    this.dedupeEnabled = dedupe;

    /** @type {Map<string, PriorityQueue>} host -> queue */
    this.buckets = new Map();
    /** Round-robin cursor over `buckets` keys. */
    this.hostOrder = [];
    this.hostCursor = 0;

    this.seen = new Set();
    this.completed = new Set();
    /** @type {Map<string, {url:string, error:string, attempts:number, status?:number}>} */
    this.failed = new Map();
    /** URLs currently checked out by a worker. */
    this.inFlight = new Map();

    this.queuedCount = 0;
    this.dequeuedCount = 0;
  }

  get size() {
    let total = 0;
    for (const q of this.buckets.values()) total += q.size;
    return total;
  }

  get pendingHosts() {
    return [...this.buckets.keys()];
  }

  get stats() {
    return {
      queued: this.size,
      inFlight: this.inFlight.size,
      completed: this.completed.size,
      failed: this.failed.size,
      seen: this.seen.size,
      dequeued: this.dequeuedCount,
    };
  }

  /** True once the cap is hit — the scheduler stops enqueuing new work. */
  get exhausted() {
    return this.dequeuedCount >= this.maxPages;
  }

  /** True when nothing is queued and nothing is being worked on. */
  get drained() {
    return this.size === 0 && this.inFlight.size === 0;
  }

  /**
   * Add a request.
   * @returns {boolean} false if it was rejected (duplicate, invalid, over cap).
   */
  add(request) {
    const raw = typeof request === 'string' ? { url: request } : { ...request };
    const canonical = canonicalizeUrl(raw.url, this.urlNormalization);
    if (!canonical) return false;

    // A POST to the same URL with a different body is a different resource,
    // so fold method+body into the dedupe key.
    const key = this.#keyFor(canonical, raw);
    if (this.dedupeEnabled && this.seen.has(key)) return false;
    if (this.queuedCount >= this.maxPages) return false;

    this.seen.add(key);

    const entry = {
      url: canonical,
      label: raw.label ?? 'default',
      depth: raw.depth ?? 0,
      priority: raw.priority ?? (raw.depth ?? 0),
      method: (raw.method ?? 'GET').toUpperCase(),
      headers: raw.headers ?? undefined,
      body: raw.body ?? undefined,
      meta: raw.meta ?? {},
      parentUrl: raw.parentUrl ?? null,
      render: raw.render,
      attempts: raw.attempts ?? 0,
      key,
      queuedAt: Date.now(),
    };

    const host = getHostname(canonical) ?? '_unknown';
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = new PriorityQueue();
      this.buckets.set(host, bucket);
      this.hostOrder.push(host);
    }
    bucket.push(entry, entry.priority);
    this.queuedCount += 1;
    return true;
  }

  addMany(requests) {
    let added = 0;
    for (const r of requests) if (this.add(r)) added += 1;
    return added;
  }

  /**
   * Re-queue a request after a failure. Bypasses the `seen` check because the
   * URL is by definition already recorded.
   */
  requeue(request, { priority } = {}) {
    if (this.queuedCount >= this.maxPages * 3) return false; // safety valve
    const host = getHostname(request.url) ?? '_unknown';
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = new PriorityQueue();
      this.buckets.set(host, bucket);
      this.hostOrder.push(host);
    }
    // Retries go to the back so fresh URLs aren't blocked behind a flaky one.
    bucket.push(request, priority ?? (request.priority ?? 0) + 100);
    return true;
  }

  /**
   * Take the next request.
   *
   * @param {(host: string) => boolean} [isHostReady] Predicate letting the
   *        scheduler veto hosts that are rate-limited or circuit-broken.
   * @returns {ScrapeRequest|null}
   */
  next(isHostReady = null) {
    if (this.exhausted) return null;
    if (this.buckets.size === 0) return null;

    // Round-robin across hosts, starting where we left off.
    const hosts = this.hostOrder;
    for (let i = 0; i < hosts.length; i += 1) {
      const idx = (this.hostCursor + i) % hosts.length;
      const host = hosts[idx];
      const bucket = this.buckets.get(host);
      if (!bucket || bucket.size === 0) continue;
      if (isHostReady && !isHostReady(host)) continue;

      const entry = bucket.pop();
      this.hostCursor = (idx + 1) % hosts.length;
      if (bucket.size === 0) this.#dropHost(host);

      this.dequeuedCount += 1;
      this.inFlight.set(entry.key, entry);
      return entry;
    }
    return null;
  }

  /** True if at least one host has work, ignoring readiness. */
  hasWork() {
    return this.size > 0;
  }

  markCompleted(request) {
    this.inFlight.delete(request.key);
    this.completed.add(request.key);
    this.failed.delete(request.key);
  }

  markFailed(request, error) {
    this.inFlight.delete(request.key);
    this.failed.set(request.key, {
      url: request.url,
      label: request.label,
      error: error?.message ?? String(error),
      code: error?.code,
      status: error?.status,
      attempts: request.attempts ?? 0,
      failedAt: new Date().toISOString(),
    });
  }

  /** Release an in-flight request without recording an outcome (used on retry). */
  release(request) {
    this.inFlight.delete(request.key);
  }

  #dropHost(host) {
    this.buckets.delete(host);
    const idx = this.hostOrder.indexOf(host);
    if (idx !== -1) {
      this.hostOrder.splice(idx, 1);
      if (this.hostCursor > idx) this.hostCursor -= 1;
      if (this.hostOrder.length === 0) this.hostCursor = 0;
      else this.hostCursor %= this.hostOrder.length;
    }
  }

  #keyFor(canonical, raw) {
    const method = (raw.method ?? 'GET').toUpperCase();
    if (method === 'GET' && !raw.body) return canonical;
    const body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body ?? null);
    return `${method} ${canonical} ${body}`;
  }

  /** Snapshot for the resume checkpoint. */
  serialize() {
    const pending = [];
    for (const bucket of this.buckets.values()) pending.push(...bucket.toArray());
    // In-flight work was interrupted — treat it as pending on resume.
    pending.push(...this.inFlight.values());
    return {
      pending,
      completed: [...this.completed],
      failed: [...this.failed.entries()],
      queuedCount: this.queuedCount,
      dequeuedCount: this.dequeuedCount,
    };
  }

  /** Restore from a checkpoint produced by `serialize()`. */
  restore(snapshot) {
    if (!snapshot) return;
    this.completed = new Set(snapshot.completed ?? []);
    this.failed = new Map(snapshot.failed ?? []);
    this.dequeuedCount = snapshot.dequeuedCount ?? 0;
    this.queuedCount = 0;
    this.seen = new Set(this.completed);

    for (const entry of snapshot.pending ?? []) {
      // `add` re-canonicalises and re-checks the seen set, so completed URLs
      // are dropped automatically and we never redo finished work.
      this.add(entry);
    }
  }
}
