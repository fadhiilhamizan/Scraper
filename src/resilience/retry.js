/**
 * Retry policy.
 *
 * Decides *whether* to retry, *how long* to wait, and *what to change* on the
 * next attempt (e.g. rotate proxy, rotate user-agent, escalate to a headless
 * browser). Returning an "adjustment" rather than just a delay is what makes
 * retries actually useful against anti-bot systems: repeating the identical
 * request from the identical IP rarely helps.
 */

import { backoffDelay, sleep } from '../utils/async.js';
import { toHarvesterError } from '../utils/errors.js';
import { parseRetryAfter } from './ratelimiter.js';

export const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504, 509, 520, 521, 522, 523, 524];

export class RetryPolicy {
  /**
   * @param {object} [options]
   * @param {number}  [options.maxAttempts=3]      Total tries, including the first.
   * @param {number}  [options.baseDelayMs=1000]
   * @param {number}  [options.maxDelayMs=60000]
   * @param {number}  [options.factor=2]
   * @param {boolean} [options.jitter=true]
   * @param {number[]}[options.retryStatuses]
   * @param {boolean} [options.rotateProxyOnRetry=true]
   * @param {boolean} [options.rotateUserAgentOnRetry=true]
   * @param {boolean} [options.escalateToBrowser=true] Retry blocked pages with a
   *        real browser before giving up.
   * @param {boolean} [options.respectRetryAfter=true]
   */
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter !== false;
    this.retryStatuses = new Set(options.retryStatuses ?? DEFAULT_RETRY_STATUSES);
    this.rotateProxyOnRetry = options.rotateProxyOnRetry !== false;
    this.rotateUserAgentOnRetry = options.rotateUserAgentOnRetry !== false;
    this.escalateToBrowser = options.escalateToBrowser !== false;
    this.respectRetryAfter = options.respectRetryAfter !== false;
  }

  /**
   * @param {Error} error
   * @param {number} attempt 1-based number of the attempt that just failed.
   * @returns {{retry: boolean, delayMs: number, reason: string, adjust: object}}
   */
  evaluate(error, attempt) {
    const err = toHarvesterError(error);
    const no = (reason) => ({ retry: false, delayMs: 0, reason, adjust: {} });

    if (attempt >= this.maxAttempts) return no('max_attempts_exhausted');

    const status = err.status;
    if (status != null && !this.retryStatuses.has(status)) {
      return no(`status_${status}_not_retryable`);
    }
    if (status == null && !err.retryable) {
      return no(`${err.code}_not_retryable`);
    }

    let delayMs = backoffDelay(attempt, {
      baseMs: this.baseDelayMs,
      maxMs: this.maxDelayMs,
      factor: this.factor,
      jitter: this.jitter,
    });

    // A server that tells us exactly how long to wait deserves to be obeyed.
    if (this.respectRetryAfter && err.headers) {
      const retryAfter = parseRetryAfter(
        err.headers['retry-after'] ?? err.headers['Retry-After'],
      );
      if (retryAfter != null) delayMs = Math.min(Math.max(retryAfter, delayMs), this.maxDelayMs);
    }

    const adjust = {};
    if (status === 429 || status === 503) {
      // Rate limited: back off harder and change identity.
      delayMs = Math.min(delayMs * 2, this.maxDelayMs);
      if (this.rotateProxyOnRetry) adjust.rotateProxy = true;
      if (this.rotateUserAgentOnRetry) adjust.rotateUserAgent = true;
    } else if (status === 403 || status === 401 || err.code === 'BLOCKED') {
      // Looks like a bot wall: new identity, and try a real browser.
      if (this.rotateProxyOnRetry) adjust.rotateProxy = true;
      if (this.rotateUserAgentOnRetry) adjust.rotateUserAgent = true;
      if (this.escalateToBrowser) adjust.forceRender = true;
    } else if (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') {
      // Could be a dead proxy — swap it.
      if (this.rotateProxyOnRetry) adjust.rotateProxy = true;
    } else if (err.code === 'RENDER_ERROR') {
      adjust.newBrowserContext = true;
    }

    return {
      retry: true,
      delayMs,
      reason: status ? `http_${status}` : err.code.toLowerCase(),
      adjust,
    };
  }

  /**
   * Convenience wrapper: run `fn` under this policy.
   * `fn` receives `{ attempt, adjust }` so it can honour the adjustments.
   */
  async execute(fn, { signal, onRetry } = {}) {
    let attempt = 0;
    let adjust = {};
    let lastError;

    for (;;) {
      attempt += 1;
      try {
        return await fn({ attempt, adjust });
      } catch (error) {
        lastError = error;
        const decision = this.evaluate(error, attempt);
        if (!decision.retry) throw error;
        adjust = decision.adjust;
        onRetry?.({ error, attempt, ...decision });
        await sleep(decision.delayMs, signal);
      }
    }
    /* eslint-disable-next-line no-unreachable */
    throw lastError;
  }
}

export function createRetryPolicy(options) {
  return new RetryPolicy(options);
}
