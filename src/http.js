const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 90) * 1000;
const cache = new Map();
const inflight = new Map();

export class HttpError extends Error {
  constructor(status, url) {
    super(status === 403 ? `zablokowane przez serwer (HTTP 403)` : `HTTP ${status}`);
    this.status = status;
    this.url = url;
    this.blocked = status === 403 || status === 429;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doFetch(url, accept) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: accept === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.6',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (res.ok) return accept === 'json' ? res.json() : res.text();
      lastErr = new HttpError(res.status, url);
      if (res.status === 403 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw lastErr;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    await sleep(600 * (attempt + 1) + Math.random() * 400);
  }
  throw lastErr;
}

export async function fetchText(url, { accept = 'html' } = {}) {
  const key = `${accept}|${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = doFetch(url, accept)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const fetchJson = (url) => fetchText(url, { accept: 'json' });
