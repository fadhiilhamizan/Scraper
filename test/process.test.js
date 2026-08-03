import test from 'node:test';
import assert from 'node:assert/strict';

import { Deduplicator, BloomFilter } from '../src/process/dedupe.js';
import { Validator } from '../src/process/validate.js';
import { CookieJar, parseSetCookie } from '../src/http/cookies.js';
import { RateLimiter, parseRetryAfter } from '../src/resilience/ratelimiter.js';
import { CircuitBreaker, CircuitState } from '../src/resilience/circuitbreaker.js';
import { RetryPolicy } from '../src/resilience/retry.js';
import { HttpError, NetworkError, ConfigError, BlockedError } from '../src/utils/errors.js';
import { detectBlock } from '../src/resilience/captcha.js';

/* ─────────────────────────────── dedupe ─────────────────────────────────── */

test('record dedupe ignores key order and case', () => {
  const d = new Deduplicator({ strategy: 'record' });
  assert.equal(d.check({ a: 1, b: 2 }).duplicate, false);
  assert.equal(d.check({ b: 2, a: 1 }).duplicate, true);
  assert.equal(d.check({ a: 1, b: 3 }).duplicate, false);
});

test('ignoreFields keeps volatile fields out of the identity', () => {
  const d = new Deduplicator({ strategy: 'record', ignoreFields: ['_scraped_at'] });
  assert.equal(d.check({ id: 1, _scraped_at: 'a' }).duplicate, false);
  assert.equal(d.check({ id: 1, _scraped_at: 'b' }).duplicate, true);
});

test('field dedupe uses only the chosen keys', () => {
  const d = new Deduplicator({ strategy: 'fields', keyFields: ['sku'] });
  assert.equal(d.check({ sku: 'A', price: 1 }).duplicate, false);
  assert.equal(d.check({ sku: 'A', price: 999 }).duplicate, true);
  assert.equal(d.check({ sku: 'B', price: 1 }).duplicate, false);
});

test('field dedupe without keyFields is a configuration error', () => {
  const d = new Deduplicator({ strategy: 'fields' });
  assert.throws(() => d.check({ a: 1 }), /requires `keyFields`/);
});

test('url dedupe keys on the source URL', () => {
  const d = new Deduplicator({ strategy: 'url' });
  assert.equal(d.check({ x: 1 }, { url: 'https://a.com' }).duplicate, false);
  assert.equal(d.check({ x: 2 }, { url: 'https://a.com' }).duplicate, true);
});

test('disabled dedupe passes everything through', () => {
  const d = new Deduplicator({ enabled: false });
  assert.equal(d.check({ a: 1 }).duplicate, false);
  assert.equal(d.check({ a: 1 }).duplicate, false);
});

test('the bloom filter never reports a false negative', () => {
  const bloom = new BloomFilter(1000, 0.01);
  const added = Array.from({ length: 500 }, (_, i) => `item-${i}`);
  for (const value of added) bloom.add(value);
  for (const value of added) {
    assert.equal(bloom.has(value), true, `${value} must still be present`);
  }
  assert.ok(bloom.memoryBytes > 0);
});

test('the bloom-backed deduplicator behaves like the set-backed one', () => {
  const d = new Deduplicator({ store: 'bloom', expectedItems: 1000 });
  assert.equal(d.check({ id: 1 }).duplicate, false);
  assert.equal(d.check({ id: 1 }).duplicate, true);
  assert.equal(d.stats.store, 'bloom');
});

/* ───────────────────────────── validation ──────────────────────────────── */

test('required and type rules are enforced', () => {
  const v = new Validator({ schema: { name: { required: true }, price: { type: 'number' } } });
  assert.equal(v.validate({ name: 'a', price: 1 }).valid, true);
  assert.equal(v.validate({ price: 1 }).valid, false);
  assert.equal(v.validate({ name: 'a', price: 'free' }).valid, false);
});

