# Getting started

This guide takes you from zero to a working scraper in about five minutes.

---

## Install

```bash
npm install
npm link
```

`npm install` fetches the framework's three dependencies. `npm link` registers
the `harvest` command so you can run it from anywhere — **skip it and you'll get
`harvest : The term 'harvest' is not recognized`**, because the command simply
isn't on your PATH yet.

Check it worked:

```bash
harvest --version
```

> **Already open a terminal before linking?** Open a new one. A shell reads its
> PATH when it starts, so an existing window may not see a newly-registered
> command.

### If you'd rather not link

Everything works without it — run the CLI by path from the project folder:

```bash
node bin/harvest.js --version
node bin/harvest.js ui
```

Or use the npm scripts:

```bash
npm run ui                       # the web interface
npm run harvest -- run r.yaml    # note the `--` before the arguments
```

The rest of these docs write `harvest`; substitute `node bin/harvest.js` if you
skipped linking.

### Optional: dynamic rendering

For JavaScript-heavy sites:

```bash
npm install playwright && npx playwright install chromium
```

Everything except rendering works without it.

**Requirements:** Node 20 or newer. (Node 22.5+ additionally enables the
built-in SQLite output.)

---

## The quickest route: the web interface

If you'd rather click than type:

```bash
harvest ui
```

Your browser opens on a page with a URL box. Paste a site, press **Analyze**,
and Harvester tells you what's on the page and writes a recipe. From there you
can edit it with live validation, test the selectors against one page, and watch
the run happen — records appearing in a table as they're extracted.

Recipes it creates are ordinary files, so anything you build visually can be run
from the terminal or a cron job later. Full tour: [Web
interface](13-web-interface.md).

The rest of this guide covers the command line, which does exactly the same
things.

---

## The three-command workflow

Writing a scraper normally means an hour in browser dev tools guessing at CSS
selectors. Harvester inverts that: it looks at the page and tells you.

### 1. Inspect the page

```bash
harvest inspect https://books.toscrape.com
```

```
Books to Scrape
https://books.toscrape.com

  Status          200  51.2 KB
  JavaScript      not needed (static HTML is enough)
  robots.txt      allowed
  Links           93 (93 internal)

  Repeated blocks — candidates for `item.selector`
  → article.product_pod  ×20 (score 78)
      "A Light in the Attic £51.77 In stock Add to basket"
    li.col-xs-6  ×20 (score 41)

  Suggested fields
    title         h3 a → clean
    url           a @href
    price         p.price_color → currency
    image         img.thumbnail @src

  Pagination
    Next page found via li.next a
```

It reports whether the content needs JavaScript, what structured data the page
already publishes, which repeated blocks look like records, and how to page
through. Add `--generate` and it writes a runnable recipe:

```bash
harvest inspect https://books.toscrape.com --generate books.yaml
```

### 2. Test the selectors

```bash
harvest test books.yaml
```

```
  ✓ item.selector article.product_pod matched 20 element(s)

  Field coverage across 20 record(s)
    ✓ title             ██████████ 100%  20/20
    ✓ price             ██████████ 100%  20/20
    ✗ rating            ░░░░░░░░░░   0%   0/20

  Sample records (showing 3 of 20)
  ────────────────────────────────────────────
    title           A Light in the Attic
    price           51.77
```

One request, no crawling, nothing written. The coverage bars are the point: a
field at 0% is a broken selector, and you find out now rather than after an
hour-long crawl.

### 3. Run it

```bash
harvest run books.yaml -o books.csv
```

```
books finished in 24s
────────────────────────────────────────────
  Pages    50 ok
  Items    1000 written
  Speed    125 pages/min · 20 items/page
  Output   books.csv (csv, 1000 records)
```

---

## Your first recipe by hand

A recipe is a YAML file. The minimum is a URL and some fields:

```yaml
name: quotes
start_urls:
  - https://quotes.toscrape.com/

extract:
  item:
    selector: "div.quote"        # one record per match
    fields:
      text: "span.text"          # shorthand: selector, taken as text
      author: "small.author"
      tags:
        selector: "a.tag"
        all: true                # collect every match into an array

output:
  - quotes.csv
```

```bash
harvest run quotes.yaml
```

