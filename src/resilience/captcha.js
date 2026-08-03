/**
 * Bot-wall detection and CAPTCHA handling.
 *
 * Detection matters even if you never intend to solve anything: a challenge
 * page returns HTTP 200, so without this a scraper happily "succeeds" and
 * writes thousands of empty records. Catching it turns a silent data-quality
 * failure into a loud, actionable error.
 *
 * On handling: the honest options are (a) slow down and retry, (b) render in a
 * real browser so JS challenges resolve themselves, or (c) stop and tell the
 * operator. Automated solving of interactive CAPTCHAs is left to an explicitly
 * configured external solver — it is off by default, and many sites' terms
 * forbid it. See docs/09-compliance.md.
 */

/** Signatures keyed by vendor. Matched against body text and headers. */
const SIGNATURES = [
  {
    vendor: 'cloudflare',
    kind: 'challenge',
    body: [
      /Checking your browser before accessing/i,
      /cf-browser-verification/i,
      /Just a moment\.\.\./i,
      /challenge-platform/i,
      /__cf_chl_/i,
      /Enable JavaScript and cookies to continue/i,
    ],
    headers: { server: /cloudflare/i },
    // Cloudflare's JS challenge usually clears itself in a real browser.
    resolvableByRendering: true,
  },
  {
    vendor: 'recaptcha',
    kind: 'captcha',
    body: [/www\.google\.com\/recaptcha\//i, /grecaptcha/i, /g-recaptcha/i],
    resolvableByRendering: false,
  },
  {
    vendor: 'hcaptcha',
    kind: 'captcha',
    body: [/hcaptcha\.com\/(1\/api\.js|captcha)/i, /h-captcha/i],
    resolvableByRendering: false,
  },
  {
    vendor: 'datadome',
    kind: 'challenge',
    body: [/datadome/i, /geo\.captcha-delivery\.com/i],
    headers: { 'x-datadome': /./i },
    resolvableByRendering: true,
  },
  {
    vendor: 'perimeterx',
    kind: 'challenge',
    body: [/_pxhd|px-captcha|perimeterx/i, /Please verify you are a human/i],
    resolvableByRendering: true,
  },
  {
    vendor: 'akamai',
    kind: 'challenge',
    body: [/Access Denied.*Reference #\d/is, /_abck/i],
    resolvableByRendering: true,
  },
  {
    vendor: 'imperva',
    kind: 'challenge',
    body: [/Incapsula incident ID/i, /_Incapsula_Resource/i],
    resolvableByRendering: true,
  },
  {
    vendor: 'generic',
    kind: 'block',
    body: [
      /you (?:have been|are) blocked/i,
      /access denied/i,
      /unusual traffic from your (?:computer|network)/i,
      /are you a (?:robot|human)/i,
      /bot detection/i,
      /rate limit exceeded/i,
      /please verify you are (?:a )?human/i,
    ],
    resolvableByRendering: false,
  },
];

/**
 * Inspect a response for signs of a bot wall.
 *
 * @param {object} response `{status, headers, body, url}`
 * @param {object} [options]
 * @param {number} [options.minBodyLength=500] Bodies shorter than this on a 200
 *        are suspicious regardless of content.
 * @returns {{blocked:boolean, vendor:string|null, kind:string|null,
 *           confidence:number, signals:string[], resolvableByRendering:boolean}}
 */
export function detectBlock(response, options = {}) {
  const { minBodyLength = 500 } = options;
  const body = response?.body ?? '';
  const headers = response?.headers ?? {};
  const status = response?.status ?? 0;

  const signals = [];
  let vendor = null;
  let kind = null;
  let confidence = 0;
  let resolvableByRendering = false;

  for (const signature of SIGNATURES) {
    let matched = false;
    for (const pattern of signature.body ?? []) {
      if (pattern.test(body)) {
        signals.push(`${signature.vendor}:body:${pattern.source.slice(0, 40)}`);
        matched = true;
        break;
      }
    }
    for (const [header, pattern] of Object.entries(signature.headers ?? {})) {
      if (headers[header] && pattern.test(String(headers[header]))) {
        signals.push(`${signature.vendor}:header:${header}`);
        // A vendor header alone is weak evidence — Cloudflare fronts a large
        // share of the web without challenging anyone.
        if (matched) confidence += 0.2;
      }
    }
    if (matched) {
      vendor ??= signature.vendor;
      kind ??= signature.kind;
      confidence += signature.kind === 'captcha' ? 0.8 : 0.7;
      resolvableByRendering = resolvableByRendering || signature.resolvableByRendering;
    }
  }

  // Status-based signals.
  if (status === 403) {
    signals.push('status:403');
    confidence += 0.4;
  } else if (status === 429) {
    signals.push('status:429');
    confidence += 0.5;
    kind ??= 'rate_limited';
  } else if (status === 503 && /captcha|challenge|verify/i.test(body)) {
    signals.push('status:503+challenge_text');
    confidence += 0.5;
  }

  // A 200 with almost no content is the classic silent block.
  if (status === 200 && body.length > 0 && body.length < minBodyLength) {
    signals.push(`thin_body:${body.length}b`);
    confidence += 0.25;
  }

  confidence = Math.min(1, confidence);
  const blocked = confidence >= 0.5;

  return {
    blocked,
    vendor: blocked ? vendor ?? 'unknown' : null,
    kind: blocked ? kind ?? 'block' : null,
    confidence: +confidence.toFixed(2),
    signals,
    resolvableByRendering,
  };
}

/**
 * Coordinates the response to a detected block.
 *
 * Solver integration is deliberately an interface, not a bundled vendor client:
 * you supply `solver` (an object with `solve(task)`) and opt in explicitly.
 */
export class CaptchaHandler {
  /**
   * @param {object} [options]
   * @param {boolean} [options.detect=true]
   * @param {'retry'|'render'|'solve'|'manual'|'fail'} [options.strategy='render']
   * @param {object} [options.solver]  `{ solve({type, siteKey, url}) => token }`
   * @param {number} [options.minConfidence=0.5]
   * @param {import('../observability/logger.js').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.detect = options.detect !== false;
    this.strategy = options.strategy ?? 'render';
    this.solver = options.solver ?? null;
    this.minConfidence = options.minConfidence ?? 0.5;
    this.logger = options.logger ?? null;
    this.stats = { detected: 0, resolved: 0, failed: 0, byVendor: {} };
  }

  /**
   * @returns {{blocked:boolean, action:'continue'|'retry'|'render'|'solve'|'manual'|'fail', detection:object}}
   */
  inspect(response) {
    if (!this.detect) return { blocked: false, action: 'continue', detection: null };

    const detection = detectBlock(response);
    if (!detection.blocked || detection.confidence < this.minConfidence) {
      return { blocked: false, action: 'continue', detection };
    }

    this.stats.detected += 1;
    this.stats.byVendor[detection.vendor] = (this.stats.byVendor[detection.vendor] ?? 0) + 1;
    this.logger?.warn('bot protection detected', {
      url: response?.url,
      vendor: detection.vendor,
      kind: detection.kind,
      confidence: detection.confidence,
    });

    let action = this.strategy;
    // A JS challenge is worth rendering; an interactive CAPTCHA is not, unless
    // a solver has been configured.
    if (action === 'render' && !detection.resolvableByRendering) {
      action = this.solver ? 'solve' : 'fail';
    }
    if (action === 'solve' && !this.solver) action = 'fail';

    return { blocked: true, action, detection };
  }

  /** Find the site key so an external solver can be given a task. */
  extractChallenge(page) {
    const $ = page.$;
    const recaptcha = $('[data-sitekey]').first().attr('data-sitekey')
      ?? /['"]sitekey['"]\s*:\s*['"]([\w-]+)['"]/i.exec(page.html)?.[1];
    if (recaptcha) {
      const isH = $('.h-captcha').length > 0 || /hcaptcha/i.test(page.html);
      return { type: isH ? 'hcaptcha' : 'recaptcha_v2', siteKey: recaptcha, url: page.url };
    }
    return null;
  }

  async solve(page) {
    if (!this.solver) throw new Error('No CAPTCHA solver configured');
    const task = this.extractChallenge(page);
    if (!task) throw new Error('Could not identify the CAPTCHA challenge on this page');

    this.logger?.info('submitting CAPTCHA to the configured solver', { type: task.type, url: task.url });
    try {
      const token = await this.solver.solve(task);
      this.stats.resolved += 1;
      return { token, task };
    } catch (error) {
      this.stats.failed += 1;
      throw error;
    }
  }
}
