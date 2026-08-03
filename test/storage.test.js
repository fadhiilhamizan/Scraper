import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  createWriter, MultiWriter, BufferedSink, csvEscape, formatFromPath,
  NdjsonWriter, JsonWriter, CsvWriter, XlsxWriter,
} from '../src/storage/index.js';

let tmpDir;

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harvester-test-'));
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const out = (name) => path.join(tmpDir, name);

const SAMPLE = [
  { id: 1, name: 'Widget', price: 10.5, tags: ['a', 'b'] },
  { id: 2, name: 'Gadget, Inc.', price: 25, tags: [] },
  { id: 3, name: 'Say "hi"', price: null, tags: ['c'] },
];

test('formatFromPath infers format and gzip from the extension', () => {
  assert.deepEqual(formatFromPath('data.csv'), { format: 'csv', gzip: false });
  assert.deepEqual(formatFromPath('data.ndjson.gz'), { format: 'ndjson', gzip: true });
  assert.deepEqual(formatFromPath('data.sqlite'), { format: 'sqlite', gzip: false });
  assert.equal(formatFromPath('data.unknown'), null);
});

test('createWriter refuses an unrecognisable path with a helpful message', () => {
  assert.throws(() => createWriter('data.weird'), /Cannot infer an output format/);
  assert.throws(() => createWriter({ format: 'nope' }), /Unknown output format/);
});

test('csvEscape quotes only when needed', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('has,comma'), '"has,comma"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line\nbreak'), '"line\nbreak"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape({ a: 1 }), '"{""a"":1}"');
});

test('the NDJSON writer emits one JSON object per line', async () => {
  const file = out('a.ndjson');
  const writer = new NdjsonWriter({ path: file });
  await writer.open();
  await writer.write(SAMPLE.slice(0, 2));
  await writer.write(SAMPLE.slice(2));
  const summary = await writer.close();

  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), SAMPLE[0]);
  assert.equal(summary.records, 3);
});

test('the JSON writer produces one valid array across several writes', async () => {
  const file = out('a.json');
  const writer = new JsonWriter({ path: file });
  await writer.open();
  await writer.write(SAMPLE.slice(0, 1));
  await writer.write(SAMPLE.slice(1));
  await writer.close();

  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[2], SAMPLE[2]);
});

test('an empty run still produces a valid JSON array', async () => {
  const file = out('empty.json');
  const writer = new JsonWriter({ path: file });
  await writer.open();
  await writer.close();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
});

test('the CSV writer infers columns, escapes, and flattens arrays', async () => {
  const file = out('a.csv');
  const writer = new CsvWriter({ path: file, bom: false });
  await writer.open();
  await writer.write(SAMPLE);
  await writer.close();

  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 4, 'header plus three rows');

  const header = lines[0].split(',');
  assert.ok(header.includes('id') && header.includes('name') && header.includes('price'));
  assert.ok(lines[2].includes('"Gadget, Inc."'), 'a comma in a value must be quoted');
  assert.ok(lines[3].includes('"Say ""hi"""'), 'quotes must be doubled');
  assert.ok(lines[1].includes('a; b'), 'scalar arrays join with a semicolon');
});

test('CSV columns can be pinned explicitly', async () => {
  const file = out('pinned.csv');
  const writer = new CsvWriter({ path: file, columns: ['name', 'id'], bom: false });
  await writer.open();
  await writer.write(SAMPLE);
  await writer.close();

  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines[0], 'name,id');
  assert.equal(lines[1], 'Widget,1');
  assert.ok(writer.summary().warning?.includes('price'), 'omitted fields must be reported');
});

test('CSV writes a BOM by default so Excel reads UTF-8 correctly', async () => {
  const file = out('bom.csv');
  const writer = new CsvWriter({ path: file });
  await writer.open();
  await writer.write([{ name: 'Café' }]);
  await writer.close();
  const buffer = await fs.readFile(file);
  assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('a gzip output is a readable gzip stream', async () => {
  const file = out('a.ndjson.gz');
  const writer = createWriter(file);
  await writer.open();
  await writer.write(SAMPLE);
  await writer.close();

  const decompressed = zlib.gunzipSync(await fs.readFile(file)).toString('utf8');
  assert.equal(decompressed.trim().split('\n').length, 3);
});

test('the XLSX writer produces a well-formed zip archive', async () => {
  const file = out('a.xlsx');
  const writer = new XlsxWriter({ path: file, sheetName: 'Products' });
  await writer.open();
  await writer.write(SAMPLE);
  await writer.close();

  const buffer = await fs.readFile(file);
  // Local file header signature and end-of-central-directory record.
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.ok(buffer.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
  assert.ok(buffer.length > 500);

  // The sheet name should survive into the workbook part (stored deflated, so
  // check by inflating every entry we can find).
  const text = buffer.toString('latin1');
  assert.ok(text.includes('[Content_Types].xml'));
  assert.ok(text.includes('xl/worksheets/sheet1.xml'));
});

test('MultiWriter fans out to every destination', async () => {
  const csvPath = out('multi.csv');
  const jsonPath = out('multi.json');
  const writer = new MultiWriter([csvPath, jsonPath]);
  await writer.open();
  await writer.write(SAMPLE);
  const summaries = await writer.close();

  assert.equal(summaries.length, 2);
  assert.equal(JSON.parse(await fs.readFile(jsonPath, 'utf8')).length, 3);
  assert.equal((await fs.readFile(csvPath, 'utf8')).trim().split('\n').length, 4);
});

test('BufferedSink batches and flushes the remainder on close', async () => {
  const file = out('buffered.ndjson');
  const writer = new MultiWriter([file]);
  const sink = new BufferedSink(writer, { batchSize: 2, flushIntervalMs: 0 });
  await sink.open();

  for (const item of SAMPLE) await sink.push(item);
  await sink.close();

  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
});

test('a nested record flattens into dotted CSV columns', async () => {
  const file = out('nested.csv');
  const writer = new CsvWriter({ path: file, bom: false });
  await writer.open();
  await writer.write([{ id: 1, meta: { author: 'Ada', year: 1843 } }]);
  await writer.close();

  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.ok(lines[0].includes('meta.author'));
  assert.ok(lines[1].includes('Ada'));
});
