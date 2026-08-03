/**
 * Proxy pool with health tracking.
 *
 * Rotation alone is not enough — dead or burned proxies must drop out of the
 * pool, otherwise every rotation has a growing chance of landing on a broken
 * exit. Each proxy therefore carries a score; repeated failures bench it
 * temporarily, and it is probed again after a cooldown.
 */

import { maskUrlCredentials } from '../observability/logger.js';

/**
 * @typedef {object} ProxyEntry
 * @property {string} url        Full proxy URL (http://user:pass@host:port).
 * @property {string} protocol
 * @property {number} successes
 * @property {number} failures
 * @property {number} benchedUntil
 */

function parseProxy(input) {
  if (!input) return null;
  const raw = typeof input === 'string' ? input : input.url;
  if (!raw) return null;

  let normalized = raw.trim();
  // Accept bare `host:port` and `user:pass@host:port` shorthand.
  if (!/^[a-z0-9]+:\/\//i.test(normalized)) normalized = `http://${normalized}`;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  return {
    url: parsed.toString().replace(/\/$/, ''),
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    username: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    label: typeof input === 'object' ? input.label : undefined,
    country: typeof input === 'object' ? input.country : undefined,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    benchedUntil: 0,
    lastUsedAt: 0,
    totalLatencyMs: 0,
  };
}

export class ProxyPool {
  /**
   * @param {object} [options]
   * @param {(string|object)[]} [options.proxies=[]]
   * @param {'round-robin'|'random'|'sticky'|'least-used'} [options.strategy='round-robin']
   * @param {number} [options.maxConsecutiveFailures=3] Before benching.
   * @param {number} [options.benchDurationMs=300000]
   * @param {boolean}[options.removeDead=false]  Permanently drop bad proxies.
   */
  constructor(options = {}) {
    const {
      proxies = [],
      strategy = 'round-robin',
      maxConsecutiveFailures = 3,
      benchDurationMs = 300_000,
      removeDead = false,
    } = options;

    this.strategy = strategy;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.benchDurationMs = benchDurationMs;
    this.removeDead = removeDead;

    this.proxies = proxies.map(parseProxy).filter(Boolean);
    this.index = 0;
    /** @type {Map<string, ProxyEntry>} host -> pinned proxy (sticky strategy) */
    this.hostAssignments = new Map();
  }

  get enabled() {
    return this.proxies.length > 0;
  }

  get size() {
    return this.proxies.length;
  }

  get available() {
    const now = Date.now();
    return this.proxies.filter((p) => p.benchedUntil <= now);
  }

  /**
   * Pick a proxy.
   * @param {string} [host] Used by the `sticky` strategy to keep one exit IP
   *        per domain, which looks like a normal user session.
   * @returns {ProxyEntry|null}
   */
  acquire(host = null) {
    if (!this.enabled) return null;

    let pool = this.available;
    if (pool.length === 0) {
      // Everything is benched — un-bench the least-bad one rather than stall.
      const revived = [...this.proxies].sort((a, b) => a.benchedUntil - b.benchedUntil)[0];
      revived.benchedUntil = 0;
      revived.consecutiveFailures = 0;
      pool = [revived];
    }

    let chosen;
    switch (this.strategy) {
      case 'random':
        chosen = pool[Math.floor(Math.random() * pool.length)];
        break;
      case 'sticky': {
        if (host) {
          const pinned = this.hostAssignments.get(host);
          if (pinned && pinned.benchedUntil <= Date.now()) {
            chosen = pinned;
          } else {
            chosen = pool[Math.floor(Math.random() * pool.length)];
            this.hostAssignments.set(host, chosen);
          }
        } else {
          chosen = pool[Math.floor(Math.random() * pool.length)];
        }
        break;
      }
      case 'least-used':
        chosen = pool.reduce((best, p) =>
          p.successes + p.failures < best.successes + best.failures ? p : best,
        );
        break;
      case 'round-robin':
      default:
        chosen = pool[this.index % pool.length];
        this.index = (this.index + 1) % Math.max(pool.length, 1);
        break;
    }

    chosen.lastUsedAt = Date.now();
    return chosen;
  }

  /** Force a different proxy for `host` (called after a block). */
  rotate(host = null) {
    if (host) this.hostAssignments.delete(host);
    this.index = (this.index + 1) % Math.max(this.proxies.length, 1);
  }

  reportSuccess(proxy, latencyMs = 0) {
    if (!proxy) return;
    proxy.successes += 1;
    proxy.consecutiveFailures = 0;
    proxy.totalLatencyMs += latencyMs;
  }

  reportFailure(proxy, error) {
    if (!proxy) return { benched: false };
    proxy.failures += 1;
    proxy.consecutiveFailures += 1;

    if (proxy.consecutiveFailures >= this.maxConsecutiveFailures) {
      if (this.removeDead) {
        this.proxies = this.proxies.filter((p) => p !== proxy);
        for (const [host, assigned] of this.hostAssignments) {
          if (assigned === proxy) this.hostAssignments.delete(host);
        }
        return { removed: true, proxy: this.describe(proxy) };
      }
      proxy.benchedUntil = Date.now() + this.benchDurationMs;
      for (const [host, assigned] of this.hostAssignments) {
        if (assigned === proxy) this.hostAssignments.delete(host);
      }
      return { benched: true, proxy: this.describe(proxy), until: proxy.benchedUntil, error: error?.message };
    }
    return { benched: false };
  }

  /** Safe-for-logs description — never leaks credentials. */
  describe(proxy) {
    if (!proxy) return null;
    return proxy.label ?? `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  }

  snapshot() {
    return this.proxies.map((p) => ({
      proxy: this.describe(p),
      url: maskUrlCredentials(p.url),
      successes: p.successes,
      failures: p.failures,
      benched: p.benchedUntil > Date.now(),
      avgLatencyMs: p.successes ? Math.round(p.totalLatencyMs / p.successes) : 0,
    }));
  }

  /** Load a newline-separated proxy list (`# comments` allowed). */
  static fromList(text, options = {}) {
    const proxies = String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    return new ProxyPool({ ...options, proxies });
  }
}
