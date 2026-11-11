# AnimeSaturn Tracker

Estensione per **Firefox e Chrome/Chromium** (Manifest V3) che traccia gli episodi visti su AnimeSaturn, li sincronizza tra i tuoi dispositivi e aggiorna la lista MyAnimeList (API v2, OAuth2 PKCE).

## Installazione per sviluppo

**Firefox** (121+): `about:debugging` → *Questo Firefox* → *Carica componente aggiuntivo temporaneo…* → `src/manifest.json`.

**Chrome / Edge / Brave**: `chrome://extensions` → attiva *Modalità sviluppatore* → *Carica estensione non pacchettizzata* → seleziona la cartella `src/`.

## Configurazione MyAnimeList
1. Crea un'app su https://myanimelist.net/apiconfig (App Type: **other**).
2. In *App Redirect URL* inserisci **entrambi** gli URL (uno per riga), così la stessa app funziona su tutti e due i browser:
   ```
   https://03dd6cc1990859252bd1a412c9b8a9356d73d68d.extensions.allizom.org/
   https://benghggecnglpgoelfmafldckmabgano.chromiumapp.org/
   ```
   Verifica che coincidano con quello mostrato nel popup (Impostazioni).
3. Incolla il Client ID nel popup e fai Login.

## Sincronizzazione
I dati usano `storage.sync`: si sincronizzano tra i Firefox (Firefox Sync, voce "Componenti aggiuntivi")
oppure tra i Chrome (Chrome Sync, voce "Estensioni"). **Non** si sincronizzano tra Firefox e Chrome:
per passare da uno all'altro usa Esporta/Importa JSON, oppure lascia che MAL faccia da riferimento comune.

## Note tecniche sulla compatibilità
- `src/lib/common.js` espone `chrome` come `browser` su Chromium (le API MV3 di Chrome restituiscono già Promise).
- Il manifest dichiara sia `background.scripts` (usato da Firefox) sia `background.service_worker` (`src/background/sw.js`, usato da Chrome).
- Il campo `key` del manifest fissa l'ID dell'estensione in Chrome, così il redirect URL è identico su ogni PC.

Per installarla in modo permanente su tutti i browser vedi [DISTRIBUZIONE.md](DISTRIBUZIONE.md).

## Struttura

```
src/
├── manifest.json
├── background/   # background.js (logica), sw.js (entry service worker Chrome)
├── content/      # content.js/css iniettati su AnimeSaturn
├── popup/        # popup.html/css/js (popup e pagina intera)
├── lib/          # common.js, mal_api.js (condivisi)
└── icons/
```
