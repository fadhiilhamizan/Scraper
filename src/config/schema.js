/**
 * Recipe normalisation and validation.
 *
 * Two jobs:
 *
 *  1. **Accept what people actually write.** YAML recipes use `snake_case`;
 *     JavaScript recipes use `camelCase`; both are accepted everywhere, along
 *     with a handful of natural aliases (`urls` for `start_urls`, `delay` for
 *     `min_delay_ms`). Normalisation happens once, here, so no other module has
 *     to think about it.
 *
 *  2. **Fail early, with a useful message.** A typo'd selector key or an
 *     unparseable XPath should be reported before the first request, naming the
 *     exact path in the recipe — not as a mysterious empty result set an hour
 *     into a crawl.
 */

import { ConfigError } from '../utils/errors.js';
import { DEFAULT_CONFIG, PRESETS } from './defaults.js';
import { validateXPath } from '../parse/xpath.js';
import { isXPathExpression } from '../parse/dom.js';
import { TRANSFORMS } from '../process/transforms.js';
import { FORMATS } from '../storage/index.js';

const snakeToCamel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Keys whose entire subtree is user data — never touched.
 * `headers` are HTTP header names, `meta`/`const`/`default`/`body` are opaque
 * payloads. Renaming anything in here would corrupt the user's data.
 */
const PRESERVE_SUBTREE = new Set(['headers', 'meta', 'const', 'default', 'body', 'query', 'params', 'cookieJar']);

/**
 * Keys whose *immediate children* are user-chosen names (output field names,
 * schema field names). The names stay verbatim; the objects beneath them are
 * ordinary config and get normalised.
 */
const PRESERVE_CHILD_NAMES = new Set(['fields', 'schema']);

/** Keys `extract` may legitimately contain; anything else is a route label. */
const EXTRACT_RESERVED = new Set(['item', 'fields', 'tables', 'jsonld', 'selector', 'scope', 'xpath']);

/** Aliases people reach for naturally. */
const ALIASES = {
  urls: 'startUrls',
  url: 'startUrls',
  start_url: 'startUrls',
  seeds: 'startUrls',
  delay: 'rateLimit.minDelayMs',
  rps: 'rateLimit.requestsPerSecond',
  workers: 'concurrency',
  limit: 'maxPages',
  outputs: 'output',
  format: 'output.format',
  selectors: 'extract.fields',
  fields: 'extract.fields',
  userAgent: 'identity.userAgent',
  proxies: 'proxy.urls',
  javascript: 'render.mode',
};

/**
 * Recursively convert `snake_case` recipe keys to `camelCase`, while leaving
 * user-chosen names alone.
 *
 * This distinction matters: `rate_limit` is ours to rename, but a field called
 * `in_stock` is the user's — silently emitting `inStock` in their CSV would be
 * a data bug, not a convenience.
 *
 * @param {any} value
 * @param {'normal'|'names'|'preserve'|'extract'} [mode]
 *   - `normal`   convert every key
 *   - `names`    keep this object's keys verbatim, normalise below them
 *   - `preserve` return the whole subtree untouched
 *   - `extract`  keep unknown keys (route labels) verbatim, normalise the rest
 */
export function normalizeKeys(value, mode = 'normal') {
  if (mode === 'preserve') return value;
  if (Array.isArray(value)) return value.map((v) => normalizeKeys(v, mode === 'names' ? 'normal' : mode));
  if (value == null || typeof value !== 'object' || value instanceof Date) return value;
  if (typeof value === 'function') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const isUserName =
      mode === 'names' ||
      (mode === 'extract' && !EXTRACT_RESERVED.has(key) && !EXTRACT_RESERVED.has(snakeToCamel(key)));

    const outKey = isUserName ? key : snakeToCamel(key);

    let childMode = 'normal';
    if (PRESERVE_SUBTREE.has(outKey)) childMode = 'preserve';
    else if (PRESERVE_CHILD_NAMES.has(outKey)) childMode = 'names';
    else if (outKey === 'extract') childMode = 'extract';
    // A route-label block inside `extract` is itself an extract block.
    else if (mode === 'extract' && isUserName) childMode = 'extract';

    out[outKey] = normalizeKeys(val, childMode);
  }
  return out;
}

