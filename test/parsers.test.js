import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOlxResponse, buildOlxUrl } from '../public/shared/olx.js';
import { parseAllegroHtml, buildAllegroUrl } from '../src/sources/allegro.js';
import { parseVintedHtml, buildVintedUrl } from '../src/sources/vinted.js';
import { FacebookStore } from '../src/sources/facebook.js';
import { looksFree, looksWanted, robustMedian, applyDealFilters, annotateBelowMarket, parseWords, sortItems, interleave } from '../public/shared/core.js';
import os from 'node:os';
import path from 'node:path';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('OLX: parsuje oferty, ceny, darmowe i zamiany', () => {
  const { items, total } = parseOlxResponse(JSON.parse(fixture('olx.json')));
  assert.equal(items.length, 4);
  assert.equal(total, 4);
  const [szafa, iphone, zamiana, przyjme] = items;
  assert.equal(szafa.free, true);
  assert.equal(szafa.price, 0);
  assert.equal(szafa.location, 'Wrocław, Krzyki');
  assert.equal(szafa.image, 'https://ireland.apollo.olxcdn.com:443/v1/files/abc/image;s=400x300');
  assert.match(szafa.description, /dwudrzwiowa,\nstan dobry/);
  assert.equal(iphone.price, 1450);
  assert.equal(iphone.free, false);
  assert.equal(iphone.business, true);
  assert.equal(iphone.negotiable, true);
  assert.equal(iphone.createdAt, '2026-11-05T08:00:00+01:00');
  assert.equal(zamiana.price, null);
  assert.equal(zamiana.free, false);
  assert.equal(przyjme.wanted, true);
});

test('OLX: buduje URL API z filtrami ceny i miasta', () => {
  const u = new URL(buildOlxUrl({ query: 'ps5', cityId: 19701, priceFrom: 100, priceTo: 1500, offset: 50 }));
  assert.equal(u.origin + u.pathname, 'https://www.olx.pl/api/v1/offers/');
  assert.equal(u.searchParams.get('query'), 'ps5');
  assert.equal(u.searchParams.get('city_id'), '19701');
  assert.equal(u.searchParams.get('filter_float_price:from'), '100');
  assert.equal(u.searchParams.get('filter_float_price:to'), '1500');
  assert.equal(u.searchParams.get('offset'), '50');
  assert.equal(u.searchParams.get('sort_by'), 'created_at:desc');
  assert.equal(new URL(buildOlxUrl({ priceTo: 0 })).searchParams.get('filter_float_price:to'), '0');
});

test('Allegro Lokalnie: parsuje prawdziwą stronę "oddam" (Wrocław)', () => {
  const { items, hasNext, total } = parseAllegroHtml(fixture('allegro-oddam.html'));
  assert.equal(items.length, 18);
  assert.equal(total, 18);
  assert.equal(hasNext, false);
  for (const it of items) {
    assert.match(it.url, /^https:\/\/allegrolokalnie\.pl\/oferta\//);
    assert.ok(it.title.length > 2);
    assert.equal(typeof it.price, 'number');
    assert.match(it.id, /^[0-9a-f-]{36}$/);
  }
  const free = items.filter((i) => i.free);
  assert.ok(free.length >= 10, `za mało darmowych: ${free.length}`);
  assert.ok(items.some((i) => i.location === 'Wrocław'));
  assert.ok(items.every((i) => !i.image || i.image.includes('/s360x360/')));
});

test('Allegro Lokalnie: parsuje stronę wyników z cenami', () => {
  const { items, hasNext } = parseAllegroHtml(fixture('allegro-iphone.html'));
  assert.ok(items.length >= 50);
  assert.equal(hasNext, true);
  assert.ok(items.every((i) => i.price >= 500 && i.price <= 900), 'price_from/price_to');
  assert.ok(items.some((i) => /iphone/i.test(i.title)));
});

test('Allegro Lokalnie: URL zawiera frazę, miasto i tylko oferty lokalne', () => {
  const u = new URL(buildAllegroUrl({ query: 'za darmo', city: 'wroclaw', priceTo: 2, page: 2 }));
  assert.equal(u.pathname, '/oferty/q/za%20darmo/wroclaw');
  assert.equal(u.searchParams.get('price_to'), '2');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('zrodlo'), 'lokalnie');
  assert.equal(new URL(buildAllegroUrl({ city: 'wroclaw' })).pathname, '/oferty/wroclaw');
});

