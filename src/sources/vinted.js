import { fetchText } from '../http.js';

const BASE = 'https://www.vinted.pl';

export function buildVintedUrl({ query = '', priceFrom, priceTo, sort = 'new', page = 1, cityId }) {
  const p = new URLSearchParams();
  if (query) p.set('search_text', query);
  if (Number.isFinite(priceFrom)) p.set('price_from', String(priceFrom));
  if (Number.isFinite(priceTo)) p.set('price_to', String(priceTo));
  p.set('order', sort === 'price' ? 'price_low_to_high' : 'newest_first');
  if (page > 1) p.set('page', String(page));
  // Opcjonalny filtr miasta — Vinted i tak często pokazuje oferty z wysyłką z całej PL.
  if (cityId) {
    p.set('city_id', String(cityId));
    p.set('distance', String(process.env.VINTED_DISTANCE || 80));
  }
  return `${BASE}/catalog?${p.toString()}`;
}

function unescapeTitle(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function parseVintedHtml(html) {
  // Dane katalogu siedzą w payloadzie RSC jako escaped JSON (\"productItem\":{...}).
  const raw = String(html).replace(/\\"/g, '"').replace(/\\\//g, '/');
  const items = [];
  const seen = new Set();
  const re =
    /"productItem":\{"id":(\d+),"title":"(.*?)","url":"(\/items\/[^"]+)".*?"price":\{"amount":"([\d.]+)","currencyCode":"(\w+)".*?"thumbnailUrl":"(https:[^"]+)".*?"isBusiness":(true|false).*?"itemBox":\{"firstLine":"(.*?)","secondLine":"(.*?)"/g;
  let m;
  while ((m = re.exec(raw))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const price = Number(m[4]);
    const brand = unescapeTitle(m[8]);
    const condition = unescapeTitle(m[9]);
    items.push({
      id,
      source: 'vinted',
      title: unescapeTitle(m[2]),
      description: [brand, condition].filter((x) => x && x !== '$undefined').join(' · '),
      price: Number.isFinite(price) ? price : null,
      priceLabel: Number.isFinite(price) ? `${price.toLocaleString('pl-PL')} zł` : '—',
      free: false,
      wanted: false,
      business: m[7] === 'true',
      url: `${BASE}${m[3].split('?')[0]}`,
      image: m[6].replace(/\\u0026/g, '&'),
      location: 'Vinted · wysyłka PL',
      createdAt: null,
      offerType: condition && condition !== '$undefined' ? condition : null,
    });
  }
  return {
    items,
    hasNext: items.length >= 20 && /[?&]page=\d+|name":"page"/.test(html),
    total: null,
  };
}

export async function searchVinted(opts, pages = 1) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const html = await fetchText(buildVintedUrl({ ...opts, page }), { accept: 'html' });
    const res = parseVintedHtml(html);
    all.push(...res.items);
    if (!res.items.length || !res.hasNext) break;
  }
  return { items: all, total: null };
}
