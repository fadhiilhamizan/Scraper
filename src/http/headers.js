/**
 * Request header assembly.
 *
 * Header *order* and *coherence* are part of a browser's fingerprint. This
 * module builds a header set from a browser profile, layers on per-run and
 * per-request overrides, and adds the contextual headers (Referer,
 * Sec-Fetch-Site) that a real navigation would carry.
 */

import { getOrigin } from '../queue/urlutils.js';

/** Emit headers in the order real browsers send them. */
const HEADER_ORDER = [
  'host',
  'connection',
  'cache-control',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'user-agent',
  'accept',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'accept-encoding',
  'accept-language',
  'cookie',
];

/**
 * @param {object} params
 * @param {string} params.url                     Target URL.
 * @param {object} [params.profile]               Browser profile from the UA rotator.
 * @param {object} [params.baseHeaders]           Run-level headers from the recipe.
 * @param {object} [params.requestHeaders]        Per-request overrides (win).
 * @param {string} [params.referer]               Page we followed the link from.
 * @param {string} [params.cookie]                Cookie header value.
 * @param {boolean}[params.identify=false]        Append a contact/UA note.
 * @returns {Record<string,string>}
 */
export function buildHeaders({
  url,
  profile = null,
  baseHeaders = {},
  requestHeaders = {},
  referer = null,
  cookie = null,
} = {}) {
  /** @type {Record<string,string>} */
  const headers = {};

  if (profile) {
    for (const [k, v] of Object.entries(profile.headers ?? {})) headers[k.toLowerCase()] = v;
    headers['user-agent'] = profile.userAgent;
  }

  for (const [k, v] of Object.entries(baseHeaders ?? {})) {
    if (v == null) continue;
    headers[k.toLowerCase()] = String(v);
  }

  if (referer) {
    headers.referer = referer;
    // Sec-Fetch-Site must agree with the Referer or the pair looks synthetic.
    const from = getOrigin(referer);
    const to = getOrigin(url);
    if (from && to) {
      if (from === to) headers['sec-fetch-site'] = 'same-origin';
      else {
        try {
          const a = new URL(from).hostname.split('.').slice(-2).join('.');
          const b = new URL(to).hostname.split('.').slice(-2).join('.');
          headers['sec-fetch-site'] = a === b ? 'same-site' : 'cross-site';
        } catch {
          headers['sec-fetch-site'] = 'cross-site';
        }
      }
    }
  }

  if (cookie) headers.cookie = cookie;

  for (const [k, v] of Object.entries(requestHeaders ?? {})) {
    if (v == null) {
      delete headers[k.toLowerCase()];
      continue;
    }
    headers[k.toLowerCase()] = String(v);
  }

  return orderHeaders(headers);
}

/** Reorder an object so JS insertion order matches browser wire order. */
export function orderHeaders(headers) {
  const ordered = {};
  for (const key of HEADER_ORDER) {
    if (key in headers) ordered[key] = headers[key];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

/**
 * Headers appropriate for a background XHR/fetch rather than a page navigation.
 * Use when scraping a site's own JSON API.
 */
export function apiHeaders({ url, profile = null, referer = null, extra = {} } = {}) {
  const base = buildHeaders({ url, profile, referer });
  return orderHeaders({
    ...base,
    accept: 'application/json, text/plain, */*',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'x-requested-with': 'XMLHttpRequest',
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), String(v)])),
  });
}
