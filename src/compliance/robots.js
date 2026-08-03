/**
 * robots.txt parser and enforcement.
 *
 * Implements the rules from RFC 9309 (the 2022 standardisation of the Robots
 * Exclusion Protocol), including the parts people usually skip:
 *
 *  - **Most-specific match wins.** `Allow: /a/b` beats `Disallow: /a` because it
 *    is longer, regardless of file order. Equal-length conflicts resolve to
 *    Allow.
 *  - **Wildcards.** `*` matches any run of characters, `$` anchors the end.
 *  - **Group selection.** The most specific matching `User-agent` group is used;
 *    `*` is only the fallback. Multiple `User-agent` lines share one group.
 *  - **Status handling.** 4xx means "no restrictions"; 5xx or a fetch failure
 *    means "treat the whole site as disallowed" until it can be read, because
 *    guessing in the permissive direction is the unsafe guess.
 */

import { getOrigin, getHostname } from '../queue/urlutils.js';

/** Turn a robots path pattern into an anchored RegExp. */
function patternToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      source += '.*';
    } else if (ch === '$' && i === pattern.length - 1) {
      source += '$';
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}`);
}

class RuleGroup {
  constructor(agents) {
    this.agents = agents;
    /** @type {{type:'allow'|'disallow', path:string, regex:RegExp, length:number}[]} */
    this.rules = [];
    this.crawlDelay = null;
    this.requestRate = null;
  }

  addRule(type, path) {
    if (typeof path !== 'string') return;
    const trimmed = path.trim();
    // `Disallow:` with an empty value means "allow everything" — no rule at all.
    if (type === 'disallow' && trimmed === '') return;
    const normalized = trimmed.startsWith('/') || trimmed.startsWith('*') ? trimmed : `/${trimmed}`;
    this.rules.push({
      type,
      path: normalized,
      regex: patternToRegExp(normalized),
      // Length for specificity excludes the wildcard metacharacters.
      length: normalized.replace(/[*$]/g, '').length,
    });
  }

  /** @returns {{allowed:boolean, rule:object|null}} */
  evaluate(pathWithQuery) {
    let best = null;
    for (const rule of this.rules) {
      if (!rule.regex.test(pathWithQuery)) continue;
      if (
        !best ||
        rule.length > best.length ||
        // Equal specificity: Allow wins (RFC 9309 §2.2.2).
        (rule.length === best.length && rule.type === 'allow' && best.type === 'disallow')
      ) {
        best = rule;
      }
    }
    return { allowed: !best || best.type === 'allow', rule: best };
  }
}

export class RobotsTxt {
  constructor({ groups = [], sitemaps = [], host = null, raw = '', status = 200 } = {}) {
    this.groups = groups;
    this.sitemaps = sitemaps;
    this.host = host;
    this.raw = raw;
    this.status = status;
    this.fetchedAt = Date.now();
  }

  /** A robots.txt that permits everything (used for 404 / 4xx responses). */
  static allowAll(meta = {}) {
    return new RobotsTxt({ ...meta, groups: [] });
  }

  /** A robots.txt that forbids everything (used for 5xx / unreachable). */
  static denyAll(meta = {}) {
    const group = new RuleGroup(['*']);
    group.addRule('disallow', '/');
    return new RobotsTxt({ ...meta, groups: [group] });
  }

  static parse(text, meta = {}) {
    const groups = [];
    const sitemaps = [];

    let current = null;
    let expectingAgent = false;

    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;

      const sep = line.indexOf(':');
      if (sep === -1) continue;

      const field = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();

      switch (field) {
        case 'user-agent': {
          const agent = value.toLowerCase();
          if (expectingAgent && current) {
            // Consecutive User-agent lines join the same group.
            current.agents.push(agent);
          } else {
            current = new RuleGroup([agent]);
            groups.push(current);
            expectingAgent = true;
          }
          break;
        }
        case 'allow':
        case 'disallow':
          if (!current) {
            // Rules before any User-agent line: treat as the wildcard group.
            current = new RuleGroup(['*']);
            groups.push(current);
          }
          expectingAgent = false;
          current.addRule(field, value);
          break;
        case 'crawl-delay': {
          const delay = Number.parseFloat(value);
          if (current && Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
          expectingAgent = false;
          break;
        }
        case 'request-rate':
          if (current) current.requestRate = value;
          expectingAgent = false;
          break;
        case 'sitemap': {
          try {
            sitemaps.push(new URL(value).toString());
          } catch { /* relative or malformed Sitemap lines are ignored */ }
          break;
        }
        default:
          expectingAgent = false;
          break;
      }
    }

    return new RobotsTxt({ ...meta, groups, sitemaps, raw: String(text) });
  }

  /**
   * Find the group that applies to `userAgent`.
   * Longest matching token wins; `*` is the fallback.
   */
  groupFor(userAgent) {
    const ua = String(userAgent ?? '*').toLowerCase();
    let best = null;
    let bestLength = -1;
    let wildcard = null;

    for (const group of this.groups) {
      for (const agent of group.agents) {
        if (agent === '*') {
          wildcard ??= group;
          continue;
        }
        if (ua.includes(agent) && agent.length > bestLength) {
          best = group;
          bestLength = agent.length;
        }
      }
    }
    return best ?? wildcard ?? null;
  }

  /** @returns {{allowed:boolean, reason:string, rule:object|null}} */
  check(url, userAgent = '*') {
    const group = this.groupFor(userAgent);
    if (!group) return { allowed: true, reason: 'no_matching_group', rule: null };

    let target;
    try {
      const parsed = new URL(url);
      target = parsed.pathname + parsed.search;
    } catch {
      return { allowed: true, reason: 'unparseable_url', rule: null };
    }

    const { allowed, rule } = group.evaluate(target);
    return {
      allowed,
      reason: rule ? `${rule.type}:${rule.path}` : 'no_matching_rule',
      rule,
    };
  }

  crawlDelayFor(userAgent = '*') {
    return this.groupFor(userAgent)?.crawlDelay ?? null;
  }
}

/**
 * Fetches, caches and applies robots.txt per origin.
 */
export class RobotsManager {
  /**
   * @param {object} options
   * @param {import('../http/client.js').HttpClient} options.httpClient
   * @param {string}  [options.userAgent='*']
   * @param {boolean} [options.enabled=true]  Turning this off is a deliberate act.
   * @param {boolean} [options.respectCrawlDelay=true]
   * @param {number}  [options.cacheTtlMs=3600000]
   * @param {'deny'|'allow'} [options.onFetchError='deny']
   */
  constructor(options = {}) {
    this.httpClient = options.httpClient;
    this.userAgent = options.userAgent ?? '*';
    this.enabled = options.enabled !== false;
    this.respectCrawlDelay = options.respectCrawlDelay !== false;
    this.cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1000;
    this.onFetchError = options.onFetchError ?? 'deny';
    this.logger = options.logger ?? null;

    /** @type {Map<string, RobotsTxt>} origin -> parsed robots */
    this.cache = new Map();
    /** In-flight fetches, so 20 workers hitting a new host cause one request. */
    this.inflight = new Map();

    this.stats = { fetched: 0, allowed: 0, blocked: 0, errors: 0 };
  }

  async #load(origin) {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return cached;

    const existing = this.inflight.get(origin);
    if (existing) return existing;

    const promise = (async () => {
      const url = `${origin}/robots.txt`;
      try {
        const response = await this.httpClient.request({
          url,
          method: 'GET',
          headers: { 'user-agent': this.userAgent, accept: 'text/plain,*/*;q=0.8' },
          timeoutMs: 10_000,
          maxRedirects: 3,
          maxResponseBytes: 512 * 1024, // RFC 9309 suggests honouring at least 500 KiB
          throwOnError: false,
        });

        this.stats.fetched += 1;
        const meta = { host: getHostname(origin), status: response.status };

        let robots;
        if (response.status >= 200 && response.status < 300) {
          robots = RobotsTxt.parse(response.body, meta);
        } else if (response.status >= 400 && response.status < 500) {
          // "Unavailable" means no restrictions.
          robots = RobotsTxt.allowAll(meta);
        } else {
          // 5xx: the site is telling us it can't answer. Assume the strict reading.
          robots = this.onFetchError === 'allow' ? RobotsTxt.allowAll(meta) : RobotsTxt.denyAll(meta);
          this.logger?.warn('robots.txt unavailable — applying fail-closed policy', {
            origin, status: response.status, policy: this.onFetchError,
          });
        }

        this.cache.set(origin, robots);
        return robots;
      } catch (error) {
        this.stats.errors += 1;
        const robots = this.onFetchError === 'allow'
          ? RobotsTxt.allowAll({ host: getHostname(origin), status: 0 })
          : RobotsTxt.denyAll({ host: getHostname(origin), status: 0 });
        this.logger?.warn('robots.txt fetch failed', {
          origin, error: error.message, policy: this.onFetchError,
        });
        this.cache.set(origin, robots);
        return robots;
      } finally {
        this.inflight.delete(origin);
      }
    })();

    this.inflight.set(origin, promise);
    return promise;
  }

  /**
   * @returns {Promise<{allowed:boolean, reason:string, crawlDelay:number|null}>}
   */
  async check(url) {
    if (!this.enabled) return { allowed: true, reason: 'robots_disabled', crawlDelay: null };

    const origin = getOrigin(url);
    if (!origin) return { allowed: false, reason: 'invalid_url', crawlDelay: null };

    const robots = await this.#load(origin);
    const verdict = robots.check(url, this.userAgent);
    const crawlDelay = this.respectCrawlDelay ? robots.crawlDelayFor(this.userAgent) : null;

    if (verdict.allowed) this.stats.allowed += 1;
    else this.stats.blocked += 1;

    return { ...verdict, crawlDelay, sitemaps: robots.sitemaps };
  }

  async sitemapsFor(url) {
    if (!this.enabled) return [];
    const origin = getOrigin(url);
    if (!origin) return [];
    const robots = await this.#load(origin);
    return robots.sitemaps;
  }

  async crawlDelayFor(url) {
    if (!this.enabled || !this.respectCrawlDelay) return null;
    const origin = getOrigin(url);
    if (!origin) return null;
    const robots = await this.#load(origin);
    return robots.crawlDelayFor(this.userAgent);
  }
}
