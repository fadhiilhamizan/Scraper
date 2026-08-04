/**
 * Page-analysis tests.
 *
 * These pin down the heuristics that decide what a generated recipe looks
 * like — the difference between a recipe that works and one that silently
 * produces empty records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzePage, findRepeatedBlocks, suggestFields, generateRecipe, buildSelector } from '../src/cli/inspect.js';
import { Page } from '../src/parse/dom.js';
import { extractItems } from '../src/parse/extractor.js';
import { normalizeConfig } from '../src/config/schema.js';

const page = (html, url = 'https://shop.test/list') => new Page({ html, url });
const wrap = (body) => `<!doctype html><html><head><title>Fixture</title></head><body>
  <header><p>${'Padding prose so the page does not read as an empty shell. '.repeat(4)}</p></header>
  ${body}</body></html>`;

/* ─────────────────────── repeated-block detection ──────────────────────── */

const SHOP = wrap(`<div class="grid">${
  [1, 2, 3, 4].map((i) => `
    <article class="product-card" data-sku="SKU-${i}">
      <h2 class="product-card__title"><a href="/p/${i}" title="Product number ${i}, full name">Product ${i}</a></h2>
      <span class="product-card__price">$${i}0.00</span>
      <img class="product-card__image" src="/img/${i}.jpg">
      <p class="product-card__blurb">A dependable product built to last for years of use.</p>
      <div class="tags"><a class="tag" href="/t/a">alpha</a><a class="tag" href="/t/b">beta</a></div>
    </article>`).join('')
}</div><nav><a class="next" href="/list?page=2">Next</a></nav>`);

test('the top candidate is the record container, not a repeated leaf', () => {
  const blocks = findRepeatedBlocks(page(SHOP));
  assert.equal(blocks[0].selector, 'article.product-card');
  assert.equal(blocks[0].count, 4);

  // `a.tag` repeats twice as often but is a leaf — a field, never a container.
  const tag = blocks.find((b) => b.selector === 'a.tag');
  assert.ok(!tag || tag.score < blocks[0].score, 'a leaf element must not outrank a real container');
});

test('a repeated leaf is filtered out entirely', () => {
  const html = wrap(`<div>${Array.from({ length: 60 }, (_, i) => `<a class="chip" href="/c/${i}">c${i}</a>`).join('')}</div>`);
  const blocks = findRepeatedBlocks(page(html));
  assert.ok(!blocks.some((b) => b.selector === 'a.chip'),
    'sixty repeated links are navigation, not sixty records');
});

test('navigation and footers are penalised', () => {
  const html = wrap(`
    <nav class="menu">${[1, 2, 3, 4].map((i) => `<div class="menu-entry"><a href="/n/${i}">Section ${i} of the site</a></div>`).join('')}</nav>
    <div class="grid">${[1, 2, 3].map((i) => `
      <div class="result"><h3 class="result__title">Result ${i}</h3>
      <p class="result__text">Some genuinely substantial body text for this result.</p>
      <a href="/r/${i}">open</a></div>`).join('')}</div>`);
  const blocks = findRepeatedBlocks(page(html));
  assert.equal(blocks[0].selector, 'div.result');
});

test('build-hashed class names are not used as selectors', () => {
  const html = wrap(`<div>${[1, 2, 3].map((i) => `
    <div class="Card_root__a1b2c"><h3 class="Card_title__x9y8z">Item ${i}</h3>
    <p>Body text that is long enough to count as real content here.</p><a href="/i/${i}">go</a></div>`).join('')}</div>`);
  const blocks = findRepeatedBlocks(page(html));
  for (const block of blocks) {
    assert.ok(!/a1b2c|x9y8z/.test(block.selector), `hashed class leaked into ${block.selector}`);
  }
});

test('ordinary snake_case class names are kept', () => {
  // The regression: `price_color` and `product_pod` look like build hashes to a
  // naive pattern, and discarding them loses the best selectors on the page.
  const html = wrap(`<div>${[1, 2, 3].map((i) => `
    <article class="product_pod"><h3><a href="/p/${i}">Item ${i}</a></h3>
    <p class="price_color">£${i}0.00</p>
    <p class="instock_availability">In stock and ready to ship today</p></article>`).join('')}</div>`);
  const blocks = findRepeatedBlocks(page(html));
  assert.equal(blocks[0].selector, 'article.product_pod');

  const fields = suggestFields(page(html), 'article.product_pod');
  assert.equal(fields.price.selector, '.price_color');
});

/* ───────────────────────────── field suggestion ────────────────────────── */

test('a suggested selector resolves to the element it was chosen for', () => {
  // `title` and `url` both reduce to `a`; without qualification the title would
  // silently read the wrong link.
  const fields = suggestFields(page(SHOP), 'article.product-card');
  const { items } = extractItems({ item: { selector: 'article.product-card', fields } }, page(SHOP));

  assert.equal(items.length, 4);
  for (const [name] of Object.entries(fields)) {
    const filled = items.filter((i) => i[name] != null && i[name] !== '').length;
    assert.equal(filled, items.length, `field '${name}' should populate on every record`);
  }
});

test('a truncated heading prefers the full title attribute', () => {
  const fields = suggestFields(page(SHOP), 'article.product-card');
  assert.equal(fields.title.attr, 'title');
  const { items } = extractItems({ item: { selector: 'article.product-card', fields } }, page(SHOP));
  assert.equal(items[0].title, 'Product number 1, full name');
});

