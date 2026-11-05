# Installare l'estensione su tutti i browser

Un componente aggiuntivo caricato da `about:debugging` è **temporaneo**: sparisce a ogni riavvio di Firefox.
Per installarlo in modo permanente, Firefox (versione stabile) richiede un file `.xpi` **firmato da Mozilla**.

## Opzione consigliata: firma "unlisted" su AMO

"Unlisted" significa che Mozilla firma il file ma **non** lo pubblica nello store pubblico.
La firma è automatica e arriva in pochi minuti. Lo installi una volta per browser e da lì si aggiorna da solo.

1. **Chiavi API**: generale su <https://addons.mozilla.org/developers/addon/api/key/> (serve un account Firefox).
2. **Firma**, dalla cartella del progetto:
   ```bash
   npx web-ext sign --channel=unlisted \
     --api-key=TUA_JWT_ISSUER --api-secret=TUO_JWT_SECRET
   ```
   Il file `.xpi` firmato finisce in `web-ext-artifacts/`.
3. **Pubblicazione**: carica il `.xpi` in una **GitHub Release** di questo repository.
4. **Installazione**: in ogni browser apri il link al `.xpi`; Firefox chiede di installarlo. Va fatto una sola volta.
5. **Aggiornamenti automatici**: aggiungi `update_url` nel manifest, puntato a un file `updates.json` ospitato nel repo:
   ```json
   "browser_specific_settings": {
     "gecko": {
       "id": "animesaturn-tracker@local.ext",
       "update_url": "https://raw.githubusercontent.com/Olly06/estensioneAnimeSaturn/main/updates.json"
     }
   }
   ```
   Esempio di `updates.json`:
   ```json
   {
     "addons": {
       "animesaturn-tracker@local.ext": {
         "updates": [
           {
             "version": "1.0.0",
             "update_link": "https://github.com/Olly06/estensioneAnimeSaturn/releases/download/v1.0.0/animesaturn-tracker-1.0.0.xpi"
           }
         ]
       }
     }
   }
   ```
   A ogni nuova versione: aumenta `version` nel manifest, firma, carica la Release e aggiungi una voce in `updates.json`.

### Da sapere
- **Repo privato**: per scaricare il `.xpi` e `updates.json` senza login, il repository deve essere **pubblico**,
  oppure i file vanno ospitati altrove (per esempio su GitHub Pages).
- **Campo obbligatorio**: AMO ora richiede nel manifest `browser_specific_settings.gecko.data_collection_permissions`;
  senza quel campo la firma viene rifiutata.
- **Redirect URL MAL**: l'ID dell'estensione resta lo stesso, quindi il Redirect URL registrato su MyAnimeList continua a funzionare.

## Alternative e limiti

- **Pubblicazione nello store AMO ("listed")**: è l'unico modo in cui Firefox Sync installa l'estensione da solo
  su tutti i browser (con l'opzione "Componenti aggiuntivi" attiva). Però passa per una revisione di Mozilla,
  e un'estensione legata a un sito di streaming non ufficiale rischia di essere rifiutata.
- **Firefox Developer Edition o Nightly**: lì si può impostare `xpinstall.signatures.required = false` in `about:config`
  e installare il `.xpi` senza firma. Nella versione stabile di Firefox quell'impostazione non funziona.

## Automazione possibile

Un workflow GitHub Actions può firmare l'estensione e creare la Release a ogni tag `v1.x`,
usando le chiavi API salvate nei **Secrets** del repository (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET`).