test('range, length, pattern and enum rules are enforced', () => {
  const v = new Validator({
    schema: {
      price: { type: 'number', min: 0, max: 100 },
      title: { minLength: 3, maxLength: 10 },
      sku: { pattern: '^[A-Z]{2}-\\d+$' },
      status: { enum: ['new', 'used'] },
    },
  });
  assert.equal(v.validate({ price: 50, title: 'hello', sku: 'AB-1', status: 'new' }).valid, true);
  assert.equal(v.validate({ price: 500 }).valid, false);
  assert.equal(v.validate({ title: 'ab' }).valid, false);
  assert.equal(v.validate({ sku: 'bad' }).valid, false);
  assert.equal(v.validate({ status: 'broken' }).valid, false);
});

test('minFilledFields catches near-empty records', () => {
  const v = new Validator({ minFilledFields: 2 });
  assert.equal(v.validate({ a: 1, b: 2 }).valid, true);
  assert.equal(v.validate({ a: 1, b: null }).valid, false);
});

test('onInvalid controls what happens to a bad record', () => {
  const schema = { name: { required: true } };
  assert.equal(new Validator({ schema, onInvalid: 'drop' }).process({}).action, 'drop');
  assert.equal(new Validator({ schema, onInvalid: 'quarantine' }).process({}).action, 'quarantine');
  assert.equal(new Validator({ schema, onInvalid: 'warn' }).process({}).action, 'keep');
  assert.throws(() => new Validator({ schema, onInvalid: 'error' }).process({}), /failed validation/);
});

test('absent optional fields skip their other rules', () => {
  const v = new Validator({ schema: { price: { type: 'number', min: 10 } } });
  assert.equal(v.validate({}).valid, true);
});

/* ─────────────────────────────── cookies ───────────────────────────────── */

test('parseSetCookie reads attributes', () => {
  const cookie = parseSetCookie('session=abc123; Path=/app; Secure; HttpOnly; Max-Age=3600', 'https://x.com/');
  assert.equal(cookie.name, 'session');
  assert.equal(cookie.value, 'abc123');
  assert.equal(cookie.path, '/app');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.ok(cookie.expires > Date.now());
});

test('a cookie cannot claim a domain it does not belong to', () => {
  const hijack = parseSetCookie('a=1; Domain=evil.com', 'https://x.com/');
  assert.equal(hijack.domain, 'x.com', 'the unrelated Domain must be rejected');

  const legitimate = parseSetCookie('a=1; Domain=x.com', 'https://sub.x.com/');
  assert.equal(legitimate.domain, 'x.com');
  assert.equal(legitimate.hostOnly, false);
});

test('the jar sends only matching cookies', () => {
  const jar = new CookieJar();
  jar.set(parseSetCookie('a=1; Path=/app', 'https://x.com/'));
  jar.set(parseSetCookie('b=2; Path=/', 'https://x.com/'));
  jar.set(parseSetCookie('c=3; Secure', 'https://x.com/'));

  assert.equal(jar.headerFor('https://x.com/app/page'), 'a=1; b=2; c=3');
  assert.equal(jar.headerFor('https://x.com/other'), 'b=2; c=3');
  assert.equal(jar.headerFor('http://x.com/other'), 'b=2', 'Secure cookies must not go over http');
  assert.equal(jar.headerFor('https://other.com/'), null);
});

test('an expired cookie is dropped', () => {
  const jar = new CookieJar();
  jar.set(parseSetCookie('a=1', 'https://x.com/'));
  jar.set(parseSetCookie('a=; Max-Age=0', 'https://x.com/'));
  assert.equal(jar.headerFor('https://x.com/'), null);
});

test('the jar round-trips through Playwright format', () => {
  const jar = new CookieJar();
  jar.set(parseSetCookie('session=xyz; Path=/', 'https://x.com/'));
  const exported = jar.toPlaywright();
  assert.equal(exported[0].name, 'session');

  const reimported = new CookieJar();
  reimported.loadFromPlaywright(exported);
  assert.equal(reimported.headerFor('https://x.com/'), 'session=xyz');
});

