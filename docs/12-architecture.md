# Architecture

How the pieces fit, and why they're arranged this way.

---

## Module map

```
src/
├── core/
│   ├── scraper.js        Orchestrator: owns the run loop and wires everything
│   ├── pipeline.js       Lifecycle hooks
│   └── report.js         Run report + terminal rendering
│
├── http/                 1. Core extraction — the request side
│   ├── client.js         Request engine (undici): timeouts, decoding, byte caps
│   ├── headers.js        Coherent, correctly-ordered header sets
│   ├── cookies.js        RFC 6265 cookie jar
│   ├── useragent.js      Browser profiles (UA + matching headers + viewport)
│   ├── proxy.js          Proxy pool with health tracking
│   └── cache.js          On-disk response cache
│
├── parse/                1. Core extraction — the parsing side
│   ├── dom.js            Page object: unified CSS/XPath querying, structured data
│   ├── xpath.js          XPath 1.0 engine over the parsed tree
│   ├── extractor.js      Declarative field extraction
│   └── pagination.js     Link discovery and pagination
│
├── render/               1. Core extraction — dynamic content
│   └── renderer.js       Playwright: contexts, actions, `auto` heuristic
│
├── resilience/           2. Resilience and anti-blocking
│   ├── ratelimiter.js    Token bucket + spacing + AIMD backoff
│   ├── retry.js          Retry policy with corrective adjustments
│   ├── circuitbreaker.js Per-host circuit breaker
│   └── captcha.js        Bot-wall detection, solver interface
│
├── process/              3. Data processing
│   ├── transforms.js     The transform library
│   ├── validate.js       Record schema validation
│   └── dedupe.js         Exact and Bloom-filter de-duplication
│
├── storage/              3. Data storage
│   ├── writers.js        NDJSON, JSON, CSV, XLSX, SQLite, console
│   └── index.js          Format registry, fan-out, buffering
│
├── queue/                4. Operational management
│   ├── frontier.js       Per-host priority queues
│   ├── state.js          Crash-safe checkpointing
│   └── urlutils.js       Canonicalisation and matching
│
├── compliance/           5. Compliance
│   ├── robots.js         RFC 9309 parser and enforcement
│   └── sitemap.js        Sitemap discovery and parsing
│
├── observability/        4. Operational management
│   ├── logger.js         Structured logging with secret redaction
│   ├── metrics.js        Counters, gauges, latency histograms
│   └── progress.js       Live terminal progress
│
├── config/
│   ├── defaults.js       Defaults and presets
│   ├── schema.js         Normalisation and validation
│   └── loader.js         YAML/JSON/JS loading, env interpolation
│
└── cli/
    ├── index.js          Commands
    ├── args.js           Argument parser
    ├── inspect.js        Page analysis and recipe generation
    └── templates.js      `harvest init` templates
```

Every module is independently usable. `HttpClient`, `RobotsTxt`, the XPath
engine and the writers have no dependency on the orchestrator.

---

## The request lifecycle

```
                        ┌──────────────┐
                        │   Frontier   │  per-host priority queues
                        └──────┬───────┘
                               │ checkout (circuit + per-host concurrency)
                               ▼
                        ┌──────────────┐
                        │  robots.txt  │  ← disallowed? cost: zero bytes
                        └──────┬───────┘
                               ▼
                        ┌──────────────┐
                        │ Rate limiter │  token bucket + spacing + jitter
                        └──────┬───────┘
                               ▼
                        ┌──────────────┐
                        │  HTTP cache  │──hit──┐
                        └──────┬───────┘       │
                               │ miss          │
                               ▼               │
                    ┌────────────────────┐     │
                    │   HTTP request     │     │
                    │  (proxy, identity) │     │
                    └──────────┬─────────┘     │
                               ▼               │
                    ┌────────────────────┐     │
                    │  Block detection   │     │
                    └──────────┬─────────┘     │
                     needs JS? │ blocked?      │
                               ▼               │
                    ┌────────────────────┐     │
                    │  Headless browser  │     │
                    └──────────┬─────────┘     │
                               ▼               │
                        ┌──────────────┐◄──────┘
                        │    Parse     │
                        └──────┬───────┘
                    ┌──────────┴──────────┐
                    ▼                     ▼
            ┌──────────────┐      ┌──────────────┐
            │   Extract    │      │  Discover    │
            └──────┬───────┘      │    links     │
                   ▼              └──────┬───────┘
            ┌──────────────┐             │
            │  Deduplicate │             └──► back to the Frontier
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │   Validate   │──invalid──► quarantine.ndjson
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │    Hooks     │  onItem / onItems
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │    Writers   │  buffered fan-out
            └──────────────┘
```

