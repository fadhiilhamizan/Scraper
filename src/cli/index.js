/**
 * The `harvest` command-line interface.
 *
 * Design rule: every command works with no configuration beyond its arguments,
 * and every command that touches the network respects robots.txt unless you
 * explicitly opt out.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, formatOptions } from './args.js';
import { analyzePage, generateRecipe } from './inspect.js';
import { loadRecipe, defineRecipe, toYaml } from '../config/loader.js';
import { Scraper } from '../core/scraper.js';
import { formatReport } from '../core/report.js';
import { HttpClient } from '../http/client.js';
import { buildHeaders } from '../http/headers.js';
import { botUserAgent } from '../http/useragent.js';
import { RobotsManager } from '../compliance/robots.js';
import { Page } from '../parse/dom.js';
import { extractItems } from '../parse/extractor.js';
import { listTransforms, TRANSFORMS } from '../process/transforms.js';
import { HttpCache } from '../http/cache.js';
import { createLogger } from '../observability/logger.js';
import { PRESETS } from '../config/defaults.js';
import { ConfigError } from '../utils/errors.js';
import { TEMPLATES } from './templates.js';

const VERSION = '1.0.0';

const C = process.stdout.isTTY
  ? { b: '\x1b[1m', d: '\x1b[90m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' }
  : { b: '', d: '', g: '', y: '', r: '', c: '', x: '' };

const FLAG_SPEC = {
  flags: {
    // global
    help: 'boolean', version: 'boolean', verbose: 'boolean', quiet: 'boolean',
    json: 'boolean', color: 'boolean',
    // run
    output: 'array', format: 'string', limit: 'number', concurrency: 'number',
    rps: 'number', delay: 'number', depth: 'number', preset: 'array',
    render: 'optional', robots: 'boolean', proxy: 'array', proxyFile: 'string',
    resume: 'boolean', cache: 'boolean', dryRun: 'boolean', report: 'string',
    maxItems: 'number', timeout: 'number', printConfig: 'boolean', userAgent: 'string',
    contact: 'string', sitemap: 'boolean',
    // inspect / test
    recipe: 'string', generate: 'string', selector: 'string', field: 'array',
    label: 'string', save: 'string', screenshot: 'string', full: 'boolean',
    // init
    template: 'string', force: 'boolean',
  },
  aliases: {
    h: 'help', v: 'verbose', V: 'version', q: 'quiet', o: 'output', f: 'format',
    l: 'limit', c: 'concurrency', p: 'preset', r: 'recipe', n: 'limit',
  },
  // `--render` works bare (meaning `always`) or with an explicit mode.
  optionalValues: { render: ['never', 'auto', 'always'] },
};

/* ────────────────────────────────── help ───────────────────────────────── */

function mainHelp() {
  return `${C.b}harvest${C.x} — a modular web scraper  ${C.d}v${VERSION}${C.x}

${C.b}USAGE${C.x}
  harvest <command> [options]

${C.b}COMMANDS${C.x}
${formatOptions([
    ['run <recipe>', 'Run a scrape from a recipe file'],
    ['init [name]', 'Create a new recipe from a template'],
    ['inspect <url>', 'Analyse a page and suggest selectors'],
    ['test <recipe>', 'Fetch one page and show what would be extracted'],
    ['quick <url>', 'Ad-hoc scrape: --field name=selector'],
    ['validate <recipe>', 'Check a recipe without running it'],
    ['robots <url>', 'Show what robots.txt allows for a URL'],
    ['transforms', 'List every available transform'],
    ['cache <clear|prune>', 'Manage the HTTP response cache'],
  ])}

${C.b}GETTING STARTED${C.x}
  ${C.d}# 1. Look at the page and let harvest propose a recipe${C.x}
  harvest inspect https://books.toscrape.com --generate books.yaml

  ${C.d}# 2. Try it against a single page${C.x}
  harvest test books.yaml

  ${C.d}# 3. Run it${C.x}
  harvest run books.yaml -o books.csv

Run ${C.c}harvest <command> --help${C.x} for command-specific options.
Full documentation is in ./docs/.`;
}

