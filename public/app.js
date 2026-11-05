import {
  annotateBelowMarket,
  applyDealFilters,
  applyFreeFilters,
  dedupe,
  interleave,
  matchesQuery,
  parseWords,
  robustMedian,
  sortItems,
} from './shared/core.js';
import { parseOlxResponse } from './shared/olx.js';
import { parseVintedHtml } from './shared/vinted.js';

const $ = (s, root = document) => root.querySelector(s);
const PEARL_PCT = 30;
const QUICK = [
  ['iphone', 1500],
  ['ps5', 1500],
  ['laptop', 1200],
  ['rower', 500],
  ['lodówka', 400],
  ['telewizor', 600],
];
const SOURCE_NAMES = { olx: 'OLX', allegro: 'Allegro Lokalnie', vinted: 'Vinted', fb: 'Grupy FB' };

// ---------- pamięć przeglądarki ----------
const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem(`okz:${key}`);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(`okz:${key}`, JSON.stringify(val));
    } catch {
      // pełny localStorage — ignorujemy
    }
  },
};

const seen = new Map(Object.entries(store.get('seen', {})));
const hidden = new Set(store.get('hidden', []));
const saved = new Map(Object.entries(store.get('saved', {})));

function persistSeen() {
  if (seen.size > 6000) {
    const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4000);
    seen.clear();
    sorted.forEach(([k, v]) => seen.set(k, v));
  }
  store.set('seen', Object.fromEntries(seen));
}

const keyOf = (it) => `${it.source}:${it.id}`;

const state = {
  tab: 'deals',
  deals: { items: [], loaded: false, loading: false, meta: null },
  free: { items: [], loaded: false, loading: false, meta: null },
  config: null,
  unread: 0,
};

// ---------- narzędzia ----------
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'przed chwilą';
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} godz. temu`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'wczoraj' : `${d} dni temu`;
}

function fmtPrice(it) {
  if (it.free || it.price === 0) return 'ZA DARMO';
  if (it.price == null) return it.priceLabel || '—';
  return `${it.price.toLocaleString('pl-PL', { maximumFractionDigits: 2 })} zł`;
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.innerHTML = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formData(form) {
  const fd = new FormData(form);
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : fd.get(el.name) ?? '';
  }
  return out;
}

function fillForm(form, data) {
  if (!data) return;
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === 'checkbox') el.checked = !!data[el.name];
    else el.value = data[el.name];
  }
}

// ---------- OLX z przeglądarki (gdy serwer ma zablokowane IP) ----------
// Most to skrypt Tampermonkey (fb-import.user.js) — pobiera OLX z domowego IP z pominięciem CORS.
const bridgeWaiters = new Map();
let bridgeSeq = 0;
let bridgeReady = document.documentElement.dataset.okzBridge === '1';
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'okz-bridge-ready') {
    bridgeReady = true;
    document.documentElement.dataset.okzBridge = '1';
    updateBridgeChip();
    return;
  }
  if (e.data.type !== 'okz-fetch-result' && e.data.type !== 'okz-olx-result') return;
  const w = bridgeWaiters.get(e.data.id);
  if (!w) return;
  bridgeWaiters.delete(e.data.id);
  if (e.data.status >= 200 && e.data.status < 300) {
    w.resolve(e.data.body);
  } else w.reject(new Error(e.data.err || (e.data.status ? `HTTP ${e.data.status}` : 'brak połączenia')));
});

const hasBridge = () => bridgeReady || document.documentElement.dataset.okzBridge === '1';

function viaBridge(url) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${bridgeSeq++}`;
    const t = setTimeout(() => {
      if (!bridgeWaiters.has(id)) return;
      bridgeWaiters.delete(id);
      reject(
        new Error(
          'timeout — zainstaluj skrypt v1.4+, w Tampermonkey zezwól na www.olx.pl i www.vinted.pl, otwórz raz te strony w przeglądarce',
        ),
      );
    }, 45000);
    bridgeWaiters.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    window.postMessage({ type: 'okz-fetch', id, url }, location.origin);
  });
}

function waitForBridge(ms = 2500) {
  if (hasBridge()) return Promise.resolve(true);
  window.postMessage({ type: 'okz-bridge-ping' }, location.origin);
  return new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.source === window && e.data?.type === 'okz-bridge-ready') done(true);
    };
    const done = (v) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => done(hasBridge()), ms);
    window.addEventListener('message', onMsg);
  });
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
        } catch (reason) {
          out[idx] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return out;
}

