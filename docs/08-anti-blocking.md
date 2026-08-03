# Resilience and anti-blocking

What to do when a site pushes back — and, more usefully, how to avoid getting
there.

---

## Start here: don't get blocked

Most blocking is earned. The overwhelming majority of blocks come from requesting
too fast, and they're preventable without any of the machinery below.

**Slow down.** One request per second per host is the default here for a reason.
A site that would block you at 20 req/s often never notices you at 1 req/s.

```yaml
rate_limit:
  requests_per_second: 1
  jitter_ms: 250
concurrency_per_host: 2
```

**Say who you are.** The default User-Agent identifies the scraper and can carry
a contact URL:

```yaml
identity:
  contact: https://example.com/about-my-crawler
```

```
Harvester/1.0 (compatible; web scraper; +https://example.com/about-my-crawler)
```

This feels counter-intuitive if you're used to hiding, but it works: an
identifiable, well-behaved crawler with a contact address gets blocked far less
often than an anonymous client claiming to be Chrome. Some operators will
whitelist you; some will email you before blocking; some will offer an API.

**Obey robots.txt.** It's on by default. It's also the cheapest possible
signal of good faith if a dispute ever arises.

**Cache while developing.** Iterating on selectors against a live site is what
turns a curious developer into an abusive one:

```bash
harvest run recipe.yaml --cache --limit 5
```

---

## Adaptive rate limiting

On by default. Three mechanisms working together:

**Token bucket** — caps the sustained rate while allowing a small burst, which
is how a real browser behaves.

**Minimum spacing** — a hard floor between two requests to the same host.
`robots.txt` `Crawl-delay` feeds straight into this, and the stricter of the two
always wins.

**AIMD backoff** — on a 429 the rate halves and the host pauses; after a run of
clean responses it climbs back. The same idea TCP congestion control uses.

```yaml
rate_limit:
  requests_per_second: 2
  burst: 2
  min_delay_ms: 0
  jitter_ms: 250
  adaptive: true
  throttle_penalty_ms: 30000
```

A `Retry-After` header is always obeyed. A bare 503 halves the rate but doesn't
impose a hard pause — it usually means "I'm broken right now", not "you're going
too fast", and stalling a whole crawl over one transient error helps nobody.

---

## Retries

```yaml
retry:
  max_attempts: 3
  base_delay_ms: 1000
  max_delay_ms: 60000
  factor: 2
  jitter: true
  rotate_proxy_on_retry: true
  rotate_user_agent_on_retry: true
  escalate_to_browser: true
```

Retries here don't just wait — they **change something**. Repeating an identical
request from an identical IP rarely helps.

| Failure | Response |
|---|---|
| 429 / 503 | back off harder, rotate identity |
| Detected bot wall | rotate identity, retry through a real browser |
| Network error / timeout | rotate proxy (it may be dead) |
| Render error | fresh browser context |
| 404 / 400 / 403 | don't retry |

Backoff uses full jitter — uniform in `[delay/2, delay]` — so a fleet of workers
doesn't retry in lockstep.

`403` is not retried by default: it usually means "you may not have this", and
hammering it is rude and futile. Add it explicitly if you have reason to think
it's a soft block:

```yaml
retry:
  retry_statuses: [403, 408, 429, 500, 502, 503, 504]
```

---

## Circuit breaker

```yaml
circuit_breaker:
  enabled: true
  failure_threshold: 5
  failure_rate_threshold: 0.7
  reset_timeout_ms: 60000
```

When a host starts failing consistently — it went down, or it started serving
challenge pages — requests to it fail fast instead of piling on. The breaker
probes periodically to see if it's recovered, with the cooldown doubling on each
re-open.

Two things this buys you: a dead domain can't consume the whole run's time
budget, and you stop deepening whatever block you've earned.

If *every* host has an open circuit, the run stops rather than spinning.

---

## User-agent rotation

```yaml
identity:
  mode: rotate
  strategy: sticky      # sticky | random | sequential
  include_mobile: false
```

Each profile bundles a User-Agent with the header set that browser genuinely
sends — `Accept`, `Accept-Language`, `Sec-CH-UA`, `Sec-Fetch-*`, and a matching
viewport. A rotator that emits a Chrome UA next to Firefox's `Accept` header is
worse than no rotation at all: mismatched fingerprints are exactly what
detection looks for.

Header **order** matches real browsers too, and `Referer` / `Sec-Fetch-Site` are
derived from the page you actually followed the link from.

`strategy: sticky` pins one identity per host for the whole run. A visitor whose
browser changes mid-session is more suspicious than one who never changes at all.

Restrict the pool if you like:

```yaml
identity:
  mode: rotate
  profiles: [chrome-windows, chrome-macos, edge-windows]
```

Available: `chrome-windows`, `chrome-macos`, `firefox-windows`, `safari-macos`,
`edge-windows`, `chrome-android`.

---

## Proxies

