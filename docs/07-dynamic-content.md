# Dynamic content

Scraping sites where the data isn't in the HTML.

---

## Install

Rendering needs Playwright, which is an optional dependency:

```bash
npm install playwright
npx playwright install chromium
```

Everything else in the framework works without it. If a recipe asks for
rendering and Playwright is missing, the run stops immediately with instructions
rather than failing every URL in turn.

---

## Check whether you actually need it

```bash
harvest inspect https://example.com/products
```

```
  JavaScript      required (heuristic: empty_spa_root_element) — use render.mode: auto
```

Add `--render` for a **measured** answer — it fetches the page both ways and
compares:

```
  JavaScript      required (measured: rendering added content (0 → 4821 chars, 3 → 412 elements))
```

A browser is roughly 20× slower than an HTTP request and uses ~100 MB of RAM per
context. It's worth ten seconds to find out you don't need one.

### Look for a JSON API first

Before reaching for a browser, open your browser's Network tab and filter to
XHR/Fetch. If the page loads its data from an internal API, calling that API
directly is faster, more stable, and far gentler on the site:

```yaml
start_urls:
  - https://example.com/api/v1/products?page=1

http:
  headers:
    accept: application/json

crawl:
  pagination: { param: page, max_pages: 50, stop_when_empty: true }

extract:
  fields:
    id:    { from: json, path: "data.*.id", all: true }
    name:  { from: json, path: "data.*.name", all: true }
```

This is usually the single biggest win available. A rendered page might take 3
seconds; the API behind it takes 80 ms and returns cleaner data.

---

## The three modes

```yaml
render:
  mode: auto      # never | auto | always
```

| Mode | Behaviour |
|---|---|
| `never` | HTTP only (default). Fastest, lightest. |
| `auto` | Fetch over HTTP, then start a browser **only if the content isn't there**. |
| `always` | Every page goes through a browser. |

`auto` is almost always right. It keeps static pages on the fast path and only
pays the browser cost where it's needed — which on a mixed site can be a small
fraction of pages.

### How `auto` decides

In order of confidence:

1. **`wait_for_selector` matched the HTML already** → no browser. This is the
   decisive test, and the reason to always set it.
2. Almost no visible text after stripping scripts and styles.
3. An empty framework root (`<div id="root"></div>`, `#app`, `#__next`, `#__nuxt`).
4. A `<noscript>` telling the user to enable JavaScript.

```yaml
render:
  mode: auto
  wait_for_selector: ".product-card"    # makes the decision exact
```

Rendering also kicks in automatically when a page is detected as a JavaScript
challenge (Cloudflare and similar) — see [Anti-blocking](08-anti-blocking.md).

---

## Waiting for content

```yaml
render:
  wait_until: domcontentloaded    # load | domcontentloaded | networkidle | commit
  wait_for_selector: ".product"
  wait_for_timeout: 0             # fixed extra pause, ms
  wait_for_function: "() => window.__APP_READY === true"
  timeout_ms: 30000
```

| `wait_until` | Waits for |
|---|---|
| `commit` | the response to start arriving — fastest, rarely enough |
| `domcontentloaded` | the HTML to parse (default) |
| `load` | images and subresources too |
| `networkidle` | 500 ms with no network activity — most thorough, slowest |

Prefer `wait_for_selector` over `networkidle`: waiting for the thing you
actually need is both faster and more reliable than waiting for the network to
go quiet, which never happens on pages with polling or analytics beacons.

A `wait_for_selector` that times out is **not** treated as fatal — extraction
proceeds and the missing field is reported. That produces a far clearer diagnosis
("`price` filled on 0% of pages") than a generic render timeout.

---

## Interacting with the page

```yaml
render:
  actions:
    - { type: click, selector: "#accept-cookies", optional: true }
    - { type: fill, selector: "#search", value: "widgets" }
    - { type: press, selector: "#search", key: Enter }
    - { type: waitForSelector, selector: ".results" }
    - { type: clickAll, selector: ".load-more", limit: 10, delay: 1000 }
    - { type: scroll, times: 5, delay: 500 }
```

