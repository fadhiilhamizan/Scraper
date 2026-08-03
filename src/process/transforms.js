/**
 * The transform library — the "clean and normalise" stage.
 *
 * Transforms are named, composable, and declared as data so a recipe can say
 * `transform: [trim, currency]` without writing code. Each transform is a pure
 * function `(value, ...args) => value`, applied left to right.
 *
 * Anything that can't be interpreted returns `null` rather than throwing or
 * silently producing `NaN`, so a bad value shows up as a missing field in the
 * output instead of poisoning downstream arithmetic.
 */

/* ────────────────────────────── text helpers ────────────────────────────── */

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·',
  laquo: '«', raquo: '»', times: '×', divide: '÷', frac12: '½', frac14: '¼',
};

export function decodeEntities(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

/** Strip tags but keep block boundaries as spaces so words don't fuse. */
export function stripTags(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* ──────────────────────────── number parsing ────────────────────────────── */

const CURRENCY_SYMBOLS = {
  $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₽': 'RUB',
  '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', '₫': 'VND', '฿': 'THB', 'R$': 'BRL',
  'Rp': 'IDR', 'RM': 'MYR', '₱': 'PHP', 'CHF': 'CHF', 'kr': 'SEK', 'zł': 'PLN',
};

/**
 * Parse a number out of messy text, handling both decimal conventions.
 *
 * The hard case is telling `1.234` (European thousands) from `1.234` (a real
 * decimal). The rule used here: whichever of `.` or `,` appears **last** is the
 * decimal separator, unless the trailing group is exactly three digits and the
 * separator also appears earlier — which means it's a thousands separator.
 *
 * @example parseNumber('$1,234.56') // 1234.56
 * @example parseNumber('1.234,56 €') // 1234.56
 * @example parseNumber('1.234')      // 1234   (three trailing digits)
 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;

  let text = String(value).trim();
  if (!text) return null;

  // Unicode minus, non-breaking and narrow spaces used as digit separators.
  text = text.replace(/[−‒–—]/g, '-').replace(/[   ]/g, '');

  const negative = /^\s*[-(]/.test(text) || /-\s*$/.test(text);
  const match = text.match(/-?\d[\d., ']*\d|\d/);
  if (!match) return null;

  let numeric = match[0].replace(/[ ']/g, '');

  const lastDot = numeric.lastIndexOf('.');
  const lastComma = numeric.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal separator.
    if (lastDot > lastComma) numeric = numeric.replace(/,/g, '');
    else numeric = numeric.replace(/\./g, '').replace(',', '.');
  } else if (lastComma !== -1) {
    const after = numeric.length - lastComma - 1;
    const occurrences = (numeric.match(/,/g) ?? []).length;
    // `1,234` and `1,234,567` are thousands; `1,23` and `1,2345` are decimals.
    numeric = after === 3 && (occurrences > 1 || /^\d{1,3},\d{3}$/.test(numeric))
      ? numeric.replace(/,/g, '')
      : numeric.replace(',', '.');
  } else if (lastDot !== -1) {
    const after = numeric.length - lastDot - 1;
    const occurrences = (numeric.match(/\./g) ?? []).length;
    if (occurrences > 1 || (after === 3 && /^\d{1,3}\.\d{3}$/.test(numeric))) {
      numeric = numeric.replace(/\./g, '');
    }
  }

  const parsed = Number.parseFloat(numeric);
  if (!Number.isFinite(parsed)) return null;
  return negative && parsed > 0 ? -parsed : parsed;
}

/**
 * Parse a price, returning the amount and the detected currency.
 * @returns {{amount:number, currency:string|null, raw:string}|null}
 */
export function parseCurrency(value) {
  if (value == null) return null;
  const raw = String(value);
  const amount = parseNumber(raw);
  if (amount == null) return null;

  let currency = null;
  const isoMatch = raw.match(/\b([A-Z]{3})\b/);
  if (isoMatch && Object.values(CURRENCY_SYMBOLS).includes(isoMatch[1])) {
    currency = isoMatch[1];
  } else {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (raw.includes(symbol)) { currency = code; break; }
    }
  }
  return { amount, currency, raw: raw.trim() };
}

/* ───────────────────────────── date parsing ─────────────────────────────── */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const RELATIVE_UNITS = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  week: 604_800_000, weeks: 604_800_000,
  month: 2_592_000_000, months: 2_592_000_000,
  year: 31_536_000_000, years: 31_536_000_000,
};