const COMMAND_HELP = {
  run: `${C.b}harvest run <recipe>${C.x} — run a scrape

${C.b}OPTIONS${C.x}
${formatOptions([
    ['-o, --output <path>', 'Write here (repeatable). Format inferred from the extension.'],
    ['-f, --format <fmt>', 'json, ndjson, csv, tsv, xlsx, sqlite, console'],
    ['-l, --limit <n>', 'Stop after N pages'],
    ['    --max-items <n>', 'Stop after N records'],
    ['-c, --concurrency <n>', 'Parallel requests (default 4)'],
    ['    --rps <n>', 'Requests per second, per host (default 1)'],
    ['    --delay <ms>', 'Minimum delay between requests to a host'],
    ['    --depth <n>', 'Maximum crawl depth'],
    ['-p, --preset <name>', `Layer a preset: ${Object.keys(PRESETS).join(', ')}`],
    ['    --render <mode>', 'never | auto | always — use a headless browser'],
    ['    --proxy <url>', 'Proxy URL (repeatable)'],
    ['    --proxy-file <path>', 'File with one proxy per line'],
    ['    --no-robots', 'Skip robots.txt — you must have another basis for access'],
    ['    --cache', 'Cache HTTP responses (great while iterating)'],
    ['    --resume', 'Resume from a checkpoint, and checkpoint as you go'],
    ['    --dry-run', 'Do everything except write output'],
    ['    --report <path>', 'Write the JSON run report here'],
    ['    --print-config', 'Print the resolved config and exit'],
    ['-v, --verbose', 'Debug logging'],
    ['-q, --quiet', 'Errors only'],
    ['    --json', 'Machine-readable JSON logs'],
  ])}

${C.b}EXAMPLES${C.x}
  harvest run shop.yaml -o products.csv
  harvest run shop.yaml -o data.json -o data.xlsx --limit 100
  harvest run spa.yaml --render always --preset careful
  harvest run big.yaml --resume --cache --report run.json`,

  inspect: `${C.b}harvest inspect <url>${C.x} — analyse a page

Fetches a page and reports what it contains: structured data, repeated blocks
that look like records, candidate selectors, tables, and whether the content
needs JavaScript.

${C.b}OPTIONS${C.x}
${formatOptions([
    ['    --render', 'Render with a headless browser first'],
    ['    --generate <path>', 'Write a starter recipe to this file'],
    ['    --save <path>', 'Save the fetched HTML'],
    ['    --json', 'Output the analysis as JSON'],
    ['    --full', 'Show every repeated block, not just the top ones'],
    ['    --no-robots', 'Skip the robots.txt check'],
  ])}

${C.b}EXAMPLE${C.x}
  harvest inspect https://books.toscrape.com --generate books.yaml`,

  test: `${C.b}harvest test <recipe> [url]${C.x} — dry-run the extraction on one page

Fetches a single page and prints the records your recipe would produce, plus a
per-field diagnostic showing which selectors matched. Nothing is written and no
crawling happens.

${C.b}OPTIONS${C.x}
${formatOptions([
    ['    --label <name>', 'Test the extract block for this route label'],
    ['    --render', 'Render with a headless browser'],
    ['    --json', 'Output records as JSON'],
    ['    --save <path>', 'Save the fetched HTML for offline iteration'],
  ])}

${C.b}EXAMPLE${C.x}
  harvest test books.yaml
  harvest test books.yaml https://books.toscrape.com/catalogue/page-2.html`,

  quick: `${C.b}harvest quick <url>${C.x} — scrape without a recipe

${C.b}OPTIONS${C.x}
${formatOptions([
    ['    --field <name=selector>', 'Field to extract (repeatable)'],
    ['    --selector <css>', 'Container selector for repeated items'],
    ['    --render', 'Render with a headless browser'],
    ['-o, --output <path>', 'Write to a file instead of stdout'],
  ])}

${C.b}EXAMPLE${C.x}
  harvest quick https://news.ycombinator.com \\
    --selector ".athing" --field "title=.titleline a" --field "url=.titleline a@href"`,

  init: `${C.b}harvest init [name]${C.x} — create a recipe from a template

${C.b}OPTIONS${C.x}
${formatOptions([
    ['    --template <name>', `One of: ${Object.keys(TEMPLATES).join(', ')}`],
    ['    --force', 'Overwrite an existing file'],
  ])}`,
};

/* ──────────────────────────────── commands ─────────────────────────────── */

