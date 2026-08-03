import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig, normalizeKeys, deepMerge } from '../src/config/schema.js';
import { loadRecipe, defineRecipe, interpolateEnv } from '../src/config/loader.js';
import { ConfigError } from '../src/utils/errors.js';

const minimal = (extra = {}) => ({
  start_urls: ['https://example.com'],
  extract: { fields: { title: 'h1' } },
  ...extra,
});

test('snake_case recipe keys become camelCase config keys', () => {
  const { config } = normalizeConfig(minimal({
    max_pages: 10,
    rate_limit: { requests_per_second: 3, min_delay_ms: 500 },
    circuit_breaker: { failure_threshold: 9 },
  }));
  assert.equal(config.maxPages, 10);
  assert.equal(config.rateLimit.requestsPerSecond, 3);
  assert.equal(config.rateLimit.minDelayMs, 500);
  assert.equal(config.circuitBreaker.failureThreshold, 9);
});

test('user field names are never renamed', () => {
  const { config } = normalizeConfig(minimal({
    extract: {
      item: {
        selector: '.row',
        fields: {
          in_stock: { selector: '.stock', transform: ['boolean'] },
          product_name: 'h2',
          'Price (USD)': { selector: '.p', transform: ['currency'] },
        },
      },
    },
  }));

  const fields = config.extract.item.fields;
  assert.ok('in_stock' in fields, 'in_stock must not become inStock');
  assert.ok('product_name' in fields);
  assert.ok('Price (USD)' in fields);
});

test('field spec keys inside a field are still normalised', () => {
  const { config } = normalizeConfig(minimal({
    extract: { fields: { my_field: { selector: 'h1', keep_empty: true } } },
  }));
  assert.equal(config.extract.fields.my_field.keepEmpty, true);
});

test('HTTP header names keep their exact casing', () => {
  const { config } = normalizeConfig(minimal({
    http: { headers: { 'X-Custom-Header': 'a', 'accept_language': 'en' } },
  }));
  assert.equal(config.http.headers['X-Custom-Header'], 'a');
  assert.ok('accept_language' in config.http.headers, 'header names are data, not config keys');
});

test('validation schema field names are preserved but rules are normalised', () => {
  const { config } = normalizeConfig(minimal({
    validate: {
      on_invalid: 'drop',
      schema: { in_stock: { required: true }, title: { min_length: 3 } },
    },
  }));
  assert.equal(config.validate.onInvalid, 'drop');
  assert.ok('in_stock' in config.validate.schema);
  assert.equal(config.validate.schema.title.minLength, 3);
});

test('meta payloads survive untouched', () => {
  const { config } = normalizeConfig(minimal({
    start_urls: [{ url: 'https://example.com', meta: { my_key: 'v', nested: { another_key: 1 } } }],
  }));
  assert.equal(config.startUrls[0].meta.my_key, 'v');
  assert.equal(config.startUrls[0].meta.nested.another_key, 1);
});

test('route labels inside extract keep their names', () => {
  const { config } = normalizeConfig(minimal({
    start_urls: [{ url: 'https://example.com', label: 'product_detail' }],
    extract: {
      product_detail: { fields: { the_title: 'h1' } },
      listing: { fields: {} },
    },
  }));
  assert.ok('product_detail' in config.extract, 'a route label must not be renamed');
  assert.ok('the_title' in config.extract.product_detail.fields);
});

test('normalizeKeys leaves functions and dates alone', () => {
  const fn = () => {};
  const date = new Date();
  const out = normalizeKeys({ my_fn: fn, my_date: date });
  assert.equal(out.myFn, fn);
  assert.equal(out.myDate, date);
});

test('deepMerge replaces arrays rather than concatenating them', () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});

test('aliases map onto their canonical keys', () => {
  const { config } = normalizeConfig({
    urls: ['https://example.com'],
    workers: 8,
    rps: 5,
    limit: 42,
    fields: { title: 'h1' },
  });
  assert.equal(config.startUrls[0].url, 'https://example.com');
  assert.equal(config.concurrency, 8);
  assert.equal(config.rateLimit.requestsPerSecond, 5);
  assert.equal(config.maxPages, 42);
  assert.equal(config.extract.fields.title, 'h1');
});

test('loose shapes are coerced into canonical ones', () => {
  const { config } = normalizeConfig(minimal({
    output: 'data.csv',
    proxy: 'http://proxy:8080',
    render: true,
    cache: true,
    crawl: { follow: '.item a', allowed_domains: 'example.com' },
  }));
  assert.deepEqual(config.output, ['data.csv']);
  assert.deepEqual(config.proxy.urls, ['http://proxy:8080']);
  assert.equal(config.render.mode, 'always');
  assert.equal(config.cache.enabled, true);
  assert.deepEqual(config.crawl.follow, [{ selector: '.item a' }]);
  assert.deepEqual(config.crawl.allowedDomains, ['example.com']);
});

test('a crawl is confined to the seed hosts unless told otherwise', () => {
  const { config } = normalizeConfig(minimal({
    start_urls: ['https://a.com/x', 'https://b.com/y'],
    crawl: { follow: [{ selector: 'a' }] },
  }));
  assert.deepEqual(config.crawl.allowedDomains.sort(), ['a.com', 'b.com']);
});

test('presets layer under the recipe', () => {
  const { config } = normalizeConfig(minimal({ concurrency: 3 }), { presets: ['fast'] });
  assert.equal(config.concurrency, 3, 'the recipe wins over the preset');
  assert.equal(config.rateLimit.requestsPerSecond, 8, 'the preset still applies elsewhere');
});