async function ensureBridge() {
  const ready = await waitForBridge();
  updateBridgeChip();
  if (!ready && !hasBridge()) {
    throw new Error(
      'brak skryptu Tampermonkey na tej stronie — zakładka „Grupy FB” → zainstaluj skrypt (v1.4+), odśwież tę kartę',
    );
  }
}

async function fetchOlxInBrowser(urls) {
  await ensureBridge();
  const results = await mapPool(urls.slice(0, 4), 2, viaBridge);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(results[0]?.reason?.message || 'brak odpowiedzi OLX');
  return dedupe(
    ok.flatMap((r) => {
      try {
        return parseOlxResponse(JSON.parse(r.value)).items;
      } catch {
        return [];
      }
    }),
  );
}

async function fetchVintedInBrowser(urls) {
  await ensureBridge();
  const results = await mapPool(urls.slice(0, 2), 1, viaBridge);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(results[0]?.reason?.message || 'brak odpowiedzi Vinted');
  return dedupe(ok.flatMap((r) => parseVintedHtml(r.value).items));
}

function updateBridgeChip() {
  const el = $('#bridgeChip');
  if (!el) return;
  if (hasBridge()) {
    el.className = 'chip';
    el.innerHTML = '<span class="dot"></span>Most OLX/Vinted: OK';
  } else {
    el.className = 'chip warn';
    el.innerHTML = '<span class="dot"></span>Most: brak skryptu';
  }
}

