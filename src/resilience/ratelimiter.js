/**
 * Per-host rate limiting.
 *
 * Combines three mechanisms so that "be polite" is the default rather than an
 * afterthought:
 *
 *  1. **Token bucket** — caps sustained requests/second while allowing a small
 *     burst, which is how real browsers behave.
 *  2. **Minimum spacing** — a hard floor between two requests to the same host.
 *     `robots.txt` `Crawl-delay` feeds straight into this.
 *  3. **Adaptive backoff** — on 429/503 the limiter halves its own rate and
 *     recovers slowly (AIMD, the same idea TCP congestion control uses). This
 *     is what keeps a long crawl from getting a domain banned.
 */

import { sleep } from '../utils/async.js';

class HostLimiter {
  constructor(host, config) {
    this.host = host;
    this.config = config;

    this.capacity = Math.max(1, config.burst);
    this.tokens = this.capacity;
    this.baseRate = config.requestsPerSecond;
    this.currentRate = config.requestsPerSecond;
    this.lastRefill = Date.now();

    this.minDelayMs = config.minDelayMs;
    this.crawlDelayMs = 0; // set from robots.txt
    this.lastRequestAt = 0;

    this.consecutiveOk = 0;
    this.penaltyUntil = 0;
  }

  /** Effective spacing: the strictest of configured delay and robots.txt. */
  get effectiveDelayMs() {
    return Math.max(this.minDelayMs, this.crawlDelayMs);
  }

  setCrawlDelay(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) {
      // Cap it: some sites publish absurd values that would stall a run forever.
      this.crawlDelayMs = Math.min(seconds * 1000, this.config.maxCrawlDelayMs);
    }
  }

  #refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.currentRate);
    this.lastRefill = now;
  }

  /**
   * How long (ms) until this host may be hit again. 0 means "go now".
   *
   * Deliberately deterministic — no jitter. This value doubles as the loop
   * condition in `acquire()` and as the scheduler's readiness test, and a
   * randomised answer would make both of those meaningless: `acquire` would
   * re-roll a fresh delay on every poll and never converge.
   */
  delayUntilReady() {
    const now = Date.now();

    if (now < this.penaltyUntil) return this.penaltyUntil - now;

    const spacing = this.effectiveDelayMs;
    const sinceLast = now - this.lastRequestAt;
    const spacingWait = spacing > 0 && sinceLast < spacing ? spacing - sinceLast : 0;

    this.#refill();
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.currentRate) * 1000);

    return Math.max(spacingWait, tokenWait);
  }

  isReady() {
    return this.delayUntilReady() === 0;
  }

  /**
   * A single random pause, applied once per acquisition. Breaking up the
   * metronome-regular request pattern is one of the cheapest ways to look less
   * like a bot.
   */
  #jitter() {
    return this.config.jitterMs > 0 ? Math.floor(Math.random() * this.config.jitterMs) : 0;
  }

  /** Consume a token. Call immediately before dispatching a request. */
  consume() {
    this.#refill();
    this.tokens = Math.max(0, this.tokens - 1);
    this.lastRequestAt = Date.now();
  }

  /** Wait until allowed, then consume. */
  async acquire(signal) {
    // Bounded: each pass either returns 0 or waits out a delay that strictly
    // decreases, so this converges rather than polling.
    for (;;) {
      const wait = this.delayUntilReady();
      if (wait <= 0) break;
      await sleep(wait, signal);
    }
    const jitter = this.#jitter();
    if (jitter > 0) await sleep(jitter, signal);
    this.consume();
  }

  /**
   * Feed back what the server said.
   * @param {object} result
   * @param {number} [result.status]
   * @param {number} [result.retryAfterMs] Parsed `Retry-After` header.
   */
  report({ status, retryAfterMs } = {}) {
    const throttled = status === 429 || status === 503 || status === 509;

    if (throttled) {
      this.consecutiveOk = 0;
      // Multiplicative decrease — this alone already slows us down.
      this.currentRate = Math.max(this.config.minRequestsPerSecond, this.currentRate / 2);

      // A hard pause on top of that is only warranted when the server actually
      // asked for one. `Retry-After` is an explicit instruction, and 429 means
      // "you are being rate limited". A bare 503 usually means "I'm broken
      // right now" — the halved rate plus the caller's retry backoff is the
      // proportionate response, and pausing the whole host for 30s would stall
      // a run over one transient error.
      const penalty = retryAfterMs
        ?? (status === 429 ? this.config.throttlePenaltyMs : 0);

      if (penalty > 0) {
        this.penaltyUntil = Date.now() + Math.min(penalty, this.config.maxPenaltyMs);
      }
      return { throttled: true, newRate: this.currentRate, penaltyMs: penalty };
    }

    if (status >= 200 && status < 400) {
      this.consecutiveOk += 1;
      // Additive increase, but only after a run of clean responses.
      if (this.consecutiveOk >= this.config.recoveryThreshold && this.currentRate < this.baseRate) {
        this.currentRate = Math.min(this.baseRate, this.currentRate + this.baseRate * 0.1);
        this.consecutiveOk = 0;
        return { recovered: true, newRate: this.currentRate };
      }
    }
    return {};
  }

  snapshot() {
    return {
      host: this.host,
      rate: +this.currentRate.toFixed(3),
      baseRate: this.baseRate,
      tokens: +this.tokens.toFixed(2),
      delayMs: this.effectiveDelayMs,
      crawlDelayMs: this.crawlDelayMs,
      penalised: Date.now() < this.penaltyUntil,
    };
  }
}

