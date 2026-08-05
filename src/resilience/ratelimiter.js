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
    /** Jittered interval for the next request; rolled on every state change. */
    this.nextIntervalMs = 0;

    this.consecutiveOk = 0;
    this.penaltyUntil = 0;

    // Pacing telemetry — all O(1), so it costs nothing to keep always on.
    // This is what answers "is my configured rate actually being achieved, and
    // if not, what is holding it back?"
    this.requestCount = 0;
    this.firstRequestAt = 0;
    this.waitedMs = 0;
    this.throttleEvents = 0;
  }

  /** Effective spacing: the strictest of configured delay and robots.txt. */
  get effectiveDelayMs() {
    return Math.max(this.minDelayMs, this.crawlDelayMs);
  }

  /** The pacing interval this host is currently observing, before jitter. */
  get nominalIntervalMs() {
    return Math.max(1000 / this.currentRate, this.effectiveDelayMs);
  }

  /**
   * True when robots.txt `Crawl-delay` — not your configuration — is what sets
   * the pace. When this is true, raising `requests_per_second` does nothing,
   * which is worth saying out loud rather than letting someone discover it by
   * changing the number and seeing no effect.
   */
  get crawlDelayBinding() {
    return this.crawlDelayMs > 0
      && this.crawlDelayMs >= Math.max(this.minDelayMs, 1000 / this.baseRate);
  }

  /** Requests per second actually achieved so far. */
  get achievedRps() {
    if (this.requestCount < 2) return 0;
    const spanSec = (this.lastRequestAt - this.firstRequestAt) / 1000;
    if (spanSec <= 0) return 0;
    // n requests span n-1 intervals.
    return +((this.requestCount - 1) / spanSec).toFixed(3);
  }

  setCrawlDelay(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) {
      // Cap it: some sites publish absurd values that would stall a run forever.
      this.crawlDelayMs = Math.min(seconds * 1000, this.config.maxCrawlDelayMs);
      this.nextIntervalMs = this.#rollInterval();
    }
  }

  /**
   * Roll the interval to observe before the next request.
   *
   * Jitter is a **fraction of the interval**, not an absolute number of
   * milliseconds. That distinction is the whole point: the anti-fingerprinting
   * value of jitter comes from variance *relative to* the request spacing, so a
   * fixed ±125 ms is meaningful at 1 req/s and a hard ceiling at 50 req/s — the
   * old absolute form capped every configuration at ~8 req/s no matter what was
   * asked for.
   *
   * The roll is one-sided upward. A hard floor (`min_delay_ms`, robots
   * `Crawl-delay`) is a promise, and rolling downward would break it. The cost
   * is a predictable `ratio/2` haircut at every rate, rather than the old
   * rate-dependent one.
   *
   * Called only on state changes — never from a read — so `delayUntilReady()`
   * stays deterministic between requests and `acquire()` converges.
   */
  #rollInterval() {
    const nominal = this.nominalIntervalMs;
    const ratio = Math.min(Math.max(this.config.jitterRatio, 0), 1);
    if (ratio === 0) return nominal;
    const spread = Math.min(nominal * ratio, this.config.maxJitterMs);
    return nominal + Math.random() * spread;
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

    const sinceLast = now - this.lastRequestAt;

    // A hard floor is honoured even while spending burst credit.
    const floor = this.effectiveDelayMs;
    const floorWait = floor > 0 && sinceLast < floor ? floor - sinceLast : 0;

    this.#refill();
    const hasCredit = this.tokens >= 1;
    const tokenWait = hasCredit ? 0 : Math.ceil(((1 - this.tokens) / this.currentRate) * 1000);

    // The jittered pacing interval applies once burst credit is spent, so a
    // configured burst still goes out back to back.
    const pacedWait = hasCredit ? 0 : Math.max(0, Math.ceil(this.nextIntervalMs - sinceLast));

    return Math.max(floorWait, tokenWait, pacedWait);
  }

  isReady() {
    return this.delayUntilReady() === 0;
  }

  /** Consume a token. Call immediately before dispatching a request. */
  consume() {
    this.#refill();
    this.tokens = Math.max(0, this.tokens - 1);

    const now = Date.now();
    this.lastRequestAt = now;
    if (this.requestCount === 0) this.firstRequestAt = now;
    this.requestCount += 1;
    this.nextIntervalMs = this.#rollInterval();
  }

  /**
   * Wait until allowed, then consume.
   *
   * The readiness test and `consume()` are deliberately adjacent with no `await`
   * between them. An intervening yield — which is what the old jitter sleep
   * was — let two workers on the same host both pass the readiness test before
   * either consumed, so both dispatched and the bucket was bypassed in pairs.
   */
  async acquire(signal) {
    const started = performance.now();
    // `report()` can raise the target mid-wait (a 429 halves the rate), so the
    // delay is not guaranteed to decrease monotonically. Cap the iterations
    // rather than trusting an invariant that adaptive throttling can break.
    for (let i = 0; i < 200; i += 1) {
      const wait = this.delayUntilReady();
      if (wait <= 0) break;
      await sleep(wait, signal);
    }
    this.waitedMs += performance.now() - started;
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
      this.throttleEvents += 1;
      // Multiplicative decrease — this alone already slows us down.
      this.currentRate = Math.max(this.config.minRequestsPerSecond, this.currentRate / 2);
      this.nextIntervalMs = this.#rollInterval();

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
        this.nextIntervalMs = this.#rollInterval();
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

      // Pacing truth: what was asked for, what was achieved, and what is
      // actually setting the pace.
      configuredRps: this.baseRate,
      achievedRps: this.achievedRps,
      nominalIntervalMs: Math.round(this.nominalIntervalMs),
      requests: this.requestCount,
      waitedMs: Math.round(this.waitedMs),
      throttleEvents: this.throttleEvents,
      crawlDelayBinding: this.crawlDelayBinding,
    };
  }
}

export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.requestsPerSecond=1]  Sustained per-host rate.
   * @param {number} [options.burst=1]              Token bucket capacity.
   * @param {number} [options.minDelayMs=0]         Hard floor between requests.
   * @param {number} [options.jitterRatio=0.25]     Random extra delay, as a
   *        fraction of the request interval. `0` gives exact pacing. At the
   *        default rate this is identical to the old `jitterMs: 250`.
   * @param {number} [options.maxJitterMs=2000]     Absolute cap on the jitter,
   *        so a very slow host isn't swung wildly.
   * @param {boolean}[options.adaptive=true]        Enable AIMD backoff.
   */
  constructor(options = {}) {
    const rps = options.requestsPerSecond ?? 1;
    const minDelayMs = options.minDelayMs ?? 0;

    // `jitterMs` was the public option before jitter became proportional.
    // Convert rather than ignore: the recipe loader does the same translation,
    // but this constructor is exported and called directly too.
    let jitterRatio = options.jitterRatio;
    if (jitterRatio === undefined && options.jitterMs !== undefined) {
      const interval = Math.max(1000 / rps, minDelayMs);
      jitterRatio = Math.min(Math.max(Number(options.jitterMs) / interval, 0), 1);
    }

    this.config = {
      requestsPerSecond: rps,
      minRequestsPerSecond: options.minRequestsPerSecond ?? 0.05,
      burst: options.burst ?? 1,
      minDelayMs,
      jitterRatio: Number.isFinite(jitterRatio) ? jitterRatio : 0.25,
      maxJitterMs: options.maxJitterMs ?? 2000,
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
