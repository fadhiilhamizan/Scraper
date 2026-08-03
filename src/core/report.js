/**
 * The run report.
 *
 * More than a summary — it is the answer to "did this run actually work?".
 * The two sections that earn their keep are:
 *
 *  - **Field health.** Per-field fill rates. A field that populated on 4 % of
 *    pages did not "mostly work"; its selector is broken. Finding that here
 *    beats finding it three weeks later in a dashboard.
 *  - **Failure grouping.** Errors collapsed by cause, so 900 failures show up
 *    as one line saying `HTTP 429 × 900` instead of 900 lines.
 */

import { shortenUrl } from '../queue/urlutils.js';

/** Fill rate below this (with enough samples) is reported as a likely breakage. */
const FIELD_HEALTH_WARN = 50;
const FIELD_HEALTH_FAIL = 10;
const FIELD_HEALTH_MIN_SAMPLES = 5;

export function buildReport(scraper, outputs = []) {
  const { config, counters, metrics } = scraper;
  const durationMs = (scraper.finishedAt ?? Date.now()) - (scraper.startedAt ?? Date.now());
  const snapshot = metrics.snapshot();

  const fieldHealth = [...scraper.fieldStats.values()]
    .map((entry) => {
      const rate = entry.attempts ? +((entry.filled / entry.attempts) * 100).toFixed(1) : 0;
      let status = 'ok';
      if (entry.attempts >= FIELD_HEALTH_MIN_SAMPLES) {
        if (rate <= FIELD_HEALTH_FAIL) status = 'broken';
        else if (rate < FIELD_HEALTH_WARN) status = 'degraded';
      }
      return { ...entry, fillRate: rate, status };
    })
    .sort((a, b) => a.fillRate - b.fillRate);

  const failures = groupFailures(scraper.frontier.failed);

  const warnings = [...scraper.warnings];
  for (const field of fieldHealth) {
    if (field.status === 'broken') {
      warnings.push(
        `Field '${field.field}' was empty on ${(100 - field.fillRate).toFixed(0)}% of pages — ` +
        'its selector has probably stopped matching.',
      );
    }
  }
  if (counters.requestsBlocked > 0) {
    warnings.push(
      `${counters.requestsBlocked} request(s) hit bot protection. Consider lowering ` +
      '`rate_limit.requests_per_second`, enabling rendering, or using proxies.',
    );
  }
  if (counters.pagesOk > 0 && counters.itemsExtracted === 0 && config.extract) {
    warnings.push(
      'Pages were fetched successfully but no items were extracted. Check your `extract` selectors ' +
      'with `harvest test <url> --recipe <file>`.',
    );
  }

  return {
    name: config.name,
    startedAt: new Date(scraper.startedAt ?? Date.now()).toISOString(),
    finishedAt: new Date(scraper.finishedAt ?? Date.now()).toISOString(),
    durationMs,
    durationHuman: formatDuration(durationMs),
    completed: scraper.frontier.drained && !scraper.stopping,
    stopReason: scraper.stopReason,

    /**
     * Every count below describes **this session**. When a run resumed from a
     * checkpoint, what earlier sessions did is reported here instead of being
     * folded in — otherwise the rates and latencies would not match the counts.
     */
    resumed: scraper.resumedFrom
      ? {
          pages: scraper.resumedFrom.pagesOk ?? 0,
          items: scraper.resumedFrom.itemsWritten ?? 0,
          totalPages: (scraper.resumedFrom.pagesOk ?? 0) + counters.pagesOk,
          totalItems: (scraper.resumedFrom.itemsWritten ?? 0) + counters.itemsWritten,
        }
      : null,

    pages: {
      ok: counters.pagesOk,
      failed: counters.pagesFailed,
      skipped: counters.pagesSkipped,
      rendered: counters.pagesRendered,
      fromCache: counters.pagesFromCache,
      queuedRemaining: scraper.frontier.size,
      blockedByRobots: counters.robotsBlocked,
    },

    items: {
      extracted: counters.itemsExtracted,
      written: counters.itemsWritten,
      duplicates: counters.itemsDuplicate,
      invalid: counters.itemsInvalid,
    },

    rates: {
      ...snapshot.rates,
      pagesPerMinute: durationMs ? +((counters.pagesOk / durationMs) * 60_000).toFixed(1) : 0,
      itemsPerPage: counters.pagesOk ? +(counters.itemsExtracted / counters.pagesOk).toFixed(2) : 0,
    },

    fieldHealth,
    failures,
    hosts: snapshot.hosts,
    latency: snapshot.histograms.request_duration_ms ?? null,

    subsystems: {
      cache: scraper.cache.stats,
      dedupe: scraper.dedupe.stats,
      validation: scraper.validator.stats,
      robots: scraper.robots.stats,
      proxies: scraper.proxyPool.enabled ? scraper.proxyPool.snapshot() : null,
      circuits: scraper.circuitBreaker.snapshot().filter((c) => c.state !== 'closed' || c.failures > 0),
      rateLimiters: scraper.rateLimiter.snapshot(),
      renderer: scraper.renderer?.stats ?? null,
      captcha: scraper.captcha.stats,
      hooks: scraper.pipeline.stats,
    },

    outputs: Array.isArray(outputs) ? outputs.flat() : [outputs],
    warnings,
    counters: snapshot.counters,
  };
}

