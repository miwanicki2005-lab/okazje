import {
  applyDealFilters,
  applyFreeFilters,
  annotateBelowMarket,
  dedupe,
  interleave,
  matchesExclude,
  matchesQuery,
  parseWords,
  robustMedian,
  sortItems,
} from '../public/shared/core.js';
import { searchOlx, olxUrls } from './sources/olx.js';
import { searchAllegro } from './sources/allegro.js';
import { searchVinted } from './sources/vinted.js';

export function loadConfig(env = process.env) {
  return {
    cityName: env.CITY_NAME || 'Wrocław',
    olxCityId: Number(env.OLX_CITY_ID || 19701),
    olxDistance: env.OLX_DISTANCE ? Number(env.OLX_DISTANCE) : null,
    allegroCity: env.ALLEGRO_CITY || 'wroclaw',
    vintedCityId: env.VINTED_CITY_ID ? Number(env.VINTED_CITY_ID) : null,
    fbGroups: parseGroups(env.FB_GROUPS),
  };
}

function parseGroups(raw) {
  const fromEnv = String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, url] = s.includes('|') ? s.split('|').map((x) => x.trim()) : [null, s];
      return { name: name || url, url };
    })
    .filter((g) => /^https:\/\/(www\.)?facebook\.com\//.test(g.url));
  if (fromEnv.length) return fromEnv;
  const search = (q) => `https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(q)}`;
  return [
    { name: 'Oddam za darmo Wrocław', url: search('oddam za darmo wrocław') },
    { name: 'Śmieciarka jedzie Wrocław', url: search('śmieciarka jedzie wrocław') },
    { name: 'Oddam / przyjmę Wrocław', url: search('oddam przyjmę wrocław') },
    { name: 'Uwaga śmieciarka jedzie Wrocław', url: search('uwaga śmieciarka jedzie wrocław') },
  ];
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));

async function settle(name, promise) {
  const started = Date.now();
  try {
    const res = await promise;
    return { name, ok: true, items: res.items, total: res.total ?? null, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, items: [], error: e.message || String(e), blocked: !!e.blocked, ms: Date.now() - started };
  }
}

function mergeQueryResults(results) {
  const ok = results.filter((r) => r.ok);
  if (!ok.length) return results[0];
  return { ...ok[0], items: dedupe(ok.flatMap((r) => r.items)) };
}

function statusOf(r) {
  return { ok: r.ok, count: r.items.length, total: r.total ?? null, error: r.error || null, blocked: !!r.blocked, ms: r.ms };
}

export function parseDealParams(q) {
  const sources = String(q.sources || 'olx,allegro,vinted').split(',').filter(Boolean);
  return {
    q: String(q.q || '').trim().slice(0, 100),
    min: num(q.min),
    max: num(q.max),
    sort: ['new', 'price', 'below'].includes(q.sort) ? q.sort : 'new',
    privateOnly: q.private === '1',
    exclude: String(q.exclude || '').slice(0, 500),
    pages: Math.min(Math.max(num(q.pages) || 2, 1), 4),
    sources,
  };
}

