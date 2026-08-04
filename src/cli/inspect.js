/**
 * Page analysis: work out what a page contains and how to scrape it.
 *
 * This is the answer to the slowest part of writing a scraper — sitting in dev
 * tools guessing selectors. It fetches a page and reports:
 *
 *   - whether the content needs JavaScript,
 *   - what structured data is already published (JSON-LD, microdata, OpenGraph),
 *   - which repeated blocks look like a list of records, with a selector for each,
 *   - candidate field selectors inside the best-scoring block,
 *   - pagination links.
 *
 * `--generate` turns all of that into a working recipe file.
 */

import { Page } from '../parse/dom.js';
import { autoDetectNextPage } from '../parse/pagination.js';
import { needsRendering } from '../render/renderer.js';
import { parseCurrency } from '../process/transforms.js';

/** Prefixes used by CSS-in-JS libraries; everything after them is a build hash. */
const HASH_PREFIX = /^(?:css|sc|jsx|svelte|emotion)-/i;

/**
 * Class names that describe layout rather than meaning.
 *
 * Deliberately excludes `item`, `card`, `row` and `box`: those look generic but
 * are very often the real record container (`.item`, `.product-card`), and
 * discarding them was losing the best candidate on plenty of sites.
 */
const GENERIC_CLASS = /^(?:col(?:-\w+)*|container|wrapper|inner|outer|content|flex|grid|clearfix|d-\w+|m[trblxy]?-\d+|p[trblxy]?-\d+|w-\d+|h-\d+|text-\w+|bg-\w+|justify-\w+|items-\w+)$/;

/**
 * Does this token look like a generated hash rather than a word?
 *
 * The digit requirement is what keeps ordinary names safe: `price_color` and
 * `product_pod` are structurally identical to `Button_a1b2c` without it, and
 * discarding them throws away the best selectors on plenty of sites.
 */
function looksLikeHash(token) {
  return (
    token.length >= 4 &&
    /^[a-z0-9]+$/i.test(token) &&
    /\d/.test(token) &&
    !/^\d+$/.test(token)
  );
}

/** Is this class name worth building a selector on? */
function isStableClass(name) {
  if (!name || name.length <= 1) return false;
  if (GENERIC_CLASS.test(name)) return false;
  if (HASH_PREFIX.test(name)) return false;
  if (looksLikeHash(name)) return false;

  // CSS modules: `Block_element__hash`, `Block_hash`, `_hash`.
  if (name.includes('_')) {
    const segments = name.split(/_+/).filter(Boolean);
    if (segments.length && looksLikeHash(segments[segments.length - 1])) return false;
  }
  return true;
}

/** A structural fingerprint used to spot repeated siblings. */
function signature($, el) {
  const $el = $(el);
  const tag = el.name;
  const classes = ($el.attr('class') ?? '')
    .split(/\s+/)
    .filter(isStableClass)
    .sort()
    .join('.');
  const itemtype = $el.attr('itemtype') ? '[itemscope]' : '';
  const testId = $el.attr('data-testid') ?? $el.attr('data-test') ?? '';
  return `${tag}${classes ? `.${classes}` : ''}${itemtype}${testId ? `[data-testid]` : ''}`;
}

/** Build the most robust selector we can for an element. */
export function buildSelector($, el, { scoped = false } = {}) {
  const $el = $(el);

  const id = $el.attr('id');
  if (id && !/\d{4,}/.test(id) && isStableClass(id)) return `#${CSS_escape(id)}`;

  const testId = $el.attr('data-testid') ?? $el.attr('data-test') ?? $el.attr('data-qa');
  if (testId) return `[data-testid="${testId}"]`;

  const itemprop = $el.attr('itemprop');
  if (itemprop) return `[itemprop="${itemprop}"]`;

  const classes = ($el.attr('class') ?? '').split(/\s+/).filter(isStableClass);
  if (classes.length) {
    // One good class is usually more durable than three chained ones.
    return `${scoped ? '' : el.name}.${classes.slice(0, 2).map(CSS_escape).join('.')}`;
  }

  const role = $el.attr('role');
  if (role) return `${el.name}[role="${role}"]`;

  return el.name;
}

