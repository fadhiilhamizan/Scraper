# Example recipes

Runnable examples, ordered roughly by complexity. Each one is commented with
the reasoning, not just the syntax.

Run them from the project root:

```bash
harvest test recipes/books-listing.yaml     # check the selectors, one request
harvest run  recipes/books-listing.yaml     # run it
```

Output paths in a recipe are resolved **relative to the recipe file**, so these
write into `recipes/output/`. That's deliberate — a recipe behaves the same
wherever you invoke it from. Override with `-o`:

```bash
harvest run recipes/books-listing.yaml -o ~/data/books.csv
```

---

| Recipe | Demonstrates |
|---|---|
| [`books-listing.yaml`](books-listing.yaml) | Repeated items, pagination, transforms, validation |
| [`books-detail.yaml`](books-detail.yaml) | Two-level crawl, route labels, XPath table lookups |
| [`quotes-javascript.yaml`](quotes-javascript.yaml) | Headless rendering, `mode: auto`, actions, arrays |
| [`structured-data.yaml`](structured-data.yaml) | JSON-LD extraction with CSS fallback chains |
| [`hackernews-api.js`](hackernews-api.js) | JavaScript recipe: hooks, custom transforms, computed URLs |

More starting points via `harvest init`:

```bash
harvest init my-scraper --template basic       # a single page of repeated items
harvest init my-scraper --template crawl       # listing -> detail
harvest init my-scraper --template spa         # JavaScript-heavy sites
harvest init my-scraper --template api         # a site's own JSON API
harvest init my-scraper --template structured  # JSON-LD
harvest init my-scraper --template tables      # HTML tables
```

---

## About the targets

`books.toscrape.com` and `quotes.toscrape.com` are sandboxes published
explicitly for scraping practice — they exist to be scraped, which makes them
safe to run repeatedly while you learn.

The Hacker News example uses the public Firebase API rather than scraping the
site's HTML. That's the right instinct generally: **check for an API first**.
It's faster, more stable, and much gentler on the site.

`structured-data.yaml` points at `example.com` and won't return anything until
you replace the URL. It's a template for the pattern, not a live demo.

---

## Writing your own

The fastest route is to let the tool do the first draft:

```bash
harvest inspect https://the-site.com/listing --generate my-scraper.yaml
harvest test my-scraper.yaml
harvest run my-scraper.yaml -o data.csv
```

`inspect` reports which repeated blocks look like records, what structured data
the page publishes, whether JavaScript is required, and how pagination works —
then writes a recipe using what it found. Review the selectors before running at
scale; they're inferred, not verified.

Before a first real run against a site you don't control, read
[docs/09-compliance.md](../docs/09-compliance.md).
