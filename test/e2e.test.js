/**
 * End-to-end tests against a local HTTP server.
 *
 * These exercise the real pipeline — robots.txt, rate limiting, the frontier,
 * pagination, extraction, validation, dedupe and file output — with no network
 * access and no mocking. If these pass, the framework actually works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Scraper } from '../src/core/scraper.js';
import { defineRecipe } from '../src/config/loader.js';
import { scrape } from '../src/index.js';
import { nullLogger } from '../src/observability/logger.js';

/* ─────────────────────────────── fixtures ──────────────────────────────── */

const PRODUCTS = [
  { id: 1, name: 'Alpha Widget', price: '$10.50', stock: 'In stock' },
  { id: 2, name: 'Beta Gadget', price: '$25.00', stock: 'In stock' },
  { id: 3, name: 'Gamma Doohickey', price: '$5.25', stock: 'Out of stock' },
  { id: 4, name: 'Delta Thing', price: '$99.99', stock: 'In stock' },
  { id: 5, name: 'Epsilon Item', price: '$1.00', stock: 'In stock' },
  { id: 6, name: 'Zeta Object', price: '$42.00', stock: 'In stock' },
];

const PER_PAGE = 2;
const TOTAL_PAGES = Math.ceil(PRODUCTS.length / PER_PAGE);

function listPage(pageNumber) {
  const slice = PRODUCTS.slice((pageNumber - 1) * PER_PAGE, pageNumber * PER_PAGE);
  const cards = slice.map((p) => `
    <article class="product" data-id="${p.id}">
      <h2 class="name">${p.name}</h2>
      <span class="price">${p.price}</span>
      <span class="stock">${p.stock}</span>
      <a class="details" href="/product/${p.id}">Details</a>
    </article>`).join('');

  const next = pageNumber < TOTAL_PAGES
    ? `<a class="next" href="/list?page=${pageNumber + 1}">Next</a>`
    : '<span class="next disabled">Next</span>';

  return `<!doctype html><html><head><title>Page ${pageNumber}</title></head>
    <body><div class="products">${cards}</div><nav>${next}</nav></body></html>`;
}

function detailPage(product) {
  return `<!doctype html><html><head>
    <title>${product.name}</title>
    <meta property="og:title" content="${product.name}">
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"${product.name}","sku":"SKU-${product.id}",
     "offers":{"@type":"Offer","price":"${product.price.replace('$', '')}","priceCurrency":"USD"}}
    </script></head>
    <body>
      <h1 class="title">${product.name}</h1>
      <div class="price">${product.price}</div>
      <p class="description">A very fine ${product.name.toLowerCase()} indeed.</p>
      <table><thead><tr><th>Attribute</th><th>Value</th></tr></thead>
      <tbody><tr><td>SKU</td><td>SKU-${product.id}</td></tr></tbody></table>
    </body></html>`;
}

/** Counts requests per path so tests can assert on crawl behaviour. */
const hits = new Map();

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/robots.txt') {
      return send(200, 'User-agent: *\nDisallow: /private\nDisallow: /admin\nCrawl-delay: 0\n', 'text/plain');
    }
    if (url.pathname === '/list') {
      const page = Number(url.searchParams.get('page') ?? 1);
      return send(200, listPage(page));
    }
    if (url.pathname.startsWith('/product/')) {
      const id = Number(url.pathname.split('/')[2]);
      const product = PRODUCTS.find((p) => p.id === id);
      return product ? send(200, detailPage(product)) : send(404, 'Not found');
    }
    if (url.pathname === '/private/secret') {
      return send(200, '<html><body>Should never be fetched</body></html>');
    }
    if (url.pathname === '/flaky') {
      // Fails twice, then succeeds — exercises the retry path.
      const count = hits.get('/flaky');
      if (count <= 2) return send(503, 'Service Unavailable');
      return send(200, '<html><body><h1 class="title">Recovered</h1></body></html>');
    }
    if (url.pathname === '/gone') return send(404, 'Not found');
    if (url.pathname === '/api/items') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const data = page <= 2 ? PRODUCTS.slice((page - 1) * 3, page * 3) : [];
      return send(200, JSON.stringify({ page, data }), 'application/json');
    }
    return send(404, 'Not found');
  });
}

