/* common.js — utilità condivise da background, content script e popup.
 * Caricato come script classico: espone il namespace globale `AST`.
 *
 * Modello dati in browser.storage.sync (compatto, una chiave per anime):
 *   "settings"      -> { scrobble, minWatchSec, clientId, base }
 *   "a:<slug>"      -> {
 *       t: "Titolo",                      // titolo AnimeSaturn ripulito
 *       e: 4,                             // ultimo episodio visualizzato (per "Continua")
 *       w: "1-4,6",                       // episodi visti, compressi a intervalli
 *       d: 1730800000,                    // ultima visione (epoch in SECONDI)
 *       m: 34572,                         // mal_id (0 = non associato)
 *       n: 12,                            // episodi totali (0 = sconosciuto/in corso)
 *       c: "/static/images/copertine/x.jpg" // cover (path relativo a img.saturncdn.net)
 *   }
 * Lo slug di AnimeSaturn (es. "black-clover-67Dip") è univoco e stabile: è la chiave.
 * Gli URL vengono ricostruiti da `settings.base`, così un cambio di dominio del sito
 * non invalida lo storico.
 */
'use strict';

/* Compatibilità Chrome: in Chromium MV3 le API `chrome.*` restituiscono già
 * Promise, quindi basta esporle come `browser`. Firefox ha `browser` nativo.
 * Questo file è il primo caricato ovunque (popup, content script, background). */
if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') {
  globalThis.browser = globalThis.chrome;
}

// eslint-disable-next-line no-unused-vars
const AST = (() => {
  const ENTRY_PREFIX = 'a:';
  const SETTINGS_KEY = 'settings';
  const COVER_HOST = 'https://img.saturncdn.net';

  const DEFAULT_SETTINGS = Object.freeze({
    scrobble: true,       // auto-scrobble su MAL
    minWatchSec: 20,      // secondi di permanenza sulla pagina prima di contare l'episodio
    clientId: '',         // Client ID dell'app registrata su MAL
    base: 'https://www.animesaturn.net',
  });

  /** [1,2,3,5,7,8] -> "1-3,5,7-8" */
  function encodeRanges(list) {
    const nums = [...new Set(list)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      const start = nums[i];
      while (i + 1 < nums.length && nums[i + 1] === nums[i] + 1) i++;
      out.push(start === nums[i] ? String(start) : `${start}-${nums[i]}`);
    }
    return out.join(',');
  }

  /** "1-3,5" -> [1,2,3,5] */
  function decodeRanges(str) {
    if (!str) return [];
    const out = [];
    for (const part of String(str).split(',')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isInteger(a)) continue;
      const end = Number.isInteger(b) ? Math.min(b, a + 5000) : a; // guardia contro input malevoli
      for (let n = a; n <= end; n++) out.push(n);
    }
    return out;
  }

  function maxWatched(entry) {
    const eps = decodeRanges(entry && entry.w);
    return eps.length ? eps[eps.length - 1] : 0;
  }

  function isCompleted(entry) {
    return !!entry && entry.n > 0 && maxWatched(entry) >= entry.n;
  }

  /** Slug segnaposto per anime importati da MAL (senza slug AnimeSaturn). */
  const placeholderSlug = (malId) => `mal-${malId}`;
  const isPlaceholder = (slug) => /^mal-\d+$/.test(slug);

  const entryKey = (slug) => ENTRY_PREFIX + slug;

  function trimBase(base) {
    return String(base || DEFAULT_SETTINGS.base).replace(/\/+$/, '');
  }

  function episodeUrl(base, slug, ep) {
    return `${trimBase(base)}/anime/${encodeURIComponent(slug)}/ep-${ep}`;
  }

  /** Versione corta del titolo per la ricerca: senza sottotitolo, stagione/parte e rumore. */
  function shortTitle(title) {
    let t = String(title || '')
      .replace(/\((?:sub\s*)?ita\)/gi, ' ')
      .split(/\s*[:–—]\s*|\s+-\s+/)[0]
      .replace(/\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|final)\s+season\b/gi, ' ')
      .replace(/\b(?:season|stagione|part|cour)\s*\d+\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = t.split(' ');
    if (words.length > 3) t = words.slice(0, 3).join(' ');
    return t || String(title || '').trim();
  }

  function searchUrl(base, title, short = false) {
    return `${trimBase(base)}/filter?key=${encodeURIComponent(short ? shortTitle(title) : title)}`;
  }

  function animeUrl(base, slug) {
    return `${trimBase(base)}/anime/${encodeURIComponent(slug)}`;
  }

  /** Comprime l'URL della cover per risparmiare quota sync. */
  function compactCover(url) {
    if (!url) return '';
    return url.startsWith(COVER_HOST + '/') ? url.slice(COVER_HOST.length) : url;
  }

  function coverUrl(c) {
    if (!c) return '';
    if (c.startsWith('/')) return COVER_HOST + c;
    return /^https:\/\//.test(c) ? c : '';
  }

  async function getSettings() {
    const { [SETTINGS_KEY]: s } = await browser.storage.sync.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(s || {}) };
  }

  return {
    ENTRY_PREFIX,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    encodeRanges,
    decodeRanges,
    maxWatched,
    isCompleted,
    entryKey,
    placeholderSlug,
    isPlaceholder,
    episodeUrl,
    animeUrl,
    searchUrl,
    shortTitle,
    compactCover,
    coverUrl,
    getSettings,
  };
})();
