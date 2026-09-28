# Audit privacy, sicurezza e bug — settembre 2026

Revisione di contratti (`contracts/`), backend (`backend/`) e frontend
(`frontend/`) sul codice di `main` al 28/09/2026 (dopo la PR #7). Ogni punto
indica gravità, stato e dove è stato risolto.

| # | Gravità | Area | Problema | Stato |
|---|---|---|---|---|
| 1 | 🔴 Alta | Frontend | XSS nell'esploratore pubblico da metadata dei token | ✅ Risolto (PR 1) |
| 2 | 🔴 Alta | Privacy | Documenti riservati in chiaro su IPFS ("il file resta privato" non vero) | ✅ Risolto: documenti cifrati |
| 3 | 🟠 Media | Frontend | XSS nelle tabelle libreria foto/documenti (delegato → titolare) | ✅ Risolto (PR 1) |
| 4 | 🟠 Media | Contratto | Hash documento sovrascrivibile | ⏳ Da decidere prima del mainnet |
| 5 | 🟠 Media | Backend | Endpoint pubblici senza limiti, cache disattivata | ✅ Risolto (PR 2) |
| 6 | 🟠 Media | Frontend | Librerie da CDN, ERC725 senza versione fissata | ✅ Risolto (PR 1) |
| 7 | 🟡 Bassa | Backend | Indirizzo del registro non normalizzato nel database | ✅ Risolto (PR 2) |
| 8 | 🟡 Bassa | Backend | Ricaricare un elemento nascosto non lo rende visibile | ✅ Risolto (PR 2) |
| 9 | 🟡 Bassa | Backend | Firme delle liste nella query string (log) | ✅ Risolto (PR 2) |
| 10 | ℹ️ Info | Contratto | Token LSP8 trasferibili dal titolare | ⏳ Da decidere prima del mainnet |
| 11 | 🟡 Bassa | Frontend | Nessuna intestazione di sicurezza (CSP, clickjacking) | 🟡 Fase 1 (PR 2): CSP in osservazione |

---

## 1. XSS nell'esploratore pubblico — 🔴 Alta — ✅ Risolto

**Problema.** `traceability-explorer-ui.js` inseriva nell'HTML dati presi dai
metadata dei token, che chi possiede un registro controlla per intero:
- l'URL dell'immagine finiva in `src='…'` senza controlli: un valore come
  `ipfs://x' onerror='…'` eseguiva codice **all'apertura della pagina**, senza
  interazione;
- `escapeHtml` (basata su `div.textContent`) non escapava gli apici, quindi i
  valori negli attributi (`data-value='…'` delle pillole filtro) potevano
  chiudere l'attributo e aggiungere gestori di evento.

**Impatto.** Chiunque abbia un registro (basta un cliente Bronze) o un suo
delegato poteva far girare codice su `traceability.chainintegrate.it` a chi apre
`explorer.html?registry=…`. È lo stesso dominio delle pagine private: il codice
può chiedere firme e transazioni alla Universal Profile della vittima, sotto il
nostro dominio.

**Correzione.**
- `TraceabilityDecode.escapeHtml` unica per tutto il frontend, escapa anche `"`
  e `'`; il modulo dell'esploratore la usa al posto della vecchia.
- `ipfsToHttp` accetta solo un CID valido (lettere e cifre, 46–100 caratteri,
  più eventuale percorso di caratteri sicuri); altrimenti restituisce `null` e
  l'immagine non viene mostrata. `decodeMetadataValue` rifiuta un riferimento
  non valido.
- Escape anche sugli URL già validati e sui tokenId (difesa in profondità).

**Verifica.** Test in Chromium sull'`explorer.html` reale, servito in HTTP, con
backend e gateway IPFS simulati e un registro con metadata malevoli (nome, descrizione,
immagini del token e della collezione, attributi, lotto), più hover, focus e click
su ogni elemento. Prima della correzione eseguivano codice 4 vettori distinti
(immagine della collezione, immagine della card, pillola "Lotto", attributo); dopo, nessuno.
Le card vengono comunque mostrate, con il testo malevolo come testo semplice.

## 2. Privacy dell'hash documento — 🔴 Alta — ✅ Risolto (documenti cifrati)

**Problema.** La guida (`how-it-works.html`, "Registrare l'hash di un documento
senza caricarlo") e il README promettono che per i documenti riservati si
registra solo l'hash e il file resta sul computer dell'azienda. Nel codice
questo percorso **non esiste**: sia il pulsante "Registra hash documento" sulle
card sia le select dei moduli di registrazione prendono il documento dalla
libreria documenti, che viene caricata su IPFS pubblico. Un'azienda che
registra l'hash di una fattura credendola privata l'ha in realtà pubblicata
(e un file su IPFS è di fatto permanente).

**Origine.** In §46–§47 dello storico il file scelto a mano è stato sostituito
dalla libreria, per evitare hash "verificabili ma irrecuperabili"; i testi
rivolti all'utente non sono stati aggiornati.

**Valutazione con il titolare del progetto.** La libreria esiste per un
motivo valido: l'impronta on-chain riguarda i byte esatti del file (un PDF
riesportato ha un'impronta diversa), quindi il file originale va conservato.
Il download era già solo lato privato e il CID non compare mai pubblicamente.
Il punto debole era la sola segretezza del CID: circola tra i delegati e nei
link, il nodo lo annuncia alla rete, e il gateway pubblico serve il file a
chiunque lo abbia; una volta uscito non si ritira.

**Correzione: documenti cifrati su IPFS** (`backend/documentCrypto.js`).
- All'upload il backend calcola l'impronta del file originale (come prima) e
  lo **cifra** prima del pin: AES-256-GCM con una chiave per documento, chiusa
  con una chiave madre (`DOCUMENT_MASTER_KEY`) e salvata dentro il file cifrato.
  Su IPFS c'è solo una versione illeggibile.
- Download solo con firma, dalla pagina privata (`POST /documents/:id/download`):
  il backend rilegge il file dal proprio nodo, lo decifra, **verifica che
  l'impronta coincida con quella registrata** e restituisce il PDF originale
  byte per byte. Non richiede membership attiva (un'azienda sospesa recupera i
  propri documenti). La firma viaggia nel corpo, non nell'URL.
- Senza chiave madre configurata gli upload di documenti vengono rifiutati: mai
  un ripiego silenzioso sul caricamento in chiaro.
- Documenti vecchi (in chiaro): ancora scaricabili; ricaricarli li sostituisce
  con la versione cifrata; `scripts/list-plaintext-documents.js` li elenca per
  toglierli dal nodo.
- Recupero senza database con la sola chiave madre
  (`scripts/decrypt-document.js`); backup del database (`scripts/backup-db.js`).
  Custodia della chiave e procedure: [`CHIAVE-DOCUMENTI.md`](CHIAVE-DOCUMENTI.md).
- Guida e README riscritti: foto pubbliche per scelta, documenti cifrati, e
  detto chiaramente che la cifratura protegge dagli estranei, non da
  ChainIntegrate (che custodisce la chiave).

**Dati già caricati.** I documenti rimasti in chiaro su IPFS dal periodo
precedente sono **dati di prova su testnet, con contenuti non reali** (per
esempio un certificato d'esempio): nessun dato riservato è stato esposto. La
loro migrazione (`scripts/list-plaintext-documents.js`, ricarica, `ipfs pin rm`)
è facoltativa. Verificato dal vivo il 28/09/2026 che un documento nuovo è
illeggibile dal gateway pubblico e recuperabile con la sola chiave madre.

**Verifica.** `scripts/test-document-encryption.js`, 14 controlli: round-trip
su file da 0 byte a 5 MB, alterazione di un byte in qualunque punto rilevata,
chiave sbagliata rifiutata, messaggio firmato identico tra frontend e backend;
percorso completo sulle route vere con un nodo IPFS simulato (su IPFS solo
dati cifrati, download identico byte per byte con nome e tipo, registro
sbagliato 404, file alterato rifiutato, documento vecchio scaricabile e
migrato al ricaricamento, senza chiave nessun upload in chiaro).

## 3. XSS nelle tabelle delle librerie — 🟠 Media — ✅ Risolto

**Problema.** Nelle pagine `user-*.html` etichetta, CID e nome originale di
foto e documenti andavano in `innerHTML` senza escape. Le etichette le scrive
chi carica il file: un delegato poteva colpire il titolare del registro. Stesso
difetto, a rischio minore, nell'anteprima dei file importati (dati dal
gestionale), nella tabella di corrispondenza dei lotti, negli errori di
validazione del file e nella lista delle deleghe.

**Correzione.** In ogni pagina `const esc = TraceabilityDecode.escapeHtml` e
escape di tutti questi valori; `id` delle righe forzati a numero; link di
download mostrati solo se il CID è valido.

## 4. Hash documento sovrascrivibile — 🟠 Media — ⏳ Prima del mainnet

`_setDocumentHash` scrive senza controllare se un hash esiste già: solo
l'interfaccia lo impedisce. Un titolare Gold può sostituirlo in seguito;
l'esploratore mostra solo l'ultimo valore (lo storico resta negli eventi
`DocumentHashSet`). Proposta: rendere l'hash scrivibile una sola volta nel
contratto (o mostrare lo storico). È una modifica al contratto: va fatta
**prima del deploy su mainnet**, dopo non è più possibile.

## 5. Endpoint pubblici senza limiti — 🟠 Media — ✅ Risolto (PR 2)

**Problema.** `/registry/:address/entries` e `/delegates` sono pubblici (per
progetto) ma non avevano limiti, e la cache era disattivata di default: ogni
richiesta rileggeva tutti gli eventi del registro dal nodo RPC più una lettura
per token. Chiunque, senza firma, poteva esaurire la quota della chiave RPC.

**Correzione.**
- **Cache legata al blocco** (`chainReadCache.getForBlock`): il risultato vale
  finché non arriva un blocco nuovo. Una cache a tempo avrebbe mostrato dati
  vecchi subito dopo una registrazione; così invece i dati sono sempre
  aggiornati all'ultimo blocco e la scansione si fa al massimo una volta per
  blocco e registro. Richieste contemporanee condividono lo stesso calcolo; il
  numero di blocco si rilegge al massimo ogni 2 secondi.
- **Verifica "registro della Factory" ricordata**: una risposta positiva vale per
  sempre (un registro resta tale), e risparmia una chiamata RPC a ogni
  richiesta, firmate comprese.
- **Limite per IP** (`rateLimit.js`): 120 richieste/minuto per la lettura
  pubblica, 60 per le route firmate (anche una firma non valida costa verifiche
  on-chain); configurabili, 429 con `Retry-After`. `trust proxy` su loopback
  perché l'IP sia quello del client dietro nginx. Messaggio 429 tradotto.

## 6. Librerie da CDN — 🟠 Media — ✅ Risolto

**Problema.** ethers 5.7.2 caricato da jsdelivr in tutte le pagine (senza
SRI) ed ERC725.js importato da `cdn.jsdelivr.net/npm/@erc725/erc725.js/+esm`
**senza versione**: ogni nuova versione, anche compromessa, girava subito su
pagine collegate alla Universal Profile.

**Correzione.** Le pagine usano il repository condiviso
[`ChainIntegrate/shared-assets`](https://github.com/ChainIntegrate/shared-assets),
servito da nginx sotto `/shared/` sullo stesso dominio (versioni fissate,
cartelle immutabili, `SHA256SUMS`):
- `/shared/ethers/5.7.2/ethers.umd.min.js`: aggiunto a shared-assets per questo
  progetto ([shared-assets#1](https://github.com/ChainIntegrate/shared-assets/pull/1)),
  file npm invariato. La migrazione a ethers v6 (già presente in shared-assets)
  è un lavoro a parte: cambia le API in frontend e backend.
- `/shared/erc725.js/0.28.2/erc725.min.js`: già presente, stessa versione che il
  CDN serviva al momento dell'audit. Verificato in Chromium: produce la stessa
  codifica LSP4Metadata della libreria in Node.

Con un server che replica la configurazione nginx, tutte le pagine si caricano
senza errori e senza richieste a domini esterni. Nessun font esterno (le
pagine usano `system-ui`; i font IBM Plex di shared-assets restano disponibili
se si vorrà uniformare lo stile agli altri progetti).

**Deploy.** Prima, sul VPS: `git pull` di `/var/www/shared-assets` (con
ethers 5.7.2) e, nel blocco `server` nginx di traceability, la riga
`include /var/www/shared-assets/nginx/shared-assets.conf;` (poi `nginx -t` e
reload). Senza, le pagine non trovano ethers.

## 7. Indirizzo non normalizzato nel database — 🟡 Bassa — ✅ Risolto (PR 2)

`registry_address` era salvato come arrivava dal client: un delegato che
scriveva l'indirizzo in minuscolo vedeva la libreria vuota, caricava in un
archivio separato e "nascondi" rispondeva 404. Ora tutte le funzioni di
`db.js` usano la forma canonica (checksum) da sole, i confronti nelle route
pure, e la pagina normalizza l'indirizzo quando si sceglie il registro. Una
migrazione automatica all'avvio sistema le righe esistenti; se due righe
diventano uguali tiene quella cifrata (documenti) o la più vecchia, e resta
visibile se almeno una lo era.

## 8. Elemento nascosto e poi ricaricato — 🟡 Bassa — ✅ Risolto (PR 2)

`insertPhoto`/`insertDocument` restituivano il record esistente anche se
nascosto: l'utente vedeva "caricato" ma l'elemento non compariva. Ora
ricaricarlo lo rende di nuovo visibile.

## 9. Firme nella query string — 🟡 Bassa — ✅ Risolto (PR 2)

Le liste passavano firma e timestamp nell'URL (`GET /photos`, `GET /documents`),
che finisce nei log di accesso e resta riutilizzabile per 5 minuti. Ora le
pagine usano `POST /photos/list` e `POST /documents/list` con la firma nel
corpo. I GET restano temporaneamente per le pagine ancora in cache nel
browser: **da togliere** in una prossima versione.

## 10. Token trasferibili — ℹ️ Info — ⏳ Prima del mainnet

I token LSP8 vengono coniati al titolare, che può trasferirli. I dati restano
nel registro, ma la proprietà del token può spostarsi (anche dopo un
`setRegistryAdmin`). Decidere la regola prima del mainnet.

---

## 11. Intestazioni di sicurezza — 🟡 Bassa — 🟡 Fase 1 (PR 2)

Nessuna intestazione di sicurezza sulle pagine. Ora `nginx/security-headers.conf`
(da includere nel blocco `server` di traceability):
- **Incorporamento**: l'esploratore resta incorporabile ovunque (è pensato per
  un `<iframe>` sui siti dei clienti); pagine private, admin e guida solo dal
  nostro dominio (`X-Frame-Options` + `frame-ancestors`).
- `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- **Content-Security-Policy**: script solo dal nostro dominio, e soprattutto
  `connect-src` limitato a backend e gateway IPFS nostri (un codice iniettato
  non può spedire dati altrove). `'unsafe-inline'` resta necessario finché le
  pagine hanno script e `onclick` nel codice HTML.

**Fase 1 = `Report-Only`**: la CSP non blocca, segnala nella console. Motivo: la
UP extension inserisce il proprio codice nella pagina e non si può provare qui.
Verificato in Chromium con la CSP **bloccante**: nessuna violazione su tutte le
pagine, esploratore con metadata e immagini IPFS, test XSS e download
documenti funzionanti. **Fase 2**: dopo la prova con la UP collegata, passare a
`Content-Security-Policy` (una parola nel file). Configurazione validata con
`nginx -t` e intestazioni controllate su un nginx locale.

## Cosa è già solido

- Autenticazione concentrata in `authGuard.verifySignedRequest`: firma SIWE
  verificata via ERC-1271, registro accettato solo se deployato dalla Factory,
  autorizzazione e membership controllate on-chain.
- Hash dei file ricalcolato lato server dai byte ricevuti.
- Permessi (membership, deleghe, Gold) applicati dal contratto, non solo dalla UI.
- Query SQL parametrizzate; errori verso il client generici; tipi di file
  limitati; `image-size` limitato ai parser png/jpg/webp (§55).
- CORS ristretto all'origin della UI sulle route firmate.