test('an unknown preset is rejected by name', () => {
  assert.throws(() => normalizeConfig(minimal(), { presets: ['turbo'] }), /Unknown preset 'turbo'/);
});

/* ─────────────────────────── validation errors ─────────────────────────── */

test('a recipe with no start URLs is rejected', () => {
  assert.throws(() => normalizeConfig({ extract: { fields: { a: 'h1' } } }), /start_urls.*is empty/s);
});

test('an invalid start URL is named in the error', () => {
  assert.throws(() => normalizeConfig({
    start_urls: ['not a url'],
    extract: { fields: { a: 'h1' } },
  }), /start_urls\[0\]/);
});

test('an unknown transform is caught before the run starts', () => {
  assert.throws(
    () => normalizeConfig(minimal({ extract: { fields: { a: { selector: 'h1', transform: ['nope'] } } } })),
    /unknown transform 'nope'/i,
  );
});

test('malformed XPath is caught before the run starts', () => {
  assert.throws(
    () => normalizeConfig(minimal({ extract: { fields: { a: { xpath: '//div[' } } } })),
    /invalid XPath/,
  );
});

test('an invalid regex is caught before the run starts', () => {
  assert.throws(
    () => normalizeConfig(minimal({ extract: { fields: { a: { selector: 'h1', regex: '(' } } } })),
    /regex/,
  );
});

test('a field with no source is rejected', () => {
  assert.throws(
    () => normalizeConfig(minimal({ extract: { fields: { a: { transform: ['trim'] } } } })),
    /needs one of/,
  );
});

test('a bare `attr` field is accepted as a self-reference', () => {
  const { config } = normalizeConfig(minimal({
    extract: { item: { selector: '.row', fields: { id: { attr: 'data-id' } } } },
  }));
  assert.equal(config.extract.item.fields.id.attr, 'data-id');
});

test('an unknown `from:` source lists the valid ones', () => {
  assert.throws(
    () => normalizeConfig(minimal({ extract: { fields: { a: { from: 'telepathy' } } } })),
    /unknown `from: telepathy`/,
  );
});

test('an unknown output format is rejected', () => {
  assert.throws(
    () => normalizeConfig(minimal({ output: [{ format: 'parquet' }] })),
    /unknown format 'parquet'/,
  );
});

test('dedupe by fields without key_fields is rejected', () => {
  assert.throws(
    () => normalizeConfig(minimal({ dedupe: { strategy: 'fields' } })),
    /requires `dedupe.key_fields`/,
  );
});

test('an unknown top-level key produces a warning, not a failure', () => {
  const { warnings } = normalizeConfig(minimal({ conccurency: 4 }), { strict: true });
  assert.ok(warnings.some((w) => w.includes('conccurency')));
  assert.ok(warnings.some((w) => w.includes('concurrency')), 'the suggestion should name the real key');
});

/* ───────────────────────────── file loading ────────────────────────────── */

test('interpolateEnv substitutes variables and defaults', () => {
  const env = { TOKEN: 'secret123' };
  assert.equal(interpolateEnv('Bearer ${TOKEN}', env), 'Bearer secret123');
  assert.equal(interpolateEnv('${MISSING:-fallback}', env), 'fallback');
  assert.equal(interpolateEnv('${UNSET}', env), '${UNSET}');
});

test('a YAML recipe loads, interpolates and resolves relative paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvester-recipe-'));
  try {
    const file = path.join(dir, 'shop.yaml');
    await fs.writeFile(file, [
      'name: shop',
      'start_urls:',
      '  - https://example.com/products',
      'http:',
      '  headers:',
      '    authorization: "Bearer ${MY_TOKEN:-none}"',
      'extract:',
      '  item:',
      '    selector: ".product"',
      '    fields:',
      '      in_stock:',
      '        selector: ".stock"',
      '        transform: [boolean]',
      'output:',
      '  - out/data.csv',
    ].join('\n'), 'utf8');

    const { config } = await loadRecipe(file);
    assert.equal(config.name, 'shop');
    assert.equal(config.http.headers.authorization, 'Bearer none');
    assert.ok('in_stock' in config.extract.item.fields);
    assert.equal(config.output[0], path.resolve(dir, 'out/data.csv'),
      'relative output paths resolve against the recipe, not the cwd');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a .env file next to the recipe supplies variables', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvester-recipe-'));
  try {
    await fs.writeFile(path.join(dir, '.env'), 'MY_TOKEN=from-dotenv\n', 'utf8');
    const file = path.join(dir, 'r.yaml');
    await fs.writeFile(file, [
      'start_urls: ["https://example.com"]',
      'http: { headers: { authorization: "${MY_TOKEN}" } }',
      'extract: { fields: { a: "h1" } }',
    ].join('\n'), 'utf8');

    const { config } = await loadRecipe(file);
    assert.equal(config.http.headers.authorization, 'from-dotenv');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing recipe file gives an actionable error', async () => {
  await assert.rejects(() => loadRecipe('./definitely-not-here.yaml'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /harvest init/);
    return true;
  });
});

test('invalid YAML reports the line number', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvester-recipe-'));
  try {
    const file = path.join(dir, 'bad.yaml');
    await fs.writeFile(file, 'start_urls:\n  - a\n   bad indent: [\n', 'utf8');
    await assert.rejects(() => loadRecipe(file), /Invalid YAML/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('defineRecipe exposes hooks from the recipe object', () => {
  const onItem = (item) => item;
  const { hooks } = defineRecipe({ ...minimal(), hooks: { onItem } });
  assert.equal(hooks.onItem, onItem);
});