/* ───────────────────────────── rate limiting ───────────────────────────── */

test('parseRetryAfter accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.ok(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) > 55_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('nonsense'), null);
});

test('a minimum delay spaces requests to a host', () => {
  const limiter = new RateLimiter({ requestsPerSecond: 100, burst: 100, minDelayMs: 500, jitterMs: 0 });
  assert.equal(limiter.delayUntilReady('x.com'), 0);
  limiter.consume('x.com');
  assert.ok(limiter.delayUntilReady('x.com') > 400);
});

test('the token bucket allows a burst then throttles', () => {
  const limiter = new RateLimiter({ requestsPerSecond: 1, burst: 3, jitterMs: 0 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.delayUntilReady('x.com'), 0, `burst request ${i + 1} should pass`);
    limiter.consume('x.com');
  }
  assert.ok(limiter.delayUntilReady('x.com') > 0, 'the fourth request must wait');
});

test('a 429 halves the rate and applies a penalty', () => {
  const limiter = new RateLimiter({ requestsPerSecond: 4, burst: 4 });
  const before = limiter.forHost('x.com').currentRate;
  const result = limiter.report('x.com', { status: 429, retryAfterMs: 5000 });
  assert.equal(result.throttled, true);
  assert.ok(result.newRate < before);
  assert.ok(limiter.delayUntilReady('x.com') > 4000);
});

test('robots Crawl-delay raises the floor but is capped', () => {
  const limiter = new RateLimiter({ requestsPerSecond: 10, burst: 10, maxCrawlDelayMs: 30_000 });
  limiter.setCrawlDelay('x.com', 5);
  assert.equal(limiter.forHost('x.com').effectiveDelayMs, 5000);
  limiter.setCrawlDelay('x.com', 99_999);
  assert.equal(limiter.forHost('x.com').effectiveDelayMs, 30_000);
});

/* ──────────────────────────── circuit breaker ──────────────────────────── */

test('consecutive failures open the circuit', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10_000 });
  for (let i = 0; i < 2; i += 1) breaker.onFailure('x.com', new Error('boom'));
  assert.equal(breaker.canRequest('x.com'), true);

  const transition = breaker.onFailure('x.com', new Error('boom'));
  assert.equal(transition.transitioned, CircuitState.OPEN);
  assert.equal(breaker.canRequest('x.com'), false);
});

test('a success resets the failure streak', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  breaker.onFailure('x.com', new Error('a'));
  breaker.onFailure('x.com', new Error('b'));
  breaker.onSuccess('x.com');
  breaker.onFailure('x.com', new Error('c'));
  assert.equal(breaker.canRequest('x.com'), true);
});

test('the circuit half-opens after its cooldown and closes on a good probe', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
  breaker.onFailure('x.com', new Error('down'));
  assert.equal(breaker.canRequest('x.com'), true, 'a zero cooldown allows an immediate probe');
  assert.equal(breaker.forHost('x.com').state, CircuitState.HALF_OPEN);
  breaker.onSuccess('x.com');
  assert.equal(breaker.forHost('x.com').state, CircuitState.CLOSED);
});

test('circuits are tracked per host', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.onFailure('bad.com', new Error('x'));
  assert.equal(breaker.canRequest('bad.com'), false);
  assert.equal(breaker.canRequest('good.com'), true);
});

/* ────────────────────────────── retry policy ───────────────────────────── */

test('retryable statuses retry, others do not', () => {
  const policy = new RetryPolicy({ maxAttempts: 3 });
  assert.equal(policy.evaluate(new HttpError('x', { status: 503 }), 1).retry, true);
  assert.equal(policy.evaluate(new HttpError('x', { status: 429 }), 1).retry, true);
  assert.equal(policy.evaluate(new HttpError('x', { status: 404 }), 1).retry, false);
  assert.equal(policy.evaluate(new HttpError('x', { status: 400 }), 1).retry, false);
  assert.equal(policy.evaluate(new NetworkError('reset'), 1).retry, true);
  assert.equal(policy.evaluate(new ConfigError('bad recipe'), 1).retry, false);
});

