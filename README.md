# Harvester

A professional, modular web scraping framework. Describe what you want in a
YAML file; it handles requests, JavaScript rendering, anti-blocking, cleaning,
validation, de-duplication and output — and tells you when a site changes.

**Point-and-click, in your browser:**

```bash
npm install
npm run ui
```

Paste a URL, and it finds the selectors, writes the recipe, tests it, and shows
the data arriving live. [→ Web interface](docs/13-web-interface.md)

**Or from the terminal:**

```bash
harvest inspect https://books.toscrape.com --generate books.yaml   # find the selectors
harvest test books.yaml                                            # check them
harvest run books.yaml -o books.csv                                # run it
```

The `harvest` command needs `npm link` first — see [Install](#install).

---

## Why this one

**It finds the selectors for you.** Give it a URL and it analyses the page —
which repeated blocks look like records, what structured data is published,
whether JavaScript is required, how pagination works — then writes a working
recipe. In the browser or with `harvest inspect`.

**It tells you when it breaks.** Every run reports per-field fill rates. A
selector that stopped matching shows up as `price: 0% filled` and a non-zero
exit code, not as a column that's been quietly empty for three weeks.

**It's polite by default.** robots.txt enforced, one request per second per
host, an identifying User-Agent, and crawls confined to your seed domains. Going
faster is an explicit choice.

**It's honest about the hard parts.** CAPTCHA solving isn't bundled, the stealth
patches don't claim to beat commercial fingerprinting, and the compliance docs
tell you when to stop rather than how to push through.

---

## Install

```bash
npm install
```

That's enough to use it — via npm scripts, which always work:

```bash
npm run ui                          # the web interface
npm run harvest -- run r.yaml       # the CLI (note the `--`)
node bin/harvest.js run r.yaml      # or by path
```

To type `harvest` instead, register the command once:

```bash
npm link
```

Then **open a new terminal** — a shell caches which commands exist when it
starts, so a window you already had open won't find it. If you see *"harvest is
not recognized"*, that's why; see
[Troubleshooting](docs/10-troubleshooting.md#harvest-is-not-recognized-as-a-command).

For JavaScript-heavy sites:

```bash
npm install playwright && npx playwright install chromium
```

Requires Node 20+. Runtime dependencies: `cheerio`, `undici`, `yaml`.

---

## A recipe

```yaml
name: books
start_urls:
  - url: https://books.toscrape.com/
    label: listing

rate_limit:
  requests_per_second: 1

identity:
  contact: https://example.com/about-my-crawler

crawl:
  pagination: { selector: "li.next a", max_pages: 50 }
  follow:
    - { selector: "article.product_pod h3 a", label: detail, on: listing }

extract:
  listing:
    fields: {}
  detail:
    fields:
      title:
        selector: "div.product_main h1"
        required: true
      price:
        selector: "p.price_color"
        transform: [clean, currency]     # "£51.77" -> 51.77
        type: number
      stock:
        selector: "p.availability"
        transform: [clean, digits, int]
        type: integer
      description:
        selector: "#product_description ~ p"
        transform: [clean]

validate:
  schema:
    title: { required: true, min_length: 1 }
    price: { type: number, min: 0 }
  on_invalid: quarantine

dedupe:
  strategy: fields
  key_fields: [title]

output:
  - books.ndjson
  - books.csv
```

```bash
harvest run books.yaml
```

```
books finished in 1m 42s
────────────────────────────────────────────────────────────
  Pages    1050 ok
  Items    1000 written
  Speed    617 pages/min · 0.95 items/page
  Latency  p50 84ms · p90 210ms · max 1.9s
  Output   books.ndjson (ndjson, 1000 records)
  Output   books.csv (csv, 1000 records)
────────────────────────────────────────────────────────────
```

---

## Features

### Core extraction

- **HTTP engine** on undici — connection pooling, HTTP/2, proxies, cookies,
  redirect chains, charset detection, byte caps, gzip/brotli/zstd
- **CSS selectors** via cheerio, and a real **XPath 1.0 engine** — all 13 axes,
  predicates, unions, arithmetic, and the core function library — implemented
  directly against the parsed tree
- **Structured data** — JSON-LD (with `@graph` flattening), microdata,
  OpenGraph, and HTML tables, read as first-class sources
- **Dynamic rendering** via Playwright, with an `auto` mode that starts a
  browser only for pages that actually need one

### Resilience

- **Adaptive rate limiting** — token bucket, per-host spacing, jitter, and AIMD
  backoff that halves the rate on a 429 and recovers slowly
- **Retries that change something** — rotate proxy, rotate identity, escalate to
  a browser, fresh context; full jitter; `Retry-After` obeyed
- **Per-host circuit breakers** so one dead domain can't consume the run
- **Coherent identity rotation** — each profile pairs a User-Agent with the
  header set that browser genuinely sends, in the right order
- **Proxy pool** with health tracking, benching and revival
- **Bot-wall detection** for Cloudflare, DataDome, PerimeterX, Akamai, Imperva,
  reCAPTCHA and hCaptcha — so a challenge page doesn't become 10,000 empty rows

### Processing and storage

- **57 transforms** — currency parsing that handles both decimal conventions,
  date parsing including relative phrases, entity decoding, regex extraction
- **Schema validation** with `warn` / `drop` / `quarantine` / `error`
- **De-duplication** by record, key fields, or URL; exact or Bloom-filter;
  persistable for incremental runs
- **Output** to NDJSON, JSON, CSV, TSV, Excel, SQLite, stdout, gzipped —
  several at once, streaming where the format allows

### Operations

- **Crash-safe checkpointing** — `--resume` continues an interrupted crawl
- **Per-host priority frontier** with canonical URL de-duplication
- **Field health reporting** — the thing that catches silent breakage
- **Structured logging** with credential redaction, metrics, live progress
- **Machine-readable run reports** for CI

### Compliance

- **RFC 9309 robots.txt** — most-specific-match precedence, wildcards, `$`
  anchors, group selection, `Crawl-delay`, fail-closed on error
- **Sitemap discovery** — indexes, gzip, plain-text
- **Honest defaults** — identifying User-Agent, conservative pacing, seed-domain
  confinement

---

## From JavaScript

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

```js
import { Scraper, defineRecipe } from 'harvester';

const { config, hooks } = defineRecipe(recipe);
const scraper = new Scraper(config, { hooks });
scraper.on('item', (item) => console.log(item));
const report = await scraper.run();

if (report.fieldHealth.some((f) => f.status === 'broken')) {
  throw new Error('The site changed — selectors need updating');
}
```

---

## CLI

| Command | Purpose |
|---|---|
| `harvest ui` | Open the visual interface in your browser |
| `harvest run <recipe>` | Run a scrape |
| `harvest inspect <url>` | Analyse a page, suggest selectors, generate a recipe |
| `harvest test <recipe>` | Dry-run extraction on one page, with coverage bars |
| `harvest quick <url>` | Ad-hoc scrape, no recipe |
| `harvest init [name]` | Scaffold a recipe from a template |
| `harvest validate <recipe>` | Check a recipe without running it |
| `harvest robots <url>` | Show what robots.txt allows |
| `harvest transforms` | List every transform |
| `harvest cache clear\|prune` | Manage the response cache |

---

## Documentation

| | |
|---|---|
| [Getting started](docs/01-getting-started.md) | Zero to a working scraper |
| [Web interface](docs/13-web-interface.md) | The browser UI, end to end |
| [Writing recipes](docs/02-recipes.md) | Every option, with examples |
| [CLI reference](docs/03-cli.md) | Commands, flags, exit codes |
| [Selectors and fields](docs/04-selectors.md) | CSS, XPath, structured data, transforms |
| [Crawling](docs/05-crawling.md) | Frontier, following, pagination, resume |
| [Programmatic API](docs/06-api.md) | Classes, hooks, events, reports |
| [Dynamic content](docs/07-dynamic-content.md) | Rendering, actions, performance |
| [Anti-blocking](docs/08-anti-blocking.md) | Rate limits, proxies, identity, bot walls |
| [Compliance and ethics](docs/09-compliance.md) | robots.txt, terms, personal data |
| [Troubleshooting](docs/10-troubleshooting.md) | Symptoms → causes → fixes |
| [Output formats](docs/11-output.md) | Every writer and its options |
| [Architecture](docs/12-architecture.md) | How it fits together, and why |

Runnable examples are in [`recipes/`](recipes/).

---

## Testing

```bash
npm test
```

202 tests, including end-to-end runs against a local HTTP server that exercise
robots enforcement, retries, pagination, per-host concurrency, checkpoint and
resume, caching, quarantine, and real browser rendering.

---

## Responsible use

This tool makes it easy to collect data at scale. That's worth taking seriously.

Its defaults enforce robots.txt, pace requests conservatively, identify the
scraper honestly, and confine crawls to the domains you seeded. You can change
all of that — but the compliance documentation covers what you're taking on when
you do: terms of service, personal data under GDPR and similar regimes, and the
point at which continuing stops being a technical problem and becomes an ethical
one.

Read [docs/09-compliance.md](docs/09-compliance.md) before your first real run.
It's the most important page here.

---

## Licence

MIT — see [LICENSE](LICENSE).
