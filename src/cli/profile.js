/**
 * `harvest profile` — where is the time going, and what would actually help?
 *
 * Throughput complaints nearly always have one of four causes, and they produce
 * indistinguishable numbers while needing opposite fixes:
 *
 *   1. the configured politeness budget (working exactly as intended),
 *   2. a robots.txt `Crawl-delay` overriding that budget entirely,
 *   3. headless rendering at ~1.5 s/page,
 *   4. one request per record, when the listing page already had the data.
 *
 * Guessing between them wastes days. This measures instead.
 */

import { Scraper } from '../core/scraper.js';
import { formatDuration } from '../core/report.js';
import { nullLogger } from '../observability/logger.js';

const C = process.stdout.isTTY
  ? { b: '\x1b[1m', d: '\x1b[90m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' }
  : { b: '', d: '', g: '', y: '', r: '', c: '', x: '' };

/**
 * The pacing a config implies, before any network contact.
 * @returns {{intervalMs:number, rps:number, perHostCeiling:number}}
 */
export function predictPacing(config) {
  const rate = config.rateLimit;
  const nominal = Math.max(1000 / rate.requestsPerSecond, rate.minDelayMs || 0);
  const ratio = Math.min(Math.max(rate.jitterRatio ?? 0, 0), 1);
  const meanJitter = Math.min(nominal * ratio, rate.maxJitterMs ?? 2000) / 2;
  const intervalMs = nominal + meanJitter;

  // Requests to one host are also capped by how many can be in flight at once
  // divided by the round trip; without a measurement we can only report the
  // pacing limit, which is the one that binds on a polite config.
  return {
    intervalMs,
    rps: +(1000 / intervalMs).toFixed(3),
    perHostCeiling: +(1000 / intervalMs).toFixed(3),
  };
}

/** Project how long `targetRecords` will take at an observed pace. */
export function project({ recordsPerSecond, targetRecords }) {
  if (!recordsPerSecond || recordsPerSecond <= 0) return null;
  return Math.round((targetRecords / recordsPerSecond) * 1000);
}

const line = (label, value, note) =>
  `  ${label.padEnd(22)}${String(value).padEnd(10)}${note ? `${C.d}${note}${C.x}` : ''}`;

/** Arithmetic only — no requests are made. */
export function renderDryProfile(config, { targetRecords = 1000 } = {}) {
  const pacing = predictPacing(config);
  const out = [];
  const hosts = new Set(config.startUrls.map((s) => {
    try {
      return new URL(s.url).hostname;
    } catch {
      return null;
    }
  }).filter(Boolean));
  const singleHost = hosts.size <= 1;

  out.push('');
  out.push(`${C.b}Predicted ceiling for '${config.name}'${C.x} ${C.d}(from config alone — no requests made)${C.x}`);
  out.push('');
  out.push(line('requests_per_second', config.rateLimit.requestsPerSecond,
    `→ ${Math.round(1000 / config.rateLimit.requestsPerSecond)} ms between requests, per host`));
  out.push(line('jitter_ratio', config.rateLimit.jitterRatio ?? 0,
    `→ +${Math.round((pacing.intervalMs - Math.max(1000 / config.rateLimit.requestsPerSecond, config.rateLimit.minDelayMs || 0)))} ms mean`));
  if (config.rateLimit.minDelayMs) out.push(line('min_delay_ms', config.rateLimit.minDelayMs));
  out.push(line('burst', config.rateLimit.burst));
  out.push(line('concurrency', config.concurrency,
    singleHost ? '← see the note below' : ''));
  out.push(line('concurrency_per_host', config.concurrencyPerHost));
  out.push(line('render.mode', config.render.mode,
    config.render.mode !== 'never' ? '← a browser costs ~1-3 s/page' : ''));
  out.push('');
  out.push(`  ${C.b}⇒ ${pacing.rps} requests/second${C.x} per host`);

  // The most common misunderstanding in the whole design, stated plainly.
  if (singleHost && config.concurrency > config.concurrencyPerHost) {
    out.push('');
    out.push(`  ${C.y}Note${C.x} the rate limit is ${C.b}per host${C.x}, and all your start URLs are on one host.`);
    out.push(`  ${config.concurrency} workers on a single host still get ${pacing.rps} req/s between them —`);
    out.push(`  ${config.concurrency - config.concurrencyPerHost} of them will simply sit idle. Raising \`concurrency\` cannot help here;`);
    out.push('  raising `requests_per_second` is the only lever, and only if you may.');
  }

  out.push('');
  out.push(`  ${C.d}Not accounted for — only a real run can measure these:${C.x}`);
  out.push(`  ${C.d}  robots.txt Crawl-delay${C.x} — fetched at run time, and it ${C.b}overrides the above${C.x}`);
  out.push(`  ${C.d}  network latency · rendering · retries · requests per record${C.x}`);
  out.push('');
  out.push(`  Run ${C.c}harvest profile <recipe>${C.x} ${C.d}(without --dry)${C.x} to measure them.`);
  out.push('');
  void targetRecords;
  return out.join('\n');
}

