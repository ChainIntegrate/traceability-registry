# Audit privacy, sicurezza e bug — settembre 2026

Revisione di contratti (`contracts/`), backend (`backend/`) e frontend
(`frontend/`) sul codice di `main` al 28/09/2026 (dopo la PR #7). Ogni punto
indica gravità, stato e dove è stato risolto.

| # | Gravità | Area | Problema | Stato |
|---|---|---|---|---|
| 1 | 🔴 Alta | Frontend | XSS nell'esploratore pubblico da metadata dei token | ✅ Risolto (PR 1) |
| 2 | 🔴 Alta | Privacy | "Solo hash, il file resta privato" promesso ma non esistente | ⏳ Da decidere |
| 3 | 🟠 Media | Frontend | XSS nelle tabelle libreria foto/documenti (delegato → titolare) | ✅ Risolto (PR 1) |
| 4 | 🟠 Media | Contratto | Hash documento sovrascrivibile | ⏳ Da decidere prima del mainnet |
| 5 | 🟠 Media | Backend | Endpoint pubblici senza limiti, cache disattivata | ⏳ PR 2 |
| 6 | 🟠 Media | Frontend | Librerie da CDN, ERC725 senza versione fissata | ✅ Risolto (PR 1) |
| 7 | 🟡 Bassa | Backend | Indirizzo del registro non normalizzato nel database | ⏳ PR 2 |
| 8 | 🟡 Bassa | Backend | Ricaricare un elemento nascosto non lo rende visibile | ⏳ PR 2 |
| 9 | 🟡 Bassa | Backend | Firme delle liste nella query string (log) | ⏳ PR 2 |
| 10 | ℹ️ Info | Contratto | Token LSP8 trasferibili dal titolare | ⏳ Da decidere prima del mainnet |

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

## 2. Privacy dell'hash documento — 🔴 Alta — ⏳ Da decidere

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

**Opzioni.** (a) correggere guida e README; (b) aggiungere un vero percorso
"solo hash" (impronta calcolata nel browser, il file non esce mai dal
computer), mantenendo la libreria per i documenti da pubblicare.

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

## 5. Endpoint pubblici senza limiti — 🟠 Media — ⏳ PR 2

`/registry/:address/entries` e `/delegates` sono pubblici (per progetto) ma non
hanno limiti di frequenza, e `CHAIN_READ_CACHE_TTL_SECONDS` vale 0 di default:
ogni richiesta rilegge tutti gli eventi del registro dal nodo RPC più una lettura
per token. Chiunque, senza firma, può esaurire la quota della chiave RPC
dedicata. Proposta: cache attiva (es. 30 s) e limite per IP (express o nginx
`limit_req`).

## 6. Librerie da CDN — 🟠 Media — ✅ Risolto

**Problema.** ethers 5.7.2 caricato da jsdelivr in tutte le pagine (senza
SRI) ed ERC725.js importato da `cdn.jsdelivr.net/npm/@erc725/erc725.js/+esm`
**senza versione**: ogni nuova versione, anche compromessa, girava subito su
pagine collegate alla Universal Profile.

**Correzione.** Librerie servite dallo stesso dominio da `frontend/vendor/`
(dettagli, checksum e licenze in `frontend/vendor/README.md`):
`ethers-5.7.2.umd.min.js` (file npm invariato) ed `erc725-0.28.2.esm.min.js`
(bundle ESM della versione 0.28.2, quella servita dal CDN al momento
dell'audit). Il bundle produce, in Chromium, la stessa codifica LSP4Metadata
della libreria in Node. Tutte le pagine si caricano senza errori e senza
richieste a domini esterni. Nessun font esterno (le pagine usano `system-ui`).

**Deploy.** La cartella `frontend/vendor/` va pubblicata insieme alle pagine.

## 7. Indirizzo non normalizzato nel database — 🟡 Bassa — ⏳ PR 2

`registry_address` è salvato come arriva dal client. Un delegato che scrive
l'indirizzo in minuscolo vede la libreria vuota, carica in un archivio separato
e "nascondi" risponde 404 (confronto esatto). Proposta: normalizzare
(checksum) nel backend e migrare le righe esistenti.

## 8. Elemento nascosto e poi ricaricato — 🟡 Bassa — ⏳ PR 2

`insertPhoto`/`insertDocument` restituiscono il record esistente anche se
nascosto: l'utente vede "caricato" ma l'elemento non compare. Proposta:
renderlo di nuovo visibile al ricaricamento.

## 9. Firme nella query string — 🟡 Bassa — ⏳ PR 2

Le liste (`GET /photos`, `GET /documents`) passano firma e timestamp nell'URL:
finiscono nei log di accesso e restano riutilizzabili per 5 minuti.
Proposta: POST con firma nel corpo.

## 10. Token trasferibili — ℹ️ Info — ⏳ Prima del mainnet

I token LSP8 vengono coniati al titolare, che può trasferirli. I dati restano
nel registro, ma la proprietà del token può spostarsi (anche dopo un
`setRegistryAdmin`). Decidere la regola prima del mainnet.

---

## Cosa è già solido

- Autenticazione concentrata in `authGuard.verifySignedRequest`: firma SIWE
  verificata via ERC-1271, registro accettato solo se deployato dalla Factory,
  autorizzazione e membership controllate on-chain.
- Hash dei file ricalcolato lato server dai byte ricevuti.
- Permessi (membership, deleghe, Gold) applicati dal contratto, non solo dalla UI.
- Query SQL parametrizzate; errori verso il client generici; tipi di file
  limitati; `image-size` limitato ai parser png/jpg/webp (§55).
- CORS ristretto all'origin della UI sulle route firmate.
