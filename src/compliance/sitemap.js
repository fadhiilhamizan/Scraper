/**
 * Sitemap discovery and parsing.
 *
 * Seeding a crawl from `sitemap.xml` rather than by following links is usually
 * both faster and gentler: the site is telling you exactly which URLs it wants
 * indexed, so you fetch far fewer pages to reach the same data.
 *
 * Supports sitemap indexes (recursively), gzipped sitemaps, and plain-text
 * sitemaps. Parsing is regex-based on purpose — sitemap XML is simple and
 * predictable, and this avoids pulling in an XML stack for one feature.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

const URL_BLOCK = /<url>([\s\S]*?)<\/url>/gi;
const SITEMAP_BLOCK = /<sitemap>([\s\S]*?)<\/sitemap>/gi;
const LOC = /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i;
const LASTMOD = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i;
const CHANGEFREQ = /<changefreq>\s*([\s\S]*?)\s*<\/changefreq>/i;
const PRIORITY = /<priority>\s*([\s\S]*?)\s*<\/priority>/i;

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so `&amp;lt;` doesn't double-decode
}

/**
 * @typedef {object} SitemapEntry
 * @property {string} url
 * @property {string|null} lastmod
 * @property {string|null} changefreq
 * @property {number|null} priority
 */

/**
 * Parse sitemap XML or a plain-text URL list.
 * @returns {{entries: SitemapEntry[], children: string[], type: 'index'|'urlset'|'text'}}
 */
export function parseSitemap(content) {
  const text = String(content).trim();

  // A plain-text sitemap is just one URL per line.
  if (!text.startsWith('<') && !text.includes('<urlset') && !text.includes('<sitemapindex')) {
    const entries = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
      .map((url) => ({ url, lastmod: null, changefreq: null, priority: null }));
    return { entries, children: [], type: 'text' };
  }

  const children = [];
  for (const match of text.matchAll(SITEMAP_BLOCK)) {
    const loc = LOC.exec(match[1])?.[1];
    if (loc) children.push(decodeXmlEntities(loc.trim()));
  }

  const entries = [];
  for (const match of text.matchAll(URL_BLOCK)) {
    const block = match[1];
    const loc = LOC.exec(block)?.[1];
    if (!loc) continue;
    const priority = PRIORITY.exec(block)?.[1];
    entries.push({
      url: decodeXmlEntities(loc.trim()),
      lastmod: LASTMOD.exec(block)?.[1] ?? null,
      changefreq: CHANGEFREQ.exec(block)?.[1] ?? null,
      priority: priority ? Number.parseFloat(priority) : null,
    });
  }

  return {
    entries,
    children,
    type: children.length && !entries.length ? 'index' : 'urlset',
  };
}

export class SitemapReader {
  /**
   * @param {object} options
   * @param {import('../http/client.js').HttpClient} options.httpClient
   * @param {number} [options.maxSitemaps=50]   Guard against index loops.
   * @param {number} [options.maxUrls=50000]
   * @param {number} [options.maxDepth=3]
   */
  constructor(options = {}) {
    this.httpClient = options.httpClient;
    this.maxSitemaps = options.maxSitemaps ?? 50;
    this.maxUrls = options.maxUrls ?? 50_000;
    this.maxDepth = options.maxDepth ?? 3;
    this.userAgent = options.userAgent ?? '*';
    this.logger = options.logger ?? null;
  }

  async #fetch(url) {
    const response = await this.httpClient.request({
      url,
      headers: { 'user-agent': this.userAgent, accept: 'application/xml,text/xml,text/plain,*/*' },
      timeoutMs: 20_000,
      maxResponseBytes: 50 * 1024 * 1024,
      throwOnError: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} fetching sitemap ${url}`);
    }

    // Gzipped sitemaps often arrive without a Content-Encoding header, so sniff
    // the magic bytes rather than trusting metadata.
    let buffer = response.buffer;
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      buffer = await gunzip(buffer);
      return buffer.toString('utf8');
    }
    return response.body || buffer.toString('utf8');
  }

  /**
   * Read a sitemap (or index) and return every URL it points at.
   * @param {string|string[]} start
   * @returns {Promise<SitemapEntry[]>}
   */
  async read(start) {
    const queue = (Array.isArray(start) ? start : [start]).map((url) => ({ url, depth: 0 }));
    const visited = new Set();
    /** @type {SitemapEntry[]} */
    const collected = [];

    while (queue.length && visited.size < this.maxSitemaps && collected.length < this.maxUrls) {
      const { url, depth } = queue.shift();
      if (visited.has(url) || depth > this.maxDepth) continue;
      visited.add(url);

      let content;
      try {
        content = await this.#fetch(url);
      } catch (error) {
        this.logger?.warn('sitemap fetch failed', { url, error: error.message });
        continue;
      }

      const { entries, children, type } = parseSitemap(content);
      this.logger?.debug('sitemap parsed', { url, type, urls: entries.length, children: children.length });

      for (const entry of entries) {
        if (collected.length >= this.maxUrls) break;
        collected.push(entry);
      }
      for (const child of children) {
        queue.push({ url: child, depth: depth + 1 });
      }
    }

    return collected;
  }

  /**
   * Discover sitemaps for a site: robots.txt `Sitemap:` lines first, then the
   * conventional locations.
   * @returns {Promise<string[]>}
   */
  async discover(origin, robotsManager = null) {
    const found = [];
    if (robotsManager) {
      try {
        found.push(...(await robotsManager.sitemapsFor(origin)));
      } catch { /* fall through to conventional paths */ }
    }
    if (found.length) return [...new Set(found)];

    for (const candidate of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz']) {
      const url = `${origin.replace(/\/$/, '')}${candidate}`;
      try {
        const response = await this.httpClient.request({
          url,
          method: 'GET',
          headers: { 'user-agent': this.userAgent },
          timeoutMs: 8000,
          maxResponseBytes: 4096,
          throwOnError: false,
        });
        if (response.status === 200) {
          found.push(url);
          break;
        }
      } catch { /* try the next candidate */ }
    }
    return [...new Set(found)];
  }
}
