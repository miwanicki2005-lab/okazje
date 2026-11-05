import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dataDir;

// Podmieniamy globalny fetch w procesie serwera, żeby test nie zależał od sieci.
const preload = `
const olx = ${JSON.stringify(fixture('olx.json'))};
const oddam = ${JSON.stringify(fixture('allegro-oddam.html'))};
const iphone = ${JSON.stringify(fixture('allegro-iphone.html'))};
const mode = process.env.OLX_MODE;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes('olx.pl')) {
    if (mode === 'blocked') return new Response('blocked', { status: 403 });
    return new Response(olx, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('allegrolokalnie.pl')) {
    const html = /oddam|darmo|gratis/.test(decodeURIComponent(url)) ? oddam : iphone;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  throw new Error('unexpected ' + url);
};
`;

async function startServer(env) {
  const preloadFile = path.join(dataDir, 'preload.mjs');
  fs.writeFileSync(preloadFile, preload);
  const p = spawn(process.execPath, ['--import', preloadFile, 'server.js'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => String(d).includes('działa') && resolve());
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  return p;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okazje-'));
  proc = await startServer({ IMPORT_TOKEN: 'sekret' });
});
after(() => proc?.kill());

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};

test('strona główna i pliki statyczne', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /Okazje/);
  assert.equal((await get('/shared/core.js')).status, 200);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js']) {
    const r = await get(p);
    assert.ok([403, 404].includes(r.status), p);
    assert.doesNotMatch(String(r.body), /createServer/);
  }
});

test('/api/deals łączy OLX i Allegro, filtruje cenę i liczy medianę', async () => {
  const { status, body } = await get('/api/deals?q=iphone&min=400&max=1500&sources=olx,allegro');
  assert.equal(status, 200);
  assert.equal(body.sources.olx.ok, true);
  assert.equal(body.sources.allegro.ok, true);
  assert.ok(body.items.length > 10);
  assert.ok(body.items.every((i) => i.price >= 400 && i.price <= 1500));
  assert.ok(body.items.some((i) => i.source === 'olx'));
  assert.ok(body.items.some((i) => i.source === 'allegro'));
  assert.ok(body.marketMedian > 0);
  assert.ok(body.items.some((i) => Number.isFinite(i.belowPct)));
  assert.ok(body.items.filter((i) => i.price < body.marketMedian * 0.25).every((i) => i.belowPct == null));
  assert.equal(body.fallback, null);
});

test('/api/deals bez firm odrzuca oferty firmowe', async () => {
  const { body } = await get('/api/deals?q=iphone&max=1500&sources=olx&private=1');
  assert.ok(body.items.every((i) => !i.business));
});

test('/api/free pokazuje tylko darmowe i chowa "przyjmę"', async () => {
  const { body } = await get('/api/free?sources=olx,allegro');
  assert.ok(body.items.length > 5);
  assert.ok(body.items.every((i) => i.free));
  assert.ok(!body.items.some((i) => /przyjmę/i.test(i.title)));
  assert.ok(body.items.some((i) => i.source === 'olx' && i.title.startsWith('Szafa')));
  const withWanted = await get('/api/free?sources=olx&wanted=1');
  assert.ok(withWanted.body.items.some((i) => /przyjmę/i.test(i.title)));
});

test('import z FB: token, zapis, deduplikacja, widoczne w /api/free', async () => {
  const post = (body, token) =>
    fetch(`${BASE}/api/fb/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Import-Token': token } : {}) },
      body: JSON.stringify(body),
    });
  const posts = [
    { id: 'fb:123:1', url: 'https://www.facebook.com/groups/123/posts/1/', text: 'Oddam kanapę\nOdbiór Nadodrze', group: 'Oddam za darmo Wrocław', image: 'https://scontent.xx.fbcdn.net/a.jpg' },
    { id: 'fb:123:2', url: 'https://www.facebook.com/groups/123/posts/2/', text: 'Przyjmę pralkę', group: 'Oddam za darmo Wrocław' },
    { id: 'evil', url: 'https://evil.example.com/', text: 'x' },
  ];
  assert.equal((await post({ posts })).status, 401);
  const r1 = await (await post({ posts }, 'sekret')).json();
  assert.deepEqual([r1.added, r1.total], [2, 2]);
  const r2 = await (await post({ posts: [{ ...posts[0], text: 'Oddam kanapę\nOdbiór Nadodrze, 3 piętro' }] }, 'sekret')).json();
  assert.deepEqual([r2.added, r2.updated, r2.total], [0, 1, 2]);

  const { body } = await get('/api/free?sources=fb');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].title, 'Oddam kanapę');
  assert.equal(body.items[0].group, 'Oddam za darmo Wrocław');
  assert.match(body.items[0].description, /3 piętro/);
  assert.ok(body.sources.fb.lastImport);

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'facebook-posts.json'), 'utf8'));
  assert.equal(saved.posts.length, 2);
});

test('userscript ma wstawiony adres serwera i token', async () => {
  const { status, body } = await get('/fb-import.user.js?token=sekret');
  assert.equal(status, 200);
  assert.match(body, /==UserScript==/);
  assert.ok(body.includes(`'${BASE}'`));
  assert.ok(body.includes("'sekret'"));
  assert.ok(body.includes('@connect      127.0.0.1'));
  assert.ok(body.includes('@match        http://127.0.0.1/*'));
  assert.ok(!body.includes('__SERVER_'));
});

test('gdy OLX blokuje serwer: Allegro działa, a frontend dostaje URL-e do pobrania z przeglądarki', async () => {
  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
  proc = await startServer({ OLX_MODE: 'blocked' });
  const { body } = await get('/api/deals?q=iphone&max=1500');
  assert.equal(body.sources.olx.ok, false);
  assert.equal(body.sources.olx.blocked, true);
  assert.equal(body.sources.allegro.ok, true);
  assert.ok(body.items.length > 0);
  assert.ok(body.fallback.olx[0].startsWith('https://www.olx.pl/api/v1/offers/'));
  const free = await get('/api/free?sources=olx,allegro');
  assert.ok(free.body.fallback.olx.length >= 5);
  assert.ok(free.body.items.length > 0);
});
