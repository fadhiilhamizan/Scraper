/**
 * Harvester — a modular web scraping framework.
 *
 * Three ways in, in increasing order of control:
 *
 * ```js
 * // 1. One page, one line.
 * import { scrape } from 'harvester';
 * const items = await scrape('https://example.com', {
 *   fields: { title: 'h1', price: { selector: '.price', transform: ['currency'] } },
 * });
 *
 * // 2. A full run from a recipe object.
 * import { run } from 'harvester';
 * const report = await run({
 *   start_urls: ['https://example.com/products'],
 *   crawl: { follow: [{ selector: '.product a', label: 'detail' }] },
 *   extract: { fields: { title: 'h1' } },
 *   output: ['products.csv'],
 * });
 *
 * // 3. Full control, with hooks and event subscriptions.
 * import { Scraper, defineRecipe } from 'harvester';
 * const { config, hooks } = defineRecipe(recipe);
 * const scraper = new Scraper(config, { hooks });
 * scraper.on('item', (item) => console.log(item));
 * await scraper.run();
 * ```
 */

import { Scraper } from './core/scraper.js';
import { defineRecipe, loadRecipe } from './config/loader.js';
import { Page } from './parse/dom.js';
import { extractItems } from './parse/extractor.js';
import { HttpClient } from './http/client.js';
import { botUserAgent } from './http/useragent.js';
import { buildHeaders } from './http/headers.js';
import { RobotsManager } from './compliance/robots.js';
import { nullLogger } from './observability/logger.js';

/* ─────────────────────────── high-level helpers ─────────────────────────── */

/**
 * Scrape a single page and return its records. No queue, no crawling.
 *
 * Still checks robots.txt by default — pass `robots: false` only when you have
 * another basis for access (your own site, an API agreement, explicit permission).
 *
 * @param {string} url
 * @param {object} options
 * @param {object} options.fields          Field spec (see docs/04-selectors.md).
 * @param {string} [options.selector]      Container selector for repeated items.
 * @param {boolean|'auto'} [options.render=false] Use a headless browser.
 * @param {boolean} [options.robots=true]
 * @param {object} [options.headers]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object[]>}
 */
export async function scrape(url, options = {}) {
  const {
    fields,
    selector = null,
    render = false,
    robots = true,
    headers = {},
    userAgent = botUserAgent({ contact: options.contact }),
    timeoutMs = 30_000,
    logger = nullLogger,
    ...rest
  } = options;

  if (!fields && !options.tables && !options.jsonld) {
    throw new Error('scrape() needs `fields`, `tables: true` or `jsonld: true`.');
  }

  const client = new HttpClient({ timeoutMs });
  try {
    if (robots) {
      const manager = new RobotsManager({ httpClient: client, userAgent, logger });
      const verdict = await manager.check(url);
      if (!verdict.allowed) {
        throw new Error(
          `robots.txt disallows fetching ${url} (rule: ${verdict.reason}). ` +
          'Pass `robots: false` only if you have another basis for access.',
        );
      }
    }

    let html;
    let finalUrl = url;
    let response = null;

    if (render) {
      const { Renderer } = await import('./render/renderer.js');
      const renderer = new Renderer({ ...rest.renderOptions, logger });
      try {
        const result = await renderer.render({
          url,
          waitForSelector: options.waitForSelector ?? selector ?? null,
          waitUntil: options.waitUntil ?? 'domcontentloaded',
          scroll: options.scroll,
          actions: options.actions ?? [],
          contextOptions: { userAgent },
        });
        html = result.html;
        finalUrl = result.url;
      } finally {
        await renderer.close();
      }
    } else {
      response = await client.request({
        url,
        headers: buildHeaders({ url, baseHeaders: { 'user-agent': userAgent, ...headers } }),
        timeoutMs,
      });
      html = response.body;
      finalUrl = response.url;
    }

    const page = new Page({ html, url: finalUrl, response });
    const { items } = extractItems(
      { selector, fields, tables: options.tables, jsonld: options.jsonld },
      page,
      { response },
    );
    return items;
  } finally {
    await client.close();
  }
}

/**
 * Run a complete scrape from a recipe object.
 * @param {object} recipe
 * @param {object} [options] `{presets, overrides, logger, onItem}`
 * @returns {Promise<object>} the run report
 */
