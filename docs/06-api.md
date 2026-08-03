# Programmatic API

Three levels, in increasing order of control.

---

## `scrape(url, options)` — one page

```js
import { scrape } from 'harvester';

const items = await scrape('https://books.toscrape.com', {
  selector: 'article.product_pod',
  fields: {
    title: 'h3 a',
    price: { selector: 'p.price_color', transform: ['currency'], type: 'number' },
    url: { selector: 'h3 a', attr: 'href', type: 'url' },
  },
});
```

| Option | Default | Description |
|---|---|---|
| `fields` | — | Field spec (required unless `tables`/`jsonld`) |
| `selector` | `null` | Container selector for repeated items |
| `tables` | `false` | Extract every HTML table instead |
| `jsonld` | `false` | Extract JSON-LD entities instead |
| `render` | `false` | Use a headless browser |
| `robots` | `true` | Check robots.txt first |
| `headers` | `{}` | Extra request headers |
| `userAgent` | bot UA | Override the User-Agent |
| `contact` | — | Contact URL for the bot UA |
| `timeoutMs` | `30000` | Request timeout |
| `waitForSelector` | — | With `render` |
| `actions` | `[]` | With `render` |

Throws if robots.txt disallows the URL. Pass `robots: false` only when you have
another basis for access.

---

## `run(recipe)` / `runFile(path)` — a full scrape

```js
import { run } from 'harvester';

const report = await run({
  start_urls: ['https://books.toscrape.com'],
  crawl: { pagination: { selector: 'li.next a', max_pages: 5 } },
  extract: {
    item: {
      selector: 'article.product_pod',
      fields: { title: 'h3 a', price: { selector: '.price_color', transform: ['currency'] } },
    },
  },
  output: ['books.csv'],
}, {
  onItem: (item) => console.log(item.title),
});

console.log(`${report.items.written} records in ${report.durationHuman}`);
```

```js
import { runFile } from 'harvester';
const report = await runFile('./recipes/books.yaml', { presets: ['careful'] });
```

Options: `presets`, `overrides`, `logger`, `hooks`, `onItem`.

---

## `Scraper` — full control

```js
import { Scraper, defineRecipe, createLogger } from 'harvester';

const { config, hooks, warnings } = defineRecipe(recipe);
const scraper = new Scraper(config, {
  hooks,
  logger: createLogger({ level: 'debug' }),
});

scraper.on('item', (item, request) => { /* … */ });
scraper.on('requestFailed', (error, request) => { /* … */ });
scraper.on('skipped', ({ request, reason }) => { /* … */ });

const report = await scraper.run();
```

### Events

| Event | Arguments |
|---|---|
| `item` | `(item, request)` — every record that passed dedupe and validation |
| `requestFailed` | `(error, request)` — a request that failed after retries |
| `error` | same as above; **only** emitted when a listener is attached |
| `skipped` | `({ request, reason, detail })` — e.g. blocked by robots.txt |
| `stopping` | `(reason)` |

### Control

```js
scraper.stop('reason');    // finish in-flight work, start nothing new
scraper.abort('reason');   // cancel in-flight requests too
```

Live state while running: `scraper.counters`, `scraper.frontier.stats`,
`scraper.metrics.snapshot()`.

---

## Hooks

Registered on the recipe (`hooks:`) or passed to `new Scraper(config, { hooks })`.
All may be async. Handlers run in registration order.

**Observers** — return value ignored:

| Hook | Arguments |
|---|---|
| `onRunStart` | `(config, ctx)` |
| `onPage` | `(page, ctx)` — after parsing, before extraction |
| `onError` | `(error, ctx)` |
| `onRunEnd` | `(report)` |

**Transformers** — the return value replaces the input; `null` drops it:

| Hook | Arguments |
|---|---|
| `onRequest` | `(request, ctx) => request \| null` |
| `onResponse` | `(response, ctx) => response \| null` |
| `onItem` | `(item, ctx) => item \| null` |
| `onItems` | `(items, ctx) => items` |
| `onLinks` | `(requests, ctx) => requests` |

A hook that throws is logged and skipped rather than killing the run — a bug in
a custom enrichment step shouldn't lose an hour of crawling.

### The context object

```js
{
  config, logger, metrics, frontier, cookieJar, scraper,
  enqueue(request),      // queue an extra URL
  stop(reason),
  request,               // the current request (where applicable)
  page,                  // the parsed page (where applicable)
}
```

### Examples

```js
hooks: {
  // Enrich and filter.
  onItem(item) {
    if (item.price == null) return null;
    return { ...item, priceBand: item.price < 50 ? 'budget' : 'standard' };
  },

  // Queue URLs found in a way `crawl.follow` can't express.
  onPage(page, ctx) {
    const data = page.jsonLd().find((b) => b['@type'] === 'ItemList');
    for (const el of data?.itemListElement ?? []) {
      ctx.enqueue({ url: el.url, label: 'detail' });
    }
  },

  // Skip URLs cheaply, before any request is made.
  onRequest(request) {
    return request.url.includes('/archive/') ? null : request;
  },

  // Stop on a condition the built-in limits can't express.
  onItems(items, ctx) {
    if (items.some((i) => i.date < '2020-01-01')) ctx.stop('reached the archive cut-off');
    return items;
  },

  // Post to an API instead of a file.
  async onItems(items) {
    await fetch('https://my-api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(items),
    });
    return items;
  },
}
```