// ---------- renderowanie ----------
function renderStatus(el, meta, extra = '') {
  if (!meta) {
    el.innerHTML = extra;
    return;
  }
  const chips = Object.entries(meta.sources || {}).map(([name, s]) => {
    let cls = s.ok ? '' : 'err';
    let txt = s.ok ? `${s.count}` : 'błąd';
    let title = s.error || '';
    if (name === 'fb') {
      txt = s.lastImport ? `${s.count} · import ${timeAgo(s.lastImport)}` : 'brak importu';
      if (!s.lastImport) cls = 'warn';
    }
    if (s.via === 'browser') txt += ' (przez przeglądarkę)';
    return `<span class="chip ${cls}" title="${escapeHtml(title)}"><span class="dot"></span>${SOURCE_NAMES[name] || name}: ${txt}</span>`;
  });
  const when = meta.fetchedAt ? `<span class="muted">· odświeżono ${new Date(meta.fetchedAt).toLocaleTimeString('pl-PL')}</span>` : '';
  const errors = Object.entries(meta.sources || {})
    .filter(([, s]) => !s.ok && s.error)
    .map(([name, s]) => `<div class="notice">⚠ ${SOURCE_NAMES[name] || name}: ${escapeHtml(s.error)}</div>`);
  el.innerHTML = chips.join('') + when + extra + errors.join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderGrid(grid, items, { markSeen = true } = {}) {
  const tpl = $('#cardTpl');
  const frag = document.createDocumentFragment();
  let newCount = 0;
  const now = Date.now();
  for (const it of items) {
    const k = keyOf(it);
    const node = tpl.content.firstElementChild.cloneNode(true);
    const isNew = !seen.has(k);
    if (isNew) {
      newCount++;
      node.classList.add('is-new');
      if (markSeen) seen.set(k, now);
    } else if (now - seen.get(k) > 30 * 60000) {
      node.classList.add('seen');
    }
    if (it.belowPct >= PEARL_PCT) node.classList.add('pearl');

    const thumb = $('.thumb', node);
    thumb.href = it.url;
    const img = $('img', node);
    if (it.image) {
      img.onerror = () => thumb.classList.add('empty');
      img.referrerPolicy = 'no-referrer';
      img.alt = it.title;
      img.src = it.image;
    } else thumb.classList.add('empty');
    const src = $('.src', node);
    src.textContent = SOURCE_NAMES[it.source] || it.source;
    src.classList.add(it.source);

    const price = $('.price', node);
    price.textContent = fmtPrice(it);
    if (it.free || it.price === 0) price.classList.add('free');

    const below = $('.below', node);
    if (Number.isFinite(it.belowPct)) {
      if (it.belowPct >= 10) {
        below.textContent = `−${it.belowPct}% rynku${it.belowPct >= PEARL_PCT ? ' 🔥' : ''}`;
        below.classList.add(it.belowPct >= PEARL_PCT ? 'great' : 'good');
      } else if (it.belowPct <= -15) {
        below.textContent = `+${-it.belowPct}% rynku`;
        below.classList.add('bad');
      }
    } else if (it.negotiable) {
      below.textContent = 'do negocjacji';
      below.classList.add('good');
    }

    const title = $('.title', node);
    title.href = it.url;
    title.textContent = it.title;
    title.title = it.title;
    const descText = it.source === 'fb' ? it.description.split('\n').slice(1).join('\n').trim() || '' : it.description;
    $('.desc', node).textContent = descText || '';
    $('.loc', node).textContent = it.source === 'fb' ? `👥 ${it.group || 'grupa FB'}` : `📍 ${it.location || ''}`;
    $('.loc', node).title = $('.loc', node).textContent;
    $('.time', node).textContent = it.createdAt ? timeAgo(it.createdAt) : it.offerType || '';

    const star = $('.star', node);
    const setStar = () => {
      const on = saved.has(k);
      star.classList.toggle('on', on);
      star.textContent = on ? '★' : '☆';
    };
    setStar();
    star.onclick = () => {
      if (saved.has(k)) saved.delete(k);
      else saved.set(k, { ...it, savedAt: Date.now() });
      store.set('saved', Object.fromEntries(saved));
      setStar();
      updateBadges();
      if (state.tab === 'saved') renderSaved();
    };
    $('.hide', node).onclick = () => {
      hidden.add(k);
      store.set('hidden', [...hidden].slice(-5000));
      node.remove();
      toast('Ukryto ogłoszenie.');
    };
    frag.appendChild(node);
  }
  grid.replaceChildren(frag);
  if (markSeen) persistSeen();
  return newCount;
}

function skeleton(grid, n = 8) {
  grid.innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

function updateBadges() {
  const visibleDeals = visibleDealItems().length;
  const visibleFree = visibleFreeItems().length;
  $('#badge-deals').textContent = state.deals.loaded ? visibleDeals : '';
  $('#badge-free').textContent = state.free.loaded ? visibleFree : '';
  $('#badge-saved').textContent = saved.size || '';
  document.title = `${state.unread ? `(${state.unread}) ` : ''}Okazje ${state.config?.cityName || 'Wrocław'}`;
}

// ---------- OKAZJE ----------
function dealsParams() {
  const f = formData($('#dealsForm'));
  store.set('dealsForm', f);
  const sources = ['olx', 'allegro', 'vinted'].filter((s) => f[`src_${s}`]);
  const p = new URLSearchParams({ q: f.q.trim(), sort: f.sort, sources: sources.join(','), exclude: f.exclude });
  if (f.min !== '') p.set('min', f.min);
  if (f.max !== '') p.set('max', f.max);
  if (f.private) p.set('private', '1');
  return { f, p };
}

function visibleDealItems() {
  const f = formData($('#dealsForm'));
  return state.deals.items.filter((it) => !hidden.has(keyOf(it)) && (!f.pearls || it.belowPct >= PEARL_PCT));
}

async function loadDeals({ silent = false } = {}) {
  const { f, p } = dealsParams();
  if (!f.q.trim() && f.max === '') {
    $('#dealsEmpty').hidden = false;
    $('#dealsEmpty').innerHTML =
      'Wpisz czego szukasz i/lub <b>maksymalną cenę</b> — pokażę oferty z Wrocławia poniżej tej ceny, a przy wpisanej frazie policzę też <b>medianę rynkową</b> i oznaczę 🔥 perełki tańsze o 30%+.' +
      `<div class="quick">${QUICK.map(([q, max]) => `<button type="button" data-q="${q}" data-max="${max}">${q} do ${max} zł</button>`).join('')}</div>`;
    $('#dealsEmpty').querySelectorAll('.quick button').forEach(
      (b) =>
        (b.onclick = () => {
          $('#dq').value = b.dataset.q;
          $('#dmax').value = b.dataset.max;
          loadDeals();
        }),
    );
    return 0;
  }
  if (state.deals.loading) return 0;
  state.deals.loading = true;
  const btn = $('#dealsForm button[type=submit]');
  btn.disabled = true;
  if (!silent) skeleton($('#dealsGrid'));
  $('#dealsEmpty').hidden = true;
  try {
    const data = await api(`/api/deals?${p}`);
    if (data.fallback?.olx || data.fallback?.vinted) await dealsBrowserFallback(data, f);
    state.deals.items = data.items;
    state.deals.meta = data;
    state.deals.loaded = true;
    return renderDeals(silent);
  } catch (e) {
    $('#dealsGrid').innerHTML = '';
    $('#dealsEmpty').hidden = false;
    $('#dealsEmpty').innerHTML = `Nie udało się pobrać ofert: <b>${escapeHtml(e.message)}</b>`;
    return 0;
  } finally {
    state.deals.loading = false;
    btn.disabled = false;
  }
}

async function dealsBrowserFallback(data, f) {
  const excludeWords = parseWords(f.exclude);
  const num = (v) => (v === '' ? undefined : Number(v));
  const lists = [data.items];
  let median = data.marketMedian;
  const refPrices = [];

  if (data.fallback?.olx) {
    try {
      const [main, ref] = await Promise.all([
        fetchOlxInBrowser(data.fallback.olx),
        data.fallback.olxRef?.length ? fetchOlxInBrowser(data.fallback.olxRef).catch(() => []) : [],
      ]);
      ref.forEach((it) => it.price > 0 && !it.free && refPrices.push(it.price));
      const olx = applyDealFilters(main, { min: num(f.min), max: num(f.max), excludeWords, privateOnly: f.private });
      lists.push(olx);
      data.sources.olx = { ok: true, count: olx.length, via: 'browser' };
    } catch (e) {
      data.sources.olx.error = `OLX blokuje IP serwera (${e.message}).`;
    }
  }

  if (data.fallback?.vinted) {
    try {
      const [main, ref] = await Promise.all([
        fetchVintedInBrowser(data.fallback.vinted),
        data.fallback.vintedRef?.length ? fetchVintedInBrowser(data.fallback.vintedRef).catch(() => []) : [],
      ]);
      ref.forEach((it) => it.price > 0 && refPrices.push(it.price));
      const vinted = applyDealFilters(main, { min: num(f.min), max: num(f.max), excludeWords, privateOnly: f.private });
      lists.push(vinted);
      data.sources.vinted = { ok: true, count: vinted.length, via: 'browser' };
    } catch (e) {
      data.sources.vinted.error = `Vinted blokuje IP serwera (${e.message}).`;
    }
  }

  if (refPrices.length >= 8) median = robustMedian(refPrices) || median;
  let items = dedupe(interleave(lists));
  items = annotateBelowMarket(items, median);
  data.items = sortItems(items, f.sort);
  data.marketMedian = median;
  if (refPrices.length) data.marketSample = Math.max(data.marketSample || 0, refPrices.length);
}

function renderDeals(silent) {
  const meta = state.deals.meta;
  const items = visibleDealItems();
  renderStatus($('#dealsStatus'), meta);
  const market = $('#dealsMarket');
  if (meta?.marketMedian) {
    market.hidden = false;
    const pearls = state.deals.items.filter((i) => i.belowPct >= PEARL_PCT).length;
    market.innerHTML = `📊 Mediana rynkowa dla „<b>${escapeHtml($('#dq').value)}</b>”: <b>${Math.round(meta.marketMedian).toLocaleString('pl-PL')} zł</b>
      <span class="muted">(z ${meta.marketSample} ogłoszeń)</span> · perełek 🔥 (≥${PEARL_PCT}% taniej): <b>${pearls}</b>`;
  } else market.hidden = true;
  const newCount = renderGrid($('#dealsGrid'), items);
  $('#dealsEmpty').hidden = items.length > 0;
  if (!items.length) $('#dealsEmpty').innerHTML = 'Brak ofert dla tych filtrów. Spróbuj podnieść cenę albo zmienić frazę.';
  updateBadges();
  return silent ? newCount : 0;
}

// ---------- ZA DARMO ----------
function freeParams() {
  const f = formData($('#freeForm'));
  store.set('freeForm', f);
  const sources = ['olx', 'allegro', 'fb'].filter((s) => f[`src_${s}`]);
  const p = new URLSearchParams({ sources: sources.join(','), q: f.q.trim(), exclude: f.exclude });
  if (f.wanted) p.set('wanted', '1');
  return { f, p };
}

function visibleFreeItems() {
  const f = formData($('#freeForm'));
  return state.free.items.filter((it) => !hidden.has(keyOf(it)) && (!f.unseen || !seen.has(keyOf(it)) || Date.now() - seen.get(keyOf(it)) < 30 * 60000));
}

async function loadFree({ silent = false } = {}) {
  if (state.free.loading) return 0;
  state.free.loading = true;
  const { f, p } = freeParams();
  const btn = $('#freeForm button[type=submit]');
  btn.disabled = true;
  if (!silent) skeleton($('#freeGrid'));
  try {
    const data = await api(`/api/free?${p}`);
    if (data.fallback?.olx) {
      try {
        let olx = (await fetchOlxInBrowser(data.fallback.olx)).filter((it) => it.free);
        olx = applyFreeFilters(olx, { hideWanted: !f.wanted, excludeWords: parseWords(f.exclude) });
        if (f.q.trim()) olx = olx.filter((it) => matchesQuery(it, f.q));
        data.items = sortItems(dedupe(interleave([data.items, olx])), 'new');
        data.sources.olx = { ok: true, count: olx.length, via: 'browser' };
      } catch (e) {
        data.sources.olx.error = `OLX blokuje IP serwera (${e.message}).`;
      }
    }
    state.free.items = data.items;
    state.free.meta = data;
    state.free.loaded = true;
    return renderFree(silent);
  } catch (e) {
    $('#freeGrid').innerHTML = '';
    $('#freeEmpty').hidden = false;
    $('#freeEmpty').innerHTML = `Nie udało się pobrać: <b>${escapeHtml(e.message)}</b>`;
    return 0;
  } finally {
    state.free.loading = false;
    btn.disabled = false;
  }
}

function renderFree(silent) {
  const items = visibleFreeItems();
  const fb = state.free.meta?.sources?.fb;
  const hint = fb && !fb.lastImport ? ' <a href="#fb" class="muted">→ podłącz grupy FB</a>' : '';
  renderStatus($('#freeStatus'), state.free.meta, hint);
  const newCount = renderGrid($('#freeGrid'), items);
  $('#freeEmpty').hidden = items.length > 0;
  if (!items.length) $('#freeEmpty').innerHTML = 'Nic za darmo dla tych filtrów. Wróć za chwilę — odświeżam automatycznie.';
  updateBadges();
  return silent ? newCount : 0;
}

// ---------- ZAPISANE ----------
function renderSaved() {
  const items = [...saved.values()].sort((a, b) => b.savedAt - a.savedAt);
  renderGrid($('#savedGrid'), items, { markSeen: false });
  $('#savedGrid').querySelectorAll('.card').forEach((c) => c.classList.remove('is-new', 'seen'));
  $('#savedEmpty').hidden = items.length > 0;
}

// ---------- FB ----------
async function renderFb() {
  const cfg = state.config;
  if (!cfg) return;
  $('#fbGroups').innerHTML = cfg.fbGroups
    .map((g) => `<a href="${escapeHtml(g.url)}" target="_blank" rel="noopener"><span>👥 ${escapeHtml(g.name)}</span><span class="muted">otwórz ↗</span></a>`)
    .join('');
  $('#tokenRow').hidden = !cfg.importTokenRequired;
  const tokenInput = $('#importToken');
  tokenInput.value = store.get('importToken', '');
  const setHref = () => {
    store.set('importToken', tokenInput.value.trim());
    $('#installScript').href = `/fb-import.user.js${tokenInput.value.trim() ? `?token=${encodeURIComponent(tokenInput.value.trim())}` : ''}`;
  };
  tokenInput.oninput = setHref;
  setHref();
  try {
    const data = await api('/api/fb');
    const groups = new Set(data.items.map((i) => i.group).filter(Boolean));
    $('#fbStats').innerHTML = data.lastImport
      ? `Zapisanych postów: <b>${data.items.length}</b> z ${groups.size} grup · ostatni import: <b>${timeAgo(data.lastImport)}</b>`
      : 'Jeszcze nic nie zaimportowano. Zainstaluj skrypt i otwórz grupę.';
  } catch {
    $('#fbStats').textContent = '';
  }
}

$('#fbClear').onclick = async () => {
  if (!confirm('Usunąć wszystkie zapisane posty z grup FB?')) return;
  const headers = { 'X-Import-Token': store.get('importToken', '') };
  const res = await fetch('/api/fb/clear', { method: 'POST', headers });
  toast(res.ok ? 'Wyczyszczono posty FB.' : 'Nie udało się (sprawdź token).');
  renderFb();
};

// ---------- zakładki ----------
function showTab(tab) {
  if (!['deals', 'free', 'saved', 'fb'].includes(tab)) tab = 'deals';
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab}`));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  store.set('tab', tab);
  if (tab === 'free' && !state.free.loaded) loadFree();
  if (tab === 'deals' && !state.deals.loaded) loadDeals();
  if (tab === 'saved') renderSaved();
  if (tab === 'fb') renderFb();
  state.unread = 0;
  updateBadges();
}

document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

$('#dealsForm').onsubmit = (e) => {
  e.preventDefault();
  loadDeals();
};
$('#freeForm').onsubmit = (e) => {
  e.preventDefault();
  loadFree();
};
$('#dealsForm [name=pearls]').onchange = () => state.deals.loaded && renderDeals(false);
$('#freeForm [name=unseen]').onchange = () => state.free.loaded && renderFree(false);
$('#dealsForm [name=sort]').onchange = () => state.deals.loaded && loadDeals();

// ---------- auto-odświeżanie i powiadomienia ----------
let nextRefresh = 0;
function scheduleNext() {
  nextRefresh = Date.now() + Number($('#autoInterval').value) * 1000;
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: 'favicon.svg', tag: 'okazje' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // niektóre przeglądarki mobilne wymagają service workera
  }
}

async function autoTick() {
  const el = $('#countdown');
  if (!$('#autoRefresh').checked) {
    el.textContent = '';
    return;
  }
  const left = Math.max(0, Math.round((nextRefresh - Date.now()) / 1000));
  el.textContent = `za ${left}s`;
  if (left > 0) return;
  scheduleNext();
  const tasks = [];
  if (state.free.loaded || state.tab === 'free') tasks.push(loadFree({ silent: true }).then((n) => ['za darmo', n]));
  if (state.deals.loaded) tasks.push(loadDeals({ silent: true }).then((n) => ['okazji', n]));
  const results = await Promise.all(tasks);
  const parts = results.filter(([, n]) => n > 0).map(([label, n]) => `${n} nowych ${label}`);
  if (parts.length) {
    const total = results.reduce((s, [, n]) => s + n, 0);
    if (document.hidden) state.unread += total;
    updateBadges();
    toast(`🆕 ${parts.join(' · ')}`);
    notify('Okazje Wrocław', parts.join(', '));
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    state.unread = 0;
    updateBadges();
  }
});

$('#autoRefresh').checked = store.get('auto', true);
$('#autoInterval').value = String(store.get('autoInterval', 120));
$('#autoRefresh').onchange = () => {
  store.set('auto', $('#autoRefresh').checked);
  scheduleNext();
};
$('#autoInterval').onchange = () => {
  store.set('autoInterval', Number($('#autoInterval').value));
  scheduleNext();
};

function updateNotifyBtn() {
  const btn = $('#notifyBtn');
  if (!('Notification' in window)) btn.hidden = true;
  else if (Notification.permission === 'granted') btn.textContent = '🔔 Powiadomienia wł.';
}
$('#notifyBtn').onclick = async () => {
  if (!('Notification' in window)) return;
  const res = await Notification.requestPermission();
  updateNotifyBtn();
  toast(res === 'granted' ? 'Dostaniesz powiadomienie o nowych rzeczach.' : 'Powiadomienia zablokowane w przeglądarce.');
};

// ---------- start ----------
(async function init() {
  fillForm($('#dealsForm'), store.get('dealsForm', null));
  fillForm($('#freeForm'), store.get('freeForm', null));
  updateNotifyBtn();
  updateBridgeChip();
  waitForBridge(3000).then(updateBridgeChip);
  try {
    state.config = await api('/api/config');
    $('#cityName').textContent = state.config.cityName;
  } catch {
    toast('Nie mogę połączyć się z serwerem aplikacji. Czy uruchomiłeś <b>npm start</b>?', 8000);
  }
  scheduleNext();
  setInterval(autoTick, 1000);
  showTab(location.hash.slice(1) || store.get('tab', 'free'));
})();
