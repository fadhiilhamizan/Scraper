/**
 * The orchestrator.
 *
 * Owns the run loop and wires every subsystem together. The processing order
 * for a single URL is fixed and deliberate:
 *
 *   robots.txt → rate limit → cache → fetch (HTTP, escalating to a browser)
 *   → block detection → parse → extract → validate → deduplicate → hooks
 *   → write, and separately: discover links → enqueue
 *
 * Compliance comes first because a URL we may not fetch should cost nothing,
 * and deduplication comes before the sink so a duplicate never touches disk.
 */

import { EventEmitter } from 'node:events';

import { HttpClient } from '../http/client.js';
import { CookieJar } from '../http/cookies.js';
import { ProxyPool } from '../http/proxy.js';
import { UserAgentRotator, botUserAgent } from '../http/useragent.js';
import { buildHeaders } from '../http/headers.js';
import { HttpCache } from '../http/cache.js';

import { RobotsManager } from '../compliance/robots.js';
import { SitemapReader } from '../compliance/sitemap.js';

import { RateLimiter, parseRetryAfter } from '../resilience/ratelimiter.js';
import { RetryPolicy } from '../resilience/retry.js';
import { CircuitBreaker } from '../resilience/circuitbreaker.js';
import { CaptchaHandler } from '../resilience/captcha.js';

import { Renderer, needsRendering } from '../render/renderer.js';

import { Page } from '../parse/dom.js';
import { extractItems } from '../parse/extractor.js';
import { discoverLinks } from '../parse/pagination.js';

import { Deduplicator } from '../process/dedupe.js';
import { Validator } from '../process/validate.js';

import { MultiWriter, BufferedSink, NdjsonWriter } from '../storage/index.js';

import { Frontier } from '../queue/frontier.js';
import { RunState } from '../queue/state.js';
import { getHostname, shortenUrl } from '../queue/urlutils.js';

import { Pipeline } from './pipeline.js';
import { buildReport } from './report.js';

import { createLogger, nullLogger } from '../observability/logger.js';
import { Metrics } from '../observability/metrics.js';
import { ProgressReporter } from '../observability/progress.js';

import { sleep, deferred } from '../utils/async.js';
import {
  BlockedError, DisallowedError, CircuitOpenError, HttpError,
  toHarvesterError,
} from '../utils/errors.js';

/**
 * How long an idle worker parks when no host has capacity. Only another worker
 * finishing can help, and that fires a wake — so this is purely a safety net
 * against a missed signal, not a poll interval.
 */
const IDLE_SAFETY_MS = 1000;

export class Scraper extends EventEmitter {
  /**
   * @param {object} config   A normalised config (see `config/schema.js`).
   * @param {object} [options]
   * @param {object} [options.hooks]
   * @param {object} [options.logger]
   */
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.logger = options.logger ?? createLogger({
      level: config.logging?.level ?? 'info',
      format: config.logging?.format,
    });

    this.metrics = new Metrics();
    this.pipeline = new Pipeline(options.hooks ?? {}, { logger: this.logger });

    this.abortController = new AbortController();
    this.stopping = false;
    this.stopReason = null;
    this.startedAt = null;
    this.finishedAt = null;

    /** Per-field extraction health, for the "did the site change?" report. */
    this.fieldStats = new Map();
    /** Non-fatal problems worth surfacing at the end. */
    this.warnings = [];

