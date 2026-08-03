/**
 * User-Agent rotation with *coherent* identities.
 *
 * A rotator that emits a Chrome UA alongside Firefox's `Accept` header is worse
 * than no rotation at all — mismatched fingerprints are exactly what bot
 * detection looks for. So each profile bundles a UA with the header set that
 * browser genuinely sends, including Client Hints for Chromium.
 */

/**
 * @typedef {object} BrowserProfile
 * @property {string} name
 * @property {string} platform  Playwright-compatible engine hint.
 * @property {string} userAgent
 * @property {Record<string,string>} headers
 * @property {{width:number,height:number}} viewport
 */

/** @type {BrowserProfile[]} */
export const BROWSER_PROFILES = [
  {
    name: 'chrome-windows',
    engine: 'chromium',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'chrome-macos',
    engine: 'chromium',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    viewport: { width: 1728, height: 1117 },
  },
  {
    name: 'firefox-windows',
    engine: 'firefox',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.5',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      te: 'trailers',
    },
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'safari-macos',
    engine: 'webkit',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
    },
    viewport: { width: 1680, height: 1050 },
  },
  {
    name: 'edge-windows',
    engine: 'chromium',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'chrome-android',
    engine: 'chromium',
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'upgrade-insecure-requests': '1',
    },
    viewport: { width: 412, height: 915 },
  },
];

/**
 * An honest, identifying UA. This is the **default** — see the note in
 * docs/09-compliance.md. Rotation exists for sites that block all non-browser
 * traffic, not as a way to hide who you are.
 */
export function botUserAgent({ name = 'Harvester', version = '1.0', contact } = {}) {
  const contactPart = contact ? `; +${contact}` : '';
  return `${name}/${version} (compatible; web scraper${contactPart})`;
}

export class UserAgentRotator {
  /**
   * @param {object} [options]
   * @param {'sequential'|'random'|'sticky'} [options.strategy='sticky']
   *        `sticky` keeps one identity per host for the whole run, which is far
   *        more believable than changing browser mid-session.
   * @param {string[]} [options.userAgents]  Raw UA strings (overrides profiles).
   * @param {string[]} [options.include]     Profile names to restrict to.
   * @param {boolean}  [options.mobile=false] Include mobile profiles.
   */
  constructor(options = {}) {
    const { strategy = 'sticky', userAgents = null, include = null, mobile = false } = options;

    this.strategy = strategy;
    this.index = 0;
    /** @type {Map<string, BrowserProfile>} host -> pinned profile */
    this.hostAssignments = new Map();

    if (userAgents?.length) {
      this.profiles = userAgents.map((ua, i) => ({
        name: `custom-${i}`,
        engine: 'chromium',
        userAgent: ua,
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
        viewport: { width: 1920, height: 1080 },
      }));
    } else {
      this.profiles = BROWSER_PROFILES.filter((p) => {
        if (include?.length && !include.includes(p.name)) return false;
        if (!mobile && p.mobile) return false;
        return true;
      });
    }

    if (this.profiles.length === 0) this.profiles = [BROWSER_PROFILES[0]];
  }

  /**
   * @param {string} [host] Used by the `sticky` strategy.
   * @returns {BrowserProfile}
   */
  next(host = null) {
    if (this.strategy === 'sticky' && host) {
      let profile = this.hostAssignments.get(host);
      if (!profile) {
        profile = this.profiles[Math.floor(Math.random() * this.profiles.length)];
        this.hostAssignments.set(host, profile);
      }
      return profile;
    }
    if (this.strategy === 'random') {
      return this.profiles[Math.floor(Math.random() * this.profiles.length)];
    }
    const profile = this.profiles[this.index % this.profiles.length];
    this.index += 1;
    return profile;
  }

  /** Force a new identity for a host — called by the retry policy after a block. */
  rotate(host) {
    if (!host) {
      this.index += 1;
      return;
    }
    const current = this.hostAssignments.get(host);
    const alternatives = this.profiles.filter((p) => p !== current);
    const pick = alternatives.length
      ? alternatives[Math.floor(Math.random() * alternatives.length)]
      : this.profiles[0];
    this.hostAssignments.set(host, pick);
  }

  get size() {
    return this.profiles.length;
  }
}
