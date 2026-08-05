/**
 * Performance-behaviour tests.
 *
 * These pin the throughput and correctness defects fixed in the performance
 * overhaul. Several of them fail on the pre-fix code, which is the point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from '../src/resilience/ratelimiter.js';
import { normalizeConfig } from '../src/config/schema.js';
import { Page } from '../src/parse/dom.js';
import { extractItems } from '../src/parse/extractor.js';
import { Deduplicator } from '../src/process/dedupe.js';
import { Metrics } from '../src/observability/metrics.js';
import { predictPacing, project } from '../src/cli/profile.js';

/* ───────────────────────── rate limiter pacing ─────────────────────────── */

/**
 * Drive a limiter on a virtual clock and report the mean interval it achieves.
 * The clock is installed before construction so the token bucket's own
 * `lastRefill` is on the same timeline.
 */
function pace({ n = 400, ...options }) {
  let t = Date.now();
  const realNow = Date.now;
  Date.now = () => t;
  const gaps = [];
  try {
    const host = new RateLimiter(options).forHost('x.com');
    let prev = null;
    for (let i = 0; i < n; i += 1) {
      for (let guard = 0; guard < 500; guard += 1) {
        const wait = host.delayUntilReady();
        if (wait <= 0) break;
        t += wait;
      }
      if (prev !== null) gaps.push(t - prev);
      prev = t;
      host.consume();
    }
  } finally {
    Date.now = realNow;
  }
  return {
    mean: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    min: Math.min(...gaps),
    rps: gaps.length / (gaps.reduce((a, b) => a + b, 0) / 1000),
  };
}

test('the achieved rate tracks the configured rate at every scale', () => {
  // The old absolute jitter added a flat ~125 ms per request, which capped
  // throughput at ~8 req/s no matter what was configured.
  for (const rps of [0.33, 1, 8, 50]) {
    const ratio = 0.25;
    const result = pace({ requestsPerSecond: rps, jitterRatio: ratio });
    const expected = (1000 / rps) * (1 + ratio / 2);
    const drift = Math.abs(result.mean - expected) / expected;
    assert.ok(drift < 0.05, `rps ${rps}: mean ${result.mean.toFixed(1)}ms vs expected ${expected.toFixed(1)}ms`);
  }
});

test('a high configured rate is actually reachable', () => {
  const { rps } = pace({ requestsPerSecond: 50, jitterRatio: 0.05 });
  assert.ok(rps > 40, `expected >40 req/s at rps 50, got ${rps.toFixed(1)}`);
});

test('jitter_ratio: 0 gives exact pacing', () => {
  const { mean, min } = pace({ requestsPerSecond: 4, jitterRatio: 0 });
  assert.ok(Math.abs(mean - 250) < 5, `expected ~250ms, got ${mean}`);
  assert.ok(min >= 250, 'exact pacing must never undercut the interval');
});

test('jitter never undercuts min_delay_ms or a Crawl-delay', () => {
  const floor = pace({ requestsPerSecond: 100, minDelayMs: 500, jitterRatio: 0.5 });
  assert.ok(floor.min >= 500, `min_delay_ms violated: ${floor.min}ms`);

  let t = Date.now();
  const realNow = Date.now;
  Date.now = () => t;
  try {
    const host = new RateLimiter({ requestsPerSecond: 100, jitterRatio: 0.5 }).forHost('x.com');
    host.setCrawlDelay(10);
    host.consume();
    t += 1;
    assert.ok(host.delayUntilReady() >= 9000, 'a 10s Crawl-delay must dominate a fast configured rate');
  } finally {
    Date.now = realNow;
  }
});

test('burst credit is spent before pacing kicks in', () => {
  let t = Date.now();
  const realNow = Date.now;
  Date.now = () => t;
  try {
    const host = new RateLimiter({ requestsPerSecond: 1, burst: 5, jitterRatio: 0.25 }).forHost('x.com');
    for (let i = 0; i < 5; i += 1) {
      assert.equal(host.delayUntilReady(), 0, `burst request ${i + 1} should go immediately`);
      host.consume();
    }
    assert.ok(host.delayUntilReady() > 0, 'the sixth request must wait');
  } finally {
    Date.now = realNow;
  }
});