async function cmdRun(positional, flags) {
  const recipePath = positional[0];
  if (!recipePath) throw new ConfigError('Which recipe? Usage: harvest run <recipe.yaml>');

  const overrides = buildOverrides(flags);
  const { config, warnings, hooks, source } = await loadRecipe(recipePath, {
    presets: flags.preset ?? [],
    overrides,
  });

  if (flags.printConfig) {
    process.stdout.write(toYaml(config));
    return 0;
  }

  if (flags.dryRun) {
    config.output = [{ format: 'none' }];
    config.resume = { ...config.resume, enabled: false };
  }

  const logger = createLogger({
    level: flags.quiet ? 'error' : flags.verbose ? 'debug' : config.logging.level,
    format: flags.json ? 'json' : config.logging.format,
  });

  for (const warning of warnings) logger.warn(warning);
  logger.debug('recipe loaded', { source });

  if (config.output.length === 0 && !flags.dryRun) {
    logger.warn('No output configured — records will be printed to stdout. Use -o to write a file.');
    config.output = [{ format: 'console', mode: 'ndjson' }];
  }

  const scraper = new Scraper(config, { hooks, logger });
  installSignalHandlers(scraper, logger);

  const report = await scraper.run();

  if (flags.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(formatReport(report, { color: !!C.b }));

  // Non-zero exit when nothing was produced but work was attempted — this is
  // what makes `harvest run` usable in a cron job or CI pipeline.
  if (report.items.written === 0 && report.pages.ok > 0 && config.extract) return 2;
  if (report.pages.ok === 0 && report.pages.failed > 0) return 1;
  return 0;
}

async function cmdInspect(positional, flags) {
  const url = positional[0];
  if (!url) throw new ConfigError('Which URL? Usage: harvest inspect <url>');

  const logger = createLogger({ level: flags.verbose ? 'debug' : 'warn' });
  const client = new HttpClient({ timeoutMs: flags.timeout ?? 30_000 });
  const userAgent = flags.userAgent ?? botUserAgent({ contact: flags.contact });

  try {
    let robotsVerdict = null;
    if (flags.robots !== false) {
      const robots = new RobotsManager({ httpClient: client, userAgent, logger });
      robotsVerdict = await robots.check(url);
      if (!robotsVerdict.allowed) {
        process.stderr.write(
          `${C.r}robots.txt disallows this URL${C.x} (rule: ${robotsVerdict.reason})\n` +
          `Pass ${C.c}--no-robots${C.x} only if you have another basis for access.\n`,
        );
        return 1;
      }
    }

    const rendered = flags.render !== undefined && flags.render !== 'never';

    // Always fetch over plain HTTP. When rendering too, this second copy is
    // what lets us *measure* whether JavaScript is required instead of guessing.
    const response = await client.request({
      url,
      headers: buildHeaders({ url, baseHeaders: { 'user-agent': userAgent } }),
      throwOnError: false,
    });
    const staticHtml = response.body;
    let html = staticHtml;

    if (rendered) {
      const { Renderer } = await import('../render/renderer.js');
      const renderer = new Renderer({ logger });
      try {
        const result = await renderer.render({
          url,
          waitUntil: 'networkidle',
          waitForTimeout: 500,
          contextOptions: { userAgent },
        });
        html = result.html;
      } finally {
        await renderer.close();
      }
    }

    if (flags.save) {
      await fs.writeFile(flags.save, html, 'utf8');
      process.stderr.write(`${C.d}HTML saved to ${flags.save}${C.x}\n`);
    }

    const analysis = analyzePage({
      html, url, response, robotsVerdict, rendered,
      staticHtml: rendered ? staticHtml : null,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    } else {
      process.stdout.write(renderAnalysis(analysis, flags));
    }

    if (flags.generate) {
      const recipe = generateRecipe(analysis, {
        name: path.basename(flags.generate, path.extname(flags.generate)),
        output: `output/${path.basename(flags.generate, path.extname(flags.generate))}.csv`,
      });
      const note = recipe._note;
      delete recipe._note;
      const yaml =
        `# Generated by \`harvest inspect ${url}\`\n` +
        `# Review these selectors before running at scale — they are inferred, not verified.\n` +
        (note ? `# ${note}\n` : '') +
        '\n' + toYaml(recipe);
      await fs.writeFile(flags.generate, yaml, 'utf8');
      process.stdout.write(
        `\n${C.g}✓${C.x} Recipe written to ${C.b}${flags.generate}${C.x}\n` +
        `  Next: ${C.c}harvest test ${flags.generate}${C.x}\n`,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function cmdTest(positional, flags) {
  const recipePath = positional[0];
  if (!recipePath) throw new ConfigError('Which recipe? Usage: harvest test <recipe.yaml> [url]');

  const { config } = await loadRecipe(recipePath, { presets: flags.preset ?? [] });
  const url = positional[1] ?? config.startUrls[0]?.url;
  if (!url) throw new ConfigError('No URL to test — the recipe has no `start_urls` and none was given.');

  const logger = createLogger({ level: flags.verbose ? 'debug' : 'warn' });
  const client = new HttpClient(config.http);
  const userAgent = config.identity.userAgent ?? botUserAgent({ contact: config.identity.contact });

  try {
    if (config.robots.enabled && flags.robots !== false) {
      const robots = new RobotsManager({ httpClient: client, userAgent, logger });
      const verdict = await robots.check(url);
      if (!verdict.allowed) {
        process.stderr.write(`${C.r}robots.txt disallows ${url}${C.x} (rule: ${verdict.reason})\n`);
        return 1;
      }
    }

    const shouldRender = flags.render !== undefined ? flags.render !== 'never' : config.render.mode === 'always';
    let html;
    let response = null;

    if (shouldRender) {
      const { Renderer } = await import('../render/renderer.js');
      const renderer = new Renderer({ ...config.render, logger });
      try {
        const result = await renderer.render({
          url,
          waitUntil: config.render.waitUntil,
          waitForSelector: config.render.waitForSelector,
          scroll: config.render.scroll,
          actions: config.render.actions,
          contextOptions: { userAgent },
        });
        html = result.html;
      } finally {
        await renderer.close();
      }
    } else {
      response = await client.request({
        url,
        headers: buildHeaders({ url, profile: null, baseHeaders: { 'user-agent': userAgent, ...config.http.headers } }),
        throwOnError: false,
      });
      html = response.body;
      if (response.status >= 400) {
        process.stderr.write(`${C.y}Server returned HTTP ${response.status}${C.x}\n`);
      }
    }

    if (flags.save) await fs.writeFile(flags.save, html, 'utf8');

    const page = new Page({ html, url, response });
    const label = flags.label ?? config.startUrls[0]?.label ?? 'default';
    const extractSpec = config.extract?.[label]?.fields || config.extract?.[label]?.item
      ? config.extract[label]
      : config.extract;

    if (!extractSpec) throw new ConfigError('This recipe has no `extract` block.');

    const result = extractItems(extractSpec, page, { response });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result.items, null, 2)}\n`);
      return result.items.length ? 0 : 2;
    }

    process.stdout.write(renderTestResult(result, extractSpec, page, url));
    return result.items.length ? 0 : 2;
  } finally {
    await client.close();
  }
}

async function cmdQuick(positional, flags) {
  const url = positional[0];
  if (!url) throw new ConfigError('Which URL? Usage: harvest quick <url> --field name=selector');
  if (!flags.field?.length) {
    throw new ConfigError(
      'No fields given. Example:\n' +
      '  harvest quick https://example.com --field "title=h1" --field "link=a@href"',
    );
  }

  const fields = {};
  for (const entry of flags.field) {
    const eq = entry.indexOf('=');
    if (eq === -1) throw new ConfigError(`--field must be name=selector, got '${entry}'`);
    const name = entry.slice(0, eq).trim();
    let selector = entry.slice(eq + 1).trim();
    // `a@href` is a compact way to say "the href attribute of a".
    const at = selector.lastIndexOf('@');
    const spec = { selector, transform: ['clean'] };
    if (at > 0 && !selector.startsWith('//')) {
      spec.selector = selector.slice(0, at).trim();
      spec.attr = selector.slice(at + 1).trim();
      delete spec.transform;
      // A bare `/product/1` is rarely what anyone wants out of `href`.
      if (['href', 'src', 'data-src', 'data-href'].includes(spec.attr)) spec.type = 'url';
    }
    fields[name] = spec;
  }

  const { config } = defineRecipe({
    start_urls: [url],
    max_pages: 1,
    render: flags.render !== undefined && flags.render !== 'never' ? { mode: 'always' } : undefined,
    robots: { enabled: flags.robots !== false },
    extract: flags.selector ? { item: { selector: flags.selector, fields } } : { fields },
    output: flags.output?.length ? flags.output : [{ format: 'console', mode: 'json' }],
    logging: { progress: false, level: flags.verbose ? 'debug' : 'warn' },
  });

  const scraper = new Scraper(config, { logger: createLogger({ level: flags.verbose ? 'debug' : 'warn' }) });
  const report = await scraper.run();
  if (report.items.written === 0) {
    process.stderr.write(`${C.y}No records matched. Try ${C.c}harvest inspect ${url}${C.y} to find selectors.${C.x}\n`);
    return 2;
  }
  return 0;
}

async function cmdValidate(positional, flags) {
  const recipePath = positional[0];
  if (!recipePath) throw new ConfigError('Which recipe? Usage: harvest validate <recipe.yaml>');

  const { config, warnings } = await loadRecipe(recipePath, { presets: flags.preset ?? [] });

  process.stdout.write(`${C.g}✓${C.x} ${recipePath} is valid\n\n`);
  process.stdout.write(`  Start URLs     ${config.startUrls.length}\n`);
  process.stdout.write(`  Concurrency    ${config.concurrency} (${config.concurrencyPerHost}/host)\n`);
  process.stdout.write(`  Rate limit     ${config.rateLimit.requestsPerSecond}/s per host\n`);
  process.stdout.write(`  robots.txt     ${config.robots.enabled ? `${C.g}enforced${C.x}` : `${C.r}DISABLED${C.x}`}\n`);
  process.stdout.write(`  Rendering      ${config.render.mode}\n`);
  process.stdout.write(`  Max pages      ${config.maxPages || 'unlimited'}\n`);
  const fields = config.extract?.item?.fields ?? config.extract?.fields;
  if (fields) process.stdout.write(`  Fields         ${Object.keys(fields).join(', ')}\n`);
  process.stdout.write(`  Outputs        ${config.output.map((o) => (typeof o === 'string' ? o : o.path ?? o.format)).join(', ') || 'none'}\n`);

  if (warnings.length) {
    process.stdout.write(`\n${C.y}Warnings${C.x}\n`);
    for (const warning of warnings) process.stdout.write(`  ! ${warning}\n`);
  }
  return 0;
}

async function cmdRobots(positional, flags) {
  const url = positional[0];
  if (!url) throw new ConfigError('Which URL? Usage: harvest robots <url>');

  const client = new HttpClient();
  const userAgent = flags.userAgent ?? botUserAgent({ contact: flags.contact });
  try {
    const manager = new RobotsManager({ httpClient: client, userAgent });
    const verdict = await manager.check(url);
    const delay = await manager.crawlDelayFor(url);
    const sitemaps = await manager.sitemapsFor(url);

    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ url, userAgent, ...verdict, crawlDelay: delay, sitemaps }, null, 2)}\n`);
      return verdict.allowed ? 0 : 1;
    }

    process.stdout.write(`\n  URL          ${url}\n`);
    process.stdout.write(`  User-agent   ${C.d}${userAgent}${C.x}\n`);
    process.stdout.write(`  Verdict      ${verdict.allowed ? `${C.g}allowed${C.x}` : `${C.r}disallowed${C.x}`}\n`);
    process.stdout.write(`  Matched      ${verdict.reason}\n`);
    process.stdout.write(`  Crawl-delay  ${delay != null ? `${delay}s` : `${C.d}not specified${C.x}`}\n`);
    if (sitemaps.length) {
      process.stdout.write(`  Sitemaps     ${sitemaps.join('\n               ')}\n`);
    }
    process.stdout.write('\n');
    return verdict.allowed ? 0 : 1;
  } finally {
    await client.close();
  }
}

async function cmdInit(positional, flags) {
  const name = positional[0] ?? 'scraper';
  const templateName = flags.template ?? 'basic';
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new ConfigError(
      `Unknown template '${templateName}'. Available: ${Object.keys(TEMPLATES).join(', ')}.`,
    );
  }

  const file = name.endsWith('.yaml') || name.endsWith('.yml') ? name : `${name}.yaml`;
  let exists = true;
  try {
    await fs.access(file);
  } catch {
    exists = false;
  }
  if (exists && !flags.force) {
    throw new ConfigError(`${file} already exists. Pass --force to overwrite.`);
  }

  await fs.writeFile(file, template.replace(/\{\{name\}\}/g, path.basename(file, path.extname(file))), 'utf8');
  process.stdout.write(
    `${C.g}✓${C.x} Created ${C.b}${file}${C.x} ${C.d}(${templateName} template)${C.x}\n\n` +
    `  1. Edit ${file} — set start_urls and the fields you want\n` +
    `  2. ${C.c}harvest test ${file}${C.x}   ${C.d}# check the selectors${C.x}\n` +
    `  3. ${C.c}harvest run ${file}${C.x}    ${C.d}# run it${C.x}\n\n` +
    `  ${C.d}Tip: \`harvest inspect <url> --generate ${file}\` writes the selectors for you.${C.x}\n`,
  );
  return 0;
}

async function cmdTransforms(positional, flags) {
  const names = listTransforms();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(names, null, 2)}\n`);
    return 0;
  }

  const groups = {
    'Text & whitespace': ['trim', 'collapse', 'normalizeSpace', 'squeeze', 'lower', 'upper', 'capitalize', 'title', 'slug', 'padStart'],
    'Cleaning': ['clean', 'stripTags', 'decodeEntities', 'stripNonPrintable', 'stripEmoji', 'normalizeUnicode'],
    'Numbers': ['number', 'int', 'float', 'round', 'currency', 'currencyCode', 'price', 'percent'],
    'Dates': ['date', 'dateOnly', 'dateEU', 'timestamp'],
    'Booleans': ['boolean', 'test'],
    'Strings': ['replace', 'remove', 'extract', 'extractAll', 'split', 'join', 'prefix', 'suffix', 'truncate'],
    'Extraction': ['email', 'phone', 'digits', 'urlPath', 'domain', 'queryParam'],
    'Arrays': ['first', 'last', 'nth', 'unique', 'compact', 'sort', 'count', 'slice'],
    'Structural': ['json', 'toString', 'default', 'nullIfEmpty'],
  };

  process.stdout.write(`\n${C.b}Available transforms${C.x} ${C.d}(${names.length} total)${C.x}\n`);
  const listed = new Set();
  for (const [group, items] of Object.entries(groups)) {
    const present = items.filter((n) => n in TRANSFORMS);
    if (!present.length) continue;
    process.stdout.write(`\n  ${C.c}${group}${C.x}\n    ${present.join(', ')}\n`);
    for (const n of present) listed.add(n);
  }
  const other = names.filter((n) => !listed.has(n));
  if (other.length) process.stdout.write(`\n  ${C.c}Other${C.x}\n    ${other.join(', ')}\n`);

  process.stdout.write(
    `\n${C.d}Use them in a recipe:${C.x}\n` +
    `  price:\n    selector: ".price"\n    transform: [clean, currency]   ${C.d}# "\$1,299.00" -> 1299${C.x}\n` +
    `  posted:\n    selector: "time"\n    transform: ["date:day"]         ${C.d}# "3 days ago" -> "2026-07-28"${C.x}\n\n`,
  );
  return 0;
}

