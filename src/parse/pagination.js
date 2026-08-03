/**
 * Link discovery: how a crawl finds its next URLs.
 *
 * Three complementary mechanisms:
 *   - `crawl.follow` rules — CSS/XPath selectors whose links get queued, each
 *     with an optional `label` that routes the page to different extraction.
 *   - `crawl.pagination` — the "next page" case, which is common enough to
 *     deserve its own shorthand, including numeric-parameter and template forms.
 *   - Auto-detection — a last resort that finds `rel="next"` and the usual
 *     pagination markup without configuration.
 */

import { resolveUrl, isSameDomain, matchesAny, getHostname } from '../queue/urlutils.js';

/** Selectors that identify a "next page" link across most of the web. */
const NEXT_LINK_SELECTORS = [
  'link[rel="next"]',
  'a[rel="next"]',
  '.pagination a.next',
  '.pagination .next a',
  'a.next',
  'a.next-page',
  '[aria-label="Next"]',
  '[aria-label="Next page"]',
  'li.next a',
  '.pager__item--next a',
];

/** Text content that reliably means "next" (checked case-insensitively). */
const NEXT_TEXT = /^(next|next page|next »|»|›|→|older|more|load more|show more|siguiente|suivant|weiter|次へ|下一页|selanjutnya|berikutnya)$/i;

/**
 * Apply the recipe's allow/deny rules to a candidate URL.
 * @returns {{allowed:boolean, reason:string}}
 */
export function isUrlAllowed(url, crawlConfig, { seedHosts = [] } = {}) {
  const host = getHostname(url);
  if (!host) return { allowed: false, reason: 'unparseable' };

  const domains = crawlConfig.allowedDomains?.length ? crawlConfig.allowedDomains : seedHosts;
  if (domains.length && !domains.some((d) => isSameDomain(host, d))) {
    return { allowed: false, reason: 'off_domain' };
  }

  // Deny wins over allow — it's the safety rule.
  if (crawlConfig.denyPatterns?.length && matchesAny(url, crawlConfig.denyPatterns)) {
    return { allowed: false, reason: 'deny_pattern' };
  }
  if (crawlConfig.allowPatterns?.length && !matchesAny(url, crawlConfig.allowPatterns)) {
    return { allowed: false, reason: 'not_in_allow_patterns' };
  }

  return { allowed: true, reason: 'ok' };
}

/**
 * Collect links a `crawl.follow` rule matches.
 *
 * @param {import('./dom.js').Page} page
 * @param {object} rule `{selector|xpath|pattern, attr, label, priority, maxLinks, meta}`
 * @returns {{url:string, label:string, priority:number, meta:object}[]}
 */
export function followRule(page, rule) {
  const out = [];
  const attr = rule.attr ?? 'href';

  if (rule.pattern && !rule.selector && !rule.xpath) {
    // Pattern-only rule: scan every link on the page.
    for (const link of page.links()) {
      if (matchesAny(link.url, [rule.pattern])) {
        out.push({ url: link.url, label: rule.label ?? 'default', priority: rule.priority ?? 0, meta: { ...rule.meta, linkText: link.text } });
      }
    }
    return rule.maxLinks ? out.slice(0, rule.maxLinks) : out;
  }

  const selector = rule.xpath ?? rule.selector;
  const selection = page.select(selector);

  selection.each((_, el) => {
    const $el = page.$(el);
    // `attr` may be `href` (the usual case) or a data attribute holding a URL.
    const raw = attr === 'text' ? $el.text().trim() : $el.attr(attr) ?? $el.find('a').first().attr('href');
    const absolute = resolveUrl(raw, page.baseUrl);
    if (!absolute) return;
    if (rule.pattern && !matchesAny(absolute, [rule.pattern])) return;

    out.push({
      url: absolute,
      label: rule.label ?? 'default',
      priority: rule.priority ?? 0,
      meta: { ...rule.meta, linkText: $el.text().replace(/\s+/g, ' ').trim() || undefined },
    });
  });

  return rule.maxLinks ? out.slice(0, rule.maxLinks) : out;
}

/**
 * Resolve the next page URL.
 *
 * Modes, in priority order:
 *  - `selector` / `xpath` — an explicit next-page link.
 *  - `urlTemplate` — e.g. `https://x.com/list?page={page}`, driven by a counter.
 *  - `param` — increment a query parameter on the current URL.
 *  - auto — try `rel="next"` and common markup.
 *
 * @returns {{url:string, page:number}|null}
 */