/** Deep merge; arrays are replaced, not concatenated. */
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (override === null) return null;
  if (Array.isArray(override) || typeof override !== 'object') return override;
  if (base == null || typeof base !== 'object' || Array.isArray(base)) return { ...override };

  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] ??= {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/** Resolve top-level aliases into their canonical locations. */
function applyAliases(recipe) {
  const out = { ...recipe };
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!(alias in out)) continue;
    // Never let an alias clobber an explicitly-set canonical key.
    const [head] = target.split('.');
    if (target === head && head in out && head !== alias) {
      delete out[alias];
      continue;
    }
    const value = out[alias];
    delete out[alias];
    if (target === 'output.format') {
      out.output = Array.isArray(out.output) ? out.output : out.output ? [out.output] : [];
      if (out.output.length === 0) out.output = [{ format: value }];
      continue;
    }
    if (target === 'render.mode') {
      setPath(out, 'render.mode', value === true ? 'always' : value === false ? 'never' : value);
      continue;
    }
    setPath(out, target, value);
  }
  return out;
}

/**
 * Turn a raw recipe object into a complete, validated config.
 *
 * @param {object} raw
 * @param {object} [options]
 * @param {string[]} [options.presets]
 * @param {object} [options.overrides] Applied last (CLI flags).
 * @param {boolean}[options.strict=false] Reject unknown top-level keys.
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw, options = {}) {
  const { presets = [], overrides = {}, strict = false } = options;

  if (raw == null || typeof raw !== 'object') {
    throw new ConfigError('A recipe must be an object with at least `start_urls` and `extract`.');
  }

  const warnings = [];
  // A deep clone, not a merge: `coerce()` writes derived values (allowed
  // domains, effective limits) back into the config, and a shallow copy would
  // let those writes reach the shared DEFAULT_CONFIG and leak into every later
  // config built in this process.
  let config = structuredClone(DEFAULT_CONFIG);

  for (const preset of presets) {
    const values = PRESETS[preset];
    if (!values) {
      throw new ConfigError(
        `Unknown preset '${preset}'. Available: ${Object.keys(PRESETS).join(', ')}.`,
      );
    }
    config = deepMerge(config, structuredClone(values));
  }

  const normalized = applyAliases(normalizeKeys(raw));
  config = deepMerge(config, normalized);
  config = deepMerge(config, applyAliases(normalizeKeys(overrides)));

  if (strict) {
    for (const key of Object.keys(normalized)) {
      if (!(key in DEFAULT_CONFIG) && key !== 'hooks' && key !== 'transforms') {
        warnings.push(`Unknown recipe key '${key}' — it will be ignored. Did you mean one of: ${closestKeys(key).join(', ')}?`);
      }
    }
  }

  coerce(config, warnings);
  validateConfig(config);
  return { config, warnings };
}

/** Normalise loose value shapes into the canonical ones. */
function coerce(config, warnings) {
  // start_urls: allow a bare string.
  if (typeof config.startUrls === 'string') config.startUrls = [config.startUrls];
  if (!Array.isArray(config.startUrls)) config.startUrls = [];
  config.startUrls = config.startUrls
    .map((entry) => (typeof entry === 'string' ? { url: entry } : entry))
    .filter((entry) => entry && typeof entry.url === 'string');

  // output: allow a string or a single object.
  if (typeof config.output === 'string') config.output = [config.output];
  else if (config.output && !Array.isArray(config.output)) config.output = [config.output];
  config.output ??= [];

  // proxy: allow a bare list or a single URL.
  if (typeof config.proxy === 'string') config.proxy = { urls: [config.proxy] };
  else if (Array.isArray(config.proxy)) config.proxy = { urls: config.proxy };
  if (typeof config.proxy?.urls === 'string') config.proxy.urls = [config.proxy.urls];

  // render: allow `render: true` / `render: 'always'`.
  if (config.render === true) config.render = { ...DEFAULT_CONFIG.render, mode: 'always' };
  else if (config.render === false) config.render = { ...DEFAULT_CONFIG.render, mode: 'never' };
  else if (typeof config.render === 'string') config.render = { ...DEFAULT_CONFIG.render, mode: config.render };

  // cache: allow `cache: true`.
  if (config.cache === true) config.cache = { ...DEFAULT_CONFIG.cache, enabled: true };
  else if (config.cache === false) config.cache = { ...DEFAULT_CONFIG.cache, enabled: false };

  // resume: allow `resume: true`.
  if (config.resume === true) config.resume = { ...DEFAULT_CONFIG.resume, enabled: true };
  else if (config.resume === false) config.resume = { ...DEFAULT_CONFIG.resume, enabled: false };

  // crawl.follow: allow a bare selector string or a list of them.
  if (config.crawl) {
    if (typeof config.crawl.follow === 'string') config.crawl.follow = [{ selector: config.crawl.follow }];
    else if (Array.isArray(config.crawl.follow)) {
      config.crawl.follow = config.crawl.follow.map((f) => (typeof f === 'string' ? { selector: f } : f));
    } else if (!config.crawl.follow) {
      config.crawl.follow = [];
    }

    if (typeof config.crawl.pagination === 'string') {
      config.crawl.pagination = { selector: config.crawl.pagination };
    }
    for (const key of ['allowedDomains', 'allowPatterns', 'denyPatterns']) {
      if (typeof config.crawl[key] === 'string') config.crawl[key] = [config.crawl[key]];
      config.crawl[key] ??= [];
    }
  }

  // If no allowed domains were given, restrict the crawl to the seed hosts.
  // Silently crawling the whole web because a recipe omitted one key would be
  // both rude and expensive.
  if (config.crawl && config.crawl.allowedDomains.length === 0 && config.startUrls.length) {
    config.crawl.allowedDomains = [...new Set(
      config.startUrls.map((s) => {
        try {
          return new URL(s.url).hostname;
        } catch {
          return null;
        }
      }).filter(Boolean),
    )];
  }

  // `identity.mode: rotate` implies rotation is wanted even without profiles.
  if (config.identity?.userAgent && config.identity.mode === 'bot') {
    config.identity.mode = 'custom';
  }

  // maxPages of 0 means unlimited; represent that as Infinity internally.
  config.maxPagesEffective = config.maxPages > 0 ? config.maxPages : Infinity;
  config.maxItemsEffective = config.maxItems > 0 ? config.maxItems : Infinity;

  if (config.concurrencyPerHost > config.concurrency) {
    warnings.push(
      `concurrency_per_host (${config.concurrencyPerHost}) exceeds concurrency (${config.concurrency}); ` +
      'the global limit wins.',
    );
  }

  if (!config.robots.userAgent) {
    config.robots.userAgent = config.identity.userAgent ?? 'Harvester';
  }

  coerceRateLimit(config, warnings);
  warnOnAggressiveRate(config, warnings);
}

