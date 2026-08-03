/**
 * Typed error hierarchy.
 *
 * Every error carries a `retryable` flag so the retry policy never has to
 * pattern-match on error messages, and a `code` so logs stay greppable.
 */

export class HarvesterError extends Error {
  constructor(message, { code = 'HARVESTER_ERROR', retryable = false, cause, ...meta } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    Object.assign(this, meta);
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Bad recipe / bad options — never retryable, the run should stop. */
export class ConfigError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'CONFIG_ERROR', retryable: false, ...meta });
  }
}

/** Transport-level failure: DNS, TLS, socket reset, timeout. */
export class NetworkError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'NETWORK_ERROR', retryable: true, ...meta });
  }
}

/** The server answered, but with a status we treat as a failure. */
export class HttpError extends HarvesterError {
  constructor(message, { status, url, headers, body, ...meta } = {}) {
    // 408/425/429 and all 5xx are worth another attempt; other 4xx are not.
    const retryable = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
    super(message, { code: `HTTP_${status}`, retryable, status, url, headers, ...meta });
    this.status = status;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }
}

/** Request exceeded its time budget. */
export class TimeoutError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'TIMEOUT', retryable: true, ...meta });
  }
}

/** We believe the response is a bot-wall (CAPTCHA / challenge page). */
export class BlockedError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'BLOCKED', retryable: true, ...meta });
  }
}

/** robots.txt (or an allow/deny rule) forbids this URL. Not an accident — don't retry. */
export class DisallowedError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'DISALLOWED', retryable: false, ...meta });
  }
}

/** A parsed record failed its schema. */
export class ValidationError extends HarvesterError {
  constructor(message, { issues = [], ...meta } = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, issues, ...meta });
    this.issues = issues;
  }
}

/** Headless browser could not render the page. */
export class RenderError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'RENDER_ERROR', retryable: true, ...meta });
  }
}

/** Circuit breaker is open for this host — fail fast instead of piling on. */
export class CircuitOpenError extends HarvesterError {
  constructor(message, meta = {}) {
    super(message, { code: 'CIRCUIT_OPEN', retryable: false, ...meta });
  }
}

/** Normalise anything thrown into a HarvesterError. */
export function toHarvesterError(err, fallbackMessage = 'Unknown error') {
  if (err instanceof HarvesterError) return err;
  if (err instanceof Error) {
    const netCodes = new Set([
      'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
      'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
      'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'EPROTO',
    ]);
    const code = err.code || err.cause?.code;
    if (err.name === 'AbortError' || code === 'UND_ERR_ABORTED') {
      return new TimeoutError(err.message || 'Request aborted', { cause: err });
    }
    if (netCodes.has(code)) {
      return new NetworkError(err.message, { cause: err, systemCode: code });
    }
    // A caller that explicitly marked its error transient is telling us
    // something the code alone doesn't; honour it.
    return new HarvesterError(err.message || fallbackMessage, {
      cause: err,
      code: code || 'UNKNOWN',
      retryable: err.retryable === true,
    });
  }
  return new HarvesterError(String(err ?? fallbackMessage));
}