function CSS_escape(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}

/**
 * Produce a selector that actually resolves to `el` **first** within
 * `container`.
 *
 * `buildSelector` alone often returns something too generic — a product card
 * with an image link and a title link both reduce to `a`, and extraction takes
 * the first match, so half the suggested fields would silently come back empty.
 * This qualifies the selector until it unambiguously points at the element we
 * chose, and verifies each candidate before returning it.
 *
 * @param {*} $ cheerio instance
 * @param {*} el target element
 * @param {*} container cheerio selection to scope within (may be the body)
 * @param {string} [attr] the attribute the field will read, if any
 * @returns {string}
 */
function refineSelector($, el, container, attr = null) {
  const scoped = true;
  const base = buildSelector($, el, { scoped });

  /** Does `selector` pick `el` as its first match inside the container? */
  const resolves = (selector) => {
    try {
      return container.find(selector).get(0) === el;
    } catch {
      return false;
    }
  };

  if (resolves(base)) return base;

  // Qualify by the attribute we're about to read — `a[title]` cleanly
  // distinguishes a title link from a bare image link.
  if (attr && attr !== 'text' && $(el).attr(attr) != null) {
    const qualified = `${base}[${attr}]`;
    if (resolves(qualified)) return qualified;
  }

  // Walk up, prefixing ancestors: `h3 a`, then `.card h3 a`.
  let node = el.parent;
  let prefix = '';
  for (let depth = 0; depth < 3 && node && node.type === 'tag'; depth += 1) {
    const parentSelector = buildSelector($, node, { scoped });
    prefix = prefix ? `${parentSelector} ${prefix}` : parentSelector;
    const candidate = `${prefix} ${base}`;
    if (resolves(candidate)) return candidate;
    node = node.parent;
  }

  // Last resort: position among siblings of the same tag.
  const siblings = (el.parent?.children ?? []).filter((n) => n.type === 'tag' && n.name === el.name);
  const index = siblings.indexOf(el);
  if (index >= 0) {
    const positional = `${el.name}:nth-of-type(${index + 1})`;
    if (resolves(positional)) return positional;
  }

  return base;
}

/**
 * Find repeated blocks that look like a list of records.
 * @returns {{selector:string, count:number, score:number, sample:object}[]}
 */