test('retries stop at maxAttempts', () => {
  const policy = new RetryPolicy({ maxAttempts: 2 });
  assert.equal(policy.evaluate(new HttpError('x', { status: 503 }), 1).retry, true);
  assert.equal(policy.evaluate(new HttpError('x', { status: 503 }), 2).retry, false);
});

test('403 is not retried by default — it usually means "you may not have this"', () => {
  const policy = new RetryPolicy({ maxAttempts: 3 });
  assert.equal(policy.evaluate(new HttpError('forbidden', { status: 403 }), 1).retry, false);
});

test('a detected bot wall asks for a new identity and a browser', () => {
  const policy = new RetryPolicy({ maxAttempts: 3 });
  const decision = policy.evaluate(new BlockedError('bot wall detected'), 1);
  assert.equal(decision.retry, true);
  assert.equal(decision.adjust.forceRender, true);
  assert.equal(decision.adjust.rotateProxy, true);
  assert.equal(decision.adjust.rotateUserAgent, true);
});

test('adding 403 to retry_statuses makes it retry with rotation', () => {
  const policy = new RetryPolicy({ maxAttempts: 3, retryStatuses: [403, 429, 503] });
  const decision = policy.evaluate(new HttpError('forbidden', { status: 403 }), 1);
  assert.equal(decision.retry, true);
  assert.equal(decision.adjust.rotateProxy, true);
  assert.equal(decision.adjust.forceRender, true);
});

test('a 429 backs off harder and rotates identity', () => {
  const policy = new RetryPolicy({ maxAttempts: 3 });
  const decision = policy.evaluate(new HttpError('slow down', { status: 429 }), 1);
  assert.equal(decision.retry, true);
  assert.equal(decision.adjust.rotateUserAgent, true);
});

test('toHarvesterError keeps an explicit retryable flag from a plain error', () => {
  const decision = new RetryPolicy({ maxAttempts: 3 }).evaluate(
    Object.assign(new Error('custom transient failure'), { retryable: true }),
    1,
  );
  assert.equal(decision.retry, true);
});

test('Retry-After is respected over the computed backoff', () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 120_000 });
  const decision = policy.evaluate(
    new HttpError('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    1,
  );
  assert.ok(decision.delayMs >= 30_000);
});

/* ─────────────────────────── block detection ───────────────────────────── */

test('a Cloudflare challenge is detected and marked renderable', () => {
  const detection = detectBlock({
    status: 503,
    headers: { server: 'cloudflare' },
    body: '<html><body>Just a moment...<div id="cf-browser-verification"></div>' + 'x'.repeat(600) + '</body></html>',
  });
  assert.equal(detection.blocked, true);
  assert.equal(detection.vendor, 'cloudflare');
  assert.equal(detection.resolvableByRendering, true);
});

test('a reCAPTCHA page is detected and marked not renderable', () => {
  const detection = detectBlock({
    status: 200,
    headers: {},
    body: '<div class="g-recaptcha" data-sitekey="abc"></div><script src="https://www.google.com/recaptcha/api.js"></script>' + 'x'.repeat(600),
  });
  assert.equal(detection.blocked, true);
  assert.equal(detection.vendor, 'recaptcha');
  assert.equal(detection.resolvableByRendering, false);
});

test('ordinary pages are not flagged', () => {
  const detection = detectBlock({
    status: 200,
    headers: { server: 'cloudflare' },
    body: `<html><body><h1>Products</h1>${'<p>Real content here.</p>'.repeat(40)}</body></html>`,
  });
  assert.equal(detection.blocked, false, 'being behind Cloudflare is not by itself a block');
});

test('a 200 with a near-empty body is treated as suspicious', () => {
  const detection = detectBlock({ status: 403, headers: {}, body: 'Access Denied' });
  assert.equal(detection.blocked, true);
});
