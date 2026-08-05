# Writing recipes

A recipe is a single file describing an entire scrape: where to start, how to
behave, what to extract, and where to put it. YAML is the default; JSON and
JavaScript work too.

Every key is optional except `start_urls` and `extract`.

Keys may be written `snake_case` (the YAML convention used throughout these
docs) or `camelCase`. Your own names — field names, header names, route labels —
are **never** rewritten.

---

## Table of contents

- [Minimal recipe](#minimal-recipe)
- [Full reference](#full-reference)
  - [Identity and metadata](#identity-and-metadata)
  - [`start_urls`](#start_urls)
  - [Limits](#limits)
  - [`http`](#http)
  - [`identity`](#identity)
  - [`rate_limit`](#rate_limit)
  - [`retry`](#retry)
  - [`circuit_breaker`](#circuit_breaker)
  - [`robots`](#robots)
  - [`render`](#render)
  - [`proxy`](#proxy)
  - [`captcha`](#captcha)
  - [`cache`](#cache)
  - [`crawl`](#crawl)
  - [`extract`](#extract)
  - [`validate`](#validate)
  - [`dedupe`](#dedupe)
  - [`output`](#output)
  - [`metadata`](#metadata)
  - [`resume`](#resume)
  - [`logging`](#logging) and [`report`](#report)
- [Environment variables](#environment-variables)
- [Presets](#presets)
- [JavaScript recipes](#javascript-recipes)

---

## Minimal recipe

```yaml
start_urls:
  - https://books.toscrape.com/

extract:
  item:
    selector: "article.product_pod"
    fields:
      title: "h3 a"
      price:
        selector: "p.price_color"
        transform: [clean, currency]
        type: number

output:
  - books.csv
```

---

## Full reference

### Identity and metadata

```yaml
name: my-scraper          # used in logs, reports, and as a default filename
description: >
  What this collects and why. Worth writing — the person debugging this in
  six months is probably you.
```

### `start_urls`

Where the crawl begins. A bare string, or an object for more control.

```yaml
start_urls:
  - https://example.com/page-1                # simple form

  - url: https://example.com/api/items        # full form
    label: api                                # routes to extract.api
    method: POST
    headers:
      x-api-version: "2"
    body:
      query: "widgets"
    meta:                                     # arbitrary data, carried through
      source: partner-feed
    render: true                              # force a browser for this URL
```

`label` is the routing key: it selects which `extract` block runs, and which
`crawl.follow` rules apply. Default is `default`.

### Limits

```yaml
concurrency: 4              # global in-flight requests
concurrency_per_host: 2     # per-host cap — the one that protects the target
max_pages: 0                # 0 = unlimited
max_items: 0                # 0 = unlimited
max_runtime_ms: 0           # 0 = unlimited
```

`concurrency_per_host` is the number that matters. A crawl spanning 50 domains
at `concurrency: 20` is polite; 20 concurrent requests at one small site is not.

### `http`

```yaml
http:
  method: GET
  headers:
    accept-language: "en-GB,en;q=0.9"
  timeout_ms: 30000
  connect_timeout_ms: 10000
  max_redirects: 5
  max_response_bytes: 10485760   # 10 MiB — guards against huge downloads
  http2: false
  cookies: true                  # keep a session across requests
  reject_unauthorized: true      # NEVER disable except for a corporate MITM proxy
  cookie_jar:                    # seed cookies, e.g. a session from your browser
    session_id: "${SESSION_ID}"
```

### `identity`

How the scraper presents itself.

```yaml
identity:
  mode: bot                 # bot | rotate | custom
  contact: https://example.com/crawler   # strongly recommended
  user_agent: null          # set this for mode: custom
  strategy: sticky          # sticky | random | sequential (for mode: rotate)
  profiles: null            # restrict rotation to named browser profiles
  include_mobile: false
```

- **`bot`** (default) sends an honest, identifying User-Agent. Site owners who
  can see who you are and how to reach you block you far less often than they
  block an anonymous client pretending to be Chrome.
- **`rotate`** cycles through coherent browser profiles — UA, `Accept`,
  `Sec-CH-UA` and viewport all consistent. Use it when a site blocks all
  non-browser traffic, not as a way to hide.
- `strategy: sticky` pins one identity per host for the whole run, which is far
  more believable than changing browser mid-session.

### `rate_limit`

```yaml
rate_limit:
  requests_per_second: 1     # sustained, per host
  burst: 1                   # token bucket capacity
  min_delay_ms: 0            # hard floor between requests to one host
  jitter_ratio: 0.25         # random extra delay, as a FRACTION of the interval
  max_jitter_ms: 2000        # absolute cap on that jitter
  adaptive: true             # halve the rate on 429/503, recover slowly
  throttle_penalty_ms: 30000 # pause after an explicit 429
```

**`requests_per_second` is per host.** A crawl of one domain gets that rate no
matter how high `concurrency` is — extra workers simply sit idle. This is the
most common source of "why is it slow?"; `harvest profile --dry` says so
explicitly.

**Jitter is a fraction of the interval, not a fixed number of milliseconds.**
Its purpose is variance *relative to* the spacing, so a fixed ±125 ms is
meaningful at 1 req/s and a hard ceiling at 50. The mean interval works out at
`(1000 / requests_per_second) × (1 + jitter_ratio / 2)`, so the default costs
about 11%. Set `jitter_ratio: 0` for exact pacing.

> **Migrating from `jitter_ms`** — the old key still works and is converted
> automatically (`jitter_ms × rps / 1000`), with a warning. At the old defaults
> (250 ms at 1 req/s) that is exactly `0.25`, so existing recipes are unchanged.

`adaptive` is AIMD — the same idea TCP congestion control uses. On a 429 the
rate halves and (if the server sent `Retry-After`, or the status was 429) the
host pauses; after a run of clean responses it climbs back. This is what keeps a
long crawl from earning a ban.

`robots.txt` `Crawl-delay` raises `min_delay_ms` automatically; the stricter of
the two always wins. When it does, `requests_per_second` has no effect at all —
the run report says so.

### `authorization`

```yaml
authorization:
  basis: public        # public | owner | permission | api-terms
  note: "written permission from ops@example.com, 2026-01-12"
```

Purely declarative — it gates a warning, never behaviour. Above 4 req/s or 4
concurrent per host you get a warning unless a basis other than `public` is
declared. It is recorded in `report.posture`, which is what makes an aggressive
rate auditable rather than anonymous.

### `retry`

```yaml
retry:
  max_attempts: 3
  base_delay_ms: 1000
  max_delay_ms: 60000
  factor: 2
  jitter: true
  respect_retry_after: true
  retry_statuses: [408, 425, 429, 500, 502, 503, 504, 509, 520, 521, 522, 523, 524]
  rotate_proxy_on_retry: true
  rotate_user_agent_on_retry: true
  escalate_to_browser: true    # retry a blocked page with a real browser
```

`403` is deliberately **not** retried by default — it usually means "you may not
have this", and hammering it is both rude and futile. Add it to `retry_statuses`
if you have reason to believe it's a soft block.

### `circuit_breaker`

```yaml
circuit_breaker:
  enabled: true
  failure_threshold: 5          # consecutive failures before opening
  failure_rate_threshold: 0.7   # or this share of a sliding window
  window_size: 20
  minimum_requests: 10
  reset_timeout_ms: 60000       # doubles on each re-open
```

When a host starts failing consistently, requests to it fail fast instead of
piling on. A single dead domain then can't consume the whole run's time budget.

### `robots`

```yaml
robots:
  enabled: true
  respect_crawl_delay: true
  user_agent: null        # defaults to your identity
  on_error: deny          # deny | allow — what to do when robots.txt is unreachable
  cache_ttl_ms: 3600000
```

`on_error: deny` is the default because guessing permissively is the unsafe
guess. See [Compliance](09-compliance.md).

### `render`

```yaml
render:
  mode: never             # never | auto | always
  engine: chromium        # chromium | firefox | webkit
  headless: true
  max_contexts: 4
  timeout_ms: 30000
  wait_until: domcontentloaded   # load | domcontentloaded | networkidle | commit
  wait_for_selector: ".product"
  wait_for_timeout: 0
  block_resources: [image, media, font]
  stealth: true
  screenshot: false
  scroll:
    enabled: true
    max_scrolls: 10
    delay_ms: 500
  actions:
    - { type: click, selector: "#accept-cookies", optional: true }
    - { type: clickAll, selector: ".load-more", limit: 10, delay: 1000 }
```

Full details in [Dynamic content](07-dynamic-content.md).

### `proxy`

```yaml
proxy:
  urls:
    - http://user:pass@proxy1.example.com:8080
    - socks5://proxy2.example.com:1080
  file: ./proxies.txt          # one per line, `#` comments allowed
  strategy: round-robin        # round-robin | random | sticky | least-used
  max_consecutive_failures: 3  # then bench the proxy
  bench_duration_ms: 300000
  remove_dead: false
```

Credentials are masked in all logs and reports.

### `captcha`

```yaml
captcha:
  detect: true
  strategy: render      # retry | render | solve | manual | fail
  min_confidence: 0.5
```

Detection matters even if you never solve anything: a challenge page returns
HTTP 200, so without it a scraper "succeeds" and writes thousands of empty
records. See [Anti-blocking](08-anti-blocking.md).

### `cache`

```yaml
cache:
  enabled: false
  dir: .harvester/cache
  ttl_ms: 86400000        # 24h
```

Turn this on while you iterate on selectors. The target server sees one request
instead of thirty, and your edit-test loop gets much faster.

### `crawl`

```yaml
crawl:
  max_depth: 3
  allowed_domains: []         # empty = the hosts of your start_urls
  allow_patterns: []          # if set, a URL must match one
  deny_patterns:              # deny always wins over allow
    - "/cart"
    - "\\.(pdf|zip|jpg)$"

  follow:
    - selector: "article.product h3 a"
      label: detail           # routes matched URLs to extract.detail
      on: listing             # only follow from pages labelled `listing`
      attr: href
      priority: 0             # lower runs first
      max_links: 50
      meta: { source: catalogue }

  pagination:
    selector: "li.next a"     # or xpath / param / url_template
    max_pages: 20

  normalization:
    strip_tracking: true      # drop utm_*, fbclid, gclid, …
    strip_fragment: true
    sort_query: true
    strip_www: false
```

Full details in [Crawling](05-crawling.md).

### `extract`

Either one block:

```yaml
extract:
  item:
    selector: ".product"      # repeating container; omit for one record per page
    fields:
      title: "h1"
```

Or one block per route label:

```yaml
extract:
  listing:
    fields: {}                # crawled but harvested for nothing
  detail:
    fields:
      title: "h1"
```

Shortcuts:

```yaml
extract:
  tables: true                # every <table> becomes records
  jsonld: Product             # every JSON-LD entity of this @type
```

Full field reference in [Selectors and fields](04-selectors.md).

### `validate`

```yaml
validate:
  schema:
    title:
      required: true
      type: string
      min_length: 2
      max_length: 200
    price:
      type: number
      min: 0
      max: 100000
    status:
      enum: [new, used, refurbished]
    sku:
      pattern: "^[A-Z]{2}-\\d+$"
  strict: false               # reject unknown fields
  min_filled_fields: 2        # catch near-empty records
  on_invalid: quarantine      # warn | drop | quarantine | error
```

`quarantine` is the default and the right one: invalid records go to
`quarantine.ndjson` next to your output, with the reason attached. Silently
dropping them hides the fact that a site changed.

### `dedupe`

```yaml
dedupe:
  enabled: true
  strategy: record            # record | fields | url
  key_fields: [sku]           # required for strategy: fields
  ignore_fields: [_scraped_at, _url]
  store: set                  # set | bloom
  persist_path: .harvester/seen.json   # enables incremental runs
  case_sensitive: false
```

`persist_path` makes runs incremental: point two runs at the same file and the
second only emits records it hasn't seen before.

Use `store: bloom` above a few million records — fixed memory, with a tiny
false-positive rate that can only ever over-detect duplicates.

### `output`

```yaml
output:
  - products.csv                    # format inferred from the extension
  - path: products.json
    pretty: true
  - path: products.xlsx
    sheet_name: Products
  - path: products.db
    format: sqlite
    table: products
    upsert_key: sku
  - format: console
    mode: table
```

See [Output formats](11-output.md).

### `metadata`

Fields added to every record.

```yaml
metadata:
  url: true            # _url — which page it came from
  scraped_at: true     # _scraped_at — ISO timestamp
  depth: false         # _depth
  label: false         # _label
```

`metadata: false` turns them all off.

### `resume`

```yaml
resume:
  enabled: false
  state_path: .harvester/state.json
  interval_ms: 10000
```

Checkpoints the frontier, cookies and counters. `harvest run r.yaml --resume`
picks up where an interrupted run stopped. A checkpoint written by a *different*
recipe is refused rather than silently mixing incompatible data.

### `logging`

```yaml
logging:
  level: info        # silent | error | warn | info | debug | trace
  format: null       # null = pretty when stderr is a TTY, else json
  progress: true
```

Logs always go to **stderr**, so `harvest run r.yaml > data.ndjson` keeps stdout
clean for piping.

### `report`

```yaml
report: ./run-report.json
```

Writes the full machine-readable report: per-field fill rates, grouped
failures, per-host stats, subsystem health. Useful in CI to detect a site
changing before the data quality does.

---

## Environment variables

`${VAR}` and `${VAR:-default}` are substituted from the environment, and from a
`.env` file sitting next to the recipe. Keep credentials out of the recipe:

```yaml
http:
  headers:
    authorization: "Bearer ${API_TOKEN}"
proxy:
  urls:
    - "http://${PROXY_USER}:${PROXY_PASS}@proxy.example.com:8080"
```

```bash
# .env  (add it to .gitignore)
API_TOKEN=abc123
```

---

## Presets

Layered *under* your recipe, so anything you set explicitly wins.

```bash
harvest run r.yaml --preset careful
```

| Preset | Effect |
|---|---|
| `owned` | 50 req/s, 32 concurrent — **only** for a site you own or have permission for. Declares `authorization.basis: owner`. Does *not* disable robots.txt. |
| `fast` | 16 concurrent, 8 req/s — for sites that explicitly permit it |
| `polite` | the defaults, stated explicitly |
| `careful` | 2 concurrent, 1 request every ~3.8s, 5 retries |
| `spa` | rendering always on, low concurrency |
| `develop` | 5 pages, caching on, debug logging |

Because presets layer *under* the recipe, a recipe that sets `rate_limit` or
`concurrency` explicitly will override them — `harvest profile` tells you when
that's happening rather than letting you wonder why a preset did nothing.

---

## JavaScript recipes

When you need real logic — computed URLs, custom transforms, lifecycle hooks —
use `.js` instead of `.yaml`:

```js
// shop.recipe.js
export default {
  name: 'shop',

  // Generate 100 category URLs rather than listing them.
  start_urls: Array.from({ length: 100 }, (_, i) => ({
    url: `https://example.com/category/${i + 1}`,
    label: 'listing',
  })),

  extract: {
    listing: {
      item: {
        selector: '.product',
        fields: {
          title: 'h2',
          price: { selector: '.price', transform: ['currency'], type: 'number' },
        },
      },
    },
  },

  hooks: {
    // Drop records we don't care about.
    onItem(item) {
      if (item.price == null || item.price > 1000) return null;
      return { ...item, priceBand: item.price < 50 ? 'budget' : 'standard' };
    },

    // Queue extra URLs discovered at runtime.
    onPage(page, ctx) {
      for (const link of page.links('a.related')) ctx.enqueue({ url: link.url, label: 'listing' });
    },

    onRunEnd(report) {
      if (report.warnings.length) console.error('Review:', report.warnings);
    },
  },

  output: ['products.ndjson'],
};
```

```bash
harvest run shop.recipe.js
```

Every hook is listed in [Programmatic API](06-api.md#hooks).

---

## Next

- [CLI reference](03-cli.md)
- [Selectors and fields](04-selectors.md)
- [Crawling](05-crawling.md)
