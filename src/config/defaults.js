/**
 * Default configuration.
 *
 * The defaults are deliberately **conservative**: one request per second per
 * host, robots.txt enforced, no proxies, no rendering unless the page needs it.
 * A recipe that says nothing about politeness is polite. Going faster is an
 * explicit choice the user makes and can be held to.
 */

export const DEFAULT_CONFIG = {
  name: 'harvest',
  description: '',

  startUrls: [],
  /** Seed the frontier from the site's sitemap.xml. `true`, or a sitemap URL. */
  sitemap: false,

  /** Global in-flight request cap. */
  concurrency: 4,
  /** Per-host in-flight cap — the one that actually protects the target. */
  concurrencyPerHost: 2,
  /** Stop after this many pages. `0` means unlimited. */
  maxPages: 0,
  /** Stop after this many items. `0` means unlimited. */
  maxItems: 0,
  /** Whole-run time budget in ms. `0` means unlimited. */
  maxRuntimeMs: 0,

  http: {
    method: 'GET',
    headers: {},
    timeoutMs: 30_000,
    connectTimeoutMs: 10_000,
    maxRedirects: 5,
    maxResponseBytes: 10 * 1024 * 1024,
    http2: false,
    rejectUnauthorized: true,
    cookies: true,
    /** Seed cookies, e.g. a session copied from your browser. */
    cookieJar: null,
  },

  identity: {
    /** 'bot' sends an honest identifying UA; 'rotate' cycles browser profiles. */
    mode: 'bot',
    userAgent: null,
    /** Contact URL or email appended to the bot UA. Strongly recommended. */
    contact: null,
    strategy: 'sticky',
    profiles: null,
    includeMobile: false,
  },

  proxy: {
    urls: [],
    file: null,
    strategy: 'round-robin',
    maxConsecutiveFailures: 3,
    benchDurationMs: 300_000,
    removeDead: false,
  },

  rateLimit: {
    requestsPerSecond: 1,
    burst: 1,
    minDelayMs: 0,
    jitterMs: 250,
    adaptive: true,
    throttlePenaltyMs: 30_000,
  },

  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    factor: 2,
    jitter: true,
    respectRetryAfter: true,
    rotateProxyOnRetry: true,
    rotateUserAgentOnRetry: true,
    escalateToBrowser: true,
  },

  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    failureRateThreshold: 0.7,
    windowSize: 20,
    minimumRequests: 10,
    resetTimeoutMs: 60_000,
  },

  robots: {
    enabled: true,
    respectCrawlDelay: true,
    userAgent: null,
    /** What to do when robots.txt can't be fetched (5xx / network error). */
    onError: 'deny',
    cacheTtlMs: 3_600_000,
  },

  render: {
    /** never | auto | always */
    mode: 'never',
    engine: 'chromium',
    headless: true,
    maxContexts: 4,
    timeoutMs: 30_000,
    waitUntil: 'domcontentloaded',
    waitForSelector: null,
    waitForTimeout: 0,
    waitForFunction: null,
    blockResources: ['image', 'media', 'font'],
    stealth: true,
    screenshot: false,
    scroll: null,
    actions: [],
  },

  cache: {
    enabled: false,
    dir: '.harvester/cache',
    ttlMs: 86_400_000,
  },

  captcha: {
    detect: true,
    /** retry | render | solve | manual | fail */
    strategy: 'render',
    minConfidence: 0.5,
    solver: null,
  },

  crawl: {
    /** Link-following rules; each entry queues matching links. */
    follow: [],
    /** Empty means "the hosts of the start URLs". */
    allowedDomains: [],
    allowPatterns: [],
    denyPatterns: [],
    maxDepth: 3,
    /** Pagination shortcut — see docs/02-recipes.md. */
    pagination: null,
    /** URL canonicalisation applied before dedupe. */
    normalization: {
      stripTracking: true,
      stripFragment: true,
      sortQuery: true,
      stripWww: false,
    },
  },

  extract: null,

  validate: {
    schema: null,
    onInvalid: 'quarantine',
    strict: false,
    minFilledFields: 0,
  },

  dedupe: {
    enabled: true,
    strategy: 'record',
    keyFields: null,
    ignoreFields: ['_scraped_at', '_url', '_depth'],
    store: 'set',
    persistPath: null,
  },

  output: [],
  /** Fields added to every record. Set to false to keep output clean. */
  metadata: {
    url: true,
    scrapedAt: true,
    depth: false,
    label: false,
  },

  storage: {
    batchSize: 100,
    flushIntervalMs: 5000,
  },

  /** Crash-safe checkpointing so an interrupted run can resume. */
  resume: {
    enabled: false,
    statePath: '.harvester/state.json',
    intervalMs: 10_000,
  },

  logging: {
    level: 'info',
    format: null,
    progress: true,
  },

  /** Write a machine-readable run report here when the run ends. */
  report: null,
};

/** Presets applied by `--preset`, layered under the recipe's own settings. */
export const PRESETS = {
  /** Fast, for sites you own or that explicitly permit heavy crawling. */
  fast: {
    concurrency: 16,
    concurrencyPerHost: 8,
    rateLimit: { requestsPerSecond: 8, burst: 8, jitterMs: 50 },
  },
  /** The default posture, stated explicitly. */
  polite: {
    concurrency: 4,
    concurrencyPerHost: 2,
    rateLimit: { requestsPerSecond: 1, burst: 1, jitterMs: 250 },
  },
  /** For fragile or aggressively protected targets. */
  careful: {
    concurrency: 2,
    concurrencyPerHost: 1,
    rateLimit: { requestsPerSecond: 0.33, burst: 1, minDelayMs: 3000, jitterMs: 1500 },
    retry: { maxAttempts: 5, baseDelayMs: 5000 },
  },
  /** JavaScript-heavy sites. */
  spa: {
    render: { mode: 'always', waitUntil: 'networkidle' },
    concurrency: 2,
    concurrencyPerHost: 1,
    rateLimit: { requestsPerSecond: 0.5, burst: 1 },
  },
  /** Iterating on selectors: cache everything, small run, verbose. */
  develop: {
    maxPages: 5,
    concurrency: 1,
    cache: { enabled: true },
    logging: { level: 'debug' },
  },
};
