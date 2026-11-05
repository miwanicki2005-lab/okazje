// ==UserScript==
// @name         Okazje — import z grup FB (oddam za darmo / śmieciarka jedzie)
// @namespace    okazje-wroclaw
// @version      1.4.0
// @description  Zbiera posty z grup FB i mostkuje OLX + Vinted z Twojego IP (gdy hosting jest zablokowany).
// @match        https://www.facebook.com/groups/*
// @match        https://web.facebook.com/groups/*
// @match        __SERVER_MATCH__
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      __SERVER_HOST__
// @connect      localhost
// @connect      127.0.0.1
// @connect      www.olx.pl
// @connect      www.vinted.pl
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Na stronie aplikacji skrypt działa jako most do OLX/Vinted: pobiera z Twojego domowego IP
  // (hostingi są często blokowane, a z przeglądarki CORS nie pozwala).
  if (!/facebook\.com$/.test(location.hostname)) {
    const reply = (id, status, body, err) =>
      window.postMessage({ type: 'okz-fetch-result', id, status, body: body || '', err: err || null }, location.origin);

    function allowed(url) {
      if (typeof url !== 'string') return null;
      if (url.startsWith('https://www.olx.pl/api/v1/offers/')) {
        return { referer: 'https://www.olx.pl/', accept: 'application/json, text/plain, */*', label: 'OLX' };
      }
      if (url.startsWith('https://www.vinted.pl/catalog')) {
        return { referer: 'https://www.vinted.pl/', accept: 'text/html,application/xhtml+xml,*/*;q=0.8', label: 'Vinted' };
      }
      return null;
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window || !m) return;
      if (m.type === 'okz-bridge-ping') {
        window.postMessage({ type: 'okz-bridge-ready', version: '1.4.0' }, location.origin);
        return;
      }
      // okz-olx-fetch zostawione dla kompatybilności ze starą stroną
      if (m.type !== 'okz-fetch' && m.type !== 'okz-olx-fetch') return;
      const meta = allowed(m.url);
      if (!meta) {
        reply(m.id, 0, '', 'zły URL (dozwolone: OLX API / Vinted katalog)');
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: m.url,
        headers: {
          Accept: meta.accept,
          'Accept-Language': 'pl-PL,pl;q=0.9',
          Referer: meta.referer,
        },
        anonymous: false,
        timeout: 20000,
        onload: (r) => reply(m.id, r.status, r.responseText, r.status >= 400 ? `HTTP ${r.status}` : null),
        onerror: () =>
          reply(
            m.id,
            0,
            '',
            `brak połączenia z ${meta.label} (w Tampermonkey zezwól na domenę i otwórz raz stronę w tej przeglądarce)`,
          ),
        ontimeout: () => reply(m.id, 0, '', `timeout ${meta.label} — otwórz stronę w nowej karcie i spróbuj ponownie`),
      });
    });
    const mark = () => {
      document.documentElement.dataset.okzBridge = '1';
      window.postMessage({ type: 'okz-bridge-ready', version: '1.4.0' }, location.origin);
    };
    mark();
    document.addEventListener('DOMContentLoaded', mark);
    return;
  }

  const bootFb = () => {
  if (document.body) startFbUi();
  else document.addEventListener('DOMContentLoaded', startFbUi, { once: true });
  };
  bootFb();
  function startFbUi() {


  const SERVER = GM_getValue('server', '__SERVER_URL__');
  const TOKEN = GM_getValue('token', '__IMPORT_TOKEN__');
  const RELOAD_MIN = 10;
  const SCROLL_STEPS = 6;

  const groupKey = () => (location.pathname.match(/^\/groups\/([^/?#]+)/) || [])[1] || '';
  const enabledGroups = () => GM_getValue('groups', {});
  const isEnabled = () => !!enabledGroups()[groupKey()];
  const autoMode = () => GM_getValue('auto', true);

  const sent = new Map();
  const queue = new Map();
  let stats = { sent: 0, lastOk: null, lastErr: null };

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#0f1220;color:#e8ecff;font:13px/1.4 system-ui,sans-serif;' +
    'border:1px solid #2b3158;border-radius:14px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.45);min-width:230px';
  document.documentElement.appendChild(panel);

  function render() {
    const on = isEnabled();
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:9px;height:9px;border-radius:50%;background:${on ? (stats.lastErr ? '#ff6b6b' : '#3ee08f') : '#6b7280'}"></span>
        <b>Okazje — import FB</b>
      </div>
      <div style="opacity:.8;margin-bottom:8px">${
        on
          ? `Wysłano: <b>${stats.sent}</b>${stats.lastOk ? ` · ${new Date(stats.lastOk).toLocaleTimeString('pl-PL')}` : ''}${
              stats.lastErr ? `<br><span style="color:#ff8a8a">${stats.lastErr}</span>` : ''
            }`
          : 'Ta grupa nie jest śledzona.'
      }</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-a="toggle" style="${btn(on ? '#3a1f2b' : '#1f6f4a')}">${on ? 'Przestań śledzić' : 'Śledź tę grupę'}</button>
        ${on ? `<button data-a="auto" style="${btn('#1d2442')}">Auto: ${autoMode() ? 'WŁ' : 'WYŁ'}</button>` : ''}
        <button data-a="cfg" style="${btn('#1d2442')}">⚙</button>
      </div>`;
  }
  function btn(bg) {
    return `background:${bg};color:#fff;border:1px solid #39407a;border-radius:9px;padding:5px 9px;cursor:pointer;font:inherit`;
  }
  panel.addEventListener('click', (e) => {
    const a = e.target?.dataset?.a;
    if (a === 'toggle') {
      const g = enabledGroups();
      if (g[groupKey()]) delete g[groupKey()];
      else g[groupKey()] = document.title.replace(/\s*\|\s*Facebook\s*$/, '');
      GM_setValue('groups', g);
      if (isEnabled()) start();
      render();
    } else if (a === 'auto') {
      GM_setValue('auto', !autoMode());
      render();
    } else if (a === 'cfg') {
      const s = prompt('Adres Twojej aplikacji Okazje:', SERVER);
      if (s) GM_setValue('server', s.replace(/\/+$/, ''));
      const t = prompt('Token importu (zostaw puste jeśli nie ustawiałeś IMPORT_TOKEN):', TOKEN);
      if (t !== null) GM_setValue('token', t.trim());
      location.reload();
    }
  });
  render();

  // ---------- ekstrakcja ----------
  const PERMALINK_RE =
    /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)|[?&](?:story_fbid|multi_permalinks)=(\d+)|\/posts\/(pfbid\w+)/;
  // Zdjęcia w grupie: photo/?fbid=…&set=pcb.POST_ID albo set=gm.POST_ID — z tego da się zbudować link do posta.
  const PHOTO_SET_RE = /[?&]set=(?:pcb|gm)\.(\d+)/;

  function groupName() {
    return (document.querySelector('h1')?.innerText || document.title).replace(/\s*\|\s*Facebook\s*$/, '').trim();
  }

  function postNodes() {
    const set = new Set();
    document.querySelectorAll('[role="feed"] > div, div[aria-posinset]').forEach((n) => set.add(n));
    document.querySelectorAll('div[role="article"]').forEach((n) => {
      if (!n.parentElement?.closest('div[role="article"]')) set.add(n);
    });
    return [...set].filter((n) => n.innerText && n.innerText.length > 20);
  }

  function hoverLinks(node) {
    // FB uzupełnia href linku z datą dopiero po najechaniu myszą.
    node.querySelectorAll('a[href]').forEach((a) => {
      if (a.dataset.okzHover) return;
      const h = a.getAttribute('href') || '';
      if (h === '#' || h === '' || /\/groups\/[^/]+\/?(\?|$)/.test(h) || /story\.php|permalink\.php/.test(h) || a.querySelector('span[id], b, use, abbr')) {
        a.dataset.okzHover = '1';
        ['mouseover', 'mouseenter', 'focus', 'pointerover'].forEach((t) => a.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window })));
      }
    });
  }

  function postUrlFromHref(href, gk) {
    if (!href) return null;
    let m = href.match(/\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+|pfbid\w+)/);
    if (m) return { id: m[2], url: `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/` };
    m = href.match(PERMALINK_RE);
    if (m) {
      const id = m[1] || m[2] || m[3];
      return { id, url: `https://www.facebook.com/groups/${gk}/posts/${id}/` };
    }
    m = href.match(PHOTO_SET_RE);
    if (m) return { id: m[1], url: `https://www.facebook.com/groups/${gk}/posts/${m[1]}/` };
    return null;
  }

  function expandSeeMore(node) {
    node.querySelectorAll('div[role="button"]').forEach((b) => {
      const t = (b.innerText || '').trim().toLowerCase();
      if ((t === 'wyświetl więcej' || t === 'see more' || t === 'zobacz więcej') && !b.dataset.okz) {
        b.dataset.okz = '1';
        b.click();
      }
    });
  }

  function textOf(node) {
    const msg =
      node.querySelector('[data-ad-rendering-role="story_message"]') ||
      node.querySelector('[data-ad-preview="message"]') ||
      node.querySelector('[data-ad-comet-preview="message"]');
    if (msg) return msg.innerText.trim();
    let best = '';
    node.querySelectorAll('div[dir="auto"], span[dir="auto"]').forEach((d) => {
      if (d.closest('[role="article"] [role="article"]')) return;
      const t = d.innerText.trim();
      if (t.length > best.length && t.length < 5000) best = t;
    });
    return best;
  }

  function imageOf(node) {
    const imgs = [...node.querySelectorAll('img')].filter((i) => /scontent|fbcdn/.test(i.src) && (i.naturalWidth || i.width) >= 150);
    return imgs[0]?.src || null;
  }

  function authorOf(node) {
    const el = node.querySelector('h2 a, h3 a, h4 a, strong a, h2 span, h3 span');
    return el ? el.innerText.trim().split('\n')[0] : '';
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function extract(node) {
    const text = textOf(node);
    const image = imageOf(node);
    if (!text && !image) return null;
    const gk = groupKey();
    const groupUrl = `https://www.facebook.com/groups/${gk}/`;
    let best = null;
    for (const a of node.querySelectorAll('a[href]')) {
      if (a.closest('[role="article"] [role="article"]')) continue;
      const found = postUrlFromHref(a.href, gk);
      if (!found) continue;
      // Preferuj klasyczny /posts/ID nad samym fbid ze zdjęcia.
      if (!best || /\/posts\//.test(found.url)) best = found;
      if (/\/posts\//.test(found.url) && !/photo/.test(a.href)) break;
    }
    // Ostateczność: id posta ze zdjęcia w srcset / HTML węzła.
    if (!best) {
      const html = node.innerHTML || '';
      const set = html.match(PHOTO_SET_RE) || html.match(/\/posts\/(\d+)/);
      if (set) best = { id: set[1], url: `https://www.facebook.com/groups/${gk}/posts/${set[1]}/` };
    }
    return {
      id: `fb:${gk}:${best?.id || hash(text.slice(0, 300) + (image || ''))}`,
      url: best?.url || groupUrl,
      groupUrl,
      text,
      image,
      author: authorOf(node),
      group: groupName(),
    };
  }

  function scan() {
    if (!isEnabled()) return;
    for (const node of postNodes()) {
      hoverLinks(node);
      expandSeeMore(node);
      // Daj FB chwilę na uzupełnienie href po hoverze.
      const run = () => {
        const p = extract(node);
        if (!p) return;
        // Nie wysyłaj samego linku do grupy, jeśli da się poczekać na permalink (chyba że już długo).
        const isGroupOnly = p.url === p.groupUrl || /\/groups\/[^/]+\/?$/.test(p.url.split('?')[0]);
        if (isGroupOnly) {
          node.__okzTries = (node.__okzTries || 0) + 1;
          if (node.__okzTries < 4) return;
        }
        const sig = `${p.url}|${p.text.length}|${p.image || ''}`;
        if (sent.get(p.id) === sig) return;
        queue.set(p.id, { p, sig });
      };
      clearTimeout(node.__okzT);
      node.__okzT = setTimeout(run, 400);
    }
  }

  function flush() {
    if (!queue.size || !isEnabled()) return;
    const batch = [...queue.values()];
    queue.clear();
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SERVER}/api/fb/import`,
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': TOKEN },
      data: JSON.stringify({ posts: batch.map((b) => b.p) }),
      timeout: 15000,
      onload: (r) => {
        if (r.status >= 200 && r.status < 300) {
          batch.forEach((b) => sent.set(b.p.id, b.sig));
          stats.sent += batch.length;
          stats.lastOk = Date.now();
          stats.lastErr = null;
        } else {
          batch.forEach((b) => queue.set(b.p.id, b));
          stats.lastErr = `Serwer: HTTP ${r.status}${r.status === 401 ? ' (zły token)' : ''}`;
        }
        render();
      },
      onerror: () => {
        batch.forEach((b) => queue.set(b.p.id, b));
        stats.lastErr = `Brak połączenia z ${SERVER}`;
        render();
      },
      ontimeout: () => {
        batch.forEach((b) => queue.set(b.p.id, b));
        stats.lastErr = 'Timeout serwera';
        render();
      },
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoScroll() {
    for (let i = 0; i < SCROLL_STEPS; i++) {
      window.scrollBy(0, window.innerHeight * 1.5);
      await sleep(2200);
      scan();
    }
    window.scrollTo(0, 0);
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    if (!/sorting_setting=CHRONOLOGICAL/.test(location.search) && autoMode()) {
      const u = new URL(location.href);
      u.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
      location.replace(u.toString());
      return;
    }
    new MutationObserver(() => {
      clearTimeout(start.t);
      start.t = setTimeout(scan, 700);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 4000);
    setInterval(flush, 5000);
    setTimeout(() => {
      scan();
      if (autoMode()) autoScroll();
    }, 3000);
    // Odświeżanie strony, żeby łapać nowe posty, gdy karta po prostu wisi otwarta.
    setInterval(() => {
      if (autoMode() && (document.hidden || Date.now() - lastActivity > 60000)) location.reload();
    }, RELOAD_MIN * 60000);
  }

  let lastActivity = Date.now();
  ['mousemove', 'keydown', 'scroll', 'touchstart'].forEach((t) =>
    window.addEventListener(t, (e) => {
      if (e.isTrusted) lastActivity = Date.now();
    }, { passive: true }),
  );

  // FB to SPA — reagujemy też na przejścia między grupami bez przeładowania.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      render();
      if (isEnabled()) start();
    }
  }, 1500);

  if (isEnabled()) start();
  } // startFbUi
})();
