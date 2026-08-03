import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import {
  evaluate, evaluateToStrings, evaluateToString, validateXPath, stringValue,
} from '../src/parse/xpath.js';

const HTML = `
<html><body>
  <div id="main" class="container">
    <h1>Product Catalogue</h1>
    <ul class="products">
      <li class="product featured" data-id="1"><span class="name">Widget</span><span class="price">$10.50</span></li>
      <li class="product" data-id="2"><span class="name">Gadget</span><span class="price">$25.00</span></li>
      <li class="product" data-id="3"><span class="name">Doohickey</span><span class="price">$5.25</span></li>
    </ul>
    <a href="/next" rel="next">Next page</a>
    <!-- a comment -->
  </div>
</body></html>`;

const root = () => cheerio.load(HTML).root()[0];

test('selects elements by descendant path', () => {
  assert.equal(evaluate('//li', root()).length, 3);
  assert.equal(evaluate('//ul/li', root()).length, 3);
  assert.equal(evaluate('/html/body/div/h1', root()).length, 1);
});

test('reads text and attributes', () => {
  assert.equal(evaluateToString('//h1/text()', root()), 'Product Catalogue');
  assert.equal(evaluateToString('//a/@href', root()), '/next');
  assert.deepEqual(evaluateToStrings('//li/@data-id', root()), ['1', '2', '3']);
});

test('filters with attribute predicates', () => {
  assert.equal(evaluate('//li[@data-id="2"]', root()).length, 1);
  assert.equal(evaluateToString('//li[@data-id="2"]/span[@class="name"]', root()), 'Gadget');
  assert.equal(evaluate('//li[@class]', root()).length, 3);
});

test('positional predicates are 1-based', () => {
  assert.equal(evaluateToString('//li[1]/span[@class="name"]', root()), 'Widget');
  assert.equal(evaluateToString('//li[last()]/span[@class="name"]', root()), 'Doohickey');
  assert.equal(evaluate('//li[position() > 1]', root()).length, 2);
});

test('supports contains, starts-with and normalize-space', () => {
  assert.equal(evaluate('//li[contains(@class, "featured")]', root()).length, 1);
  assert.equal(evaluate('//a[starts-with(@href, "/nex")]', root()).length, 1);
  assert.equal(evaluateToString('normalize-space(//h1)', root()), 'Product Catalogue');
  assert.equal(evaluate('//span[contains(text(), "Widget")]', root()).length, 1);
});

test('supports boolean operators and not()', () => {
  assert.equal(evaluate('//li[@data-id="1" or @data-id="3"]', root()).length, 2);
  assert.equal(evaluate('//li[@class="product" and @data-id="2"]', root()).length, 1);
  assert.equal(evaluate('//li[not(contains(@class, "featured"))]', root()).length, 2);
});

test('supports axes', () => {
  assert.equal(evaluateToString('//span[@class="price"]/parent::li/@data-id', root()), '1');
  assert.equal(evaluate('//li[1]/following-sibling::li', root()).length, 2);
  assert.equal(evaluate('//li[3]/preceding-sibling::li', root()).length, 2);
  assert.equal(evaluate('//span[@class="name"]/ancestor::ul', root()).length, 1);
  assert.equal(evaluate('//li/self::li', root()).length, 3);
});

test('supports the union operator', () => {
  assert.equal(evaluate('//h1 | //a', root()).length, 2);
});

test('supports numeric predicates and arithmetic', () => {
  assert.equal(evaluate('count(//li)', root()), 3);
  assert.equal(evaluate('count(//li) + 1', root()), 4);
  assert.equal(evaluate('count(//li) div 3', root()), 1);
  // `div` and `*` must not be confused with a node test or wildcard.
  assert.equal(evaluate('2 * 3', root()), 6);
  assert.equal(evaluate('//div', root()).length, 1);
  assert.equal(evaluate('//ul/*', root()).length, 3);
});

test('handles string functions', () => {
  assert.equal(evaluate('string-length("hello")', root()), 5);
  assert.equal(evaluate('substring("harvester", 1, 7)', root()), 'harvest');
  assert.equal(evaluate('substring-after("a-b", "-")', root()), 'b');
  assert.equal(evaluate('concat("a", "b", "c")', root()), 'abc');
  assert.equal(evaluate('translate("abc", "abc", "xyz")', root()), 'xyz');
});

test('node() and comment() tests work', () => {
  assert.equal(evaluate('//div/comment()', root()).length, 1);
  assert.ok(evaluate('//ul/node()', root()).length >= 3);
});

test('relative paths evaluate against the context node', () => {
  const li = evaluate('//li[2]', root())[0];
  assert.equal(evaluateToString('./span[@class="name"]', li), 'Gadget');
  assert.equal(evaluateToString('span[@class="price"]', li), '$25.00');
  assert.equal(evaluateToString('../li[1]/span[@class="name"]', li), 'Widget');
});

test('stringValue concatenates descendant text', () => {
  const li = evaluate('//li[1]', root())[0];
  assert.equal(stringValue(li), 'Widget$10.50');
});

test('an empty result set is not an error', () => {
  assert.deepEqual(evaluate('//nonexistent', root()), []);
  assert.equal(evaluateToString('//nope/@href', root()), '');
});

test('validateXPath reports syntax errors instead of throwing', () => {
  assert.equal(validateXPath('//div[@class="x"]').valid, true);
  const bad = validateXPath('//div[');
  assert.equal(bad.valid, false);
  assert.match(bad.error, /Expected|Unexpected/);
});

test('unterminated string literals are rejected', () => {
  assert.equal(validateXPath('//div[@a="x]').valid, false);
});