export function findRepeatedBlocks(page, { minCount = 3, limit = 8 } = {}) {
  const $ = page.$;
  /** @type {Map<string, {parent:any, elements:any[], selector:string}>} */
  const groups = new Map();

  $('body *').each((_, el) => {
    if (!el.parent || el.parent.type === 'root') return;
    const sig = signature($, el);
    if (!sig || sig === el.name) return; // untyped bare tags are too generic

    // Group by parent + signature, so we find *siblings* that repeat.
    const parentKey = $(el.parent).attr('id') ?? `${el.parent.name}:${$(el.parent).attr('class') ?? ''}`;
    const key = `${parentKey}>>${sig}`;

    let group = groups.get(key);
    if (!group) {
      group = { parent: el.parent, elements: [], signature: sig };
      groups.set(key, group);
    }
    group.elements.push(el);
  });

  const candidates = [];
  for (const group of groups.values()) {
    if (group.elements.length < minCount) continue;

    const sample = group.elements[0];
    const $sample = $(sample);
    const text = $sample.text().replace(/\s+/g, ' ').trim();
    const links = $sample.find('a[href]').length;
    const images = $sample.find('img').length;
    const headings = $sample.find('h1,h2,h3,h4,h5,h6').length;
    const descendants = $sample.find('*').length;

    // Score: repetition is necessary but not sufficient. Content richness is
    // what separates a product card from a row of tag links — and repetition
    // beyond ~25 carries almost no extra information, so it is capped low
    // enough that a very common small element can't outrank a real record.
    let score = 0;
    score += Math.min(group.elements.length, 25) * 1.5;
    score += Math.min(text.length / 25, 20);
    score += links > 0 ? 8 : -6;
    score += images > 0 ? 5 : 0;
    score += headings > 0 ? 10 : 0;

    // A record is composite by definition. A leaf element — `<a class="tag">` —
    // is a *field*, never a container, however often it repeats.
    if (descendants === 0) score -= 35;
    else if (descendants >= 2 && descendants <= 60) score += 8;
    else score -= 4;

    if (group.signature.includes('[itemscope]')) score += 20;

    // Penalise things that are structurally navigation.
    const parentClass = String($(group.parent).attr('class') ?? '').toLowerCase();
    const ownClass = String($sample.attr('class') ?? '').toLowerCase();
    if (/nav|menu|footer|header|breadcrumb|pagination|social|cookie/.test(`${parentClass} ${ownClass}`)) {
      score -= 40;
    }
    if (/product|item|card|result|listing|post|article|entry|row|job|offer/.test(ownClass)) score += 15;
    if (text.length < 15) score -= 20;

    const selector = buildSelector($, sample);
    // Verify: the selector must actually re-select roughly this many elements.
    const matched = $(selector).length;
    if (matched < minCount) continue;

    candidates.push({
      selector,
      count: matched,
      score: Math.round(score),
      sampleText: text.slice(0, 120),
      hasLink: links > 0,
      hasImage: images > 0,
    });
  }

  // Collapse duplicate selectors, keep the best score.
  const bySelector = new Map();
  for (const candidate of candidates) {
    const existing = bySelector.get(candidate.selector);
    if (!existing || candidate.score > existing.score) bySelector.set(candidate.selector, candidate);
  }

  return [...bySelector.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Suggest field selectors inside a container.
 * @returns {Record<string, object>} a `fields` block ready for a recipe
 */
export function suggestFields(page, containerSelector = null) {
  const $ = page.$;
  const container = containerSelector ? $(containerSelector).first() : $('body');
  if (container.length === 0) return {};

  const fields = {};
  // Two fields may legitimately share a selector when they read different
  // things — `a` for the href and `a` for the title attribute.
  const seen = new Set();

  const addField = (name, element, spec) => {
    if (fields[name] || !element) return;
    const selector = refineSelector($, element, container, spec.attr);
    const key = `${selector}|${spec.attr ?? 'text'}`;
    if (seen.has(key)) return;
    fields[name] = { selector, ...spec };
    seen.add(key);
  };

  // Title: the first heading, or a link with substantial text.
  const heading = container.find('h1, h2, h3, [itemprop="name"], .title, .name').first();
  if (heading.length) {
    // Listings routinely truncate the visible text and keep the full value in a
    // `title` attribute on the heading or the link inside it. Prefer whichever
    // actually holds more.
    const visible = heading.text().replace(/\s+/g, ' ').trim();
    const holder = heading.is('[title]') ? heading : heading.find('[title]').first();
    const attrValue = holder.attr('title')?.trim();

    if (attrValue && attrValue.length > visible.length) {
      addField('title', holder.get(0), { attr: 'title' });
    } else {
      addField('title', heading.get(0), { transform: ['clean'] });
    }
  }

  // URL: prefer the link wrapping the heading — an image link often comes first
  // in the markup but is the less useful of the two.
  const headingLink = heading.length
    ? (heading.is('a[href]') ? heading : heading.find('a[href]').first())
    : $([]);
  const link = headingLink.length ? headingLink : container.find('a[href]').first();
  if (link.length) {
    addField('url', link.get(0), { attr: 'href', type: 'url' });
  }

  // Price: any element whose text parses as currency.
  let priceEl = null;
  container.find('*').each((_, el) => {
    if (priceEl) return;
    const $el = $(el);
    if ($el.children().length > 0) return; // leaf nodes only
    const text = $el.text().trim();
    if (text.length > 30 || text.length < 2) return;
    if (!/[$£€¥₹₩฿]|\b(?:usd|eur|gbp|idr|rp|myr|sgd)\b/i.test(text)) return;
    if (parseCurrency(text)?.amount != null) priceEl = el;
  });
  if (priceEl) {
    addField('price', priceEl, { transform: ['currency'], type: 'number' });
  }

  // Image.
  const image = container.find('img[src], img[data-src]').first();
  if (image.length) {
    addField('image', image.get(0), {
      attr: image.attr('src') ? 'src' : 'data-src',
      type: 'url',
    });
  }

  // Date.
  const time = container.find('time[datetime], [itemprop="datePublished"]').first();
  if (time.length) {
    addField('date', time.get(0), {
      attr: time.attr('datetime') ? 'datetime' : 'text',
      transform: ['date'],
    });
  }

  // Description: the longest paragraph-like leaf.
  let best = null;
  let bestLength = 60;
  container.find('p, [itemprop="description"], .description, .summary, .excerpt').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > bestLength) {
      bestLength = text.length;
      best = el;
    }
  });
  if (best) {
    addField('description', best, { transform: ['clean'] });
  }

  // Nothing above matched the site's vocabulary? Fall back to structure: any
  // leaf element carrying text and a meaningful class is very likely a field,
  // and its class name is what the site's own authors called it.
  if (Object.keys(fields).length < 2) {
    const usedClasses = new Set();
    for (const node of container.find('[class]').toArray()) {
      if (Object.keys(fields).length >= 8) break;
      const $node = $(node);
      if ($node.children().length > 0) continue;

      const text = $node.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 300) continue;

      const className = ($node.attr('class') ?? '').split(/\s+/).find(isStableClass);
      if (!className || usedClasses.has(className)) continue;
      usedClasses.add(className);

      // Strip a BEM block prefix so `.quote__author` becomes `author`.
      const name = className
        .replace(/^.*?[-_]{2}/, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
      if (!name || /^\d/.test(name) || fields[name]) continue;

      // Repeating within one record means it's a list, not a single value.
      const repeats = container.find(`.${CSS_escape(className)}`).length > 1;
      addField(name, node, { transform: ['clean'], ...(repeats ? { all: true } : {}) });
    }
  }

  return fields;
}

