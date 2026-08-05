/**
 * The parsed-page object handed to extractors and hooks.
 *
 * Wraps cheerio with one uniform query surface so a recipe can mix CSS and
 * XPath freely, and adds the page-level helpers scrapers always end up needing:
 * absolute link resolution, text extraction that respects block boundaries,
 * and structured-data readers.
 */

import * as cheerio from 'cheerio';

import { evaluateToNodes, evaluateToStrings, isElement as isXpathElement } from './xpath.js';
import { resolveUrl } from '../queue/urlutils.js';

/** Elements whose text should never appear in `page.text()`. */
const NON_CONTENT = 'script, style, noscript, template, iframe, svg, canvas';

/** Block-level tags that imply a line break when flattening to text. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'td', 'th', 'tr', 'ul',
]);

export class Page {
  /**
   * @param {object} params
   * @param {string} params.html
   * @param {string} params.url        Final URL after redirects — the base for links.
   * @param {number} [params.status]
   * @param {object} [params.headers]
   * @param {object} [params.response] The raw response record.
   */
  constructor({ html, url, status = 200, headers = {}, response = null, meta = {} }) {
    this.html = html ?? '';
    this.url = url;
    this.status = status;
    this.headers = headers;
    this.response = response;
    this.meta = meta;

    this.$ = cheerio.load(this.html, { baseURI: url }, true);
    /** Honour `<base href>` when resolving relative links. */
    const baseHref = this.$('base[href]').first().attr('href');
    this.baseUrl = baseHref ? resolveUrl(baseHref, url) ?? url : url;

    this.invalidate();
  }

  /*
   * Memoised readers.
   *
   * Every one of these is called once per *field per record* by the extractor,
   * yet each recomputes a whole-document view. `microdata()` is the worst:
   * O(scopes × properties × depth) per call, so five microdata fields over a
   * hundred records rebuilt the same document five hundred times. Memoising
   * turns that from quadratic in records into constant.
   */
  #jsonLdCache;
  #jsonCache;
  #metaCache;
  #microdataCache;
  #tableCache;
  #textCache;

  /**
   * Drop every memo. Call after anything mutates the DOM — the `onPage` hook
   * receives the live page and may rewrite it.
   */
  invalidate() {
    this.#jsonLdCache = null;
    this.#jsonCache = undefined;
    this.#metaCache = null;
    this.#microdataCache = null;
    this.#tableCache = new Map();
    this.#textCache = new Map();
  }

  /**
   * The whole response body parsed as JSON, memoised.
   *
   * The extractor used to memoise this on its per-record context object, which
   * is rebuilt by spread for every container — so the memo landed on a throwaway
   * copy and a `from: json` field re-parsed the entire body once per record.
   * Holding it on the page survives every context copy.
   *
   * @returns {any|null} null when the body isn't JSON.
   */
  json() {
    if (this.#jsonCache !== undefined) return this.#jsonCache;
    try {
      this.#jsonCache = JSON.parse(this.html);
    } catch {
      this.#jsonCache = null;
    }
    return this.#jsonCache;
  }

  /** The raw domhandler root node — the context for XPath. */
  get root() {
    return this.$.root()[0];
  }

  /* ───────────────────────────── querying ──────────────────────────────── */

  /**
   * Select nodes with CSS or XPath. XPath is detected by a leading `/`, `(`
   * or an explicit `xpath:` prefix.
   * @param {string} selector
   * @param {object} [context] A cheerio element to scope the search to.
   * @returns {import('cheerio').Cheerio} cheerio selection
   */
  select(selector, context = null) {
    if (typeof selector !== 'string' || selector.trim() === '') return this.$([]);
    const expr = selector.trim();

    if (isXPathExpression(expr)) {
      const query = expr.startsWith('xpath:') ? expr.slice(6).trim() : expr;
      const contextNode = context ? (context[0] ?? context) : this.root;
      const nodes = evaluateToNodes(query, contextNode);
      // Attribute and text results are not cheerio-wrappable; keep the raw
      // nodes accessible via `selectValues` instead.
      return this.$(nodes.filter(isXpathElement));
    }

    return context ? this.$(context).find(expr) : this.$(expr);
  }

  /**
   * Select and return string values. Handles the cases CSS can't express —
   * `//a/@href`, `//p/text()` — uniformly with CSS selectors.
   * @returns {string[]}
   */
  selectValues(selector, context = null) {
    const expr = String(selector ?? '').trim();
    if (!expr) return [];

    if (isXPathExpression(expr)) {
      const query = expr.startsWith('xpath:') ? expr.slice(6).trim() : expr;
      const contextNode = context ? (context[0] ?? context) : this.root;
      // `evaluateToStrings` copes with expressions that return a primitive
      // (`count()`, `normalize-space()`) as well as node-sets.
      return evaluateToStrings(query, contextNode);
    }

    const selection = context ? this.$(context).find(expr) : this.$(expr);
    return selection.toArray().map((el) => this.$(el).text());
  }

  /** First matching element as a cheerio selection (possibly empty). */
  selectFirst(selector, context = null) {
    return this.select(selector, context).first();
  }

  /** Does anything match? Cheap existence test for `when` conditions. */
  exists(selector, context = null) {
    const expr = String(selector ?? '').trim();
    if (!expr) return false;
    if (isXPathExpression(expr)) {
      const query = expr.startsWith('xpath:') ? expr.slice(6).trim() : expr;
      const contextNode = context ? (context[0] ?? context) : this.root;
      return evaluateToNodes(query, contextNode).length > 0;
    }
    return this.select(expr, context).length > 0;
  }

  /* ───────────────────────────── content ───────────────────────────────── */

  /** Page title: `<title>`, falling back to OpenGraph then `<h1>`. */
  title() {
    return (
      this.$('title').first().text().trim() ||
      this.$('meta[property="og:title"]').attr('content')?.trim() ||
      this.$('h1').first().text().trim() ||
      ''
    );
  }

  /**
   * Visible text with block structure preserved as newlines.
   * Far more useful than cheerio's `.text()`, which glues words together
   * across element boundaries.
   */
  text(selector = 'body') {
    const cached = this.#textCache.get(selector);
    if (cached !== undefined) return cached;
    const result = this.#computeText(selector);
    this.#textCache.set(selector, result);
    return result;
  }

  #computeText(selector) {
    const scope = selector ? this.$(selector) : this.$.root();
    if (scope.length === 0) return '';

    const clone = scope.clone();
    clone.find(NON_CONTENT).remove();

    const parts = [];
    const walk = (node) => {
      if (node.type === 'text') {
        const value = node.data ?? '';
        if (value.trim()) parts.push(value.replace(/\s+/g, ' '));
        return;
      }
      if (node.type !== 'tag' && node.type !== 'root') return;
      const isBlock = BLOCK_TAGS.has(node.name);
      if (isBlock) parts.push('\n');
      for (const child of node.children ?? []) walk(child);
      if (isBlock) parts.push('\n');
    };
    for (const el of clone.toArray()) walk(el);

    return parts
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** `<meta>` tags as a flat object, keyed by `name` or `property`. */
  metaTags() {
    if (this.#metaCache) return this.#metaCache;
    const out = {};
    this.$('meta').each((_, el) => {
      const $el = this.$(el);
      const key = $el.attr('name') ?? $el.attr('property') ?? $el.attr('itemprop') ?? $el.attr('http-equiv');
      const value = $el.attr('content');
      if (key && value != null) out[key.toLowerCase()] = value;
    });
    // Frozen because `from: meta` with no `path` hands this straight to user
    // code; a caller mutating it would silently corrupt every later read.
    this.#metaCache = Object.freeze(out);
    return this.#metaCache;
  }

  /** Canonical URL if the page declares one. */
  canonical() {
    const href = this.$('link[rel="canonical"]').first().attr('href');
    return href ? resolveUrl(href, this.baseUrl) : null;
  }

  /**
   * Every link on the page, absolute and de-duplicated.
   * @param {string} [selector='a[href]']
   * @returns {{url:string, text:string, rel:string|null, title:string|null}[]}
   */
  links(selector = 'a[href]') {
    const seen = new Set();
    const out = [];
    this.select(selector).each((_, el) => {
      const $el = this.$(el);
      const href = $el.attr('href');
      const absolute = resolveUrl(href, this.baseUrl);
      if (!absolute || seen.has(absolute)) return;
      seen.add(absolute);
      out.push({
        url: absolute,
        text: $el.text().replace(/\s+/g, ' ').trim(),
        rel: $el.attr('rel') ?? null,
        title: $el.attr('title') ?? null,
      });
    });
    return out;
  }

  /** Resolve any URL against this page. */
  resolve(href) {
    return resolveUrl(href, this.baseUrl);
  }

  /* ─────────────────────── structured data readers ─────────────────────── */

  /**
   * All JSON-LD blocks on the page, parsed. Many commerce, recipe, article and
   * job sites publish the exact data you want here — checking it first often
   * removes the need for selectors entirely, and it survives redesigns.
   */
  jsonLd() {
    if (this.#jsonLdCache) return this.#jsonLdCache;
    const blocks = [];
    this.$('script[type="application/ld+json"]').each((_, el) => {
      const raw = this.$(el).contents().text() || this.$(el).text();
      if (!raw?.trim()) return;
      try {
        const parsed = JSON.parse(raw);
        // A block may be an array or use `@graph` to hold several entities.
        const flatten = (value) => {
          if (Array.isArray(value)) value.forEach(flatten);
          else if (value && typeof value === 'object') {
            if (Array.isArray(value['@graph'])) value['@graph'].forEach(flatten);
            else blocks.push(value);
          }
        };
        flatten(parsed);
      } catch {
        // Malformed JSON-LD is extremely common; a broken block is not a
        // reason to fail the page.
      }
    });
    this.#jsonLdCache = blocks;
    return blocks;
  }

  /** JSON-LD entities filtered by `@type` (case-insensitive, substring match). */
  jsonLdOfType(type) {
    const wanted = String(type).toLowerCase();
    return this.jsonLd().filter((block) => {
      const t = block['@type'];
      if (!t) return false;
      const types = Array.isArray(t) ? t : [t];
      return types.some((v) => String(v).toLowerCase() === wanted);
    });
  }

  /** OpenGraph properties without the `og:` prefix. */
  openGraph() {
    const out = {};
    for (const [key, value] of Object.entries(this.metaTags())) {
      if (key.startsWith('og:')) out[key.slice(3)] = value;
    }
    return out;
  }

  /** Microdata (`itemscope`/`itemprop`) as nested objects. Memoised. */
  microdata() {
    this.#microdataCache ??= this.#computeMicrodata();
    return this.#microdataCache;
  }

  #computeMicrodata() {
    const readScope = (scopeEl) => {
      const item = {};
      const type = this.$(scopeEl).attr('itemtype');
      if (type) item['@type'] = type.split('/').pop();

      this.$(scopeEl)
        .find('[itemprop]')
        .each((_, el) => {
          // Skip properties belonging to a nested itemscope.
          const owner = this.$(el).parentsUntil(scopeEl, '[itemscope]').first();
          if (owner.length) return;

          const $el = this.$(el);
          const name = $el.attr('itemprop');
          if (!name) return;

          let value;
          if ($el.is('[itemscope]')) value = readScope(el);
          else if ($el.is('meta')) value = $el.attr('content');
          else if ($el.is('a, link, area')) value = this.resolve($el.attr('href'));
          else if ($el.is('img, audio, video, source, iframe, embed, track')) value = this.resolve($el.attr('src'));
          else if ($el.is('time')) value = $el.attr('datetime') ?? $el.text().trim();
          else if ($el.is('data')) value = $el.attr('value') ?? $el.text().trim();
          else value = $el.text().replace(/\s+/g, ' ').trim();

          if (item[name] === undefined) item[name] = value;
          else if (Array.isArray(item[name])) item[name].push(value);
          else item[name] = [item[name], value];
        });
      return item;
    };

    return this.$('[itemscope]')
      .filter((_, el) => this.$(el).parents('[itemscope]').length === 0)
      .toArray()
      .map(readScope);
  }

  /**
   * Every `<table>` on the page as `{headers, rows}`. Handles `colspan` on
   * header cells and both `<th>`-in-`<thead>` and first-row header styles.
   */
  tables(selector = 'table') {
    const cached = this.#tableCache.get(selector);
    if (cached !== undefined) return cached;
    const result = this.#computeTables(selector);
    this.#tableCache.set(selector, result);
    return result;
  }

  #computeTables(selector) {
    return this.select(selector)
      .toArray()
      .map((table) => {
        const $table = this.$(table);
        const cellText = (el) => this.$(el).text().replace(/\s+/g, ' ').trim();

        let headers = $table
          .find('thead tr')
          .first()
          .find('th, td')
          .toArray()
          .flatMap((el) => {
            const span = Number.parseInt(this.$(el).attr('colspan') ?? '1', 10) || 1;
            const text = cellText(el);
            return span > 1 ? Array.from({ length: span }, (_, i) => (i ? `${text}_${i + 1}` : text)) : [text];
          });

        const bodyRows = $table.find('tbody tr').toArray();
        const allRows = bodyRows.length ? bodyRows : $table.find('tr').toArray();
        let dataRows = allRows;

        if (headers.length === 0 && allRows.length) {
          const firstCells = this.$(allRows[0]).find('th, td').toArray();
          const allTh = firstCells.length > 0 && firstCells.every((el) => this.$(el).is('th'));
          if (allTh) {
            headers = firstCells.map(cellText);
            dataRows = allRows.slice(1);
          }
        }

        const rows = dataRows
          .map((tr) => this.$(tr).find('td, th').toArray().map(cellText))
          .filter((cells) => cells.length > 0 && cells.some((c) => c !== ''));

        const records = headers.length
          ? rows.map((cells) =>
              Object.fromEntries(cells.map((cell, i) => [headers[i] ?? `column_${i + 1}`, cell])))
          : [];

        return {
          caption: $table.find('caption').first().text().trim() || null,
          headers,
          rows,
          records,
          rowCount: rows.length,
        };
      });
  }
}

/** Heuristic: does this string look like XPath rather than CSS? */
export function isXPathExpression(selector) {
  if (typeof selector !== 'string') return false;
  const s = selector.trim();
  if (s.startsWith('xpath:')) return true;
  if (s.startsWith('/') || s.startsWith('(/')) return true;
  if (s.startsWith('./') || s.startsWith('../')) return true;
  // Axis syntax is unambiguous.
  return /^[a-z-]+::/i.test(s);
}

export function parseHtml(html, url, extra = {}) {
  return new Page({ html, url, ...extra });
}

export { cheerio };