```yaml
proxy:
  urls:
    - "http://user:pass@proxy1.example.com:8080"
    - "socks5://proxy2.example.com:1080"
  strategy: sticky
  max_consecutive_failures: 3
  bench_duration_ms: 300000
  remove_dead: false
```

Or from a file, one per line (`#` comments allowed):

```yaml
proxy:
  file: ./proxies.txt
```

```bash
harvest run r.yaml --proxy-file proxies.txt
```

Rotation alone isn't enough — dead or burned proxies have to leave the pool,
otherwise every rotation has a growing chance of landing on a broken exit. Each
proxy carries a health score; repeated failures bench it temporarily and it's
probed again after a cooldown. If every proxy is benched, the least-recently
failed one is revived rather than stalling the run.

Transport errors count against the proxy; HTTP status codes count against the
origin. That distinction stops a site returning 404s from destroying your pool.

`strategy: sticky` keeps one exit IP per domain, which looks like a normal
user session rather than a distributed attack.

Credentials are masked everywhere — logs, reports, error messages.

**Choosing proxies matters more than configuring them.** Datacentre proxies are
cheap and widely blocked. Residential proxies are effective but raise real
ethical questions about how the exit nodes were obtained — some networks are
built from consent-by-EULA on free VPN apps. Know what you're buying.

---

## Bot-wall detection

```yaml
captcha:
  detect: true
  strategy: render      # retry | render | solve | manual | fail
  min_confidence: 0.5
```

**This matters even if you never intend to solve anything.** A challenge page
returns HTTP 200 with a normal-looking body. Without detection your scraper
"succeeds" on every page and writes thousands of empty records — a silent
data-quality failure that can go unnoticed for weeks. Detection turns it into a
loud, actionable error.

Recognised: Cloudflare, DataDome, PerimeterX, Akamai, Imperva/Incapsula,
reCAPTCHA, hCaptcha, plus generic patterns ("unusual traffic from your network",
"are you a robot") and the tell-tale HTTP 200 with a 200-byte body.

Each detection is scored, and the response depends on what kind it is:

| Kind | `strategy: render` does |
|---|---|
| JavaScript challenge (Cloudflare, DataDome, Akamai) | retry through a real browser, which usually resolves it |
| Interactive CAPTCHA (reCAPTCHA, hCaptcha) | fail with a clear error — a browser won't help |

### On solving CAPTCHAs

Automated CAPTCHA solving is deliberately **not** bundled. It's off by default,
there's no vendor client included, and you have to supply one:

```js
export default {
  captcha: {
    strategy: 'solve',
    solver: {
      async solve({ type, siteKey, url }) {
        // Your own integration with a solving service.
        return token;
      },
    },
  },
};
```

Two reasons for that friction. Practically, a site showing you a CAPTCHA is
telling you something about your traffic; solving it treats the symptom and
usually makes the block worse. Legally and contractually, bypassing access
controls is prohibited by most sites' terms of service and, in some
jurisdictions, may implicate computer-misuse law. That's a decision to make
deliberately, with your own legal advice — not one to inherit from a default.

If you're hitting CAPTCHAs regularly, the productive moves are: slow down a lot,
identify yourself, check whether an API exists, or contact the site. In that
order.

---

## Reading the signals

The run report tells you what's happening:

```bash
harvest run recipe.yaml --report run.json
```

```json
{
  "pages": { "ok": 4821, "failed": 179, "blockedByRobots": 12 },
  "failures": [{ "reason": "HTTP 429", "count": 143 }],
  "subsystems": {
    "circuits": [{ "host": "shop.example.com", "state": "open", "failureRate": 0.82 }],
    "rateLimiters": [{ "host": "shop.example.com", "rate": 0.25, "baseRate": 2 }],
    "captcha": { "detected": 36, "byVendor": { "cloudflare": 36 } },
    "proxies": [{ "proxy": "proxy1:8080", "successes": 2103, "failures": 4 }]
  },
  "warnings": ["36 request(s) hit bot protection. Consider lowering …"]
}
```

`rateLimiters[].rate` well below `baseRate` means the adaptive limiter has been
throttling itself — the site pushed back and you should lower your configured
rate to match, rather than making the limiter fight for it every run.

---

## A realistic escalation

Work down this list. Stop as soon as it works.

1. **`--rps 0.5` and `concurrency_per_host: 1`.** Fixes most problems.
2. **Set `identity.contact`.** Free, and sometimes it's the whole fix.
3. **Check for a JSON API.** Often faster *and* unblocked.
4. **`render.mode: auto`.** Clears JavaScript challenges.
5. **`identity.mode: rotate`.** For sites that block non-browser clients.
6. **Proxies.** Only when a single IP genuinely can't do the job.
7. **Ask the site.** Surprisingly often works, especially for research or
   non-commercial use. Many operators will give you a data dump or an API key
   rather than deal with a crawler.

If you're several steps down this list and still fighting, that's a signal worth
listening to. See [Compliance](09-compliance.md).

---

## Next

- [Compliance](09-compliance.md)
- [Troubleshooting](10-troubleshooting.md)
