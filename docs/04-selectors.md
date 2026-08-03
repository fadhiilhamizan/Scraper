# Selectors and fields

How to say what you want out of a page.

---

## The field spec

A field is either a selector string or an object:

```yaml
fields:
  title: "h1.product-title"          # shorthand: this selector, as text

  price:                             # full form
    selector: "span.price"
    attr: text
    transform: [clean, currency]
    type: number
    required: true
    default: null
```

| Key | Meaning |
|---|---|
| `selector` | CSS selector (or XPath — auto-detected) |
| `xpath` | XPath explicitly |
| `attr` | `text` (default), `html`, `outerHTML`, or an attribute name |
| `all` | `true` collects every match into an array |
| `from` | read from a non-DOM source — see [below](#non-dom-sources) |
| `path` | dotted path into a `from:` source |
| `entity` | filter JSON-LD/microdata by `@type` |
| `const` | a literal value |
| `regex` | extract a capture group from the value |
| `transform` | clean-up chain — see [Transforms](#transforms) |
| `type` | coerce and validate: `string`, `number`, `integer`, `boolean`, `date`, `url`, `email` |
| `required` | report an issue when empty |
| `default` | value to use when empty |
| `keep_empty` | emit `null` rather than omitting the key |
| `when` | only extract on pages matching a condition |
| `fallback` | alternative strategies — see [Fallback chains](#fallback-chains) |
| `fields` | nested object or list of objects |

Empty fields are **omitted** from the record rather than written as `null`. Set
`keep_empty: true` if you need a stable key set (CSV columns handle this for you
anyway).

---

## CSS selectors

Everything `cheerio` supports, which is essentially everything you'd use in a
browser:

```yaml
fields:
  title: "h1"
  price: ".product .price"
  first_row: "table tr:nth-child(2) td"
  external: "a[href^='http']"
  not_ad: ".item:not(.sponsored)"
  last_para: "#description p:last-child"
```

### Reading attributes

```yaml
fields:
  link:   { selector: "a", attr: href, type: url }   # resolved to absolute
  image:  { selector: "img", attr: src, type: url }
  lazy:   { selector: "img", attr: data-src }
  when:   { selector: "time", attr: datetime, transform: [date] }
  markup: { selector: ".desc", attr: html }          # inner HTML
```

`type: url` resolves relative hrefs against the page (honouring `<base href>`).

### The container itself

Inside an `item` block, a field with no selector — or `.` — reads the repeating
element itself. This is where `data-*` attributes usually live:

```yaml
extract:
  item:
    selector: "article.product[data-sku]"
    fields:
      sku:   { attr: data-sku }        # attribute of the <article>
      css:   { selector: ".", attr: class }
      title: "h2"                      # a child, as usual
```

---

## XPath

Use it when CSS can't express what you need: selecting on text content, walking
*up* the tree, or computing a value.

Detected automatically from a leading `/`, `./`, `(` or an axis; or force it
with `xpath:` or the `xpath` key.

```yaml
fields:
  # Select by text content — impossible in CSS.
  price:
    xpath: "//td[preceding-sibling::td[text()='Price']]"

  # Walk up from a child to its parent.
  row_id:
    xpath: "//span[@class='sku']/ancestor::tr/@data-id"

  # Compute a value.
  review_count:
    xpath: "count(//div[@class='review'])"
    type: integer

  # Text of a specific node, not the whole subtree.
  headline:
    xpath: "//h1/text()"
```

### Supported

A genuine XPath 1.0 subset, implemented directly against the parsed HTML tree:

- **All 13 axes** — `child`, `descendant`, `descendant-or-self`, `parent`,
  `ancestor`, `ancestor-or-self`, `following`, `following-sibling`, `preceding`,
  `preceding-sibling`, `self`, `attribute`, plus abbreviations `//`, `..`, `.`, `@`
- **Node tests** — `name`, `*`, `text()`, `node()`, `comment()`, `prefix:*`
- **Predicates** — `[3]`, `[last()]`, `[position()>2]`, `[@a='b']`, `[not(...)]`,
  `and` / `or`, comparisons, nesting
- **Operators** — `|` (union), `+ - * div mod`
- **Functions** — `count`, `last`, `position`, `local-name`, `name`, `string`,
  `concat`, `contains`, `starts-with`, `ends-with`, `substring`,
  `substring-before`, `substring-after`, `string-length`, `normalize-space`,
  `translate`, `lower-case`, `upper-case`, `matches`, `boolean`, `not`, `true`,
  `false`, `number`, `sum`, `floor`, `ceiling`, `round`

Not supported: namespace resolution beyond literal prefix matching, variable
references (`$x`), `id()`, `lang()`.

Syntax errors are caught when the recipe loads, not mid-crawl.

---

## Non-DOM sources

`from:` reads data that isn't in the markup. **Check these first** — they
usually survive redesigns that break every CSS selector you wrote.

### `jsonld` — structured data

Most commerce, recipe, article, event and job sites publish JSON-LD for search
engines. They cannot break it without losing search rankings, which makes it the
single most durable thing to scrape.

```yaml
fields:
  name:   { from: jsonld, path: name }
  price:  { from: jsonld, path: offers.price, transform: [number], type: number }
  currency: { from: jsonld, path: offers.priceCurrency }
  in_stock: { from: jsonld, path: offers.availability, transform: ["test:InStock"] }
  rating: { from: jsonld, path: aggregateRating.ratingValue, transform: [number] }
```

When a page has several JSON-LD blocks, filter with `entity`:

```yaml
  product_name: { from: jsonld, entity: Product, path: name }
  seller:       { from: jsonld, entity: Organization, path: name }
```

`harvest inspect <url>` tells you what a page publishes.

Path syntax: `a.b`, `a[0].b`, and `a.*.b` (maps over an array). Reaching into a
one-element array without an index takes the first entry, so `offers.price`
works whether `offers` is an object or a list.

### `microdata`, `og`, `meta`

```yaml
fields:
  title:  { from: og, path: title }              # <meta property="og:title">
  image:  { from: og, path: image, type: url }
  desc:   { from: meta, path: description }      # <meta name="description">
  brand:  { from: microdata, entity: Product, path: brand }
```

### `json` — for a site's own API

When you're scraping a JSON endpoint rather than HTML:

```yaml
fields:
  id:    { from: json, path: "data.id" }
  names: { from: json, path: "data.items.*.name", all: true }
```

### `url`, `request`, `header`, `status`, `text`, `html`

```yaml
fields:
  source_url: { from: url }
  category:   { from: url, regex: { pattern: "/category/(\\w+)", group: 1 } }
  fetched_as: { from: request, path: label }
  seed_meta:  { from: meta_field, path: source }   # from start_urls[].meta
  modified:   { from: header, path: last-modified, transform: [date] }
  body_text:  { from: text }                       # visible text, block-aware
```

---

## Fallback chains

The single most useful feature for keeping a scraper alive. Each strategy is
tried in order; the first that yields a value wins.

```yaml
fields:
  price:
    from: jsonld
    path: offers.price
    transform: [number]           # inherited by every fallback
    type: number
    required: true
    fallback:
      - { selector: "[itemprop='price']", attr: content }
      - { selector: ".price-now" }
      - { selector: ".price" }
      - { xpath: "//td[preceding-sibling::td[contains(.,'Price')]]" }
```

A fallback **replaces the source entirely** — a fallback with a `selector` is
not contaminated by the base spec's `from: jsonld`. It does inherit
presentation: `transform`, `type`, `default`, `required`, `all`. A fallback can
override any of those for itself.

---

## Conditional fields

```yaml
fields:
  sale_price:
    selector: ".price-sale"
    when: { selector: ".badge-sale", exists: true }

  regular_price:
    selector: ".price"
    when: { selector: ".badge-sale", exists: false }
```

---

## Nested and repeated structures

```yaml
fields:
  # A nested object.
  author:
    selector: ".byline"
    fields:
      name: ".author-name"
      url:  { selector: "a", attr: href, type: url }

  # A list of objects.
  variants:
    selector: ".variant"
    all: true
    fields:
      size:  ".variant-size"
      price: { selector: ".variant-price", transform: [currency], type: number }

  # A simple array.
  tags:
    selector: "a.tag"
    all: true
    transform: [clean, unique]
```

CSV output flattens nested objects into `author.name` columns and joins scalar
arrays with `; `. JSON and NDJSON keep the structure.

---

## Transforms

Applied left to right, after selection and before type coercion. Arrays are
mapped element-wise.

```yaml
price:
  selector: ".price"
  transform: [clean, currency]     # "  £1,299.00  " -> 1299
```

Three argument forms:

```yaml
transform: [trim]                       # no arguments
transform: ["truncate:100"]             # one argument (everything after the first colon)
transform: [["replace", "\\s+", " "]]   # several arguments
transform: [{ replace: ["\\s+", " "] }] # the same, as a mapping
```

The colon shorthand takes exactly **one** argument, so patterns containing `:`
(URLs, regexes, times) stay intact. Use the array form when you need two.

### Reference

Run `harvest transforms` for the live list.

**Text and whitespace** — `trim`, `collapse`, `normalizeSpace`, `squeeze`,
`lower`, `upper`, `capitalize`, `title`, `slug`, `padStart`

**Cleaning** — `clean` (strip tags + decode entities + collapse whitespace, the
one you usually want), `stripTags`, `decodeEntities`, `stripNonPrintable`,
`stripEmoji`, `normalizeUnicode`

**Numbers** — `number`, `int`, `float`, `round`, `currency`, `currencyCode`,
`price`, `percent`

```yaml
transform: [currency]
# "$1,234.56" -> 1234.56      "1.234,56 €" -> 1234.56      "Rp 150.000" -> 150000
```

Both decimal conventions are handled. The rule: whichever of `.` or `,` appears
last is the decimal separator, unless the trailing group is exactly three digits
and the separator also appears earlier.

`price` returns `{ amount, currency, raw }`; `currencyCode` returns just `"USD"`.

**Dates** — `date`, `dateOnly`, `dateEU`, `timestamp`

```yaml
transform: [date]        # ISO 8601 out
# "2024-03-12" · "12 March 2024" · "March 12, 2024" · "3 days ago" · 1710201600
```

`date` reads ambiguous `03/04/2024` as US (4 March). Use `dateEU` for
day-first. `dateOnly` yields `"2024-03-12"`; `date:day` does the same.

**Booleans** — `boolean`, `test`

```yaml
in_stock: { selector: ".stock", transform: [boolean] }        # "In stock" -> true
available: { from: jsonld, path: offers.availability, transform: ["test:InStock"] }
```

`boolean` understands `yes/no`, `true/false`, `1/0`, `on/off`,
`in stock/out of stock`, and returns `null` for anything else rather than
guessing. `test:<pattern>` is true when the value matches — the clean way to
turn a coded string into a flag.

**Strings** — `replace`, `remove`, `extract`, `extractAll`, `split`, `join`,
`prefix`, `suffix`, `truncate`

```yaml
transform: [["extract", "SKU-(\\d+)", 1]]     # "Item SKU-4231" -> "4231"
transform: ["split:,"]                        # "a, b, c" -> ["a", "b", "c"]
```

**Extraction shortcuts** — `email`, `phone`, `digits`, `urlPath`, `domain`,
`queryParam`

**Arrays** — `first`, `last`, `nth`, `unique`, `compact`, `sort`, `count`, `slice`

**Structural** — `json`, `toString`, `default`, `nullIfEmpty`

### Custom transforms

In a JavaScript recipe:

```js
import { registerTransform } from 'harvester';

registerTransform('celsius', (value) => {
  const f = Number(value);
  return Number.isFinite(f) ? Math.round(((f - 32) * 5) / 9) : null;
});

export default {
  extract: { fields: { temp: { selector: '.temp-f', transform: ['number', 'celsius'] } } },
  // …
};
```

Or inline, as a function:

```js
transform: [(value) => value?.toUpperCase()]
```

---

## Types

`type:` runs after transforms and reports a problem rather than emitting `NaN`
or `"undefined"`:

| Type | Behaviour |
|---|---|
| `string` | coerced with `String()` |
| `number` / `float` | must be finite, else the field is dropped and an issue logged |
| `integer` / `int` | truncated |
| `boolean` | `Boolean()` |
| `url` | resolved to absolute; must parse |
| `email` | validated and lowercased |
| `date` | parsed and normalised to ISO 8601 |
| `object` / `array` / `any` | passed through |

---

## Whole-page shortcuts

```yaml
extract:
  tables: true          # every <table> -> one record per row, keyed by header
  tables: "table.data"  # or restrict by selector
```

```yaml
extract:
  jsonld: true          # every JSON-LD entity as a record
  jsonld: Product       # only entities of this @type
```

---

## Debugging selectors

```bash
harvest test recipe.yaml                       # coverage bars per field
harvest test recipe.yaml https://other/page    # against a different page
harvest test recipe.yaml --save page.html      # keep the HTML for offline work
harvest inspect https://site.com               # what's on the page, and where
```

`harvest test` prints a per-field fill rate. A field at 0% is a broken selector
and you find out in one request instead of after an hour-long crawl.

---

## Next

- [Crawling](05-crawling.md)
- [Dynamic content](07-dynamic-content.md)
