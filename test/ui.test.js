/**
 * Web UI tests — the HTTP API, auth, and a full run driven through it.
 *
 * A real server is started on an ephemeral port and driven with `fetch`, so
 * these cover the same paths the browser uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/ui/server.js';

let ui;
let workspace;
let site;
let base;

/* A tiny fixture site so runs don't touch the network. */
const PRODUCTS = [
  { id: 1, name: 'Alpha', price: '$10.00' },
  { id: 2, name: 'Beta', price: '$20.00' },
  { id: 3, name: 'Gamma', price: '$30.00' },
];

function listing() {
  // Deliberately padded with real prose: a page this small would otherwise trip
  // the "looks like an empty SPA shell" heuristic, which is correct behaviour
  // but not what this fixture is testing.
  return `<!doctype html><html><head><title>Fixture Shop</title></head><body>
    <header><h1>Fixture Shop</h1>
      <p>Everything in our catalogue is built to last, and every item ships within one working day.
         Browse the range below, compare the prices, and pick whichever suits you best.</p></header>
    <div class="grid">${PRODUCTS.map((p) => `
      <article class="card" data-sku="SKU-${p.id}">
        <h2 class="card__title"><a href="/p/${p.id}" title="${p.name} full name">${p.name}</a></h2>
        <span class="card__price">${p.price}</span>
        <p class="card__blurb">A dependable ${p.name.toLowerCase()} built to last for years of daily use.</p>
      </article>`).join('')}</div>
    <span class="next disabled">Next</span>
    <footer><p>Prices include tax. Delivery is calculated at checkout for your region.</p></footer>
    </body></html>`;
}

test.before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private\n');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(listing());
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;

  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-ui-'));
  ui = await createServer({ port: 0, workspace, version: 'test' });
});

