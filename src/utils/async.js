/** Small async primitives used across the framework. */

/**
 * Promise-based sleep that can be cancelled by an AbortSignal.
 *
 * The timer is deliberately **not** unref'd. A sleeping worker — waiting out a
 * politeness delay or a retry backoff — is the only thing keeping the run
 * alive between requests; unref'ing here lets the event loop drain and the
 * process exit mid-crawl with the run promise never settling.
 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Reject with `TimeoutError`-shaped error if `promise` takes longer than `ms`. */
export async function withTimeout(promise, ms, message = 'Operation timed out') {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'AbortError';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A counting semaphore. `acquire()` resolves with a release function.
 * Used to bound global and per-host concurrency.
 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.waiters = [];
  }

  get pending() {
    return this.waiters.length;
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve(() => this.#release());
      });
    });
  }

  #release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Change the limit at runtime (used by the adaptive throttler). */
  resize(limit) {
    const next = Math.max(1, limit | 0);
    const delta = next - this.limit;
    this.limit = next;
    for (let i = 0; i < delta; i += 1) {
      if (this.active < this.limit) {
        const w = this.waiters.shift();
        if (w) w();
      }
    }
  }
}

/**
 * A "deferred" — a promise plus its resolve/reject handles.
 * Used by the scheduler to park until new work arrives.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Run `items` through `worker` with bounded parallelism, preserving input order
 * in the returned array. Errors are captured per item rather than aborting.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Jittered exponential backoff. Full jitter avoids thundering herds. */
export function backoffDelay(attempt, { baseMs = 500, maxMs = 30_000, factor = 2, jitter = true } = {}) {
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  if (!jitter) return raw;
  // Full jitter: uniform in [raw/2, raw] keeps a floor while spreading retries.
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}
