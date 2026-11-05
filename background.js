/* background.js — event page (Firefox MV3).
 * Coordina storage (sync + local), risoluzione mal_id, scrobble su MAL e coda di retry.
 * Dipende da common.js (AST) e mal_api.js (MalApi), caricati prima nel manifest.
 */
'use strict';

/* global AST, MalApi */

const LOCAL = {
  META: 'meta',         // { slug: { malId, total, finished, title, cover, at } } cache delle pagine anime
  MAL_STATE: 'malState', // { slug: { s, msg, at, ep } } stato sync MAL per anime (per dispositivo)
  ARCHIVE: 'archive',   // { slug: entry } voci spostate fuori da sync per limiti di quota
  MAL_USER: 'malUser',  // { name, picture }
};
const MAX_SYNC_ENTRIES = 450;  // Firefox: max 512 chiavi in storage.sync
const META_CACHE_MAX = 300;
const RETRY_ALARM = 'mal-retry';

MalApi.setClientIdProvider(async () => (await AST.getSettings()).clientId);

/* ------------------------------------------------------------ serializzazione
 * Tutte le read-modify-write passano da qui per evitare race condition
 * (es. due episodi tracciati in rapida successione o import concorrente).
 */
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------ storage helpers */

async function getLocal(key, fallback = {}) {
  const { [key]: v } = await browser.storage.local.get(key);
  return v ?? fallback;
}

async function patchLocalMap(key, slug, value) {
  const map = await getLocal(key);
  if (value === null) delete map[slug];
  else map[slug] = { ...(map[slug] || {}), ...value };
  await browser.storage.local.set({ [key]: map });
  return map[slug];
}

async function setSettings(patch) {
  const s = { ...(await AST.getSettings()), ...patch };
  await browser.storage.sync.set({ [AST.SETTINGS_KEY]: s });
  return s;
}

async function getEntry(slug) {
  const key = AST.entryKey(slug);
  const { [key]: entry } = await browser.storage.sync.get(key);
  if (entry) return entry;
  const archive = await getLocal(LOCAL.ARCHIVE);
  return archive[slug] || null;
}

/** Tutte le voci: sync (prioritaria) + archivio locale. */
async function getAllEntries() {
  const [all, archive] = await Promise.all([browser.storage.sync.get(null), getLocal(LOCAL.ARCHIVE)]);
  const out = { ...archive };
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(AST.ENTRY_PREFIX)) out[k.slice(AST.ENTRY_PREFIX.length)] = v;
  }
  return out;
}

/** Sposta in archivio locale le voci meno recenti (completate per prime). */
async function archiveOldest(count) {
  const all = await browser.storage.sync.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(AST.ENTRY_PREFIX))
    .map(([k, v]) => ({ k, v, done: AST.isCompleted(v) }))
    .sort((a, b) => (a.done === b.done ? a.v.d - b.v.d : a.done ? -1 : 1));
  const victims = entries.slice(0, count);
  if (!victims.length) return 0;
  const archive = await getLocal(LOCAL.ARCHIVE);
  for (const { k, v } of victims) archive[k.slice(AST.ENTRY_PREFIX.length)] = v;
  await browser.storage.local.set({ [LOCAL.ARCHIVE]: archive });
  await browser.storage.sync.remove(victims.map((x) => x.k));
  return victims.length;
}

async function putEntry(slug, entry) {
  const key = AST.entryKey(slug);
  const all = await browser.storage.sync.get(null);
  const count = Object.keys(all).filter((k) => k.startsWith(AST.ENTRY_PREFIX)).length;
  if (!all[key] && count >= MAX_SYNC_ENTRIES) await archiveOldest(25);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await browser.storage.sync.set({ [key]: entry });
      // Se era in archivio, ora vive di nuovo in sync.
      const archive = await getLocal(LOCAL.ARCHIVE);
      if (archive[slug]) {
        delete archive[slug];
        await browser.storage.local.set({ [LOCAL.ARCHIVE]: archive });
      }
      return entry;
    } catch (e) {
      if (!isSpaceQuotaError(e)) throw e;
      if (!(await archiveOldest(25))) break;
    }
  }
  // Ultima spiaggia: resta solo in locale.
  await patchLocalMap(LOCAL.ARCHIVE, slug, entry);
  return entry;
}

