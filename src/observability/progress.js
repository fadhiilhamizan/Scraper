/**
 * Live terminal progress.
 *
 * Renders a single self-updating line on stderr so it never contaminates piped
 * stdout data, and disables itself automatically when stderr isn't a TTY (CI
 * logs, redirects) — where a redrawing line would just produce thousands of
 * junk lines.
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class ProgressReporter {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {number}  [options.intervalMs=120]
   * @param {NodeJS.WriteStream} [options.stream=process.stderr]
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intervalMs = options.intervalMs ?? 120;
    this.stream = options.stream ?? process.stderr;
    this.logger = options.logger ?? null;

    this.total = null;
    this.startedAt = 0;
    this.frame = 0;
    this.timer = null;
    this.currentUrl = '';
    this.state = { queued: 0, completed: 0, failed: 0, items: 0, inFlight: 0, rps: 0 };
    this.lastLineLength = 0;
    this.hidden = false;
  }

  start({ total = null } = {}) {
    if (!this.enabled) return;
    this.total = Number.isFinite(total) ? total : null;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.#render(), this.intervalMs);
    this.timer.unref?.();
  }

  update(state) {
    Object.assign(this.state, state);
  }

  setCurrent(url) {
    this.currentUrl = url ?? '';
  }

  /** Erase the progress line so a log record can print cleanly. */
  clear() {
    if (!this.enabled || this.lastLineLength === 0) return;
    this.stream.write(`\r${' '.repeat(this.lastLineLength)}\r`);
    this.lastLineLength = 0;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }

  #render() {
    if (!this.enabled || this.hidden) return;

    const { completed, failed, items, inFlight, queued, rps } = this.state;
    const spinner = SPINNER[this.frame++ % SPINNER.length];
    const elapsed = (Date.now() - this.startedAt) / 1000;

    const parts = [
      `\x1b[36m${spinner}\x1b[0m`,
      `${completed} done`,
      inFlight ? `\x1b[90m${inFlight} active\x1b[0m` : null,
      queued ? `\x1b[90m${queued} queued\x1b[0m` : null,
      failed ? `\x1b[31m${failed} failed\x1b[0m` : null,
      `\x1b[1m${items}\x1b[0m items`,
      `\x1b[90m${rps.toFixed(1)}/s\x1b[0m`,
      `\x1b[90m${formatElapsed(elapsed)}\x1b[0m`,
    ].filter(Boolean);

    if (this.total) {
      const done = Math.min(completed, this.total);
      const ratio = done / this.total;
      const width = 16;
      const filled = Math.round(ratio * width);
      parts.splice(1, 0, `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${Math.round(ratio * 100)}%`);
    }

    let line = parts.join('  ');

    // Append the URL only if there's room, truncated to fit the terminal.
    const columns = this.stream.columns ?? 100;
    const visibleLength = stripAnsi(line).length;
    const room = columns - visibleLength - 4;
    if (room > 20 && this.currentUrl) {
      const url = this.currentUrl.length > room
        ? `…${this.currentUrl.slice(-(room - 1))}`
        : this.currentUrl;
      line += `  \x1b[90m${url}\x1b[0m`;
    }

    const rendered = stripAnsi(line);
    this.stream.write(`\r${' '.repeat(this.lastLineLength)}\r${line}`);
    this.lastLineLength = rendered.length;
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
