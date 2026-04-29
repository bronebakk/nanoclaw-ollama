/**
 * Local HTTP channel — a localhost-only web chat for non-technical users.
 *
 * Binds an HTTP server to 127.0.0.1 and serves a tiny SPA from `web/local-chat/`.
 * The browser POSTs messages to /api/messages and polls /api/messages?since=<seq>
 * for replies. Designed for single-user, single-machine use — there is no auth
 * because the loopback bind IS the auth boundary.
 *
 * Wire format:
 *   POST /api/messages          body: { "text": "..." }            → 202 Accepted
 *   GET  /api/messages?since=N  → { "messages": [{seq, text, ts}], "cursor": M }
 *   GET  /api/info              → { "channelType", "platformId", "ready" }
 *   GET  /                      → index.html (the SPA)
 *   GET  /assets/*              → static SPA assets
 *
 * Outbound buffer: last 100 deliveries are kept in memory so a client that
 * polls slowly (or reloads the page) can catch up without losing messages.
 * Persistent history lives in `outbound.db`; this buffer is just for
 * convenience — it isn't a durability layer.
 *
 * Wiring required (one-time): create a messaging_groups row with
 * channel_type='local-http' and platform_id='browser' and wire it to your
 * agent group. `/init-first-agent` covers this when you pick the local-http
 * channel.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'local-http';
const PLATFORM_ID = 'browser';
const SENDER_ID = `${CHANNEL_TYPE}:user`;
const DEFAULT_PORT = 3030;
const BUFFER_LIMIT = 100;

const WEB_ROOT = path.resolve(process.cwd(), 'web', 'local-chat');

interface BufferedReply {
  seq: number;
  text: string;
  timestamp: string;
}

function createAdapter(): ChannelAdapter {
  let server: http.Server | null = null;
  const outbound: BufferedReply[] = [];
  let nextSeq = 1;

  const adapter: ChannelAdapter = {
    name: 'local-http',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const port = parseInt(process.env.LOCAL_HTTP_PORT || String(DEFAULT_PORT), 10);

      server = http.createServer((req, res) => {
        void handleRequest(req, res, config, outbound);
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        // Loopback only — never expose this to the network. The SPA has no
        // auth, so the bind address IS the trust boundary.
        server!.listen(port, '127.0.0.1', () => {
          log.info('Local HTTP channel listening', { url: `http://127.0.0.1:${port}` });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;

      outbound.push({ seq: nextSeq++, text, timestamp: new Date().toISOString() });
      while (outbound.length > BUFFER_LIMIT) outbound.shift();
      return undefined;
    },
  };

  return adapter;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
  outbound: BufferedReply[],
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const method = req.method || 'GET';

  try {
    if (method === 'POST' && url.pathname === '/api/messages') {
      return await handlePostMessage(req, res, config);
    }
    if (method === 'GET' && url.pathname === '/api/messages') {
      return handleGetMessages(url, res, outbound);
    }
    if (method === 'GET' && url.pathname === '/api/info') {
      return sendJson(res, 200, { channelType: CHANNEL_TYPE, platformId: PLATFORM_ID, ready: true });
    }
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname.startsWith('/assets/')) {
      // Strip the leading slash and resolve under WEB_ROOT. path.resolve with
      // an absolute base + a relative tail prevents `..` traversal escapes.
      const rel = url.pathname.slice('/assets/'.length);
      return serveStatic(res, path.join('assets', rel), guessContentType(rel));
    }
    sendText(res, 404, 'Not found');
  } catch (err) {
    log.error('local-http: request handler threw', { url: req.url, err });
    sendText(res, 500, 'Internal Server Error');
  }
}

async function handlePostMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
): Promise<void> {
  // CSRF guard: browsers cannot send Content-Type: application/json on a
  // cross-site form post without triggering a preflight. Requiring it blocks
  // drive-by submissions from another origin even though we're on loopback.
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    sendText(res, 415, 'Content-Type must be application/json');
    return;
  }

  const body = await readBody(req, 64 * 1024);
  let payload: { text?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    sendText(res, 400, 'Invalid JSON');
    return;
  }

  if (typeof payload.text !== 'string' || payload.text.length === 0) {
    sendText(res, 400, 'Missing text');
    return;
  }

  await config.onInbound(PLATFORM_ID, null, {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: {
      text: payload.text,
      sender: 'local',
      senderId: SENDER_ID,
    },
  });

  sendJson(res, 202, { ok: true });
}

function handleGetMessages(url: URL, res: http.ServerResponse, outbound: BufferedReply[]): void {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? parseInt(sinceRaw, 10) : 0;
  const filtered = outbound.filter((m) => m.seq > (Number.isFinite(since) ? since : 0));
  const cursor = filtered.length > 0 ? filtered[filtered.length - 1]!.seq : since;
  sendJson(res, 200, { messages: filtered, cursor });
}

function serveStatic(res: http.ServerResponse, relPath: string, contentType: string): void {
  const full = path.resolve(WEB_ROOT, relPath);
  // Defense in depth: even though path.resolve normalizes `..`, double-check
  // the resolved path is under WEB_ROOT before reading.
  if (!full.startsWith(WEB_ROOT + path.sep) && full !== WEB_ROOT) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('local-http', { factory: createAdapter });
