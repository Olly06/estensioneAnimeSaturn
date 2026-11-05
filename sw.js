/* sw.js — entry point del service worker per Chrome/Chromium.
 * Firefox ignora `background.service_worker` e carica direttamente `background.scripts`.
 */
importScripts('common.js', 'mal_api.js', 'background.js');
