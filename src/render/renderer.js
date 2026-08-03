/**
 * Headless-browser rendering, backed by Playwright.
 *
 * Playwright is an **optional** dependency. Everything else in this framework
 * works without it; the import happens lazily the first time a page actually
 * needs JavaScript, and the error message tells you exactly what to install.
 *
 * Design points worth knowing:
 *  - **One browser, many contexts.** A context is a clean profile (own cookies,
 *    own cache) and costs milliseconds; a browser costs ~300 ms and ~100 MB.
 *    Contexts are pooled per identity so concurrency is cheap.
 *  - **Resource blocking is on by default.** Images, fonts and media are ~70 %
 *    of page weight and never contain the data you want. Blocking them makes
 *    rendering roughly 3× faster and is far gentler on the target's bandwidth.
 *  - **`auto` mode renders only when needed** — see `needsRendering()`.
 */

import { RenderError } from '../utils/errors.js';
import { sleep } from '../utils/async.js';

let playwrightModule;

/** Lazily import Playwright with a helpful error if it isn't installed. */
async function loadPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch (error) {
    throw new RenderError(
      'Dynamic rendering requires Playwright, which is not installed.\n' +
      '  Install it with:  npm install playwright && npx playwright install chromium\n' +
      '  Or set `render.mode: never` in your recipe to use the HTTP engine only.',
      // `fatal` stops the run: every other URL would fail identically.
      { cause: error, retryable: false, fatal: true },
    );
  }
}

/** Resource types blocked by default — none of them carry extractable data. */
const DEFAULT_BLOCKED = ['image', 'media', 'font'];

/** Third-party hosts that only slow a render down. */
const DEFAULT_BLOCKED_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'facebook.com/tr', 'hotjar.com', 'segment.io',
  'amplitude.com', 'mixpanel.com', 'newrelic.com', 'sentry.io',
  'adservice.google.com', 'scorecardresearch.com', 'quantserve.com',
];

/**
 * Heuristic for `render.mode: auto`: does this HTML need JavaScript?
 *
 * Rendering every page "just in case" is slow and wasteful; never rendering
 * breaks on SPAs. This checks the cheap HTML response first and only escalates
 * when the evidence says the content isn't there.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.contentSelector] If given, the decisive test is
 *        simply whether this selector already matched.
 * @param {boolean} [options.contentFound]
 * @returns {{needed:boolean, reason:string}}
 */