/** Quota di spazio esaurita (non il limite di scritture/minuto di Chrome). */
function isSpaceQuotaError(e) {
  const msg = String(e && e.message);
  return /quota/i.test(msg) && !/WRITE_OPERATIONS/i.test(msg);
}

/** Scrittura in blocco (import): poche chiamate set() per restare sotto il limite
 * di Chrome di 120 scritture/minuto su storage.sync. Le voci in eccesso o che non
 * entrano nella quota finiscono nell'archivio locale. */
async function putEntriesBulk(map) {
  const all = await browser.storage.sync.get(null);
  const existing = Object.keys(all).filter((k) => k.startsWith(AST.ENTRY_PREFIX) && !(k.slice(AST.ENTRY_PREFIX.length) in map));
  const capacity = Math.max(0, MAX_SYNC_ENTRIES - existing.length);
  const sorted = Object.entries(map).sort((a, b) => b[1].d - a[1].d);
  const toArchive = sorted.slice(capacity);
  const toSync = sorted.slice(0, capacity);
  const synced = [];

  for (let i = 0; i < toSync.length; i += 50) {
    const chunk = toSync.slice(i, i + 50);
    try {
      await browser.storage.sync.set(Object.fromEntries(chunk.map(([slug, v]) => [AST.entryKey(slug), v])));
      synced.push(...chunk);
    } catch (e) {
      if (!isSpaceQuotaError(e)) throw e;
      toArchive.push(...chunk);
    }
  }

  const archive = await getLocal(LOCAL.ARCHIVE);
  for (const [slug] of synced) delete archive[slug];
  for (const [slug, v] of toArchive) archive[slug] = v;
  await browser.storage.local.set({ [LOCAL.ARCHIVE]: archive });
}

async function deleteEntry(slug) {
  await browser.storage.sync.remove(AST.entryKey(slug));
  await patchLocalMap(LOCAL.ARCHIVE, slug, null);
  await patchLocalMap(LOCAL.MAL_STATE, slug, null);
}

async function setMalState(slug, s, extra = {}) {
  await patchLocalMap(LOCAL.MAL_STATE, slug, { s, msg: '', ...extra, at: Date.now() });
}

async function saveMeta(slug, meta) {
  const map = await getLocal(LOCAL.META);
  map[slug] = { ...(map[slug] || {}), ...meta, at: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > META_CACHE_MAX) {
    keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - META_CACHE_MAX).forEach((k) => delete map[k]);
  }
  await browser.storage.local.set({ [LOCAL.META]: map });
  return map[slug];
}

/* ------------------------------------------------------------ metadati AnimeSaturn */

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return named[code.toLowerCase()] ?? all;
  });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Estrae mal_id/episodi totali/stato dalla pagina anime.
 * Usa regex e non DOMParser: il service worker di Chrome non ha DOM. */
function parseAnimePage(html) {
  const meta = {};
  const mal = html.match(/href="https?:\/\/(?:www\.)?myanimelist\.net\/anime\/(\d+)/i);
  if (mal) meta.malId = Number(mal[1]);

  // <span ...>Episodi</span> <span ...>170</span>
  const eps = html.match(/>\s*Episodi\s*<\/span>\s*<span[^>]*>\s*(\d+)\s*</i);
  if (eps) meta.total = Number(eps[1]);

  // <span ...>Stato</span> <span ...><span ...>Finito</span>…
  const stato = html.match(/>\s*Stato\s*<\/span>\s*<span[^>]*>(?:\s*<span[^>]*>)?\s*([^<]+)</i);
  if (stato) meta.finished = /finit|conclus|completat/i.test(stato[1]);

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) meta.title = stripTags(h1[1]);
  return meta;
}

async function fetchAnimeMeta(slug) {
  const { base } = await AST.getSettings();
  const res = await fetch(AST.animeUrl(base, slug), { credentials: 'omit' });
  if (!res.ok) throw new Error(`AnimeSaturn HTTP ${res.status}`);
  return saveMeta(slug, parseAnimePage(await res.text()));
}

/* ------------------------------------------------------------ MAL: associazione e scrobble */