/**
 * Translate the retired absolute `jitter_ms` into the proportional
 * `jitter_ratio`.
 *
 * The conversion is `jitter_ms × rps / 1000`, which is exact: the old code slept
 * a flat `0..jitter_ms` on top of a `1000/rps` interval, so expressing it as a
 * fraction of that interval reproduces the same distribution. At the old
 * defaults (250 ms, 1 req/s) it yields exactly 0.25.
 */
function coerceRateLimit(config, warnings) {
  const rate = config.rateLimit;
  if (rate.jitterMs === undefined) return;

  const legacy = Number(rate.jitterMs);
  delete rate.jitterMs;
  if (!Number.isFinite(legacy) || legacy < 0) return;

  // An explicit jitter_ratio always wins over the legacy key.
  if (rate.jitterRatio !== undefined && rate.jitterRatio !== DEFAULT_CONFIG.rateLimit.jitterRatio) {
    warnings.push('Both `jitter_ms` and `jitter_ratio` were set — `jitter_ms` is ignored.');
    return;
  }

  const interval = Math.max(1000 / (rate.requestsPerSecond || 1), rate.minDelayMs || 0);
  rate.jitterRatio = Math.min(Math.max(legacy / interval, 0), 1);

  if (legacy !== 250 || rate.requestsPerSecond !== 1) {
    warnings.push(
      `\`rate_limit.jitter_ms: ${legacy}\` is deprecated and was converted to ` +
      `\`jitter_ratio: ${rate.jitterRatio.toFixed(3)}\`. Jitter is now a fraction of the ` +
      'request interval, so it no longer caps throughput at higher rates.',
    );
  }
}

/** Rates well above the polite default should be attributable, not anonymous. */
function warnOnAggressiveRate(config, warnings) {
  const declared = config.authorization?.basis && config.authorization.basis !== 'public';
  if (declared) return;

  const fast = config.rateLimit.requestsPerSecond > 4 || config.concurrencyPerHost > 4;
  if (!fast) return;

  warnings.push(
    `rate_limit.requests_per_second: ${config.rateLimit.requestsPerSecond} and ` +
    `concurrency_per_host: ${config.concurrencyPerHost} are well above the polite default. ` +
    'If you own this site or have permission, declare it with ' +
    '`authorization: { basis: owner }` — it is recorded in the run report. ' +
    'Otherwise lower them.',
  );
}