/**
 * Analyse a page end to end.
 *
 * @param {object} params
 * @param {string} params.html
 * @param {string} params.url
 * @param {object} [params.response]
 * @param {object} [params.robotsVerdict]
 * @param {boolean} [params.rendered]     `html` came from a browser.
 * @param {string} [params.staticHtml]    The plain-HTTP body, when we also
 *        fetched it. Having both turns the "does this need JavaScript?"
 *        heuristic into a direct measurement.
 * @returns {object} the analysis
 */
export function analyzePage({
  html, url, response = null, robotsVerdict = null, rendered = false, staticHtml = null,
}) {
  const page = new Page({ html, url, response });

  const jsonLd = page.jsonLd();
  const microdata = page.microdata();
  const openGraph = page.openGraph();
  const tables = page.tables().filter((t) => t.rowCount > 0);

  // With both versions in hand we can measure rather than guess: if rendering
  // added substantial text or elements, the page genuinely needs a browser.
  let renderVerdict;
  if (rendered && staticHtml != null) {
    const staticPage = new Page({ html: staticHtml, url });
    const staticText = staticPage.text().length;
    const renderedText = page.text().length;
    const staticNodes = staticPage.$('body *').length;
    const renderedNodes = page.$('body *').length;
    const grew = renderedText > staticText * 1.5 + 100 || renderedNodes > staticNodes * 1.5 + 5;
    renderVerdict = {
      needed: grew,
      reason: grew
        ? `rendering added content (${staticText} → ${renderedText} chars, ${staticNodes} → ${renderedNodes} elements)`
        : `rendering changed little (${staticText} → ${renderedText} chars) — plain HTTP is enough`,
      measured: true,
      staticTextLength: staticText,
      renderedTextLength: renderedText,
    };
  } else {
    renderVerdict = { ...needsRendering(html), measured: false };
  }

  const blocks = findRepeatedBlocks(page);

  // Take the highest-scoring container that actually yields fields. A container
  // we can't extract anything from is the wrong container, whatever it scored —
  // and picking it would generate a recipe that silently produces no records.
  let bestBlock = null;
  let listFields = {};
  for (const block of blocks) {
    const candidate = suggestFields(page, block.selector);
    if (Object.keys(candidate).length > 0) {
      bestBlock = block;
      listFields = candidate;
      break;
    }
  }

  const detailFields = suggestFields(page);
  const nextPage = autoDetectNextPage(page);

  const links = page.links();
  const internal = links.filter((l) => {
    try {
      return new URL(l.url).hostname === new URL(url).hostname;
    } catch {
      return false;
    }
  });

  return {
    url: page.url,
    canonical: page.canonical(),
    title: page.title(),
    status: response?.status ?? 200,
    bytes: html.length,
    rendered,
    needsJavaScript: renderVerdict.needed,
    javaScriptReason: renderVerdict.reason,
    javaScriptMeasured: renderVerdict.measured,
    robots: robotsVerdict,

    structuredData: {
      jsonLd: jsonLd.map((b) => ({
        type: Array.isArray(b['@type']) ? b['@type'].join('/') : b['@type'] ?? 'unknown',
        keys: Object.keys(b).filter((k) => !k.startsWith('@')).slice(0, 12),
      })),
      microdata: microdata.map((m) => ({ type: m['@type'] ?? 'unknown', keys: Object.keys(m).slice(0, 12) })),
      openGraph: Object.keys(openGraph),
      hasStructuredData: jsonLd.length > 0 || microdata.length > 0,
    },

    tables: tables.map((t, i) => ({
      index: i,
      caption: t.caption,
      headers: t.headers.slice(0, 10),
      rows: t.rowCount,
    })),

    repeatedBlocks: blocks,
    suggestions: {
      itemSelector: bestBlock?.selector ?? null,
      listFields,
      detailFields,
    },

    pagination: nextPage,
    links: { total: links.length, internal: internal.length, external: links.length - internal.length },
  };
}