let server;
let base;
let tmpDir;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvester-e2e-'));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test.beforeEach(() => hits.clear());

const outFile = (name) => path.join(tmpDir, name);

/** Build and run a scraper, returning `{report, items}`. */
async function runRecipe(recipe) {
  const { config } = defineRecipe({
    rate_limit: { requests_per_second: 1000, burst: 1000, jitter_ms: 0 },
    logging: { level: 'silent', progress: false },
    ...recipe,
  });
  const scraper = new Scraper(config, { logger: nullLogger });
  const items = [];
  scraper.on('item', (item) => items.push(item));
  const report = await scraper.run();
  return { report, items };
}

/* ──────────────────────────────── tests ────────────────────────────────── */

test('extracts repeated items from a single page', async () => {
  const { report, items } = await runRecipe({
    start_urls: [`${base}/list`],
    extract: {
      item: {
        selector: 'article.product',
        fields: {
          name: '.name',
          price: { selector: '.price', transform: ['currency'], type: 'number' },
          in_stock: { selector: '.stock', transform: ['boolean'] },
          url: { selector: 'a.details', attr: 'href', type: 'url' },
        },
      },
    },
    output: [{ format: 'none' }],
    metadata: false,
  });

  assert.equal(report.pages.ok, 1);
  assert.equal(items.length, PER_PAGE);
  assert.equal(items[0].name, 'Alpha Widget');
  assert.equal(items[0].price, 10.5);
  assert.equal(items[0].in_stock, true);
  assert.equal(items[0].url, `${base}/product/1`);
});

test('follows pagination to the end and stops at the disabled link', async () => {
  const { report, items } = await runRecipe({
    start_urls: [`${base}/list`],
    crawl: { pagination: { selector: 'a.next', max_pages: 10 } },
    extract: { item: { selector: 'article.product', fields: { name: '.name' } } },
    output: [{ format: 'none' }],
    metadata: false,
  });

  assert.equal(report.pages.ok, TOTAL_PAGES);
  assert.equal(items.length, PRODUCTS.length);
  assert.deepEqual(items.map((i) => i.name).sort(), PRODUCTS.map((p) => p.name).sort());
});

test('crawls listing pages and their detail pages with per-label extraction', async () => {
  const { report, items } = await runRecipe({
    start_urls: [{ url: `${base}/list`, label: 'listing' }],
    crawl: {
      max_depth: 2,
      pagination: { selector: 'a.next', max_pages: 10 },
      follow: [{ selector: 'a.details', label: 'detail', on: 'listing' }],
    },
    extract: {
      listing: { fields: {} },
      detail: {
        fields: {
          title: { selector: 'h1.title', required: true },
          sku: { from: 'jsonld', path: 'sku' },
          price: { from: 'jsonld', path: 'offers.price', transform: ['number'], type: 'number' },
          description: { selector: '.description', transform: ['clean'] },
        },
      },
    },
    output: [{ format: 'none' }],
    metadata: false,
  });

  assert.equal(items.length, PRODUCTS.length, 'one record per detail page');
  assert.equal(report.pages.ok, TOTAL_PAGES + PRODUCTS.length);
  const alpha = items.find((i) => i.title === 'Alpha Widget');
  assert.equal(alpha.sku, 'SKU-1');
  assert.equal(alpha.price, 10.5);
  assert.match(alpha.description, /very fine alpha widget/);
});

test('robots.txt is fetched once and its rules are enforced', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/list`, `${base}/private/secret`],
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
  });

  assert.equal(hits.get('/robots.txt'), 1, 'robots.txt must be cached, not refetched per URL');
  assert.equal(hits.get('/private/secret'), undefined, 'a disallowed URL must never be requested');
  assert.equal(report.pages.blockedByRobots, 1);
  assert.equal(report.pages.ok, 1);
});

test('disabling robots.txt is honoured and warned about', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/private/secret`],
    robots: { enabled: false },
    extract: { fields: { body: 'body' } },
    output: [{ format: 'none' }],
  });

  assert.equal(hits.get('/private/secret'), 1);
  assert.equal(report.pages.ok, 1);
  assert.ok(report.warnings.some((w) => /robots\.txt enforcement is disabled/.test(w)));
});

