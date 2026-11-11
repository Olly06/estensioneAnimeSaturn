/* sw.js — entry point del service worker per Chrome/Chromium.
 * Firefox ignora `background.service_worker` e carica direttamente `background.scripts`.
 */
importScripts('../lib/common.js', '../lib/mal_api.js', 'background.js');