test('readiness and consume are atomic — two workers cannot both dispatch', async () => {
  // The old `acquire()` slept for jitter *between* the readiness test and
  // `consume()`. That yield let two workers on one host both pass the test and
  // both dispatch, bypassing the bucket in pairs.
  const limiter = new RateLimiter({ requestsPerSecond: 2, burst: 1, jitterRatio: 0 });
  const started = Date.now();
  await Promise.all([limiter.acquire('x.com'), limiter.acquire('x.com')]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 400, `two acquires at 2 req/s should span ~500ms, took ${elapsed}ms`);
});

test('legacy jitter_ms is converted, not ignored', () => {
  // Direct API use.
  const direct = new RateLimiter({ requestsPerSecond: 1, jitterMs: 250 });
  assert.equal(direct.config.jitterRatio, 0.25);
  assert.equal(new RateLimiter({ requestsPerSecond: 1, jitterMs: 0 }).config.jitterRatio, 0);

  // Through a recipe.
  const { config, warnings } = normalizeConfig({
    start_urls: ['https://x.com'],
    extract: { fields: { a: 'h1' } },
    rate_limit: { requests_per_second: 4, jitter_ms: 100 },
  });
  assert.equal(config.rateLimit.jitterRatio, 0.4, '100ms of a 250ms interval is 0.4');
  assert.equal(config.rateLimit.jitterMs, undefined);
  assert.ok(warnings.some((w) => /jitter_ms/.test(w)), 'the conversion should be announced');
});

test('the default is unchanged from the old absolute jitter', () => {
  // Backwards compatibility: at 1 req/s, ratio 0.25 spans exactly [1000, 1250)
  // — the same distribution the old `jitter_ms: 250` produced.
  const legacy = pace({ requestsPerSecond: 1, jitterMs: 250 });
  const modern = pace({ requestsPerSecond: 1, jitterRatio: 0.25 });
  assert.ok(Math.abs(legacy.mean - modern.mean) < 25, `${legacy.mean} vs ${modern.mean}`);
  assert.ok(Math.abs(modern.mean - 1125) < 25, `expected ~1125ms, got ${modern.mean}`);
});

test('the limiter reports whether Crawl-delay is what sets the pace', () => {
  const limiter = new RateLimiter({ requestsPerSecond: 1 });
  const host = limiter.forHost('x.com');
  assert.equal(host.crawlDelayBinding, false);

  host.setCrawlDelay(10);
  assert.equal(host.crawlDelayBinding, true, '10s beats the 1s configured interval');

  const fast = new RateLimiter({ requestsPerSecond: 50 }).forHost('y.com');
  fast.setCrawlDelay(0.005);
  assert.equal(fast.crawlDelayBinding, false, '5ms does not beat a 20ms interval');
});

/* ─────────────────────────── metrics accounting ────────────────────────── */

test('requestsPerSec avoids the percentile sort', () => {
  const metrics = new Metrics();
  for (let i = 0; i < 500; i += 1) metrics.observe('request_duration_ms', i);
  metrics.increment('requests_total', 100);

  let sorted = 0;
  const hist = metrics.histograms.get('request_duration_ms');
  const original = hist.percentile.bind(hist);
  hist.percentile = (p) => { sorted += 1; return original(p); };

  const value = metrics.requestsPerSec;
  assert.ok(value > 0);
  assert.equal(sorted, 0, 'reading the rate must not compute percentiles');
});

test('histograms expose their total, for time-share accounting', () => {
  const metrics = new Metrics();
  metrics.observe('x_ms', 10);
  metrics.observe('x_ms', 30);
  assert.equal(metrics.totalMs('x_ms'), 40);
  assert.equal(metrics.histograms.get('x_ms').snapshot().sum, 40);
});

test('timeSync records synchronous work', () => {
  const metrics = new Metrics();
  const result = metrics.timeSync('work_ms', () => 42);
  assert.equal(result, 42);
  assert.equal(metrics.histograms.get('work_ms').count, 1);
});

/* ──────────────────────────── parse memoisation ────────────────────────── */