---

## The `Page` object

Passed to `onPage`, and available from `parseHtml`.

```js
page.url             // final URL after redirects
page.baseUrl         // honours <base href>
page.html
page.$               // the cheerio instance

page.select(sel)     // CSS or XPath -> cheerio selection
page.selectValues(sel) // string values (handles @attr, text(), count())
page.exists(sel)
page.title()
page.text(selector)  // visible text, block-aware newlines
page.links(sel)      // [{ url, text, rel, title }] absolute, de-duplicated
page.resolve(href)
page.canonical()
page.metaTags()      // { name/property: content }
page.openGraph()     // og:* without the prefix
page.jsonLd()        // parsed JSON-LD blocks, @graph flattened
page.jsonLdOfType(t)
page.microdata()     // itemscope/itemprop as nested objects
page.tables(sel)     // [{ caption, headers, rows, records }]
```

---

## Standalone components

Everything is exported and usable on its own.

```js
import { parseHtml, extractItems } from 'harvester';

const page = parseHtml(html, 'https://example.com');
const { items, issues, stats } = extractItems(
  { item: { selector: '.product', fields: { title: 'h2' } } },
  page,
);
```

```js
import { applyTransforms, parseCurrency, parseDate } from 'harvester';

applyTransforms('  £1,299.00  ', ['clean', 'currency']);  // 1299
parseCurrency('Rp 150.000');                              // { amount: 150000, currency: 'IDR', … }
parseDate('3 days ago', { output: 'day' });               // '2026-07-28'
```

```js
import { xpath, parseHtml } from 'harvester';

const page = parseHtml(html, 'https://example.com');
xpath.evaluateToStrings('//a/@href', page.root);
xpath.evaluate('count(//div[@class="item"])', page.root);
```

```js
import { HttpClient, RobotsTxt, RateLimiter, CookieJar, ProxyPool } from 'harvester';

const client = new HttpClient({ timeoutMs: 10000 });
const response = await client.request({ url: 'https://example.com', proxy: 'http://…' });
await client.close();

const robots = RobotsTxt.parse(robotsTxtText);
robots.check('https://example.com/admin', 'MyBot');   // { allowed, reason, rule }
```

```js
import { createWriter, MultiWriter, BufferedSink } from 'harvester';

const writer = new MultiWriter(['out.csv', 'out.json']);
const sink = new BufferedSink(writer, { batchSize: 500 });
await sink.open();
await sink.push(records);
await sink.close();
```

---

## Custom transforms

```js
import { registerTransform } from 'harvester';

registerTransform('gbpToEur', (value, ctx) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1.17 * 100) / 100 : null;
});
```

Then `transform: ['currency', 'gbpToEur']` in any recipe.

---

## The run report

```js
const report = await scraper.run();
```

```js
{
  name, startedAt, finishedAt, durationMs, durationHuman,
  completed, stopReason,
  resumed: { pages, items, totalPages, totalItems } | null,

  pages:  { ok, failed, skipped, rendered, fromCache, queuedRemaining, blockedByRobots },
  items:  { extracted, written, duplicates, invalid },
  rates:  { requestsPerSec, itemsPerSec, pagesPerMinute, itemsPerPage },

  fieldHealth: [{ label, field, attempts, filled, fillRate, status }],
  failures:    [{ reason, count, examples }],
  hosts:       { 'shop.com': { requests, ok, failed, items, avgMs, successRate } },
  latency:     { count, mean, p50, p90, p99, max },

  subsystems: { cache, dedupe, validation, robots, proxies, circuits,
                rateLimiters, renderer, captcha, hooks },
  outputs, warnings, counters,
}
```

`fieldHealth` is the one to watch in production. A field whose `status` is
`broken` means its selector stopped matching:

```js
const broken = report.fieldHealth.filter((f) => f.status === 'broken');
if (broken.length) {
  await alert(`Selectors broke: ${broken.map((f) => f.field).join(', ')}`);
}
```

```js
import { formatReport } from 'harvester';
process.stderr.write(formatReport(report));
```

---

## A complete example

```js
import { Scraper, defineRecipe, formatReport, createLogger } from 'harvester';

const { config, hooks } = defineRecipe({
  name: 'monitor',
  start_urls: ['https://books.toscrape.com'],
  rate_limit: { requests_per_second: 1 },
  crawl: { pagination: { selector: 'li.next a', max_pages: 5 } },
  extract: {
    item: {
      selector: 'article.product_pod',
      fields: {
        title: { selector: 'h3 a', attr: 'title', required: true },
        price: { selector: '.price_color', transform: ['clean', 'currency'], type: 'number' },
      },
    },
  },
  validate: { schema: { title: { required: true }, price: { type: 'number', min: 0 } } },
  dedupe: { strategy: 'fields', key_fields: ['title'] },
  output: ['books.ndjson'],

  hooks: {
    onItem: (item) => ({ ...item, captured: new Date().toISOString() }),
  },
});

const scraper = new Scraper(config, { hooks, logger: createLogger({ level: 'info' }) });

process.on('SIGINT', () => scraper.stop('interrupted'));

const report = await scraper.run();
process.stderr.write(formatReport(report));

if (report.fieldHealth.some((f) => f.status === 'broken')) process.exitCode = 2;
```

---

## Next

- [Output formats](11-output.md)
- [Architecture](12-architecture.md)
