# Troubleshooting

Symptoms, causes, fixes.

---

## Nothing was extracted

`Pages 20 ok, Items 0 written` and exit code `2`.

**Diagnose first:**

```bash
harvest test recipe.yaml
```

This shows whether the container selector matched and the fill rate of every
field, from a single request.

### The container selector matched 0 elements

```
✗ item.selector .product-card matched 0 element(s)
```

Find what's actually there:

```bash
harvest inspect https://the-url.com
```

The **Repeated blocks** section lists real candidates with counts.

Common causes:

- **The content needs JavaScript.** `harvest inspect` says so explicitly. Add
  `render: { mode: auto, wait_for_selector: "…" }`.
- **Build-hashed class names.** `.ProductCard_root__x7f2q` changes on every
  deploy. Anchor on something stable: `[data-testid]`, `[itemprop]`, an
  element+attribute combination, or a structural XPath.
- **You copied a selector from dev tools.** Browser dev tools show the *rendered*
  DOM, which can differ from the HTML on the wire. `harvest test --save page.html`
  saves what the scraper actually received.
- **The page is behind a bot wall.** See [below](#everything-returns-403-or-empty-pages).

### The container matched but fields are empty

```
✓ item.selector .product matched 20 element(s)
  ✗ price   ░░░░░░░░░░   0%   0/20
```

The field selector is scoped **inside** the container. `.product .price` inside
a `.product` container looks for `.product .price` *within* each `.product` — use
just `.price`.

### It works on one page and not another

Detail and listing pages usually differ. Use labels:

```yaml
extract:
  listing: { fields: {} }
  detail:  { fields: { title: "h1" } }
```

Test each: `harvest test recipe.yaml <detail-url> --label detail`

---

## Fields are empty on *some* pages

Expected — not every page has every field. What matters is the rate.

```json
{ "field": "discount", "fillRate": 12.5, "status": "broken" }
```

- **12% and you expected 12%** → add `default: null` or leave it optional.
- **12% and you expected 100%** → the site has more than one layout. Use a
  fallback chain:

```yaml
price:
  selector: ".price-current"
  fallback:
    - { selector: ".price-now" }
    - { selector: "[itemprop='price']", attr: content }
    - { from: jsonld, path: offers.price }
  transform: [clean, currency]
  type: number
```

---

## Everything returns 403, or empty pages

```
Failures
   50 × HTTP 403
```

or

```
Warnings
  ! 36 request(s) hit bot protection.
```

Work down this list, stopping when it works:

1. **Slow down.** `--rps 0.5`, `concurrency_per_host: 1`. This fixes most cases.
2. **Identify yourself.** `identity: { contact: https://… }`.
3. **Check for a JSON API** in your browser's Network tab (filter: XHR/Fetch).
   Often faster *and* not blocked.
4. **`render: { mode: auto }`** — clears JavaScript challenges like Cloudflare's.
5. **`identity: { mode: rotate }`** — for sites that block non-browser clients.
6. **Proxies** — only when one IP genuinely can't do the job.
7. **Ask the site.** Frequently works.

Full detail in [Anti-blocking](08-anti-blocking.md).

---

## Everything is blocked by robots.txt

```
Pages 0 ok, 20 skipped
blockedByRobots: 20
```

Check what applies:

```bash
harvest robots https://the-url.com
```

If robots.txt is **unreachable** (5xx or a network error) the default is to
treat the whole site as disallowed. That's deliberate — see
[Compliance](09-compliance.md). If you know the rules independently:

```yaml
robots:
  on_error: allow
```

If the site genuinely disallows you, that's the operator's answer. `--no-robots`
exists, and using it is you asserting a different basis for access.

---

## The run is very slow

Check the report:

```
Speed    12 pages/min · 3 items/page
Latency  p50 180ms · p90 320ms · max 2100ms
```

If latency is low but throughput is too, the limiter is the bottleneck — by
design. Raise it only as far as the target can comfortably absorb:

```bash
harvest run r.yaml --rps 4 -c 8
```

Look at `subsystems.rateLimiters`: if `rate` is well below `baseRate`, the
adaptive limiter has been throttling itself because the site pushed back. Lower
your configured rate to match rather than making it fight every run.

**If rendering is on**, that's the cost — 10–30 pages/min versus 500+ over HTTP.
Use `mode: auto` rather than `always`, set `wait_for_selector`, keep
`block_resources` on, and check whether a JSON API exists.

**While developing**, use the cache:

```bash
harvest run r.yaml --cache --limit 5
```

---

## The run hangs, or never finishes

- **Check `queuedRemaining` in the report.** A huge number means the crawl is
  exploding — usually faceted navigation (every colour × size × sort
  combination). Add `deny_patterns` and `max_pages`.
- **A circuit is open.** `subsystems.circuits` shows hosts that are failing.
- **Rendering timeouts.** Lower `render.timeout_ms` and prefer
  `wait_for_selector` over `wait_until: networkidle` — networkidle never settles
  on pages with polling or analytics beacons.

`Ctrl+C` once shuts down cleanly (writing a checkpoint if `--resume` is on);
twice quits immediately.

---

## Memory keeps growing

- **Use NDJSON, not JSON or XLSX**, for large runs.
- **`dedupe.store: bloom`** above a few million records.
- **Lower `render.max_contexts`** — each is ~100 MB.
- **Cap the frontier** with `max_pages` and tighter `deny_patterns`.

The frontier itself holds one small object per queued URL; a crawl with millions
of queued URLs will use real memory. That's usually a sign the crawl needs
narrowing rather than more RAM.

---

## Prices or dates come out wrong

```yaml
price: { selector: ".price", transform: [clean, currency], type: number }
```

`currency` handles both decimal conventions: `$1,234.56` and `1.234,56 €` both
yield `1234.56`.

Ambiguous dates default to **US order** (`03/04/2024` = 4 March). For day-first:

```yaml
posted: { selector: "time", transform: [dateEU] }
```

Prefer a machine-readable source when one exists:

```yaml
posted: { selector: "time", attr: datetime, transform: [date] }
```

Test a transform chain in isolation:

```js
import { applyTransforms } from 'harvester';
console.log(applyTransforms('  £1,299.00  ', ['clean', 'currency']));  // 1299
```

---

## Text has stray whitespace or `&amp;`

Use `clean` — it strips tags, decodes entities, and collapses whitespace:

```yaml
description: { selector: ".desc", transform: [clean] }
```

For invisible characters that break CSV or equality checks:

```yaml
transform: [clean, stripNonPrintable]
```

---

## Excel shows mojibake for accented characters

The CSV writer emits a UTF-8 BOM by default, which is what Excel needs. If you
disabled it (`bom: false`), re-enable it — or use `.xlsx`, which has no encoding
ambiguity.

---

## CSV is missing columns

```
warning: 3 field(s) appeared after the header was written and were omitted
```

Columns are inferred from the first 100 records. Fields that first appear later
can't be added to a header that's already written. Pin them:

```yaml
output:
  - path: data.csv
    columns: [sku, title, price, discount, rating]
```

Or raise `header_sample_size`, or use NDJSON, which has no fixed schema.

---

## Duplicate records in the output

The same item usually appears on several listing pages. URL de-duplication
doesn't help; de-duplicate on the record:

```yaml
dedupe:
  strategy: fields
  key_fields: [sku]
```

If there's no stable ID, `strategy: record` with `ignore_fields` for volatile
values:

```yaml
dedupe:
  strategy: record
  ignore_fields: [_scraped_at, _url]
```

---

## `--resume` starts from scratch

```
Warning: The checkpoint was written by a different recipe …
```

The fingerprint covers start URLs, extraction rules and crawl rules. Change any
of them and the old checkpoint is refused rather than silently mixing
incompatible data. Delete the state file to start over.

Also check that `resume.enabled` was true on the **first** run — a checkpoint
only exists if something wrote it.

---

## Playwright errors

```
Dynamic rendering requires Playwright, which is not installed.
```

```bash
npm install playwright && npx playwright install chromium
```

```
Could not launch chromium.
```

The package is installed but the browser binary isn't:

```bash
npx playwright install chromium
```

On Linux you may also need system libraries:

```bash
npx playwright install-deps chromium
```

---

## A recipe won't load

```
Your recipe has 2 problems:
  • extract.fields.price: unknown transform 'currancy'.
  • crawl.follow[0].xpath: invalid XPath — Expected ']'
```

Validation runs before the first request, so these are caught in a second rather
than an hour in. `harvest validate recipe.yaml` checks without any network
access.

For YAML errors, the line and column are reported. The usual culprits are tabs
(YAML requires spaces) and unquoted strings containing `:` or `#`.

---

## Getting more detail

```bash
harvest run r.yaml --verbose                  # debug logging
harvest run r.yaml --json 2>run.log           # structured logs
harvest run r.yaml --report report.json       # full machine-readable report
harvest run r.yaml --print-config             # what did my flags actually do?
harvest test r.yaml --save page.html          # the exact HTML received
harvest inspect <url> --render --save r.html  # what the browser saw
```

The report's `fieldHealth` is the highest-signal section: it tells you which
selector broke, not just that something did.