export function needsRendering(html, options = {}) {
  const { contentSelector, contentFound } = options;

  // The strongest possible signal: we asked for the content and it was there.
  if (contentSelector != null) {
    return contentFound
      ? { needed: false, reason: 'content_present_in_html' }
      : { needed: true, reason: 'content_selector_did_not_match' };
  }

  if (typeof html !== 'string' || html.length === 0) {
    return { needed: true, reason: 'empty_response' };
  }

  // Strip the parts that aren't rendered content, then see what's left.
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (visible.length < 200) {
    return { needed: true, reason: `thin_rendered_text:${visible.length}chars` };
  }

  // Framework root elements that are empty in the served HTML.
  const emptyRoot = /<(?:div|main)[^>]*\bid=["'](?:root|app|__next|__nuxt|q-app|ember-app)["'][^>]*>\s*<\/(?:div|main)>/i;
  if (emptyRoot.test(html)) {
    return { needed: true, reason: 'empty_spa_root_element' };
  }

  // `<noscript>` telling the user to enable JavaScript.
  if (/<noscript>[\s\S]{0,400}?(enable|turn on|requires?)\s+javascript/i.test(html)) {
    return { needed: true, reason: 'noscript_javascript_required' };
  }

  return { needed: false, reason: 'static_html_sufficient' };
}

export class Renderer {
  /**
   * @param {object} [options]
   * @param {'chromium'|'firefox'|'webkit'} [options.engine='chromium']
   * @param {boolean} [options.headless=true]
   * @param {number}  [options.maxContexts=4]     Concurrent browser contexts.
   * @param {string[]}[options.blockResources]
   * @param {number}  [options.timeoutMs=30000]
   * @param {boolean} [options.stealth=true]      Patch the obvious automation tells.
   * @param {string}  [options.executablePath]
   * @param {object}  [options.logger]
   */
  constructor(options = {}) {
    this.options = {
      engine: options.engine ?? 'chromium',
      headless: options.headless !== false,
      maxContexts: options.maxContexts ?? 4,
      blockResources: options.blockResources ?? DEFAULT_BLOCKED,
      blockHosts: options.blockHosts ?? DEFAULT_BLOCKED_HOSTS,
      timeoutMs: options.timeoutMs ?? 30_000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? options.timeoutMs ?? 30_000,
      stealth: options.stealth !== false,
      executablePath: options.executablePath ?? null,
      args: options.args ?? [],
      slowMo: options.slowMo ?? 0,
      locale: options.locale ?? 'en-US',
      timezone: options.timezone ?? null,
      ignoreHttpsErrors: options.ignoreHttpsErrors === true,
    };
    this.logger = options.logger ?? null;

    this.browser = null;
    /** @type {Map<string, import('playwright').BrowserContext>} */
    this.contexts = new Map();
    this.launching = null;
    this.stats = { launched: 0, rendered: 0, failed: 0, contextsCreated: 0 };
  }

  get isRunning() {
    return this.browser != null && this.browser.isConnected();
  }

  async launch() {
    if (this.isRunning) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const playwright = await loadPlaywright();
      const engine = playwright[this.options.engine];
      if (!engine) throw new RenderError(`Unknown browser engine '${this.options.engine}'`);

      const args = [...this.options.args];
      if (this.options.engine === 'chromium') {
        args.push(
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-gpu',
        );
      }

      try {
        this.browser = await engine.launch({
          headless: this.options.headless,
          executablePath: this.options.executablePath ?? undefined,
          args,
          slowMo: this.options.slowMo,
        });
      } catch (error) {
        throw new RenderError(
          `Could not launch ${this.options.engine}. If Playwright is installed but its browsers are not, run:\n` +
          `  npx playwright install ${this.options.engine}`,
          { cause: error, retryable: false, fatal: true },
        );
      }

      this.stats.launched += 1;
      this.logger?.debug('browser launched', { engine: this.options.engine, headless: this.options.headless });
      return this.browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Get (or create) a context for an identity. Contexts are keyed so that
   * requests sharing a proxy + user-agent also share cookies, like a session.
   */
  async getContext(key = 'default', contextOptions = {}) {
    const existing = this.contexts.get(key);
    if (existing) return existing;

    await this.launch();

    // Evict the oldest context once the pool is full.
    if (this.contexts.size >= this.options.maxContexts) {
      const [oldestKey, oldest] = this.contexts.entries().next().value;
      this.contexts.delete(oldestKey);
      await oldest.close().catch(() => {});
    }

    const context = await this.browser.newContext({
      userAgent: contextOptions.userAgent,
      viewport: contextOptions.viewport ?? { width: 1920, height: 1080 },
      locale: contextOptions.locale ?? this.options.locale,
      timezoneId: contextOptions.timezone ?? this.options.timezone ?? undefined,
      proxy: contextOptions.proxy ? parseProxyForPlaywright(contextOptions.proxy) : undefined,
      ignoreHTTPSErrors: this.options.ignoreHttpsErrors,
      extraHTTPHeaders: contextOptions.headers ?? undefined,
      isMobile: contextOptions.isMobile ?? undefined,
      deviceScaleFactor: contextOptions.isMobile ? 3 : 1,
      javaScriptEnabled: true,
    });

    context.setDefaultTimeout(this.options.timeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

    if (contextOptions.cookies?.length) {
      await context.addCookies(contextOptions.cookies).catch(() => {});
    }

    if (this.options.stealth) await applyStealth(context);

    // Resource blocking, applied at the context level so it covers every page.
    const blocked = new Set(this.options.blockResources);
    const blockedHosts = this.options.blockHosts;
    if (blocked.size || blockedHosts.length) {
      await context.route('**/*', (route) => {
        const request = route.request();
        if (blocked.has(request.resourceType())) return route.abort();
        const url = request.url();
        if (blockedHosts.some((host) => url.includes(host))) return route.abort();
        return route.continue();
      });
    }

    this.contexts.set(key, context);
    this.stats.contextsCreated += 1;
    return context;
  }

  /**
   * Render a URL and return the final HTML.
   *
   * @param {object} params
   * @param {string} params.url
   * @param {string} [params.waitUntil='domcontentloaded']
   * @param {string} [params.waitForSelector]
   * @param {number} [params.waitForTimeout]  Fixed extra wait, ms.
   * @param {object[]} [params.actions]       Interaction script (see `runActions`).
   * @param {object} [params.scroll]          `{enabled, maxScrolls, delayMs}`
   * @param {string} [params.contextKey]
   * @param {object} [params.contextOptions]
   * @param {boolean}[params.screenshot]
   * @returns {Promise<{html:string, url:string, status:number, headers:object,
   *          title:string, cookies:any[], screenshot?:Buffer, durationMs:number}>}
   */
  async render(params) {
    const {
      url,
      waitUntil = 'domcontentloaded',
      waitForSelector = null,
      waitForTimeout = 0,
      waitForFunction = null,
      actions = [],
      scroll = null,
      contextKey = 'default',
      contextOptions = {},
      screenshot = false,
      referer = null,
    } = params;

    const started = performance.now();
    const context = await this.getContext(contextKey, contextOptions);
    const page = await context.newPage();

    try {
      const response = await page.goto(url, {
        waitUntil,
        timeout: this.options.navigationTimeoutMs,
        referer: referer ?? undefined,
      });

      if (waitForSelector) {
        try {
          await page.waitForSelector(waitForSelector, { timeout: this.options.timeoutMs, state: 'attached' });
        } catch {
          // Not fatal: the extractor will report the missing field, which is a
          // clearer error than "render timed out".
          this.logger?.debug('waitForSelector timed out', { url, selector: waitForSelector });
        }
      }

      if (waitForFunction) {
        await page.waitForFunction(waitForFunction, { timeout: this.options.timeoutMs }).catch(() => {});
      }

      if (scroll?.enabled) await autoScroll(page, scroll);
      if (actions.length) await runActions(page, actions, this.logger);
      if (waitForTimeout > 0) await sleep(waitForTimeout);

      const html = await page.content();
      const result = {
        html,
        url: page.url(),
        status: response?.status() ?? 200,
        headers: response ? await response.allHeaders().catch(() => ({})) : {},
        title: await page.title().catch(() => ''),
        cookies: await context.cookies().catch(() => []),
        durationMs: +(performance.now() - started).toFixed(1),
        rendered: true,
      };

      if (screenshot) {
        result.screenshot = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
      }

      this.stats.rendered += 1;
      return result;
    } catch (error) {
      this.stats.failed += 1;
      throw new RenderError(`Failed to render ${url}: ${error.message}`, { cause: error, url });
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Drop a context — used after a block, to shed a burned fingerprint. */
  async resetContext(key = 'default') {
    const context = this.contexts.get(key);
    if (!context) return;
    this.contexts.delete(key);
    await context.close().catch(() => {});
  }

  async close() {
    for (const context of this.contexts.values()) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

/* ─────────────────────────── page interaction ───────────────────────────── */

/**
 * Run a declarative interaction script. Every action supports `optional: true`,
 * because "click the cookie banner if it appears" is the single most common
 * requirement and it must not fail the page when the banner doesn't.
 *
 * Supported: `click`, `type`, `fill`, `select`, `press`, `wait`,
 * `waitForSelector`, `scroll`, `hover`, `evaluate`, `screenshot`.
 */
export async function runActions(page, actions, logger = null) {
  for (const [index, action] of actions.entries()) {
    const label = `${action.type}${action.selector ? ` ${action.selector}` : ''}`;
    try {
      switch (action.type) {
        case 'click':
          if (action.optional) {
            const el = await page.$(action.selector);
            if (!el) break;
          }
          await page.click(action.selector, { timeout: action.timeout ?? 10_000, force: action.force ?? false });
          break;
        case 'type':
          await page.type(action.selector, String(action.value ?? ''), { delay: action.delay ?? 50 });
          break;
        case 'fill':
          await page.fill(action.selector, String(action.value ?? ''), { timeout: action.timeout ?? 10_000 });
          break;
        case 'select':
          await page.selectOption(action.selector, action.value);
          break;
        case 'press':
          await page.press(action.selector ?? 'body', action.key ?? 'Enter');
          break;
        case 'hover':
          await page.hover(action.selector, { timeout: action.timeout ?? 10_000 });
          break;
        case 'wait':
          await sleep(action.ms ?? 1000);
          break;
        case 'waitForSelector':
          await page.waitForSelector(action.selector, {
            timeout: action.timeout ?? 15_000,
            state: action.state ?? 'visible',
          });
          break;
        case 'waitForNavigation':
          await page.waitForLoadState(action.state ?? 'networkidle', { timeout: action.timeout ?? 15_000 });
          break;
        case 'scroll':
          await autoScroll(page, { maxScrolls: action.times ?? 5, delayMs: action.delay ?? 500 });
          break;
        case 'evaluate':
          await page.evaluate(action.script);
          break;
        case 'clickAll': {
          // Repeatedly click a "load more" button until it disappears.
          const limit = action.limit ?? 20;
          for (let i = 0; i < limit; i += 1) {
            const el = await page.$(action.selector);
            if (!el) break;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) break;
            await el.click({ timeout: 5000 }).catch(() => {});
            await sleep(action.delay ?? 1000);
          }
          break;
        }
        default:
          logger?.warn('unknown render action, skipping', { type: action.type, index });
      }
    } catch (error) {
      if (action.optional) {
        logger?.debug('optional action skipped', { action: label, error: error.message });
        continue;
      }
      throw new RenderError(`Action ${index + 1} (${label}) failed: ${error.message}`, { cause: error });
    }
  }
}

/**
 * Scroll to the bottom, waiting for lazily-loaded content between steps.
 * Stops early once the page height stops growing.
 */
export async function autoScroll(page, { maxScrolls = 10, delayMs = 500, stepPx = null } = {}) {
  let previousHeight = 0;
  for (let i = 0; i < maxScrolls; i += 1) {
    const height = await page.evaluate((step) => {
      window.scrollBy(0, step ?? window.innerHeight);
      return document.body.scrollHeight;
    }, stepPx);
    await sleep(delayMs);
    if (height === previousHeight) break;
    previousHeight = height;
  }
  return previousHeight;
}

/**
 * Remove the most obvious automation tells.
 *
 * This is not a full anti-detection suite and does not claim to be. It fixes
 * the handful of properties that differ between a plain Playwright context and
 * a real browser, which is enough for sites doing basic checks.
 */
async function applyStealth(context) {
  await context.addInitScript(() => {
    // `navigator.webdriver` is true under automation.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Headless Chromium reports zero plugins and no languages.
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // `window.chrome` is absent in headless builds.
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    }

    // Permissions.query reports 'denied' for notifications under automation.
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  }).catch(() => {
    // Init scripts are unsupported on some engines/versions; not fatal.
  });
}

/** Convert a proxy URL into Playwright's `{server, username, password}` shape. */
function parseProxyForPlaywright(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    const proxy = { server: `${url.protocol}//${url.host}` };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch {
    return undefined;
  }
}

export function createRenderer(options) {
  return new Renderer(options);
}
