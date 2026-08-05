/**
 * The field extraction engine.
 *
 * Turns a declarative `fields` map into records. The design goal is that a
 * non-programmer can describe *what* they want without describing *how* to get
 * it, and that the description survives a site redesign more often than a
 * hand-written selector would.
 *
 * Three features do most of that work:
 *
 *  - **`fallback` chains.** A field can list several strategies; the first that
 *    yields a value wins. Pair a fragile CSS selector with a JSON-LD lookup and
 *    the field keeps working when the markup changes.
 *  - **Non-DOM sources.** `from: jsonld | microdata | meta | og | url | header`
 *    reads structured data that redesigns rarely touch.
 *  - **Typed coercion.** `type:` runs after transforms and reports a problem
 *    rather than silently emitting `NaN` or `"undefined"`.
 */

import { applyTransforms } from '../process/transforms.js';
import { resolveUrl } from '../queue/urlutils.js';
import { evaluate as evaluateXPath, stringValue as xpathStringValue, isAttribute } from './xpath.js';
import { isXPathExpression } from './dom.js';

/**
 * Read a dotted path out of a plain object.
 * Supports `a.b`, `a[0].b`, and `a.*.b` (which maps over an array).
 */
export function getByPath(source, path) {
  if (source == null || !path) return source;
  const segments = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s !== '');

  let current = source;
  for (let i = 0; i < segments.length; i += 1) {
    if (current == null) return undefined;
    const segment = segments[i];

    if (segment === '*') {
      const rest = segments.slice(i + 1).join('.');
      const list = Array.isArray(current) ? current : Object.values(current);
      return rest ? list.map((item) => getByPath(item, rest)).filter((v) => v !== undefined) : list;
    }

    // Reaching into an array without an index takes the first element, which
    // is what people mean by `offers.price` when `offers` is a one-item array.
    if (Array.isArray(current) && !/^\d+$/.test(segment)) {
      current = current[0];
      if (current == null) return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Pull a value off a matched element according to `attr`. */
function readFromElement($, el, attr) {
  if (!el) return null;
  const $el = $(el);

  switch (attr) {
    case undefined:
    case null:
    case 'text':
      return $el.text();
    case 'html':
    case 'innerHTML':
      return $el.html() ?? '';
    case 'outerHTML':
    case 'outerHtml':
      return $.html($el);
    case 'value':
      return $el.attr('value') ?? $el.val() ?? null;
    case 'textContent':
      return $el.text();
    default: {
      const name = attr.startsWith('@') ? attr.slice(1) : attr;
      const value = $el.attr(name);
      return value === undefined ? null : value;
    }
  }
}

/**
 * Resolve one strategy (a field spec without its fallbacks) to a raw value.
 * @returns {any} raw value, array of raw values when `all` is set, or null.
 */
function resolveRaw(spec, ctx) {
  const { page, element, request, response } = ctx;
  const $ = page.$;

  // 1. Literal value.
  if ('const' in spec) return spec.const;

  // 2. Non-DOM sources.
  if (spec.from) {
    const source = String(spec.from).toLowerCase();

    switch (source) {
      case 'url':
        return spec.path ? getByPath({ url: page.url }, spec.path) : page.url;
      case 'request':
        return spec.path ? getByPath(request ?? {}, spec.path) : request?.url ?? null;
      case 'meta':
        return spec.path ? page.metaTags()[String(spec.path).toLowerCase()] ?? null : page.metaTags();
      case 'og': {
        const og = page.openGraph();
        return spec.path ? og[String(spec.path).replace(/^og:/, '')] ?? null : og;
      }
      case 'header':
        return spec.path ? response?.headers?.[String(spec.path).toLowerCase()] ?? null : response?.headers ?? null;
      case 'status':
        return response?.status ?? null;
      case 'meta_field':
        return getByPath(request?.meta ?? {}, spec.path);
      case 'jsonld': {
        // `entity` filters by schema.org @type. It is deliberately *not*
        // `type`, which already means the field's output type.
        const blocks = spec.entity ? page.jsonLdOfType(spec.entity) : page.jsonLd();
        if (!spec.path) return spec.all ? blocks : blocks[0] ?? null;
        if (spec.all) {
          return blocks.map((b) => getByPath(b, spec.path)).filter((v) => v !== undefined && v !== null);
        }
        for (const block of blocks) {
          const value = getByPath(block, spec.path);
          if (value !== undefined && value !== null) return value;
        }
        return null;
      }
      case 'microdata': {
        const items = page.microdata();
        const filtered = spec.entity
          ? items.filter((i) => String(i['@type'] ?? '').toLowerCase() === String(spec.entity).toLowerCase())
          : items;
        if (!spec.path) return spec.all ? filtered : filtered[0] ?? null;
        if (spec.all) return filtered.map((i) => getByPath(i, spec.path)).filter((v) => v != null);
        for (const item of filtered) {
          const value = getByPath(item, spec.path);
          if (value != null) return value;
        }
        return null;
      }
      case 'json': {
        // The whole response body parsed as JSON — for scraping a site's API.
        // Memoised on the page, not on `ctx`: the context is rebuilt by spread
        // for every container, so a per-context memo re-parsed the entire body
        // once per record.
        const parsed = page.json();
        return spec.path ? getByPath(parsed, spec.path) : parsed;
      }
      case 'text':
        return page.text(spec.selector ?? 'body');
      case 'html':
        return page.html;
      default:
        throw new Error(`Unknown field source 'from: ${spec.from}'`);
    }
  }

  // 3. DOM selection.
  const rawSelector = spec.selector ?? spec.css ?? spec.xpath;
  const selector = typeof rawSelector === 'string' ? rawSelector.trim() : rawSelector;

  // The container itself. `data-id` lives on the repeating element far more
  // often than on a child, so this needs to be expressible:
  //   id: { attr: data-id }        or        id: { selector: ".", attr: data-id }
  const isSelfReference = !selector || selector === '.' || selector === '&' || selector === ':scope';
  if (isSelfReference) {
    const self = element ? (element[0] ?? element) : $('html').get(0);
    if (!self) return null;
    return readFromElement($, self, spec.attr);
  }

  const useXPath = spec.xpath != null || isXPathExpression(selector);

  if (useXPath) {
    const expression = spec.xpath ?? selector;
    const query = expression.startsWith('xpath:') ? expression.slice(6).trim() : expression;
    const contextNode = element ? (element[0] ?? element) : page.root;
    const result = evaluateXPath(query, contextNode);

    // An expression like `count(//a)` or `normalize-space(//h1)` evaluates to a
    // primitive rather than a node-set — return it as-is.
    if (!Array.isArray(result)) return spec.all ? [result] : result;
    const nodes = result;

    const read = (node) => {
      if (isAttribute(node)) return node.value;
      // An explicit `attr` still applies when XPath returned elements.
      if (spec.attr && node.type === 'tag') return readFromElement($, node, spec.attr);
      return xpathStringValue(node);
    };

    if (spec.all) return nodes.map(read);
    return nodes.length ? read(nodes[0]) : null;
  }

  const selection = element ? $(element).find(selector) : $(selector);
  if (selection.length === 0) return spec.all ? [] : null;

  if (spec.all) return selection.toArray().map((el) => readFromElement($, el, spec.attr));
  return readFromElement($, selection.get(0), spec.attr);
}

/** Apply a `regex` spec to a value (or every element of an array). */
function applyRegex(value, regexSpec) {
  if (value == null || !regexSpec) return value;

  const pattern = typeof regexSpec === 'string' ? regexSpec : regexSpec.pattern;
  const group = typeof regexSpec === 'string' ? 1 : regexSpec.group ?? 1;
  const flags = typeof regexSpec === 'string' ? '' : regexSpec.flags ?? '';
  if (!pattern) return value;

  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Invalid regex '${pattern}': ${error.message}`);
  }

  const extract = (input) => {
    const match = String(input).match(re);
    if (!match) return null;
    // Group 1 by default, but fall back to the whole match for patterns
    // without a capture group.
    return match[group] ?? match[0] ?? null;
  };

  return Array.isArray(value) ? value.map(extract).filter((v) => v != null) : extract(value);
}

/** Coerce to the declared type. Returns `{ value, error }`. */
function coerceType(value, type, ctx) {
  if (value == null || !type) return { value, error: null };

  const one = (input) => {
    switch (String(type).toLowerCase()) {
      case 'string':
        return { value: typeof input === 'string' ? input : String(input), error: null };
      case 'number':
      case 'float': {
        const n = typeof input === 'number' ? input : Number(input);
        return Number.isFinite(n) ? { value: n, error: null } : { value: null, error: `not a number: ${JSON.stringify(input)}` };
      }
      case 'integer':
      case 'int': {
        const n = typeof input === 'number' ? input : Number(input);
        return Number.isFinite(n) ? { value: Math.trunc(n), error: null } : { value: null, error: `not an integer: ${JSON.stringify(input)}` };
      }
      case 'boolean':
      case 'bool':
        return { value: Boolean(input), error: null };
      case 'url': {
        const resolved = resolveUrl(String(input), ctx.page.baseUrl);
        return resolved ? { value: resolved, error: null } : { value: null, error: `not a URL: ${JSON.stringify(input)}` };
      }
      case 'email': {
        const s = String(input).trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
          ? { value: s.toLowerCase(), error: null }
          : { value: null, error: `not an email: ${JSON.stringify(input)}` };
      }
      case 'date': {
        const s = String(input);
        const parsed = Date.parse(s);
        return Number.isFinite(parsed)
          ? { value: new Date(parsed).toISOString(), error: null }
          : { value: null, error: `not a date: ${JSON.stringify(input)}` };
      }
      case 'object':
      case 'array':
      case 'any':
        return { value: input, error: null };
      default:
        return { value: input, error: null };
    }
  };

  if (Array.isArray(value)) {
    const results = value.map(one);
    return {
      value: results.filter((r) => r.error === null).map((r) => r.value),
      error: results.find((r) => r.error)?.error ?? null,
    };
  }
  return one(value);
}

const isEmpty = (v) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Extract a single field.
 * @returns {{value:any, issues:string[], strategy:number}}
 */
export function extractField(name, fieldSpec, ctx) {
  const spec = typeof fieldSpec === 'string'
    ? { selector: fieldSpec }              // shorthand: `title: "h1"`
    : fieldSpec;

  const issues = [];

  // A `when` guard lets a field only apply to certain pages.
  if (spec.when) {
    const condition = typeof spec.when === 'string' ? { selector: spec.when } : spec.when;
    const present = condition.selector ? ctx.page.exists(condition.selector, ctx.element) : true;
    const wanted = condition.exists !== false;
    if (present !== wanted) return { value: spec.default ?? null, issues, strategy: -1 };
  }

  // Try the primary strategy, then each fallback in order.
  const strategies = [spec, ...(spec.fallback ?? []).map((f) => (typeof f === 'string' ? { selector: f } : f))];

  // A fallback replaces the *source* entirely — inheriting `from: jsonld` into
  // a fallback that specifies a `selector` would make the fallback a no-op,
  // which defeats the whole point of the chain. Only presentation carries over.
  const inherited = {};
  for (const key of ['transform', 'type', 'default', 'required', 'all', 'keepEmpty', 'when']) {
    if (key in spec) inherited[key] = spec[key];
  }

  let value = null;
  let strategyIndex = -1;

  for (let i = 0; i < strategies.length; i += 1) {
    const strategy = i === 0
      ? { ...spec, fallback: undefined }
      : { ...inherited, ...strategies[i], fallback: undefined };
    let raw;
    try {
      raw = resolveRaw(strategy, ctx);
    } catch (error) {
      issues.push(`${name}: ${error.message}`);
      continue;
    }

    if (strategy.regex) {
      try {
        raw = applyRegex(raw, strategy.regex);
      } catch (error) {
        issues.push(`${name}: ${error.message}`);
        continue;
      }
    }

    // Nested object / list of objects.
    if (strategy.fields) {
      const containers = strategy.selector
        ? ctx.page.select(strategy.selector, ctx.element).toArray()
        : [ctx.element ?? null];
      const children = containers.map((container) => {
        const { record } = extractRecord(strategy.fields, {
          ...ctx,
          element: container ? ctx.page.$(container) : ctx.element,
        });
        return record;
      });
      raw = strategy.all ? children : children[0] ?? null;
    }

    if (strategy.transform) {
      try {
        raw = applyTransforms(raw, strategy.transform, ctx);
      } catch (error) {
        issues.push(`${name}: ${error.message}`);
        continue;
      }
    }

    if (!isEmpty(raw)) {
      value = raw;
      strategyIndex = i;
      break;
    }
    value = raw;
  }

  if (isEmpty(value) && spec.default !== undefined) {
    return { value: spec.default, issues, strategy: -1 };
  }

  if (spec.type) {
    const coerced = coerceType(value, spec.type, ctx);
    if (coerced.error && !isEmpty(value)) issues.push(`${name}: ${coerced.error}`);
    value = coerced.value ?? (spec.default !== undefined ? spec.default : null);
  }

  if (spec.required && isEmpty(value)) {
    issues.push(`${name}: required field is missing`);
  }

  return { value, issues, strategy: strategyIndex };
}

/**
 * Extract every field in a spec map into one record.
 * @returns {{record:object, issues:string[], fieldsFound:number, fieldsTotal:number}}
 */
export function extractRecord(fields, ctx) {
  const record = {};
  const issues = [];
  let found = 0;
  let total = 0;

  for (const [name, spec] of Object.entries(fields ?? {})) {
    total += 1;
    const result = extractField(name, spec, ctx);
    issues.push(...result.issues);
    if (!isEmpty(result.value)) found += 1;
    // Omit empty optional fields entirely rather than writing nulls everywhere.
    const keepNulls = typeof spec === 'object' && spec?.keepEmpty === true;
    if (!isEmpty(result.value) || keepNulls || (typeof spec === 'object' && spec?.default !== undefined)) {
      record[name] = result.value;
    }
  }

  return { record, issues, fieldsFound: found, fieldsTotal: total };
}

/**
 * Run an `extract` block against a page, producing zero or more records.
 *
 * @param {object} extractSpec  The recipe's `extract` section.
 * @param {import('./dom.js').Page} page
 * @param {object} [context]    `{ request, response }`
 * @returns {{items:object[], issues:string[], stats:object}}
 */
export function extractItems(extractSpec, page, context = {}) {
  const issues = [];
  const items = [];

  if (!extractSpec) return { items, issues, stats: { containers: 0 } };

  const baseCtx = {
    page,
    element: null,
    request: context.request ?? null,
    response: context.response ?? null,
    json: undefined,
  };

  // Shortcut: `extract: { tables: true }`
  if (extractSpec.tables) {
    const selector = typeof extractSpec.tables === 'string' ? extractSpec.tables : 'table';
    for (const table of page.tables(selector)) {
      for (const row of table.records) items.push(row);
    }
  }

  // Shortcut: `extract: { jsonld: 'Product' }`
  if (extractSpec.jsonld) {
    const blocks = typeof extractSpec.jsonld === 'string'
      ? page.jsonLdOfType(extractSpec.jsonld)
      : page.jsonLd();
    items.push(...blocks);
  }

  const itemSpec = extractSpec.item ?? null;
  const fields = itemSpec?.fields ?? extractSpec.fields ?? null;

  if (fields) {
    const containerSelector = itemSpec?.selector ?? extractSpec.selector ?? null;

    if (containerSelector) {
      const containers = page.select(containerSelector).toArray();
      if (containers.length === 0) {
        issues.push(`No elements matched the item selector '${containerSelector}'`);
      }
      let fieldsFoundTotal = 0;
      let fieldsTotal = 0;
      for (const container of containers) {
        const result = extractRecord(fields, { ...baseCtx, element: page.$(container) });
        issues.push(...result.issues);
        fieldsFoundTotal += result.fieldsFound;
        fieldsTotal += result.fieldsTotal;
        if (Object.keys(result.record).length > 0) items.push(result.record);
      }
      return {
        items,
        issues,
        stats: {
          containers: containers.length,
          fieldFillRate: fieldsTotal ? +((fieldsFoundTotal / fieldsTotal) * 100).toFixed(1) : 0,
        },
      };
    }

    const result = extractRecord(fields, baseCtx);
    issues.push(...result.issues);
    if (Object.keys(result.record).length > 0) items.push(result.record);
    return {
      items,
      issues,
      stats: {
        containers: 1,
        fieldFillRate: result.fieldsTotal ? +((result.fieldsFound / result.fieldsTotal) * 100).toFixed(1) : 0,
      },
    };
  }

  return { items, issues, stats: { containers: items.length } };
}
