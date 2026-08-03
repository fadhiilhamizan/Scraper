/**
 * URL canonicalisation and matching.
 *
 * Canonicalisation matters more than it looks: it is what stops a crawl from
 * fetching `?utm_source=…` variants of the same page a hundred times, and it
 * is the key the de-duplicator and the resume checkpoint agree on.
 */

/** Query parameters that never change the content served. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'twclid', 'igshid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', '_ga', '_gl', 'yclid', 'wbraid', 'gbraid', 'ttclid',
  'campaign_id', 'ad_id', 'adset_id', 'pk_campaign', 'pk_kwd', 'piwik_campaign',
]);

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ftp:': '21' };

/**
 * Produce a stable, comparable form of a URL.
 *
 * @param {string} input
 * @param {object} [options]
 * @param {string} [options.base]                 Base URL for relative links.
 * @param {boolean} [options.stripTracking=true]  Drop known analytics params.
 * @param {boolean} [options.stripFragment=true]  Drop `#hash`.
 * @param {boolean} [options.sortQuery=true]      Sort query params alphabetically.
 * @param {boolean} [options.stripWww=false]      Treat `www.x.com` as `x.com`.
 * @param {boolean} [options.lowercasePath=false] Lowercase the path (unsafe on
 *                                                case-sensitive servers).
 * @param {string[]} [options.stripParams=[]]     Extra params to remove.
 * @param {string[]} [options.keepParams=null]    Allow-list; everything else goes.
 * @returns {string|null} canonical URL, or null if unparseable / unsupported scheme.
 */
export function canonicalizeUrl(input, options = {}) {
  const {
    base,
    stripTracking = true,
    stripFragment = true,
    sortQuery = true,
    stripWww = false,
    lowercasePath = false,
    stripParams = [],
    keepParams = null,
  } = options;

  if (typeof input !== 'string' || input.trim() === '') return null;

  let url;
  try {
    url = new URL(input.trim(), base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (stripWww && url.hostname.startsWith('www.')) url.hostname = url.hostname.slice(4);
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = '';
  if (stripFragment) url.hash = '';
  if (lowercasePath) url.pathname = url.pathname.toLowerCase();

  // Collapse duplicate slashes but never touch the leading `//` of a protocol.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  // `/path/` and `/path` are usually the same document; normalise to no trailing
  // slash except for the site root.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const params = url.searchParams;
  const removals = [];
  for (const key of params.keys()) {
    if (keepParams && !keepParams.includes(key)) removals.push(key);
    else if (stripTracking && TRACKING_PARAMS.has(key.toLowerCase())) removals.push(key);
    else if (stripParams.includes(key)) removals.push(key);
  }
  for (const key of new Set(removals)) params.delete(key);

  if (sortQuery) params.sort();
  // Re-serialise so `?` disappears when the query is now empty.
  url.search = params.toString() ? `?${params.toString()}` : '';

  return url.toString();
}

/** Resolve a possibly-relative href against a page URL. Returns null if invalid. */
export function resolveUrl(href, baseUrl) {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Skip in-page and non-navigational schemes early.
  if (/^(javascript|mailto|tel|data|blob|about|sms|ftp|file):/i.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Does `hostname` belong to `domain`, including subdomains?
 * `isSameDomain('shop.example.com', 'example.com') === true`
 */
export function isSameDomain(hostname, domain) {
  if (!hostname || !domain) return false;
  const h = hostname.toLowerCase().replace(/^www\./, '');
  const d = domain.toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith(`.${d}`);
}

/** Compile a pattern that may be a glob (`*.html`) or a `/regex/flags` literal. */
export function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== 'string') return null;

  const regexLiteral = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
  if (regexLiteral) return new RegExp(regexLiteral[1], regexLiteral[2]);

  if (pattern.includes('*') || pattern.includes('?')) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  }

  // Bare string: treat as a regex so `\.pdf$` and `/product/` both work.
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

export function matchesAny(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => {
    const re = compilePattern(p);
    return re ? re.test(url) : false;
  });
}

/** Approximate "depth" of a URL path — used to bias breadth-first crawls. */
export function pathDepth(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Human-friendly shortening for log lines and progress output. */
export function shortenUrl(url, max = 70) {
  if (typeof url !== 'string' || url.length <= max) return url;
  const head = Math.floor((max - 3) * 0.6);
  const tail = max - 3 - head;
  return `${url.slice(0, head)}...${url.slice(-tail)}`;
}
