/**
 * Cookie jar (RFC 6265 subset).
 *
 * Enough to hold a login session together across a crawl: domain/path matching,
 * Secure/HttpOnly, expiry, and Max-Age. Deliberately not a full implementation —
 * no public-suffix list — so a `domain=` attribute is only honoured when it is a
 * suffix of the origin host, which is the rule that actually matters for safety.
 */

export class Cookie {
  constructor(fields) {
    Object.assign(this, {
      name: '',
      value: '',
      domain: '',
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      createdAt: Date.now(),
      ...fields,
    });
  }

  get isExpired() {
    return this.expires != null && this.expires <= Date.now();
  }

  matches(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (this.secure && parsed.protocol !== 'https:') return false;
    if (this.isExpired) return false;

    const host = parsed.hostname.toLowerCase();
    if (this.hostOnly) {
      if (host !== this.domain) return false;
    } else if (host !== this.domain && !host.endsWith(`.${this.domain}`)) {
      return false;
    }

    // Path match per RFC 6265 §5.1.4.
    const reqPath = parsed.pathname || '/';
    if (this.path === '/') return true;
    if (reqPath === this.path) return true;
    return reqPath.startsWith(this.path.endsWith('/') ? this.path : `${this.path}/`);
  }

  toString() {
    return `${this.name}=${this.value}`;
  }

  toJSON() {
    return {
      name: this.name, value: this.value, domain: this.domain, path: this.path,
      expires: this.expires, secure: this.secure, httpOnly: this.httpOnly,
      sameSite: this.sameSite, hostOnly: this.hostOnly,
    };
  }
}

/** Parse one `Set-Cookie` header value against the URL that produced it. */
export function parseSetCookie(header, url) {
  if (typeof header !== 'string' || !header.includes('=')) return null;

  const parts = header.split(';');
  const [rawName, ...rawValueParts] = parts[0].split('=');
  const name = rawName.trim();
  if (!name) return null;
  const value = rawValueParts.join('=').trim();

  let origin;
  try {
    origin = new URL(url);
  } catch {
    return null;
  }

  const cookie = {
    name,
    value,
    domain: origin.hostname.toLowerCase(),
    path: '/',
    hostOnly: true,
    secure: false,
    httpOnly: false,
    expires: null,
    sameSite: null,
  };

  let maxAge = null;
  for (const attr of parts.slice(1)) {
    const eq = attr.indexOf('=');
    const key = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const val = eq === -1 ? '' : attr.slice(eq + 1).trim();

    switch (key) {
      case 'domain': {
        const domain = val.replace(/^\./, '').toLowerCase();
        if (!domain) break;
        // Reject cookies trying to set a domain we're not part of.
        const host = origin.hostname.toLowerCase();
        if (host === domain || host.endsWith(`.${domain}`)) {
          cookie.domain = domain;
          cookie.hostOnly = false;
        }
        break;
      }
      case 'path':
        if (val.startsWith('/')) cookie.path = val;
        break;
      case 'expires': {
        const ts = Date.parse(val);
        if (Number.isFinite(ts)) cookie.expires = ts;
        break;
      }
      case 'max-age': {
        const seconds = Number(val);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val.toLowerCase();
        break;
      default:
        break;
    }
  }

  // Max-Age wins over Expires per spec.
  if (maxAge != null) cookie.expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;

  return new Cookie(cookie);
}

export class CookieJar {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    /** @type {Map<string, Cookie>} storage key -> cookie */
    this.cookies = new Map();
  }

  #key(cookie) {
    return `${cookie.domain}|${cookie.path}|${cookie.name}`;
  }

  set(cookie) {
    if (!this.enabled || !cookie) return;
    const key = this.#key(cookie);
    // Expiry in the past is the standard way to delete a cookie.
    if (cookie.isExpired) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
  }

  /** Ingest all `Set-Cookie` headers from a response. */
  setFromResponse(headers, url) {
    if (!this.enabled) return 0;
    const raw = typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers?.['set-cookie']].flat().filter(Boolean);

    let count = 0;
    for (const header of raw) {
      const cookie = parseSetCookie(header, url);
      if (cookie) {
        this.set(cookie);
        count += 1;
      }
    }
    return count;
  }

  /** All non-expired cookies that should be sent to `url`. */
  getFor(url) {
    if (!this.enabled) return [];
    const out = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.isExpired) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.matches(url)) out.push(cookie);
    }
    // Longer paths first, per RFC 6265 §5.4.
    out.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return out;
  }

  /** Ready-to-send `Cookie` header value, or null when there's nothing to send. */
  headerFor(url) {
    const cookies = this.getFor(url);
    return cookies.length ? cookies.map((c) => c.toString()).join('; ') : null;
  }

  /** Seed cookies manually — e.g. paste a session cookie from your browser. */
  loadFromObject(map, url) {
    for (const [name, value] of Object.entries(map ?? {})) {
      let domain = '';
      try {
        domain = new URL(url).hostname.toLowerCase();
      } catch { /* leave blank; cookie will simply never match */ }
      this.set(new Cookie({ name, value: String(value), domain, path: '/' }));
    }
  }

  /** Import Playwright's cookie format (after a browser login step). */
  loadFromPlaywright(cookies = []) {
    for (const c of cookies) {
      this.set(new Cookie({
        name: c.name,
        value: c.value,
        domain: (c.domain ?? '').replace(/^\./, '').toLowerCase(),
        path: c.path || '/',
        expires: c.expires && c.expires > 0 ? c.expires * 1000 : null,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        hostOnly: !String(c.domain ?? '').startsWith('.'),
      }));
    }
  }

  /** Export in Playwright's format so an HTTP session can be handed to a browser. */
  toPlaywright() {
    return [...this.cookies.values()].filter((c) => !c.isExpired).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.hostOnly ? c.domain : `.${c.domain}`,
      path: c.path,
      expires: c.expires ? Math.floor(c.expires / 1000) : -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite === 'none' ? 'None' : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    }));
  }

  clear(domain = null) {
    if (!domain) {
      this.cookies.clear();
      return;
    }
    for (const [key, cookie] of this.cookies) {
      if (cookie.domain === domain || cookie.domain.endsWith(`.${domain}`)) this.cookies.delete(key);
    }
  }

  get size() {
    return this.cookies.size;
  }

  toJSON() {
    return [...this.cookies.values()].map((c) => c.toJSON());
  }

  static fromJSON(list) {
    const jar = new CookieJar();
    for (const c of list ?? []) jar.set(new Cookie(c));
    return jar;
  }
}
