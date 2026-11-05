import { buildOlxUrl, parseOlxResponse, OLX_PAGE_LIMIT } from '../../public/shared/olx.js';
import { fetchJson } from '../http.js';

export function olxUrls(opts, pages = 1) {
  return Array.from({ length: pages }, (_, i) => buildOlxUrl({ ...opts, offset: i * OLX_PAGE_LIMIT }));
}

export async function searchOlx(opts, pages = 1) {
  const all = [];
  let total = null;
  for (const url of olxUrls(opts, pages)) {
    const res = parseOlxResponse(await fetchJson(url));
    total ??= res.total;
    all.push(...res.items);
    if (!res.hasNext || !res.items.length) break;
  }
  return { items: all, total };
}
