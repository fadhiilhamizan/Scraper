import test from 'node:test';
import assert from 'node:assert/strict';

import { RobotsTxt } from '../src/compliance/robots.js';

test('a disallow rule blocks the matching path', () => {
  const robots = RobotsTxt.parse('User-agent: *\nDisallow: /private');
  assert.equal(robots.check('https://x.com/private/page').allowed, false);
  assert.equal(robots.check('https://x.com/public').allowed, true);
});

test('an empty Disallow means everything is allowed', () => {
  const robots = RobotsTxt.parse('User-agent: *\nDisallow:');
  assert.equal(robots.check('https://x.com/anything').allowed, true);
});

test('the most specific rule wins regardless of file order', () => {
  // Allow is listed second but is longer, so it must win.
  const robots = RobotsTxt.parse('User-agent: *\nDisallow: /admin\nAllow: /admin/public');
  assert.equal(robots.check('https://x.com/admin/secret').allowed, false);
  assert.equal(robots.check('https://x.com/admin/public/x').allowed, true);

  // And the same in the opposite order.
  const reversed = RobotsTxt.parse('User-agent: *\nAllow: /admin/public\nDisallow: /admin');
  assert.equal(reversed.check('https://x.com/admin/public/x').allowed, true);
});

test('equal-specificity conflicts resolve to Allow', () => {
  const robots = RobotsTxt.parse('User-agent: *\nDisallow: /page\nAllow: /page');
  assert.equal(robots.check('https://x.com/page').allowed, true);
});

test('wildcards and end-anchors are honoured', () => {
  const robots = RobotsTxt.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/private');
  assert.equal(robots.check('https://x.com/docs/manual.pdf').allowed, false);
  assert.equal(robots.check('https://x.com/docs/manual.pdf?v=2').allowed, true, '$ anchors to end of path+query');
  assert.equal(robots.check('https://x.com/tmp/a/private').allowed, false);
  assert.equal(robots.check('https://x.com/tmp/a/public').allowed, true);
});

test('the most specific user-agent group is selected', () => {
  const robots = RobotsTxt.parse(`
User-agent: *
Disallow: /

User-agent: Harvester
Disallow: /admin
`);
  assert.equal(robots.check('https://x.com/public', 'Harvester/1.0').allowed, true);
  assert.equal(robots.check('https://x.com/admin', 'Harvester/1.0').allowed, false);
  assert.equal(robots.check('https://x.com/public', 'SomeOtherBot').allowed, false);
});

test('consecutive User-agent lines share one group', () => {
  const robots = RobotsTxt.parse(`
User-agent: alpha
User-agent: beta
Disallow: /shared
`);
  assert.equal(robots.check('https://x.com/shared', 'alpha').allowed, false);
  assert.equal(robots.check('https://x.com/shared', 'beta').allowed, false);
});

test('Crawl-delay is read per group', () => {
  const robots = RobotsTxt.parse(`
User-agent: *
Crawl-delay: 10
Disallow:

User-agent: Harvester
Crawl-delay: 2
`);
  assert.equal(robots.crawlDelayFor('Harvester/1.0'), 2);
  assert.equal(robots.crawlDelayFor('Other'), 10);
});

test('Sitemap directives are collected', () => {
  const robots = RobotsTxt.parse(`
Sitemap: https://x.com/sitemap.xml
User-agent: *
Disallow: /a
Sitemap: https://x.com/sitemap-news.xml
`);
  assert.deepEqual(robots.sitemaps, ['https://x.com/sitemap.xml', 'https://x.com/sitemap-news.xml']);
});

test('comments and blank lines are ignored', () => {
  const robots = RobotsTxt.parse(`
# a comment
User-agent: *   # trailing comment
Disallow: /x    # another

`);
  assert.equal(robots.check('https://x.com/x').allowed, false);
  assert.equal(robots.check('https://x.com/y').allowed, true);
});

test('rules before any User-agent line apply to everyone', () => {
  const robots = RobotsTxt.parse('Disallow: /orphan');
  assert.equal(robots.check('https://x.com/orphan').allowed, false);
});

test('allowAll and denyAll behave as documented', () => {
  assert.equal(RobotsTxt.allowAll().check('https://x.com/anything').allowed, true);
  assert.equal(RobotsTxt.denyAll().check('https://x.com/anything').allowed, false);
});

test('an empty robots.txt allows everything', () => {
  assert.equal(RobotsTxt.parse('').check('https://x.com/x').allowed, true);
});