function groupFailures(failedMap) {
  const groups = new Map();
  for (const failure of failedMap.values()) {
    const key = failure.status ? `HTTP ${failure.status}` : (failure.code ?? 'UNKNOWN');
    let group = groups.get(key);
    if (!group) {
      group = { reason: key, count: 0, examples: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.examples.length < 3) {
      group.examples.push({ url: shortenUrl(failure.url, 90), error: failure.error });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

/** Render the report for a terminal. */
export function formatReport(report, { color = true } = {}) {
  const c = color ? C : Object.fromEntries(Object.keys(C).map((k) => [k, '']));
  const lines = [];
  const rule = '─'.repeat(60);

  lines.push('');
  lines.push(`${c.bold}${report.name}${c.reset} ${c.dim}finished in ${report.durationHuman}${c.reset}`);
  lines.push(c.dim + rule + c.reset);

  const statusColor = report.pages.failed === 0 ? c.green : report.pages.ok > 0 ? c.yellow : c.red;
  lines.push(
    `  Pages    ${statusColor}${report.pages.ok} ok${c.reset}` +
    `${report.pages.failed ? `, ${c.red}${report.pages.failed} failed${c.reset}` : ''}` +
    `${report.pages.skipped ? `, ${c.dim}${report.pages.skipped} skipped${c.reset}` : ''}` +
    `${report.pages.rendered ? `, ${c.dim}${report.pages.rendered} rendered${c.reset}` : ''}` +
    `${report.pages.fromCache ? `, ${c.dim}${report.pages.fromCache} cached${c.reset}` : ''}`,
  );
  lines.push(
    `  Items    ${c.bold}${report.items.written}${c.reset} written` +
    `${report.items.duplicates ? `, ${c.dim}${report.items.duplicates} duplicates${c.reset}` : ''}` +
    `${report.items.invalid ? `, ${c.yellow}${report.items.invalid} invalid${c.reset}` : ''}`,
  );
  lines.push(
    `  Speed    ${report.rates.pagesPerMinute} pages/min` +
    `${c.dim} · ${report.rates.itemsPerPage} items/page${c.reset}`,
  );
  if (report.latency) {
    lines.push(`  Latency  ${c.dim}p50 ${report.latency.p50}ms · p90 ${report.latency.p90}ms · max ${report.latency.max}ms${c.reset}`);
  }
  if (report.resumed) {
    lines.push(
      `  Resumed  ${c.dim}carried over ${report.resumed.pages} pages / ${report.resumed.items} items ` +
      `→ ${report.resumed.totalPages} pages, ${report.resumed.totalItems} items in total${c.reset}`,
    );
  }

  for (const output of report.outputs) {
    if (!output?.destination) continue;
    lines.push(`  Output   ${c.cyan}${output.destination}${c.reset} ${c.dim}(${output.format}, ${output.records} records)${c.reset}`);
  }

  const problemFields = report.fieldHealth.filter((f) => f.status !== 'ok');
  if (problemFields.length) {
    lines.push('');
    lines.push(`  ${c.bold}Field health${c.reset}`);
    for (const field of problemFields.slice(0, 10)) {
      const mark = field.status === 'broken' ? `${c.red}✗${c.reset}` : `${c.yellow}!${c.reset}`;
      lines.push(`    ${mark} ${field.field.padEnd(24)} ${field.fillRate}% filled ${c.dim}(${field.filled}/${field.attempts})${c.reset}`);
    }
  }

  if (report.failures.length) {
    lines.push('');
    lines.push(`  ${c.bold}Failures${c.reset}`);
    for (const group of report.failures.slice(0, 6)) {
      lines.push(`    ${c.red}${String(group.count).padStart(5)}${c.reset} × ${group.reason}`);
      lines.push(`          ${c.dim}${group.examples[0]?.url ?? ''}${c.reset}`);
    }
  }

  if (report.warnings.length) {
    lines.push('');
    lines.push(`  ${c.bold}${c.yellow}Warnings${c.reset}`);
    for (const warning of report.warnings.slice(0, 8)) {
      lines.push(`    ${c.yellow}!${c.reset} ${wrap(warning, 66, '      ')}`);
    }
  }

  lines.push(c.dim + rule + c.reset);
  lines.push('');
  return lines.join('\n');
}

function wrap(text, width, indent) {
  const words = String(text).split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${indent}`);
}
