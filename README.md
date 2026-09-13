# TraceabilityRegistry — ChainIntegrate

Prodotto di tracciabilità multi-azienda, ispirato al Supplier Trust Registry
ma con architettura diversa perché il problema è diverso: non un'autorità che
attesta su tanti soggetti, ma tante aziende autonome che operano ciascuna nel
proprio spazio isolato. Caso pilota: Birra20Venti (sostituisce l'attuale
sistema ERC-721 di `Materie_Prime.html`/`Batch.html`), pensato fin dall'inizio
per essere offerto anche ad altre aziende.

Stato: **Factory deployata e verificata su testnet**
([`0xA57527bE3AaDF4F1A60AF9829BaCA0949DAce315`](https://explorer.execution.testnet.lukso.network/address/0xA57527bE3AaDF4F1A60AF9829BaCA0949DAce315) —
sorgente pubblicata su Blockscout, verificabile da chiunque). Non ancora
deployata su mainnet, non ancora deployato nessun `TraceabilityRegistry` di
singola azienda (serve una UP con Membership Corporate almeno Bronze che
chiami `Factory.deployRegistry()`). Repo:
[github.com/ChainIntegrate/traceability-registry](https://github.com/ChainIntegrate/traceability-registry)
(pubblico, licenza All Rights Reserved — codice visibile per trasparenza,
nessun permesso di riuso). Questo documento è il riferimento per riprendere
il lavoro senza dover rileggere tutta la chat.

---

## 1. Perché questa architettura (non quella del Supplier Trust Registry)

| | Supplier Trust Registry | TraceabilityRegistry |
|---|---|---|
| Contratti | 1 condiviso | N, uno per azienda (via Factory) |
| TokenId per azienda | 1 (self-mint, "accoglie" valutazioni) | molti (lotti + batch), non sequenziali |
| Isolamento tra aziende | logico (tokenId diversi, stesso spazio) | fisico (indirizzo di contratto diverso) |

Un'azienda ha *un* tokenId di fiducia da mantenere nel tempo, ma potenzialmente
centinaia di lotti/batch — un contratto dedicato dà spazio, storia e indirizzo
propri senza affollare uno spazio condiviso.

## 2. I due contratti

### `TraceabilityRegistryFactory`
Un solo contratto, deployato una volta da ChainIntegrate. Compito: deployare
un `TraceabilityRegistry` dedicato per ogni azienda che lo richiede.

- `deployRegistry(name, symbol)` — chiunque abbia `tierOf(msg.sender) != 0` su
  Membership Corporate (quindi almeno Bronze) può chiamarla. Deploya il
  contratto passando `chainIntegrateOwner` (fisso) e `msg.sender` (l'azienda)
  come `registryAdmin`.
- **Limite registri per tier** (stesso schema già in uso sul Supplier Trust
  Registry): Bronze 1, Silver 2, Gold 5 — `maxRegistriesForTier(tier)`,
  controllato live ad ogni deploy. Nessuna retroattività: se un'azienda scende
  di tier dopo aver già deployato più registri di quanti il nuovo tier
  permetta, quelli esistenti restano validi — semplicemente non può
  deployarne di nuovi finché non risale (stessa filosofia già applicata alle
  deleghe).
- `registriesOf[azienda] => address[]` — tutti i registry di un'azienda,
  `registryCountOf`/`getRegistries` per letture comode lato UI.
- `allRegistries[]` — array enumerabile, pronto per una directory pubblica o
  un indexer futuro.

### `TraceabilityRegistry` (una istanza per azienda)
LSP8, due tipi di entry nella stessa collezione, distinti da una data key
custom `ENTRY_TYPE_KEY`: `RawMaterialLot` (0) e `ProductionBatch` (1).

**Modello di permessi** (owner ≠ chi opera, principio già in uso su altri
progetti ChainIntegrate):

- `owner()` = ChainIntegrate UP — branding/creator della collezione (quello
  che vedi su universaleverything.io), gestione emergenza (`setRegistryAdmin`),
  può sempre gestire le deleghe.
- `registryAdmin` = UP dell'azienda — mint di lotti/batch, metadata della
  *propria* collezione (`setRegistryMetadata`), può delegare ad altri UP **se
  e solo se** il proprio tier Membership Corporate è ≥ Silver (controllato
  live ad ogni chiamata, non in cache — se scende sotto Silver non può
  aggiungerne di nuovi, ma le deleghe già concesse restano valide).
- `delegates[indirizzo] => bool` — altri UP autorizzati a mintare per conto
  dell'azienda, aggiunti/rimossi da `registryAdmin` (con Silver) o da
  ChainIntegrate.

**Granularità del mint — importante**: un `RawMaterialLot` corrisponde a UNA
riga dell'array `materie_prime[]` nel JSON di acquisto, non all'intero JSON.
Il JSON di acquisto Pinta (20 materiali) produce 20 token separati, non 1 —
altrimenti `UsedLots` (sotto) non potrebbe puntare al singolo ingrediente
usato in un batch. `tokenId` = hash di `fornitore + nome ingrediente + lotto`
(non solo il lotto, che potrebbe ripetersi tra fornitori diversi).

**Collegamento lotto → batch, reale non testuale**: `mintProductionBatch`
accetta `usedLotTokenIds[]`, un array di tokenId di `RawMaterialLot` già
esistenti. Il contratto verifica che ognuno esista, sia davvero un
`RawMaterialLot` e non sia invalidato. Lotti citati nel JSON del batch ma non
matchati (nome diverso non importa, ma il valore **lotto** deve combaciare
esatto — nessuna tolleranza) restano solo come testo nei metadata, senza
riferimento strutturato — gestito interamente lato UI con conferma esplicita
dell'utente prima del mint (mai un blocco automatico, mai un fallback silente).

**`indexDate`** (uint256, timestamp Unix) — parametro su ogni funzione di
mint. Serve per ordinare la visualizzazione senza affidarsi al timestamp di
mint (fragile: import massivi/storici falserebbero l'ordine) né a stringhe di
data in formati non uniformi. Se il JSON contiene più di un campo data
riconosciuto (es. batch con "Data Produzione" + "Data Imbottigliamento"), la
UI **deve sempre far scegliere esplicitamente l'utente** — mai un fallback
automatico "prendi la più recente".

**Invalidazione, mai burn**: `invalidateEntry(tokenId, motivazione)` — segna
uno stato (`EntryStatus.Invalidated`), non tocca i metadata originali (restano
leggibili, errore compreso, per trasparenza storica). A cascata,
`mintProductionBatch` rifiuta ogni nuovo riferimento a un lotto invalidato. I
batch che lo referenziavano da prima restano intatti (immutabilità = storia
vera); la UI, leggendo lo stato, dovrà mostrare un avviso in lettura.
Autorizzati: `registryAdmin`/delegato o ChainIntegrate.

**Hash documento (Gold)**: `setDocumentHash(tokenId, hash)` — solo l'hash
keccak256 on-chain, mai il file né il CID. Gated Gold (tier di `registryAdmin`,
non del delegato che chiama). Il file (es. fattura) sta sul nodo IPFS
ChainIntegrate ma **non referenziato** in nessun campo pubblico della
metadata — il CID resta privato nel backend, recuperabile solo via API
firmata ERC-1271 (stesso pattern già usato su MyCarBook) per chi è autorizzato
su quel registry, che lo scarica e ricalcola l'hash per confrontarlo con
quello on-chain.

**Foto**: nessuna gestione a contratto — libreria immagini lato UI/backend,
CID già pinnato riusato per chiave (es. nome ricetta per i batch, fornitore o
default per le materie prime), niente ri-upload ad ogni mint a meno di scelta
esplicita.

## 3. Schema JSON (fedele agli originali Birra20Venti)

File: `schemas/raw-material-purchase.schema.json`,
`schemas/production-batch.schema.json` — validazione strutturale di base
(JSON Schema draft-07). Le regole di business che JSON Schema non esprime
bene sono nel validatore JS.

### Acquisto materie prime
- `name`, `description` obbligatori.
- `attributes[]` deve contenere `Fornitore` e `Data Acquisto`.
- `materie_prime[]`: almeno 1 elemento. Per riga: `nome` e `quantità`
  obbligatori (tolleranza possibile in futuro sulla nomenclatura),
  **`lotto` obbligatorio e rigoroso — mai tollerante**, `data_scadenza`
  opzionale (anche stringa vuota).

### Batch di produzione
- `name`, `description` obbligatori.
- `attributes[]` deve contenere `Ricetta` (chiave per la libreria foto) e
  almeno una data tra quelle whitelisted (`Data Produzione`,
  `Data Imbottigliamento`).
- Convenzione: **qualunque** `trait_type` che inizia per `"Lotto "` è un
  candidato al matching automatico verso i `RawMaterialLot` già mintati
  (confermato coi dati reali: 8 trovati su Batch #131 senza logica ad hoc).

Il validatore (`frontend/traceability-json-validators.js`, vanilla JS, zero
dipendenze, stesso stile degli altri frontend ChainIntegrate) espone:

- `validateRawMaterialPurchaseJson(json)` / `validateProductionBatchJson(json)`
  → `{ valid, errors[], warnings[] }`.
- `extractRawMaterialPurchaseData(json)` → righe pronte per i tre array
  paralleli del mint batch.
- `extractProductionBatchData(json)` → ricetta, date candidate
  (`requiresDateSelection` se >1), riferimenti lotto estratti.

**Nota da un test sui dati reali**: il lotto "Pilsen (2-Row)" nel batch #131
(`M260100390`) e nell'acquisto Pinta del 09/07 (`M2601000390`) differiscono
di uno zero — con la regola di rigore sul lotto, questo matching fallirebbe
correttamente e finirebbe in "non trovato" nella schermata di conferma.
Prima prova concreta che la tolleranza-solo-sul-nome funziona come deciso.

## 4. Visualizzazione (deciso, non ancora implementato)

- **Nessun backend/indexer per ora** — lettura diretta dal browser, come le
  pagine Birra20Venti attuali, ma contro `rpc.chainintegrate.it` invece del
  nodo pubblico LUKSO.
- **Enumerazione via eventi**, non `tokenIdsOf`/loop su contatore: i tokenId
  non sono sequenziali (sono hash). `RawMaterialLotMinted`/
  `ProductionBatchMinted` letti via `eth_getLogs` a partire da
  `deployedAtBlock` (salvato on-chain al costruttore) danno l'elenco
  ordinato di tokenId senza costi extra di storage.
- **Ordinamento per `indexDate`**, non per data di mint né per stringhe.
- **Distribuzione come widget riusabile** (`<div data-registry="0x...">` +
  script unico ChainIntegrate) invece di un file HTML/JS copiaincollato per
  ogni cliente — manutenibile centralmente, embeddabile su siti terzi.
- **Piano B se il volume cresce**: indexer/cache dietro la stessa interfaccia
  dati, senza dover riscrivere il widget lato cliente.

## 5. UI di mint — due varianti, stesso dominio (proposta, da confermare)

1. Carica JSON e basta (il caso principale, usato per primo).
2. Form guidato che compila i campi e genera il JSON internamente.

Entrambe richiedono solo Bronze — nessuna differenziazione per tier proposta,
dato che il gate è identico. Consigliato: stesso dominio, due punti
d'ingresso, non due domini separati (meno superficie da mantenere). **Da
confermare**, decisione a basso rischio, rimandabile.

Prima del mint, in entrambi i casi: **anteprima obbligatoria** di cosa verrà
scritto in chain (stessa funzione di rendering usata poi dal widget pubblico,
per garantire coerenza tra anteprima e visualizzazione finale).

## 6. Calcolo tokenId e parsing date (`frontend/traceability-tokenid.js`)

Vanilla JS, richiede solo `ethers.js` v5 (stesso CDN già usato in
`Batch.html`), nessuna altra dipendenza.

- **`computeRawMaterialLotTokenId(registryAddress, fornitore, nomeIngrediente, lotto)`**
  → `keccak256(abi.encodePacked(registryAddress, "RML", fornitore, nomeIngrediente, lotto))`,
  identico a `solidityKeccak256` lato JS. L'indirizzo del registry è incluso
  come sale (isolamento extra, a costo zero); il prefisso `"RML"` separa lo
  spazio hash da quello dei batch, in aggiunta al controllo che il contratto
  fa già via `ENTRY_TYPE_KEY`. Testato su dati reali: 20/20 tokenId unici
  sui materiali dell'acquisto Pinta, idempotenza confermata (stesso input →
  stesso tokenId, il contratto rifiuta il doppio mint).
- **`computeProductionBatchTokenId(registryAddress, batchName)`** → stesso
  schema, usa il `name` del batch (es. "Batch #131") come identificativo
  naturale già assegnato dall'azienda.
- **`parseItalianDateToUnixSeconds(dateStr)`** → converte `DD/MM/YYYY` o
  `DD-MM-YYYY` in timestamp Unix per `indexDate`. Nessun fallback silenzioso:
  formato non riconosciuto = errore esplicito, mai una data indovinata.

## 7. Costruzione metadata LSP4 (`frontend/traceability-metadata.js`)

Puro JSON, nessuna chiamata di rete — testato sui JSON reali (primo
materiale Pinta, Batch #131), incluso il caso "nessuna foto in libreria
ancora" (icon/images vuoti, nessun crash).

- **`buildRawMaterialLotMetadata(lot, fornitore, dataAcquistoRaw, photoLibraryEntry)`**
  → un oggetto `LSP4Metadata` per riga di `materie_prime[]`. `name` generato
  come `"<nome> — Lotto <lotto>"` (non esisteva un nome a questo livello nel
  JSON originale, solo a livello di intero acquisto). Attributi: Nome, Lotto,
  Fornitore, Data Acquisto, Quantità, Data Scadenza.
- **`buildProductionBatchMetadata(originalBatchJson, photoLibraryEntry)`** →
  riusa `name`/`description`/`attributes` del JSON originale quasi as-is
  (le righe `"Lotto X"` restano in metadata per leggibilità, anche se il
  collegamento vero è ormai on-chain via `usedLotTokenIds`) — cambia solo
  l'immagine, presa dalla libreria.
- **`photoLibraryEntry`** atteso: `{ cid, keccak256Hash, width, height }` —
  l'hash va calcolato **una sola volta**, al primo upload dell'immagine (come
  da `lsp4-metadata-notes.md` §3), mai ricalcolato ad ogni mint.

## 8. Backend — `POST /api/traceability/pin-json` (`backend/`)

Nuovo servizio Express (`traceability-backend`), stesso stile degli altri
backend ChainIntegrate (PM2, `.env`, porta dedicata — proposta `3014` (3010-3013 già occupate da altri servizi), **da
confermare libera sul VPS Aruba**).

**Perché serve un backend e non solo lettura diretta**: la porta 5001 del
nodo IPFS ChainIntegrate è whitelistata solo all'IP Aruba — il pin deve per
forza passare da un servizio server-side lì ospitato.

**Verifica**, in ordine, prima di pinnare:

1. Validazione campi (`registryAddress`, `signerAddress`, `metadataJsonString`,
   `signature`, `timestamp`) — testata: tutti i rami rispondono `400`/`401`
   correttamente senza bisogno di rete.
2. **Freschezza della firma**: `timestamp` deve essere entro
   `MAX_SIGNATURE_AGE_SECONDS` (default 300s) da adesso — anti-replay.
3. **Verifica ERC-1271** (`erc1271.js`): una UP non firma come una EOA — si
   chiama `isValidSignature(hash, signature)` sul contratto della UP stessa,
   confrontando il ritorno con il magic value EIP-1271 (`0x1626ba7e`), non un
   semplice `ecrecover`.
4. **Autorizzazione on-chain**: chiama `isAuthorized(signerAddress)` **sul
   registry stesso** (funzione già esposta su `TraceabilityRegistry.sol`) —
   nessuna lista permessi duplicata lato backend, unica fonte di verità.
5. Solo a questo punto: pin su IPFS (`ipfsClient.js`, Kubo HTTP API,
   `POST /api/v0/add?pin=true`), risposta `{ cid }`.

**Messaggio firmato dalla UP** (`buildSignedMessage`, condiviso tra
frontend e backend — DEVONO produrre byte-per-byte lo stesso testo):
```
ChainIntegrate TraceabilityRegistry - Pin metadata
Registry: <registryAddress>
Content hash: <keccak256 del JSON>
Timestamp: <unix seconds>
```
Il JSON intero non viene mostrato nel messaggio (resterebbe illeggibile
nella UP extension) — solo il suo hash, che lega comunque la firma a un
contenuto esatto.

**Non testato in questa fase** (richiede un nodo RPC e una UP reali,
riproducibili solo su testnet): la verifica ERC-1271 vera e propria e la
chiamata `isAuthorized` end-to-end. Tutto il resto (validazione, messaggio,
sintassi) è testato.

## 9. Orchestrazione mint — parzialmente disegnata

Ora che il backend esiste, resta solo la parte puramente client-side da
scrivere (nessun altro componente mancante):

1. **UI**: costruisce la metadata (`traceability-metadata.js`) per ogni riga.
2. **UI → Backend** (`POST /api/traceability/pin-json`, **fatto**, §8):
   invia `{ registryAddress, signerAddress, metadataJsonString, signature, timestamp }`
   — la UP firma `buildSignedMessage(...)` via `personal_sign`. Risposta: `{ cid }`.
3. **UI**: con CID ricevuto, usa `erc725.js` (`ERC725.encodeData(...)`, vedi
   `lsp4-metadata-notes.md` §4) per ottenere il valore `VerifiableURI`
   codificato — questo passo NON richiede backend, `encodeData` calcola da
   solo l'hash del JSON per il wrapper.
4. **UI**: compone i tre array paralleli (`tokenIds[]`,
   `lsp4MetadataValues[]` = i valori VerifiableURI, `indexDates[]`) — un
   elemento per riga, stesso ordine, stessa posizione.
5. **UI**: firma e invia `mintRawMaterialLotBatch(...)` /
   `mintProductionBatch(...)` con la UP connessa.

Resta da scrivere solo lo script che lega i punti 1, 3, 4 insieme
(`traceability-mint-compose.js`, non ancora scritto) — il punto 2 è ora
pronto e testato quanto possibile senza un nodo live.

## 9. Orchestrazione mint — completata (`frontend/traceability-mint-compose.js`)

Lega insieme tutti i pezzi precedenti. Testato quanto possibile senza un
nodo live:

- **`buildSignedMessage`** duplicato qui (frontend) e in `backend/traceabilityRoutes.js`
  — **verificato che producano byte-per-byte lo stesso messaggio** (test
  diretto backend vs frontend, stesso input). Se uno dei due cambia senza
  l'altro, questo stesso confronto lo scoprirebbe. Candidato futuro a
  diventare un unico file condiviso invece di due copie mantenute a mano.
- **`encodeLsp4MetadataValue`** — usa `erc725.js` reale (non simulato):
  testato codificando la metadata vera del primo materiale dell'acquisto
  Pinta in un `VerifiableURI` valido (75 byte, formato corretto), pronto
  così com'è per essere passato al mint.
- **`pinMetadataToIpfs`** — firma con la UP (`signer.signMessage`, apre
  l'extension) e chiama il backend §8. Non testabile end-to-end senza UP e
  nodo reali.
- **`composeRawMaterialLotBatchMintArgs`** — da un JSON acquisto validato,
  produce i tre array pronti per `mintRawMaterialLotBatch`: un giro per
  lotto (validazione → metadata → pin → encode → tokenId), stessa
  `indexDate` per tutti (unica a livello di acquisto).
- **`composeProductionBatchMintArgs`** — un solo batch per chiamata (a
  differenza dei lotti, un batch non si importa mai in gruppo). Riceve
  `usedLotTokenIds` già risolto da un passo separato (matching + conferma
  utente, non ancora scritto — fa parte della UI, §5).

Con questo, **tutta la logica non-UI del sistema è scritta e testata sui
dati reali di Birra20Venti**. Manca solo l'interfaccia grafica che guida
l'utente attraverso questi passaggi (upload/compilazione, conferma matching,
scelta data, anteprima, firma) — nessun altro pezzo di logica mancante.

## 11. Libreria foto — `POST /api/traceability/upload-photo` + `GET /api/traceability/photos`

Stesso schema di sicurezza di `pin-json` (§8): firma ERC-1271 verificata
server-side, poi `isAuthorized(signerAddress)` controllato **on-chain**, mai
una lista permessi propria. Aggiunge SQLite (`db.js`, `better-sqlite3`) per
la libreria vera e propria — una tabella `photos`, isolata per
`registry_address` (stessa filosofia di isolamento del resto del sistema).

- **`POST /upload-photo`** (multipart, campo `file` + `registryAddress`,
  `signerAddress`, `label`, `signature`, `timestamp`): l'hash del contenuto
  usato per verificare la firma è **ricalcolato dai byte ricevuti**, mai
  fidandosi di un hash dichiarato dal client — stessa disciplina di
  `pin-json`. Determina le dimensioni dell'immagine server-side
  (`image-size`) invece di fidarsi del client. Pinna su IPFS
  (`pinFileToIpfs`, `ipfsClient.js` generalizzato per accettare qualunque
  buffer, non solo JSON) e salva `{ label, cid, hash, width, height, ... }`
  nel database.
- **`GET /photos`** (query string: `registryAddress`, `signerAddress`,
  `signature`, `timestamp`) — **NON pubblica**: richiede la stessa
  verifica firma+autorizzazione dell'upload. Correzione fatta durante lo
  sviluppo: la libreria può contenere immagini caricate ma non ancora usate
  in nessun mint pubblico, quindi resta visibile solo a chi è autorizzato su
  quel registry — diverso dai dati già mintati (§9), che restano pubblici
  per design. Verificato con test: la route ora richiede davvero firma e
  timestamp, non solo `registryAddress`.

**Bug trovato e corretto durante il test**: l'ordinamento iniziale
(`ORDER BY created_at DESC`) non garantiva un ordine stabile tra due upload
avvenuti nello stesso secondo (risoluzione del timestamp). Corretto
aggiungendo `id DESC` come criterio secondario — riverificato con un test
che inserisce due foto nello stesso secondo.

**Non ancora costruito**: il pezzo frontend che chiama questi due endpoint
(selezione/upload nella UI) — fa parte della UI di mint (§5), non ancora scritta.

## 12. Lettura on-chain — `GET /api/traceability/registry/:address/entries`

Corregge il problema segnalato al punto precedente (§13 vecchia numerazione):
`rpc.chainintegrate.it` non è un dominio pubblico, ogni lettura on-chain deve
passare dal backend, mai dal browser direttamente. Questo endpoint è
**pubblico** (nessuna firma) — a differenza della libreria foto, i dati già
mintati sono per design verificabili da chiunque.

- **Enumerazione via eventi**, non `tokenIdsOf`/loop su contatore (i tokenId
  sono hash, non sequenziali): `RawMaterialLotMinted`, `ProductionBatchMinted`,
  `EntryInvalidated`, letti via `queryFilter` da `deployedAtBlock` in poi.
- **`mergeEntries`** (logica pura, separata dalla route per essere testabile
  senza un nodo RPC vero) — testata con eventi finti ma nella forma esatta
  che ethers produce: ordina per `indexDate` decrescente, applica lo stato
  invalidato al tokenId giusto, preserva `usedLots` sui batch, distingue
  `entryType`. Tutti i casi verificati con successo.
- Per ogni entry, recupera anche la metadata grezza (`getDataForTokenId`,
  bytes `VerifiableURI`) — **la decodifica (CID + hash, poi fetch dal
  gateway IPFS pubblico) resta lato client**, stessa logica già scritta in
  `traceability-mint-compose.js` per l'encoding: non duplicata anche qui.

Serve a due consumatori diversi con la stessa risposta:
1. Il futuro widget di visualizzazione pubblica.
2. La UI di mint, per il matching automatico lotto→tokenId (letture, non
   scritture — nessuna firma necessaria neanche lì).

**Non ancora costruito**: il widget stesso (decodifica client-side del
`metadataValue` + fetch dal gateway IPFS + rendering) — la fonte dati che gli
serve ora esiste ed è testata.

## 14. Revisione di sicurezza/robustezza del backend — criticità trovate e corrette

Revisione approfondita di tutto il backend (non solo "il codice fa quello
che dice" — verificato anche coi test — ma "la logica è quella giusta").
Tutte le correzioni sotto sono state applicate e, dove possibile senza un
nodo RPC/UP reali, testate.

**🔴 Critiche:**
- **Formato firma ERC-1271 mai verificato contro una UP reale.**
  `erc1271.js` assume `ethers.utils.hashMessage` (EIP-191 standard) — la
  scelta più ragionevole, ma non testata contro `LSP0ERC725Account` vero.
  Aggiunto `scripts/test-erc1271-live.js`: **da eseguire su testnet con una
  UP reale prima di qualunque deploy in produzione** — se il formato non
  combacia, ogni firma verrebbe rifiutata sempre, silenziosamente.
- **Errori multer non gestiti.** Un file troppo grande falliva *prima* del
  nostro handler, finendo nella pagina HTML di errore di Express invece che
  in JSON pulito. Aggiunto `handleMulterError` come middleware dedicato.
  **Verificato con una vera richiesta HTTP multipart da 9MB**: ora torna
  `413` JSON, non più HTML.
- **`registryAddress` mai verificato come legittimo.** Chiunque poteva
  deployare un proprio contratto con `isAuthorized()` che ritorna sempre
  `true` e usare gratis il nostro IPFS/RPC. Aggiunta `isRegistry` mapping
  alla Factory (**modifica al contratto**, `contracts/TraceabilityRegistryFactory.sol`)
  e `verifyRegistryIsKnown()` in `authGuard.js`, applicata a **tutte e
  quattro** le route (non solo quelle firmate — anche la lettura pubblica,
  perché l'abuso del nodo RPC è un rischio anche lì). Verificato con test
  HTTP reale: registry sconosciuto → `403` prima di qualunque chiamata on-chain.

**🟠 Importanti:**
- **Upload foto duplicati** in caso di doppio click/retry. `db.js`: vincolo
  `UNIQUE(registry_address, keccak256_hash)`, `insertPhoto` ora idempotente
  (ritorna il record esistente invece di duplicare). **Testato**: stesso
  hash → stesso id ritornato, nessuna riga aggiuntiva; hash diverso → riga
  nuova, non deduplicato.
- **CORS assente ovunque.** `server.js`: due politiche distinte — lettura
  pubblica (`/registry/*`) permissiva per l'embed su siti terzi, route
  firmate (`pin-json`, `upload-photo`, `photos`) ristrette a
  `ALLOWED_MINT_UI_ORIGIN` (nuova variabile `.env`).

**🟡 Da tenere d'occhio:**
- **Logica di verifica copiata tre volte** (causa diretta del bug della
  scorsa volta: `GET /photos` partita senza controllo). Estratta in
  `authGuard.js`, un solo punto ora usato da tutte e tre le route firmate.
  **Testato**: tutti i rami (registry sconosciuto, timestamp scaduto, firma
  non verificabile) rispondono nell'ordine giusto — il timestamp è
  controllato **prima** di toccare la Factory, confermato con un mock che
  avrebbe lanciato un errore se chiamato fuori ordine.
- **Nessuna cache sulle letture on-chain.** Aggiunta `chainReadCache.js`,
  TTL in-memory, **disattivata di default** (`CHAIN_READ_CACHE_TTL_SECONDS=0`)
  — pensata per essere attivata con una sola variabile d'ambiente quando il
  volume lo richiederà, senza toccare il resto del codice. **Testata**:
  presenza, scadenza reale dopo il TTL, disattivazione con TTL=0.
- **`eth_getLogs` senza limite di range.** Aggiunto `blockChunks.js`
  (`computeBlockChunks`/`chunkedQueryFilter`), configurabile via
  `MAX_BLOCK_RANGE_PER_CALL`. **Testato**: copertura esatta su 25.001
  blocchi, nessun buco né sovrapposizione tra chunk.

**🟢 Minori:**
- Messaggi di errore verso il client ora generici (`"Verifica firma non
  riuscita."`), il dettaglio resta solo nei log server-side — verificato nel
  test di `authGuard.js`.
- Allowlist MIME (`image/png`, `image/jpeg`, `image/webp` — niente SVG, può
  contenere script). **Testato**: upload SVG → `415`.
- Limite lunghezza `label` (200 caratteri). **Testato**: label da 250
  caratteri → `400`.
- Timeout esplicito sulle chiamate IPFS (`IPFS_TIMEOUT_MS`, default 15s).
  **Testato con un server reale che non risponde mai**: la chiamata non
  resta appesa, fallisce dopo il tempo configurato.
- **"Nascondere" una foto** senza cancellarla — `hidePhoto()` +
  `POST /photos/:id/hide` (firmata), simmetrico a `invalidateEntry`
  on-chain. **Testato**: nascosta esclusa dalla lista normale, visibile con
  `includeHidden`, record non cancellato.
- `.gitignore` per il backend (`.env`, `*.db`, `node_modules/`) — poi
  consolidato in un unico `.gitignore` alla radice del repo (copre anche
  `contracts/`/Hardhat quando arriverà), il file dentro `backend/` è
  ridondante ma innocuo se resta.
- **Regola d'oro sulla chiave RPC**: annotata in `.env.example` — una API
  key dedicata a questo servizio, mai riusata da MatchPredictor o altri
  backend, per isolare monitoraggio e impatto di eventuali problemi.

**Non testabile in questa fase** (richiede un nodo RPC/Hardhat locale o
testnet vero): il flusso end-to-end completo di `GET /registry/:address/entries`
contro un vero contratto (eventi reali, `queryFilter` reale) — verificato
solo il ramo "registry sconosciuto" (che non tocca la rete) e la logica pura
di combinazione (`mergeEntries`, già testata in precedenza).

## 16. Membership Corporate aggiornabile (contratti)

Su richiesta esplicita: sia `TraceabilityRegistryFactory` che ogni
`TraceabilityRegistry` avevano il riferimento alla Membership Corporate come
`immutable`. Cambiato in variabile mutabile + setter riservato a
ChainIntegrate su **entrambi** i contratti:

- **`Factory.setMembershipCorporate(address)`** — usato per i **nuovi**
  deploy da quel momento in poi. Non tocca i registry già esistenti.
- **`TraceabilityRegistry.setMembershipCorporate(address)`** — necessario
  perché ogni registry ha la propria copia fissata al momento del proprio
  deploy: senza questa seconda funzione, i registry già attivi resterebbero
  agganciati alla vecchia Membership Corporate anche dopo un aggiornamento
  della Factory (deleghe Silver, funzionalità Gold verificate contro il
  contratto sbagliato). Va richiamata esplicitamente per ogni registry che
  deve restare allineato — non è automatica.

Controllo grezzo di bilanciamento parentesi fatto (nessun compilatore
Solidity disponibile in questo ambiente) — **verificare con `solc`/Hardhat
reale prima del deploy**.

## 17. Metadata di collezione — immagine square + banner (`traceability-metadata.js`)

Nuova funzione **`buildRegistryCollectionMetadata(name, description, squarePhotoLibraryEntry, bannerPhotoLibraryEntry)`**
— quella che `registryAdmin` imposta via `setRegistryMetadata()` (§2), la
"collezione" visibile su universaleverything.io. Testata con e senza banner:
`icon`/`images` sempre presenti (standard LSP4), `backgroundImage` aggiunto
solo se fornito un banner (campo non ufficiale ma già visto funzionare, vedi
`lsp4-metadata-notes.md` §3) — nessun campo spurio quando manca.

## 18. Libreria foto — client frontend (`frontend/traceability-photo-library.js`)

Completa il cerchio aperto quando avevamo costruito solo il backend: ora
esiste anche il lato che lo chiama davvero. **Stesso endpoint usato sia per
caricamento anticipato (gestione libreria) sia inline durante il mint di un
token** — nessuna distinzione, ogni upload arricchisce comunque la libreria
per i mint futuri, come richiesto.

- **`uploadPhoto`**, **`listPhotos`**, **`hidePhoto`** — ognuna firma un
  messaggio specifico con la UP prima di chiamare il backend corrispondente
  (§11). **Tutti gli upload richiedono firma, nessuna eccezione.**
- I tre `buildXSignedMessage` sono duplicati intenzionali delle controparti
  in `backend/photoRoutes.js` — **verificato che producano byte-per-byte lo
  stesso messaggio** (stesso confronto diretto già fatto per `pin-json`).
- `uploadPhoto` testato end-to-end con un signer e un `fetch` finti (nessuna
  rete reale): URL corretto, tutti i campi nel `FormData` (incluso il file
  come Blob), messaggio firmato nel formato esatto, risposta interpretata
  correttamente.

## 19. Internazionalizzazione IT/EN e form guidato (`user.html`, `admin.html`)

Richiesti esplicitamente dopo i primi test reali: pulsanti IT/EN sempre
visibili (non autorilevamento da browser), e una seconda modalità di mint
oltre al caricamento JSON.

- **i18n**: dizionario `I18N` con chiavi `it`/`en`, funzione `t(key, params)`
  con sostituzione `{placeholder}`, applicato via `data-i18n`/
  `data-i18n-placeholder` sull'HTML statico e chiamate `t(...)` nel JS
  dinamico (log, tabelle, errori). Preferenza salvata in `localStorage`.
  **Verificato con uno script che estrae ogni chiave usata (HTML+JS) e la
  confronta con il dizionario**: `user.html` → 118/118 chiavi coperte in
  entrambe le lingue, zero mancanti, zero chiavi morte; `admin.html` →
  43/43, stesso esito.
- **Form guidato**: in "Materie prime" e "Batch produzione", un sotto-tab
  "Compila manualmente" accanto a "Carica JSON" — righe aggiungibili
  dinamicamente (materiali per gli acquisti, coppie ingrediente/lotto per i
  batch). Costruisce **esattamente** lo stesso oggetto JSON che produrrebbe
  un file caricato, poi lo passa alla stessa pipeline di validazione/
  anteprima/mint (funzioni condivise `processRawMaterialJson`/
  `processProductionBatchJson`, non duplicata tra i due percorsi).
  **Verificato contro i validatori reali**: JSON generato dal form → valido,
  righe vuote scartate correttamente, doppia data richiede scelta, data
  singola no, nessuna data correttamente rifiutata — stessi identici
  risultati che si otterrebbero da un file caricato a mano.

## 21. Widget pubblico di visualizzazione (`frontend/explorer.html`)

Pagina pubblica, **nessuna connessione UP richiesta** — a differenza di
`user.html`/`admin.html`, chiunque la apre (cliente, ispettore, un sito
esterno che la embedda). Stile a card ispirato deliberatamente a
universaleverything.io su richiesta esplicita: immagine, badge tipo
(materia prima/batch), nome, descrizione, attributi (espandibili al click).

- **Legge solo dal backend pubblico** (`GET /registry/:address/entries`,
  già pubblico per design) — mai RPC diretto dal browser, coerente con
  tutto il resto.
- **Batch collegati ai propri lotti**: i lotti in `usedLots` diventano link
  cliccabili che scorrono fino alla card del lotto corrispondente — il
  collegamento strutturato lotto→batch (non solo testo) diventa finalmente
  visibile anche qui, non solo nella UI di mint.
- **Entry invalidate**: mostrate comunque (mai nascoste — restano
  verificabili) ma visivamente attenuate con un badge dedicato.
- **Embeddabile**: `?registry=0x...` nell'URL carica subito senza dover
  compilare un form — pensato per un `<iframe>` su un sito esterno.
- **Sicurezza**: dato che il contenuto (nome, descrizione, attributi) viene
  da metadata pubblica scrivibile da chi ha autorizzazione di mint,
  **tutto passa da un escape HTML** prima di finire nel DOM — **testato con
  un DOM reale (jsdom)**: un tentativo di injection (`<img onerror=...>`)
  viene neutralizzato correttamente, nessun tag eseguibile nel risultato.
- i18n: stesso pattern IT/EN a pulsanti di `user.html`/`admin.html`,
  verificato 13/13 chiavi coperte, zero morte.
- **Intestazione collezione**: nome/descrizione/banner/icona del registro
  stesso (`setRegistryMetadata`, non i singoli token) — letti via un nuovo
  campo `collectionMetadataValue` nella risposta di `/entries` (backend:
  `registry.getData(LSP4_METADATA_KEY)`, funzione standard ERC725Y già
  presente sul contratto, nessun redeploy necessario).
- **Filtri a pillole**: un gruppo per ogni chiave di attributo trovata tra
  tutte le card, valori distinti come pillole cliccabili. Semantica: **OR**
  tra valori della stessa chiave, **AND** tra chiavi diverse. **Testato con
  5 scenari e dati realistici** (stessi lotti/batch usati altrove in questo
  documento): filtro singolo isola la card giusta, OR su due valori prende
  entrambe, AND tra due chiavi restringe correttamente, nessun filtro
  mostra tutto — incluso il caso specifico richiesto (filtrare per numero di
  lotto isola il materiale, non il batch che lo referenzia con una chiave
  diversa per ingrediente).

**Non testato**: il rendering visivo reale in un browser con dati veri (la
logica di fetch/decode/escape sì, il DOM finale visto da un utente no).

## 22. Refactoring in modulo condiviso + integrazione in `user.html`

Dopo il primo uso reale: troppi gruppi di filtri aperti spingevano le card
troppo in basso (ogni ingrediente di un batch genera una propria chiave
"Lotto X", quindi molti gruppi). Estratta tutta la logica di
`explorer.html` (card, filtri, intestazione collezione) in un modulo
condiviso — **corretta una volta sola, beneficiano entrambe le pagine**:

- **`frontend/traceability-explorer-ui.js`** + **`traceability-explorer-ui.css`**
  (classi `te-*` per non entrare in conflitto con lo stile della pagina
  ospitante). `createGalleryInstance({...})` produce un'istanza indipendente
  — più istanze possono coesistere sulla stessa pagina.
- **Fix UX filtri**: gruppi ora dentro `<details>`/`<summary>` (nativi,
  nessun JS per aprire/chiudere), chiusi di default, con il conteggio dei
  valori nell'etichetta. **Verificato che la logica di matching produca gli
  stessi identici risultati di prima dell'estrazione**.
- **`explorer.html`** riscritta per usare il modulo — molto più corta,
  stessa funzionalità.
- **`user.html`**: due aggiunte richieste esplicitamente —
  1. Tab "Info registro" ora mostra i metadata **attualmente impostati**
     (nome/descrizione/immagini) sopra il form di modifica, aggiornati sia
     alla selezione del registro sia subito dopo un salvataggio riuscito —
     non serve più uscire dal pannello per vedere cosa c'è già.
  2. Nuovo tab "Esplora registro": stessa galleria pubblica di
     `explorer.html`, montata dentro il pannello autenticato. Caricata solo
     al click sul tab (non ad ogni selezione registro), per non appesantire
     le altre operazioni.
- **Coerenza i18n finale**: `user.html` + modulo condiviso insieme →
  139/139 chiavi coperte, zero mancanti, zero morte;
  `explorer.html` + modulo → 13/13.

**Nota di processo**: questo refactoring è stato costruito la prima volta
sopra un clone locale non aggiornato (errore mio — non avevo riclonato
all'inizio del turno). Il confronto riga-per-riga contro il repo reale ha
mostrato zero divergenze non intenzionali, e il lavoro è stato riapplicato
pulito sulla base corretta prima di essere presentato — nessun commit
errato è mai arrivato su GitHub.

## 23. Fix UX filtri — da tendine verticali a chip orizzontali con menu a comparsa

Le tendine `<details>` (§22) restavano comunque troppo lunghe con molte
chiavi diverse (ogni ingrediente di un batch ne genera una propria) — anche
chiuse, ogni gruppo occupava una riga intera. Feedback diretto dopo il primo
uso reale con dati veri (22 chiavi distinte). Sostituito con lo stesso
pattern di universaleverything.io: chip orizzontali a capo automatico,
click apre un piccolo menu a comparsa (overlay, non spinge il contenuto
sottostante), un solo menu aperto alla volta, click fuori lo chiude.

**Testato con un DOM reale (jsdom)**, non solo a occhio: apertura/chiusura
al click sul toggle, click fuori dal menu lo chiude, click **dentro** il
menu (su una pillola) non lo chiude, la chip si evidenzia (`has-active`)
quando ha un filtro selezionato, "Cancella filtri" rimuove l'evidenziazione,
e solo un menu resta aperto quando se ne apre un secondo. Il listener
globale di "click fuori" è registrato una sola volta per istanza di galleria
(non ad ogni `renderFilters`), per non accumularne di duplicati sulle
gallerie multiple che possono coesistere sulla stessa pagina (es. `user.html`
con la sua Esplora registro).

## 24. Errore di connessione UP silenzioso e criptico — corretto

Sintomo reale segnalato: se l'estensione UP non mostra/completa il popup di
autorizzazione (bloccata, minimizzata, chiuso per sbaglio), `signer.getAddress()`
falliva con un errore ethers criptico (`unknown account #0`) che emergeva
**dopo**, sparso in punti scollegati del pannello (libreria foto, tier
deleghe) — mai al momento della connessione stessa, dove la vera causa
sarebbe stata ovvia.

Aggiunto un controllo esplicito subito dopo `eth_requestAccounts`
(`user.html` e `admin.html`): se il rifiuto/annullamento viene rilevato
subito o se non risulta nessun account autorizzato, un messaggio chiaro
lo dice immediatamente, invece di lasciare che l'errore riemerga più tardi
in componenti che non c'entrano nulla con la causa reale.

## 25. Bottone di annullamento (`invalidateEntry`) nel tab "Esplora registro"

Il contratto aveva già `invalidateEntry` da tempo — mancava solo la UI per
chiamarlo. **Nessuna modifica al contratto**, funziona da subito sul
registry Birra20Venti già live.

- **Deciso**: solo il bottone, niente cambio immagine/attributo "Stato"
  aggiornabile su universaleverything.io — quella richiederebbe una
  funzione che il contratto non ha, non retroattiva sul registry esistente
  (discusso esplicitamente, rimandato).
- **Modulo condiviso** (`traceability-explorer-ui.js`): `createGalleryInstance`
  accetta ora un `onInvalidate` opzionale. Se assente (sempre il caso su
  `explorer.html`, pubblica e senza wallet), **nessun bottone compare mai** —
  verificato con jsdom, non solo per assunzione. Se presente, il bottone
  appare solo sulle entry non ancora annullate (mai due volte sullo stesso
  token), chiede il motivo via prompt, e se l'utente annulla il prompt
  **nessuna chiamata avviene** — anche questo verificato con un DOM reale,
  6 scenari in tutto.
- **`user.html`**: `exploreGallery` passa `onInvalidate` che chiama
  `activeRegistry.invalidateEntry(tokenId, reason)`, poi la galleria si
  ricarica da sola per riflettere subito il nuovo stato (badge "Annullato",
  bottone sparito, card attenuata).
- Aggiunta `invalidateEntry` alla `REGISTRY_ABI` di `user.html` — mancava,
  la chiamata sarebbe fallita silenziosamente senza.
- Coerenza i18n: 147/147, zero mancanti.

## 26. Motivo dell'annullamento visibile nelle card

Il motivo era già scritto on-chain (nell'evento `EntryInvalidated`, mai in
uno stato leggibile direttamente) — mancava solo mostrarlo. Nessuna
modifica al contratto.

- **Backend**: `mergeEntries` ora riceve una mappa tokenId→{reason, by}
  invece di un semplice insieme di tokenId annullati — costruita dagli
  stessi eventi già scansionati per il badge "Annullato". Ogni entry
  annullata porta `invalidationReason`/`invalidatedBy` nella risposta di
  `/entries`. **Testato**: motivo e firmatario corretti sul token giusto,
  `null` su quello mai annullato; nessuna regressione sul ramo già testato
  (registry sconosciuto → 403).
- **Modulo condiviso**: la card mostra un riquadro rosso col motivo,
  **solo** se lo status è Invalidated **e** un motivo è presente — mai su
  un'entry valida. **Testato con jsdom**: compare dove deve, non compare
  dove non deve.
- Attiva automaticamente sia su `explorer.html` (pubblica) sia su `user.html`
  (tab Esplora registro) — stesso modulo, una sola modifica.
- Coerenza i18n: 148/148 su `user.html`, 18/18 su `explorer.html` (incluse
  4 chiavi "invalidate" mai attivate lì ma presenti per coerenza, dato che
  il modulo le referenzia comunque nel codice sorgente anche se quel ramo
  non scatta mai senza `onInvalidate`).

## 27. Ricerca trasversale per numero di lotto

Problema segnalato con dati reali: filtrando per la pillola `Lotto` (chiave
generica, usata dai `RawMaterialLot`) non emergeva il batch che referenzia
lo stesso lotto — perché nel batch quel valore vive sotto una chiave
**diversa per ogni ingrediente** (`"Lotto Ciliegie Fresche"`,
`"Lotto Pilsen (2-Row)"`, ecc., convenzione voluta fin dall'inizio per il
matching automatico all'inserimento). Le pillole fanno corrispondenza
esatta chiave+valore, quindi non collegano mai le due schede.

**Aggiunta una casella di ricerca testuale separata**, non a pillole: cerca
solo nel **valore** di qualunque attributo la cui chiave sia `"Lotto"`
oppure inizi per `"Lotto "` (stesso prefisso già usato per il matching
automatico in `traceability-json-validators.js`), case-insensitive,
substring — non serve il valore esatto. Si combina in **AND** con le
pillole eventualmente attive.

**Testato riproducendo esattamente lo scenario segnalato** (lotto ciliegie
nell'acquisto sotto chiave `"Lotto"`, stesso valore nel batch sotto chiave
`"Lotto Ciliegie Fresche"`): la ricerca trova entrambe le schede, esclude
un lotto diverso, funziona anche con corrispondenza parziale, si azzera
correttamente col campo vuoto. Coerenza i18n: 149/149 su `user.html`,
19/19 su `explorer.html`.

## 28. Filtri sfrondati + pillola "Lotto" trasversale

Raffinamento richiesto dopo l'uso reale: troppe chiavi diverse (ogni
ingrediente di un batch genera la sua) rendevano i filtri "normali" ingombra
nti, e il campo di ricerca da solo era scomodo se non si conosceva già il
numero di lotto a memoria ("bisogna prendertelo, copiarlo, reincollarlo").

- **Whitelist esplicita** per le pillole a corrispondenza esatta:
  `Fornitore`, `Data Acquisto`, `Data Scadenza`, `Ricetta`, `Data Produzione`,
  `Data Imbottigliamento` — tutto il resto (`Nome`, `Quantità`, ogni
  `"Lotto <ingrediente>"`) escluso.
- **La pillola "Lotto" diventa un'eccezione governata**: aggregata su
  *tutti* i valori esistenti sotto qualunque chiave `"Lotto"`/`"Lotto ..."`
  (stessa unione già usata dalla ricerca libera), ma resta un elenco
  cliccabile — non serve più conoscere il lotto a memoria, si sceglie dalla
  lista. Click = stessa ricerca trasversale di prima (non corrispondenza
  esatta chiave+valore), sincronizzata col campo di testo libero (tenuto,
  come richiesto, per chi il lotto lo conosce già).
- **Bug trovato e corretto durante la scrittura, non dopo**: condividere lo
  stile CSS tra pillole normali e pillole "Lotto" (stessa classe) avrebbe
  attaccato *anche* il gestore click generico (`togglePill`, che si aspetta
  `data-key`) alle pillole lotto — corretto escludendole esplicitamente dal
  selettore (`:not(.te-lot-pill)`).
- **Testato con dati reali** (stesso scenario ciliegie/batch di prima, con
  l'aggiunta delle chiavi ora escluse): whitelist rispettata, pillola
  "Lotto" elenca entrambi i valori, click trova entrambe le schede
  nonostante le chiavi diverse, doppio click deseleziona senza errori — 11
  controlli, tutti passati. Nessuna nuova chiave i18n necessaria.

## 29. Punti aperti / TODO

- [ ] Confermare import esatti e versione `@lukso/lsp8-contracts` /
      `@lukso/lsp4-contracts` (allineare al resto dei repo ChainIntegrate).
- [x] `_LSP4_TOKEN_TYPE_NFT` — **era sbagliata**, non esiste come costante
      esportata (confermato da un vero errore di compilazione `HH600`).
      Corretto: è semplicemente il valore numerico `1`, non un identificatore
      con nome — coerente con `lsp4-metadata-notes.md`.
- [x] `_LSP8_TOKENID_FORMAT_HASH` — **confermata corretta**: compilazione
      completa riuscita (28 file Solidity) dopo la correzione sopra.
- [ ] Confermare che `tierOf()` su Membership Corporate ritorni `0` anche per
      un'azienda sospesa (altrimenti serve un controllo `isSuspended()`
      separato nel Factory e nei modifier di `TraceabilityRegistry`).
- [ ] Confermare che `SILVER_TIER = 2` / `GOLD_TIER = 3` combacino
      esattamente con `setTier()` sul contratto Membership Corporate reale.
- [x] ~~Confermare se un'azienda con più stabilimenti deve poter avere più di
      un registry~~ — risolto: limite per tier, Bronze 1 / Silver 2 / Gold 5
      (§2), stesso schema del Supplier Trust Registry.
- [x] Decidere UI: ~~stesso dominio con due tab, o due domini~~ — **deciso:
      un solo dominio, due tab** ("Carica JSON" / "Compila e genera JSON").
- [x] Costruire `POST /api/traceability/pin-json` — **fatto** (§8), testato
      quanto possibile senza un nodo RPC/IPFS live (validazione, messaggio,
      sintassi). Verifica ERC-1271/`isAuthorized` end-to-end da provare su
      testnet.
- [x] Porta confermata: `3014` (verificato con `ss -tlnp` sul VPS reale —
      3001-3002, 3006-3013, 3020, 3032 risultavano occupate).
- [ ] Decidere se le metadata devono essere bilingui EN/IT (principio già in
      uso altrove: EN prima, IT seconda) o restare solo IT come i JSON
      sorgente attuali — per ora `traceability-metadata.js` riproduce solo IT,
      fedele allo schema originale, nessuna traduzione applicata.
- [x] Aggiungere GitHub repo `ChainIntegrate/traceability-registry` — **fatto**,
      pubblico, con LICENSE (All Rights Reserved) al primo commit.
- [x] **Correzione architetturale** (§12): endpoint di lettura backend
      costruito e testato (logica pura `mergeEntries`) — resta da scrivere
      solo il widget stesso (decodifica client-side + rendering).
- [x] Costruire il pezzo frontend che chiama `upload-photo`/`photos` — **fatto**
      (`traceability-photo-library.js`), confermato funzionante da mint reali.
- [x] Costruire il widget di visualizzazione pubblica — **fatto**
      (`frontend/explorer.html`, §21).
- [x] Il delegato di un registry non aveva modo di accedervi dalla UI (solo
      i registri auto-deployati comparivano) — **fatto**, sezione dedicata
      in `user.html` per connettersi a un registry esistente via indirizzo.
- [x] **Verifica ERC-1271 su UP reale** — confermata empiricamente: mint
      reali (materie prime e batch) completati con successo su testnet, che
      richiedono `verifySignedRequest` (ERC-1271 + `isAuthorized`) superato
      ad ogni chiamata. Il formato `ethers.utils.hashMessage` è quindi
      corretto. Lo script dedicato (`scripts/test-erc1271-live.js`) resta
      comunque disponibile per una verifica isolata futura, se mai servisse.
- [ ] Configurare `.env` di produzione: `FACTORY_ADDRESS` (dopo il deploy
      della Factory), `ALLOWED_MINT_UI_ORIGIN` (dominio della UI di mint),
      una **API key RPC dedicata** a questo servizio (mai riusata da altri
      backend ChainIntegrate).
- [x] Data di scadenza opzionale (materie prime) — **già così**, verificato:
      non è nei campi obbligatori né nello schema né nel validatore.
- [x] Annullamento registrazione — **già implementato** (`invalidateEntry`,
      mai burn, resta visibile on-chain, escluso dai nuovi collegamenti).
- [x] Membership Corporate aggiornabile — **fatto** (§16), sia su Factory
      che su ogni singolo TraceabilityRegistry.
- [x] Metadata di collezione con square+banner — **fatto** (§17).
- [x] Client frontend libreria foto — **fatto** (§18).
- [ ] **Verificare con un vero compilatore Solidity (`solc`/Hardhat)** le
      modifiche ai contratti — qui controllato solo il bilanciamento delle
      parentesi, non una vera compilazione.

## 10. Prossimi passi (codice non ancora scritto)

1. ~~Funzione di calcolo `tokenId`~~ — **fatto** (§7).
2. ~~Costruttore metadata LSP4~~ — **fatto** (§8), testato su dati reali.
3. ~~`POST /api/traceability/pin-json` (backend)~~ — **fatto** (§8).
4. ~~Script di orchestrazione lato client~~ — **fatto** (§9), testato quanto
   possibile senza un nodo live (messaggio identico backend/frontend,
   encoding VerifiableURI reale su dati Pinta).
5. UI di mint (due tab, stesso dominio): upload/compilazione JSON →
   validazione → matching lotti (con schermata di conferma per i non
   trovati, tolleranza nome/rigore lotto) → scelta data se
   `requiresDateSelection` → anteprima → firma UP → mint.
6. Deploy Hardhat (testnet prima) di Factory + primo Registry (Birra20Venti).
7. Widget di visualizzazione (eventi + `indexDate`, embeddabile).