/**
 * Lightweight in-process metrics: counters, gauges and latency histograms.
 *
 * The collector is deliberately dependency-free and cheap enough to call on
 * every request. `snapshot()` produces a plain object suitable for the run
 * report; `toPrometheus()` renders the same data in Prometheus text format so
 * a run can be scraped by an external monitor if you expose it over HTTP.
 */

export class Histogram {
  constructor(name) {
    this.name = name;
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    /** Reservoir of samples kept for percentile estimation. */
    this.samples = [];
    this.maxSamples = 2000;
  }

  observe(value) {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(value);
    } else {
      // Reservoir sampling keeps the distribution unbiased on long runs.
      const idx = Math.floor(Math.random() * this.count);
      if (idx < this.maxSamples) this.samples[idx] = value;
    }
  }

  percentile(p) {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  snapshot() {
    return {
      count: this.count,
      mean: this.count ? +(this.sum / this.count).toFixed(2) : 0,
      min: this.count ? +this.min.toFixed(2) : 0,
      p50: +this.percentile(50).toFixed(2),
      p90: +this.percentile(90).toFixed(2),
      p99: +this.percentile(99).toFixed(2),
      max: this.count ? +this.max.toFixed(2) : 0,
    };
  }
}

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    /** Per-host breakdown, useful when a crawl spans several domains. */
    this.byHost = new Map();
  }

  #key(name, labels) {
    if (!labels || Object.keys(labels).length === 0) return name;
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`);
    return `${name}{${parts.join(',')}}`;
  }

  increment(name, value = 1, labels = null) {
    const key = this.#key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name, value, labels = null) {
    this.gauges.set(this.#key(name, labels), value);
  }

  observe(name, value, labels = null) {
    const key = this.#key(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = new Histogram(key);
      this.histograms.set(key, hist);
    }
    hist.observe(value);
    return hist;
  }

  /** Time an async function and record its duration under `name`. */
  async time(name, fn, labels = null) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - t0, labels);
    }
  }

  recordHost(host, field, value = 1) {
    let entry = this.byHost.get(host);
    if (!entry) {
      entry = { requests: 0, ok: 0, failed: 0, blocked: 0, items: 0, bytes: 0, totalMs: 0 };
      this.byHost.set(host, entry);
    }
    entry[field] = (entry[field] ?? 0) + value;
  }

  get(name, labels = null) {
    return this.counters.get(this.#key(name, labels)) ?? 0;
  }

  get elapsedMs() {
    return Date.now() - this.startedAt;
  }

  snapshot() {
    const histograms = {};
    for (const [k, h] of this.histograms) histograms[k] = h.snapshot();

    const hosts = {};
    for (const [host, entry] of this.byHost) {
      hosts[host] = {
        ...entry,
        avgMs: entry.requests ? Math.round(entry.totalMs / entry.requests) : 0,
        successRate: entry.requests ? +((entry.ok / entry.requests) * 100).toFixed(1) : 0,
      };
    }

    const elapsedSec = Math.max(this.elapsedMs / 1000, 0.001);
    return {
      elapsedMs: this.elapsedMs,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
      hosts,
      rates: {
        requestsPerSec: +(this.get('requests_total') / elapsedSec).toFixed(2),
        itemsPerSec: +(this.get('items_extracted') / elapsedSec).toFixed(2),
      },
    };
  }

  toPrometheus() {
    const lines = [];
    for (const [key, value] of this.counters) {
      lines.push(`# TYPE ${key.split('{')[0]} counter`);
      lines.push(`harvester_${key} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`# TYPE ${key.split('{')[0]} gauge`);
      lines.push(`harvester_${key} ${value}`);
    }
    for (const [key, hist] of this.histograms) {
      const base = key.split('{')[0];
      const snap = hist.snapshot();
      lines.push(`# TYPE ${base} summary`);
      lines.push(`harvester_${base}_count ${snap.count}`);
      lines.push(`harvester_${base}_sum ${(snap.mean * snap.count).toFixed(2)}`);
      for (const q of [50, 90, 99]) {
        lines.push(`harvester_${base}{quantile="0.${q}"} ${snap[`p${q}`]}`);
      }
    }
    return lines.join('\n');
  }
}

export function createMetrics() {
  return new Metrics();
}
