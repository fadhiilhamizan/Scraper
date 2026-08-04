/**
 * HTTP API for the web UI.
 *
 * Every handler returns a plain object (serialised as JSON) or throws an
 * `ApiError`. Long-running work — inspecting, testing, running — is the same
 * code the CLI uses, so the two interfaces can't drift apart.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadRecipe, defineRecipe, toYaml } from '../config/loader.js';
import { normalizeConfig } from '../config/schema.js';
import { PRESETS } from '../config/defaults.js';
import { HttpClient } from '../http/client.js';
import { buildHeaders } from '../http/headers.js';
import { botUserAgent } from '../http/useragent.js';
import { RobotsManager } from '../compliance/robots.js';
import { Page } from '../parse/dom.js';
import { extractItems } from '../parse/extractor.js';
import { listTransforms } from '../process/transforms.js';
import { analyzePage, generateRecipe } from '../cli/inspect.js';
import { TEMPLATES } from '../cli/templates.js';
import { nullLogger } from '../observability/logger.js';
import { ConfigError } from '../utils/errors.js';

export class ApiError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const RECIPE_EXT = /\.(ya?ml|json|m?js)$/i;
/** Recipe names are file names — no separators, no traversal. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function assertSafeName(name) {
  if (!name || !SAFE_NAME.test(name) || name.startsWith('.')) {
    throw new ApiError(`Invalid recipe name '${name}'. Use letters, digits, dots, dashes and underscores.`);
  }
  if (!RECIPE_EXT.test(name)) {
    throw new ApiError(`'${name}' must end in .yaml, .yml, .json, .js or .mjs.`);
  }
  return name;
}

/** Write `text` to a temp recipe so the normal loader path handles it. */
async function withTempRecipe(text, workspace, fn) {
  const file = path.join(workspace, `.harvest-ui-draft-${process.pid}-${Date.now()}.yaml`);
  await fs.writeFile(file, text, 'utf8');
  try {
    return await fn(file);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

export function createApi({ workspace, jobs, version }) {
  const resolve = (name) => path.join(workspace, assertSafeName(name));

  /** Load a recipe from either a saved file or unsaved editor text. */
  async function loadEither({ name, text }, options = {}) {
    if (text != null && text.trim() !== '') {
      return withTempRecipe(text, workspace, (file) => loadRecipe(file, options));
    }
    if (name) return loadRecipe(resolve(name), options);
    throw new ApiError('Provide either a recipe `name` or recipe `text`.');
  }

  return {
    /* ─────────────────────────── bootstrap ──────────────────────────── */

    async bootstrap() {
      let playwright = true;
      try {
        await import('playwright');
      } catch {
        playwright = false;
      }
      return {
        version,
        workspace,
        node: process.version,
        playwright,
        presets: Object.keys(PRESETS),
        templates: Object.keys(TEMPLATES),
        transforms: listTransforms(),
        recipes: await this.listRecipes(),
        runs: jobs.list(),
      };
    },

    /* ──────────────────────────── recipes ───────────────────────────── */

    async listRecipes() {
      let entries;
      try {
        entries = await fs.readdir(workspace, { withFileTypes: true });
      } catch {
        return [];
      }

      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() || !RECIPE_EXT.test(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(workspace, entry.name);
        const stat = await fs.stat(full).catch(() => null);

        let title = null;
        let startUrl = null;
        let valid = true;
        let error = null;
        try {
          const { config } = await loadRecipe(full);
          title = config.description || config.name;
          startUrl = config.startUrls?.[0]?.url ?? null;
        } catch (e) {
          valid = false;
          error = e.message.split('\n')[0];
        }

        out.push({
          name: entry.name,
          size: stat?.size ?? 0,
          modified: stat ? new Date(stat.mtimeMs).toISOString() : null,
          title,
          startUrl,
          valid,
          error,
        });
      }
      return out.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
    },

    async readRecipe(name) {
      const file = resolve(name);
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        throw new ApiError(`Recipe '${name}' not found.`, 404);
      }
      // A JavaScript recipe has to be loaded from its real path (it may import
      // relative modules); YAML and JSON validate straight from the text.
      const isJs = /\.m?js$/i.test(name);
      const check = await this.validateRecipe(isJs ? { name } : { text });
      return { name, text, editable: !isJs, ...check };
    },

    async saveRecipe(name, text) {
      if (typeof text !== 'string') throw new ApiError('`text` is required.');
      const file = resolve(name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, 'utf8');
      return { name, saved: true, ...(await this.validateRecipe({ text })) };
    },

    async deleteRecipe(name) {
      const file = resolve(name);
      try {
        await fs.unlink(file);
      } catch {
        throw new ApiError(`Recipe '${name}' not found.`, 404);
      }
      return { name, deleted: true };
    },

    /**
     * Validate without running. Returns `valid: false` plus messages rather
     * than throwing — the editor shows these inline as you type.
     */
    async validateRecipe({ name, text, presets = [] }) {
      try {
        const { config, warnings } = await loadEither({ name, text }, { presets });
        const fields = config.extract?.item?.fields ?? config.extract?.fields ?? null;
        return {
          valid: true,
          errors: [],
          warnings,
          summary: {
            name: config.name,
            startUrls: config.startUrls.map((s) => s.url),
            concurrency: config.concurrency,
            perHost: config.concurrencyPerHost,
            requestsPerSecond: config.rateLimit.requestsPerSecond,
            robots: config.robots.enabled,
            render: config.render.mode,
            maxPages: config.maxPages || null,
            fields: fields ? Object.keys(fields) : [],
            itemSelector: config.extract?.item?.selector ?? config.extract?.selector ?? null,
            labels: Object.keys(config.extract ?? {}).filter(
              (k) => !['item', 'fields', 'tables', 'jsonld', 'selector', 'scope'].includes(k),
            ),
            outputs: config.output.map((o) => (typeof o === 'string' ? o : o.path ?? o.format)),
          },
        };
      } catch (error) {
        return {
          valid: false,
          errors: error instanceof ConfigError && error.issues?.length
            ? error.issues
            : [error.message],
          warnings: [],
          summary: null,
        };
      }
    },

    async getTemplate(name) {
      const template = TEMPLATES[name];
      if (!template) throw new ApiError(`Unknown template '${name}'.`, 404);
      return { name, text: template };
    },

    /* ──────────────────────────── inspect ───────────────────────────── */

    async inspect({ url, render = false, robots = true }) {
      if (!url) throw new ApiError('`url` is required.');
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new ApiError(`'${url}' is not a valid URL.`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ApiError('Only http and https URLs are supported.');
      }

      const client = new HttpClient({ timeoutMs: 30_000 });
      const userAgent = botUserAgent();
      try {
        let robotsVerdict = null;
        if (robots) {
          const manager = new RobotsManager({ httpClient: client, userAgent, logger: nullLogger });
          robotsVerdict = await manager.check(url);
          if (!robotsVerdict.allowed) {
            return {
              blocked: true,
              robots: robotsVerdict,
              message: `robots.txt disallows this URL (rule: ${robotsVerdict.reason}).`,
            };
          }
        }

        const response = await client.request({
          url,
          headers: buildHeaders({ url, baseHeaders: { 'user-agent': userAgent } }),
          throwOnError: false,
        });
        const staticHtml = response.body;
        let html = staticHtml;

        if (render) {
          const { Renderer } = await import('../render/renderer.js').catch(() => {
            throw new ApiError(
              'Rendering needs Playwright. Install it with: npm install playwright && npx playwright install chromium',
              501,
            );
          });
          const renderer = new Renderer({ logger: nullLogger });
          try {
            const result = await renderer.render({
              url, waitUntil: 'networkidle', waitForTimeout: 500,
              contextOptions: { userAgent },
            });
            html = result.html;
          } catch (error) {
            throw new ApiError(error.message, 502);
          } finally {
            await renderer.close().catch(() => {});
          }
        }

        return {
          blocked: false,
          analysis: analyzePage({
            html, url, response, robotsVerdict, rendered: render,
            staticHtml: render ? staticHtml : null,
          }),
        };
      } finally {
        await client.close();
      }
    },

    async generate({ url, render = false, name = 'my-scraper' }) {
      const result = await this.inspect({ url, render });
      if (result.blocked) throw new ApiError(result.message, 403);

      const recipe = generateRecipe(result.analysis, {
        name: name.replace(/\.(ya?ml|json|m?js)$/i, ''),
        output: `output/${name.replace(/\.(ya?ml|json|m?js)$/i, '')}.csv`,
      });
      const note = recipe._note;
      delete recipe._note;

      const yaml =
        `# Generated from ${url}\n` +
        '# Review these selectors before running at scale — they are inferred, not verified.\n' +
        (note ? `# ${note}\n` : '') +
        '\n' + toYaml(recipe);

      return { yaml, analysis: result.analysis };
    },

    /* ───────────────────────────── test ─────────────────────────────── */

    /** Fetch one page and report exactly what the recipe would extract. */
    async test({ name, text, url, label, render }) {
      const { config } = await loadEither({ name, text });
      const target = url || config.startUrls[0]?.url;
      if (!target) throw new ApiError('No URL to test — the recipe has no start_urls.');

      const client = new HttpClient(config.http);
      const userAgent = config.identity.userAgent ?? botUserAgent({ contact: config.identity.contact });

      try {
        if (config.robots.enabled) {
          const manager = new RobotsManager({ httpClient: client, userAgent, logger: nullLogger });
          const verdict = await manager.check(target);
          if (!verdict.allowed) {
            return { blocked: true, url: target, message: `robots.txt disallows this URL (${verdict.reason}).` };
          }
        }

        const shouldRender = render != null ? !!render : config.render.mode === 'always';
        let html;
        let response = null;

        if (shouldRender) {
          const { Renderer } = await import('../render/renderer.js').catch(() => {
            throw new ApiError(
              'Rendering needs Playwright. Install it with: npm install playwright && npx playwright install chromium',
              501,
            );
          });
          const renderer = new Renderer({ ...config.render, logger: nullLogger });
          try {
            const result = await renderer.render({
              url: target,
              waitUntil: config.render.waitUntil,
              waitForSelector: config.render.waitForSelector,
              scroll: config.render.scroll,
              actions: config.render.actions,
              contextOptions: { userAgent },
            });
            html = result.html;
          } catch (error) {
            throw new ApiError(error.message, 502);
          } finally {
            await renderer.close().catch(() => {});
          }
        } else {
          response = await client.request({
            url: target,
            headers: buildHeaders({
              url: target,
              baseHeaders: { 'user-agent': userAgent, ...config.http.headers },
            }),
            throwOnError: false,
          });
          html = response.body;
        }

        const page = new Page({ html, url: target, response });
        const routeLabel = label ?? config.startUrls[0]?.label ?? 'default';
        const spec = (config.extract?.[routeLabel]?.fields || config.extract?.[routeLabel]?.item)
          ? config.extract[routeLabel]
          : config.extract;

        if (!spec) throw new ApiError('This recipe has no `extract` block.');

        const result = extractItems(spec, page, { response });
        const fields = spec.item?.fields ?? spec.fields ?? {};

        const coverage = Object.keys(fields).map((field) => {
          const filled = result.items.filter((item) => {
            const v = item[field];
            return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
          }).length;
          return {
            field,
            filled,
            total: result.items.length,
            rate: result.items.length ? Math.round((filled / result.items.length) * 100) : 0,
          };
        });

        return {
          blocked: false,
          url: target,
          label: routeLabel,
          title: page.title(),
          status: response?.status ?? 200,
          rendered: shouldRender,
          bytes: html.length,
          containerSelector: spec.item?.selector ?? spec.selector ?? null,
          containersMatched: result.stats.containers ?? 0,
          items: result.items.slice(0, 50),
          itemCount: result.items.length,
          coverage,
          issues: [...new Set(result.issues)].slice(0, 20),
        };
      } finally {
        await client.close();
      }
    },

    /* ───────────────────────────── runs ─────────────────────────────── */

    async startRun({ name, text, presets = [], overrides = {} }) {
      const clean = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v !== null && v !== undefined && v !== '') clean[k] = v;
      }

      const { config, hooks } = await loadEither({ name, text }, { presets, overrides: clean });
      const job = jobs.create({ name: name ?? config.name ?? 'untitled', config, hooks });
      return { id: job.id, ...job.summary() };
    },

    listRuns() {
      return jobs.list();
    },

    getRun(id) {
      const job = jobs.get(id);
      if (!job) throw new ApiError(`Run '${id}' not found.`, 404);
      return job.snapshot();
    },

    stopRun(id) {
      const job = jobs.get(id);
      if (!job) throw new ApiError(`Run '${id}' not found.`, 404);
      const stopped = job.stop?.() ?? false;
      return { id, stopped, status: job.status };
    },

    async deleteRun(id) {
      const ok = await jobs.remove(id);
      if (!ok) throw new ApiError(`Run '${id}' not found.`, 404);
      return { id, deleted: true };
    },

    /** Read a finished run's records back for the results table. */
    async runData(id, { limit = 1000, offset = 0 } = {}) {
      const job = jobs.get(id);
      if (!job) throw new ApiError(`Run '${id}' not found.`, 404);

      let raw;
      try {
        raw = await fs.readFile(job.dataPath, 'utf8');
      } catch {
        return { items: [], total: 0 };
      }

      const lines = raw.split('\n').filter(Boolean);
      const items = lines
        .slice(offset, offset + limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      return { items, total: lines.length, offset };
    },

    /** Path + filename for a download, converting on the fly where needed. */
    async runDownload(id, format = 'ndjson') {
      const job = jobs.get(id);
      if (!job) throw new ApiError(`Run '${id}' not found.`, 404);

      const { items } = await this.runData(id, { limit: Infinity });
      if (items.length === 0) throw new ApiError('This run produced no records.', 404);

      const base = `${(job.summary().name || 'harvest').replace(/\.[^.]+$/, '')}-${id}`;

      if (format === 'ndjson') {
        return {
          filename: `${base}.ndjson`,
          contentType: 'application/x-ndjson',
          body: `${items.map((i) => JSON.stringify(i)).join('\n')}\n`,
        };
      }
      if (format === 'json') {
        return {
          filename: `${base}.json`,
          contentType: 'application/json',
          body: JSON.stringify(items, null, 2),
        };
      }
      if (format === 'csv' || format === 'xlsx') {
        const { createWriter } = await import('../storage/index.js');
        const tmp = path.join(job.dir, `download.${format}`);
        const writer = createWriter({ path: tmp, format });
        await writer.open();
        await writer.write(items);
        await writer.close();
        return {
          filename: `${base}.${format}`,
          contentType: format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          file: tmp,
        };
      }
      throw new ApiError(`Unsupported download format '${format}'.`);
    },

    /* ──────────────────────────── robots ────────────────────────────── */

    async robots({ url, userAgent }) {
      if (!url) throw new ApiError('`url` is required.');
      const client = new HttpClient();
      const ua = userAgent || botUserAgent();
      try {
        const manager = new RobotsManager({ httpClient: client, userAgent: ua, logger: nullLogger });
        const verdict = await manager.check(url);
        return {
          url,
          userAgent: ua,
          ...verdict,
          crawlDelay: await manager.crawlDelayFor(url),
          sitemaps: await manager.sitemapsFor(url),
        };
      } finally {
        await client.close();
      }
    },

    /** Turn a form-built recipe object into YAML, validating on the way. */
    async toYaml(recipe) {
      try {
        normalizeConfig(recipe);
      } catch (error) {
        throw new ApiError(error.message, 400);
      }
      return { yaml: toYaml(recipe) };
    },
  };
}

export { defineRecipe };