/** Hard validation — anything that reaches here throws. */
export function validateConfig(config) {
  const errors = [];

  if (config.startUrls.length === 0 && !config.sitemap) {
    errors.push('`start_urls` is empty — give the scraper at least one URL to begin from.');
  }

  for (const [i, seed] of config.startUrls.entries()) {
    try {
      const url = new URL(seed.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push(`start_urls[${i}]: only http and https are supported, got '${url.protocol}'.`);
      }
    } catch {
      errors.push(`start_urls[${i}]: '${seed.url}' is not a valid URL.`);
    }
  }

  if (!Number.isFinite(config.concurrency) || config.concurrency < 1) {
    errors.push('`concurrency` must be a positive number.');
  }
  if (config.rateLimit.requestsPerSecond <= 0) {
    errors.push('`rate_limit.requests_per_second` must be greater than 0.');
  }

  if (!['never', 'auto', 'always'].includes(config.render.mode)) {
    errors.push(`\`render.mode\` must be never, auto or always — got '${config.render.mode}'.`);
  }
  if (!['chromium', 'firefox', 'webkit'].includes(config.render.engine)) {
    errors.push(`\`render.engine\` must be chromium, firefox or webkit — got '${config.render.engine}'.`);
  }

  if (!['deny', 'allow'].includes(config.robots.onError)) {
    errors.push("`robots.on_error` must be 'deny' or 'allow'.");
  }

  const bases = ['public', 'owner', 'permission', 'api-terms'];
  if (config.authorization?.basis && !bases.includes(config.authorization.basis)) {
    errors.push(`\`authorization.basis\` must be one of: ${bases.join(', ')}.`);
  }

  const ratio = config.rateLimit.jitterRatio;
  if (ratio != null && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    errors.push('`rate_limit.jitter_ratio` must be between 0 and 1.');
  }

  if (!['warn', 'drop', 'quarantine', 'error'].includes(config.validate.onInvalid)) {
    errors.push("`validate.on_invalid` must be warn, drop, quarantine or error.");
  }

  if (!['record', 'fields', 'url'].includes(config.dedupe.strategy)) {
    errors.push("`dedupe.strategy` must be record, fields or url.");
  }
  if (config.dedupe.strategy === 'fields' && !config.dedupe.keyFields?.length) {
    errors.push("`dedupe.strategy: fields` requires `dedupe.key_fields`.");
  }

  for (const [i, spec] of config.output.entries()) {
    const format = typeof spec === 'string' ? null : spec?.format;
    if (format && !FORMATS[String(format).toLowerCase()]) {
      errors.push(`output[${i}]: unknown format '${format}'. Supported: ${Object.keys(FORMATS).join(', ')}.`);
    }
  }

  if (config.extract) errors.push(...validateExtract(config.extract, 'extract'));

  for (const [i, rule] of (config.crawl?.follow ?? []).entries()) {
    if (!rule.selector && !rule.xpath && !rule.pattern) {
      errors.push(`crawl.follow[${i}]: needs a \`selector\`, \`xpath\` or \`pattern\`.`);
    }
    if (rule.selector) errors.push(...validateSelector(rule.selector, `crawl.follow[${i}].selector`));
    if (rule.xpath) errors.push(...validateSelector(rule.xpath, `crawl.follow[${i}].xpath`, true));
  }

  if (config.crawl?.pagination) {
    const p = config.crawl.pagination;
    if (!p.selector && !p.xpath && !p.urlTemplate && !p.param) {
      errors.push('`crawl.pagination` needs one of: selector, xpath, url_template, param.');
    }
  }

  if (errors.length) {
    throw new ConfigError(
      `Your recipe has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n` +
      errors.map((e) => `  • ${e}`).join('\n'),
      { issues: errors },
    );
  }
  return true;
}

function validateSelector(selector, path, forceXPath = false) {
  const errors = [];
  if (typeof selector !== 'string' || selector.trim() === '') {
    errors.push(`${path}: selector must be a non-empty string.`);
    return errors;
  }
  if (forceXPath || isXPathExpression(selector)) {
    const expression = selector.startsWith('xpath:') ? selector.slice(6).trim() : selector;
    const { valid, error } = validateXPath(expression);
    if (!valid) errors.push(`${path}: invalid XPath — ${error}`);
  }
  return errors;
}

const VALID_SOURCES = new Set([
  'jsonld', 'microdata', 'meta', 'og', 'url', 'request', 'header', 'status',
  'json', 'text', 'html', 'meta_field',
]);