    this.#buildSubsystems();
  }

  #buildSubsystems() {
    const c = this.config;

    this.httpClient = new HttpClient({
      timeoutMs: c.http.timeoutMs,
      connectTimeoutMs: c.http.connectTimeoutMs,
      maxRedirects: c.http.maxRedirects,
      maxResponseBytes: c.http.maxResponseBytes,
      http2: c.http.http2,
      rejectUnauthorized: c.http.rejectUnauthorized,
      maxConnectionsPerHost: Math.max(2, c.concurrencyPerHost * 2),
    });

    this.cookieJar = new CookieJar({ enabled: c.http.cookies !== false });
    if (c.http.cookieJar && c.startUrls[0]) {
      this.cookieJar.loadFromObject(c.http.cookieJar, c.startUrls[0].url);
    }

    this.proxyPool = new ProxyPool({
      proxies: c.proxy.urls ?? [],
      strategy: c.proxy.strategy,
      maxConsecutiveFailures: c.proxy.maxConsecutiveFailures,
      benchDurationMs: c.proxy.benchDurationMs,
      removeDead: c.proxy.removeDead,
    });

    this.userAgent = c.identity.userAgent
      ?? botUserAgent({ name: 'Harvester', version: '1.0', contact: c.identity.contact });

    this.uaRotator = new UserAgentRotator({
      strategy: c.identity.strategy,
      userAgents: c.identity.mode === 'rotate' ? null : [this.userAgent],
      include: c.identity.profiles,
      mobile: c.identity.includeMobile,
    });

    this.cache = new HttpCache({
      enabled: c.cache.enabled,
      dir: c.cache.dir,
      ttlMs: c.cache.ttlMs,
    });

    this.robots = new RobotsManager({
      httpClient: this.httpClient,
      userAgent: c.robots.userAgent,
      enabled: c.robots.enabled,
      respectCrawlDelay: c.robots.respectCrawlDelay,
      onFetchError: c.robots.onError,
      cacheTtlMs: c.robots.cacheTtlMs,
      logger: this.logger,
    });

    this.rateLimiter = new RateLimiter(c.rateLimit);
    this.retryPolicy = new RetryPolicy(c.retry);
    this.circuitBreaker = new CircuitBreaker(c.circuitBreaker);
    this.captcha = new CaptchaHandler({ ...c.captcha, logger: this.logger });

    this.renderer = c.render.mode === 'never'
      ? null
      : new Renderer({ ...c.render, logger: this.logger });

    this.frontier = new Frontier({
      maxPages: c.maxPagesEffective,
      urlNormalization: c.crawl?.normalization ?? {},
    });

    this.dedupe = new Deduplicator(c.dedupe);
    this.validator = new Validator(c.validate);

    this.writer = new MultiWriter(c.output ?? [], { logger: this.logger });
    this.sink = new BufferedSink(this.writer, c.storage);
    this.quarantineWriter = null;

    this.runState = new RunState({ ...c.resume, logger: this.logger });

    /** @type {Map<string, number>} host -> in-flight count */
    this.hostActive = new Map();

    this.progress = new ProgressReporter({
      enabled: c.logging?.progress !== false && process.stderr.isTTY && c.logging?.format !== 'json',
      logger: this.logger,
    });

    this.seedHosts = c.startUrls
      .map((s) => getHostname(s.url))
      .filter(Boolean);

    this.counters = {
      itemsExtracted: 0, itemsWritten: 0, itemsDuplicate: 0, itemsInvalid: 0,
      pagesOk: 0, pagesFailed: 0, pagesSkipped: 0, pagesRendered: 0, pagesFromCache: 0,
      requestsBlocked: 0, robotsBlocked: 0,
    };
    /** Counters carried over from an earlier, resumed session. */
    this.resumedFrom = null;
  }

  /** Workers parked waiting for work. @type {Set<{promise:Promise, resolve:Function}>} */
  #idleWaiters = new Set();

  /* ────────────────────────────── public API ───────────────────────────── */

  /**
   * Run the scrape to completion.
   * @returns {Promise<object>} the run report
   */
  async run() {
    this.startedAt = Date.now();
    this.logger.info('run starting', {
      name: this.config.name,
      startUrls: this.config.startUrls.length,
      concurrency: this.config.concurrency,
      render: this.config.render.mode,
      robots: this.config.robots.enabled ? 'enforced' : 'DISABLED',
    });

    if (!this.config.robots.enabled) {
      this.warnings.push(
        'robots.txt enforcement is disabled. You are responsible for ensuring this crawl is authorised.',
      );
    }

    await this.pipeline.emit('onRunStart', this.config, this.#context());

    try {
      await this.#setup();
      await this.#seed();
      await this.#runWorkers();
    } catch (error) {
      this.stopReason ??= `fatal: ${error.message}`;
      this.logger.error('run aborted', { error: error.message, stack: error.stack });
      await this.#teardown();
      throw error;
    }

    const report = await this.#teardown();
    await this.pipeline.emit('onRunEnd', report);
    return report;
  }

  /** Ask the run to wind down. In-flight requests finish; nothing new starts. */
  stop(reason = 'stopped by caller') {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.logger.warn('stopping', { reason });
    this.emit('stopping', reason);
    // Parked workers must re-check `#shouldStop()` now, not after their timeout.
    this.#wake();
  }

  /** Stop now, aborting in-flight requests too. */
  abort(reason = 'aborted') {
    this.stop(reason);
    this.abortController.abort();
  }

  /* ──────────────────────────────── setup ──────────────────────────────── */

  async #setup() {
    if (this.config.proxy.file) {
      const fs = await import('node:fs/promises');
      try {
        const text = await fs.readFile(this.config.proxy.file, 'utf8');
        const loaded = ProxyPool.fromList(text, this.config.proxy);
        this.proxyPool = loaded;
        this.logger.info('proxy list loaded', { file: this.config.proxy.file, count: loaded.size });
      } catch (error) {
        this.warnings.push(`Could not read proxy file ${this.config.proxy.file}: ${error.message}`);
      }
    }
    if (this.proxyPool.enabled) {
      this.logger.info('proxy rotation active', {
        proxies: this.proxyPool.size, strategy: this.proxyPool.strategy,
      });
    }

    await this.cache.init();
    if (this.config.dedupe.persistPath) {
      const loaded = await this.dedupe.load();
      if (loaded) this.logger.info('loaded previously seen records', { count: loaded });
      if (this.dedupe.incompatibleStore) {
        this.logger.warn(this.dedupe.incompatibleStore.message);
        this.warnings.push(this.dedupe.incompatibleStore.message);
      }
    }

    await this.sink.open();

    if (this.config.resume?.enabled) {
      const state = await this.runState.load();
      if (state) {
        const check = this.runState.verify(state, this.config);
        if (check.ok) {
          this.frontier.restore(state.frontier);
          if (state.cookies) this.cookieJar = CookieJar.fromJSON(state.cookies);
          // Counters stay session-scoped so the report's rates and latencies
          // describe the work this process actually did. Earlier sessions are
          // reported separately, under `report.resumed`.
          this.resumedFrom = state.counters ?? null;
          this.logger.info('resumed from checkpoint', {
            pending: this.frontier.size,
            completed: this.frontier.completed.size,
            savedAt: state.savedAt,
          });
        } else {
          this.warnings.push(check.reason);
          this.logger.warn('checkpoint rejected', { reason: check.reason });
        }
      }
      this.runState.start(() => this.#snapshot(), this.config);
    }

    this.progress.start({
      total: Number.isFinite(this.config.maxPagesEffective) ? this.config.maxPagesEffective : null,
    });
  }

  async #seed() {
    // Only seed when we didn't resume into a populated frontier.
    if (this.frontier.size > 0) return;

    let seeded = 0;
    for (const entry of this.config.startUrls) {
      if (this.frontier.add({
        url: entry.url,
        label: entry.label ?? 'default',
        depth: 0,
        priority: 0,
        method: entry.method ?? this.config.http.method,
        headers: entry.headers,
        body: entry.body,
        meta: entry.meta ?? {},
        render: entry.render,
      })) seeded += 1;
    }

    if (this.config.sitemap) {
      const reader = new SitemapReader({
        httpClient: this.httpClient,
        userAgent: this.userAgent,
        logger: this.logger,
        maxUrls: Number.isFinite(this.config.maxPagesEffective) ? this.config.maxPagesEffective : 50_000,
      });

      const sources = typeof this.config.sitemap === 'string'
        ? [this.config.sitemap]
        : await reader.discover(new URL(this.config.startUrls[0].url).origin, this.robots);

      if (sources.length === 0) {
        this.warnings.push('sitemap seeding was requested but no sitemap could be found.');
      } else {
        const entries = await reader.read(sources);
        const label = this.config.startUrls[0]?.label ?? 'default';
        let added = 0;
        for (const entry of entries) {
          if (this.frontier.add({ url: entry.url, label, depth: 0, priority: 1, meta: { lastmod: entry.lastmod } })) {
            added += 1;
          }
        }
        seeded += added;
        this.logger.info('seeded from sitemap', { sitemaps: sources.length, urls: added });
      }
    }

    this.logger.info('frontier seeded', { urls: seeded });
    if (seeded === 0) this.warnings.push('No URLs were queued — check `start_urls`.');
  }

  /* ──────────────────────────── the run loop ───────────────────────────── */

  async #runWorkers() {
    const workerCount = Math.max(1, this.config.concurrency);
    const workers = Array.from({ length: workerCount }, (_, i) => this.#worker(i));
    await Promise.all(workers);
  }

  async #worker(id) {
    const log = this.logger.child({ worker: id });

    while (!this.#shouldStop()) {
      const request = this.#checkout();

      if (!request) {
        // Nothing available right now. If the frontier is genuinely empty and
        // no peer is working, there is nothing left to produce more work.
        if (this.frontier.drained) break;
        await this.#parkUntilWork();
        continue;
      }

      try {
        await this.#process(request, log);
      } catch (error) {
        // #process handles its own errors; anything here is a bug.
        log.error('unhandled worker error', { url: request.url, error: error.message, stack: error.stack });
        this.frontier.markFailed(request, error);
      } finally {
        this.#releaseHost(request.url);
        // A slot just freed up — a peer may be parked waiting for exactly this.
        this.#wake();
      }
    }
  }

  /**
   * Sleep until there is plausibly work to do.
   *
   * This used to be a flat 50 ms poll, which meant that on a single-host crawl
   * every worker beyond `concurrency_per_host` spun at 20 Hz for the entire run
   * doing nothing. Parking on a promise costs nothing and makes idle time
   * measurable instead of an artefact of the poll interval.
   *
   * The wait is chosen by *why* there is no work. If some host has capacity and
   * is merely rate-limited, sleep exactly until it is ready. If no host has
   * capacity, only another worker finishing can help — park on the wake signal,
   * with a timeout as a safety net so a missed wake degrades to a slow poll
   * rather than a hang.
   */
  async #parkUntilWork() {
    const canTake = (host) => this.circuitBreaker.canRequest(host)
      && (this.hostActive.get(host) ?? 0) < this.config.concurrencyPerHost;

    const withCapacity = this.frontier.pendingHosts.filter(canTake);
    const waitMs = withCapacity.length
      ? Math.max(1, this.rateLimiter.minDelayAcrossHosts(withCapacity))
      : IDLE_SAFETY_MS;

    const started = performance.now();
    const waiter = deferred();
    this.#idleWaiters.add(waiter);
    const timer = setTimeout(() => waiter.resolve(), waitMs);

    try {
      await waiter.promise;
    } finally {
      clearTimeout(timer);
      this.#idleWaiters.delete(waiter);
      this.metrics.observe('worker_idle_ms', performance.now() - started);
    }
  }

  /** Release every parked worker — new work arrived, or a slot freed up. */
  #wake() {
    if (this.#idleWaiters.size === 0) return;
    for (const waiter of this.#idleWaiters) waiter.resolve();
    this.#idleWaiters.clear();
  }

  #shouldStop() {
    if (this.stopping) return true;
    // The cap is on the job as a whole, so a resumed run counts what earlier
    // sessions already wrote.
    const writtenTotal = this.counters.itemsWritten + (this.resumedFrom?.itemsWritten ?? 0);
    if (writtenTotal >= this.config.maxItemsEffective) {
      this.stop(`reached max_items (${this.config.maxItems})`);
      return true;
    }
    if (this.config.maxRuntimeMs > 0 && Date.now() - this.startedAt > this.config.maxRuntimeMs) {
      this.stop(`reached max_runtime_ms (${this.config.maxRuntimeMs})`);
      return true;
    }
    if (this.circuitBreaker.allOpen() && this.frontier.inFlight.size === 0) {
      this.stop('every target host has an open circuit — all of them are failing');
      return true;
    }
    return false;
  }

  /** Take the next request this worker is allowed to run, or null. */
  #checkout() {
    const canTake = (host) => {
      if (!this.circuitBreaker.canRequest(host)) return false;
      return (this.hostActive.get(host) ?? 0) < this.config.concurrencyPerHost;
    };

    // Prefer a host that is ready *now*, so workers aren't parked on a slow
    // domain while another has capacity.
    let request = this.frontier.next((host) => canTake(host) && this.rateLimiter.isReady(host));
    request ??= this.frontier.next(canTake);
    if (!request) return null;

    const host = getHostname(request.url) ?? '_unknown';
    this.hostActive.set(host, (this.hostActive.get(host) ?? 0) + 1);
    return request;
  }

  #releaseHost(url) {
    const host = getHostname(url) ?? '_unknown';
    const count = (this.hostActive.get(host) ?? 1) - 1;
    if (count <= 0) this.hostActive.delete(host);
    else this.hostActive.set(host, count);
  }

  /* ─────────────────────── processing a single URL ─────────────────────── */

  async #process(request, log) {
    const host = getHostname(request.url) ?? '_unknown';
    const started = performance.now();

    this.progress.setCurrent(request.url);

    try {
      // 1. Hooks may rewrite or drop the request.
      const gated = await this.pipeline.transform('onRequest', request, this.#context());
      if (gated === null) {
        this.counters.pagesSkipped += 1;
        this.frontier.markCompleted(request);
        return;
      }
      Object.assign(request, gated);

      // 2. robots.txt — before any bytes are requested.
      if (this.config.robots.enabled) {
        const verdict = await this.metrics.time('robots_ms', () => this.robots.check(request.url));
        if (verdict.crawlDelay != null && !this.config.robots.ignoreCrawlDelay) {
          this.rateLimiter.setCrawlDelay(host, verdict.crawlDelay);
        }
        if (!verdict.allowed) {
          this.counters.robotsBlocked += 1;
          this.counters.pagesSkipped += 1;
          this.metrics.increment('robots_disallowed');
          log.debug('skipped by robots.txt', { url: shortenUrl(request.url), rule: verdict.reason });
          this.frontier.markCompleted(request);
          this.emit('skipped', { request, reason: 'robots', detail: verdict.reason });
          return;
        }
      }

      // 3. Politeness delay. Timed separately from everything else — on a
      // polite run this is the overwhelming majority of wall time, and saying
      // so plainly is the whole point of the timing report.
      await this.metrics.time(
        'wait_ratelimit_ms',
        () => this.rateLimiter.acquire(host, this.abortController.signal),
      );

      // 4. Fetch, with retries and identity rotation.
      const response = await this.#fetchWithRetry(request, log);

      this.metrics.increment('requests_total');
      this.metrics.recordHost(host, 'requests');
      this.metrics.recordHost(host, 'bytes', response.bytes ?? 0);
      this.metrics.recordHost(host, 'totalMs', response.durationMs ?? 0);
      this.metrics.observe('request_duration_ms', response.durationMs ?? 0);
      // Cache hits report durationMs 0; keeping them out of `net_ms` stops a
      // cached run from looking like an impossibly fast network.
      if (!response.fromCache) {
        this.metrics.observe('net_ms', response.durationMs ?? 0);
        if (response.rendered) this.metrics.observe('render_ms', response.durationMs ?? 0);
      }

      if (response.fromCache) this.counters.pagesFromCache += 1;
      // "Rendered" counts browsers actually launched. A cached body that a
      // browser produced earlier costs nothing now, and counting it would make
      // a fully-cached run look as expensive as the one that populated it.
      if (response.rendered && !response.fromCache) this.counters.pagesRendered += 1;

      // 5. Parse and extract.
      await this.#handleResponse(request, response, log);

      this.counters.pagesOk += 1;
      this.metrics.recordHost(host, 'ok');
      this.circuitBreaker.onSuccess(host);
      this.frontier.markCompleted(request);
    } catch (rawError) {
      const error = toHarvesterError(rawError);
      this.counters.pagesFailed += 1;
      this.metrics.increment('requests_failed');
      this.metrics.recordHost(host, 'failed');

      if (error.code === 'BLOCKED') {
        this.counters.requestsBlocked += 1;
        this.metrics.recordHost(host, 'blocked');
      }

      if (!(error instanceof DisallowedError) && !(error instanceof CircuitOpenError)) {
        const transition = this.circuitBreaker.onFailure(host, error);
        if (transition.transitioned === 'open') {
          this.logger.warn('circuit opened — pausing this host', {
            host, reason: transition.reason, failureRate: transition.failureRate,
          });
          this.warnings.push(`Host ${host} started failing consistently and was paused (${transition.reason}).`);
        }
      }

      this.frontier.markFailed(request, error);
      log.warn('request failed', {
        url: shortenUrl(request.url),
        code: error.code,
        status: error.status,
        attempts: request.attempts,
        error: error.message,
      });

      this.emit('requestFailed', error, request);
      // EventEmitter re-throws `error` when nothing is listening. A failed
      // request is routine, so only emit it when someone asked to hear about it.
      if (this.listenerCount('error') > 0) this.emit('error', error, request);

      await this.pipeline.emit('onError', error, { ...this.#context(), request });

      // Some failures will repeat identically for every remaining URL (a
      // missing browser, an unusable output). Burning the whole frontier on
      // them helps nobody.
      if (error.fatal) {
        this.stop(`unrecoverable: ${error.message.split('\n')[0]}`);
        this.warnings.push(error.message);
      }
    } finally {
      // Gated: without this the snapshot was computed on every page even under
      // `--json` and in CI, where the progress renderer discards it.
      if (this.progress.enabled) this.progress.update(this.#progressSnapshot());
      this.metrics.observe('page_total_ms', performance.now() - started);
    }
  }

  /**
   * Fetch a URL, retrying with the adjustments the retry policy asks for
   * (new proxy, new user-agent, escalate to a browser).
   */
  async #fetchWithRetry(request, log) {
    let attempt = 0;
    let adjust = {};
    const host = getHostname(request.url) ?? '_unknown';

    for (;;) {
      attempt += 1;
      request.attempts = attempt;

      if (!this.circuitBreaker.canRequest(host)) {
        throw new CircuitOpenError(`Circuit is open for ${host}`, { host });
      }

      if (adjust.rotateProxy) this.proxyPool.rotate(host);
      if (adjust.rotateUserAgent) this.uaRotator.rotate(host);
      if (adjust.newBrowserContext && this.renderer) await this.renderer.resetContext(host);

      try {
        return await this.#fetchOnce(request, { forceRender: adjust.forceRender === true }, log);
      } catch (rawError) {
        const error = toHarvesterError(rawError);

        // Let the rate limiter learn from throttling responses.
        if (error.status) {
          const retryAfterMs = parseRetryAfter(error.headers?.['retry-after']);
          const feedback = this.rateLimiter.report(host, { status: error.status, retryAfterMs });
          if (feedback.throttled) {
            log.warn('throttled — reducing request rate for this host', {
              host, newRate: +feedback.newRate.toFixed(2), penaltyMs: feedback.penaltyMs,
            });
          }
        }

        const decision = this.retryPolicy.evaluate(error, attempt);
        if (!decision.retry) throw error;

        adjust = decision.adjust;
        this.metrics.increment('retries_total');
        log.info('retrying', {
          url: shortenUrl(request.url),
          attempt: attempt + 1,
          of: this.retryPolicy.maxAttempts,
          reason: decision.reason,
          delayMs: decision.delayMs,
          adjustments: Object.keys(adjust).join(',') || 'none',
        });

        // A retry costs its backoff *plus* a fresh politeness interval. Timed
        // together so a flaky host shows up as retry cost rather than being
        // mistaken for the site simply being slow.
        await this.metrics.time('wait_retry_ms', async () => {
          await sleep(decision.delayMs, this.abortController.signal);
          // Re-acquire the politeness token — the retry is a fresh request.
          await this.rateLimiter.acquire(host, this.abortController.signal);
        });
      }
    }
  }

  /** A single fetch attempt: cache → HTTP → optional render → block check. */
  async #fetchOnce(request, { forceRender }, log) {
    const host = getHostname(request.url) ?? '_unknown';
    const mode = this.config.render.mode;
    const shouldRenderUpFront = forceRender || request.render === true || mode === 'always';

    const profile = this.uaRotator.next(host);
    const proxy = this.proxyPool.acquire(host);

    // Cache lookup comes first, before the render branch. A cached body is a
    // cached body however it was obtained — checking it after the render branch
    // meant `render.mode: always` silently never used the cache at all.
    const cacheKey = { url: request.url, method: request.method, body: request.body };
    const wantsRenderedBody = shouldRenderUpFront || mode === 'auto';

    if (this.cache.enabled && request.method === 'GET') {
      const cached = await this.metrics.time('cache_lookup_ms', () => this.cache.get(cacheKey));
      // A body captured without a browser can't satisfy a run that needs one:
      // serving it would hand back the un-rendered shell and extract nothing.
      const usable = cached && (!wantsRenderedBody || cached.rendered === true);

      if (usable) {
        log.debug('cache hit', {
          url: shortenUrl(request.url), ageMs: cached.ageMs, rendered: cached.rendered === true,
        });
        this.metrics.increment('cache_hits');
        return {
          ...cached,
          buffer: Buffer.from(cached.body ?? ''),
          bytes: (cached.body ?? '').length,
          durationMs: 0,
          rendered: cached.rendered === true,
        };
      }
      if (cached) {
        log.debug('cache entry ignored — it was captured without rendering', {
          url: shortenUrl(request.url),
        });
      }
    }

    if (shouldRenderUpFront && this.renderer) {
      const rendered = await this.#renderPage(request, { profile, proxy, host });
      if (this.cache.enabled && request.method === 'GET') {
        await this.cache.set(cacheKey, rendered);
      }
      return rendered;
    }

    const headers = buildHeaders({
      url: request.url,
      profile,
      baseHeaders: this.config.http.headers,
      requestHeaders: request.headers,
      referer: request.parentUrl,
      cookie: this.cookieJar.headerFor(request.url),
    });

    const started = performance.now();
    let response;
    try {
      response = await this.httpClient.request({
        url: request.url,
        method: request.method,
        headers,
        body: request.body,
        proxy: proxy?.url ?? null,
        signal: this.abortController.signal,
        timeoutMs: this.config.http.timeoutMs,
        throwOnError: true,
      });
      this.proxyPool.reportSuccess(proxy, performance.now() - started);
    } catch (error) {
      // Distinguish a dead proxy from a hostile server: transport errors are
      // the proxy's fault, HTTP statuses are the origin's.
      if (!(error instanceof HttpError)) {
        const outcome = this.proxyPool.reportFailure(proxy, error);
        if (outcome.benched) {
          log.warn('proxy benched after repeated failures', { proxy: outcome.proxy });
        }
      }
      throw error;
    }

    this.cookieJar.setFromResponse(response.headers, response.url);

    // Bot-wall detection: a challenge page is HTTP 200 and would otherwise be
    // parsed as if it were real content.
    const inspection = this.captcha.inspect(response);
    if (inspection.blocked) {
      this.metrics.increment('blocks_detected', 1, { vendor: inspection.detection.vendor });
      if (inspection.action === 'render' && this.renderer) {
        log.info('challenge detected — retrying through a browser', {
          url: shortenUrl(request.url), vendor: inspection.detection.vendor,
        });
        return this.#renderPage(request, { profile, proxy, host });
      }
      throw new BlockedError(
        `Blocked by ${inspection.detection.vendor} (${inspection.detection.kind}) at ${request.url}`,
        { url: request.url, detection: inspection.detection, status: response.status },
      );
    }

    // `auto` mode: the HTTP response is in hand; decide whether it's enough.
    // This runs BEFORE the cache write, so what lands on disk is the body we
    // actually used. Caching the un-rendered shell here meant the next run got
    // a cache hit, returned early, never escalated, and extracted nothing.
    if (mode === 'auto' && this.renderer) {
      const contentSelector = this.config.render.waitForSelector
        ?? this.config.extract?.item?.selector
        ?? this.config.extract?.selector
        ?? null;

      // Parsed once and carried on the response, so `#handleResponse` reuses it
      // instead of parsing the same HTML a second time.
      let page = null;
      let contentFound;
      if (contentSelector) {
        try {
          page = this.metrics.timeSync('parse_html_ms', () => new Page({
            html: response.body,
            url: response.url ?? request.url,
            status: response.status,
            headers: response.headers,
            response,
            meta: request.meta,
          }));
          contentFound = page.exists(contentSelector);
        } catch {
          page = null;
          contentFound = false;
        }
      }

      const verdict = needsRendering(response.body, { contentSelector, contentFound });
      if (verdict.needed) {
        log.debug('escalating to a browser', { url: shortenUrl(request.url), reason: verdict.reason });
        this.metrics.increment('render_escalations', 1, { reason: verdict.reason });
        const rendered = await this.#renderPage(request, { profile, proxy, host });
        if (this.cache.enabled && request.method === 'GET') {
          await this.cache.set(cacheKey, rendered);
        }
        return rendered;
      }
      if (page) response.page = page;
    }

    if (this.cache.enabled && request.method === 'GET') {
      await this.cache.set(cacheKey, response);
    }

    this.rateLimiter.report(host, { status: response.status });
    return response;
  }

  async #renderPage(request, { profile, proxy, host }) {
    if (!this.renderer) {
      throw new BlockedError('This page needs JavaScript but `render.mode` is `never`.', { url: request.url });
    }

    const r = this.config.render;
    const contextKey = `${host}:${proxy ? this.proxyPool.describe(proxy) : 'direct'}:${profile.name}`;

    const result = await this.renderer.render({
      url: request.url,
      waitUntil: r.waitUntil,
      waitForSelector: r.waitForSelector,
      waitForTimeout: r.waitForTimeout,
      waitForFunction: r.waitForFunction,
      actions: r.actions ?? [],
      scroll: r.scroll,
      screenshot: r.screenshot,
      referer: request.parentUrl,
      contextKey,
      contextOptions: {
        userAgent: profile.userAgent,
        viewport: profile.viewport,
        isMobile: profile.mobile,
        proxy: proxy?.url ?? null,
        cookies: this.cookieJar.toPlaywright(),
        headers: this.config.http.headers,
      },
    });

    // Carry browser cookies back so subsequent HTTP requests stay logged in.
    this.cookieJar.loadFromPlaywright(result.cookies ?? []);

    return {
      url: result.url,
      requestUrl: request.url,
      status: result.status,
      headers: result.headers,
      body: result.html,
      buffer: Buffer.from(result.html),
      bytes: Buffer.byteLength(result.html),
      contentType: 'text/html',
      durationMs: result.durationMs,
      fromCache: false,
      rendered: true,
      screenshot: result.screenshot,
    };
  }

  /* ──────────────────────── parse, extract, write ──────────────────────── */

  async #handleResponse(request, rawResponse, log) {
    const response = await this.pipeline.transform('onResponse', rawResponse, {
      ...this.#context(), request,
    });
    if (response === null) return;

    // Only parse things that are actually markup.
    const contentType = response.contentType ?? '';
    const isHtml = !contentType || /html|xml/.test(contentType);
    const isJson = /json/.test(contentType);
    if (!isHtml && !isJson) {
      log.debug('skipping non-markup response', { url: shortenUrl(request.url), contentType });
      return;
    }

    // `auto` render mode already parsed this HTML to test whether the content
    // was present; reuse that parse rather than doing it twice.
    const page = response.page ?? this.metrics.timeSync('parse_html_ms', () => new Page({
      html: response.body,
      url: response.url ?? request.url,
      status: response.status,
      headers: response.headers,
      response,
      meta: request.meta,
    }));

    if (this.pipeline.has('onPage')) {
      await this.pipeline.emit('onPage', page, { ...this.#context(), request, response });
      // A hook receives the live page and may rewrite the DOM. The page's
      // readers are memoised, so anything cached before the hook ran could now
      // be stale.
      page.invalidate();
    }

    // Extraction, scoped by label when the recipe routes pages.
    const extractSpec = this.#extractSpecFor(request.label);
    let items = [];
    if (extractSpec) {
      const result = this.metrics.timeSync(
        'extract_ms',
        () => extractItems(extractSpec, page, { request, response }),
      );
      items = result.items;
      this.#recordFieldHealth(request.label, extractSpec, result);

      for (const issue of result.issues.slice(0, 5)) {
        log.debug('extraction issue', { url: shortenUrl(page.url), issue });
      }
      if (result.issues.length) this.metrics.increment('extraction_issues', result.issues.length);
    }

    this.counters.itemsExtracted += items.length;
    this.metrics.increment('items_extracted', items.length);
    this.metrics.recordHost(getHostname(page.url) ?? '_', 'items', items.length);

    // Link discovery happens regardless of whether this page yielded items —
    // an intermediate listing page is often item-free by design.
    await this.metrics.time('discover_ms', () => this.#discover(page, request, items.length, log));

    if (items.length === 0) return;

    items = await this.pipeline.transformEach('onItem', items, { ...this.#context(), request, page });
    items = await this.pipeline.transform('onItems', items, { ...this.#context(), request, page });
    if (!items?.length) return;

    await this.#emitItems(items, request, page, log);
  }

  async #emitItems(items, request, page, log) {
    const accepted = [];
    const quarantined = [];

    for (const raw of items) {
      if (this.counters.itemsWritten + accepted.length >= this.config.maxItemsEffective) break;

      const item = this.#withMetadata(raw, request, page);

      const { duplicate } = this.dedupe.check(item, { url: page.url });
      if (duplicate) {
        this.counters.itemsDuplicate += 1;
        this.metrics.increment('items_duplicate');
        continue;
      }

      let verdict;
      try {
        verdict = this.validator.process(item);
      } catch (error) {
        // `on_invalid: error` — stop the run, the data is not trustworthy.
        this.stop(`validation failed: ${error.message}`);
        throw error;
      }

      if (verdict.action === 'drop') {
        this.counters.itemsInvalid += 1;
        this.metrics.increment('items_invalid');
        continue;
      }
      if (verdict.action === 'quarantine') {
        this.counters.itemsInvalid += 1;
        this.metrics.increment('items_quarantined');
        quarantined.push({ ...item, _issues: verdict.issues });
        continue;
      }
      if (verdict.issues.length) {
        log.warn('record has validation warnings', {
          url: shortenUrl(page.url),
          issues: verdict.issues.map((i) => `${i.field}: ${i.message}`).slice(0, 3),
        });
      }

      accepted.push(item);
      this.emit('item', item, request);
    }

    if (accepted.length) {
      await this.metrics.time('write_ms', () => this.sink.push(accepted));
      this.counters.itemsWritten += accepted.length;
      this.metrics.increment('items_written', accepted.length);
    }
    if (quarantined.length) await this.#quarantine(quarantined);
  }

  #withMetadata(item, request, page) {
    const meta = this.config.metadata;
    if (!meta || meta === false) return item;
    const out = { ...item };
    if (meta.url !== false) out._url = page.url;
    if (meta.scrapedAt !== false) out._scraped_at = new Date().toISOString();
    if (meta.depth) out._depth = request.depth;
    if (meta.label) out._label = request.label;
    return out;
  }

  async #quarantine(records) {
    if (!this.quarantineWriter) {
      const base = this.config.output.find((o) => typeof o === 'string' || o?.path);
      const basePath = typeof base === 'string' ? base : base?.path;
      const dir = basePath ? basePath.replace(/[^/\\]+$/, '') : '';
      this.quarantineWriter = new NdjsonWriter({ path: `${dir}quarantine.ndjson` });
      await this.quarantineWriter.open();
      this.warnings.push(
        `Some records failed validation and were quarantined to ${this.quarantineWriter.options.path} ` +
        'rather than dropped. Inspect that file — it usually means the site changed.',
      );
    }
    await this.quarantineWriter.write(records);
  }

  async #discover(page, request, itemsOnPage, log) {
    const crawl = this.config.crawl;
    if (!crawl || (crawl.follow.length === 0 && !crawl.pagination)) return;
    if (this.frontier.exhausted || this.stopping) return;

    const { requests, skipped } = discoverLinks(page, request, crawl, {
      seedHosts: this.seedHosts,
      itemsOnPage,
    });

    const gated = await this.pipeline.transform('onLinks', requests, {
      ...this.#context(), request, page,
    });
    if (!gated?.length) return;

    const added = this.frontier.addMany(gated);
    if (added) {
      this.metrics.increment('links_queued', added);
      log.debug('queued links', { from: shortenUrl(page.url), found: gated.length, queued: added });
      // New work exists — release any parked workers rather than making them
      // wait out their timeout.
      this.#wake();
    }
    for (const [reason, count] of Object.entries(skipped)) {
      this.metrics.increment('links_skipped', count, { reason });
    }
  }

  /**
   * Track how often each field actually produced a value. A field that fills
   * on 3 % of pages is almost always a selector the site has changed, and this
   * is what surfaces it in the final report.
   */
  #recordFieldHealth(label, extractSpec, result) {
    const fields = extractSpec.item?.fields ?? extractSpec.fields;
    if (!fields) return;

    for (const name of Object.keys(fields)) {
      const key = `${label}.${name}`;
      let entry = this.fieldStats.get(key);
      if (!entry) {
        entry = { label, field: name, attempts: 0, filled: 0 };
        this.fieldStats.set(key, entry);
      }
      for (const item of result.items) {
        entry.attempts += 1;
        const value = item[name];
        if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
          entry.filled += 1;
        }
      }
      if (result.items.length === 0) entry.attempts += 1;
    }
  }

  #extractSpecFor(label) {
    const extract = this.config.extract;
    if (!extract) return null;
    // `extract` may be keyed by label: `extract: { detail: {...}, list: {...} }`
    if (extract[label] && (extract[label].fields || extract[label].item || extract[label].tables)) {
      return extract[label];
    }
    if (extract.scope && extract.scope !== label) return null;
    return extract;
  }

  /* ───────────────────────────── teardown ──────────────────────────────── */

  async #teardown() {
    this.finishedAt = Date.now();
    this.progress.stop();

    const outputs = await this.sink.close().catch((error) => {
      this.logger.error('failed to close outputs', { error: error.message });
      return [];
    });
    if (this.quarantineWriter) await this.quarantineWriter.close().catch(() => {});

    this.runState.stop();
    if (this.config.resume?.enabled) {
      if (this.frontier.drained && !this.stopping) await this.runState.clear();
      else await this.runState.save(this.#snapshot(), this.config);
    }

    if (this.config.dedupe.persistPath) await this.dedupe.save().catch(() => {});

    await this.renderer?.close().catch(() => {});
    await this.httpClient.close().catch(() => {});

    const report = buildReport(this, outputs);

    if (this.config.report) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(this.config.report), { recursive: true }).catch(() => {});
      await fs.writeFile(this.config.report, JSON.stringify(report, null, 2), 'utf8').catch((error) => {
        this.logger.error('could not write the run report', { error: error.message });
      });
    }

    this.logger.info('run finished', {
      durationMs: report.durationMs,
      pages: report.pages.ok,
      items: report.items.written,
      failed: report.pages.failed,
    });
    return report;
  }

  #snapshot() {
    // Checkpointed counters are cumulative across every session of this job.
    const cumulative = { ...this.counters };
    if (this.resumedFrom) {
      for (const [key, value] of Object.entries(this.resumedFrom)) {
        cumulative[key] = (cumulative[key] ?? 0) + value;
      }
    }
    return {
      frontier: this.frontier.serialize(),
      cookies: this.cookieJar.toJSON(),
      counters: cumulative,
    };
  }

  #progressSnapshot() {
    return {
      ...this.frontier.stats,
      items: this.counters.itemsWritten,
      failed: this.counters.pagesFailed,
      // `metrics.requestsPerSec` is two divisions. The full `snapshot()` this
      // used to call walks every histogram and sorts each reservoir three
      // times — six sorts of 2000 numbers per page, to obtain one figure.
      rps: this.metrics.requestsPerSec,
    };
  }

  #context() {
    return {
      config: this.config,
      logger: this.logger,
      metrics: this.metrics,
      frontier: this.frontier,
      cookieJar: this.cookieJar,
      scraper: this,
      /** Queue an extra URL from inside a hook. */
      enqueue: (req) => this.frontier.add(req),
      stop: (reason) => this.stop(reason),
    };
  }
}

export function createScraper(config, options) {
  return new Scraper(config, options);
}
