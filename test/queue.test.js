import test from 'node:test';
import assert from 'node:assert/strict';

import { Frontier } from '../src/queue/frontier.js';
import {
  canonicalizeUrl, resolveUrl, isSameDomain, matchesAny, getHostname,
} from '../src/queue/urlutils.js';

/* ───────────────────────────── URL utilities ────────────────────────────── */

test('canonicalizeUrl strips tracking parameters', () => {
  assert.equal(
    canonicalizeUrl('https://x.com/p?id=1&utm_source=twitter&fbclid=abc'),
    'https://x.com/p?id=1',
  );
});

test('canonicalizeUrl normalises host, port, slash and fragment', () => {
  assert.equal(canonicalizeUrl('HTTPS://X.COM:443/a/'), 'https://x.com/a');
  assert.equal(canonicalizeUrl('https://x.com/a#section'), 'https://x.com/a');
  assert.equal(canonicalizeUrl('https://x.com//a//b'), 'https://x.com/a/b');
  assert.equal(canonicalizeUrl('https://x.com/'), 'https://x.com/');
});

test('canonicalizeUrl sorts query parameters so order does not create duplicates', () => {
  assert.equal(
    canonicalizeUrl('https://x.com/p?b=2&a=1'),
    canonicalizeUrl('https://x.com/p?a=1&b=2'),
  );
});

test('canonicalizeUrl rejects non-http schemes and junk', () => {
  assert.equal(canonicalizeUrl('javascript:void(0)'), null);
  assert.equal(canonicalizeUrl('mailto:a@b.com'), null);
  assert.equal(canonicalizeUrl('not a url'), null);
  assert.equal(canonicalizeUrl(''), null);
});

test('resolveUrl handles relative links and skips non-navigational ones', () => {
  assert.equal(resolveUrl('/b', 'https://x.com/a/c'), 'https://x.com/b');
  assert.equal(resolveUrl('../d', 'https://x.com/a/b/c'), 'https://x.com/a/d');
  assert.equal(resolveUrl('#top', 'https://x.com/a'), null);
  assert.equal(resolveUrl('javascript:x()', 'https://x.com/a'), null);
  assert.equal(resolveUrl('mailto:a@b.c', 'https://x.com/a'), null);
});

test('isSameDomain treats subdomains as belonging to the domain', () => {
  assert.equal(isSameDomain('shop.example.com', 'example.com'), true);
  assert.equal(isSameDomain('example.com', 'example.com'), true);
  assert.equal(isSameDomain('www.example.com', 'example.com'), true);
  assert.equal(isSameDomain('notexample.com', 'example.com'), false);
  assert.equal(isSameDomain('example.com.evil.net', 'example.com'), false);
});

test('matchesAny accepts globs, regex literals and bare patterns', () => {
  assert.equal(matchesAny('https://x.com/a.pdf', ['\\.pdf$']), true);
  assert.equal(matchesAny('https://x.com/products/1', ['/products/']), true);
  assert.equal(matchesAny('https://x.com/a', ['/regex:\\/b/']), false);
  assert.equal(matchesAny('https://x.com/a', []), false);
});

/* ────────────────────────────── the frontier ────────────────────────────── */

test('the frontier de-duplicates by canonical URL', () => {
  const f = new Frontier();
  assert.equal(f.add('https://x.com/a'), true);
  assert.equal(f.add('https://x.com/a'), false);
  assert.equal(f.add('https://x.com/a?utm_source=x'), false, 'tracking params must not create a duplicate');
  assert.equal(f.add('https://x.com/a#frag'), false);
  assert.equal(f.size, 1);
});

test('lower priority values are served first', () => {
  const f = new Frontier();
  f.add({ url: 'https://x.com/low', priority: 10 });
  f.add({ url: 'https://x.com/high', priority: 1 });
  f.add({ url: 'https://x.com/mid', priority: 5 });
  assert.match(f.next().url, /high/);
  assert.match(f.next().url, /mid/);
  assert.match(f.next().url, /low/);
});

test('equal priorities keep insertion order', () => {
  const f = new Frontier();
  for (const n of [1, 2, 3, 4]) f.add({ url: `https://x.com/${n}`, priority: 0 });
  assert.deepEqual(
    [f.next(), f.next(), f.next(), f.next()].map((r) => r.url.slice(-1)),
    ['1', '2', '3', '4'],
  );
});

test('requests are served round-robin across hosts', () => {
  const f = new Frontier();
  f.add('https://a.com/1');
  f.add('https://a.com/2');
  f.add('https://b.com/1');
  const hosts = [f.next(), f.next(), f.next()].map((r) => getHostname(r.url));
  assert.deepEqual(hosts, ['a.com', 'b.com', 'a.com'], 'one busy host must not starve the others');
});

test('the readiness predicate can veto a host', () => {
  const f = new Frontier();
  f.add('https://blocked.com/1');
  f.add('https://open.com/1');
  const request = f.next((host) => host !== 'blocked.com');
  assert.equal(getHostname(request.url), 'open.com');
});

test('maxPages caps how much work is handed out', () => {
  const f = new Frontier({ maxPages: 2 });
  f.add('https://x.com/1');
  f.add('https://x.com/2');
  assert.equal(f.add('https://x.com/3'), false);
  assert.ok(f.next());
  assert.ok(f.next());
  assert.equal(f.next(), null);
  assert.equal(f.exhausted, true);
});

test('a POST with a different body is a different resource', () => {
  const f = new Frontier();
  assert.equal(f.add({ url: 'https://x.com/api', method: 'POST', body: { page: 1 } }), true);
  assert.equal(f.add({ url: 'https://x.com/api', method: 'POST', body: { page: 2 } }), true);
  assert.equal(f.add({ url: 'https://x.com/api', method: 'POST', body: { page: 1 } }), false);
});

test('drained reflects both the queue and in-flight work', () => {
  const f = new Frontier();
  f.add('https://x.com/a');
  assert.equal(f.drained, false);
  const request = f.next();
  assert.equal(f.drained, false, 'in-flight work means not drained');
  f.markCompleted(request);
  assert.equal(f.drained, true);
});

test('serialize/restore round-trips without redoing completed work', () => {
  const f = new Frontier();
  f.add('https://x.com/done');
  f.add('https://x.com/pending');
  const done = f.next();
  f.markCompleted(done);

  const restored = new Frontier();
  restored.restore(f.serialize());

  assert.equal(restored.completed.size, 1);
  const urls = [];
  let next;
  // eslint-disable-next-line no-cond-assign
  while ((next = restored.next())) urls.push(next.url);
  assert.deepEqual(urls, ['https://x.com/pending']);
});

test('in-flight requests are restored as pending', () => {
  const f = new Frontier();
  f.add('https://x.com/interrupted');
  f.next(); // checked out, never completed — simulates a crash

  const restored = new Frontier();
  restored.restore(f.serialize());
  assert.equal(restored.size, 1);
});
