import fs from 'node:fs';
import path from 'node:path';
import { applyDealFilters, applyFreeFilters, matchesQuery, parseWords, sortItems } from '../../public/shared/core.js';

const MAX_DEALS = Number(process.env.SYNC_MAX_DEALS || 800);
const MAX_FREE = Number(process.env.SYNC_MAX_FREE || 400);
const MAX_AGE_DAYS = Number(process.env.SYNC_MAX_AGE_DAYS || 7);

function itemKey(it) {
  return `${it.source}:${it.id}`;
}

function sanitizeDeal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = String(raw.source || '').slice(0, 20);
  const id = String(raw.id || '').slice(0, 120);
  const url = String(raw.url || '').slice(0, 800);
  if (!source || !id || !/^https?:\/\//.test(url)) return null;
  if (!['olx', 'allegro', 'vinted'].includes(source)) return null;
  const price = raw.price == null || raw.price === '' ? null : Number(raw.price);
  if (price != null && (Number.isNaN(price) || price < 0 || price > 1_000_000)) return null;
  return {
    id,
    source,
    url,
    title: String(raw.title || '').slice(0, 200),
    description: String(raw.description || '').slice(0, 1500),
    image: /^https?:\/\//.test(String(raw.image || '')) ? String(raw.image).slice(0, 2000) : null,
    price,
    priceLabel: String(raw.priceLabel || '').slice(0, 40),
    free: !!raw.free || price === 0,
    location: String(raw.location || '').slice(0, 120),
    createdAt: raw.createdAt && !Number.isNaN(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null,
    business: !!raw.business,
    belowPct: typeof raw.belowPct === 'number' ? raw.belowPct : null,
    marketMedian: typeof raw.marketMedian === 'number' ? raw.marketMedian : null,
  };
}

/** Oferty zrzucone z laptopa (most OLX/Vinted) — telefon tylko czyta. */
export class SyncedStore {
  constructor(file) {
    this.file = file;
    this.deals = new Map();
    this.free = new Map();
    this.lastSync = null;
    this.dealsMeta = null;
    this.freeMeta = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const it of raw.deals || []) {
        const s = sanitizeDeal(it);
        if (s) this.deals.set(itemKey(s), { ...s, syncedAt: it.syncedAt || raw.lastSync });
      }
      for (const it of raw.free || []) {
        const s = sanitizeDeal(it);
        if (s) this.free.set(itemKey(s), { ...s, free: true, price: 0, syncedAt: it.syncedAt || raw.lastSync });
      }
      this.lastSync = raw.lastSync || null;
      this.dealsMeta = raw.dealsMeta || null;
      this.freeMeta = raw.freeMeta || null;
    } catch {
      // brak pliku przy pierwszym starcie
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        lastSync: this.lastSync,
        dealsMeta: this.dealsMeta,
        freeMeta: this.freeMeta,
        deals: [...this.deals.values()],
        free: [...this.free.values()],
      }),
    );
    fs.renameSync(tmp, this.file);
  }

  prune(map, max) {
    const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
    for (const [k, it] of map) {
      const t = Date.parse(it.syncedAt || it.createdAt || 0);
      if (t && t < cutoff) map.delete(k);
    }
    if (map.size > max) {
      const sorted = [...map.values()].sort((a, b) => Date.parse(b.syncedAt || 0) - Date.parse(a.syncedAt || 0));
      map.clear();
      for (const it of sorted.slice(0, max)) map.set(itemKey(it), it);
    }
  }

  push({ deals, free, dealsMeta, freeMeta } = {}) {
    const now = new Date().toISOString();
    let dealsUpserted = 0;
    let freeUpserted = 0;

    for (const raw of Array.isArray(deals) ? deals.slice(0, 500) : []) {
      const s = sanitizeDeal(raw);
      if (!s || s.free) continue;
      this.deals.set(itemKey(s), { ...s, syncedAt: now });
      dealsUpserted++;
    }
    for (const raw of Array.isArray(free) ? free.slice(0, 300) : []) {
      const s = sanitizeDeal(raw);
      if (!s) continue;
      this.free.set(itemKey(s), { ...s, free: true, price: 0, priceLabel: 'Za darmo', syncedAt: now });
      freeUpserted++;
    }

    if (dealsMeta && typeof dealsMeta === 'object') this.dealsMeta = { ...dealsMeta, syncedAt: now };
    if (freeMeta && typeof freeMeta === 'object') this.freeMeta = { ...freeMeta, syncedAt: now };
    if (dealsUpserted || freeUpserted) this.lastSync = now;

    this.prune(this.deals, MAX_DEALS);
    this.prune(this.free, MAX_FREE);
    this.save();
    return {
      dealsUpserted,
      freeUpserted,
      dealsTotal: this.deals.size,
      freeTotal: this.free.size,
      lastSync: this.lastSync,
    };
  }

  listDeals(q = {}) {
    const sources = String(q.sources || 'olx,allegro,vinted')
      .split(',')
      .filter(Boolean);
    const excludeWords = parseWords(String(q.exclude || ''));
    const textQuery = String(q.q || '').trim();
    const min = q.min === '' || q.min == null ? undefined : Number(q.min);
    const max = q.max === '' || q.max == null ? undefined : Number(q.max);
    const privateOnly = q.private === '1' || q.private === true;
    const sort = ['new', 'price', 'below'].includes(q.sort) ? q.sort : 'new';

    let items = [...this.deals.values()].filter((it) => sources.includes(it.source));
    items = applyDealFilters(items, {
      min: Number.isFinite(min) ? min : undefined,
      max: Number.isFinite(max) ? max : undefined,
      excludeWords,
      privateOnly,
    });
    if (textQuery) items = items.filter((it) => matchesQuery(it, textQuery));
    items = sortItems(items, sort);

    const bySource = Object.fromEntries(
      sources.map((name) => [name, { ok: true, count: items.filter((i) => i.source === name).length, via: 'laptop' }]),
    );

    return {
      items,
      sources: bySource,
      via: 'laptop',
      lastSync: this.lastSync,
      dealsMeta: this.dealsMeta,
      marketMedian: this.dealsMeta?.marketMedian ?? null,
      marketSample: this.dealsMeta?.marketSample ?? 0,
      fetchedAt: this.lastSync,
      totalStored: this.deals.size,
    };
  }

  listFree(q = {}) {
    const sources = String(q.sources || 'olx,allegro,fb')
      .split(',')
      .filter(Boolean);
    const excludeWords = parseWords(String(q.exclude || ''));
    const textQuery = String(q.q || '').trim();
    const hideWanted = q.wanted !== '1' && q.wanted !== true;

    let items = [...this.free.values()].filter((it) => sources.includes(it.source));
    items = applyFreeFilters(items, { hideWanted, excludeWords });
    if (textQuery) items = items.filter((it) => matchesQuery(it, textQuery));
    items = sortItems(items, 'new');

    const bySource = Object.fromEntries(
      ['olx', 'allegro']
        .filter((s) => sources.includes(s))
        .map((name) => [name, { ok: true, count: items.filter((i) => i.source === name).length, via: 'laptop' }]),
    );

    return {
      items,
      sources: bySource,
      via: 'laptop',
      lastSync: this.lastSync,
      freeMeta: this.freeMeta,
      fetchedAt: this.lastSync,
      totalStored: this.free.size,
    };
  }

  status() {
    return {
      lastSync: this.lastSync,
      deals: this.deals.size,
      free: this.free.size,
      dealsMeta: this.dealsMeta,
      freeMeta: this.freeMeta,
    };
  }

  clear() {
    this.deals.clear();
    this.free.clear();
    this.lastSync = null;
    this.dealsMeta = null;
    this.freeMeta = null;
    this.save();
  }
}
