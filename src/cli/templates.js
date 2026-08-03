/**
 * Recipe templates used by `harvest init`.
 *
 * Each is a complete, runnable file with the reasoning inline — the fastest way
 * to learn the recipe format is to read a good one.
 */

const basic = `# {{name}} — a Harvester recipe
# Run with:  harvest run {{name}}.yaml -o output/{{name}}.csv
# Docs:      ./docs/02-recipes.md

name: {{name}}
description: What this scraper collects, and why.

# ─── Where to start ────────────────────────────────────────────────────────
start_urls:
  - https://books.toscrape.com/

# ─── How to behave ─────────────────────────────────────────────────────────
# One request per second per host is the default. Raise it only for sites you
# own or that permit it.
rate_limit:
  requests_per_second: 1

# robots.txt is enforced by default. Leave it that way unless you have another
# basis for access (your own site, an API agreement, written permission).
robots:
  enabled: true
  respect_crawl_delay: true

# Identify yourself. Site owners who can see who you are and how to reach you
# are far less likely to block you.
identity:
  contact: https://example.com/about-my-crawler

# ─── What to collect ───────────────────────────────────────────────────────
extract:
  item:
    # The repeating container. One record is produced per match.
    selector: "article.product_pod"
    fields:
      title:
        selector: "h3 a"
        attr: title
        required: true

      price:
        selector: "p.price_color"
        transform: [clean, currency]   # "£51.77" -> 51.77
        type: number

      in_stock:
        selector: "p.instock.availability"
        transform: [clean]

      url:
        selector: "h3 a"
        attr: href
        type: url                      # resolved to an absolute URL

# ─── Where to put it ───────────────────────────────────────────────────────
output:
  - output/{{name}}.csv
`;

const crawl = `# {{name}} — crawl a listing, then scrape each detail page.
#
# The pattern: page 1 of a listing links to detail pages *and* to page 2.
# \`crawl.follow\` queues the detail links with the label "detail";
# \`crawl.pagination\` walks the listing. Extraction is keyed by label so each
# page type gets its own field set.

name: {{name}}
description: Crawl a paginated catalogue and extract each product page.

start_urls:
  - url: https://books.toscrape.com/
    label: listing

rate_limit:
  requests_per_second: 1

crawl:
  max_depth: 2
  allowed_domains:
    - books.toscrape.com

  follow:
    - selector: "article.product_pod h3 a"
      label: detail          # routes to the \`detail\` extract block below
      on: listing            # only follow these links from listing pages

  pagination:
    selector: "li.next a"
    max_pages: 5

  deny_patterns:
    - "/cart"
    - "\\\\.(pdf|zip|jpg|png)$"

# Extraction keyed by label. A page fetched with label \`detail\` uses the
# \`detail\` block; anything else falls through to \`default\`.
extract:
  detail:
    fields:
      title:
        selector: "div.product_main h1"
        required: true
      price:
        selector: "p.price_color"
        transform: [clean, currency]
        type: number
      description:
        selector: "#product_description ~ p"
        transform: [clean]
      upc:
        selector: "table.table-striped tr:nth-child(1) td"
      availability:
        selector: "table.table-striped tr:nth-child(6) td"
        transform: [clean, digits, int]
        type: integer

  # Listing pages contribute no records — they exist only to be crawled.
  listing:
    fields: {}

validate:
  schema:
    title:
      required: true
      min_length: 2
    price:
      type: number
      min: 0
  on_invalid: quarantine

output:
  - output/{{name}}.ndjson
  - output/{{name}}.csv
`;

