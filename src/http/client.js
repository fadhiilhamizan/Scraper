/**
 * HTTP request engine.
 *
 * Built on undici for connection pooling, HTTP/2 and proxy support. Handles
 * the unglamorous parts properly: content decoding, charset detection, byte
 * caps, redirect chains, and a timeout that actually fires.
 *
 * It deliberately knows nothing about queues, retries or parsing — those live
 * in their own modules. This makes it usable standalone.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Agent, ProxyAgent, interceptors, request as undiciRequest } from 'undici';

import { HttpError, NetworkError, TimeoutError, toHarvesterError } from '../utils/errors.js';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);
// Node >= 22.15 ships zstd; treat it as optional so older runtimes still work.
const zstdDecompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;

const ACCEPT_ENCODING = zstdDecompress ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';

/** Content types we are willing to buffer as text. */
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|x-www-form-urlencoded))/i;

async function decompress(buffer, encoding) {
  if (!buffer.length) return buffer;
  const enc = String(encoding ?? '').toLowerCase().trim();
  try {
    switch (enc) {
      case 'gzip':
      case 'x-gzip':
        return await gunzip(buffer);
      case 'deflate':
        // Some servers send raw deflate despite the header. Detect via zlib magic.
        return (buffer[0] & 0x0f) === 0x08 ? await inflate(buffer) : await inflateRaw(buffer);
      case 'br':
        return await brotliDecompress(buffer);
      case 'zstd':
        return zstdDecompress ? await zstdDecompress(buffer) : buffer;
      default:
        return buffer;
    }
  } catch {
    // A malformed body is better surfaced as garbled text than as a hard crash.
    return buffer;
  }
}

/** Pull the charset from a Content-Type header, then from an HTML `<meta>` tag. */
export function detectCharset(contentTypeHeader, buffer) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentTypeHeader ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  // Only the head of the document can legally declare the charset.
  const head = buffer.subarray(0, 2048).toString('latin1');
  const meta =
    /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=\s*([\w-]+)/i.exec(head)?.[1] ??
    /encoding=["']([\w-]+)["']/i.exec(head)?.[1]; // XML declaration
  return meta ? meta.toLowerCase() : 'utf-8';
}

function decodeBody(buffer, charset) {
  const normalized = (charset || 'utf-8').replace(/^utf8$/, 'utf-8');
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch {
    // Unknown label — fall back rather than lose the page.
    return buffer.toString('utf8');
  }
}

function headersToObject(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  // Preserve multiple Set-Cookie values, which must not be comma-joined.
  if (Array.isArray(raw?.['set-cookie'])) out['set-cookie'] = raw['set-cookie'];
  else if (raw?.['set-cookie']) out['set-cookie'] = [raw['set-cookie']];
  return out;
}

export class HttpClient {
  /**
   * @param {object} [options]
   * @param {number}  [options.timeoutMs=30000]     Whole-request budget.
   * @param {number}  [options.connectTimeoutMs=10000]
   * @param {number}  [options.maxRedirects=5]
   * @param {number}  [options.maxResponseBytes=10485760] 10 MiB cap.
   * @param {boolean} [options.http2=false]
   * @param {boolean} [options.rejectUnauthorized=true] Set false only for
   *          corporate MITM proxies — it disables TLS verification.
   * @param {number}  [options.maxConnectionsPerHost=8]
   */
  constructor(options = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 30_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      maxRedirects: options.maxRedirects ?? 5,
      maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
      http2: options.http2 === true,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      maxConnectionsPerHost: options.maxConnectionsPerHost ?? 8,
      keepAliveMs: options.keepAliveMs ?? 4000,
    };

    this.defaultAgent = new Agent({
      connect: {
        timeout: this.options.connectTimeoutMs,
        rejectUnauthorized: this.options.rejectUnauthorized,
      },
      allowH2: this.options.http2,
      connections: this.options.maxConnectionsPerHost,
      keepAliveTimeout: this.options.keepAliveMs,
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
    });

