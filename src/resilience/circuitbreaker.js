/**
 * Per-host circuit breaker.
 *
 * When a domain starts failing hard — it went down, or it started serving
 * challenge pages to us — hammering it further wastes the run's time budget
 * and deepens whatever block we've earned. The breaker fails fast instead, then
 * probes periodically to see whether the host has recovered.
 *
 * States: closed (normal) -> open (reject immediately) -> half_open (one probe).
 */

export const CircuitState = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

class HostCircuit {
  constructor(host, config) {
    this.host = host;
    this.config = config;
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.totalRequests = 0;
    this.openedAt = 0;
    this.nextProbeAt = 0;
    this.consecutiveOpens = 0;
    /** Sliding window of recent outcomes (true = success). */
    this.window = [];
  }

  #record(ok) {
    this.window.push(ok);
    if (this.window.length > this.config.windowSize) this.window.shift();
  }

  get failureRate() {
    if (this.window.length < this.config.minimumRequests) return 0;
    const failures = this.window.filter((ok) => !ok).length;
    return failures / this.window.length;
  }

  /** Can a request go out right now? Transitions OPEN -> HALF_OPEN when due. */
  canRequest() {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.OPEN) {
      if (Date.now() >= this.nextProbeAt) {
        this.state = CircuitState.HALF_OPEN;
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow the single probe that opened this state.
    return true;
  }

  onSuccess() {
    this.totalRequests += 1;
    this.successes += 1;
    this.#record(true);

    if (this.state === CircuitState.HALF_OPEN) {
      // The probe worked — close up and forget the streak.
      this.state = CircuitState.CLOSED;
      this.failures = 0;
      this.consecutiveOpens = 0;
      this.window = [];
      return { transitioned: CircuitState.CLOSED };
    }
    this.failures = 0;
    return {};
  }

  onFailure(error) {
    this.totalRequests += 1;
    this.failures += 1;
    this.#record(false);

    if (this.state === CircuitState.HALF_OPEN) {
      this.#open();
      return { transitioned: CircuitState.OPEN, reason: 'probe_failed' };
    }

    const tripByStreak = this.failures >= this.config.failureThreshold;
    const tripByRate =
      this.window.length >= this.config.minimumRequests &&
      this.failureRate >= this.config.failureRateThreshold;

    if (this.state === CircuitState.CLOSED && (tripByStreak || tripByRate)) {
      this.#open();
      return {
        transitioned: CircuitState.OPEN,
        reason: tripByStreak ? 'consecutive_failures' : 'failure_rate',
        failureRate: +this.failureRate.toFixed(2),
        lastError: error?.message,
      };
    }
    return {};
  }

  #open() {
    this.state = CircuitState.OPEN;
    this.openedAt = Date.now();
    this.consecutiveOpens += 1;
    // Each re-open waits longer, capped, so a genuinely dead host stops
    // consuming scheduler attention.
    const cooldown = Math.min(
      this.config.resetTimeoutMs * 2 ** (this.consecutiveOpens - 1),
      this.config.maxResetTimeoutMs,
    );
    this.nextProbeAt = this.openedAt + cooldown;
    this.window = [];
    this.failures = 0;
  }

  /** Manually force the circuit closed (used by `--force` / operator override). */
  reset() {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.consecutiveOpens = 0;
    this.window = [];
  }

  snapshot() {
    return {
      host: this.host,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      failureRate: +this.failureRate.toFixed(2),
      msUntilProbe: this.state === CircuitState.OPEN ? Math.max(0, this.nextProbeAt - Date.now()) : 0,
    };
  }
}

export class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.failureThreshold=5]      Consecutive failures to trip.
   * @param {number} [options.failureRateThreshold=0.7] Or this share of the window.
   * @param {number} [options.windowSize=20]
   * @param {number} [options.minimumRequests=10]      Before rate is considered.
   * @param {number} [options.resetTimeoutMs=60000]    Cooldown before probing.
   * @param {boolean}[options.enabled=true]
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.config = {
      failureThreshold: options.failureThreshold ?? 5,
      failureRateThreshold: options.failureRateThreshold ?? 0.7,
      windowSize: options.windowSize ?? 20,
      minimumRequests: options.minimumRequests ?? 10,
      resetTimeoutMs: options.resetTimeoutMs ?? 60_000,
      maxResetTimeoutMs: options.maxResetTimeoutMs ?? 900_000,
    };
    /** @type {Map<string, HostCircuit>} */
    this.circuits = new Map();
  }

  forHost(host) {
    let circuit = this.circuits.get(host);
    if (!circuit) {
      circuit = new HostCircuit(host, this.config);
      this.circuits.set(host, circuit);
    }
    return circuit;
  }

  canRequest(host) {
    if (!this.enabled) return true;
    return this.forHost(host).canRequest();
  }

  isOpen(host) {
    return this.enabled && this.forHost(host).state === CircuitState.OPEN;
  }

  onSuccess(host) {
    if (!this.enabled) return {};
    return this.forHost(host).onSuccess();
  }

  onFailure(host, error) {
    if (!this.enabled) return {};
    return this.forHost(host).onFailure(error);
  }

  reset(host) {
    if (host) this.forHost(host).reset();
    else for (const c of this.circuits.values()) c.reset();
  }

  /** True when every known host is open — the run cannot make progress. */
  allOpen() {
    if (!this.enabled || this.circuits.size === 0) return false;
    return [...this.circuits.values()].every((c) => c.state === CircuitState.OPEN);
  }

  snapshot() {
    return [...this.circuits.values()].map((c) => c.snapshot());
  }
}
