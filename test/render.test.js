/**
 * Dynamic-rendering tests.
 *
 * Playwright is an optional dependency, so the whole file skips itself when it
 * isn't installed rather than failing a perfectly valid install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { needsRendering } from '../src/render/renderer.js';
import { Scraper } from '../src/core/scraper.js';
import { defineRecipe } from '../src/config/loader.js';
import { nullLogger } from '../src/observability/logger.js';

let playwrightAvailable = true;
try {
  await import('playwright');
} catch {
  playwrightAvailable = false;
}

/* ───────────────────── the `auto` heuristic (no browser) ───────────────── */

test('needsRendering trusts a content selector over any heuristic', () => {
  assert.deepEqual(
    needsRendering('<html><body>anything</body></html>', { contentSelector: '.x', contentFound: true }),
    { needed: false, reason: 'content_present_in_html' },
  );
  assert.equal(
    needsRendering('<html><body>plenty of text here</body></html>', { contentSelector: '.x', contentFound: false }).needed,
    true,
  );
});

test('needsRendering spots an empty SPA root element', () => {
  const html = `<html><body><div id="root"></div><script>${'x'.repeat(2000)}</script></body></html>`;
  const verdict = needsRendering(html);
  assert.equal(verdict.needed, true);
  assert.match(verdict.reason, /thin_rendered_text|empty_spa_root/);
});

test('needsRendering spots a noscript JavaScript warning', () => {
  const html = `<html><body><noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="app"></div><p>${'padding text '.repeat(40)}</p></body></html>`;
  assert.equal(needsRendering(html).needed, true);
});

test('needsRendering leaves ordinary server-rendered HTML alone', () => {
  const html = `<html><body><h1>Products</h1>${'<p>Real server-rendered content.</p>'.repeat(30)}</body></html>`;
  const verdict = needsRendering(html);
  assert.equal(verdict.needed, false);
  assert.equal(verdict.reason, 'static_html_sufficient');
});

test('needsRendering treats an empty response as needing a browser', () => {
  assert.equal(needsRendering('').needed, true);
});

/* ─────────────────────── real browser rendering ────────────────────────── */

const ITEMS = [
  { id: 1, name: 'Dynamic Alpha', price: 19.99 },
  { id: 2, name: 'Dynamic Beta', price: 29.5 },
  { id: 3, name: 'Lazy Gamma', price: 8.75 },
];

const SHELL = `<!doctype html><html><head><title>SPA</title></head><body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
  <script>
    const ITEMS = ${JSON.stringify(ITEMS)};
    setTimeout(() => {
      document.getElementById('root').innerHTML =
        '<div class="grid">' + ITEMS.slice(0, 2).map(i =>
          '<div class="item" data-id="' + i.id + '">' +
          '<h2 class="item__name">' + i.name + '</h2>' +
          '<span class="item__price">$' + i.price.toFixed(2) + '</span></div>').join('') +
        '</div><button id="load-more">More</button>';
      document.getElementById('load-more').addEventListener('click', () => {
        const i = ITEMS[2];
        document.querySelector('.grid').insertAdjacentHTML('beforeend',
          '<div class="item" data-id="' + i.id + '">' +
          '<h2 class="item__name">' + i.name + '</h2>' +
          '<span class="item__price">$' + i.price.toFixed(2) + '</span></div>');
        document.getElementById('load-more').remove();
      });
    }, 100);
  </script></body></html>`;

let server;
let base;