export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.requestsPerSecond=1]  Sustained per-host rate.
   * @param {number} [options.burst=1]              Token bucket capacity.
   * @param {number} [options.minDelayMs=0]         Hard floor between requests.
   * @param {number} [options.jitterMs=250]         Random extra delay.
   * @param {boolean}[options.adaptive=true]        Enable AIMD backoff.
   */
  constructor(options = {}) {
    this.config = {
      requestsPerSecond: options.requestsPerSecond ?? 1,
      minRequestsPerSecond: options.minRequestsPerSecond ?? 0.05,
      burst: options.burst ?? 1,
      minDelayMs: options.minDelayMs ?? 0,
      jitterMs: options.jitterMs ?? 250,
      adaptive: options.adaptive !== false,
      throttlePenaltyMs: options.throttlePenaltyMs ?? 30_000,
      maxPenaltyMs: options.maxPenaltyMs ?? 300_000,
      maxCrawlDelayMs: options.maxCrawlDelayMs ?? 30_000,
      recoveryThreshold: options.recoveryThreshold ?? 10,
    };
    /** @type {Map<string, HostLimiter>} */
    this.hosts = new Map();
  }

  forHost(host) {
    let limiter = this.hosts.get(host);
    if (!limiter) {
      limiter = new HostLimiter(host, this.config);
      this.hosts.set(host, limiter);
    }
    return limiter;
  }

  isReady(host) {
    return this.forHost(host).isReady();
  }

  delayUntilReady(host) {
    return this.forHost(host).delayUntilReady();
  }

  /** Smallest wait across all known hosts — how long the scheduler should park. */
  minDelayAcrossHosts(hosts) {
    let min = Infinity;
    for (const host of hosts) {
      min = Math.min(min, this.forHost(host).delayUntilReady());
      if (min === 0) return 0;
    }
    return Number.isFinite(min) ? min : 0;
  }

  async acquire(host, signal) {
    return this.forHost(host).acquire(signal);
  }

  consume(host) {
    this.forHost(host).consume();
  }

  setCrawlDelay(host, seconds) {
    this.forHost(host).setCrawlDelay(seconds);
  }

  report(host, result) {
    if (!this.config.adaptive) return {};
    return this.forHost(host).report(result);
  }

  snapshot() {
    return [...this.hosts.values()].map((h) => h.snapshot());
  }
}

/**
 * Parse a `Retry-After` header. Accepts both delta-seconds and HTTP-date.
 * @returns {number|null} milliseconds to wait
 */
export function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
