# The web interface

Everything the CLI does, in a browser — with live progress, inline validation
and results you can click through.

```bash
harvest ui
```

```
  Harvester v1.0.0

  ▸ http://127.0.0.1:4180/?token=j6Yt_E0cvt_uQ1i89rKYAkQ4rEi8yDAa

  Recipes  C:\Users\you\scrapers
  Stop     Ctrl+C
```

Your browser opens automatically. If it doesn't, copy that URL — the token in it
is required.

---

## The workflow

The interface is built around one path: **URL in, data out**.

### 1. Inspect a page

Paste a URL and press **Analyze**. Harvester fetches the page and reports:

- whether the content needs JavaScript (and, with **Render JS** ticked, it
  *measures* this by comparing the rendered DOM against the raw HTML rather than
  guessing),
- what robots.txt allows, and any `Crawl-delay`,
- structured data the page already publishes — JSON-LD, microdata, OpenGraph,
- **repeated blocks** that look like a list of records, ranked, with the top
  candidate starred,
- **suggested fields** with the selector and transform for each,
- any tables, and how pagination works.

Press **Create recipe** and it writes a working recipe from all of that.

### 2. Edit and validate

The recipe opens in the editor. Validation runs as you type — selector syntax,
XPath syntax, transform names, regex validity — and the panel on the right
summarises what the recipe will actually do: start URLs, item selector, fields,
request rate, whether robots.txt is enforced, where output goes.

The editor handles YAML properly: Tab indents (Shift+Tab outdents), Enter keeps
your indentation, and there's a line gutter. `Ctrl+S` saves.

### 3. Test

**Test** fetches a single page and shows exactly what your recipe would extract:

- how many elements the item selector matched,
- a **coverage bar per field** — the fraction of records where it produced a
  value,
- the first records, in a table.

A field at 0% is a broken selector, and you find out in one request instead of
an hour into a crawl.

### 4. Run

**Run** starts the scrape and switches to the live view:

- status, items, pages, queued, failed and rate, updating as it goes,
- a progress bar,
- **Data** — records appearing in a table in real time,
- **Log** — the structured log stream,
- **Report** — field health, warnings and grouped failures when it finishes.

**Stop** finishes in-flight requests and shuts down cleanly. **Download** gives
you CSV, JSON, NDJSON or Excel.

---

## Options

The **Run options** panel overrides the recipe for one run without editing it:

| Option | Effect |
|---|---|
| Page limit | Stop after N pages — the safe way to try a new recipe |
| Requests / sec | Per-host rate |
| Concurrency | Parallel requests |
| Preset | `fast`, `polite`, `careful`, `spa`, `develop` |
| Rendering | `never`, `auto`, `always` |
| Cache responses | Re-runs served from disk — use this while iterating |
| Resume / checkpoint | Survive an interruption and continue |

**Start with a page limit of 5 and caching on.** You'll iterate faster and the
site will barely notice you.

---

## Recipes and the workspace

The sidebar lists every recipe in your workspace folder — by default whichever
directory you ran `harvest ui` from:

```bash
harvest ui --dir ./recipes
```

Recipes here are ordinary files. The CLI, the UI and your editor all read the
same ones, so nothing is locked into the interface:

```bash
harvest ui --dir ./recipes      # build it visually
harvest run recipes/shop.yaml   # then run it from cron
```

**+** creates a recipe from a template (`basic`, `crawl`, `spa`, `api`,
`structured`, `tables`). A recipe with a problem is marked with a red `!`.

JavaScript recipes (`.js`) appear in the list and can be run, but are read-only
in the editor — they can import other modules, so editing them belongs in your
own editor.

---

## Runs

**Runs** lists every scrape with its status, item count and duration. Click one
to reopen its live view, data and report; history survives a server restart.

Runs are stored under `.harvester/ui/runs/<id>/` in your workspace, with the
records as NDJSON plus the report. The 50 most recent are kept.

---

## Keyboard

| Key | Action |
|---|---|
| `Ctrl`/`Cmd` + `S` | Save the recipe |
| `Ctrl`/`Cmd` + `Enter` | Save and run |
| `Tab` / `Shift`+`Tab` | Indent / outdent |
| `Esc` | Close a dialogue |

---

## Options for `harvest ui`

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `4180` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Interface to bind |
| `--dir <path>` | current directory | Folder holding your recipes |
| `--no-open` | | Don't launch a browser |

---

## Security

This starts a server that can make network requests and write files, so the
defaults matter:

- **Loopback only.** Binds to `127.0.0.1` unless you explicitly pass `--host`.
- **Session token.** Generated at startup and embedded in the served page. Every
  API call must present it. This is what stops another site you happen to have
  open from driving your scraper via `fetch('http://localhost:4180/api/runs')` —
  a browser can't read the token, and can't send the custom header cross-origin
  without a preflight, which is refused.
- **Origin checks.** Cross-origin requests are rejected; no CORS headers are
  ever sent.
- **Content Security Policy.** The page can't load or contact anything external.
- **Confined workspace.** Recipe names are validated; paths can't escape the
  workspace folder.

Two things to keep in mind:

- **The token is in the URL.** It'll be in your browser history. Restarting the
  server issues a new one.
- **`--host 0.0.0.0` exposes it.** Anyone who can reach the address and has the
  token can run scrapes from your machine and read files it produces. Don't do
  this on a network you don't control; the CLI warns you when you try.

The interface is a local tool for one person. It has no accounts, no
multi-tenancy, and isn't built to be exposed to the internet.

---

## When to use the CLI instead

The UI is best for exploring a site and building a recipe. The CLI is better for:

- **Scheduled runs** — cron, CI, task scheduler. Exit code `2` means "pages
  fetched but nothing extracted", which is what catches a site changing.
- **Very large crawls** — no browser tab holding a connection open.
- **Pipelines** — `harvest run r.yaml | jq …`.
- **Version control** — recipes are files; review them in pull requests.

They share the same recipes and the same engine, so moving between them costs
nothing.

---

## Troubleshooting

**"Could not reach the Harvester server"** — the page was opened without the
token, or the server was restarted (which issues a new one). Use the URL printed
in the terminal.

**Port already in use** — `harvest ui --port 8080`.

**Rendering unavailable** in the sidebar — Playwright isn't installed:

```bash
npm install playwright && npx playwright install chromium
```

**A run seems stuck** — check the Log tab. A large `queued` number usually means
the crawl is expanding faster than expected; add `deny_patterns` and a page
limit. See [Troubleshooting](10-troubleshooting.md).
