/* popup.js — UI del popup. Tutta la logica di dominio vive nel background:
 * qui si legge lo stato (getState) e si inviano azioni via runtime.sendMessage.
 */
'use strict';

/* global AST */

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const IS_PAGE = params.has('page'); // aperto in una scheda invece che come popup

const POPUP_LIMIT = 10; // nel popup solo gli ultimi 10; la lista completa è nella pagina intera
let state = null;
let activeTab = 'ongoing';

/* ---------------------------------------------------------- utilità */

async function send(type, data = {}) {
  const res = await browser.runtime.sendMessage({ type, ...data });
  if (res && res.error) throw new Error(res.error);
  return res;
}

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function formatDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const diffDays = Math.floor((Date.now() - d) / 86400000);
  if (diffDays === 0) return `oggi ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  if (diffDays === 1) return 'ieri';
  if (diffDays < 7) return `${diffDays} giorni fa`;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

function parseMalInput(value) {
  const v = String(value).trim();
  const m = v.match(/myanimelist\.net\/anime\/(\d+)/) || v.match(/^(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Apre un URL riusando la scheda attiva se è già su AnimeSaturn. */
async function openUrl(url) {
  if (IS_PAGE) {
    await browser.tabs.create({ url });
    return;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const base = state ? state.settings.base : '';
  if (tab && tab.url && base && tab.url.startsWith(base)) await browser.tabs.update(tab.id, { url });
  else await browser.tabs.create({ url });
  window.close();
}

function openEpisode(slug, ep, title = '', short = false) {
  // Anime importato da MAL: nessuno slug AnimeSaturn, si apre la ricerca per titolo
  // (Shift+clic = titolo abbreviato).
  if (AST.isPlaceholder(slug)) return openUrl(AST.searchUrl(state.settings.base, title, short));
  return openUrl(AST.episodeUrl(state.settings.base, slug, ep));
}

/* ---------------------------------------------------------- rendering voci */

const SYNC_LABELS = {
  ok: ['ok', '✓ MAL'],
  pending: ['pending', '⟳ in coda'],
  error: ['error', '! errore MAL'],
  unmatched: ['unmatched', '? non associato'],
};

function sortedEntries() {
  return Object.entries(state.entries)
    .map(([slug, entry]) => ({ slug, entry }))
    .sort((a, b) => b.entry.d - a.entry.d);
}

function coverFor(slug, entry) {
  const ms = state.malState[slug];
  return AST.coverUrl(entry.c) || (ms && ms.malCover) || '';
}

function buildItem(slug, entry, mode) {
  const tpl = $('#item-tpl').content.firstElementChild.cloneNode(true);
  const ms = state.malState[slug] || {};
  const n = entry.n || 0;
  const maxEp = AST.maxWatched(entry);
  const watchedCount = AST.decodeRanges(entry.w).length;

  const img = tpl.querySelector('.cover');
  const cover = coverFor(slug, entry);
  if (cover) img.src = cover;
  img.addEventListener('error', () => {
    if (ms.malCover && img.src !== ms.malCover) img.src = ms.malCover;
    else img.removeAttribute('src');
  });

  const title = tpl.querySelector('.title');
  title.textContent = entry.t || slug;
  title.title = entry.t || slug;

  tpl.querySelector('.progress-text').textContent = `Ep ${entry.e}${n ? `/${n}` : ''}`;

  const sync = tpl.querySelector('.sync');
  if (state.auth.loggedIn && SYNC_LABELS[ms.s]) {
    const [cls, label] = SYNC_LABELS[ms.s];
    sync.className = `sync ${cls}`;
    sync.textContent = label;
    sync.title = ms.msg || (ms.s === 'ok' ? `Sincronizzato: ${ms.ep} ep · ${ms.status}` : '');
  }

  const bar = tpl.querySelector('.bar');
  if (n) tpl.querySelector('.bar-fill').style.width = `${Math.min(100, (maxEp / n) * 100)}%`;
  else bar.classList.add('hidden');

  const extra = tpl.querySelector('.extra');
  if (mode === 'history') {
    extra.append(`${formatDate(entry.d)} · ${watchedCount} ep vist${watchedCount === 1 ? 'o' : 'i'}`);
    if (entry.m) {
      extra.append(' · ', el('a', { href: `https://myanimelist.net/anime/${entry.m}`, target: '_blank', text: 'MAL' }));
    }
  }

  const actions = tpl.querySelector('.actions');
  actions.append(
    el('button', {
      class: 'icon-btn play',
      title: AST.isPlaceholder(slug)
        ? `Cerca su AnimeSaturn (Shift: "${AST.shortTitle(entry.t)}")`
        : `Riprendi episodio ${entry.e}`,
      text: '▶',
      onclick: (ev) => openEpisode(slug, entry.e, entry.t, ev.shiftKey),
    }),
  );
  if (mode === 'ongoing' && (!n || entry.e < n)) {
    actions.append(
      el('button', {
        class: 'icon-btn',
        title: `Episodio successivo (${entry.e + 1})`,
        text: '⏭',
        onclick: (ev) => openEpisode(slug, entry.e + 1, entry.t, ev.shiftKey),
      }),
    );
  }
  if (!entry.m || ms.s === 'unmatched' || mode === 'history') {
    actions.append(
      el('button', {
        class: 'icon-btn',
        title: entry.m ? 'Cambia associazione MAL' : 'Associa manualmente a MAL',
        text: '🔗',
        onclick: () => toggleMalForm(tpl, slug, entry),
      }),
    );
  }
  if (ms.s === 'error' || ms.s === 'pending') {
    actions.append(
      el('button', {
        class: 'icon-btn',
        title: 'Riprova sincronizzazione MAL',
        text: '⟳',
        onclick: async () => {
          try {
            await send('retrySync', { slug });
            toast('Sincronizzazione avviata');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    );
  }
  if (mode === 'history') {
    const del = el('button', { class: 'icon-btn danger', title: 'Elimina dallo storico', text: '🗑' });
    del.addEventListener('click', async () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.title = 'Clicca di nuovo per confermare';
        setTimeout(() => del.classList.remove('confirm'), 3000);
        return;
      }
      await send('deleteEntry', { slug });
      toast('Eliminato');
    });
    actions.append(del);
  }
  return tpl;
}

function toggleMalForm(item, slug, entry) {
  const info = item.querySelector('.info');
  const existing = info.querySelector('.malform');
  if (existing) {
    existing.remove();
    return;
  }
  const input = el('input', {
    type: 'text',
    placeholder: 'URL o ID MyAnimeList',
    value: entry.m ? String(entry.m) : '',
  });
  const save = async () => {
    const malId = parseMalInput(input.value);
    if (!malId && input.value.trim()) return toast('ID/URL MAL non valido', true);
    try {
      await send('setMalId', { slug, malId });
      toast(malId ? `Associato a MAL #${malId}` : 'Associazione rimossa');
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const form = el('div', { class: 'malform' }, [input, el('button', { class: 'btn small', text: 'Salva', onclick: save })]);
  info.append(form);
  input.focus();
}

const limited = (items) => (IS_PAGE ? items : items.slice(0, POPUP_LIMIT));

/** Nel popup: pulsante "Vedi tutti" che apre la pagina completa in una scheda. */
function renderSeeAll(sel, count) {
  const btn = $(sel);
  const more = !IS_PAGE && count > POPUP_LIMIT;
  btn.hidden = !more;
  if (more) btn.textContent = `Vedi tutti (${count}) ↗`;
}

function renderOngoing() {
  const list = $('#ongoing-list');
  list.replaceChildren();
  const items = sortedEntries().filter(({ entry }) => !AST.isCompleted(entry));
  for (const { slug, entry } of limited(items)) list.append(buildItem(slug, entry, 'ongoing'));
  $('#ongoing-empty').hidden = items.length > 0;
  renderSeeAll('#ongoing-all', items.length);

  const quick = $('#quick-continue');
  const first = items[0];
  quick.hidden = !first;
  if (first) {
    $('#quick-title').textContent = `${first.entry.t} · Ep ${first.entry.e}`;
    quick.onclick = (ev) => openEpisode(first.slug, first.entry.e, first.entry.t, ev.shiftKey);
  }
}

function renderHistory() {
  const q = normalizeQuery($('#search').value);
  const list = $('#history-list');
  list.replaceChildren();
  const items = sortedEntries().filter(({ slug, entry }) => !q || normalizeQuery(`${entry.t} ${slug}`).includes(q));
  for (const { slug, entry } of limited(items)) list.append(buildItem(slug, entry, 'history'));
  $('#history-empty').hidden = items.length > 0;
  renderSeeAll('#history-all', items.length);
}

function normalizeQuery(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function renderSettings() {
  const { settings, auth, redirectUrl } = state;
  const clientInput = $('#client-id');
  if (document.activeElement !== clientInput) clientInput.value = settings.clientId || '';
  $('#redirect-url').value = redirectUrl;
  $('#scrobble-toggle').checked = !!settings.scrobble;
  const minSec = $('#min-sec');
  if (document.activeElement !== minSec) minSec.value = settings.minWatchSec;

  $('#account-status').textContent = auth.loggedIn
    ? `Connesso come ${(auth.user && auth.user.name) || 'utente MAL'}`
    : 'Non connesso';
  $('#login-btn').hidden = auth.loggedIn;
  $('#logout-btn').hidden = !auth.loggedIn;
  $('#mal-import-btn').hidden = !auth.loggedIn;

  const pill = $('#mal-pill');
  pill.classList.toggle('on', auth.loggedIn);
  pill.textContent = auth.loggedIn ? `MAL · ${(auth.user && auth.user.name) || 'ok'}` : 'MAL offline';
}

async function refresh() {
  state = await send('getState');
  // Evita di distruggere un form di associazione MAL mentre l'utente sta scrivendo.
  if (document.activeElement && document.activeElement.closest('.malform')) return;
  renderOngoing();
  renderHistory();
  renderSettings();
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch((e) => toast(e.message, true)), 120);
}

/* ---------------------------------------------------------- schede */

function showTab(name) {
  activeTab = name;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${name}`;
  if (name === 'history') $('#search').focus();
  try {
    localStorage.setItem('ast-tab', name);
  } catch {
    /* storage non disponibile */
  }
}

/* ---------------------------------------------------------- permessi host */

const REQUIRED_ORIGINS = browser.runtime.getManifest().host_permissions;

async function checkPermissions() {
  const ok = await browser.permissions.contains({ origins: REQUIRED_ORIGINS });
  $('#perm-warning').hidden = ok;
  if (!ok && activeTab !== 'settings') showTab('settings');
}

/* ---------------------------------------------------------- eventi */

function bindEvents() {
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

  $('#search').addEventListener('input', renderHistory);

  for (const id of ['#ongoing-all', '#history-all']) {
    $(id).addEventListener('click', async () => {
      await browser.tabs.create({ url: browser.runtime.getURL(`popup/popup.html?page=1&tab=${activeTab}`) });
      window.close();
    });
  }

  $('#perm-grant').addEventListener('click', () => {
    // permissions.request deve partire in modo sincrono dal gesto utente.
    browser.permissions.request({ origins: REQUIRED_ORIGINS }).then(checkPermissions);
  });

  $('#client-id').addEventListener('change', async (e) => {
    await send('setSettings', { patch: { clientId: e.target.value } });
    toast('Client ID salvato');
  });

  $('#copy-redirect').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#redirect-url').value);
    toast('Redirect URL copiato');
  });

  $('#login-btn').addEventListener('click', async () => {
    const clientId = $('#client-id').value.trim();
    if (!clientId) return toast('Inserisci il Client ID della tua app MAL', true);
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.textContent = 'Attendo MAL…';
    try {
      // Il popup potrebbe chiudersi quando si apre la finestra di login:
      // il flusso continua comunque nel background.
      await send('login', { clientId });
      toast('Login effettuato');
      await refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Login con MAL';
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await send('logout');
    toast('Disconnesso da MAL');
  });

  $('#scrobble-toggle').addEventListener('change', async (e) => {
    await send('setSettings', { patch: { scrobble: e.target.checked } });
    toast(e.target.checked ? 'Auto-scrobble attivo' : 'Auto-scrobble disattivato');
  });

  $('#min-sec').addEventListener('change', async (e) => {
    await send('setSettings', { patch: { minWatchSec: e.target.value } });
    toast('Salvato');
  });

  $('#retry-all').addEventListener('click', async () => {
    await send('retrySync');
    toast('Sincronizzazione avviata');
  });

  $('#mal-import-btn').addEventListener('click', async () => {
    const btn = $('#mal-import-btn');
    btn.disabled = true;
    btn.textContent = 'Importo da MAL…';
    try {
      const r = await send('importFromMal');
      toast(`MAL: ${r.added} nuovi, ${r.updated} aggiornati (${r.total} completati)`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Importa anime visti da MAL';
    }
  });

  $('#export-btn').addEventListener('click', async () => {
    try {
      const data = await send('exportData');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `animesaturn-tracker-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#import-btn').addEventListener('click', () => {
    if (!IS_PAGE) {
      // In Firefox il popup si chiude all'apertura del file picker: si usa una scheda.
      browser.tabs.create({ url: browser.runtime.getURL('popup/popup.html?page=1&tab=settings') });
      window.close();
      return;
    }
    $('#import-file').click();
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const { imported } = await send('importData', { data });
      toast(`Importati ${imported} anime`);
    } catch (err) {
      toast(`Importazione fallita: ${err.message}`, true);
    }
  });

  browser.storage.onChanged.addListener(scheduleRefresh);
}

/* ---------------------------------------------------------- avvio */

(async function init() {
  if (IS_PAGE) document.body.classList.add('fullpage');
  bindEvents();
  let initial = params.get('tab');
  if (!initial) {
    try {
      initial = localStorage.getItem('ast-tab');
    } catch {
      initial = null;
    }
  }
  showTab(['ongoing', 'history', 'settings'].includes(initial) ? initial : 'ongoing');
  try {
    await refresh();
    await checkPermissions();
  } catch (e) {
    toast(e.message, true);
  }
})();