/**
 * Parse a date from the many shapes sites use, including relative phrases.
 *
 * @param {string} value
 * @param {object} [options]
 * @param {'iso'|'date'|'timestamp'|'object'} [options.output='iso']
 * @param {boolean} [options.dayFirst=false] Read ambiguous `03/04/2024` as
 *        4 March (true) rather than 3 April (false).
 * @returns {string|Date|number|null}
 */
export function parseDate(value, options = {}) {
  const { output = 'iso', dayFirst = false, now = Date.now() } = options;
  if (value == null) return null;
  if (value instanceof Date) return formatDate(value, output);

  const text = String(value).trim();
  if (!text) return null;

  // Unix timestamp (seconds or milliseconds).
  if (/^\d{10}$/.test(text)) return formatDate(new Date(Number(text) * 1000), output);
  if (/^\d{13}$/.test(text)) return formatDate(new Date(Number(text)), output);

  // "3 days ago" / "in 2 hours" / "yesterday"
  const relative = text.toLowerCase();
  if (relative === 'today' || relative === 'now') return formatDate(new Date(now), output);
  if (relative === 'yesterday') return formatDate(new Date(now - 86_400_000), output);
  if (relative === 'tomorrow') return formatDate(new Date(now + 86_400_000), output);

  const rel = relative.match(/^(?:in\s+)?(\d+)\s*([a-z]+)\s*(ago)?$/);
  if (rel && RELATIVE_UNITS[rel[2]]) {
    const delta = Number(rel[1]) * RELATIVE_UNITS[rel[2]];
    return formatDate(new Date(rel[3] ? now - delta : now + delta), output);
  }

  // ISO 8601 — trust the engine.
  if (/^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    const parsed = new Date(text.includes('T') || !text.includes(' ') ? text : text.replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return formatDate(parsed, output);
  }

  // "12 March 2024" / "March 12, 2024" / "12-Mar-2024"
  const named = text.match(/(\d{1,2})[\s.\-/]+([a-z]{3,9})[\s.\-/,]+(\d{4})/i)
    ?? text.match(/([a-z]{3,9})[\s.\-/]+(\d{1,2})(?:st|nd|rd|th)?[\s.\-/,]+(\d{4})/i);
  if (named) {
    const monthToken = MONTHS[named[1].toLowerCase()] !== undefined ? named[1] : named[2];
    const dayToken = MONTHS[named[1].toLowerCase()] !== undefined ? named[2] : named[1];
    const month = MONTHS[String(monthToken).toLowerCase()];
    if (month !== undefined) {
      const parsed = new Date(Date.UTC(Number(named[3]), month, Number(dayToken)));
      if (!Number.isNaN(parsed.getTime())) return formatDate(parsed, output);
    }
  }

  // Numeric d/m/y or m/d/y.
  const numeric = text.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})/);
  if (numeric) {
    let [, a, b, c] = numeric.map(Number);
    let year;
    let month;
    let day;
    if (String(numeric[1]).length === 4) {
      [year, month, day] = [a, b, c];
    } else {
      year = c < 100 ? (c > 50 ? 1900 + c : 2000 + c) : c;
      // A value above 12 can only be the day, whatever the convention.
      if (a > 12) [day, month] = [a, b];
      else if (b > 12) [day, month] = [b, a];
      else [day, month] = dayFirst ? [a, b] : [b, a];
    }
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(parsed.getTime())) return formatDate(parsed, output);
  }

  // Last resort — let the engine try.
  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) return formatDate(fallback, output);
  return null;
}

function formatDate(date, output) {
  if (Number.isNaN(date.getTime())) return null;
  switch (output) {
    case 'date': return date;
    case 'timestamp': return date.getTime();
    case 'day': return date.toISOString().slice(0, 10);
    case 'object':
      return {
        iso: date.toISOString(),
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        timestamp: date.getTime(),
      };
    case 'iso':
    default: return date.toISOString();
  }
}

/* ────────────────────────────── the registry ────────────────────────────── */

const apply = (value, fn) => (Array.isArray(value) ? value.map(fn) : fn(value));
const asString = (value) => (value == null ? '' : String(value));

