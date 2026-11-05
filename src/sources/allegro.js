import { looksFree, looksWanted } from '../../public/shared/core.js';
import { fetchText } from '../http.js';

const BASE = 'https://allegrolokalnie.pl';

export function buildAllegroUrl({ query = '', city, priceFrom, priceTo, sort = 'new', page = 1 }) {
  const path = query
    ? `/oferty/q/${encodeURIComponent(query)}${city ? `/${city}` : ''}`
    : `/oferty${city ? `/${city}` : ''}`;
  const p = new URLSearchParams();
  if (Number.isFinite(priceFrom)) p.set('price_from', String(priceFrom));
  if (Number.isFinite(priceTo)) p.set('price_to', String(priceTo));
  p.set('sort', sort === 'price' ? 'price-asc' : 'startingTime-desc');
  if (page > 1) p.set('page', String(page));
  // Bez tego Allegro Lokalnie dorzuca oferty z allegro.pl z całej Polski.
  p.set('zrodlo', 'lokalnie');
  return `${BASE}${path}?${p.toString()}`;
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(re, s) {
  const m = re.exec(s);
  return m ? m[1] : null;
}

export function parseAllegroHtml(html) {
  const chunks = String(html).split('<article').slice(1);
  const items = [];
  for (const chunk of chunks) {
    const end = chunk.indexOf('</article>');
    const a = end === -1 ? chunk : chunk.slice(0, end);
    const href = pick(/href="(\/oferta\/[^"]+)"/, a);
    if (!href) continue;
    const title = decode(pick(/itemprop="itemOffered"[^>]*>([\s\S]*?)<\/h3>/, a) || pick(/alt="([^"]*)"/, a));
    if (!title) continue;
    const id = pick(/lokalnie_offer_id&quot;:&quot;([0-9a-f-]+)&quot;/, a) || href;
    const dollars = pick(/ml-offer-price__dollars">([^<]*)</, a);
    const cents = pick(/ml-offer-price__cents">([^<]*)</, a);
    let price = null;
    if (dollars != null) {
      const whole = Number(decode(dollars).replace(/[^\d]/g, ''));
      const frac = cents ? Number(decode(cents).replace(/[^\d]/g, '')) / 100 : 0;
      if (Number.isFinite(whole)) price = whole + (Number.isFinite(frac) ? frac : 0);
    }
    const img = pick(/<img[^>]+src="([^"]+)"/, a);
    const location = decode(pick(/<address[^>]*>([\s\S]*?)<\/address>/, a) || '');
    const sellerType = decode(pick(/Sprzedający:\s*([^<]*)</, a) || '');
    const offerType = pick(/mlc-itembox__offer-type--([a-z]+)/, a);
    const params = [...a.matchAll(/ml-text-small">\s*([^<]*?)<span[^>]*>([^<]*)</g)]
      .map((m) => `${decode(m[1])} ${decode(m[2])}`)
      .join(' · ');
    const negotiable = /do negocjacji/.test(a);

    items.push({
      id,
      source: 'allegro',
      title,
      description: params,
      price,
      priceLabel: price != null ? `${price.toLocaleString('pl-PL')} zł` : '—',
      negotiable,
      free: looksFree(title) && (price == null || price <= 2),
      wanted: looksWanted(title),
      business: /firma/i.test(sellerType),
      offerType: offerType === 'buy' ? 'Kup teraz' : offerType === 'auction' ? 'Licytacja' : 'Ogłoszenie',
      url: `${BASE}${href}`,
      image: img ? img.replace(/\/s\d+x\d+\//, '/s360x360/') : null,
      location,
      createdAt: null,
    });
  }
  return {
    items,
    hasNext: /has_next_page&quot;:true/.test(html),
    total: Number((pick(/offer-count__number">([^<]*)</, html) || '').replace(/[^\d]/g, '')) || null,
  };
}

export async function searchAllegro(opts, pages = 1) {
  const all = [];
  let total = null;
  for (let page = 1; page <= pages; page++) {
    const html = await fetchText(buildAllegroUrl({ ...opts, page }), { accept: 'text/html' });
    const res = parseAllegroHtml(html);
    total ??= res.total;
    all.push(...res.items);
    if (!res.hasNext || !res.items.length) break;
  }
  return { items: all, total };
}
