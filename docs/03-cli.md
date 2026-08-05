# CLI reference

```
harvest <command> [options]
```

| Command | Purpose |
|---|---|
| [`ui`](#harvest-ui) | Open the visual interface in a browser |
| [`run`](#harvest-run) | Run a scrape from a recipe |
| [`profile`](#harvest-profile) | Measure where a run's time goes |
| [`init`](#harvest-init) | Create a recipe from a template |
| [`inspect`](#harvest-inspect) | Analyse a page and suggest selectors |
| [`test`](#harvest-test) | Dry-run extraction on a single page |
| [`quick`](#harvest-quick) | Ad-hoc scrape with no recipe |
| [`validate`](#harvest-validate) | Check a recipe without running it |
| [`robots`](#harvest-robots) | Show what robots.txt allows |
| [`transforms`](#harvest-transforms) | List every transform |
| [`cache`](#harvest-cache) | Manage the response cache |

Global: `--help`, `--version`, `--verbose`, `--quiet`, `--json`.

---

## `harvest ui`

```bash
harvest ui [options]
```

Starts a local web server and opens it in your browser. Everything below is
available there too: inspecting pages, editing recipes with live validation,
testing selectors, and watching runs stream in.

| Option | Description |
|---|---|
| `--port <n>` | Port to listen on (default 4180) |
| `--host <addr>` | Interface to bind (default 127.0.0.1) |
| `--dir <path>` | Folder holding your recipes (default: current directory) |
| `--no-open` | Don't launch a browser |

Binds to localhost only, and every request must carry a session token generated
at startup and embedded in the page. Full detail: [Web
interface](13-web-interface.md).

```bash
harvest ui
harvest ui --dir ./recipes --port 8080
```

---

## `harvest run`

```bash
harvest run <recipe> [options]
```

CLI options override the recipe.

**Output**

| Option | Description |
|---|---|
| `-o, --output <path>` | Destination; repeat for several. Format inferred from the extension. |
| `-f, --format <fmt>` | Force a format: `json`, `ndjson`, `csv`, `tsv`, `xlsx`, `sqlite`, `console` |
| `--report <path>` | Write the JSON run report here |
| `--dry-run` | Do everything except write output |

**Limits and speed**

| Option | Description |
|---|---|
| `-l, --limit <n>` | Stop after N pages |
| `--max-items <n>` | Stop after N records |
| `-c, --concurrency <n>` | Parallel requests (default 4) |
| `--rps <n>` | Requests per second, per host |
| `--delay <ms>` | Minimum gap between requests to one host |
| `--depth <n>` | Maximum crawl depth |
| `--timeout <ms>` | Per-request timeout |
| `-p, --preset <name>` | `fast`, `polite`, `careful`, `spa`, `develop` (repeatable) |

**Behaviour**

| Option | Description |
|---|---|
| `--render [mode]` | `never`, `auto`, `always`. Bare `--render` means `always`. |
| `--proxy <url>` | Proxy URL (repeatable) |
| `--proxy-file <path>` | File with one proxy per line |
| `--user-agent <ua>` | Override the User-Agent |
| `--contact <url>` | Contact URL advertised in the bot User-Agent |
| `--no-robots` | Skip robots.txt — see [Compliance](09-compliance.md) |
| `--cache` | Cache HTTP responses |
| `--resume` | Resume from a checkpoint, and checkpoint as you go |
| `--sitemap` | Seed the frontier from the site's sitemap |

**Diagnostics**

| Option | Description |
|---|---|
| `-v, --verbose` | Debug logging |
| `-q, --quiet` | Errors only |
| `--json` | JSON logs and a JSON report on stdout |
| `--print-config` | Print the fully resolved config and exit |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The run failed (no page succeeded) |
| `2` | Pages were fetched but nothing was extracted — usually a broken selector |
| `64` | Bad command line |
| `78` | Bad recipe |
| `130` | Interrupted twice (forced quit) |

Code `2` is what makes `harvest run` usable in cron or CI: a silent
extraction failure becomes a non-zero exit instead of an empty file.

**Examples**

```bash
harvest run shop.yaml -o products.csv
harvest run shop.yaml -o data.json -o data.xlsx --limit 100
harvest run spa.yaml --render always --preset careful
harvest run big.yaml --resume --cache --report run.json
harvest run shop.yaml --print-config          # what did my flags actually do?
harvest run shop.yaml | jq -r '.title'        # NDJSON on stdout
```

Pressing `Ctrl+C` once finishes in-flight requests and shuts down cleanly
(writing a checkpoint if `--resume` is on). Pressing it twice quits immediately.

---

## `harvest profile`

```bash
harvest profile <recipe> [options]
```

Answers "why is this slow?" by measuring rather than guessing. Throughput
problems have four common causes that produce indistinguishable numbers and need
opposite fixes: the politeness budget you configured, a robots.txt `Crawl-delay`
overriding it, headless rendering, or one request per record.

| Option | Description |
|---|---|
| `--dry` | Arithmetic only — predict the ceiling, make no requests |
| `--limit <n>` | Pages to sample (default 25) |
| `--records <n>` | Project the time for this many records (default 1000) |
| `-p, --preset <name>` | Profile as though this preset were applied |

```bash
harvest profile shop.yaml --dry     # instant, offline
harvest profile shop.yaml           # sample and diagnose
```

`--dry` also calls out the most common misunderstanding: on a single-host crawl,
the rate limit is per host, so raising `concurrency` cannot help.

Sampled runs write nothing and are capped, so they're safe to run against a live
site. Full guide: [Troubleshooting → the run is very
slow](10-troubleshooting.md#the-run-is-very-slow).

---

## `harvest inspect`

```bash
harvest inspect <url> [options]
```

Fetches a page and reports what's on it: whether JavaScript is required, what
structured data it publishes, which repeated blocks look like records, candidate
selectors, tables, and pagination.

| Option | Description |
|---|---|
| `--render` | Also render with a browser. Enables a **measured** JS verdict rather than a heuristic one, by comparing the rendered DOM against the raw HTML. |
| `--generate <path>` | Write a starter recipe |
| `--save <path>` | Save the fetched HTML |
| `--full` | Show every repeated block, not just the top few |
| `--json` | Emit the analysis as JSON |
| `--no-robots` | Skip the robots.txt check |

```bash
harvest inspect https://books.toscrape.com --generate books.yaml
harvest inspect https://spa.example.com --render
harvest inspect https://site.com --json | jq '.structuredData'
```

---

## `harvest test`

```bash
harvest test <recipe> [url] [options]
```

Fetches **one** page and shows exactly what your recipe would extract, with a
per-field coverage bar. Nothing is written, nothing is crawled.

| Option | Description |
|---|---|
| `--label <name>` | Test the extract block for a given route label |
| `--render` | Render with a browser |
| `--save <path>` | Save the HTML for offline iteration |
| `--json` | Emit the records as JSON |

Exits `2` when nothing was extracted.

```bash
harvest test books.yaml
harvest test books.yaml https://books.toscrape.com/catalogue/page-2.html
harvest test shop.yaml --label detail
```

---

## `harvest quick`

```bash
harvest quick <url> --field name=selector [...]
```

One-off scrape with no recipe file.

| Option | Description |
|---|---|
| `--field <name=selector>` | Field to extract (repeatable). `sel@attr` reads an attribute. |
| `--selector <css>` | Container selector for repeated items |
| `--render` | Render with a browser |
| `-o, --output <path>` | Write to a file instead of stdout |

```bash
harvest quick https://news.ycombinator.com \
  --selector ".athing" \
  --field "title=.titleline a" \
  --field "url=.titleline a@href"
```

`@href` and `@src` are resolved to absolute URLs automatically.

---

## `harvest init`

```bash
harvest init [name] [--template <name>] [--force]
```

| Template | For |
|---|---|
| `basic` | a single page of repeated items |
| `crawl` | listing → detail pages, with pagination |
| `spa` | JavaScript-heavy sites |
| `api` | a site's own JSON API |
| `structured` | JSON-LD extraction |
| `tables` | HTML tables |

```bash
harvest init my-scraper --template crawl
```

---

## `harvest validate`

```bash
harvest validate <recipe>
```

Checks the recipe — selector syntax, XPath syntax, transform names, regex
validity, output formats — and prints a summary of what it would do. No network
access. Good as a pre-commit hook.

---

## `harvest robots`

```bash
harvest robots <url> [--user-agent <ua>] [--json]
```

Shows whether a URL is allowed, which rule matched, the `Crawl-delay`, and any
declared sitemaps. Exits `1` when disallowed, so it composes with `&&`.

```bash
harvest robots https://example.com/products && harvest run shop.yaml
```

---

## `harvest transforms`

Lists every available transform, grouped by purpose. `--json` for the raw list.

---

## `harvest cache`

```bash
harvest cache clear     # delete everything
harvest cache prune     # delete expired entries only
```

---

## Piping

Logs and progress go to **stderr**; data goes to **stdout**. So:

```bash
harvest run shop.yaml | jq 'select(.price < 50)'
harvest run shop.yaml --json 2>run.log | wc -l
harvest run shop.yaml -o - -f csv > products.csv
```