export async function getDeals(cfg, p) {
  const fetchSort = p.sort === 'price' ? 'price' : 'new';
  const olxOpts = { query: p.q, cityId: cfg.olxCityId, distance: cfg.olxDistance, priceFrom: p.min, priceTo: p.max, sort: fetchSort };
  const alOpts = { query: p.q, city: cfg.allegroCity, priceFrom: p.min, priceTo: p.max, sort: fetchSort };
  const vinOpts = { query: p.q, cityId: cfg.vintedCityId, priceFrom: p.min, priceTo: p.max, sort: fetchSort };

  const jobs = [];
  if (p.sources.includes('olx')) jobs.push(settle('olx', searchOlx(olxOpts, p.pages)));
  if (p.sources.includes('allegro')) jobs.push(settle('allegro', searchAllegro(alOpts, p.pages)));
  if (p.sources.includes('vinted')) jobs.push(settle('vinted', searchVinted(vinOpts, Math.min(p.pages, 2))));

  // Próbka rynkowa bez limitu ceny — z niej liczymy medianę, żeby wiedzieć co jest "poniżej ceny".
  const refJobs = [];
  if (p.q) {
    if (p.sources.includes('olx')) refJobs.push(settle('olx', searchOlx({ ...olxOpts, priceFrom: p.min, priceTo: undefined }, 2)));
    if (p.sources.includes('allegro')) refJobs.push(settle('allegro', searchAllegro({ ...alOpts, priceFrom: p.min, priceTo: undefined }, 1)));
    if (p.sources.includes('vinted')) refJobs.push(settle('vinted', searchVinted({ ...vinOpts, priceFrom: p.min, priceTo: undefined }, 1)));
  }

  const [results, refs] = await Promise.all([Promise.all(jobs), Promise.all(refJobs)]);
  const excludeWords = parseWords(p.exclude);

  const refPrices = refs
    .flatMap((r) => r.items)
    .filter((it) => !it.free && it.price > 0 && !matchesExclude(it, excludeWords))
    .map((it) => it.price);
  const marketMedian = refPrices.length >= 8 ? robustMedian(refPrices) : null;

  let items = interleave(results.map((r) => r.items));
  items = dedupe(items);
  items = applyDealFilters(items, { min: p.min, max: p.max, excludeWords, privateOnly: p.privateOnly });
  items = annotateBelowMarket(items, marketMedian);
  items = sortItems(items, p.sort);

  const sources = Object.fromEntries(results.map((r) => [r.name, statusOf(r)]));
  const olx = results.find((r) => r.name === 'olx');
  return {
    items,
    marketMedian,
    marketSample: refPrices.length,
    sources,
    fallback: olx && olx.blocked ? { olx: olxUrls(olxOpts, p.pages), olxRef: p.q ? olxUrls({ ...olxOpts, priceTo: undefined }, 2) : [] } : null,
    fetchedAt: new Date().toISOString(),
  };
}

export function freeOlxQueries(cfg) {
  const base = { cityId: cfg.olxCityId, distance: cfg.olxDistance, sort: 'new' };
  return [
    { opts: { ...base, priceTo: 0 }, pages: 2 },
    { opts: { ...base, query: 'oddam' }, pages: 1 },
    { opts: { ...base, query: 'za darmo' }, pages: 1 },
    { opts: { ...base, query: 'oddam za darmo' }, pages: 1 },
    { opts: { ...base, query: 'gratis' }, pages: 1 },
  ];
}

export async function getFree(cfg, fbStore, q) {
  const sources = String(q.sources || 'olx,allegro,fb').split(',').filter(Boolean);
  const hideWanted = q.wanted !== '1';
  const excludeWords = parseWords(String(q.exclude || '').slice(0, 500));
  const textQuery = String(q.q || '').trim().slice(0, 100);

  const jobs = [];
  if (sources.includes('olx')) {
    jobs.push(
      Promise.all(freeOlxQueries(cfg).map(({ opts, pages }) => settle('olx', searchOlx(opts, pages)))).then(mergeQueryResults),
    );
  }
  if (sources.includes('allegro')) {
    const base = { city: cfg.allegroCity, priceTo: 2, sort: 'new' };
    jobs.push(
      Promise.all(['oddam', 'za darmo', 'gratis', 'do oddania'].map((query) => settle('allegro', searchAllegro({ ...base, query }, 1)))).then(
        mergeQueryResults,
      ),
    );
  }
  const results = await Promise.all(jobs);
  const fbItems = sources.includes('fb') ? fbStore.list() : [];

  const lists = results.map((r) => r.items.filter((it) => it.free));
  let items = dedupe(interleave([fbItems, ...lists]));
  items = applyFreeFilters(items, { hideWanted, excludeWords });
  if (textQuery) items = items.filter((it) => matchesQuery(it, textQuery));
  items = sortItems(items, 'new');

  const status = Object.fromEntries(results.map((r) => [r.name, statusOf(r)]));
  if (sources.includes('fb')) status.fb = { ok: true, count: fbItems.length, lastImport: fbStore.lastImport };
  const olx = results.find((r) => r.name === 'olx');
  return {
    items,
    sources: status,
    fallback: olx && olx.blocked ? { olx: freeOlxQueries(cfg).flatMap(({ opts, pages }) => olxUrls(opts, pages)) } : null,
    fetchedAt: new Date().toISOString(),
  };
}