/** Restituisce il mal_id dell'anime (salvandolo nella voce sync), o 0 se non trovato. */
async function resolveMalId(slug) {
  const entry = await getEntry(slug);
  if (!entry) return 0;
  if (entry.m) return entry.m;

  // 1) cache dei metadati (pagina anime visitata) o fetch della pagina anime: link diretto a MAL.
  let meta = (await getLocal(LOCAL.META))[slug];
  if (!meta || !meta.malId) {
    try {
      meta = await fetchAnimeMeta(slug);
    } catch (e) {
      console.warn('[AST] meta fetch fallito', slug, e);
    }
  }
  let malId = (meta && meta.malId) || 0;

  // 2) fallback: ricerca testuale su MAL con matching normalizzato.
  if (!malId) {
    const match = await MalApi.findBestMatch(entry.t, { slug });
    if (match) {
      malId = match.node.id;
      console.info(`[AST] "${entry.t}" -> MAL ${malId} "${match.node.title}" (score ${match.score.toFixed(2)})`);
    }
  }

  if (malId) {
    await serial(async () => {
      const fresh = await getEntry(slug);
      if (fresh && !fresh.m) await putEntry(slug, { ...fresh, m: malId, n: fresh.n || (meta && meta.finished && meta.total) || 0 });
    });
  }
  return malId;
}

const scrobbleLocks = new Map();
/** Scrobble per-slug serializzato (evita PATCH concorrenti sullo stesso anime). */
function scrobble(slug, opts) {
  const prev = scrobbleLocks.get(slug) || Promise.resolve();
  const run = prev.then(() => doScrobble(slug, opts)).catch(() => {});
  scrobbleLocks.set(slug, run);
  run.finally(() => scrobbleLocks.get(slug) === run && scrobbleLocks.delete(slug));
  return run;
}

async function doScrobble(slug, { force = false } = {}) {
  const settings = await AST.getSettings();
  if (!settings.scrobble && !force) return setMalState(slug, 'off');
  if (!(await MalApi.isLoggedIn())) return setMalState(slug, 'nologin');

  try {
    const malId = await resolveMalId(slug);
    if (!malId) return setMalState(slug, 'unmatched', { msg: 'Anime non trovato su MAL: associalo manualmente' });

    const entry = await getEntry(slug);
    const info = await MalApi.getAnime(malId);
    const total = Number(info.num_episodes) || 0;
    const watched = AST.maxWatched(entry);
    const target = total > 0 ? Math.min(watched, total) : watched;

    const remote = info.my_list_status || null;
    const remoteEps = (remote && remote.num_episodes_watched) || 0;
    const newEps = Math.max(target, remoteEps); // mai far regredire il progresso su MAL
    const status = total > 0 && newEps >= total ? 'completed' : 'watching';

    const unchanged = remote && remoteEps === newEps && (remote.status === status || remote.status === 'completed');
    if (!unchanged) {
      await MalApi.updateMyListStatus(malId, { status, num_watched_episodes: newEps });
    }

    // Aggiorna episodi totali e cover dalla fonte autorevole.
    if (total && entry.n !== total) {
      await serial(async () => {
        const fresh = await getEntry(slug);
        if (fresh) await putEntry(slug, { ...fresh, n: total });
      });
    }
    await setMalState(slug, 'ok', {
      ep: newEps,
      status: unchanged ? remote.status : status,
      malTitle: info.title,
      malCover: info.main_picture && (info.main_picture.medium || info.main_picture.large),
    });
  } catch (e) {
    console.warn('[AST] scrobble fallito', slug, e);
    if (e.code === 'reauth') return setMalState(slug, 'nologin', { msg: e.message });
    if (e.code === 'no_client_id') return setMalState(slug, 'error', { msg: e.message });
    if (e.retryable) {
      await setMalState(slug, 'pending', { msg: e.message });
      return scheduleRetry();
    }
    return setMalState(slug, 'error', { msg: e.message });
  }
}

function scheduleRetry() {
  browser.alarms.create(RETRY_ALARM, { delayInMinutes: 5, periodInMinutes: 15 });
}

async function retryPending({ all = false } = {}) {
  const states = await getLocal(LOCAL.MAL_STATE);
  const slugs = Object.keys(states).filter((s) =>
    all ? ['pending', 'error', 'nologin'].includes(states[s].s) : states[s].s === 'pending');
  for (const slug of slugs) await scrobble(slug, { force: all });
  const left = Object.values(await getLocal(LOCAL.MAL_STATE)).some((st) => st.s === 'pending');
  if (!left) await browser.alarms.clear(RETRY_ALARM);
  return slugs.length;
}

