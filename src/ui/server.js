/**
 * The local web server behind `harvest ui`.
 *
 * Security posture — this listens on a TCP port, so it matters:
 *
 *  - **Loopback only.** Binds to 127.0.0.1 unless you explicitly pass a host.
 *  - **Session token.** A random token is generated at startup and baked into
 *    the served page. Every API call must present it. This is what stops a
 *    malicious web page you happen to have open from driving your scraper via
 *    `fetch('http://localhost:4180/api/runs', …)`.
 *  - **Origin and Host checks.** Cross-origin requests are rejected outright;
 *    no CORS headers are ever sent.
 *
 * The API surface is deliberately small and lives in `api.js`; this file is
 * plumbing: routing, static files, SSE, and shutdown.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { JobManager } from './jobs.js';
import { createApi, ApiError } from './api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ApiError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('Request body is not valid JSON.');
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {object} [options]
 * @param {number} [options.port=4180]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.workspace=process.cwd()] Where recipes live.
 * @param {string} [options.runsDir]
 * @param {string} [options.token] Override the generated session token.
 */
export async function createServer(options = {}) {
  const port = options.port ?? 4180;
  const host = options.host ?? '127.0.0.1';
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const token = options.token ?? randomBytes(24).toString('base64url');
  const version = options.version ?? '1.0.0';

  await fsp.mkdir(workspace, { recursive: true });

  const jobs = new JobManager({ dir: options.runsDir ?? path.join(workspace, '.harvester', 'ui', 'runs') });
  await jobs.init();

  const api = createApi({ workspace, jobs, version });

  /** Reject anything that isn't same-origin. */
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin navigations and curl send no Origin
    try {
      const url = new URL(origin);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === host;
    } catch {
      return false;
    }
  }

  function authorised(req, url) {
    const provided = req.headers['x-harvest-token'] ?? url.searchParams.get('token');
    if (provided !== token) return false;
    return originAllowed(req);
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);

    // Refuse anything that escapes the public directory.
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
      return send(res, 403, { error: 'Forbidden' });
    }

    let content;
    try {
      content = await fsp.readFile(file);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }

    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    if (ext === '.html') {
      // The session token is injected into the page rather than exposed on an
      // endpoint, so only a document served by this process can obtain it.
      // The one inline script carries a per-response nonce; without it the CSP
      // below would block it along with everything else.
      const nonce = randomBytes(16).toString('base64');
      content = Buffer.from(
        content.toString('utf8')
          .replace('__HARVEST_NONCE__', nonce)
          .replace('__HARVEST_TOKEN__', token),
        'utf8',
      );
      // Everything is local; no outbound requests are permitted at all.
      headers['content-security-policy'] =
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    }

    res.writeHead(200, headers);
    res.end(content);
  }

  /** Server-Sent Events stream for one run. */
  function streamRun(req, res, id) {
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: `Run '${id}' not found.` });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const write = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    write('snapshot', job.snapshot());

    // A persisted (reloaded-from-disk) run has no live events to send.
    if (typeof job.on !== 'function') {
      write('end', job.summary());
      return res.end();
    }

    const onStats = (stats) => write('stats', stats);
    const onItem = (item) => write('item', item);
    const onLog = (record) => write('log', record);
    const onStatus = (status) => write('status', { status });
    const onEnd = (summary) => {
      write('end', { ...summary, stats: job.stats, report: job.report });
      cleanup();
      res.end();
    };

    job.on('stats', onStats);
    job.on('item', onItem);
    job.on('log', onLog);
    job.on('status', onStatus);
    job.on('end', onEnd);

    // Proxies and some browsers drop an idle stream; a comment keeps it warm.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20_000);
    keepAlive.unref?.();

    function cleanup() {
      clearInterval(keepAlive);
      job.off('stats', onStats);
      job.off('item', onItem);
      job.off('log', onLog);
      job.off('status', onStatus);
      job.off('end', onEnd);
    }

    req.on('close', cleanup);

    if (job.status !== 'running' && job.status !== 'starting') {
      write('end', { ...job.summary(), stats: job.stats, report: job.report });
      cleanup();
      res.end();
    }
  }

  /** Route table: [method, pattern, handler]. `:id` captures a segment. */
  const routes = [
    ['GET', '/api/bootstrap', () => api.bootstrap()],
    ['GET', '/api/recipes', () => api.listRecipes()],
    ['GET', '/api/recipes/:name', ({ params }) => api.readRecipe(params.name)],
    ['PUT', '/api/recipes/:name', ({ params, body }) => api.saveRecipe(params.name, body.text)],
    ['DELETE', '/api/recipes/:name', ({ params }) => api.deleteRecipe(params.name)],
    ['POST', '/api/validate', ({ body }) => api.validateRecipe(body)],
    ['GET', '/api/templates/:name', ({ params }) => api.getTemplate(params.name)],
    ['POST', '/api/inspect', ({ body }) => api.inspect(body)],
    ['POST', '/api/generate', ({ body }) => api.generate(body)],
    ['POST', '/api/test', ({ body }) => api.test(body)],
    ['POST', '/api/robots', ({ body }) => api.robots(body)],
    ['GET', '/api/runs', () => api.listRuns()],
    ['POST', '/api/runs', ({ body }) => api.startRun(body)],
    ['GET', '/api/runs/:id', ({ params }) => api.getRun(params.id)],
    ['POST', '/api/runs/:id/stop', ({ params }) => api.stopRun(params.id)],
    ['DELETE', '/api/runs/:id', ({ params }) => api.deleteRun(params.id)],
    ['GET', '/api/runs/:id/data', ({ params, url }) => api.runData(params.id, {
      limit: Number(url.searchParams.get('limit') ?? 1000),
      offset: Number(url.searchParams.get('offset') ?? 0),
    })],
  ];

  function match(method, pathname) {
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const patternParts = pattern.split('/');
      const pathParts = pathname.split('/');
      if (patternParts.length !== pathParts.length) continue;

      const params = {};
      let ok = true;
      for (let i = 0; i < patternParts.length; i += 1) {
        if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (patternParts[i] !== pathParts[i]) { ok = false; break; }
      }
      if (ok) return { handler, params };
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? host}`);
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const { pathname } = url;

    // No CORS, ever. A preflight means someone is calling us cross-origin.
    if (req.method === 'OPTIONS') return send(res, 405, { error: 'Not allowed' });

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    if (!authorised(req, url)) {
      return send(res, 401, {
        error: 'Unauthorised. Open the interface from the URL printed by `harvest ui`.',
      });
    }

    // Downloads: stream a file or a generated body.
    const download = pathname.match(/^\/api\/runs\/([^/]+)\/download$/);
    if (download && req.method === 'GET') {
      try {
        const result = await api.runDownload(download[1], url.searchParams.get('format') ?? 'ndjson');
        const headers = {
          'content-type': result.contentType,
          'content-disposition': `attachment; filename="${result.filename}"`,
          'cache-control': 'no-store',
        };
        if (result.file) {
          res.writeHead(200, headers);
          return fs.createReadStream(result.file).pipe(res);
        }
        return send(res, 200, result.body, headers);
      } catch (error) {
        return send(res, error.status ?? 500, { error: error.message });
      }
    }

    const stream = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (stream && req.method === 'GET') return streamRun(req, res, stream[1]);

    const route = match(req.method, pathname);
    if (!route) return send(res, 404, { error: `No route for ${req.method} ${pathname}` });

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await route.handler({ params: route.params, body, url, req });
      return send(res, 200, result ?? {});
    } catch (error) {
      const status = error.status ?? (error.name === 'ConfigError' ? 400 : 500);
      if (status >= 500) {
        process.stderr.write(`[harvest ui] ${req.method} ${pathname} failed: ${error.stack ?? error.message}\n`);
      }
      return send(res, status, {
        error: error.message,
        issues: error.issues ?? undefined,
      });
    }
  });

  server.headersTimeout = 0;
  server.requestTimeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}/?token=${token}`;

  return {
    server,
    jobs,
    api,
    url,
    token,
    port: actualPort,
    host,
    workspace,
    async close() {
      jobs.stopAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Best-effort "open the browser", used by `harvest ui --open`. */
export async function openBrowser(url) {
  const { spawn } = await import('node:child_process');
  const command = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
