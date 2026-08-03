import test from 'node:test';
import assert from 'node:assert/strict';

import { Page } from '../src/parse/dom.js';
import { extractItems, extractRecord, getByPath } from '../src/parse/extractor.js';

const HTML = `
<html><head>
  <title>Shop</title>
  <meta property="og:title" content="Widget — Shop">
  <meta name="description" content="A fine widget">
  <link rel="canonical" href="https://shop.test/p/widget">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
   "sku":"W-1","offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD",
   "availability":"https://schema.org/InStock"},
   "aggregateRating":{"ratingValue":"4.5","reviewCount":"120"}}
  </script>
</head><body>
  <div class="products">
    <article class="card" data-sku="A1">
      <h2 class="title">Widget</h2>
      <span class="price">$10.50</span>
      <a class="link" href="/p/widget">details</a>
      <img src="/img/a.jpg">
      <span class="stock">In stock</span>
    </article>
    <article class="card" data-sku="B2">
      <h2 class="title">Gadget</h2>
      <span class="price">$25.00</span>
      <a class="link" href="/p/gadget">details</a>
      <span class="stock">Out of stock</span>
    </article>
    <article class="card" data-sku="C3">
      <h2 class="title">Doohickey</h2>
      <a class="link" href="/p/doohickey">details</a>
    </article>
  </div>
  <table>
    <thead><tr><th>Name</th><th>Qty</th></tr></thead>
    <tbody><tr><td>Bolt</td><td>12</td></tr><tr><td>Nut</td><td>34</td></tr></tbody>
  </table>
</body></html>`;

const page = () => new Page({ html: HTML, url: 'https://shop.test/list' });

test('getByPath walks objects, arrays and wildcards', () => {
  const data = { a: { b: [{ c: 1 }, { c: 2 }] }, list: [10, 20] };
  assert.equal(getByPath(data, 'a.b[0].c'), 1);
  assert.deepEqual(getByPath(data, 'a.b.*.c'), [1, 2]);
  assert.equal(getByPath(data, 'list[1]'), 20);
  assert.equal(getByPath(data, 'missing.deep'), undefined);
  // Reaching into a one-element array without an index takes the first entry.
  assert.equal(getByPath({ offers: [{ price: 5 }] }, 'offers.price'), 5);
});

test('extracts one record per container', () => {
  const { items } = extractItems({
    item: {
      selector: 'article.card',
      fields: {
        title: '.title',
        price: { selector: '.price', transform: ['currency'], type: 'number' },
        sku: { selector: '', attr: 'data-sku' },
      },
    },
  }, page());

  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Widget');
  assert.equal(items[0].price, 10.5);
  assert.equal(items[1].price, 25);
  // The third card has no price, so the key is omitted rather than set to null.
  assert.equal('price' in items[2], false);
});

test('attr reads attributes and type: url resolves them', () => {
  const { items } = extractItems({
    item: {
      selector: 'article.card',
      fields: { link: { selector: '.link', attr: 'href', type: 'url' } },
    },
  }, page());
  assert.equal(items[0].link, 'https://shop.test/p/widget');
});

test('a field can read an attribute off the item container itself', () => {
  const spec = {
    item: {
      selector: 'article.card',
      fields: {
        // All three spellings mean "this container element".
        sku: { attr: 'data-sku' },
        skuDot: { selector: '.', attr: 'data-sku' },
        skuEmpty: { selector: '', attr: 'data-sku' },
        ownClass: { attr: 'class' },
      },
    },
  };
  const { items } = extractItems(spec, page());
  assert.equal(items[0].sku, 'A1');
  assert.equal(items[0].skuDot, 'A1');
  assert.equal(items[0].skuEmpty, 'A1');
  assert.equal(items[1].sku, 'B2');
  assert.equal(items[0].ownClass, 'card');
});

test('string shorthand means "this selector, as text"', () => {
  const { items } = extractItems({ fields: { title: 'h2.title' } }, page());
  assert.equal(items[0].title, 'Widget');
});

test('all: true collects every match', () => {
  const { items } = extractItems({
    fields: { titles: { selector: '.title', all: true } },
  }, page());
  assert.deepEqual(items[0].titles, ['Widget', 'Gadget', 'Doohickey']);
});

test('fallback chains try each strategy in order', () => {
  const { items } = extractItems({
    fields: {
      name: {
        selector: '.does-not-exist',
        fallback: [
          { selector: '.also-missing' },
          { from: 'jsonld', path: 'name' },
        ],
        required: true,
      },
    },
  }, page());
  assert.equal(items[0].name, 'Widget Pro');
});

test('a fallback replaces the source entirely, not just the selector', () => {
  // The regression: the fallback used to inherit `from: jsonld` from the base
  // spec, so its `selector` was ignored and the chain could never recover.
  const broken = new Page({
    html: '<html><head><script type="application/ld+json">{invalid json</script></head>'
      + '<body><h1 class="t">Recovered Title</h1></body></html>',
    url: 'https://shop.test/p',
  });

  const { items } = extractItems({
    fields: {
      name: {
        from: 'jsonld',
        path: 'name',
        transform: ['clean'],
        fallback: [{ selector: 'h1.t' }],
        required: true,
      },
    },
  }, broken);

  assert.equal(items[0].name, 'Recovered Title');
});