/* ------------------------------------------------------------ tracciamento episodi */

async function onEpisodeViewed(p, sender) {
  const slug = String(p.slug || '');
  const ep = Number(p.ep);
  if (!/^[\w.-]{1,120}$/.test(slug) || !Number.isInteger(ep) || ep < 0 || ep > 10000) {
    throw new Error('Payload episodio non valido');
  }

  // Segue automaticamente i cambi di dominio di AnimeSaturn.
  const origin = sender && sender.url ? new URL(sender.url).origin : '';
  const settings = await AST.getSettings();
  if (origin && origin !== settings.base) await setSettings({ base: origin });

  const meta = (await getLocal(LOCAL.META))[slug];
  const entry = await serial(async () => {
    const prev = (await getEntry(slug)) || { t: '', e: 0, w: '', d: 0, m: 0, n: 0, c: '' };
    const watched = AST.decodeRanges(prev.w);
    watched.push(ep);
    const next = {
      t: String(p.title || prev.t || slug).slice(0, 150),
      e: ep,
      w: AST.encodeRanges(watched),
      d: Math.floor(Date.now() / 1000),
      m: prev.m || (meta && meta.malId) || 0,
      n: prev.n || (meta && meta.finished && meta.total) || 0,
      c: AST.compactCover(p.cover) || prev.c || '',
    };
    return putEntry(slug, next);
  });

  scrobble(slug); // asincrono: la risposta al content script non attende MAL
  return { ok: true, entry };
}

async function onAnimeMeta(p) {
  const slug = String(p.slug || '');
  if (!/^[\w.-]{1,120}$/.test(slug)) return { ok: false };
  const meta = await saveMeta(slug, {
    malId: Number(p.malId) || 0,
    total: Number(p.total) || 0,
    finished: !!p.finished,
    title: String(p.title || '').slice(0, 150),
  });
  await serial(async () => {
    const entry = await getEntry(slug);
    if (!entry) return;
    const patch = {};
    if (!entry.m && meta.malId) patch.m = meta.malId;
    if (!entry.n && meta.finished && meta.total) patch.n = meta.total;
    if (Object.keys(patch).length) await putEntry(slug, { ...entry, ...patch });
  });
  return { ok: true };
}

/* ------------------------------------------------------------ backup */

async function exportData() {
  const settings = await AST.getSettings();
  return {
    format: 'animesaturn-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { scrobble: settings.scrobble, minWatchSec: settings.minWatchSec, clientId: settings.clientId, base: settings.base },
    anime: await getAllEntries(),
  };
}

function sanitizeEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const w = AST.encodeRanges(AST.decodeRanges(typeof v.w === 'string' ? v.w : ''));
  return {
    t: String(v.t || '').slice(0, 150),
    e: Math.max(0, parseInt(v.e, 10) || 0),
    w,
    d: Math.max(0, parseInt(v.d, 10) || 0),
    m: Math.max(0, parseInt(v.m, 10) || 0),
    n: Math.max(0, parseInt(v.n, 10) || 0),
    c: typeof v.c === 'string' ? v.c.slice(0, 300) : '',
  };
}

/** Import in modalità merge: unione degli episodi visti, vince la visione più recente. */
async function importData(data) {
  if (!data || data.format !== 'animesaturn-tracker' || typeof data.anime !== 'object') {
    throw new Error('File di backup non riconosciuto');
  }
  let imported = 0;
  const batch = {};
  await serial(async () => {
    for (const [slug, raw] of Object.entries(data.anime)) {
      if (!/^[\w.-]{1,120}$/.test(slug)) continue;
      const inc = sanitizeEntry(raw);
      if (!inc) continue;
      const cur = await getEntry(slug);
      const merged = cur
        ? {
          ...(inc.d > cur.d ? { ...cur, ...inc } : { ...inc, ...cur }),
          w: AST.encodeRanges([...AST.decodeRanges(cur.w), ...AST.decodeRanges(inc.w)]),
          m: cur.m || inc.m,
          n: Math.max(cur.n, inc.n),
          c: cur.c || inc.c,
        }
        : inc;
      batch[slug] = merged;
      imported++;
    }
    await putEntriesBulk(batch);
    if (data.settings && typeof data.settings === 'object') {
      const s = data.settings;
      const patch = {};
      if (typeof s.scrobble === 'boolean') patch.scrobble = s.scrobble;
      if (Number.isFinite(s.minWatchSec)) patch.minWatchSec = Math.min(600, Math.max(0, s.minWatchSec));
      if (typeof s.clientId === 'string' && s.clientId) patch.clientId = s.clientId.trim();
      await setSettings(patch);
    }
  });
  return { imported };
}