test('transient 503s are retried until they succeed', async () => {
  const { report, items } = await runRecipe({
    start_urls: [`${base}/flaky`],
    retry: { max_attempts: 4, base_delay_ms: 10, max_delay_ms: 50 },
    extract: { fields: { title: '.title' } },
    output: [{ format: 'none' }],
    metadata: false,
  });

  assert.equal(hits.get('/flaky'), 3, 'two failures then a success');
  assert.equal(report.pages.ok, 1);
  assert.equal(items[0].title, 'Recovered');
});

test('a permanent 404 is not retried and is reported as a failure', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/gone`],
    retry: { max_attempts: 3, base_delay_ms: 10 },
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
  });

  assert.equal(hits.get('/gone'), 1, '404 must not be retried');
  assert.equal(report.pages.failed, 1);
  assert.equal(report.failures[0].reason, 'HTTP 404');
});

test('max_pages caps the crawl', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    max_pages: 2,
    crawl: {
      max_depth: 3,
      pagination: { selector: 'a.next', max_pages: 10 },
      follow: [{ selector: 'a.details', label: 'detail' }],
    },
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
  });

  assert.equal(report.pages.ok, 2);
});

test('deny_patterns keep matching URLs out of the frontier', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    crawl: {
      max_depth: 2,
      follow: [{ selector: 'a.details', label: 'detail' }],
      deny_patterns: ['/product/'],
    },
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
  });

  assert.equal(report.pages.ok, 1, 'only the listing page should be fetched');
});

test('duplicate records are collapsed', async () => {
  const { report, items } = await runRecipe({
    // The same page twice under different query strings that canonicalise away.
    start_urls: [`${base}/list?page=1`, `${base}/list?page=1&utm_source=x`],
    dedupe: { strategy: 'fields', key_fields: ['name'] },
    extract: { item: { selector: 'article.product', fields: { name: '.name' } } },
    output: [{ format: 'none' }],
    metadata: false,
  });

  assert.equal(report.pages.ok, 1, 'the tracking-param variant is the same URL');
  assert.equal(items.length, PER_PAGE);
});

test('invalid records are quarantined rather than silently dropped', async () => {
  const quarantinePath = outFile('quarantine.ndjson');
  await fs.rm(quarantinePath, { force: true });

  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    extract: {
      item: {
        selector: 'article.product',
        fields: { name: '.name', price: { selector: '.price', transform: ['currency'], type: 'number' } },
      },
    },
    validate: {
      schema: { price: { type: 'number', min: 1000 } }, // nothing can satisfy this
      on_invalid: 'quarantine',
    },
    output: [outFile('valid.ndjson')],
    metadata: false,
  });

  assert.equal(report.items.written, 0);
  assert.equal(report.items.invalid, PER_PAGE);

  const quarantined = (await fs.readFile(quarantinePath, 'utf8')).trim().split('\n');
  assert.equal(quarantined.length, PER_PAGE);
  assert.ok(JSON.parse(quarantined[0])._issues.length > 0, 'the reason must be recorded');
});

test('output is written to every configured destination', async () => {
  const csvPath = outFile('products.csv');
  const jsonPath = outFile('products.json');

  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    crawl: { pagination: { selector: 'a.next', max_pages: 10 } },
    extract: {
      item: {
        selector: 'article.product',
        fields: { name: '.name', price: { selector: '.price', transform: ['currency'], type: 'number' } },
      },
    },
    output: [csvPath, jsonPath],
    metadata: { url: true, scraped_at: false },
  });

  assert.equal(report.items.written, PRODUCTS.length);

  const csv = (await fs.readFile(csvPath, 'utf8')).trim().split('\n');
  assert.equal(csv.length, PRODUCTS.length + 1);
  assert.ok(csv[0].includes('name'));

  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  assert.equal(json.length, PRODUCTS.length);
  assert.ok(json[0]._url.startsWith(base), 'metadata.url should add _url');
  assert.equal('_scraped_at' in json[0], false, 'metadata.scraped_at: false should omit it');
});

test('field health surfaces a selector that stopped matching', async () => {
  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    crawl: { pagination: { selector: 'a.next', max_pages: 10 } },
    extract: {
      item: {
        selector: 'article.product',
        fields: { name: '.name', broken: '.this-class-does-not-exist' },
      },
    },
    output: [{ format: 'none' }],
  });

  const broken = report.fieldHealth.find((f) => f.field === 'broken');
  assert.equal(broken.status, 'broken');
  assert.equal(broken.fillRate, 0);
  assert.ok(report.warnings.some((w) => w.includes("'broken'")));

  const healthy = report.fieldHealth.find((f) => f.field === 'name');
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.fillRate, 100);
});

test('hooks can enrich, filter and observe', async () => {
  const seen = [];
  const { config } = defineRecipe({
    start_urls: [`${base}/list`],
    rate_limit: { requests_per_second: 1000, burst: 1000, jitter_ms: 0 },
    logging: { level: 'silent', progress: false },
    extract: { item: { selector: 'article.product', fields: { name: '.name' } } },
    output: [{ format: 'none' }],
    metadata: false,
  });

  const scraper = new Scraper(config, {
    logger: nullLogger,
    hooks: {
      onPage: (page) => { seen.push(page.url); },
      onItem: (item) => {
        if (item.name.startsWith('Beta')) return null;   // drop
        return { ...item, enriched: true };               // enrich
      },
    },
  });

  const items = [];
  scraper.on('item', (i) => items.push(i));
  await scraper.run();

  assert.equal(seen.length, 1);
  assert.equal(items.length, 1, 'the Beta record should have been dropped');
  assert.equal(items[0].enriched, true);
});

test('an interrupted run resumes from its checkpoint', async () => {
  const statePath = outFile('state.json');
  await fs.rm(statePath, { force: true });

  const recipe = {
    start_urls: [`${base}/list`],
    // One worker, so the interruption point is deterministic. With several,
    // the scheduler legitimately has every remaining page in flight before
    // `stop()` lands — in-flight work is finished by design — and how many
    // pages complete becomes a race rather than a property of resume.
    concurrency: 1,
    rate_limit: { requests_per_second: 1000, burst: 1000, jitter_ms: 0 },
    logging: { level: 'silent', progress: false },
    crawl: { pagination: { selector: 'a.next', max_pages: 10 } },
    extract: { item: { selector: 'article.product', fields: { name: '.name' } } },
    output: [{ format: 'none' }],
    resume: { enabled: true, state_path: statePath, interval_ms: 5 },
  };

  // First run: stop as soon as the first page is done.
  const first = new Scraper(defineRecipe(recipe).config, { logger: nullLogger });
  first.on('item', () => {
    if (first.counters.pagesOk >= 1) first.stop('test interrupt');
  });
  const firstReport = await first.run();
  assert.ok(firstReport.pages.ok < TOTAL_PAGES, 'the first run should not have finished');

  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.ok(saved.frontier.pending.length > 0, 'unfinished work must be checkpointed');

  // Second run: pick up where it left off.
  const second = new Scraper(defineRecipe(recipe).config, { logger: nullLogger });
  const secondReport = await second.run();

  assert.ok(secondReport.pages.ok > 0, 'the resumed run should still have work to do');
  assert.equal(
    firstReport.pages.ok + secondReport.pages.ok,
    TOTAL_PAGES,
    'between them the two runs should cover every page exactly once',
  );
  // Counts are session-scoped; carried-over totals are reported separately.
  assert.equal(secondReport.resumed.pages, firstReport.pages.ok);
  assert.equal(secondReport.resumed.totalPages, TOTAL_PAGES);
  assert.equal(secondReport.completed, true, 'the resumed run should finish the crawl');
});

test('a changed recipe refuses to reuse an old checkpoint', async () => {
  const statePath = outFile('state2.json');
  await fs.writeFile(statePath, JSON.stringify({
    version: 1,
    fingerprint: 'deadbeefdeadbeef',
    frontier: { pending: [], completed: [], failed: [] },
  }), 'utf8');

  const { report } = await runRecipe({
    start_urls: [`${base}/list`],
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
    resume: { enabled: true, state_path: statePath },
  });

  assert.ok(report.warnings.some((w) => w.includes('different recipe')));
});

test('the HTTP cache prevents a second fetch', async () => {
  const cacheDir = outFile('cache');
  await fs.rm(cacheDir, { recursive: true, force: true });

  const recipe = {
    start_urls: [`${base}/list`],
    extract: { fields: { title: 'title' } },
    output: [{ format: 'none' }],
    cache: { enabled: true, dir: cacheDir },
  };

  await runRecipe(recipe);
  const afterFirst = hits.get('/list');

  const { report } = await runRecipe(recipe);
  assert.equal(hits.get('/list'), afterFirst, 'the second run must be served from cache');
  assert.equal(report.pages.fromCache, 1);
});

test('scrape() extracts a single page in one call', async () => {
  const items = await scrape(`${base}/product/1`, {
    fields: {
      title: 'h1.title',
      price: { selector: '.price', transform: ['currency'], type: 'number' },
      sku: { from: 'jsonld', path: 'sku' },
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Alpha Widget');
  assert.equal(items[0].price, 10.5);
  assert.equal(items[0].sku, 'SKU-1');
});

test('scrape() refuses a robots-disallowed URL by default', async () => {
  await assert.rejects(
    () => scrape(`${base}/private/secret`, { fields: { body: 'body' } }),
    /robots\.txt disallows/,
  );
});

test('tables: true turns an HTML table into records', async () => {
  const items = await scrape(`${base}/product/1`, { tables: true, fields: undefined });
  assert.deepEqual(items[0], { Attribute: 'SKU', Value: 'SKU-1' });
});

test('a JSON API can be paginated by query parameter', async () => {
  const { report, items } = await runRecipe({
    start_urls: [{ url: `${base}/api/items?page=1`, label: 'api' }],
    crawl: { pagination: { param: 'page', max_pages: 5, stop_when_empty: true } },
    extract: {
      fields: {
        names: { from: 'json', path: 'data.*.name', all: true },
        page: { from: 'json', path: 'page' },
      },
    },
    output: [{ format: 'none' }],
    metadata: false,
  });

  // Pages 1 and 2 return data, page 3 is empty and stops the walk.
  assert.ok(report.pages.ok >= 2);
  const allNames = items.flatMap((i) => i.names ?? []);
  assert.ok(allNames.includes('Alpha Widget'));
  assert.ok(allNames.includes('Zeta Object'));
});

test('per-host concurrency is respected', async () => {
  let concurrent = 0;
  let peak = 0;

  const busy = http.createServer((req, res) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    setTimeout(() => {
      concurrent -= 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>ok</h1></body></html>');
    }, 40);
  });
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const busyBase = `http://127.0.0.1:${busy.address().port}`;

  try {
    await runRecipe({
      start_urls: Array.from({ length: 8 }, (_, i) => `${busyBase}/p${i}`),
      concurrency: 8,
      concurrency_per_host: 2,
      robots: { enabled: false },
      extract: { fields: { title: 'h1' } },
      output: [{ format: 'none' }],
    });
    assert.ok(peak <= 2, `per-host concurrency exceeded: peaked at ${peak}`);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

test('the rate limiter actually spaces requests out', async () => {
  const { config } = defineRecipe({
    start_urls: Array.from({ length: 4 }, (_, i) => `${base}/product/${i + 1}`),
    concurrency: 4,
    rate_limit: { requests_per_second: 20, burst: 1, jitter_ms: 0 },
    logging: { level: 'silent', progress: false },
    extract: { fields: { title: 'h1.title' } },
    output: [{ format: 'none' }],
  });

  const started = Date.now();
  const report = await new Scraper(config, { logger: nullLogger }).run();
  const elapsed = Date.now() - started;

  assert.equal(report.pages.ok, 4);
  // Four requests at 20/s with a burst of 1 means at least ~150 ms of spacing.
  assert.ok(elapsed >= 120, `expected pacing, finished in ${elapsed}ms`);
});
