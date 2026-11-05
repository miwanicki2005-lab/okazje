// ==UserScript==
// @name         Okazje — import z grup FB (oddam za darmo / śmieciarka jedzie)
// @namespace    okazje-wroclaw
// @version      1.1.0
// @description  Zbiera posty z wybranych grup Facebooka i wysyła je do Twojej aplikacji Okazje; pobiera też OLX z Twojego IP, gdy serwer jest zablokowany.
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
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Na stronie aplikacji skrypt działa jako "most" do API OLX: pobiera z Twojego domowego IP
  // (OLX blokuje IP serwerów/hostingów, a z przeglądarki nie pozwala przez CORS).
  if (!/facebook\.com$/.test(location.hostname)) {
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window || !m || m.type !== 'okz-olx-fetch') return;
      if (typeof m.url !== 'string' || !m.url.startsWith('https://www.olx.pl/api/v1/offers/')) return;
      GM_xmlhttpRequest({
        method: 'GET',
        url: m.url,
        headers: { Accept: 'application/json' },
        timeout: 20000,
        onload: (r) => window.postMessage({ type: 'okz-olx-result', id: m.id, status: r.status, body: r.responseText }, location.origin),
        onerror: () => window.postMessage({ type: 'okz-olx-result', id: m.id, status: 0, body: '' }, location.origin),
        ontimeout: () => window.postMessage({ type: 'okz-olx-result', id: m.id, status: 0, body: '' }, location.origin),
      });
    });
    document.documentElement.dataset.okzBridge = '1';
    window.postMessage({ type: 'okz-bridge-ready' }, location.origin);
    return;
  }

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
  const PERMALINK_RE = /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)|[?&](?:story_fbid|multi_permalinks|fbid)=(\d+)|\/posts\/(pfbid\w+)/;

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
    node.querySelectorAll('a[role="link"]:not([data-okz])').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (h === '#' || h === '' || /\/groups\/[^/]+\/?$/.test(h) || a.querySelector('span[id], b, use')) {
        a.setAttribute('data-okz', '1');
        ['mouseover', 'mouseenter', 'focus'].forEach((t) => a.dispatchEvent(new MouseEvent(t, { bubbles: true })));
      }
    });
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
    let url = null;
    let id = null;
    for (const a of node.querySelectorAll('a[href]')) {
      const m = a.href.match(PERMALINK_RE);
      if (m && !a.closest('[role="article"] [role="article"]')) {
        id = m[1] || m[2] || m[3];
        url = a.href.split('?')[0].includes('/posts/') ? a.href.split('?')[0] : a.href;
        break;
      }
    }
    const gk = groupKey();
    const groupUrl = `${location.origin}/groups/${gk}/`;
    return {
      id: `fb:${gk}:${id || hash(text.slice(0, 300) + (image || ''))}`,
      url: url || groupUrl,
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
      const p = extract(node);
      if (!p) continue;
      const sig = `${p.url}|${p.text.length}|${p.image || ''}`;
      if (sent.get(p.id) === sig) continue;
      queue.set(p.id, { p, sig });
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
})();
