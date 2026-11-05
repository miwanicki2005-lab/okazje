import { looksFree, looksWanted } from './core.js';

export const OLX_API = 'https://www.olx.pl/api/v1/offers/';
export const OLX_PAGE_LIMIT = 50;

export function buildOlxUrl({ query = '', cityId, regionId, distance, priceFrom, priceTo, sort = 'new', offset = 0, limit = OLX_PAGE_LIMIT, categoryId }) {
  const p = new URLSearchParams();
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  if (query) p.set('query', query);
  if (cityId) p.set('city_id', String(cityId));
  if (regionId) p.set('region_id', String(regionId));
  if (distance) p.set('distance', String(distance));
  if (categoryId) p.set('category_id', String(categoryId));
  if (Number.isFinite(priceFrom)) p.set('filter_float_price:from', String(priceFrom));
  if (Number.isFinite(priceTo)) p.set('filter_float_price:to', String(priceTo));
  p.set('sort_by', sort === 'price' ? 'filter_float_price:asc' : 'created_at:desc');
  p.set('filter_refiners', 'spell_checker');
  return `${OLX_API}?${p.toString()}`;
}

function photoUrl(photo) {
  if (!photo?.link) return null;
  return photo.link.replace('{width}', '400').replace('{height}', '300');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function parseOlxOffer(o) {
  const priceParam = (o.params || []).find((p) => p.key === 'price');
  const pv = priceParam?.value || {};
  const priceType = pv.type || null;
  let price = typeof pv.value === 'number' ? pv.value : null;
  if (priceType === 'free') price = 0;
  if (priceType === 'exchange' || priceType === 'arranged') price = null;

  const loc = o.location || {};
  const location = [loc.city?.name, loc.district?.name].filter(Boolean).join(', ');
  const description = stripHtml(o.description).slice(0, 400);

  return {
    id: String(o.id),
    source: 'olx',
    title: o.title,
    description,
    price,
    priceLabel: pv.label || (price === 0 ? 'Za darmo' : price != null ? `${price} zł` : 'Zamienię / do uzgodnienia'),
    priceType,
    negotiable: !!pv.negotiable,
    free: priceType === 'free' || (price === 0 && priceType !== 'exchange') || (looksFree(o.title) && (price == null || price <= 1)),
    wanted: looksWanted(o.title),
    business: !!o.business,
    url: o.url,
    image: photoUrl(o.photos?.[0]),
    location,
    createdAt: o.last_refresh_time || o.created_time || null,
    promoted: !!(o.promotion?.top_ad || o.promotion?.highlighted),
  };
}

export function parseOlxResponse(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  return {
    items: data.map(parseOlxOffer).filter((it) => it.url && it.title),
    hasNext: !!json?.links?.next,
    total: json?.metadata?.visible_total_count ?? json?.metadata?.total_elements ?? null,
  };
}
