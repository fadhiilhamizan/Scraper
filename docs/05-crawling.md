# Crawling

Turning one URL into many, without turning a scrape into a denial-of-service.

---

## The frontier

The queue of URLs to fetch. Three properties are worth knowing because they
explain most of the framework's behaviour:

**Per-host buckets, served round-robin.** One slow domain can't starve the
others, and per-host politeness delays overlap with useful work elsewhere.

**Priority queue within each host.** Lower `priority` runs first; ties stay
FIFO. Pagination gets a priority *bump* so a listing finishes before the crawl
descends into detail pages — which keeps memory flat and makes partial results
useful.

**Canonical de-duplication.** Every URL is normalised before it's queued:
tracking parameters dropped, query parameters sorted, fragment removed, default
port and trailing slash normalised. So these are all one URL:

```
https://shop.com/p?id=1&utm_source=twitter
https://shop.com/p?utm_campaign=x&id=1
https://shop.com/p?id=1#reviews
HTTPS://SHOP.COM:443/p?id=1
```

Tune it if a site needs different rules:

```yaml
crawl:
  normalization:
    strip_tracking: true      # utm_*, fbclid, gclid, msclkid, …
    strip_fragment: true
    sort_query: true
    strip_www: false          # treat www.x.com and x.com as one host
    strip_params: [sessionid] # site-specific junk
    keep_params: [id, page]   # allow-list; everything else is dropped
```

---

## Following links

```yaml
crawl:
  follow:
    - selector: "article.product h3 a"
      label: detail
      on: listing
```

| Key | Meaning |
|---|---|
| `selector` / `xpath` | what to match |
| `pattern` | additionally require the URL to match this regex/glob |
| `attr` | attribute holding the URL (default `href`) |
| `label` | route label for the queued URLs |
| `on` | only apply this rule to pages with that label |
| `priority` | lower runs first |
| `max_links` | cap per page |
| `meta` | data attached to each queued request |

A `pattern`-only rule scans every link on the page:

```yaml
  follow:
    - pattern: "/product/\\d+"
      label: detail
```

### Labels and routing

Labels are how one recipe handles several page types:

```yaml
start_urls:
  - url: https://shop.com/
    label: listing

crawl:
  follow:
    - { selector: ".product a", label: detail, on: listing }
    - { selector: ".category a", label: listing, on: listing }

extract:
  listing:
    fields: {}                    # crawled, but yields no records
  detail:
    fields:
      title: "h1"
      price: { selector: ".price", transform: [currency], type: number }
```

---

## Pagination

Depth-exempt on purpose: page 40 of a listing is the same "level" as page 1, and
counting it as depth would truncate long listings at `max_depth`.

### By next-link

```yaml
crawl:
  pagination:
    selector: "a[rel='next']"
    max_pages: 50
```

Stops when the link is missing, points at the current page, or carries
`disabled` / `aria-disabled="true"`.

### By query parameter

```yaml
crawl:
  pagination:
    param: page          # increments ?page=N
    step: 1
    start: 1
    max_pages: 100
    stop_when_empty: true    # stop when a page yields no records
```

### By URL template

```yaml
crawl:
  pagination:
    url_template: "https://shop.com/products?offset={offset}&limit=50"
    page_size: 50
    max_pages: 40
    stop_when_empty: true
```

`{page}` and `{offset}` are substituted.

`stop_when_empty` matters for the parameter and template forms: they have no
"last page" marker, so the only reliable end signal is a page that produced
nothing. **Always set `max_pages` as well** — a site that returns the first page
for any out-of-range value would otherwise loop forever.

### Automatic

With `pagination` set but no strategy, or via `harvest inspect`, the framework
looks for `rel="next"`, common pagination classes, and link text
(`Next`, `»`, `→`, `Load more`, and equivalents in several languages).

---

## Staying inside the lines

A crawl **cannot leave the domains of your start URLs** unless you say so. This
is a deliberate default: a recipe with one missing key should not start crawling
the open web.