test('a fallback inherits transforms and type but not the source', () => {
  const { items } = extractItems({
    fields: {
      price: {
        from: 'jsonld',
        path: 'nonexistent.path',
        transform: ['currency'],
        type: 'number',
        fallback: [{ selector: '.price' }],
      },
    },
  }, page());
  assert.equal(items[0].price, 10.5, 'the inherited currency transform should still run');
});

test('a fallback can override the inherited transform', () => {
  const { items } = extractItems({
    fields: {
      value: {
        selector: '.nope',
        transform: ['currency'],
        fallback: [{ selector: '.title', transform: ['upper'] }],
      },
    },
  }, page());
  assert.equal(items[0].value, 'WIDGET');
});

test('the jsonld `entity` filter is separate from the field type', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Corp"}</script>
    <script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"9.99"}}</script>
  </head><body></body></html>`;
  const p = new Page({ html, url: 'https://shop.test/p' });

  const { items } = extractItems({
    fields: {
      product: { from: 'jsonld', entity: 'Product', path: 'name', type: 'string' },
      seller: { from: 'jsonld', entity: 'Organization', path: 'name' },
      price: { from: 'jsonld', entity: 'Product', path: 'offers.price', transform: ['number'], type: 'number' },
    },
  }, p);

  assert.equal(items[0].product, 'Widget');
  assert.equal(items[0].seller, 'Acme Corp');
  assert.equal(items[0].price, 9.99, 'type: number must not be mistaken for an @type filter');
});

test('reads JSON-LD, OpenGraph and meta sources', () => {
  const { items } = extractItems({
    fields: {
      name: { from: 'jsonld', path: 'name' },
      price: { from: 'jsonld', path: 'offers.price', transform: ['number'], type: 'number' },
      rating: { from: 'jsonld', path: 'aggregateRating.ratingValue', transform: ['number'] },
      ogTitle: { from: 'og', path: 'title' },
      description: { from: 'meta', path: 'description' },
      pageUrl: { from: 'url' },
    },
  }, page());

  assert.equal(items[0].name, 'Widget Pro');
  assert.equal(items[0].price, 49.99);
  assert.equal(items[0].rating, 4.5);
  assert.equal(items[0].ogTitle, 'Widget — Shop');
  assert.equal(items[0].description, 'A fine widget');
  assert.equal(items[0].pageUrl, 'https://shop.test/list');
});

test('XPath selectors work alongside CSS', () => {
  const { items } = extractItems({
    fields: {
      first: { xpath: '//article[1]/h2/text()' },
      href: { xpath: '//a[@class="link"][2]/@href' },
      count: { xpath: 'count(//article)', transform: ['int'] },
    },
  }, page());
  assert.equal(items[0].first, 'Widget');
  assert.equal(items[0].href, '/p/gadget');
  assert.equal(items[0].count, 3);
});

test('regex extraction pulls a capture group', () => {
  const { items } = extractItems({
    fields: { sku: { selector: '.link', attr: 'href', regex: { pattern: '/p/(\\w+)', group: 1 } } },
  }, page());
  assert.equal(items[0].sku, 'widget');
});

test('const injects a literal and default fills gaps', () => {
  const { items } = extractItems({
    fields: {
      source: { const: 'shop.test' },
      missing: { selector: '.nope', default: 'n/a' },
    },
  }, page());
  assert.equal(items[0].source, 'shop.test');
  assert.equal(items[0].missing, 'n/a');
});

test('required fields report an issue when absent', () => {
  const { issues } = extractItems({
    fields: { must: { selector: '.absent', required: true } },
  }, page());
  assert.ok(issues.some((i) => i.includes('required')));
});

test('type coercion rejects bad values instead of emitting NaN', () => {
  const { items, issues } = extractItems({
    fields: { qty: { selector: '.title', type: 'number' } },
  }, page());
  assert.equal(items.length === 0 || items[0].qty === undefined, true);
  assert.ok(issues.some((i) => i.includes('not a number')));
});

test('nested fields build nested objects', () => {
  const { items } = extractItems({
    fields: {
      product: {
        selector: 'article.card',
        fields: { title: '.title', price: { selector: '.price', transform: ['currency'] } },
      },
    },
  }, page());
  assert.deepEqual(items[0].product, { title: 'Widget', price: 10.5 });
});

test('when guards restrict a field to matching pages', () => {
  const { items } = extractItems({
    fields: {
      onlyIfTable: { selector: 'title', when: { selector: 'table', exists: true } },
      neverSet: { selector: 'title', when: { selector: 'form', exists: true } },
    },
  }, page());
  assert.equal(items[0].onlyIfTable, 'Shop');
  assert.equal('neverSet' in items[0], false);
});

test('tables: true emits one record per row', () => {
  const { items } = extractItems({ tables: true }, page());
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { Name: 'Bolt', Qty: '12' });
});

test('a container selector that matches nothing reports an issue', () => {
  const { items, issues } = extractItems({
    item: { selector: '.no-such-thing', fields: { a: 'h1' } },
  }, page());
  assert.equal(items.length, 0);
  assert.ok(issues.some((i) => i.includes('No elements matched')));
});

test('extractRecord reports fill statistics', () => {
  const p = page();
  const result = extractRecord(
    { a: 'h2.title', b: '.nope', c: '.price' },
    { page: p, element: null },
  );
  assert.equal(result.fieldsTotal, 3);
  assert.equal(result.fieldsFound, 2);
});