const JSON_BODY = JSON.stringify({
  data: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Item ${i}` })),
});

test('a from: json field parses the body once, not once per record', () => {
  const page = new Page({ html: JSON_BODY, url: 'https://api.test/items' });

  let parses = 0;
  const original = page.json.bind(page);
  page.json = () => { parses += 1; return original(); };

  const { items } = extractItems({
    item: {
      // 40 containers, each reading two `from: json` fields.
      selector: 'body',
      fields: {
        first: { from: 'json', path: 'data.0.name' },
        count: { from: 'json', path: 'data.0.id' },
      },
    },
  }, page);

  assert.ok(items.length >= 1);
  // The memo lives on the page, so repeated reads are free regardless of how
  // many per-record contexts the extractor builds.
  assert.equal(page.json(), original(), 'the parsed body should be identical between calls');
  assert.ok(parses <= 3, `expected the body to be parsed once, saw ${parses} calls`);
});

test('page.json() memoises and survives a failed parse', () => {
  const page = new Page({ html: JSON_BODY, url: 'https://api.test/x' });
  assert.equal(page.json(), page.json(), 'same object identity on repeat calls');
  assert.equal(page.json().data.length, 40);

  const html = new Page({ html: '<html><body>not json</body></html>', url: 'https://x.test/' });
  assert.equal(html.json(), null);
  assert.equal(html.json(), null, 'a failed parse is memoised too, not retried');
});

const MICRODATA = `<html><body>${Array.from({ length: 20 }, (_, i) => `
  <div class="q" itemscope itemtype="http://schema.org/CreativeWork">
    <span itemprop="text">Quote ${i}</span><small itemprop="author">Author ${i}</small>
  </div>`).join('')}</body></html>`;

test('page readers are memoised, and per-selector where relevant', () => {
  const page = new Page({ html: MICRODATA, url: 'https://x.test/' });

  assert.equal(page.microdata(), page.microdata(), 'microdata is memoised');
  assert.equal(page.metaTags(), page.metaTags(), 'metaTags is memoised');
  assert.equal(page.tables(), page.tables(), 'tables is memoised');
  assert.equal(page.text('body'), page.text('body'));

  // Per-selector memos must not collide with each other.
  assert.notEqual(page.tables('table.a'), page.tables('table.b'));
  assert.equal(page.tables('table.a'), page.tables('table.a'));
});

test('metaTags is frozen — it is handed to user code by reference', () => {
  const page = new Page({ html: '<html><head><meta name="a" content="1"></head></html>', url: 'https://x.test/' });
  const meta = page.metaTags();
  assert.equal(meta.a, '1');
  assert.throws(() => { 'use strict'; meta.a = 'mutated'; }, TypeError);
});

test('invalidate() clears the memos after a DOM mutation', () => {
  const page = new Page({ html: '<html><head><meta name="a" content="1"></head><body></body></html>', url: 'https://x.test/' });
  assert.equal(page.metaTags().a, '1');

  // An `onPage` hook may rewrite the document.
  page.$('head').append('<meta name="b" content="2">');
  assert.equal(page.metaTags().b, undefined, 'stale until invalidated');

  page.invalidate();
  assert.equal(page.metaTags().b, '2');
});

/* ──────────────────────────────── dedupe ───────────────────────────────── */

test('case and whitespace normalisation applies inside records', () => {
  // Previously `normalizeForKey` stringified objects before normalising, so
  // both options were silently dead for the default `record` strategy.
  const d = new Deduplicator({ strategy: 'record' });
  assert.equal(d.check({ title: 'Widget' }).duplicate, false);
  assert.equal(d.check({ title: 'widget' }).duplicate, true, 'case should be folded by default');
  assert.equal(d.check({ title: '  Widget  ' }).duplicate, true, 'whitespace should be folded');

  const strict = new Deduplicator({ strategy: 'record', caseSensitive: true });
  assert.equal(strict.check({ title: 'Widget' }).duplicate, false);
  assert.equal(strict.check({ title: 'widget' }).duplicate, false, 'case_sensitive must be honoured');
});

test('nested values are normalised too', () => {
  const d = new Deduplicator({ strategy: 'record' });
  assert.equal(d.check({ a: { b: ['X ', 'Y'] } }).duplicate, false);
  assert.equal(d.check({ a: { b: ['x', 'y'] } }).duplicate, true);
});

test('key order still does not affect the hash', () => {
  const d = new Deduplicator({ strategy: 'record' });
  assert.equal(d.check({ a: 1, b: 2 }).duplicate, false);
  assert.equal(d.check({ b: 2, a: 1 }).duplicate, true);
});

test('a persisted store from an older key version is refused, not silently reused', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-dedupe-'));
  const file = path.join(dir, 'seen.json');
  try {
    await fs.writeFile(file, JSON.stringify({ store: 'set', hashes: ['abc'], keyVersion: 1 }), 'utf8');

    const d = new Deduplicator({ persistPath: file });
    assert.equal(await d.load(), 0, 'an incompatible store must not be loaded');
    assert.ok(d.incompatibleStore, 'and the caller must be told');
    assert.match(d.incompatibleStore.message, /older version/);

    // A store it wrote itself round-trips.
    d.incompatibleStore = null;
    d.check({ id: 1 });
    await d.save();
    const fresh = new Deduplicator({ persistPath: file });
    assert.equal(await fresh.load(), 1);
    assert.equal(fresh.incompatibleStore, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ──────────────────────────── profile arithmetic ───────────────────────── */

test('predictPacing reproduces the pacing formula', () => {
  const config = (rate) => normalizeConfig({
    start_urls: ['https://x.com'],
    extract: { fields: { a: 'h1' } },
    rate_limit: rate,
  }).config;

  assert.equal(predictPacing(config({ requests_per_second: 1, jitter_ratio: 0.25 })).rps, 0.889);
  assert.equal(predictPacing(config({ requests_per_second: 1, jitter_ratio: 0 })).rps, 1);

  const fast = predictPacing(config({ requests_per_second: 50, jitter_ratio: 0.05 }));
  assert.ok(fast.rps > 45, `expected >45 req/s, got ${fast.rps}`);

  // A hard floor overrides the rate entirely.
  const floored = predictPacing(config({ requests_per_second: 10, min_delay_ms: 2000, jitter_ratio: 0 }));
  assert.equal(floored.rps, 0.5);
});

test('project converts a rate into a duration', () => {
  assert.equal(project({ recordsPerSecond: 2, targetRecords: 1000 }), 500_000);
  assert.equal(project({ recordsPerSecond: 0, targetRecords: 1000 }), null);
});

/* ─────────────────────────── authorization posture ─────────────────────── */

test('an aggressive rate warns unless a basis is declared', () => {
  const base = { start_urls: ['https://x.com'], extract: { fields: { a: 'h1' } } };

  const loud = normalizeConfig({ ...base, rate_limit: { requests_per_second: 20 } });
  assert.ok(loud.warnings.some((w) => /well above the polite default/.test(w)));

  const declared = normalizeConfig({
    ...base,
    rate_limit: { requests_per_second: 20 },
    authorization: { basis: 'owner', note: 'my own site' },
  });
  assert.ok(!declared.warnings.some((w) => /well above the polite default/.test(w)));
  assert.equal(declared.config.authorization.basis, 'owner');

  const quiet = normalizeConfig({ ...base, rate_limit: { requests_per_second: 1 } });
  assert.ok(!quiet.warnings.some((w) => /well above the polite default/.test(w)));
});

test('an unknown authorization basis is rejected', () => {
  assert.throws(() => normalizeConfig({
    start_urls: ['https://x.com'],
    extract: { fields: { a: 'h1' } },
    authorization: { basis: 'because-i-want-to' },
  }), /authorization.basis/);
});

test('ignore_crawl_delay is narrower than disabling robots.txt', () => {
  const { config } = normalizeConfig({
    start_urls: ['https://x.com'],
    extract: { fields: { a: 'h1' } },
    robots: { ignore_crawl_delay: true },
  });
  assert.equal(config.robots.ignoreCrawlDelay, true);
  assert.equal(config.robots.enabled, true, 'Allow/Disallow must still be enforced');
});

test('the owned preset is aggressive and declares why', () => {
  const { config } = normalizeConfig(
    { start_urls: ['https://x.com'], extract: { fields: { a: 'h1' } } },
    { presets: ['owned'] },
  );
  assert.equal(config.rateLimit.requestsPerSecond, 50);
  assert.equal(config.authorization.basis, 'owner');
  assert.equal(config.robots.enabled, true, 'going fast must not silently disable robots.txt');
});
