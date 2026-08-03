# Output formats

Format is inferred from the file extension. Several destinations at once is
fine — each gets every record.

```yaml
output:
  - products.csv
  - products.json
  - path: products.db
    format: sqlite
    table: products
```

```bash
harvest run r.yaml -o products.csv -o products.json
```

---

## Choosing

| Format | Extension | Streams | Good for |
|---|---|---|---|
| NDJSON | `.ndjson` `.jsonl` | yes | large runs, appending, `jq`, pandas, DuckDB |
| JSON | `.json` | flat memory | small datasets, APIs |
| CSV / TSV | `.csv` `.tsv` | yes | spreadsheets, quick inspection |
| Excel | `.xlsx` | no | sharing with non-technical colleagues |
| SQLite | `.db` `.sqlite` | yes | querying, incremental updates, joins |
| Console | — | yes | piping, debugging |
| Gzip | `*.gz` | yes | archives |

**Default to NDJSON for anything large.** It streams, it appends safely, it
survives an interrupted run (every complete line is valid), and every data tool
reads it.

**CSV when a human will open it.** Nested objects flatten to `author.name`
columns; scalar arrays join with `; `.

---

## NDJSON

```yaml
output:
  - path: data.ndjson
    append: false
    gzip: false
```

```bash
harvest run r.yaml -o data.ndjson
jq 'select(.price < 50)' data.ndjson
```

Fully streaming — memory stays flat whether you write 100 records or 10 million.

---

## JSON

```yaml
output:
  - path: data.json
    pretty: true       # false for one dense line
```

Written incrementally (open bracket, commas, close bracket), so memory stays
flat even though the file format isn't streamable. An empty run still produces
a valid `[]`.

---

## CSV and TSV

```yaml
output:
  - path: data.csv
    delimiter: ","
    columns: [sku, title, price]   # pin them, or let them be inferred
    header_sample_size: 100
    bom: true
    append: false
```

**Columns.** If you don't pin them, they're inferred from the first
`header_sample_size` records (union of keys, ordered by frequency) — inference
has to buffer that many rows because the header must be written first. Fields
that first appear *after* the header is written can't be added to it; the run
summary reports them and tells you to pin `columns`.

**BOM.** A UTF-8 byte-order mark is written by default so Excel opens non-ASCII
text correctly rather than as mojibake. `bom: false` to omit it.

**Escaping.** Values are quoted only when they need it. Embedded quotes are
doubled, and control characters that corrupt CSV parsers regardless of quoting
are stripped.

---

## Excel

```yaml
output:
  - path: data.xlsx
    sheet_name: Products
    columns: [sku, title, price]
```

Written with no third-party dependency — an `.xlsx` file is a ZIP of XML parts,
and the archive is built directly. Numbers and booleans are typed (so they sort
and sum correctly), the header row is bold and frozen, and an autofilter is
applied.

Buffers all rows: spreadsheets aren't a streaming format, and anything large
enough to matter should be CSV or SQLite. Capped at Excel's 1,048,575-row limit.

---

## SQLite

Requires Node 22.5 or newer (the built-in `node:sqlite` — no native module to
compile).

```yaml
output:
  - path: data.db
    format: sqlite
    table: products
    upsert_key: sku      # INSERT OR REPLACE on this column
```

Columns are created from the first batch; new columns are added with
`ALTER TABLE` as they appear, so a changing record shape doesn't break the run.
WAL mode is enabled, so you can query the database while the crawl is still
running:

```bash
sqlite3 data.db "SELECT title, price FROM products ORDER BY price DESC LIMIT 10"
```

`upsert_key` makes repeated runs idempotent — re-scraping a product updates its
row instead of duplicating it.

---

## Console and stdout

With no `-o`, records go to stdout as NDJSON while logs go to stderr:

```bash
harvest run r.yaml | jq -r '.title'
harvest run r.yaml 2>run.log | wc -l
```

```yaml
output:
  - format: console
    mode: ndjson       # ndjson | json | table
```

`mode: table` prints an aligned table — handy for a quick look, not for piping.

---

## Gzip

Append `.gz` to any streaming format:

```yaml
output:
  - data.ndjson.gz
  - data.csv.gz
```

Typically 80–90% smaller for scraped text.

---

## Metadata columns

```yaml
metadata:
  url: true            # _url
  scraped_at: true     # _scraped_at
  depth: false         # _depth
  label: false         # _label
```

`metadata: false` turns them all off. Keep `_url` — knowing which page a record
came from is what makes a dataset debuggable six months later.

---

## Quarantined records

When validation is set to `quarantine` (the default), failing records go to
`quarantine.ndjson` beside your main output, with the reason attached:

```json
{ "title": "Widget", "price": null,
  "_issues": [{ "field": "price", "rule": "required", "message": "is required but missing or empty" }] }
```

Inspect it. A sudden pile of quarantined records almost always means the site
changed, and the `_issues` field tells you which selector to look at.

---

## Incremental and append-only datasets

```yaml
dedupe:
  strategy: fields
  key_fields: [sku]
  persist_path: .harvester/seen.json

output:
  - path: data.ndjson
    append: true
```

The seen-set survives between runs, so a nightly job appends only records it
hasn't emitted before. For SQLite, `upsert_key` achieves the same with updates
instead of appends.

---

## Custom destinations

Anything not covered — a database, a queue, an API — is a hook:

```js
hooks: {
  async onItems(items) {
    await db.collection('products').insertMany(items);
    return items;          // return them so file outputs still run
  },
}
```

Or implement the writer contract (`open`, `write`, `close`) and pass an instance
in `output`:

```js
import { Writer } from 'harvester/storage';

class KafkaWriter extends Writer {
  async open() { this.producer = await connect(); }
  async write(items) {
    await this.producer.send({ topic: 'scraped', messages: items.map((v) => ({ value: JSON.stringify(v) })) });
    this.count += items.length;
  }
  async close() { await this.producer.disconnect(); return this.summary(); }
}

export default { output: [new KafkaWriter()], /* … */ };
```

---

## Buffering

```yaml
storage:
  batch_size: 100
  flush_interval_ms: 5000
```

Records are batched so writers get useful chunk sizes, and flushed on a timer so
a slow crawl still produces output promptly. Lower `batch_size` if you're
tailing the file live; raise it for maximum throughput.

If one destination fails mid-run it's disabled with an error and the others
carry on — a broken sink shouldn't lose the data going everywhere else. If
*every* destination fails to open, the run stops immediately rather than
crawling with nowhere to put the results.