/** @type {Record<string, (value:any, ...args:any[]) => any>} */
export const TRANSFORMS = {
  /* — whitespace and casing — */
  trim: (v) => apply(v, (x) => (typeof x === 'string' ? x.trim() : x)),
  collapse: (v) => apply(v, (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : x)),
  normalizeSpace: (v) => TRANSFORMS.collapse(v),
  squeeze: (v) => apply(v, (x) => (typeof x === 'string' ? x.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim() : x)),
  lower: (v) => apply(v, (x) => asString(x).toLowerCase()),
  upper: (v) => apply(v, (x) => asString(x).toUpperCase()),
  capitalize: (v) => apply(v, (x) => { const s = asString(x); return s.charAt(0).toUpperCase() + s.slice(1); }),
  title: (v) => apply(v, (x) => asString(x).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())),

  /* — cleaning — */
  stripTags: (v) => apply(v, stripTags),
  decodeEntities: (v) => apply(v, decodeEntities),
  clean: (v) => apply(v, (x) => decodeEntities(stripTags(asString(x))).replace(/\s+/g, ' ').trim()),
  // Control characters, zero-width spaces, bidi marks and the BOM: invisible
  // characters that corrupt CSV output and break equality comparisons.
  stripNonPrintable: (v) => apply(v, (x) => asString(x)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')),
  stripEmoji: (v) => apply(v, (x) => asString(x)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()),
  /** Unicode NFKC folding — turns fullwidth/ligature characters into plain ASCII forms. */
  normalizeUnicode: (v) => apply(v, (x) => asString(x).normalize('NFKC')),

  /* — numbers — */
  number: (v) => apply(v, parseNumber),
  int: (v) => apply(v, (x) => { const n = parseNumber(x); return n == null ? null : Math.trunc(n); }),
  float: (v) => apply(v, parseNumber),
  round: (v, digits = 0) => apply(v, (x) => {
    const n = parseNumber(x);
    if (n == null) return null;
    const factor = 10 ** Number(digits);
    return Math.round(n * factor) / factor;
  }),
  currency: (v) => apply(v, (x) => parseCurrency(x)?.amount ?? null),
  currencyCode: (v) => apply(v, (x) => parseCurrency(x)?.currency ?? null),
  price: (v) => apply(v, (x) => parseCurrency(x)),
  percent: (v) => apply(v, (x) => { const n = parseNumber(x); return n == null ? null : n / 100; }),

  /* — booleans — */
  /**
   * True when the value matches a pattern. The clean way to turn a coded
   * string into a flag, e.g. schema.org availability:
   *   `transform: ["test:InStock"]`  →  "https://schema.org/InStock" -> true
   */
  test: (v, pattern = '', flags = 'i') => apply(v, (x) => {
    if (x == null) return null;
    try {
      return new RegExp(pattern, flags).test(asString(x));
    } catch {
      return asString(x).includes(pattern);
    }
  }),
  boolean: (v) => apply(v, (x) => {
    if (typeof x === 'boolean') return x;
    if (x == null) return null;
    const s = asString(x).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'available', 'in stock'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'off', 'unavailable', 'out of stock'].includes(s)) return false;
    return null;
  }),

  /* — dates — */
  date: (v, output = 'iso') => apply(v, (x) => parseDate(x, { output })),
  dateOnly: (v) => apply(v, (x) => parseDate(x, { output: 'day' })),
  timestamp: (v) => apply(v, (x) => parseDate(x, { output: 'timestamp' })),
  dateEU: (v, output = 'iso') => apply(v, (x) => parseDate(x, { output, dayFirst: true })),

  /* — strings — */
  replace: (v, pattern, replacement = '') => apply(v, (x) => {
    const s = asString(x);
    try {
      return s.replace(new RegExp(pattern, 'g'), replacement);
    } catch {
      return s.split(pattern).join(replacement);
    }
  }),
  remove: (v, pattern) => TRANSFORMS.replace(v, pattern, ''),
  extract: (v, pattern, group = 0) => apply(v, (x) => {
    try {
      return asString(x).match(new RegExp(pattern))?.[Number(group)] ?? null;
    } catch {
      return null;
    }
  }),
  extractAll: (v, pattern) => {
    try {
      return [...asString(Array.isArray(v) ? v.join(' ') : v).matchAll(new RegExp(pattern, 'g'))].map((m) => m[1] ?? m[0]);
    } catch {
      return [];
    }
  },
  split: (v, separator = ',') => apply(v, (x) => asString(x).split(separator).map((s) => s.trim()).filter(Boolean)),
  join: (v, separator = ', ') => (Array.isArray(v) ? v.filter((x) => x != null && x !== '').join(separator) : v),
  prefix: (v, text = '') => apply(v, (x) => `${text}${asString(x)}`),
  suffix: (v, text = '') => apply(v, (x) => `${asString(x)}${text}`),
  truncate: (v, length = 200, ellipsis = '…') => apply(v, (x) => {
    const s = asString(x);
    return s.length <= Number(length) ? s : s.slice(0, Number(length)).trimEnd() + ellipsis;
  }),
  slug: (v) => apply(v, (x) => asString(x)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')),
  padStart: (v, length = 2, pad = '0') => apply(v, (x) => asString(x).padStart(Number(length), pad)),

  /* — extraction shortcuts — */
  email: (v) => apply(v, (x) => asString(x).match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null),
  phone: (v) => apply(v, (x) => {
    const digits = asString(x).replace(/[^\d+]/g, '');
    return digits.length >= 7 ? digits : null;
  }),
  digits: (v) => apply(v, (x) => asString(x).replace(/\D/g, '') || null),
  urlPath: (v) => apply(v, (x) => { try { return new URL(asString(x)).pathname; } catch { return null; } }),
  domain: (v) => apply(v, (x) => { try { return new URL(asString(x)).hostname; } catch { return null; } }),
  queryParam: (v, name) => apply(v, (x) => {
    try { return new URL(asString(x)).searchParams.get(name); } catch { return null; }
  }),

  /* — arrays — */
  first: (v) => (Array.isArray(v) ? v[0] ?? null : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] ?? null : v),
  nth: (v, index = 0) => (Array.isArray(v) ? v[Number(index)] ?? null : v),
  unique: (v) => (Array.isArray(v) ? [...new Set(v)] : v),
  compact: (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : v),
  sort: (v) => (Array.isArray(v) ? [...v].sort() : v),
  count: (v) => (Array.isArray(v) ? v.length : v == null ? 0 : 1),
  slice: (v, start = 0, end) => (Array.isArray(v) ? v.slice(Number(start), end === undefined ? undefined : Number(end)) : v),

  /* — structural — */
  json: (v) => apply(v, (x) => { try { return JSON.parse(asString(x)); } catch { return null; } }),
  toString: (v) => apply(v, (x) => (x == null ? null : String(x))),
  default: (v, fallback = null) => (v == null || v === '' || (Array.isArray(v) && v.length === 0) ? fallback : v),
  nullIfEmpty: (v) => (v === '' || (Array.isArray(v) && v.length === 0) ? null : v),
};