```yaml
crawl:
  allowed_domains:            # subdomains included
    - shop.example.com
    - cdn.example.com

  allow_patterns:             # if set, a URL must match one of these
    - "/products/"
    - "/categories/"

  deny_patterns:              # deny always beats allow
    - "/cart"
    - "/checkout"
    - "/login"
    - "\\.(pdf|zip|jpg|png|mp4)$"
    - "\\?.*sort="            # avoid crawling every sort permutation

  max_depth: 3
```

Patterns accept a regex string, a `/regex/flags` literal, or a glob with `*`.

`deny_patterns` is worth spending a minute on. Faceted navigation — every
combination of colour, size and sort order — is the classic way a crawl
explodes from 500 URLs into 500,000.

---

## Seeding from a sitemap

Usually faster and gentler than link-following: the site is telling you exactly
which URLs it wants indexed, so you fetch far fewer pages for the same data.

```yaml
start_urls:
  - https://example.com/
sitemap: true                 # discover via robots.txt, then conventional paths
```

```yaml
sitemap: https://example.com/sitemap-products.xml
```

Handles sitemap indexes (recursively), gzipped sitemaps, and plain-text URL
lists. Or from the CLI:

```bash
harvest run recipe.yaml --sitemap
```

---

## De-duplicating records

URL de-duplication stops you *fetching* the same page twice. Record
de-duplication stops you *writing* the same data twice — which is different,
because the same product often appears on several listing pages.

```yaml
dedupe:
  strategy: fields
  key_fields: [sku]
```

| Strategy | Identity |
|---|---|
| `record` | the whole record (minus `ignore_fields`) |
| `fields` | the chosen `key_fields` |
| `url` | the source URL |

### Incremental runs

```yaml
dedupe:
  strategy: fields
  key_fields: [sku]
  persist_path: .harvester/seen.json
```

The seen-set survives between runs, so a nightly job only emits records it
hasn't seen. Combine with `output: [{ path: data.ndjson, append: true }]` for an
ever-growing dataset.

### Very large crawls

```yaml
dedupe:
  store: bloom
  expected_items: 50000000
  false_positive_rate: 0.001
```

Fixed memory instead of linear. A Bloom filter never reports a false negative,
so it can only ever over-detect duplicates — the safe direction.

---

## Resuming

```yaml
resume:
  enabled: true
  state_path: .harvester/state.json
  interval_ms: 10000
```

```bash
harvest run big-crawl.yaml --resume
```

The frontier, cookies and counters are checkpointed atomically. Interrupt with
`Ctrl+C` (once), or survive a crash, and the next run continues from where it
stopped. In-flight requests are restored as pending, so nothing is lost.

A checkpoint written by a **different recipe** is refused — changing your start
URLs or extraction rules and resuming would silently mix incompatible data.
Delete the state file to start over.

Counters in the report are session-scoped; what earlier sessions did appears
under `report.resumed`.

---

## A worked example

Listing → detail, paginated, with limits:

```yaml
name: catalogue

start_urls:
  - url: https://books.toscrape.com/
    label: listing

concurrency: 4
concurrency_per_host: 2
max_pages: 500

rate_limit:
  requests_per_second: 1

crawl:
  max_depth: 2
  allowed_domains: [books.toscrape.com]
  deny_patterns: ["/cart", "\\.(jpg|png|css|js)$"]

  pagination:
    selector: "li.next a"
    max_pages: 50

  follow:
    - selector: "article.product_pod h3 a"
      label: detail
      on: listing

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
        transform: [clean, currency]
        type: number
      availability:
        selector: "table.table-striped tr:nth-child(6) td"
        transform: [clean, digits, int]
        type: integer
      description:
        selector: "#product_description ~ p"
        transform: [clean]

dedupe:
  strategy: fields
  key_fields: [title]

validate:
  schema:
    title: { required: true, min_length: 1 }
    price: { type: number, min: 0 }
  on_invalid: quarantine

output:
  - output/books.ndjson
  - output/books.csv
```

---

## Next

- [Dynamic content](07-dynamic-content.md)
- [Anti-blocking](08-anti-blocking.md)