export async function run(recipe, options = {}) {
  const { config, hooks, warnings } = defineRecipe(recipe, options);
  const scraper = new Scraper(config, { hooks: { ...hooks, ...options.hooks }, logger: options.logger });
  for (const warning of warnings) scraper.logger.warn(warning);
  if (options.onItem) scraper.on('item', options.onItem);
  return scraper.run();
}

/**
 * Run a scrape from a recipe file (YAML / JSON / JS).
 * @param {string} recipePath
 * @param {object} [options]
 * @returns {Promise<object>} the run report
 */
export async function runFile(recipePath, options = {}) {
  const { config, hooks, warnings } = await loadRecipe(recipePath, options);
  const scraper = new Scraper(config, { hooks: { ...hooks, ...options.hooks }, logger: options.logger });
  for (const warning of warnings) scraper.logger.warn(warning);
  if (options.onItem) scraper.on('item', options.onItem);
  return scraper.run();
}

/**
 * Parse HTML you already have (from a file, a proxy, another tool) and extract.
 * Useful for testing selectors without touching the network.
 *
 * @param {string} html
 * @param {object} spec `{selector, fields}`
 * @param {string} [url='https://example.com'] Base for relative link resolution.
 */
export function extractFromHtml(html, spec, url = 'https://example.com') {
  const page = new Page({ html, url });
  return extractItems(spec, page);
}

/* ──────────────────────────── component exports ─────────────────────────── */

export { Scraper, createScraper } from './core/scraper.js';
export { Pipeline, createPipeline, HOOKS } from './core/pipeline.js';
export { buildReport, formatReport } from './core/report.js';

export { defineRecipe, loadRecipe, toYaml, interpolateEnv } from './config/loader.js';
export { normalizeConfig, validateConfig, deepMerge } from './config/schema.js';
export { DEFAULT_CONFIG, PRESETS } from './config/defaults.js';

export { HttpClient, createHttpClient } from './http/client.js';
export { CookieJar, Cookie, parseSetCookie } from './http/cookies.js';
export { ProxyPool } from './http/proxy.js';
export { UserAgentRotator, BROWSER_PROFILES, botUserAgent } from './http/useragent.js';
export { buildHeaders, apiHeaders } from './http/headers.js';
export { HttpCache } from './http/cache.js';

export { Page, parseHtml, isXPathExpression } from './parse/dom.js';
export { extractItems, extractRecord, extractField, getByPath } from './parse/extractor.js';
export { discoverLinks, findNextPage, isUrlAllowed } from './parse/pagination.js';
export * as xpath from './parse/xpath.js';

export {
  TRANSFORMS, applyTransforms, registerTransform, listTransforms,
  parseNumber, parseCurrency, parseDate, stripTags, decodeEntities,
} from './process/transforms.js';
export { Deduplicator, BloomFilter, createDeduplicator } from './process/dedupe.js';
export { Validator, createValidator } from './process/validate.js';

export { Renderer, createRenderer, needsRendering, runActions, autoScroll } from './render/renderer.js';

export { RateLimiter, parseRetryAfter } from './resilience/ratelimiter.js';
export { RetryPolicy, createRetryPolicy } from './resilience/retry.js';
export { CircuitBreaker, CircuitState } from './resilience/circuitbreaker.js';
export { CaptchaHandler, detectBlock } from './resilience/captcha.js';

export { RobotsTxt, RobotsManager } from './compliance/robots.js';
export { SitemapReader, parseSitemap } from './compliance/sitemap.js';

export { Frontier } from './queue/frontier.js';
export { RunState, createRunState } from './queue/state.js';
export {
  canonicalizeUrl, resolveUrl, isSameDomain, matchesAny, getHostname, getOrigin,
} from './queue/urlutils.js';

export {
  createWriter, MultiWriter, BufferedSink, FORMATS,
  JsonWriter, NdjsonWriter, CsvWriter, XlsxWriter, SqliteWriter, ConsoleWriter,
} from './storage/index.js';

export { Logger, createLogger, nullLogger, LEVELS } from './observability/logger.js';
export { Metrics, createMetrics } from './observability/metrics.js';
export { ProgressReporter } from './observability/progress.js';

export {
  HarvesterError, ConfigError, NetworkError, HttpError, TimeoutError,
  BlockedError, DisallowedError, ValidationError, RenderError, CircuitOpenError,
} from './utils/errors.js';
export { sleep, withTimeout, Semaphore, mapLimit, backoffDelay } from './utils/async.js';

export default { scrape, run, runFile, Scraper, defineRecipe, loadRecipe };