export function findNextPage(page, pagination, request = {}) {
  if (!pagination) return null;

  const currentPage = request.meta?._page ?? 1;
  const maxPages = pagination.maxPages ?? Infinity;
  if (currentPage >= maxPages) return null;

  // Guard: a "next" link that points at the current page loops forever.
  const notSelf = (url) => (url && url !== page.url ? url : null);

  if (pagination.selector || pagination.xpath) {
    const selection = page.select(pagination.xpath ?? pagination.selector).first();
    if (selection.length === 0) return null;
    // A disabled next button is how a site says "you're on the last page".
    const cls = selection.attr('class') ?? '';
    if (/\b(disabled|is-disabled|inactive)\b/i.test(cls) || selection.attr('aria-disabled') === 'true') {
      return null;
    }
    const href = selection.attr(pagination.attr ?? 'href');
    const url = notSelf(resolveUrl(href, page.baseUrl));
    return url ? { url, page: currentPage + 1 } : null;
  }

  if (pagination.urlTemplate) {
    const step = pagination.step ?? 1;
    const start = pagination.start ?? 1;
    const nextIndex = start + currentPage * step;
    const url = pagination.urlTemplate
      .replace(/\{page\}/g, String(nextIndex))
      .replace(/\{offset\}/g, String(currentPage * (pagination.pageSize ?? step)));
    // Stop when the current page yielded nothing — the usual end signal for
    // template pagination, which has no "last page" marker.
    if (pagination.stopWhenEmpty !== false && request.meta?._itemsOnPage === 0) return null;
    return { url, page: currentPage + 1 };
  }

  if (pagination.param) {
    let url;
    try {
      url = new URL(page.url);
    } catch {
      return null;
    }
    const step = pagination.step ?? 1;
    const current = Number(url.searchParams.get(pagination.param) ?? pagination.start ?? 1);
    if (pagination.stopWhenEmpty !== false && request.meta?._itemsOnPage === 0) return null;
    url.searchParams.set(pagination.param, String(current + step));
    return { url: url.toString(), page: currentPage + 1 };
  }

  return autoDetectNextPage(page, currentPage);
}

/** Best-effort next-page detection with no configuration. */
export function autoDetectNextPage(page, currentPage = 1) {
  for (const selector of NEXT_LINK_SELECTORS) {
    const el = page.$(selector).first();
    if (el.length === 0) continue;
    const cls = el.attr('class') ?? '';
    if (/\b(disabled|is-disabled|inactive)\b/i.test(cls)) continue;
    const url = resolveUrl(el.attr('href'), page.baseUrl);
    if (url && url !== page.url) return { url, page: currentPage + 1, detectedBy: selector };
  }

  // Fall back to link text.
  let found = null;
  page.$('a[href]').each((_, el) => {
    if (found) return;
    const $el = page.$(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!NEXT_TEXT.test(text)) return;
    const url = resolveUrl($el.attr('href'), page.baseUrl);
    if (url && url !== page.url) found = { url, page: currentPage + 1, detectedBy: `text:${text}` };
  });
  return found;
}

/**
 * Produce every request a page should enqueue.
 *
 * @param {import('./dom.js').Page} page
 * @param {object} request  The request that produced this page.
 * @param {object} crawlConfig
 * @param {object} [options] `{seedHosts, itemsOnPage}`
 * @returns {{requests:object[], skipped:Record<string,number>}}
 */
export function discoverLinks(page, request, crawlConfig, options = {}) {
  const { seedHosts = [], itemsOnPage = 0 } = options;
  const depth = request.depth ?? 0;
  const maxDepth = crawlConfig.maxDepth ?? 3;

  const requests = [];
  const skipped = {};
  const note = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };

  const push = (candidate, extra = {}) => {
    const verdict = isUrlAllowed(candidate.url, crawlConfig, { seedHosts });
    if (!verdict.allowed) {
      note(verdict.reason);
      return;
    }
    requests.push({
      url: candidate.url,
      label: candidate.label ?? 'default',
      depth: depth + 1,
      priority: candidate.priority ?? depth + 1,
      parentUrl: page.url,
      meta: { ...candidate.meta, ...extra },
    });
  };

  // Pagination is depth-exempt: page 40 of a listing is the same "level" as
  // page 1, and counting it as depth would truncate long listings.
  const pagination = crawlConfig.pagination;
  if (pagination) {
    const next = findNextPage(page, pagination, { ...request, meta: { ...request.meta, _itemsOnPage: itemsOnPage } });
    if (next) {
      const verdict = isUrlAllowed(next.url, crawlConfig, { seedHosts });
      if (verdict.allowed) {
        requests.push({
          url: next.url,
          label: request.label,          // same page type, so same extraction
          depth,
          priority: (request.priority ?? 0) - 1, // finish a listing before descending
          parentUrl: page.url,
          meta: { ...request.meta, _page: next.page },
        });
      } else {
        note(verdict.reason);
      }
    }
  }

  if (depth >= maxDepth) {
    if (crawlConfig.follow?.length) note('max_depth');
    return { requests, skipped };
  }

  for (const rule of crawlConfig.follow ?? []) {
    // A rule can be restricted to pages of a given label.
    if (rule.on && rule.on !== request.label) continue;
    for (const candidate of followRule(page, rule)) {
      push(candidate);
    }
  }

  return { requests, skipped };
}
