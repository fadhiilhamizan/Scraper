/**
 * Lifecycle hooks.
 *
 * Every stage of the pipeline emits a hook. Handlers run in registration order
 * and may be async. Two hook shapes exist:
 *
 *  - **Observers** (`onRunStart`, `onError`, …) — return value ignored.
 *  - **Transformers** (`onRequest`, `onResponse`, `onItem`) — whatever they
 *    return replaces the value; returning `null` from `onItem` or `onRequest`
 *    drops it. This is how you filter, enrich, or rewrite without forking the
 *    engine.
 *
 * A throwing hook is logged and skipped rather than killing the run — a bug in
 * a custom enrichment step should not lose an hour of crawling.
 */

export const HOOKS = [
  /** `(config, ctx)` — before anything is fetched. */
  'onRunStart',
  /** `(request, ctx) => request|null` — mutate or drop a queued request. */
  'onRequest',
  /** `(response, ctx) => response` — raw response, before parsing. */
  'onResponse',
  /** `(page, ctx)` — after parsing, before extraction. */
  'onPage',
  /** `(item, ctx) => item|null` — per extracted record. */
  'onItem',
  /** `(items, ctx) => items` — the whole page's records at once. */
  'onItems',
  /** `(requests, ctx) => requests` — links discovered on a page. */
  'onLinks',
  /** `(error, ctx)` — any request-level failure, after retries. */
  'onError',
  /** `(result)` — the run finished (success or failure). */
  'onRunEnd',
];

export class Pipeline {
  /**
   * @param {Record<string, Function|Function[]>} [hooks]
   * @param {object} [options]
   * @param {import('../observability/logger.js').Logger} [options.logger]
   */
  constructor(hooks = {}, options = {}) {
    this.logger = options.logger ?? null;
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map(HOOKS.map((name) => [name, []]));
    this.errors = 0;
    this.register(hooks);
  }

  register(hooks) {
    for (const [name, handler] of Object.entries(hooks ?? {})) {
      if (!this.handlers.has(name)) {
        this.logger?.warn('unknown hook, ignoring', { hook: name, valid: HOOKS.join(', ') });
        continue;
      }
      const list = Array.isArray(handler) ? handler : [handler];
      for (const fn of list) {
        if (typeof fn === 'function') this.handlers.get(name).push(fn);
      }
    }
    return this;
  }

  on(name, handler) {
    return this.register({ [name]: handler });
  }

  has(name) {
    return (this.handlers.get(name)?.length ?? 0) > 0;
  }

  /** Run observer hooks; failures are logged, never propagated. */
  async emit(name, ...args) {
    const handlers = this.handlers.get(name);
    if (!handlers?.length) return;
    for (const handler of handlers) {
      try {
        await handler(...args);
      } catch (error) {
        this.errors += 1;
        this.logger?.error('hook threw — continuing', { hook: name, error: error.message, stack: error.stack });
      }
    }
  }

  /**
   * Run transformer hooks, threading the value through each.
   * A handler returning `undefined` leaves the value unchanged; returning
   * `null` short-circuits and drops it.
   */
  async transform(name, value, context) {
    const handlers = this.handlers.get(name);
    if (!handlers?.length) return value;

    let current = value;
    for (const handler of handlers) {
      try {
        const result = await handler(current, context);
        if (result === null) return null;
        if (result !== undefined) current = result;
      } catch (error) {
        this.errors += 1;
        this.logger?.error('hook threw — value passed through unchanged', {
          hook: name, error: error.message, stack: error.stack,
        });
      }
    }
    return current;
  }

  /** Apply `onItem` across a list, dropping the nulls. */
  async transformEach(name, items, context) {
    if (!this.has(name)) return items;
    const out = [];
    for (const item of items) {
      const result = await this.transform(name, item, context);
      if (result !== null && result !== undefined) out.push(result);
    }
    return out;
  }

  get stats() {
    const registered = {};
    for (const [name, list] of this.handlers) {
      if (list.length) registered[name] = list.length;
    }
    return { registered, errors: this.errors };
  }
}

export function createPipeline(hooks, options) {
  return new Pipeline(hooks, options);
}