The order is deliberate:

- **robots.txt first.** A URL we may not fetch should cost zero bytes.
- **Rate limiting before the request**, not after — throttling a response you've
  already taken is pointless.
- **Block detection before parsing.** A challenge page returns HTTP 200; parsing
  it produces thousands of empty records and a silent data-quality failure.
- **De-duplication before validation and writing.** A duplicate should never
  touch disk, and shouldn't inflate validation statistics.
- **Link discovery independent of extraction.** An intermediate listing page is
  often item-free by design; that mustn't stop the crawl.

---

## Concurrency

Three independent limits:

| Limit | Purpose |
|---|---|
| `concurrency` | global in-flight requests — protects *you* |
| `concurrency_per_host` | in-flight per host — protects *them* |
| `rate_limit` | requests per second per host — protects them further |

Workers pull round-robin across hosts, preferring a host that's ready *now* so
they aren't parked on a slow domain while another has capacity. A worker that
finds no eligible work sleeps briefly and retries; the loop ends when the
frontier is empty *and* nothing is in flight.

---

## Design decisions worth explaining

### Declarative recipes, not code

A scraper is mostly a description of where data lives. Expressing that as data
means it can be validated before the first request, generated by `inspect`,
diffed in review, and edited by someone who doesn't write JavaScript. Code is
still available — a `.js` recipe with hooks — for the parts that genuinely need
logic.

### Validation before the first request

Selector syntax, XPath syntax, transform names, regex validity, output formats
and enum values are all checked at load time. A typo'd transform should not
surface as an empty column an hour into a crawl.

### Fallback chains as a first-class feature

Sites get redesigned; that's the normal case, not the exception. A field that
can say "JSON-LD, then this selector, then that one" survives changes that break
any single strategy. It's the difference between a scraper that runs for a year
and one that breaks in a month.

### Structured data before CSS

JSON-LD and microdata exist for search engines, which means sites have a strong
incentive to keep them working across redesigns. `harvest inspect` surfaces them
first for that reason.

### Field health in the report

The failure mode that costs the most is the *silent* one: the scrape "succeeds",
writes records, and one column has been empty for three weeks. Per-field fill
rates turn that into a visible warning and a non-zero exit code.

### Quarantine, not drop

Invalid records go to a file with the reason attached. Dropping them silently
hides exactly the signal you need — that the site changed.

### Retries that change something

Repeating an identical request from an identical IP rarely helps. Each retry
returns an *adjustment*: rotate proxy, rotate identity, escalate to a browser,
fresh browser context.

### Adaptive rate limiting

The configured rate is a ceiling, not a target. On a 429 the limiter halves its
own rate and recovers slowly (AIMD). A crawl that starts too fast corrects
itself rather than earning a ban.

### Conservative defaults

robots.txt enforced, 1 req/s, identifying User-Agent, crawl confined to the seed
domains, no CAPTCHA solving. A recipe that says nothing about politeness is
polite; going faster is an explicit, attributable choice.

### A dependency tree you can audit

Three runtime dependencies — `cheerio` (HTML parsing), `undici` (HTTP), `yaml`
(recipes) — plus optional `playwright`. XLSX, ZIP, SQLite, XPath, robots.txt,
sitemaps, cookies, Bloom filters and the CLI parser are all implemented
directly. Fewer things to audit, fewer supply-chain surprises.

---

## Extending it

**A transform**

```js
import { registerTransform } from 'harvester';
registerTransform('myThing', (value) => transform(value));
```

**An output destination** — implement `open` / `write` / `close`:

```js
import { Writer } from 'harvester/storage';
class MyWriter extends Writer { /* … */ }
```

**Behaviour** — hooks, covered in [Programmatic API](06-api.md#hooks).

**A component** — every class is exported and constructible on its own; swap
`HttpClient`, `Frontier`, `Deduplicator` or `RateLimiter` for your own
implementation of the same interface.

---

## Testing

```bash
npm test
```

202 tests: the XPath engine against a real DOM, robots.txt against RFC 9309
cases, transforms against real-world number and date formats, the frontier's
ordering and resume semantics, writers against their actual file formats, and
**end-to-end runs against a local HTTP server** exercising the full pipeline —
robots enforcement, retries, pagination, per-host concurrency, checkpoint and
resume, caching, quarantine, and browser rendering with interaction scripts.

The render tests skip themselves when Playwright isn't installed rather than
failing a valid install.