test('rozpoznawanie "za darmo" i "przyjmę"', () => {
  for (const t of ['Oddam szafę', 'Kanapa ZA DARMO', 'oddaję książki', 'Gratis biurko', 'Do oddania wózek', 'Krzesła za free']) assert.ok(looksFree(t), t);
  for (const t of ['Sprzedam szafę', 'iPhone 13', 'Rower damski']) assert.ok(!looksFree(t), t);
  for (const t of ['Przyjmę lodówkę', 'Szukam biurka', 'Czy ktoś odda pralkę?']) assert.ok(looksWanted(t), t);
  assert.ok(!looksWanted('Oddam szafę'));
});

test('mediana odporna na skrajne ceny i filtry ofert', () => {
  const prices = [5, 10, 1000, 1100, 1200, 1150, 1050, 1250, 99999, 1000];
  const m = robustMedian(prices);
  assert.ok(m >= 1000 && m <= 1200, String(m));
  const items = [
    { title: 'iPhone 13', price: 900, business: false },
    { title: 'Etui iPhone 13', price: 20, business: false },
    { title: 'iPhone 13 firma', price: 1000, business: true },
    { title: 'iPhone zamiana', price: null },
    { title: 'iPhone za darmo', price: 0, free: true },
    { title: 'Kupię iPhone 13', price: 800, wanted: true },
  ];
  const out = applyDealFilters(items, { min: 10, max: 1200, excludeWords: parseWords('etui, szkło'), privateOnly: true });
  assert.deepEqual(out.map((i) => i.title), ['iPhone 13']);
});

test('Vinted: parsuje katalog HTML i buduje URL', () => {
  const { items } = parseVintedHtml(fixture('vinted-rower.html'));
  assert.ok(items.length >= 20);
  assert.ok(items.every((i) => i.source === 'vinted' && i.price > 0 && i.url.startsWith('https://www.vinted.pl/items/')));
  assert.ok(items.every((i) => i.image?.startsWith('https://')));
  assert.match(items[0].title, /\w/);
  const u = new URL(buildVintedUrl({ query: 'iphone', priceFrom: 100, priceTo: 900, page: 2, sort: 'price' }));
  assert.equal(u.searchParams.get('search_text'), 'iphone');
  assert.equal(u.searchParams.get('price_from'), '100');
  assert.equal(u.searchParams.get('price_to'), '900');
  assert.equal(u.searchParams.get('order'), 'price_low_to_high');
  assert.equal(u.searchParams.get('page'), '2');
});

test('FB: zamienia link do zdjęcia na permalink posta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okz-fb-'));
  const store = new FacebookStore(path.join(dir, 'fb.json'));
  const r = store.import([
    {
      id: 'fb:Uwaga:277',
      url: 'https://www.facebook.com/photo/?fbid=1&set=pcb.2773907126337164',
      text: 'Oddam lampę\nKrzyki',
      group: 'Śmieciarka',
      groupUrl: 'https://www.facebook.com/groups/UwagaSmieciarkaJedzieWroclaw/',
    },
    { id: 'fb:Uwaga:x', url: 'https://www.facebook.com/groups/Uwaga/', text: 'Nowe posty', group: 'x' },
  ]);
  assert.equal(r.added, 1);
  const [p] = store.list();
  assert.equal(p.url, 'https://www.facebook.com/groups/UwagaSmieciarkaJedzieWroclaw/posts/2773907126337164/');
});

test('procent poniżej rynku pomija akcesoria za grosze', () => {
  const out = annotateBelowMarket([{ price: 600 }, { price: 1200 }, { price: 20 }, { price: 0 }], 1000);
  assert.deepEqual(out.map((i) => i.belowPct), [40, -20, null, null]);
});

test('sortowanie najnowsze miesza źródła z datą i bez daty', () => {
  const list = interleave([
    [{ id: 'a', source: 'olx', createdAt: '2026-11-05T08:00:00Z' }, { id: 'b', source: 'olx', createdAt: '2026-11-05T09:00:00Z' }],
    [{ id: 'c', source: 'allegro' }, { id: 'd', source: 'allegro' }],
  ]);
  const ids = sortItems(list, 'new').map((i) => i.id);
  assert.equal(ids.length, 4);
  assert.ok(ids.indexOf('b') < ids.indexOf('a'));
  assert.ok(ids.indexOf('c') < ids.indexOf('d'));
});