test.after(async () => {
  await ui.close();
  await new Promise((resolve) => site.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
});

const root = () => `http://127.0.0.1:${ui.port}`;

async function call(method, path, body, { token = ui.token, headers = {} } = {}) {
  const res = await fetch(`${root()}${path}`, {
    method,
    headers: {
      ...(token ? { 'x-harvest-token': token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* not every response is JSON */ }
  return { status: res.status, body: json, res };
}

/* ────────────────────────────── auth ─────────────────────────────── */

test('the API rejects requests with no token', async () => {
  const { status, body } = await call('GET', '/api/bootstrap', null, { token: null });
  assert.equal(status, 401);
  assert.match(body.error, /Unauthorised/);
});

test('the API rejects a wrong token', async () => {
  const { status } = await call('GET', '/api/bootstrap', null, { token: 'not-the-token' });
  assert.equal(status, 401);
});

test('the API rejects a cross-origin request even with the token', async () => {
  const { status } = await call('GET', '/api/bootstrap', null, {
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(status, 401, 'a page on another origin must not be able to drive the scraper');
});

test('CORS preflight is refused outright', async () => {
  const res = await fetch(`${root()}/api/runs`, { method: 'OPTIONS' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('the token is injected into the page, not exposed on an endpoint', async () => {
  const res = await fetch(root());
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes(ui.token), 'the served page carries the session token');
  assert.ok(!html.includes('__HARVEST_TOKEN__'), 'the placeholder should be replaced');
  assert.ok(!html.includes('__HARVEST_NONCE__'), 'the nonce placeholder should be replaced');

  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-/, 'the inline token script needs a nonce to run');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the stylesheet keeps the rules the layout depends on', async () => {
  // Two CSS regressions that broke the interface badly enough to be worth
  // pinning: an author `display` beat the UA `[hidden]` rule and left an empty
  // dialog over the page, and a missing `white-space: pre` made the line-number
  // gutter reflow into a paragraph and crush the editor.
  const css = await (await fetch(`${root()}/styles.css`)).text();

  assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important/,
    '`hidden` must beat any author display rule');

  const gutter = /\.gutter\s*{([^}]*)}/.exec(css)?.[1] ?? '';
  assert.match(gutter, /white-space:\s*pre/, 'line numbers must not reflow');
  assert.match(gutter, /flex:\s*none/, 'the gutter must not grow or shrink');
});

test('a JavaScript recipe is reported as read-only', async () => {
  await fs.writeFile(path.join(workspace, 'js-recipe.js'),
    `export default { start_urls: ['${base}'], extract: { fields: { title: 'h1' } } };\n`, 'utf8');

  const js = await call('GET', '/api/recipes/js-recipe.js');
  assert.equal(js.status, 200);
  assert.equal(js.body.editable, false, 'a .js recipe cannot be safely edited in a textarea');
  assert.equal(js.body.valid, true);

  await fs.writeFile(path.join(workspace, 'yaml-recipe.yaml'), RECIPE(base), 'utf8');
  const yaml = await call('GET', '/api/recipes/yaml-recipe.yaml');
  assert.equal(yaml.body.editable, true);

  await fs.unlink(path.join(workspace, 'js-recipe.js'));
  await fs.unlink(path.join(workspace, 'yaml-recipe.yaml'));
});

test('static serving refuses path traversal', async () => {
  const res = await fetch(`${root()}/../package.json`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404, `expected a refusal, got ${res.status}`);
});

/* ──────────────────────────── bootstrap ──────────────────────────── */

test('bootstrap describes the environment', async () => {
  const { status, body } = await call('GET', '/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(body.version, 'test');
  assert.equal(body.workspace, workspace);
  assert.ok(Array.isArray(body.presets) && body.presets.includes('careful'));
  assert.ok(body.templates.includes('basic'));
  assert.ok(body.transforms.includes('currency'));
});

/* ───────────────────────────── recipes ───────────────────────────── */

const RECIPE = (url) => [
  'name: fixture',
  `start_urls: ["${url}"]`,
  'rate_limit: { requests_per_second: 100, jitter_ms: 0 }',
  'extract:',
  '  item:',
  '    selector: "article.card"',
  '    fields:',
  '      sku: { attr: data-sku }',
  '      title: { selector: "a[title]", attr: title }',
  '      price: { selector: ".card__price", transform: [currency], type: number }',
  '',
].join('\n');

test('a recipe can be created, listed, read and deleted', async () => {
  const save = await call('PUT', '/api/recipes/test.yaml', { text: RECIPE(base) });
  assert.equal(save.status, 200);
  assert.equal(save.body.valid, true);

  const list = await call('GET', '/api/recipes');
  assert.ok(list.body.some((r) => r.name === 'test.yaml' && r.valid));

  const read = await call('GET', '/api/recipes/test.yaml');
  assert.equal(read.status, 200);
  assert.match(read.body.text, /article\.card/);
  assert.equal(read.body.editable, true);

  const removed = await call('DELETE', '/api/recipes/test.yaml');
  assert.equal(removed.status, 200);

  const gone = await call('GET', '/api/recipes/test.yaml');
  assert.equal(gone.status, 404);
});

test('project files that share a recipe extension are not listed as recipes', async () => {
  // Running the interface from a project root should not present package.json
  // as a broken recipe.
  await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"x"}', 'utf8');
  await fs.writeFile(path.join(workspace, 'package-lock.json'), '{}', 'utf8');
  await fs.writeFile(path.join(workspace, 'vite.config.js'), 'export default {}', 'utf8');
  await fs.writeFile(path.join(workspace, '.eslintrc.json'), '{}', 'utf8');
  await fs.writeFile(path.join(workspace, 'real.yaml'), RECIPE(base), 'utf8');

  const { body } = await call('GET', '/api/recipes');
  const names = body.map((r) => r.name);

  assert.ok(names.includes('real.yaml'));
  for (const noise of ['package.json', 'package-lock.json', 'vite.config.js', '.eslintrc.json']) {
    assert.ok(!names.includes(noise), `${noise} should not be listed`);
  }

  await fs.unlink(path.join(workspace, 'real.yaml'));
});

test('recipe names cannot escape the workspace', async () => {
  for (const name of ['../escape.yaml', '..%2Fescape.yaml', 'sub/dir.yaml', '.hidden.yaml']) {
    const { status } = await call('PUT', `/api/recipes/${encodeURIComponent(name)}`, { text: 'x' });
    assert.equal(status, 400, `'${name}' should be refused`);
  }
});

test('a recipe must have a known extension', async () => {
  const { status, body } = await call('PUT', '/api/recipes/notes.txt', { text: 'x' });
  assert.equal(status, 400);
  assert.match(body.error, /must end in/);
});

/* ──────────────────────────── validation ─────────────────────────── */

test('validation reports a clean recipe with a summary', async () => {
  const { body } = await call('POST', '/api/validate', { text: RECIPE(base) });
  assert.equal(body.valid, true);
  assert.deepEqual(body.summary.fields, ['sku', 'title', 'price']);
  assert.equal(body.summary.itemSelector, 'article.card');
  assert.equal(body.summary.robots, true);
});

test('validation returns errors instead of throwing', async () => {
  const { status, body } = await call('POST', '/api/validate', {
    text: 'start_urls: ["https://x.com"]\nextract:\n  fields:\n    a: { selector: "h1", transform: [nope] }\n',
  });
  assert.equal(status, 200, 'an invalid recipe is a normal answer, not an HTTP error');
  assert.equal(body.valid, false);
  assert.ok(body.errors.some((e) => /unknown transform/i.test(e)));
});

test('a template can be fetched for the new-recipe flow', async () => {
  const { status, body } = await call('GET', '/api/templates/crawl');
  assert.equal(status, 200);
  assert.match(body.text, /crawl:/);
  assert.equal((await call('GET', '/api/templates/nope')).status, 404);
});

/* ───────────────────────────── inspect ───────────────────────────── */

test('inspect analyses a page and suggests selectors', async () => {
  const { status, body } = await call('POST', '/api/inspect', { url: base });
  assert.equal(status, 200);
  assert.equal(body.blocked, false);

  const a = body.analysis;
  assert.equal(a.title, 'Fixture Shop');
  assert.equal(a.needsJavaScript, false);
  assert.ok(a.repeatedBlocks.some((b) => b.selector === 'article.card' && b.count === 3));
  assert.ok(Object.keys(a.suggestions.listFields).includes('price'));
});

test('inspect refuses a robots-disallowed URL', async () => {
  const { body } = await call('POST', '/api/inspect', { url: `${base}/private/x` });
  assert.equal(body.blocked, true);
  assert.match(body.message, /robots\.txt/);
});

test('inspect rejects a non-HTTP URL', async () => {
  const { status, body } = await call('POST', '/api/inspect', { url: 'file:///etc/passwd' });
  assert.equal(status, 400);
  assert.match(body.error, /http and https/);
});

test('generate produces a runnable recipe', async () => {
  const { status, body } = await call('POST', '/api/generate', { url: base, name: 'generated.yaml' });
  assert.equal(status, 200);
  assert.match(body.yaml, /start_urls:/);

  const check = await call('POST', '/api/validate', { text: body.yaml });
  assert.equal(check.body.valid, true, `generated recipe should validate: ${check.body.errors}`);
});

/* ────────────────────────────── test run ─────────────────────────── */

test('test fetches one page and reports field coverage', async () => {
  const { status, body } = await call('POST', '/api/test', { text: RECIPE(base) });
  assert.equal(status, 200);
  assert.equal(body.blocked, false);
  assert.equal(body.containersMatched, 3);
  assert.equal(body.itemCount, 3);
  assert.equal(body.items[0].title, 'Alpha full name');
  assert.equal(body.items[0].price, 10);
  assert.equal(body.items[0].sku, 'SKU-1');

  for (const field of body.coverage) {
    assert.equal(field.rate, 100, `${field.field} should be fully populated`);
  }
});

test('test reports a container selector that matches nothing', async () => {
  const broken = RECIPE(base).replace('article.card', '.does-not-exist');
  const { body } = await call('POST', '/api/test', { text: broken });
  assert.equal(body.containersMatched, 0);
  assert.equal(body.itemCount, 0);
  assert.ok(body.issues.some((i) => /No elements matched/.test(i)));
});

/* ──────────────────────────── full runs ──────────────────────────── */

/** Drive a run to completion over the SSE stream, collecting the events. */
async function runToCompletion(payload) {
  const start = await call('POST', '/api/runs', payload);
  assert.equal(start.status, 200, `run should start: ${JSON.stringify(start.body)}`);
  const id = start.body.id;

  const res = await fetch(`${root()}/api/runs/${id}/stream?token=${encodeURIComponent(ui.token)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let split;
    // eslint-disable-next-line no-cond-assign
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const name = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
    if (events.some((e) => e.name === 'end')) break;
  }
  return { id, events };
}

test('a run streams progress and finishes', async () => {
  const { id, events } = await runToCompletion({ text: RECIPE(base), name: 'fixture.yaml' });

  const names = events.map((e) => e.name);
  assert.ok(names.includes('snapshot'), 'a late subscriber gets the current state');
  assert.ok(names.includes('item'), 'records stream as they are extracted');
  assert.ok(names.includes('end'));

  const end = events.find((e) => e.name === 'end').data;
  assert.equal(end.status, 'done');
  assert.equal(end.items, 3);
  assert.ok(end.report, 'the final event carries the run report');
  assert.ok(end.stats, 'the final event carries the last stats sample');
  assert.equal(end.report.pages.ok, 1);

  const items = events.filter((e) => e.name === 'item').map((e) => e.data);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Alpha full name');

  const detail = await call('GET', `/api/runs/${id}`);
  assert.equal(detail.body.status, 'done');
});

test('run data is readable after the run and downloadable in every format', async () => {
  const { id } = await runToCompletion({ text: RECIPE(base), name: 'fixture.yaml' });

  const data = await call('GET', `/api/runs/${id}/data`);
  assert.equal(data.body.total, 3);
  assert.equal(data.body.items.length, 3);

  for (const [format, check] of [
    ['ndjson', (t) => t.trim().split('\n').length === 3],
    ['json', (t) => JSON.parse(t).length === 3],
    ['csv', (t) => t.trim().split('\n').length === 4],
  ]) {
    const res = await fetch(`${root()}/api/runs/${id}/download?format=${format}&token=${encodeURIComponent(ui.token)}`);
    assert.equal(res.status, 200, `${format} download should succeed`);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=/);
    assert.ok(check(await res.text()), `${format} download should contain 3 records`);
  }

  const xlsx = await fetch(`${root()}/api/runs/${id}/download?format=xlsx&token=${encodeURIComponent(ui.token)}`);
  assert.equal(xlsx.status, 200);
  const buffer = Buffer.from(await xlsx.arrayBuffer());
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'xlsx should be a zip archive');
});

test('CLI overrides from the run options panel are applied', async () => {
  const { events } = await runToCompletion({
    text: RECIPE(base),
    name: 'fixture.yaml',
    overrides: { max_pages: 1, concurrency: 1 },
  });
  const end = events.find((e) => e.name === 'end').data;
  assert.equal(end.report.pages.ok, 1);
});

test('a preset can be layered onto a run', async () => {
  const { events } = await runToCompletion({
    text: RECIPE(base),
    name: 'fixture.yaml',
    presets: ['careful'],
  });
  assert.equal(events.find((e) => e.name === 'end').data.status, 'done');
});

test('an invalid recipe fails to start with a useful message', async () => {
  const { status, body } = await call('POST', '/api/runs', {
    text: 'start_urls: []\nextract: { fields: { a: "h1" } }\n',
  });
  assert.equal(status, 400);
  assert.match(body.error, /start_urls/);
});

test('runs appear in the list and can be deleted', async () => {
  const { id } = await runToCompletion({ text: RECIPE(base), name: 'fixture.yaml' });

  const list = await call('GET', '/api/runs');
  assert.ok(list.body.some((r) => r.id === id));

  assert.equal((await call('DELETE', `/api/runs/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/runs/${id}`)).status, 404);
});

test('stopping an unknown run is a 404, not a crash', async () => {
  assert.equal((await call('POST', '/api/runs/nope/stop')).status, 404);
});

/* ───────────────────────────── robots ────────────────────────────── */

test('the robots endpoint reports the verdict', async () => {
  const allowed = await call('POST', '/api/robots', { url: base });
  assert.equal(allowed.body.allowed, true);

  const denied = await call('POST', '/api/robots', { url: `${base}/private/x` });
  assert.equal(denied.body.allowed, false);
  assert.match(denied.body.reason, /disallow/);
});