test('the url field prefers the link wrapping the heading', () => {
  const fields = suggestFields(page(SHOP), 'article.product-card');
  const { items } = extractItems({ item: { selector: 'article.product-card', fields } }, page(SHOP));
  assert.equal(items[0].url, 'https://shop.test/p/1');
});

test('unknown markup still yields fields, named after the site\'s own classes', () => {
  const html = wrap(`<div>${[1, 2].map((i) => `
    <div class="quote"><span class="quote__text">Quote number ${i} goes here.</span>
    <small class="quote__author">Author ${i}</small>
    <a class="quote__tag" href="/t/a">alpha</a><a class="quote__tag" href="/t/b">beta</a></div>`).join('')}</div>`);

  const fields = suggestFields(page(html), 'div.quote');
  assert.ok('text' in fields, 'BEM prefixes should be stripped from field names');
  assert.ok('author' in fields);
  assert.equal(fields.tag?.all, true, 'a class repeating inside one record is a list');

  const { items } = extractItems({ item: { selector: 'div.quote', fields } }, page(html));
  assert.equal(items[0].text, 'Quote number 1 goes here.');
  assert.equal(items[0].author, 'Author 1');
  assert.deepEqual(items[0].tag, ['alpha', 'beta']);
});

test('microdata attributes are preferred when present', () => {
  const html = wrap(`<div>${[1, 2].map((i) => `
    <div class="quote" itemscope itemtype="http://schema.org/CreativeWork">
      <span class="text" itemprop="text">Quote ${i}</span>
      <small class="author" itemprop="author">Author ${i}</small></div>`).join('')}</div>`);
  const fields = suggestFields(page(html), 'div.quote');
  const selectors = Object.values(fields).map((f) => f.selector).join(' ');
  assert.match(selectors, /itemprop/, 'itemprop is far more durable than a class name');
});

/* ──────────────────────────── whole-page analysis ──────────────────────── */

test('analyzePage never picks a container it cannot extract from', () => {
  const analysis = analyzePage({ html: SHOP, url: 'https://shop.test/list' });
  assert.ok(analysis.suggestions.itemSelector);
  assert.ok(Object.keys(analysis.suggestions.listFields).length > 0,
    'a container yielding no fields is the wrong container');
});

test('analyzePage detects pagination and structured data', () => {
  const analysis = analyzePage({ html: SHOP, url: 'https://shop.test/list' });
  assert.equal(analysis.pagination.url, 'https://shop.test/list?page=2');
  assert.equal(analysis.needsJavaScript, false);
});

test('a rendered comparison measures rather than guesses', () => {
  const staticHtml = wrap('<div id="root"></div>');
  const rendered = SHOP;
  const analysis = analyzePage({ html: rendered, url: 'https://shop.test/', rendered: true, staticHtml });
  assert.equal(analysis.needsJavaScript, true);
  assert.equal(analysis.javaScriptMeasured, true);
  assert.match(analysis.javaScriptReason, /rendering added content/);
});

test('rendering that adds nothing is reported as unnecessary', () => {
  const analysis = analyzePage({ html: SHOP, url: 'https://shop.test/', rendered: true, staticHtml: SHOP });
  assert.equal(analysis.needsJavaScript, false);
  assert.equal(analysis.javaScriptMeasured, true);
});

/* ────────────────────────────── generation ─────────────────────────────── */

test('a generated recipe is valid and actually extracts records', () => {
  const analysis = analyzePage({ html: SHOP, url: 'https://shop.test/list' });
  const recipe = generateRecipe(analysis, { name: 'shop' });
  delete recipe._note;

  const { config } = normalizeConfig(recipe);
  assert.equal(config.startUrls[0].url, 'https://shop.test/list');

  const { items } = extractItems(config.extract, page(SHOP));
  assert.equal(items.length, 4, 'the generated recipe should produce one record per card');
  assert.ok(items[0].title && items[0].price != null);
});

test('a page publishing JSON-LD generates a structured-data recipe', () => {
  const html = wrap(`<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Widget",
     "offers":{"@type":"Offer","price":"9.99","priceCurrency":"USD"}}</script>
    <h1>Widget</h1><p>A description long enough to be treated as real content.</p>`);
  const analysis = analyzePage({ html, url: 'https://shop.test/p/1' });
  const recipe = generateRecipe(analysis, { name: 'p' });

  assert.equal(recipe.extract.fields.price.from, 'jsonld');
  assert.equal(recipe.extract.fields.price.path, 'offers.price');
  delete recipe._note;
  assert.doesNotThrow(() => normalizeConfig(recipe));
});

test('buildSelector prefers stable hooks in order', () => {
  const p = page(wrap('<div id="main"><span data-testid="price">£1</span><i itemprop="sku">X</i><b class="thing">y</b></div>'));
  const $ = p.$;
  assert.equal(buildSelector($, $('#main').get(0)), '#main');
  assert.equal(buildSelector($, $('[data-testid]').get(0)), '[data-testid="price"]');
  assert.equal(buildSelector($, $('[itemprop]').get(0)), '[itemprop="sku"]');
  assert.equal(buildSelector($, $('.thing').get(0)), 'b.thing');
});