| Action | Options |
|---|---|
| `click` | `selector`, `timeout`, `force` |
| `clickAll` | `selector`, `limit`, `delay` — repeats until the element disappears |
| `type` | `selector`, `value`, `delay` (per keystroke) |
| `fill` | `selector`, `value` — sets the value directly |
| `select` | `selector`, `value` |
| `press` | `selector`, `key` |
| `hover` | `selector` |
| `scroll` | `times`, `delay` |
| `wait` | `ms` |
| `waitForSelector` | `selector`, `state`, `timeout` |
| `waitForNavigation` | `state`, `timeout` |
| `evaluate` | `script` |

**`optional: true` is the one to remember.** Cookie banners are the single most
common blocker, and they don't always appear — a required click on an absent
banner would fail every page that didn't show one.

```yaml
    - { type: click, selector: "#onetrust-accept-btn-handler", optional: true }
    - { type: click, selector: "[aria-label='Accept cookies']", optional: true }
```

Any non-optional action that fails raises a render error for that page, which is
then subject to the normal retry policy.

---

## Infinite scroll

```yaml
render:
  scroll:
    enabled: true
    max_scrolls: 20
    delay_ms: 800
```

Scrolls, waits for content to load, and **stops early once the page height stops
growing** — so `max_scrolls` is a ceiling, not a fixed cost.

For "Load more" buttons use `clickAll` instead; it's more reliable than
scrolling because the stop condition is unambiguous.

---

## Performance

Rendering is expensive. Three settings recover most of the cost:

```yaml
render:
  block_resources: [image, media, font]   # ~70% of page weight, no data in it
  max_contexts: 4
  wait_until: domcontentloaded

concurrency: 2
concurrency_per_host: 1
```

**Resource blocking is on by default.** Images, fonts and media are the bulk of
page weight and never contain the data you want. Blocking them makes rendering
roughly 3× faster and is markedly gentler on the target's bandwidth — a point
worth making to a site owner if they ask.

Analytics and ad hosts are blocked too (`google-analytics.com`,
`doubleclick.net`, `hotjar.com`, and similar). Override with `block_hosts`.

**Browser contexts**, not browsers, are the unit of concurrency. A context is a
clean profile — its own cookies and cache — and costs milliseconds; a browser
costs ~300 ms and ~100 MB. Contexts are pooled per identity (host + proxy +
user-agent), so requests sharing an identity also share a session.

Realistic throughput: **10–30 pages/minute** rendered, versus 500+ over plain
HTTP. Budget accordingly.

---

## Sessions and logins

Cookies flow both ways: an HTTP login is visible to the browser, and cookies a
browser picks up are used by subsequent HTTP requests. So a common pattern is to
log in once with a browser and then crawl fast over HTTP:

```yaml
start_urls:
  - url: https://example.com/login
    label: login
    render: true          # force a browser for this URL only

render:
  mode: auto
  actions:
    - { type: fill, selector: "#username", value: "${LOGIN_USER}" }
    - { type: fill, selector: "#password", value: "${LOGIN_PASS}" }
    - { type: click, selector: "button[type=submit]" }
    - { type: waitForSelector, selector: ".dashboard" }
```

Or paste a session cookie you already have:

```yaml
http:
  cookie_jar:
    session_id: "${SESSION_COOKIE}"
```

Only do this on accounts you own, and check the site's terms — automated access
to an authenticated area is frequently prohibited even when scraping the public
site is fine. See [Compliance](09-compliance.md).

---

## Stealth

```yaml
render:
  stealth: true      # default
```

Removes the obvious automation tells: `navigator.webdriver`, the empty plugin
and language arrays headless Chromium reports, the missing `window.chrome`
object, and the notification-permission mismatch.

This is not a full anti-detection suite and doesn't claim to be. It handles
sites doing basic checks. If a site is running commercial fingerprinting, no
amount of patching wins that arms race — slow down, identify yourself, and
consider asking for an API instead.

---

## Debugging

Watch it work:

```yaml
render:
  headless: false
  slow_mo: 500
```

Capture what the browser saw:

```yaml
render:
  screenshot: true
```

```bash
harvest test recipe.yaml --render --save rendered.html
harvest inspect https://site.com --render --save rendered.html
```

Diffing the saved HTML against the raw response tells you exactly what
JavaScript added.

---

## Next

- [Anti-blocking](08-anti-blocking.md)
- [Troubleshooting](10-troubleshooting.md)