function validateExtract(extract, path) {
  const errors = [];

  if (typeof extract !== 'object' || Array.isArray(extract)) {
    errors.push(`${path}: must be a mapping.`);
    return errors;
  }

  // An `extract` block may instead be keyed by route label:
  //   extract:
  //     listing: { fields: {...} }
  //     detail:  { fields: {...} }
  const labelBlocks = Object.entries(extract).filter(
    ([key, value]) => !EXTRACT_RESERVED.has(key) && value && typeof value === 'object' && !Array.isArray(value),
  );
  const hasOwnSpec = extract.fields || extract.item || extract.tables || extract.jsonld;

  if (!hasOwnSpec && labelBlocks.length) {
    for (const [label, block] of labelBlocks) {
      errors.push(...validateExtract(block, `${path}.${label}`));
    }
    return errors;
  }

  const fields = extract.item?.fields ?? extract.fields;

  if (!fields && !extract.tables && !extract.jsonld) {
    errors.push(`${path}: needs \`fields\`, \`item.fields\`, \`tables\` or \`jsonld\`.`);
    return errors;
  }

  const containerSelector = extract.item?.selector ?? extract.selector;
  if (containerSelector) errors.push(...validateSelector(containerSelector, `${path}.item.selector`));

  if (fields) errors.push(...validateFields(fields, `${path}.fields`));
  return errors;
}

function validateFields(fields, path, depth = 0) {
  const errors = [];
  if (depth > 5) {
    errors.push(`${path}: nested fields are more than 5 levels deep.`);
    return errors;
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push(`${path}: must be a mapping of field name to definition.`);
    return errors;
  }

  for (const [name, rawSpec] of Object.entries(fields)) {
    const fieldPath = `${path}.${name}`;
    const spec = typeof rawSpec === 'string' ? { selector: rawSpec } : rawSpec;

    if (spec == null || typeof spec !== 'object') {
      errors.push(`${fieldPath}: must be a selector string or an object.`);
      continue;
    }

    // `attr` on its own, or an empty/`.` selector, means "this container
    // element" — the usual way to read `data-id` off the repeating element.
    const hasSource =
      spec.selector !== undefined || spec.xpath || spec.css || spec.from ||
      'const' in spec || spec.fields || spec.attr;
    if (!hasSource) {
      errors.push(
        `${fieldPath}: needs one of \`selector\`, \`xpath\`, \`from\`, \`const\`, or \`attr\` ` +
        '(use `attr` alone to read an attribute of the item container itself).',
      );
    }

    if (spec.from && !VALID_SOURCES.has(String(spec.from).toLowerCase())) {
      errors.push(
        `${fieldPath}: unknown \`from: ${spec.from}\`. Valid sources: ${[...VALID_SOURCES].join(', ')}.`,
      );
    }

    if (spec.selector) errors.push(...validateSelector(spec.selector, `${fieldPath}.selector`));
    if (spec.xpath) errors.push(...validateSelector(spec.xpath, `${fieldPath}.xpath`, true));

    if (spec.transform) {
      const chain = Array.isArray(spec.transform) ? spec.transform : [spec.transform];
      for (const entry of chain) {
        const transformName = typeof entry === 'string'
          ? entry.split(':')[0]
          : Array.isArray(entry) ? entry[0]
          : (entry && typeof entry === 'object' ? (entry.name ?? Object.keys(entry)[0]) : null);
        if (typeof entry === 'function') continue;
        if (!transformName || !(transformName in TRANSFORMS)) {
          errors.push(
            `${fieldPath}: unknown transform '${transformName}'. ` +
            `Run \`harvest transforms\` to list them all.`,
          );
        }
      }
    }

    if (spec.regex) {
      const pattern = typeof spec.regex === 'string' ? spec.regex : spec.regex.pattern;
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
      } catch (error) {
        errors.push(`${fieldPath}.regex: ${error.message}`);
      }
    }

    if (Array.isArray(spec.fallback)) {
      for (const [i, fb] of spec.fallback.entries()) {
        const fbSpec = typeof fb === 'string' ? { selector: fb } : fb;
        if (fbSpec?.selector) errors.push(...validateSelector(fbSpec.selector, `${fieldPath}.fallback[${i}]`));
        if (fbSpec?.xpath) errors.push(...validateSelector(fbSpec.xpath, `${fieldPath}.fallback[${i}].xpath`, true));
      }
    }

    if (spec.fields) errors.push(...validateFields(spec.fields, `${fieldPath}.fields`, depth + 1));
  }

  return errors;
}

/** Suggest likely intended keys for a typo, by edit distance. */
function closestKeys(key, limit = 3) {
  const candidates = Object.keys(DEFAULT_CONFIG);
  return candidates
    .map((c) => ({ c, d: editDistance(key.toLowerCase(), c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.c);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
