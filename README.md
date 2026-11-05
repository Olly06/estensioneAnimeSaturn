# AnimeSaturn Tracker

Estensione Firefox (Manifest V3) che traccia gli episodi visti su AnimeSaturn, li sincronizza tra browser con Firefox Sync e aggiorna la lista MyAnimeList (API v2, OAuth2 PKCE).

## Installazione (temporanea)
1. `about:debugging` → *Questo Firefox* → *Carica componente aggiuntivo temporaneo…* → `manifest.json`.
2. Crea un'app su https://myanimelist.net/apiconfig (App Type: **other**).
3. Registra come Redirect URL quello mostrato nel popup (Impostazioni), poi incolla il Client ID e fai Login.

Per la sincronizzazione multi-dispositivo abilita "Componenti aggiuntivi" in Firefox Sync.
