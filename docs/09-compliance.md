# Compliance and ethics

Web scraping is legal in many contexts and illegal or contractually prohibited
in others, and the line depends on jurisdiction, the data, the site's terms, and
what you do with it afterwards. This page explains what the tool does by
default, why, and what remains your responsibility.

**None of this is legal advice.** If the stakes are meaningful — commercial use,
personal data, a site that has objected — get advice from someone qualified.

---

## What the defaults do

| Default | Behaviour |
|---|---|
| `robots.enabled: true` | robots.txt is fetched and enforced before any page is requested |
| `robots.respect_crawl_delay: true` | `Crawl-delay` raises the minimum gap between requests |
| `robots.on_error: deny` | if robots.txt can't be read, treat the site as disallowed |
| `rate_limit.requests_per_second: 1` | one request per second per host |
| `concurrency_per_host: 2` | at most two requests in flight per host |
| `identity.mode: bot` | an honest, identifying User-Agent |
| `crawl.allowed_domains` | defaults to the hosts of your start URLs |
| CAPTCHA solving | off, with no vendor client bundled |

The intent: a recipe that says nothing about politeness is polite. Going faster
or quieter is an explicit choice you make and can be held to.

---

## robots.txt

The Robots Exclusion Protocol was standardised as [RFC
9309](https://www.rfc-editor.org/rfc/rfc9309) in 2022. This implementation
follows it, including the parts commonly skipped:

- **Most-specific match wins.** `Allow: /a/b` beats `Disallow: /a` because it's
  longer, regardless of order in the file. Equal-length conflicts resolve to
  `Allow`.
- **Wildcards.** `*` matches any run of characters; `$` anchors the end of the
  path and query.
- **Group selection.** The most specific matching `User-agent` group is used,
  with `*` only as a fallback. Consecutive `User-agent` lines share one group.
- **Status handling.** `4xx` means no restrictions. `5xx` or an unreachable
  robots.txt means *treat the whole site as disallowed* until it can be read.

That last one deserves a note. `on_error: deny` is the default because guessing
in the permissive direction is the unsafe guess: if a site is having an outage,
crawling it anyway is precisely the wrong thing to do. Override only if you know
the site's rules independently:

```yaml
robots:
  on_error: allow
```

Check what applies before you write a recipe:

```bash
harvest robots https://example.com/products
```

```
  Verdict      allowed
  Matched      no_matching_rule
  Crawl-delay  10s
  Sitemaps     https://example.com/sitemap.xml
```

Exits non-zero when disallowed, so it composes:

```bash
harvest robots https://example.com/x && harvest run recipe.yaml
```

### Disabling it

```yaml
robots:
  enabled: false
```

```bash
harvest run recipe.yaml --no-robots
```

This is deliberately visible: it logs a warning at run start and appears in
`report.warnings`. There are legitimate reasons — your own site, a staging
environment, a contract or API agreement that supersedes robots.txt, a
robots.txt that blocks everything but where you have written permission. What
there isn't is a *technical* reason. If you turn it off, you're asserting you
have another basis for access.

Note that robots.txt is a request for crawler behaviour, not an access control
and not, by itself, a legal instrument. Ignoring it isn't automatically
unlawful — but it is evidence about your intent if a dispute arises, and it's
the first thing anyone will look at.

---

## Rate limiting as an ethical matter

Bandwidth and CPU cost the site owner money. A crawler running at 50 req/s
against a small site is imposing a real cost and may degrade service for actual
users. That's the practical harm, and it's the one most likely to matter.

The defaults here are conservative on purpose. When you raise them, scale to the
target: a large e-commerce platform absorbs 10 req/s without noticing; a
volunteer-run archive does not.

```yaml
rate_limit:
  requests_per_second: 0.5     # a small site
  jitter_ms: 1000
concurrency_per_host: 1
```

Crawling outside the target's business hours is a courtesy worth considering for
smaller sites.

---

## Declaring why you may go fast

The defaults are conservative. When you raise them, say why:

```yaml
rate_limit:
  requests_per_second: 20
authorization:
  basis: owner        # public | owner | permission | api-terms
  note: "written permission from ops@example.com, 2026-01-12"
```

This changes no behaviour — it gates a warning and is recorded in
`report.posture`. Above 4 req/s or 4 concurrent per host, a run with
`basis: public` prints:

```
rate_limit.requests_per_second: 20 and concurrency_per_host: 8 are well above
the polite default. If you own this site or have permission, declare it with
`authorization: { basis: owner }`. Otherwise lower them.
```

The point is attribution. A fast run that records *why* it was entitled to be
fast is defensible; an anonymous one is just fast. `--preset owned` sets
`basis: owner` for you — and deliberately does **not** disable robots.txt, which
remains a separate, explicit act.

For a site you own that publishes a `Crawl-delay` aimed at other crawlers:

```yaml
robots:
  ignore_crawl_delay: true   # still enforces Allow/Disallow
```

That is narrower than `robots.enabled: false`, and it is the right tool when the
only thing in your way is your own configuration.

---

## Identify yourself

```yaml
identity:
  contact: https://example.com/about-my-crawler
```

```
Harvester/1.0 (compatible; web scraper; +https://example.com/about-my-crawler)
```

Put a page at that URL saying who you are, what you're collecting, why, and how
to ask you to stop. This costs nothing and changes outcomes: operators
overwhelmingly prefer a crawler they can contact over one they can only block.

Disguising a scraper as a browser isn't automatically wrong — the rotation
features exist because some sites block all non-browser traffic indiscriminately
— but it's a meaningful step. Take it knowingly, not by default.

---

## Terms of service

Many sites prohibit automated access in their terms. Whether those terms bind
you depends on how they were presented and where you are — a click-through
agreement you accepted is on much firmer ground than a link in a footer.

Enforceability aside: if a site's terms say no, you know the operator's
position. Proceeding is a choice about risk, not a technicality.

Situations that raise the stakes materially:

- You created an account and clicked through terms to reach the data
- You're bypassing authentication or an access control
- You're circumventing an anti-bot measure after being blocked
- You've received a cease-and-desist and continued

---

## Personal data

If the data identifies a living person — names, emails, usernames, photos,
profiles, reviews tied to individuals — then GDPR (EU/UK), CCPA (California),
and comparable regimes may apply **even though the data is public**. Publicly
accessible is not the same as free to process.

Under GDPR, obligations that typically apply to scraped personal data include:

- A lawful basis for processing (usually legitimate interests, which requires a
  documented balancing assessment)
- Notifying the people concerned (Article 14) — with a narrow exception where
  this is impossible or disproportionate, which you must be able to justify
- Data minimisation — collect only what you actually need
- Honouring access, rectification and erasure requests
- Storage limitation — a defined retention period, not "forever"

Practical guidance:

- **Don't collect personal data you don't need.** The cheapest compliance
  strategy by a wide margin. If you need review *text*, you may not need the
  reviewer's name.
- **Aggregate early** where the analysis allows it.
- **Never scrape special-category data** — health, religion, ethnicity, political
  opinions, sexual orientation, biometrics — without specific legal advice.
- **Secure what you store.** A scraped dataset of personal data is a breach
  waiting to happen.

If you're building a dataset of people, talk to a privacy professional before
you build it, not after.

---

## Copyright and database rights

Facts aren't copyrightable; creative expression is. Scraping prices, ratings and
availability sits on much safer ground than reproducing article text, photographs
or reviews.

The EU additionally recognises a *sui generis* database right protecting
substantial investment in compiling a database, independent of copyright in its
contents. Extracting a substantial part of a protected database can infringe
even where no individual item is protected.

Practical positions:

- Extract facts and data points, not prose and images
- Don't republish substantial verbatim content
- Transformative analysis is on firmer ground than redistribution
- Attribute sources

---

## A checklist before a real run

- [ ] `harvest robots <url>` — am I allowed?
- [ ] Have I read the terms of service?
- [ ] Is there an API, feed, or bulk download that would serve me better?
- [ ] Am I collecting personal data? Do I have a basis and a retention plan?
- [ ] Is my rate limit proportionate to this site's size?
- [ ] Is `identity.contact` set to a page that actually exists?
- [ ] Have I tested with `--limit 5 --cache` first?
- [ ] Do I know what I'll do if the operator asks me to stop?

---

## When to stop

Some signals are worth treating as a stop, not an obstacle:

- A cease-and-desist, or any direct request to stop
- Blocks that persist after you've slowed down substantially and identified
  yourself — that's an operator making a decision, not a technical hurdle
- A robots.txt that changes to disallow you
- Discovering the data is personal, sensitive, or behind an access control you
  hadn't noticed

Persisting past a clear objection changes the character of what you're doing,
both ethically and in how a court is likely to see it.

---

## Ask first

The most underrated option. Site operators are people, and many will:

- Give you an API key
- Send you a bulk export
- Tell you which endpoints are cheap to hit
- Point you at data they already publish

An email costs ten minutes and can replace weeks of engineering — and it turns
an adversarial relationship into a cooperative one.

---

## Next

- [Anti-blocking](08-anti-blocking.md) — the technical side
- [Troubleshooting](10-troubleshooting.md)
