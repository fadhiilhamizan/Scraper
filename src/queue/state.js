/**
 * Run checkpointing.
 *
 * A crawl that dies at hour three should not restart at hour zero. The state
 * file holds the frontier snapshot, the completed set, cookies and counters;
 * `harvest run --resume` reloads it and carries on.
 *
 * Writes are atomic (temp file + rename) so a crash *during* a checkpoint can't
 * leave a corrupt state file — the worst case is losing the last interval.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const STATE_VERSION = 1;

export class RunState {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=false]
   * @param {string}  [options.path='.harvester/state.json']
   * @param {number}  [options.intervalMs=10000]
   * @param {object}  [options.logger]
   */
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    // The recipe key is `resume.state_path`; `path` is accepted too.
    this.path = options.statePath ?? options.path ?? path.join('.harvester', 'state.json');
    this.intervalMs = options.intervalMs ?? 10_000;
    this.logger = options.logger ?? null;

    this.timer = null;
    this.saving = null;
    this.lastSavedAt = 0;
    this.saveCount = 0;
    this.dirty = false;
  }

  /**
   * A fingerprint of the parts of the config that determine what gets scraped.
   * Resuming with a *different* recipe would silently mix incompatible data, so
   * a mismatch is refused.
   */
  static fingerprint(config) {
    const relevant = {
      startUrls: config.startUrls?.map((s) => s.url).sort(),
      extract: config.extract,
      crawl: {
        follow: config.crawl?.follow,
        allowedDomains: [...(config.crawl?.allowedDomains ?? [])].sort(),
        allowPatterns: config.crawl?.allowPatterns,
        denyPatterns: config.crawl?.denyPatterns,
        maxDepth: config.crawl?.maxDepth,
        pagination: config.crawl?.pagination,
      },
    };
    return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
  }

  /**
   * Read a checkpoint.
   * @returns {Promise<object|null>} null when absent or unreadable.
   */
  async load() {
    if (!this.enabled) return null;
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const state = JSON.parse(raw);
      if (state.version !== STATE_VERSION) {
        this.logger?.warn('checkpoint has an incompatible version — starting fresh', {
          found: state.version, expected: STATE_VERSION,
        });
        return null;
      }
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn('could not read checkpoint — starting fresh', { path: this.path, error: error.message });
      }
      return null;
    }
  }

  /**
   * Validate a loaded checkpoint against the current run.
   * @returns {{ok:boolean, reason?:string}}
   */
  verify(state, config) {
    if (!state) return { ok: false, reason: 'no_checkpoint' };
    const expected = RunState.fingerprint(config);
    if (state.fingerprint !== expected) {
      return {
        ok: false,
        reason:
          'The checkpoint was written by a different recipe (start URLs, extraction or crawl rules changed). ' +
          'Delete the state file or run without --resume to start over.',
      };
    }
    return { ok: true };
  }

  /**
   * Write a checkpoint atomically.
   * @param {object} snapshot `{frontier, cookies, stats, dedupe}`
   */
  async save(snapshot, config) {
    if (!this.enabled) return false;
    // Serialise saves so the interval timer can't overlap a manual save.
    if (this.saving) await this.saving;

    this.saving = (async () => {
      const payload = {
        version: STATE_VERSION,
        fingerprint: RunState.fingerprint(config),
        savedAt: new Date().toISOString(),
        runName: config.name,
        ...snapshot,
      };

      const target = path.resolve(this.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
        await fs.rename(tmp, target);
        this.lastSavedAt = Date.now();
        this.saveCount += 1;
        this.dirty = false;
        return true;
      } catch (error) {
        this.logger?.error('checkpoint write failed', { path: target, error: error.message });
        await fs.unlink(tmp).catch(() => {});
        return false;
      }
    })();

    try {
      return await this.saving;
    } finally {
      this.saving = null;
    }
  }

  /** Start periodic checkpointing. `getSnapshot` is called on each tick. */
  start(getSnapshot, config) {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      Promise.resolve(getSnapshot())
        .then((snapshot) => this.save(snapshot, config))
        .catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Remove the checkpoint — called after a clean, complete run. */
  async clear() {
    this.stop();
    try {
      await fs.unlink(path.resolve(this.path));
      return true;
    } catch {
      return false;
    }
  }
}

export function createRunState(options) {
  return new RunState(options);
}
