// Logika wspólna dla serwera (Node) i przeglądarki — bez zależności.

const FREE_RE = /(oddam|odda[mć]\b|oddaj[eę]|do\s+oddania|za\s*darmo|za\s*free|za\s*friko|gratis|darmo(w|\b)|za\s*0\s*z[łl]|za\s*symboliczn|za\s*czekolad|za\s*piwo|za\s*odbi[oó]r|w\s*zamian\s*za\s*odbi[oó]r)/i;
const WANTED_RE = /(przyjm[eę]|przygarn[eę]|szukam|poszukuj[eę]|kupi[eę]|potrzebuj[eę]|czy\s+kto[sś]\s+(ma|odda))/i;

export function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

export function looksFree(text) {
  return FREE_RE.test(String(text || ''));
}

export function looksWanted(text) {
  return WANTED_RE.test(String(text || ''));
}

export function parseWords(str) {
  return String(str || '')
    .split(/[,;\n]+/)
    .map((w) => normalize(w).trim())
    .filter(Boolean);
}

export function matchesExclude(item, excludeWords) {
  if (!excludeWords.length) return false;
  const hay = normalize(`${item.title} ${item.description || ''}`);
  return excludeWords.some((w) => hay.includes(w));
}

export function matchesQuery(item, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalize(`${item.title} ${item.description || ''} ${item.location || ''} ${item.group || ''}`);
  return words.every((w) => hay.includes(w));
}

export function median(nums) {
  const arr = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Odrzucamy skrajne 10% z każdej strony, żeby etui za 5 zł i "zamienię na auto" za 99999 nie psuły mediany.
export function robustMedian(nums) {
  const arr = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (arr.length < 6) return median(arr);
  const cut = Math.floor(arr.length * 0.1);
  return median(arr.slice(cut, arr.length - cut));
}

export function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.source}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function sortItems(items, sort) {
  const arr = [...items];
  if (sort === 'price') {
    arr.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  } else if (sort === 'below') {
    arr.sort((a, b) => (b.belowPct ?? -Infinity) - (a.belowPct ?? -Infinity));
  } else {
    // Allegro Lokalnie nie podaje daty na liście, więc oferty bez daty zostają na swoich pozycjach
    // (kolejność "najnowsze" ze źródła), a oferty z datą sortujemy między sobą w ich slotach.
    arr.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const ts = (it) => Date.parse(it.createdAt);
    const slots = [];
    const dated = [];
    arr.forEach((it, i) => {
      if (it.createdAt && !Number.isNaN(ts(it))) {
        slots.push(i);
        dated.push(it);
      }
    });
    dated.sort((a, b) => ts(b) - ts(a));
    slots.forEach((slot, i) => (arr[slot] = dated[i]));
  }
  return arr;
}

// Przeplatamy źródła według pozycji, żeby przy sortowaniu "najnowsze" OLX nie zasłonił całkiem Allegro.
export function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out.map((it, i) => ({ ...it, rank: i }));
}

export function applyDealFilters(items, { min, max, excludeWords = [], privateOnly = false }) {
  return items.filter((it) => {
    if (it.price == null || !Number.isFinite(it.price) || it.price <= 0) return false;
    if (it.wanted) return false;
    if (Number.isFinite(min) && it.price < min) return false;
    if (Number.isFinite(max) && it.price > max) return false;
    if (privateOnly && it.business) return false;
    if (matchesExclude(it, excludeWords)) return false;
    return true;
  });
}

// Poniżej 25% mediany to prawie zawsze akcesoria/części (etui do iPhone'a, dzwonek do roweru), nie okazja.
const MIN_REALISTIC_SHARE = 0.25;

export function annotateBelowMarket(items, marketMedian) {
  if (!marketMedian) return items;
  return items.map((it) => {
    if (!(it.price > 0) || it.price < marketMedian * MIN_REALISTIC_SHARE) return { ...it, belowPct: null };
    return { ...it, belowPct: Math.round(((marketMedian - it.price) / marketMedian) * 100) };
  });
}

export function applyFreeFilters(items, { hideWanted = true, excludeWords = [] } = {}) {
  return items.filter((it) => {
    if (hideWanted && it.wanted) return false;
    if (matchesExclude(it, excludeWords)) return false;
    return true;
  });
}