/**
 * Parse a transform spec into `[name, ...args]`.
 *
 * Accepted forms:
 *   `"trim"`                        no arguments
 *   `"truncate:50"`                 one argument — everything after the first
 *                                   colon, so patterns containing `:` are safe
 *   `["replace", "\\s+", " "]`      several arguments
 *   `{ replace: ["\\s+", " "] }`    the same, in mapping form
 *   `{ name: 'round', args: [2] }`  explicit
 *
 * The colon shorthand deliberately takes exactly one argument: splitting on
 * every colon would break `"replace:https://x/:"` and any regex using `:`.
 * Use the array form when you need two.
 */
function normalizeSpec(spec) {
  if (typeof spec === 'function') return { fn: spec, args: [] };
  if (typeof spec === 'string') {
    const colon = spec.indexOf(':');
    if (colon === -1) return { name: spec.trim(), args: [] };
    return { name: spec.slice(0, colon).trim(), args: [spec.slice(colon + 1)] };
  }
  if (Array.isArray(spec)) {
    const [name, ...args] = spec;
    return { name: String(name), args };
  }
  if (spec && typeof spec === 'object') {
    if (spec.name) return { name: String(spec.name), args: spec.args ?? [] };
    const [name, args] = Object.entries(spec)[0] ?? [];
    if (!name) return null;
    return { name, args: Array.isArray(args) ? args : [args] };
  }
  return null;
}

/**
 * Apply a transform chain to a value.
 *
 * @param {any} value
 * @param {Array<string|object|Function>} chain
 * @param {object} [context] Passed to function transforms as a second argument.
 * @returns {any}
 */
export function applyTransforms(value, chain, context = {}) {
  if (!chain) return value;
  const list = Array.isArray(chain) ? chain : [chain];

  let current = value;
  for (const spec of list) {
    const normalized = normalizeSpec(spec);
    if (!normalized) continue;

    if (normalized.fn) {
      current = normalized.fn(current, context);
      continue;
    }

    const fn = TRANSFORMS[normalized.name];
    if (!fn) {
      throw new Error(
        `Unknown transform '${normalized.name}'. Available: ${Object.keys(TRANSFORMS).sort().join(', ')}`,
      );
    }
    current = fn(current, ...normalized.args);
  }
  return current;
}

/** Register a custom transform, usable by name from any recipe. */
export function registerTransform(name, fn) {
  if (typeof fn !== 'function') throw new TypeError(`Transform '${name}' must be a function`);
  TRANSFORMS[name] = fn;
  return TRANSFORMS;
}

export function listTransforms() {
  return Object.keys(TRANSFORMS).sort();
}