/** Turn a completed sample run into a diagnosis and a prescription. */
export function renderMeasuredProfile(report, config, { targetRecords = 1000, faster = null } = {}) {
  const out = [];
  const timing = report.timing;
  const perRecord = report.efficiency?.requestsPerRecord;

  const elapsedSec = Math.max(report.durationMs / 1000, 0.001);
  const recordsPerSecond = report.items.written / elapsedSec;
  const projectedMs = project({ recordsPerSecond, targetRecords });

  out.push('');
  out.push(`${C.b}Measured over ${report.pages.ok} page${report.pages.ok === 1 ? '' : 's'}${C.x} `
    + `${C.d}(${report.items.written} records in ${formatDuration(report.durationMs)})${C.x}`);

  if (projectedMs) {
    out.push('');
    out.push(`  ${C.b}Projection${C.x}  ${targetRecords} records ≈ ${C.b}${formatDuration(projectedMs)}${C.x} at this pace.`);
  }

  // What to change, ranked by what would actually move the number.
  //
  // Idle time is deliberately folded into the rate-limit share rather than
  // reported on its own. Workers sit idle *because* the per-host limiter is the
  // constraint — reporting "55% idle" as the headline sends people to tune
  // `concurrency`, which is the one knob that cannot help.
  const advice = [];
  const buckets = timing?.buckets ?? {};
  const pct = (name) => buckets[name]?.pct ?? 0;
  const pacedPct = pct('rateLimitWait') + pct('idle');
  const crawlDelayHost = (report.pacing ?? []).find((h) => h.crawlDelayBinding);

  if (crawlDelayHost) {
    advice.push(
      `${C.y}robots.txt sets the pace here.${C.x} ${crawlDelayHost.host} publishes ` +
      `Crawl-delay: ${crawlDelayHost.crawlDelayMs / 1000}s, which overrides ` +
      '`requests_per_second` entirely — changing that number will do nothing. ' +
      'Honour it, or, if the site is yours, set `robots.ignore_crawl_delay: true`.',
    );
  } else if (pct('render') > 30) {
    advice.push(
      `${Math.round(pct('render'))}% of worker time is headless rendering. Look for a ` +
      'JSON endpoint behind the page (browser Network tab, filter XHR) — calling it ' +
      'directly is routinely 10-50x faster and far lighter on the site. Failing that, ' +
      '`render.mode: auto` with `wait_for_selector` skips the browser on pages that don\'t need it.',
    );
  } else if (pacedPct > 30) {
    advice.push(
      `${Math.round(pacedPct)}% of worker time is the politeness budget you configured ` +
      `(${Math.round(pct('rateLimitWait'))}% waiting, ${Math.round(pct('idle'))}% idle because the ` +
      'per-host limit leaves spare workers nothing to do). ' +
      'If you own this site or have permission, raising `rate_limit.requests_per_second` ' +
      'is the only lever. Otherwise this run is correctly paced, and the time it takes ' +
      'is the right answer.',
    );

    if (faster) {
      const speedup = faster.rps / predictPacing(config).rps;
      if (speedup > 1.5) {
        const scaled = projectedMs ? projectedMs / speedup : 0;
        advice.push(
          `${C.b}--preset ${faster.name}${C.x} would give ${faster.rps} req/s here ` +
          `(${speedup.toFixed(1)}x), putting ${targetRecords} records at ≈${formatDuration(scaled)}.`,
        );
      } else {
        // Presets layer *under* the recipe, so a recipe that pins these values
        // silently wins. Saying so beats letting someone try it and see nothing.
        advice.push(
          `${C.y}Note${C.x} \`--preset ${faster.name}\` would barely change this: your recipe sets ` +
          '`rate_limit`/`concurrency` explicitly, and a preset layers *under* the recipe. ' +
          'Edit the recipe instead.',
        );
      }
    }
  }

  if (perRecord != null && perRecord >= 2) {
    advice.push(
      `${C.b}${perRecord} requests per record.${C.x} If the listing page already carries the ` +
      'fields you need, dropping the detail fetch would be roughly ' +
      `${Math.round(perRecord)}x faster — and asks the site for ` +
      `${Math.round(100 - 100 / perRecord)}% less. This is usually the biggest win available.`,
    );
  }

  const throttled = (report.pacing ?? []).filter((h) => h.throttleEvents > 0);
  for (const host of throttled) {
    advice.push(
      `${host.host} throttled you ${host.throttleEvents}x and the adaptive limiter ` +
      `dropped to ${host.rate}/s. Set \`requests_per_second\` at or below that rather ` +
      'than making the limiter fight for it every run.',
    );
  }

  if (advice.length) {
    out.push('');
    out.push(`  ${C.b}What would actually help${C.x}`);
    for (const item of advice) out.push(`    ${C.g}▸${C.x} ${wrapText(item, 74, '      ')}`);
  } else {
    out.push('');
    out.push(`  ${C.g}Nothing obviously wasteful${C.x} — the time is going where you'd expect.`);
  }

  out.push('');
  return out.join('\n');
}

function wrapText(text, width, indent) {
  const words = String(text).split(' ');
  const lines = [];
  let current = '';
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  for (const word of words) {
    if (visible(current) + visible(word) + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${indent}`);
}

/**
 * Run a bounded sample of a recipe with output disabled.
 * @returns {Promise<object>} the run report
 */
export async function sampleRun(config, { pages = 25 } = {}) {
  const sampled = {
    ...config,
    maxPages: pages,
    maxPagesEffective: pages,
    output: [{ format: 'none' }],
    resume: { ...config.resume, enabled: false },
    report: null,
    logging: { ...config.logging, progress: false, level: 'error' },
  };
  return new Scraper(sampled, { logger: nullLogger }).run();
}