/**
 * Turn an analysis into a runnable recipe.
 * @returns {object} recipe object (snake_case, ready to serialise as YAML)
 */
export function generateRecipe(analysis, options = {}) {
  const { name = 'my-scraper', output = 'output/data.csv' } = options;
  const hasList = !!analysis.suggestions.itemSelector;

  const recipe = {
    name,
    description: `Generated from ${analysis.url} on ${new Date().toISOString().slice(0, 10)}. Review the selectors before running at scale.`,
    start_urls: [analysis.url],
  };

  if (analysis.needsJavaScript) {
    recipe.render = {
      mode: 'auto',
      wait_for_selector: analysis.suggestions.itemSelector ?? undefined,
    };
  }

  recipe.rate_limit = { requests_per_second: 1 };

  if (analysis.pagination) {
    recipe.crawl = {
      max_depth: 1,
      pagination: { selector: analysis.pagination.detectedBy ?? 'a[rel="next"]', max_pages: 10 },
    };
  }

  // Prefer JSON-LD when the page publishes it — far more durable than CSS.
  const productLd = analysis.structuredData.jsonLd.find((b) => /product|offer/i.test(b.type));
  if (productLd) {
    recipe.extract = {
      fields: {
        name: { from: 'jsonld', path: 'name', type: 'string' },
        price: { from: 'jsonld', path: 'offers.price', transform: ['number'], type: 'number' },
        currency: { from: 'jsonld', path: 'offers.priceCurrency' },
        availability: { from: 'jsonld', path: 'offers.availability' },
        url: { from: 'url' },
      },
    };
    recipe._note = 'This page publishes JSON-LD, which survives redesigns better than CSS selectors.';
  } else if (hasList) {
    recipe.extract = {
      item: {
        selector: analysis.suggestions.itemSelector,
        fields: analysis.suggestions.listFields,
      },
    };
  } else if (analysis.tables.length) {
    recipe.extract = { tables: true };
  } else {
    recipe.extract = { fields: analysis.suggestions.detailFields };
  }

  recipe.output = [output];
  return recipe;
}
