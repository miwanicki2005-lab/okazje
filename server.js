import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getDeals, getFree, parseDealParams } from './src/app.js';
import { FacebookStore } from './src/sources/facebook.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IMPORT_TOKEN = process.env.IMPORT_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const cfg = loadConfig();
const fbStore = new FacebookStore(path.join(DATA_DIR, 'facebook-posts.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, data, extra = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...extra });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Import-Token',
};

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Za duże żądanie'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Nie znaleziono', { 'Content-Type': 'text/plain; charset=utf-8' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function userscript(req, url) {
  const tpl = fs.readFileSync(path.join(ROOT, 'userscript', 'fb-import.user.js'), 'utf8');
  const server = origin(req);
  const token = url.searchParams.get('token') || '';
  const { protocol, hostname } = new URL(server);
  return tpl
    .replaceAll('__SERVER_URL__', server)
    .replaceAll('__SERVER_MATCH__', `${protocol}//${hostname}/*`)
    .replaceAll('__SERVER_HOST__', hostname)
    .replaceAll('__IMPORT_TOKEN__', token.replace(/[^\w-]/g, ''));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const q = Object.fromEntries(url.searchParams);

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', CORS);

    if (pathname === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

    if (pathname === '/api/config') {
      return json(res, 200, { ...cfg, importTokenRequired: !!IMPORT_TOKEN, fbLastImport: fbStore.lastImport });
    }

    if (pathname === '/api/deals' && req.method === 'GET') {
      return json(res, 200, await getDeals(cfg, parseDealParams(q)));
    }

    if (pathname === '/api/free' && req.method === 'GET') {
      return json(res, 200, await getFree(cfg, fbStore, q));
    }

    if (pathname === '/api/fb/import' && req.method === 'POST') {
      if (IMPORT_TOKEN && req.headers['x-import-token'] !== IMPORT_TOKEN) {
        return json(res, 401, { error: 'Zły token importu (IMPORT_TOKEN)' }, CORS);
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, fbStore.import(body.posts), CORS);
    }

    if (pathname === '/api/fb' && req.method === 'GET') {
      return json(res, 200, { lastImport: fbStore.lastImport, items: fbStore.list() });
    }

    if (pathname === '/api/fb/clear' && req.method === 'POST') {
      if (IMPORT_TOKEN && req.headers['x-import-token'] !== IMPORT_TOKEN) return json(res, 401, { error: 'Zły token' });
      fbStore.clear();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/fb-import.user.js') {
      return send(res, 200, userscript(req, url), { 'Content-Type': 'text/javascript; charset=utf-8' });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Nie ma takiego endpointu' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}:`, e);
    if (!res.headersSent) json(res, 500, { error: e.message || 'Błąd serwera' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Okazje ${cfg.cityName} działa na http://localhost:${PORT}`);
});
