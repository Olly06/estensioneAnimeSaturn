/* content.js — scraping metadati AnimeSaturn + marcatura episodi visti.
 *
 * Struttura attuale del sito (verificata):
 *   /anime/<slug>              pagina anime: h1 titolo, link MyAnimeList, "Episodi N", "Stato"
 *   /episode/<slug>/ep-<n>     pagina "Stai per guardare" (NON conta come visione)
 *   /anime/<slug>/ep-<n>       pagina player: x-data="watchPage({...animeName, animeSlug, next...})"
 * Le tile episodio sono <a class="ep-tile"> e il CSS del sito mostra già il
 * check verde (.ep-seen) quando la tile ha classe .is-watched: la riusiamo.
 */
'use strict';

/* global AST */

(() => {
  if (window.__astTrackerLoaded) return;
  window.__astTrackerLoaded = true;

  const WATCH_RE = /^\/anime\/([^/?#]+)\/ep-(\d+)\/?$/;
  const ANIME_RE = /^\/anime\/([^/?#]+)\/?$/;
  const EP_LINK_RE = /\/(?:anime|episode)\/([^/?#]+)\/ep-(\d+)\/?(?:[?#]|$)/;

  /* ---------------------------------------------------------- scraping */

  function readJsonLd(type) {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const list = Array.isArray(data) ? data : [data];
        const hit = list.find((d) => d && d['@type'] === type);
        if (hit) return hit;
      } catch {
        /* JSON-LD malformato: ignora */
      }
    }
    return null;
  }

  /** Legge la configurazione Alpine `watchPage({...})` del player. */
  function readWatchConfig() {
    const el = document.querySelector('[x-data^="watchPage("]');
    if (!el) return null;
    const raw = el.getAttribute('x-data').trim();
    try {
      return JSON.parse(raw.slice('watchPage('.length, raw.lastIndexOf(')')));
    } catch {
      return null;
    }
  }

  const metaContent = (prop) => {
    const m = document.querySelector(`meta[property="${prop}"]`);
    return m ? m.content : '';
  };

  /** Titolo pulito: rimuove brand, numero episodio e tag lingua. */
  function cleanTitle(t) {
    return String(t || '')
      .replace(/^AnimeSaturn\s*[-–—]\s*/i, '')
      .replace(/\s*[-–—]?\s*Episodio\s+\d+.*$/i, '')
      .replace(/\s+Streaming.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function scrapeWatchPage(slug, ep) {
    const cfg = readWatchConfig();
    const ld = readJsonLd('TVEpisode');
    const series = (ld && ld.partOfSeries) || {};
    // Se il sito naviga via History API la config può riferirsi all'episodio
    // precedente, ma il titolo dell'anime resta valido se lo slug coincide.
    const cfgValid = cfg && cfg.animeSlug === slug;
    const title = cleanTitle(
      (cfgValid && cfg.animeName) || series.name || metaContent('og:image:alt') || document.title,
    );
    return {
      slug,
      ep,
      title,
      cover: series.image || (ld && ld.image) || metaContent('og:image'),
      url: location.href,
    };
  }

  function scrapeAnimePage(slug) {
    const malLink = document.querySelector('a[href*="myanimelist.net/anime/"]');
    const malMatch = malLink && malLink.href.match(/myanimelist\.net\/anime\/(\d+)/);
    let total = 0;
    let finished = false;
    for (const label of document.querySelectorAll('span')) {
      const text = label.textContent.trim().toLowerCase();
      const next = label.nextElementSibling;
      if (!next) continue;
      const value = next.textContent.trim();
      if (text === 'episodi' && /^\d+$/.test(value)) total = Number(value);
      if (text === 'stato') finished = /finit|conclus|completat/i.test(value);
    }
    const h1 = document.querySelector('h1');
    return {
      slug,
      title: cleanTitle(h1 ? h1.textContent : metaContent('og:image:alt')),
      malId: malMatch ? Number(malMatch[1]) : 0,
      total,
      finished,
    };
  }

  /* ---------------------------------------------------------- marcatura DOM */

  const cache = new Map(); // slug -> entry | null

  async function loadEntries(slugs) {
    const missing = slugs.filter((s) => !cache.has(s));
    if (!missing.length) return;
    const keys = missing.map(AST.entryKey);
    const [fromSync, local] = await Promise.all([
      browser.storage.sync.get(keys),
      browser.storage.local.get('archive'),
    ]);
    const archive = local.archive || {};
    for (const s of missing) cache.set(s, fromSync[AST.entryKey(s)] || archive[s] || null);
  }

  function parseEpLink(a) {
    const href = a.getAttribute('href');
    if (!href) return null;
    let path;
    try {
      path = new URL(href, location.href).pathname;
    } catch {
      return null;
    }
    const m = path.match(EP_LINK_RE);
    return m ? { slug: decodeURIComponent(m[1]), ep: Number(m[2]) } : null;
  }

  async function markEpisodes() {
    const links = [];
    for (const a of document.querySelectorAll('a[href*="/ep-"]')) {
      const info = parseEpLink(a);
      if (info) links.push({ a, ...info });
    }
    if (!links.length) return;
    await loadEntries([...new Set(links.map((l) => l.slug))]);

    const watchedSets = new Map();
    for (const { a, slug, ep } of links) {
      const entry = cache.get(slug);
      if (!watchedSets.has(slug)) watchedSets.set(slug, new Set(entry ? AST.decodeRanges(entry.w) : []));
      const watched = watchedSets.get(slug).has(ep);
      const isLast = !!entry && entry.e === ep;
      const isTile = a.classList.contains('ep-tile') || !!a.querySelector('.ep-seen');

      a.classList.toggle('ast-watched', watched);
      a.classList.toggle('ast-last', watched && isLast);
      if (isTile) {
        // Riusa il check verde nativo del sito (.is-watched .ep-seen { display:block }).
        a.classList.toggle('is-watched', watched);
      } else {
        a.classList.toggle('ast-card', watched);
        if (watched && getComputedStyle(a).position === 'static') a.classList.add('ast-rel');
      }
      if (watched) a.dataset.astTitle = isLast ? 'Ultimo visto' : 'Visto';
      else delete a.dataset.astTitle;
    }
  }

  let markTimer = 0;
  function scheduleMark() {
    clearTimeout(markTimer);
    markTimer = setTimeout(() => markEpisodes().catch((e) => console.debug('[AST] mark', e)), 150);
  }

  /* ---------------------------------------------------------- "Continua" sulla pagina anime */

  async function injectContinueButton(slug) {
    await loadEntries([slug]);
    const entry = cache.get(slug);
    document.getElementById('ast-continue')?.remove();
    if (!entry || !entry.e) return;
    const h1 = document.querySelector('h1');
    if (!h1) return;
    const a = document.createElement('a');
    a.id = 'ast-continue';
    a.className = 'ast-continue';
    a.href = `/anime/${encodeURIComponent(slug)}/ep-${entry.e}`;
    a.textContent = `▶ Continua dall'episodio ${entry.e}`;
    h1.insertAdjacentElement('afterend', a);
  }

  /* ---------------------------------------------------------- tracciamento */

  let currentPath = '';
  let tracked = new Set();      // "slug#ep" già inviati in questa pagina
  let visibleSeconds = 0;
  let minWatchSec = AST.DEFAULT_SETTINGS.minWatchSec;

  AST.getSettings().then((s) => (minWatchSec = Number(s.minWatchSec) || 0));

  function onRoute() {
    currentPath = location.pathname;
    visibleSeconds = 0;
    const animeMatch = currentPath.match(ANIME_RE);
    if (animeMatch) {
      const slug = decodeURIComponent(animeMatch[1]);
      browser.runtime.sendMessage({ type: 'animeMeta', payload: scrapeAnimePage(slug) }).catch(() => {});
      injectContinueButton(slug).catch(() => {});
    }
    scheduleMark();
  }

  async function sendEpisode(slug, ep) {
    const key = `${slug}#${ep}`;
    if (tracked.has(key)) return;
    tracked.add(key);
    try {
      const res = await browser.runtime.sendMessage({ type: 'episodeViewed', payload: scrapeWatchPage(slug, ep) });
      if (res && res.error) throw new Error(res.error);
      cache.delete(slug);
      scheduleMark();
    } catch (e) {
      tracked.delete(key); // riprova al prossimo tick
      console.warn('[AST] tracking fallito', e);
    }
  }

  // Un unico tick da 1s: rileva navigazioni via History API e misura il tempo
  // di visione effettivo (solo con tab visibile).
  setInterval(() => {
    if (location.pathname !== currentPath) onRoute();
    const m = currentPath.match(WATCH_RE);
    if (!m) return;
    if (!document.hidden) visibleSeconds++;
    if (visibleSeconds >= minWatchSec) sendEpisode(decodeURIComponent(m[1]), Number(m[2]));
  }, 1000);

  window.addEventListener('popstate', () => setTimeout(onRoute, 0));

  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length)) scheduleMark();
  }).observe(document.body, { childList: true, subtree: true });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[AST.SETTINGS_KEY]) {
      minWatchSec = Number((changes[AST.SETTINGS_KEY].newValue || {}).minWatchSec) || 0;
    }
    let dirty = false;
    for (const key of Object.keys(changes)) {
      if (key.startsWith(AST.ENTRY_PREFIX)) {
        cache.delete(key.slice(AST.ENTRY_PREFIX.length));
        dirty = true;
      } else if (key === 'archive') {
        cache.clear();
        dirty = true;
      }
    }
    if (dirty) {
      scheduleMark();
      const am = location.pathname.match(ANIME_RE);
      if (am) injectContinueButton(decodeURIComponent(am[1])).catch(() => {});
    }
  });

  onRoute();
})();