Three things happen automatically, without you asking:

- **robots.txt is fetched and obeyed**, including `Crawl-delay`.
- **Requests are paced** at one per second per host.
- **The scraper identifies itself** in its User-Agent.

These are defaults, not ceremony. See [Compliance](09-compliance.md) for why,
and how to change them when you have grounds to.

---

## Crawling more than one page

Two mechanisms, and they compose:

```yaml
crawl:
  # Walk the listing.
  pagination:
    selector: "li.next a"
    max_pages: 10

  # Queue every product link found on a listing page.
  follow:
    - selector: "article.product_pod h3 a"
      label: detail       # tags the queued URL
      on: listing         # only follow from pages labelled `listing`

  max_depth: 2
  deny_patterns: ["/cart", "\\.pdf$"]
```

Label your start URL and give each label its own fields:

```yaml
start_urls:
  - url: https://books.toscrape.com/
    label: listing

extract:
  listing:
    fields: {}                 # listing pages are crawled, not harvested
  detail:
    fields:
      title: "div.product_main h1"
      price:
        selector: "p.price_color"
        transform: [clean, currency]
        type: number
```

By default a crawl **cannot leave the domains of your start URLs**. You have to
opt into anything wider with `crawl.allowed_domains`.

---

## Cleaning values as you extract

Raw page text is messy: `"  £51.77  "` is a string, not a price. Transforms fix
that declaratively:

```yaml
price:
  selector: "p.price_color"
  transform: [clean, currency]   # "  £51.77  " -> 51.77
  type: number
```

```yaml
posted:
  selector: "time"
  attr: datetime
  transform: [date]              # "3 days ago" -> "2026-07-28T00:00:00.000Z"
```

`harvest transforms` lists all 57. Full reference: [Selectors and
fields](04-selectors.md).

---

## Output

Format is inferred from the extension. Several at once is fine:

```bash
harvest run books.yaml -o data.csv -o data.json -o data.xlsx
```

| Extension | Format | Good for |
|---|---|---|
| `.csv` / `.tsv` | delimited text | spreadsheets, quick inspection |
| `.json` | one JSON array | small datasets, APIs |
| `.ndjson` / `.jsonl` | one object per line | large runs, streaming, `jq` |
| `.xlsx` | Excel | sharing with non-technical colleagues |
| `.db` / `.sqlite` | SQLite | querying, incremental updates |
| `*.gz` | any of the above, gzipped | archives |

No `-o` prints NDJSON to stdout, so this works:

```bash
harvest run books.yaml | jq -r '.title'
```

---

## Using it from JavaScript

For a single page:

```js
import { scrape } from 'harvester';

const items = await scrape('https://books.toscrape.com', {
  selector: 'article.product_pod',
  fields: {
    title: 'h3 a',
    price: { selector: 'p.price_color', transform: ['currency'], type: 'number' },
  },
});
```

For a full run with hooks:

```js
import { Scraper, defineRecipe } from 'harvester';

const { config, hooks } = defineRecipe({
  start_urls: ['https://books.toscrape.com'],
  extract: { item: { selector: 'article.product_pod', fields: { title: 'h3 a' } } },
  hooks: {
    onItem: (item) => ({ ...item, scrapedBy: 'me' }),
  },
});

const scraper = new Scraper(config, { hooks });
scraper.on('item', (item) => console.log(item.title));
const report = await scraper.run();
```

Full surface: [Programmatic API](06-api.md).

---

## When a site needs JavaScript

If `harvest inspect` says *JavaScript required*, add:

```yaml
render:
  mode: auto                     # try HTTP first, use a browser only if needed
  wait_for_selector: ".product"
```

`auto` is almost always the right choice — it keeps the fast path fast and only
starts a browser for pages that genuinely need one. See [Dynamic
content](07-dynamic-content.md).

---

## Next

- [Writing recipes](02-recipes.md) — every option, with examples
- [Selectors and fields](04-selectors.md) — CSS, XPath, JSON-LD, transforms
- [Anti-blocking](08-anti-blocking.md) — what to do when a site pushes back
- [Compliance](09-compliance.md) — the legal and ethical side, honestly
- [Troubleshooting](10-troubleshooting.md) — when it doesn't work