/* ------------------------------------------------------------ messaggi */

async function getState() {
  const [settings, entries, malState, meta, malUser, loggedIn] = await Promise.all([
    AST.getSettings(),
    getAllEntries(),
    getLocal(LOCAL.MAL_STATE),
    getLocal(LOCAL.META),
    getLocal(LOCAL.MAL_USER, null),
    MalApi.isLoggedIn(),
  ]);
  return {
    settings,
    entries,
    malState,
    meta,
    auth: { loggedIn, user: loggedIn ? malUser : null },
    redirectUrl: MalApi.getRedirectURL(),
  };
}

const handlers = {
  episodeViewed: (msg, sender) => onEpisodeViewed(msg.payload || {}, sender),
  animeMeta: (msg) => onAnimeMeta(msg.payload || {}),
  getState: () => getState(),

  async setSettings(msg) {
    const patch = {};
    const p = msg.patch || {};
    if (typeof p.scrobble === 'boolean') patch.scrobble = p.scrobble;
    if (p.minWatchSec !== undefined) patch.minWatchSec = Math.min(600, Math.max(0, parseInt(p.minWatchSec, 10) || 0));
    if (typeof p.clientId === 'string') patch.clientId = p.clientId.trim();
    const s = await setSettings(patch);
    if (patch.scrobble === true) retryPending({ all: true });
    return s;
  },

  async login(msg) {
    const clientId = String(msg.clientId || (await AST.getSettings()).clientId || '').trim();
    await setSettings({ clientId });
    await MalApi.login(clientId);
    try {
      const u = await MalApi.getUser();
      await browser.storage.local.set({ [LOCAL.MAL_USER]: { name: u.name, picture: u.picture || '' } });
    } catch (e) {
      console.warn('[AST] getUser fallito', e);
    }
    retryPending({ all: true }); // sincronizza ciò che era rimasto indietro
    return { ok: true };
  },

  async logout() {
    await MalApi.logout();
    await browser.storage.local.remove(LOCAL.MAL_USER);
    return { ok: true };
  },

  async setMalId(msg) {
    const slug = String(msg.slug || '');
    const malId = parseInt(msg.malId, 10) || 0;
    await serial(async () => {
      const entry = await getEntry(slug);
      if (!entry) throw new Error('Anime non trovato');
      await putEntry(slug, { ...entry, m: malId });
    });
    if (malId) await scrobble(slug, { force: true });
    else await setMalState(slug, 'unmatched');
    return { ok: true };
  },

  async retrySync(msg) {
    if (msg.slug) await scrobble(String(msg.slug), { force: true });
    else await retryPending({ all: true });
    return { ok: true };
  },

  async deleteEntry(msg) {
    await serial(() => deleteEntry(String(msg.slug || '')));
    return { ok: true };
  },

  exportData: () => exportData(),
  importData: (msg) => importData(msg.data),
};

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Accetta messaggi solo dalla propria estensione (popup o content script).
  if (sender.id !== browser.runtime.id) return false;
  const h = msg && handlers[msg.type];
  if (!h) return false;
  // sendResponse + `return true` funziona sia in Firefox sia in Chrome
  // (Chrome non supporta la Promise restituita dal listener).
  Promise.resolve()
    .then(() => h(msg, sender))
    .catch((e) => {
      console.error('[AST]', msg.type, e);
      return { error: e.message || String(e) };
    })
    .then(sendResponse);
  return true;
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) retryPending();
});

browser.runtime.onInstalled.addListener(async () => {
  // Inizializza le impostazioni mantenendo quelle già sincronizzate.
  await setSettings({});
});