test.before(async () => {
  if (!playwrightAvailable) return;
  server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\n');
    }
    if (req.url === '/static') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><body><div class="item"><h2 class="item__name">Server Rendered</h2>
        <span class="item__price">$1.00</span></div>${'<p>filler text here</p>'.repeat(30)}</body></html>`);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHELL);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function run(recipe) {
  const { config } = defineRecipe({
    rate_limit: { requests_per_second: 100, burst: 10, jitter_ms: 0 },
    logging: { level: 'silent', progress: false },
    output: [{ format: 'none' }],
    metadata: false,
    ...recipe,
  });
  const scraper = new Scraper(config, { logger: nullLogger });
  const items = [];
  scraper.on('item', (i) => items.push(i));
  const report = await scraper.run();
  return { report, items };
}

const opts = { skip: playwrightAvailable ? false : 'playwright is not installed' };

test('render.mode: always extracts JavaScript-generated content', opts, async () => {
  const { report, items } = await run({
    start_urls: [`${base}/`],
    render: { mode: 'always', wait_for_selector: '.item', wait_until: 'networkidle' },
    extract: {
      item: {
        selector: '.item',
        fields: {
          id: { attr: 'data-id', type: 'integer' },
          name: '.item__name',
          price: { selector: '.item__price', transform: ['currency'], type: 'number' },
        },
      },
    },
  });

  assert.equal(report.pages.rendered, 1);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Dynamic Alpha');
  assert.equal(items[0].id, 1);
  assert.equal(items[0].price, 19.99);
});

test('render.mode: auto escalates only when the content is missing', opts, async () => {
  const dynamic = await run({
    start_urls: [`${base}/`],
    render: { mode: 'auto', wait_for_selector: '.item', wait_until: 'networkidle' },
    extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
  });
  assert.equal(dynamic.report.pages.rendered, 1, 'the SPA page needs a browser');
  assert.equal(dynamic.items.length, 2);

  const staticPage = await run({
    start_urls: [`${base}/static`],
    render: { mode: 'auto', wait_for_selector: '.item', wait_until: 'networkidle' },
    extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
  });
  assert.equal(staticPage.report.pages.rendered, 0, 'server-rendered HTML must not start a browser');
  assert.equal(staticPage.items[0].name, 'Server Rendered');
});

test('actions drive the page, and optional actions tolerate absence', opts, async () => {
  const { items } = await run({
    start_urls: [`${base}/`],
    render: {
      mode: 'always',
      wait_for_selector: '.item',
      wait_until: 'networkidle',
      actions: [
        // This selector does not exist; `optional` must keep the run alive.
        { type: 'click', selector: '#cookie-accept', optional: true },
        { type: 'clickAll', selector: '#load-more', limit: 3, delay: 150 },
      ],
    },
    extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
  });

  assert.equal(items.length, 3, 'the load-more click should have added a third item');
  assert.equal(items[2].name, 'Lazy Gamma');
});

/* ────────────────────── cache + render interaction ─────────────────────── */

test('auto + cache: a second run extracts the same items as the first', opts, async () => {
  // The regression: the un-rendered shell was cached, so run 2 got a cache hit,
  // returned early, never escalated to a browser, and extracted nothing.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-rendercache-'));

  try {
    const recipe = {
      start_urls: [`${base}/`],
      render: { mode: 'auto', wait_for_selector: '.item', wait_until: 'networkidle' },
      cache: { enabled: true, dir },
      extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
    };

    const first = await run(recipe);
    assert.equal(first.report.pages.rendered, 1, 'run 1 must need a browser');
    assert.equal(first.items.length, 2);

    const second = await run(recipe);
    assert.deepEqual(
      second.items.map((i) => i.name),
      first.items.map((i) => i.name),
      'a cached run must yield the same records, not the empty shell',
    );
    assert.equal(second.report.pages.fromCache, 1, 'and it should come from cache');
    assert.equal(second.report.pages.rendered, 0, 'without launching a browser again');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('always + cache: the cache is actually used', opts, async () => {
  // The cache lookup used to sit *after* the render branch, so `always` mode
  // silently re-rendered every page on every run.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-rendercache2-'));

  try {
    const recipe = {
      start_urls: [`${base}/`],
      render: { mode: 'always', wait_for_selector: '.item', wait_until: 'networkidle' },
      cache: { enabled: true, dir },
      extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
    };

    const first = await run(recipe);
    assert.equal(first.report.pages.rendered, 1);
    assert.equal(first.items.length, 2);

    const second = await run(recipe);
    assert.equal(second.report.pages.fromCache, 1, 'run 2 should be served from cache');
    assert.equal(second.report.pages.rendered, 0, 'and must not launch a browser');
    assert.equal(second.items.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a rendered cache entry is not served to a render.mode: never run', opts, async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-rendercache3-'));

  try {
    const extract = { item: { selector: '.item', fields: { name: '.item__name' } } };

    // Populate the cache from a rendered run.
    await run({
      start_urls: [`${base}/`],
      render: { mode: 'always', wait_for_selector: '.item', wait_until: 'networkidle' },
      cache: { enabled: true, dir },
      extract,
    });

    // A run that doesn't want rendering may reuse it — a rendered body is a
    // superset of the raw one, so this is safe and saves a request.
    const plain = await run({
      start_urls: [`${base}/`],
      render: { mode: 'never' },
      cache: { enabled: true, dir },
      extract,
    });
    assert.equal(plain.report.pages.rendered, 0);
    assert.equal(plain.items.length, 2, 'the cached rendered body should still extract');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a required action that fails surfaces as a render error', opts, async () => {
  const { report } = await run({
    start_urls: [`${base}/`],
    retry: { max_attempts: 1 },
    render: {
      mode: 'always',
      wait_until: 'networkidle',
      timeout_ms: 3000,
      actions: [{ type: 'click', selector: '#does-not-exist', timeout: 1000 }],
    },
    extract: { item: { selector: '.item', fields: { name: '.item__name' } } },
  });

  assert.equal(report.pages.failed, 1);
  assert.equal(report.failures[0].reason, 'RENDER_ERROR');
});
