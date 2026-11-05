import { buildVintedUrl, parseVintedHtml } from '../../public/shared/vinted.js';
import { fetchText } from '../http.js';

export { buildVintedUrl, parseVintedHtml, vintedUrls } from '../../public/shared/vinted.js';

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