const spa = `# {{name}} — a JavaScript-heavy site.
#
# \`render.mode: auto\` fetches plain HTTP first and only starts a browser when
# the content isn't in the response. That keeps the fast path fast: rendering
# every page "just in case" is roughly 20x slower and much heavier on the target.
#
# Requires Playwright:
#   npm install playwright && npx playwright install chromium

name: {{name}}
description: Scrape a single-page application.

start_urls:
  - https://example.com/app/listings

render:
  mode: auto
  engine: chromium
  wait_until: networkidle
  # The decisive test for "auto": if this selector is already in the HTML,
  # no browser is started.
  wait_for_selector: ".listing-card"
  timeout_ms: 30000

  # Images and fonts are ~70% of page weight and hold no data.
  block_resources: [image, media, font]

  # Lazy-loaded lists need scrolling before the content exists.
  scroll:
    enabled: true
    max_scrolls: 10
    delay_ms: 600

  # Declarative interactions. \`optional: true\` means "if present" — which is
  # exactly what you want for cookie banners.
  actions:
    - { type: click, selector: "#accept-cookies", optional: true }
    - { type: clickAll, selector: "button.load-more", limit: 10, delay: 1200 }

# Browsers are expensive. Keep concurrency low.
concurrency: 2
rate_limit:
  requests_per_second: 0.5

extract:
  item:
    selector: ".listing-card"
    fields:
      title: ".listing-card__title"
      price:
        selector: ".listing-card__price"
        transform: [clean, currency]
        type: number
      link:
        selector: "a"
        attr: href
        type: url

output:
  - output/{{name}}.json
`;

const api = `# {{name}} — scrape a site's own JSON API.
#
# Always check for this first. If a page loads its data from an internal API
# (look in the browser's Network tab, filter to XHR/Fetch), calling that API is
# faster, more stable and far gentler than rendering pages.

name: {{name}}
description: Read a paginated JSON API.

start_urls:
  - url: https://api.example.com/v1/products?page=1&limit=100
    label: api

http:
  headers:
    accept: application/json
    # Secrets come from the environment or a .env file next to this recipe —
    # never commit them.
    authorization: "Bearer \${API_TOKEN}"

rate_limit:
  requests_per_second: 2

crawl:
  pagination:
    param: page          # increments ?page=N
    step: 1
    max_pages: 50
    stop_when_empty: true

extract:
  # \`from: json\` reads the parsed response body. \`path\` walks it, and \`*\`
  # maps over an array.
  item:
    fields:
      items:
        from: json
        path: "data"
        all: true

# For a flat list of records, this shape is usually simpler:
#
# extract:
#   fields:
#     id:    { from: json, path: "data.*.id" }
#     name:  { from: json, path: "data.*.attributes.name" }

output:
  - output/{{name}}.ndjson
`;

const structured = `# {{name}} — extract structured data instead of writing selectors.
#
# Most commerce, recipe, article, event and job-listing sites publish JSON-LD
# for search engines. Reading it is the single most durable scraping strategy
# available: the markup can be redesigned freely, but the structured data has
# to keep working or the site loses its search rankings.
#
# Check what a page publishes with:  harvest inspect <url>

name: {{name}}
description: Extract JSON-LD product data.

start_urls:
  - https://example.com/product/12345

extract:
  fields:
    name:
      from: jsonld
      path: name
      # If JSON-LD is missing on some pages, fall back to CSS.
      fallback:
        - { selector: "h1" }
        - { from: og, path: title }
      required: true

    price:
      from: jsonld
      path: offers.price
      transform: [number]
      type: number
      fallback:
        - { selector: "[itemprop='price']", attr: content, transform: [number] }
        - { selector: ".price", transform: [clean, currency] }

    currency:
      from: jsonld
      path: offers.priceCurrency

    in_stock:
      from: jsonld
      path: offers.availability
      # "https://schema.org/InStock" -> true, "…/OutOfStock" -> false
      transform: ["test:InStock"]

    sku:
      from: jsonld
      path: sku

    rating:
      from: jsonld
      path: aggregateRating.ratingValue
      transform: [number]
      type: number

    image:
      from: jsonld
      path: image
      fallback:
        - { from: og, path: image }
      type: url

output:
  - output/{{name}}.json
`;

const tables = `# {{name}} — pull every HTML table off a page.
#
# \`tables: true\` finds each <table>, reads its header row, and emits one
# record per data row. Good for reference data, statistics and documentation.

name: {{name}}
description: Extract tabular data.

start_urls:
  - https://example.com/statistics

extract:
  tables: true          # or a selector: tables: "table.data"

# Tables often carry footnote markers and non-breaking spaces. Clean them up
# with a validation floor so junk rows don't reach the output.
validate:
  min_filled_fields: 2
  on_invalid: drop

output:
  - output/{{name}}.xlsx
`;

export const TEMPLATES = {
  basic,
  crawl,
  spa,
  api,
  structured,
  tables,
};