    /** @type {Map<string, ProxyAgent>} */
    this.proxyAgents = new Map();
    /** Composed dispatchers, keyed by proxy + redirect limit. */
    this.dispatchers = new Map();
    this.closed = false;
  }

  #agentFor(proxyUrl) {
    if (!proxyUrl) return this.defaultAgent;
    let agent = this.proxyAgents.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent({
        uri: proxyUrl,
        connect: {
          timeout: this.options.connectTimeoutMs,
          rejectUnauthorized: this.options.rejectUnauthorized,
        },
        requestTls: { rejectUnauthorized: this.options.rejectUnauthorized },
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
      });
      this.proxyAgents.set(proxyUrl, agent);
    }
    return agent;
  }

  /**
   * Redirect following moved out of `request()` and into an interceptor in
   * undici v7, so each (proxy, redirect-limit) pair needs its own composed
   * dispatcher. They're cached because composing allocates.
   */
  #dispatcherFor(proxyUrl, maxRedirects) {
    const key = `${proxyUrl ?? 'direct'}|${maxRedirects}`;
    let dispatcher = this.dispatchers.get(key);
    if (!dispatcher) {
      const agent = this.#agentFor(proxyUrl);
      dispatcher = maxRedirects > 0
        ? agent.compose(interceptors.redirect({ maxRedirections: maxRedirects, throwOnMaxRedirects: false }))
        : agent;
      this.dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  /**
   * Perform a request.
   *
   * @param {object} req
   * @param {string} req.url
   * @param {string} [req.method='GET']
   * @param {Record<string,string>} [req.headers]
   * @param {string|Buffer|object} [req.body]  Objects are JSON-encoded.
   * @param {string} [req.proxy]               Proxy URL for this request.
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.timeoutMs]
   * @param {boolean} [req.throwOnError=true]  Throw on 4xx/5xx.
   * @returns {Promise<{status:number, headers:object, body:string, buffer:Buffer,
   *          url:string, redirects:string[], durationMs:number, contentType:string,
   *          charset:string, fromCache:false}>}
   */
  async request(req) {
    if (this.closed) throw new NetworkError('HTTP client has been closed');

    const {
      url,
      method = 'GET',
      headers = {},
      body,
      proxy = null,
      signal,
      timeoutMs = this.options.timeoutMs,
      maxRedirects = this.options.maxRedirects,
      maxResponseBytes = this.options.maxResponseBytes,
      throwOnError = true,
    } = req;

    const outgoing = { 'accept-encoding': ACCEPT_ENCODING };
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      outgoing[k.toLowerCase()] = String(v);
    }

    let payload = body;
    if (payload != null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      if (payload instanceof URLSearchParams) {
        payload = payload.toString();
        outgoing['content-type'] ??= 'application/x-www-form-urlencoded';
      } else {
        payload = JSON.stringify(payload);
        outgoing['content-type'] ??= 'application/json';
      }
    }

    // One controller drives both our timeout and any caller-supplied signal.
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const started = performance.now();
    try {
      const response = await undiciRequest(url, {
        method: method.toUpperCase(),
        headers: outgoing,
        body: payload,
        dispatcher: this.#dispatcherFor(proxy, maxRedirects),
        signal: controller.signal,
      });

      const chunks = [];
      let total = 0;
      let truncated = false;

      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxResponseBytes) {
          truncated = true;
          // Stop pulling; undici releases the connection when we break out.
          break;
        }
        chunks.push(chunk);
      }
      if (truncated) response.body.destroy?.();

      const rawBuffer = Buffer.concat(chunks);
      const responseHeaders = headersToObject(response.headers);
      const buffer = await decompress(rawBuffer, responseHeaders['content-encoding']);

      const contentTypeHeader = responseHeaders['content-type'] ?? '';
      const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase();
      const charset = detectCharset(contentTypeHeader, buffer);
      const isText = !contentType || TEXTUAL.test(contentType);

      // The redirect chain ends at whatever undici last requested.
      const history = response.context?.history?.map((u) => u.toString()) ?? [];
      const finalUrl = history.length ? history[history.length - 1] : url;

      const durationMs = performance.now() - started;

      const result = {
        url: finalUrl,
        requestUrl: url,
        status: response.statusCode,
        statusText: '',
        headers: responseHeaders,
        buffer,
        body: isText ? decodeBody(buffer, charset) : '',
        contentType,
        charset,
        bytes: buffer.length,
        truncated,
        redirects: history.slice(0, -1),
        redirected: history.length > 1,
        durationMs: +durationMs.toFixed(1),
        fromCache: false,
        proxy: proxy ?? null,
      };

      if (throwOnError && response.statusCode >= 400) {
        throw new HttpError(`HTTP ${response.statusCode} for ${url}`, {
          status: response.statusCode,
          url: finalUrl,
          headers: responseHeaders,
          body: result.body.slice(0, 2000),
          response: result,
        });
      }

      return result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (timedOut) {
        throw new TimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`, {
          url,
          timeoutMs,
          cause: error,
        });
      }
      throw toHarvesterError(error, `Request to ${url} failed`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  get(url, options = {}) {
    return this.request({ ...options, url, method: 'GET' });
  }

  post(url, body, options = {}) {
    return this.request({ ...options, url, method: 'POST', body });
  }

  head(url, options = {}) {
    return this.request({ ...options, url, method: 'HEAD' });
  }

  async close() {
    this.closed = true;
    const closers = [this.defaultAgent.close().catch(() => {})];
    for (const agent of this.proxyAgents.values()) closers.push(agent.close().catch(() => {}));
    this.proxyAgents.clear();
    // Composed dispatchers wrap the agents above; closing the agents is enough.
    this.dispatchers.clear();
    await Promise.all(closers);
  }
}

export function createHttpClient(options) {
  return new HttpClient(options);
}
