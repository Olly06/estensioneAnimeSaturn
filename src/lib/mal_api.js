/* mal_api.js — client REST per MyAnimeList API v2 + OAuth2 PKCE + matching titoli.
 * Caricato nel background (script classico): espone il namespace globale `MalApi`.
 *
 * NOTA: MyAnimeList supporta SOLO `code_challenge_method=plain`, quindi
 * code_challenge === code_verifier (43–128 caratteri non riservati).
 */
'use strict';

// eslint-disable-next-line no-unused-vars
const MalApi = (() => {
  const AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
  const TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
  const API_BASE = 'https://api.myanimelist.net/v2';
  const AUTH_KEY = 'malAuth'; // in storage.local (mai in sync)
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;

  class MalError extends Error {
    constructor(message, { status = 0, code = '' } = {}) {
      super(message);
      this.name = 'MalError';
      this.status = status;
      this.code = code; // 'reauth' | 'no_client_id' | 'network' | 'http' | 'auth_flow'
    }
    get retryable() {
      return this.code === 'network' || this.status === 429 || this.status >= 500;
    }
  }

  let clientIdProvider = async () => '';
  /** Il background inietta la sorgente del Client ID (salvato nelle impostazioni). */
  function setClientIdProvider(fn) {
    clientIdProvider = fn;
  }

  /* ------------------------------------------------------------ PKCE / OAuth */

  function randomString(len) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // 64 → nessun bias
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => alphabet[b & 63]).join('');
  }

  function getRedirectURL() {
    return browser.identity.getRedirectURL();
  }

  async function loadAuth() {
    const { [AUTH_KEY]: auth } = await browser.storage.local.get(AUTH_KEY);
    return auth || null;
  }

  async function saveAuth(tokens, clientId) {
    const auth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      clientId,
    };
    await browser.storage.local.set({ [AUTH_KEY]: auth });
    return auth;
  }

  async function clearAuth() {
    await browser.storage.local.remove(AUTH_KEY);
  }

  async function tokenRequest(params) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
    } catch (e) {
      throw new MalError(`Rete non raggiungibile: ${e.message}`, { code: 'network' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || data.error_description || data.error || `HTTP ${res.status}`;
      const reauth = res.status === 400 || res.status === 401;
      throw new MalError(`Token MAL: ${msg}`, { status: res.status, code: reauth ? 'reauth' : 'http' });
    }
    return data;
  }

  /** Avvia il flusso OAuth2 Authorization Code + PKCE tramite browser.identity. */
  async function login(clientId) {
    if (!clientId) throw new MalError('Imposta prima il Client ID MAL', { code: 'no_client_id' });
    const verifier = randomString(128);
    const state = randomString(32);
    const redirectUri = getRedirectURL();

    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      state,
      redirect_uri: redirectUri,
      code_challenge: verifier,
      code_challenge_method: 'plain',
    }).toString();

    let resultUrl;
    try {
      resultUrl = await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    } catch (e) {
      throw new MalError(`Autorizzazione annullata o fallita: ${e.message}`, { code: 'auth_flow' });
    }

    const result = new URL(resultUrl);
    const params = result.searchParams;
    if (params.get('error')) {
      throw new MalError(`MAL ha rifiutato l'accesso: ${params.get('error_description') || params.get('error')}`, {
        code: 'auth_flow',
      });
    }
    if (params.get('state') !== state) throw new MalError('Parametro state non valido (possibile CSRF)', { code: 'auth_flow' });
    const code = params.get('code');
    if (!code) throw new MalError('Nessun authorization code ricevuto', { code: 'auth_flow' });

    const tokens = await tokenRequest({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    return saveAuth(tokens, clientId);
  }

  async function logout() {
    // MAL non espone un endpoint di revoca: si eliminano i token locali.
    await clearAuth();
  }

  async function isLoggedIn() {
    return !!(await loadAuth());
  }

  let refreshing = null;
  /** Refresh con de-duplicazione: richieste concorrenti condividono la stessa promise. */
  function refreshTokens(auth) {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const tokens = await tokenRequest({
            client_id: auth.clientId,
            grant_type: 'refresh_token',
            refresh_token: auth.refreshToken,
          });
          return await saveAuth(tokens, auth.clientId);
        } catch (e) {
          if (e.code === 'reauth') await clearAuth();
          throw e;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  async function getValidAuth({ forceRefresh = false } = {}) {
    let auth = await loadAuth();
    if (!auth) return null;
    if (forceRefresh || auth.expiresAt - REFRESH_MARGIN_MS < Date.now()) {
      auth = await refreshTokens(auth);
    }
    return auth;
  }

  /* ------------------------------------------------------------ REST */

  async function request(path, { method = 'GET', query, form, requireAuth = false } = {}, retried = false) {
    const auth = await getValidAuth();
    const headers = {};
    if (auth) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
    } else if (requireAuth) {
      throw new MalError('Login MAL richiesto', { code: 'reauth', status: 401 });
    } else {
      const clientId = await clientIdProvider();
      if (!clientId) throw new MalError('Client ID MAL mancante', { code: 'no_client_id' });
      headers['X-MAL-CLIENT-ID'] = clientId;
    }

    const url = new URL(API_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

    const init = { method, headers };
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new MalError(`Rete non raggiungibile: ${e.message}`, { code: 'network' });
    }

    if (res.status === 401 && auth && !retried) {
      // Token revocato/scaduto prima del previsto: un refresh forzato e un solo retry.
      await getValidAuth({ forceRefresh: true });
      return request(path, { method, query, form, requireAuth }, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new MalError(`MAL ${method} ${path}: ${data.message || data.error || 'HTTP ' + res.status}`, {
        status: res.status,
        code: res.status === 401 ? 'reauth' : 'http',
      });
    }
    return data;
  }

  const SEARCH_FIELDS = 'id,title,alternative_titles,num_episodes,main_picture,media_type,start_season';

  async function searchAnime(q, limit = 10) {
    const query = String(q).trim().slice(0, 64); // MAL rifiuta query troppo lunghe
    if (query.length < 3) return [];
    const data = await request('/anime', { query: { q: query, limit, fields: SEARCH_FIELDS, nsfw: 'true' } });
    return (data.data || []).map((d) => d.node);
  }

  function getAnime(id, fields = 'id,title,num_episodes,main_picture,my_list_status,status') {
    return request(`/anime/${encodeURIComponent(id)}`, { query: { fields } });
  }

  /** @param {{status?:string,num_watched_episodes?:number,score?:number}} patch */
  function updateMyListStatus(id, patch) {
    const form = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) form[k] = String(v);
    return request(`/anime/${encodeURIComponent(id)}/my_list_status`, { method: 'PATCH', form, requireAuth: true });
  }

  /** Tutta la lista dell'utente per uno stato MAL (paginata, 1000 per pagina). */
  async function getAnimeList(status = 'completed') {
    const out = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const data = await request('/users/@me/animelist', {
        requireAuth: true,
        query: { status, limit: 1000, offset, nsfw: 'true', fields: 'list_status,num_episodes,main_picture' },
      });
      out.push(...(data.data || []));
      if (!data.paging || !data.paging.next) break;
    }
    return out;
  }

  function getUser() {
    return request('/users/@me', { requireAuth: true });
  }

  /* ------------------------------------------------------------ Matching titoli
   * AnimeSaturn usa un mix di titoli inglesi, romaji e italiani, con suffissi
   * "(ITA)", "Season 2", "2", "Part 2"... MAL ha titolo romaji + alternative
   * (en, ja, synonyms). Si normalizzano entrambi i lati e si calcola una
   * similarità a bigrammi, pesando la coerenza di stagione/parte.
   */

  const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };
  const NOISE = /\b(?:sub\s*ita|dub\s*ita|ita|sub|dub|streaming|episodio\s*\d+|ep\s*\d+|tv|the animation)\b/g;

  function normalize(str) {
    return String(str || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // accenti/macron (ō -> o)
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Allinea le varianti di traslitterazione romaji (ou/oo/uu -> o/u). */
  function loosen(s) {
    return s.replace(/ou|oo|oh(?=\s|$)/g, 'o').replace(/uu/g, 'u').replace(/\s+/g, '');
  }

  function analyze(title) {
    let s = normalize(title);
    let season = 1;
    let part = 0;
    const take = (re, fn) => {
      const m = s.match(re);
      if (m) {
        fn(m);
        s = s.replace(re, ' ');
      }
    };
    take(/\b(?:season|stagione|s)\s*(\d{1,2})\b/, (m) => (season = +m[1]));
    take(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/, (m) => (season = +m[1]));
    take(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+season\b/, (m) => (season = ORDINALS[m[1]]));
    take(/\b(?:part|cour)\s*(\d{1,2})\b/, (m) => (part = +m[1]));
    take(/\bfinal season\b/, () => (season = Math.max(season, 99)));
    take(/\b(ii|iii|iv|vi|vii|viii|ix)$/, (m) => (season = ROMAN[m[1]]));
    // Numero singolo finale ("Blue Box 2"), solo se il titolo non è solo un numero.
    take(/(?<=\S)(?<!\bno)\s([2-9])$/, (m) => (season = +m[1]));
    const base = s.replace(/\s+/g, ' ').trim();
    return { full: normalize(title), base, loose: loosen(base), season, part };
  }

  function bigrams(s) {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  /** Coefficiente di Sørensen–Dice sui bigrammi (0..1). */
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
    return (2 * inter) / (a.length - 1 + (b.length - 1));
  }

  function candidateTitles(node) {
    const alt = node.alternative_titles || {};
    return [node.title, alt.en, alt.ja, ...(alt.synonyms || [])].filter(Boolean);
  }

  function scoreCandidate(src, node, { isMovie = false } = {}) {
    let best = 0;
    for (const t of candidateTitles(node)) {
      const c = analyze(t);
      if (!c.full) continue;
      let s;
      if (c.full === src.full) {
        s = 1.2;
      } else {
        s = 0.6 * dice(src.loose, c.loose) + 0.4 * dice(src.full, c.full);
        if (c.season === src.season) s += 0.12;
        else s -= 0.25;
        if (src.part && c.part && src.part !== c.part) s -= 0.15;
      }
      best = Math.max(best, s);
    }
    const type = node.media_type || '';
    if (isMovie ? type === 'movie' : type === 'tv') best += 0.03;
    return best;
  }

  function buildQueries(title) {
    const a = analyze(title);
    const qs = [
      title.replace(/\((?:sub\s*)?ita\)|\bsub ita\b|\bita\b/gi, '').trim(),
      a.season > 1 && a.season < 99 ? `${a.base} season ${a.season}` : a.base,
      a.base.split(' ').slice(0, 4).join(' '),
    ];
    return [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()).filter((q) => q.length >= 3))];
  }

  const MATCH_THRESHOLD = 0.55;

  /**
   * Cerca su MAL il titolo AnimeSaturn e restituisce il miglior candidato.
   * @returns {Promise<{node:object, score:number}|null>}
   */
  async function findBestMatch(title, { slug = '' } = {}) {
    const src = analyze(title);
    const isMovie = /\b(movie|film)\b/i.test(title + ' ' + slug);
    let best = null;
    const seen = new Set();
    for (const q of buildQueries(title)) {
      const results = await searchAnime(q, 10);
      for (const node of results) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const score = scoreCandidate(src, node, { isMovie });
        if (!best || score > best.score) best = { node, score };
      }
      if (best && best.score >= 0.9) break; // abbastanza sicuro, risparmia chiamate
    }
    return best && best.score >= MATCH_THRESHOLD ? best : null;
  }

  return {
    MalError,
    setClientIdProvider,
    getRedirectURL,
    login,
    logout,
    isLoggedIn,
    getUser,
    getAnimeList,
    searchAnime,
    getAnime,
    updateMyListStatus,
    findBestMatch,
    // esposti per test/debug dalla console del background
    _match: { normalize, analyze, dice, scoreCandidate, buildQueries },
  };
})();