async function cmdCache(positional) {
  const action = positional[0];
  const cache = new HttpCache({ enabled: true });

  if (action === 'clear') {
    await cache.clear();
    process.stdout.write(`${C.g}✓${C.x} Cache cleared (${cache.dir})\n`);
    return 0;
  }
  if (action === 'prune') {
    const removed = await cache.prune();
    process.stdout.write(`${C.g}✓${C.x} Removed ${removed} expired entr${removed === 1 ? 'y' : 'ies'}\n`);
    return 0;
  }
  process.stderr.write('Usage: harvest cache <clear|prune>\n');
  return 1;
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

function renderAnalysis(a, flags) {
  const out = [];
  const line = (label, value) => out.push(`  ${label.padEnd(16)}${value}`);

  out.push(`\n${C.b}${a.title || '(no title)'}${C.x}`);
  out.push(`${C.d}${a.url}${C.x}\n`);

  line('Status', `${a.status}  ${C.d}${(a.bytes / 1024).toFixed(1)} KB${a.rendered ? ', rendered' : ''}${C.x}`);
  const jsLabel = a.javaScriptMeasured ? 'measured' : 'heuristic';
  line('JavaScript', a.needsJavaScript
    ? `${C.y}required${C.x} ${C.d}(${jsLabel}: ${a.javaScriptReason}) — use render.mode: auto${C.x}`
    : `${C.g}not needed${C.x} ${C.d}(${jsLabel}: ${a.javaScriptReason})${C.x}`);
  if (a.robots) {
    line('robots.txt', a.robots.allowed ? `${C.g}allowed${C.x}` : `${C.r}disallowed${C.x}`);
    if (a.robots.crawlDelay != null) line('Crawl-delay', `${a.robots.crawlDelay}s`);
  }
  line('Links', `${a.links.total} ${C.d}(${a.links.internal} internal)${C.x}`);

  const sd = a.structuredData;
  if (sd.hasStructuredData || sd.openGraph.length) {
    out.push(`\n  ${C.b}Structured data${C.x} ${C.d}— prefer this over CSS: it survives redesigns${C.x}`);
    for (const block of sd.jsonLd) {
      out.push(`    ${C.g}JSON-LD${C.x}  ${C.b}${block.type}${C.x} ${C.d}${block.keys.join(', ')}${C.x}`);
    }
    for (const block of sd.microdata) {
      out.push(`    ${C.g}Microdata${C.x} ${C.b}${block.type}${C.x} ${C.d}${block.keys.join(', ')}${C.x}`);
    }
    if (sd.openGraph.length) out.push(`    ${C.g}OpenGraph${C.x} ${C.d}${sd.openGraph.join(', ')}${C.x}`);
  }

  if (a.tables.length) {
    out.push(`\n  ${C.b}Tables${C.x} ${C.d}— extract them all with \`extract: { tables: true }\`${C.x}`);
    for (const t of a.tables.slice(0, 5)) {
      out.push(`    [${t.index}] ${t.rows} rows  ${C.d}${t.headers.join(' | ').slice(0, 80)}${C.x}`);
    }
  }

  if (a.repeatedBlocks.length) {
    out.push(`\n  ${C.b}Repeated blocks${C.x} ${C.d}— candidates for \`item.selector\`${C.x}`);
    const shown = flags.full ? a.repeatedBlocks : a.repeatedBlocks.slice(0, 4);
    for (const [i, block] of shown.entries()) {
      const mark = i === 0 ? `${C.g}→${C.x}` : ' ';
      out.push(`  ${mark} ${C.c}${block.selector}${C.x}  ${C.d}×${block.count} (score ${block.score})${C.x}`);
      if (block.sampleText) out.push(`      ${C.d}"${block.sampleText.slice(0, 70)}${block.sampleText.length > 70 ? '…' : ''}"${C.x}`);
    }
  }

  const fields = a.suggestions.itemSelector ? a.suggestions.listFields : a.suggestions.detailFields;
  if (Object.keys(fields).length) {
    out.push(`\n  ${C.b}Suggested fields${C.x}`);
    for (const [name, spec] of Object.entries(fields)) {
      const extra = [spec.attr ? `@${spec.attr}` : null, spec.transform ? `→ ${[].concat(spec.transform).join(', ')}` : null]
        .filter(Boolean).join(' ');
      out.push(`    ${name.padEnd(14)}${C.c}${spec.selector}${C.x} ${C.d}${extra}${C.x}`);
    }
  }

  if (a.pagination) {
    out.push(`\n  ${C.b}Pagination${C.x}`);
    out.push(`    Next page found via ${C.c}${a.pagination.detectedBy}${C.x}`);
    out.push(`    ${C.d}${a.pagination.url}${C.x}`);
  }

  if (!flags.generate) {
    out.push(`\n  ${C.d}Generate a recipe from this: ${C.c}harvest inspect ${a.url} --generate my.yaml${C.x}`);
  }
  out.push('');
  return out.join('\n');
}

function renderTestResult(result, extractSpec, page, url) {
  const out = [];
  const fields = extractSpec.item?.fields ?? extractSpec.fields ?? {};
  const containerSelector = extractSpec.item?.selector ?? extractSpec.selector;

  out.push(`\n${C.b}${page.title() || url}${C.x}`);
  out.push(`${C.d}${url}${C.x}\n`);

  if (containerSelector) {
    const matched = result.stats.containers ?? 0;
    const mark = matched > 0 ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`;
    out.push(`  ${mark} item.selector ${C.c}${containerSelector}${C.x} matched ${C.b}${matched}${C.x} element(s)`);
    if (matched === 0) {
      out.push(`    ${C.y}Nothing matched. Run ${C.c}harvest inspect ${url}${C.y} to find the right container.${C.x}`);
    }
    out.push('');
  }

  // Per-field fill rate across the extracted records.
  if (Object.keys(fields).length && result.items.length) {
    out.push(`  ${C.b}Field coverage${C.x} ${C.d}across ${result.items.length} record(s)${C.x}`);
    for (const name of Object.keys(fields)) {
      const filled = result.items.filter((item) => {
        const v = item[name];
        return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      }).length;
      const rate = Math.round((filled / result.items.length) * 100);
      const mark = rate === 0 ? `${C.r}✗${C.x}` : rate < 50 ? `${C.y}!${C.x}` : `${C.g}✓${C.x}`;
      const bar = '█'.repeat(Math.round(rate / 10)).padEnd(10, '░');
      out.push(`    ${mark} ${name.padEnd(18)}${C.d}${bar}${C.x} ${String(rate).padStart(3)}%  ${C.d}${filled}/${result.items.length}${C.x}`);
    }
    out.push('');
  }

  if (result.issues.length) {
    out.push(`  ${C.y}Issues${C.x}`);
    for (const issue of [...new Set(result.issues)].slice(0, 8)) out.push(`    ! ${issue}`);
    out.push('');
  }

  if (result.items.length === 0) {
    out.push(`  ${C.r}No records extracted.${C.x}`);
    out.push(`  ${C.d}Try: harvest inspect ${url}${C.x}\n`);
    return out.join('\n');
  }

  out.push(`  ${C.b}Sample records${C.x} ${C.d}(showing ${Math.min(3, result.items.length)} of ${result.items.length})${C.x}`);
  for (const item of result.items.slice(0, 3)) {
    out.push(`  ${C.d}${'─'.repeat(56)}${C.x}`);
    for (const [key, value] of Object.entries(item)) {
      const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
      out.push(`    ${key.padEnd(16)}${rendered.slice(0, 70)}${rendered.length > 70 ? `${C.d}…${C.x}` : ''}`);
    }
  }
  out.push('');
  out.push(`  ${C.g}✓${C.x} Looks good? Run it: ${C.c}harvest run <recipe> -o data.csv${C.x}\n`);
  return out.join('\n');
}

/* ──────────────────────────────── plumbing ─────────────────────────────── */

/** Translate CLI flags into a config override object. */
function buildOverrides(flags) {
  const overrides = {};

  if (flags.output?.length) overrides.output = flags.output;
  if (flags.format) {
    overrides.output = (overrides.output ?? []).map((o) =>
      (typeof o === 'string' ? { path: o, format: flags.format } : { ...o, format: flags.format }));
    if (!overrides.output.length) overrides.output = [{ format: flags.format }];
  }
  if (flags.limit != null) overrides.maxPages = flags.limit;
  if (flags.maxItems != null) overrides.maxItems = flags.maxItems;
  if (flags.concurrency != null) overrides.concurrency = flags.concurrency;
  if (flags.timeout != null) overrides.http = { timeoutMs: flags.timeout };
  if (flags.rps != null) overrides.rateLimit = { ...overrides.rateLimit, requestsPerSecond: flags.rps };
  if (flags.delay != null) overrides.rateLimit = { ...overrides.rateLimit, minDelayMs: flags.delay };
  if (flags.depth != null) overrides.crawl = { maxDepth: flags.depth };
  // `--render` bare parses as `true`, meaning "always".
  if (flags.render !== undefined) {
    overrides.render = { mode: flags.render === true ? 'always' : flags.render };
  }
  if (flags.robots === false) overrides.robots = { enabled: false };
  if (flags.proxy?.length) overrides.proxy = { urls: flags.proxy };
  if (flags.proxyFile) overrides.proxy = { ...overrides.proxy, file: flags.proxyFile };
  if (flags.cache) overrides.cache = { enabled: true };
  if (flags.resume) overrides.resume = { enabled: true };
  if (flags.report) overrides.report = flags.report;
  if (flags.sitemap) overrides.sitemap = true;
  if (flags.userAgent) overrides.identity = { userAgent: flags.userAgent };
  if (flags.contact) overrides.identity = { ...overrides.identity, contact: flags.contact };
  if (flags.verbose) overrides.logging = { level: 'debug' };
  if (flags.quiet) overrides.logging = { ...overrides.logging, level: 'error', progress: false };
  if (flags.json) overrides.logging = { ...overrides.logging, format: 'json', progress: false };

  return overrides;
}

function installSignalHandlers(scraper, logger) {
  let attempts = 0;
  const onSignal = () => {
    attempts += 1;
    if (attempts === 1) {
      logger.warn('interrupt received — finishing in-flight requests, press Ctrl+C again to force quit');
      scraper.stop('interrupted by user');
    } else {
      logger.error('forced exit — in-flight work is lost');
      scraper.abort('forced exit');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

const COMMANDS = {
  run: cmdRun,
  init: cmdInit,
  inspect: cmdInspect,
  test: cmdTest,
  quick: cmdQuick,
  validate: cmdValidate,
  robots: cmdRobots,
  transforms: cmdTransforms,
  cache: cmdCache,
};

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv, FLAG_SPEC);
  } catch (error) {
    process.stderr.write(`${C.r}${error.message}${C.x}\n`);
    return 64;
  }

  const { command, positional, flags, unknown } = parsed;

  if (flags.version) {
    process.stdout.write(`harvest ${VERSION}\n`);
    return 0;
  }
  if (!command || command === 'help') {
    const topic = positional[0];
    process.stdout.write(`${topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : mainHelp()}\n`);
    return 0;
  }
  if (flags.help) {
    process.stdout.write(`${COMMAND_HELP[command] ?? mainHelp()}\n`);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    const suggestion = Object.keys(COMMANDS).find((c) => c.startsWith(command[0]));
    process.stderr.write(
      `${C.r}Unknown command '${command}'${C.x}` +
      `${suggestion ? ` — did you mean ${C.c}${suggestion}${C.x}?` : ''}\n` +
      `Run ${C.c}harvest help${C.x} to see the available commands.\n`,
    );
    return 64;
  }

  if (unknown.length) {
    process.stderr.write(`${C.y}Ignoring unknown option(s): ${unknown.join(', ')}${C.x}\n`);
  }

  try {
    return await handler(positional, flags);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${C.r}${error.message}${C.x}\n\n`);
      return 78;
    }
    process.stderr.write(`\n${C.r}${error.name}: ${error.message}${C.x}\n`);
    if (flags.verbose && error.stack) process.stderr.write(`${C.d}${error.stack}${C.x}\n`);
    else process.stderr.write(`${C.d}Run with --verbose for a stack trace.${C.x}\n`);
    return 1;
  }
}
