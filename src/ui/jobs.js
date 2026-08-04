/**
 * Run manager for the web UI.
 *
 * Runs scrapes in-process rather than spawning the CLI, which means the UI can
 * subscribe directly to `item` events and the logger — live records and live
 * logs without parsing stdout.
 *
 * Each run gets a directory under `.harvester/ui/runs/<id>/` holding an NDJSON
 * copy of everything extracted plus the final report, so results survive a
 * browser refresh and a server restart.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Scraper } from '../core/scraper.js';
import { Logger } from '../observability/logger.js';

/** How many records and log lines to keep in memory for late subscribers. */
const ITEM_BUFFER = 500;
const LOG_BUFFER = 400;

/**
 * One scrape, with its live state.
 * @typedef {object} Job
 * @property {string} id
 * @property {'starting'|'running'|'stopping'|'done'|'failed'|'stopped'} status
 */
export class Job extends EventEmitter {
  constructor({ id, name, config, hooks, dir }) {
    super();
    this.id = id;
    this.name = name;
    this.config = config;
    this.hooks = hooks ?? {};
    this.dir = dir;

    this.status = 'starting';
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.error = null;
    this.report = null;

    /** Recent records, for the live table. */
    this.items = [];
    this.itemCount = 0;
    /** Recent log lines. */
    this.logs = [];
    this.stats = {
      queued: 0, inFlight: 0, completed: 0, failed: 0, skipped: 0,
      items: 0, rps: 0, rendered: 0, cached: 0,
    };

    this.scraper = null;
    this.dataPath = path.join(dir, 'data.ndjson');
  }

  get durationMs() {
    return (this.finishedAt ?? Date.now()) - this.startedAt;
  }

  /** A compact shape for the runs list. */
  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null,
      durationMs: this.durationMs,
      items: this.itemCount,
      pages: this.stats.completed,
      failed: this.stats.failed,
      error: this.error,
    };
  }

  /** Everything a freshly-connected client needs to render the run. */
  snapshot() {
    return {
      ...this.summary(),
      stats: this.stats,
      items: this.items,
      logs: this.logs,
      report: this.report,
      startUrls: this.config.startUrls?.map((s) => s.url) ?? [],
    };
  }

  #pushLog(record) {
    this.logs.push(record);
    if (this.logs.length > LOG_BUFFER) this.logs.shift();
    this.emit('log', record);
  }

  #pushItem(item) {
    this.itemCount += 1;
    this.items.push(item);
    if (this.items.length > ITEM_BUFFER) this.items.shift();
    this.emit('item', item);
  }

  #setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });

    // Always keep a private NDJSON copy so the UI can offer downloads and
    // survive a refresh, regardless of what the recipe writes.
    const config = {
      ...this.config,
      output: [...(this.config.output ?? []), { path: this.dataPath, format: 'ndjson' }],
      logging: { ...this.config.logging, progress: false },
    };

    const logger = new Logger({
      level: config.logging?.level ?? 'info',
      format: 'json',
      write: (line) => {
        try {
          this.#pushLog(JSON.parse(line));
        } catch {
          this.#pushLog({ time: new Date().toISOString(), level: 'info', msg: line });
        }
      },
    });

    this.scraper = new Scraper(config, { hooks: this.hooks, logger });
    this.#setStatus('running');

    this.scraper.on('item', (item) => this.#pushItem(item));

    // Poll rather than emitting per-request: at 500 req/s an event per request
    // would flood the SSE stream and the browser.
    const ticker = setInterval(() => this.#sampleStats(), 400);
    ticker.unref?.();

    try {
      const report = await this.scraper.run();
      this.report = report;
      this.#sampleStats();
      this.#setStatus(this.status === 'stopping' ? 'stopped' : 'done');
      await this.#persist();
    } catch (error) {
      this.error = error.message;
      this.report = this.scraper.report ?? null;
      this.#setStatus('failed');
      this.#pushLog({ time: new Date().toISOString(), level: 'error', msg: error.message });
      await this.#persist().catch(() => {});
    } finally {
      clearInterval(ticker);
      this.finishedAt = Date.now();
      this.emit('end', this.summary());
    }
    return this.report;
  }

  #sampleStats() {
    if (!this.scraper) return;
    const frontier = this.scraper.frontier.stats;
    const counters = this.scraper.counters;
    const elapsedSec = Math.max(this.durationMs / 1000, 0.001);

    this.stats = {
      queued: frontier.queued,
      inFlight: frontier.inFlight,
      completed: counters.pagesOk,
      failed: counters.pagesFailed,
      skipped: counters.pagesSkipped,
      rendered: counters.pagesRendered,
      cached: counters.pagesFromCache,
      items: counters.itemsWritten,
      duplicates: counters.itemsDuplicate,
      invalid: counters.itemsInvalid,
      rps: +((counters.pagesOk + counters.pagesFailed) / elapsedSec).toFixed(2),
    };
    this.emit('stats', this.stats);
  }

  async #persist() {
    await fs.writeFile(
      path.join(this.dir, 'run.json'),
      JSON.stringify({ ...this.summary(), report: this.report, stats: this.stats }, null, 2),
      'utf8',
    );
  }

  stop() {
    if (!this.scraper || this.status !== 'running') return false;
    this.#setStatus('stopping');
    this.scraper.stop('stopped from the web interface');
    return true;
  }

  abort() {
    if (!this.scraper) return false;
    this.#setStatus('stopping');
    this.scraper.abort('aborted from the web interface');
    return true;
  }
}

export class JobManager {
  /**
   * @param {object} [options]
   * @param {string} [options.dir='.harvester/ui/runs']
   * @param {number} [options.keep=50] How many finished runs to retain.
   */
  constructor(options = {}) {
    this.dir = options.dir ?? path.join('.harvester', 'ui', 'runs');
    this.keep = options.keep ?? 50;
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
  }

  /** Reload finished runs from disk so history survives a restart. */
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    let entries;
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, entry.name, 'run.json'), 'utf8');
        const saved = JSON.parse(raw);
        this.jobs.set(saved.id, {
          ...saved,
          persisted: true,
          dir: path.join(this.dir, entry.name),
          dataPath: path.join(this.dir, entry.name, 'data.ndjson'),
          summary: () => saved,
          snapshot: () => ({ ...saved, items: [], logs: [], stats: saved.stats ?? {} }),
        });
      } catch {
        // A half-written run directory is not worth failing startup over.
      }
    }
  }

  /**
   * @param {object} params `{ name, config, hooks }`
   * @returns {Job}
   */
  create({ name, config, hooks }) {
    const id = randomUUID().slice(0, 8);
    const job = new Job({ id, name, config, hooks, dir: path.join(this.dir, id) });
    this.jobs.set(id, job);

    // Fire and forget — the caller subscribes to events for progress.
    job.start().catch(() => {});

    this.#evict();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()]
      .map((job) => job.summary())
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  get running() {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'starting');
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') job.abort?.();
    this.jobs.delete(id);
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  /** Drop the oldest finished runs beyond `keep`. */
  #evict() {
    const finished = [...this.jobs.values()]
      .filter((j) => !['running', 'starting', 'stopping'].includes(j.status))
      .sort((a, b) => new Date(a.summary().startedAt) - new Date(b.summary().startedAt));

    while (finished.length > this.keep) {
      const oldest = finished.shift();
      this.jobs.delete(oldest.id);
      fs.rm(oldest.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Stop everything — called on server shutdown. */
  stopAll() {
    for (const job of this.running) job.stop?.();
  }
}
