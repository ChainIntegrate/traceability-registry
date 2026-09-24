# TraceabilityRegistry — ChainIntegrate

Prodotto di tracciabilità multi-azienda, ispirato al Supplier Trust Registry
ma con architettura diversa perché il problema è diverso: non un'autorità che
attesta su tanti soggetti, ma tante aziende autonome che operano ciascuna nel
proprio spazio isolato. Caso pilota: Birra20Venti (sostituisce l'attuale
sistema ERC-721 di `Materie_Prime.html`/`Batch.html`), pensato fin dall'inizio
per essere offerto anche ad altre aziende.

Stato: **Factory deployata e verificata su testnet**
([`0x5979cFcfdCC860C3273B83e89D9FCf4D8a2bfee9`](https://explorer.execution.testnet.lukso.network/address/0x5979cFcfdCC860C3273B83e89D9FCf4D8a2bfee9) —
sorgente pubblicata su Blockscout, verificabile da chiunque). **Birra20Venti
non ha alcun `TraceabilityRegistry` proprio, né su testnet né su mainnet**:
i test fatti finora (mint, esplorazione, hash documento — vedi i §§
successivi) hanno usato registry di test deployati su testnet durante questo
lavoro, popolati con i dati reali di Birra20Venti (nomi prodotti, lotti,
JSON) per avere una verifica il più possibile realistica — nessun registro è
mai stato deployato specificamente per o intestato a Birra20Venti, nessun
uso in produzione, nessun deploy su mainnet ancora fatto. Dal Factory attuale, `deployRegistry()`
richiede anche che ChainIntegrate abbia già assegnato un settore all'azienda
via `setSector` (§48) — non basta più solo il tier Membership Corporate. Repo:
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
  Membership Corporate (quindi almeno Bronze) **e un settore già assegnato**
  (`sectorOf(msg.sender) != bytes32(0)`, vedi §48 — assegnato solo da
  ChainIntegrate via `setSector`, mai auto-dichiarabile) può chiamarla.
  Deploya il contratto passando `chainIntegrateOwner` (fisso) e `msg.sender`
  (l'azienda) come `registryAdmin`.
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
CID già pinnato riusato per chiave (es. `Codice` per i batch — rinominato da
`Ricetta`, vedi §48 — fornitore o default per le materie prime), niente
ri-upload ad ogni mint a meno di scelta esplicita.

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
- `attributes[]` deve contenere `Codice` (chiave per la libreria foto —
  rinominato da `Ricetta`, non più specifico del settore alimentare/birra,
  vedi §48) e almeno una data tra quelle riconosciute per il settore
  (`RECOGNIZED_DATE_TRAIT_TYPES_BATCH`, configurabile per pagina/settore —
  Birra20Venti (`alimentare_bidata`) ne ha due, `Data Produzione` e
  `Data Imbottigliamento`; gli altri settori attuali (`alimentare_monodata`,
  `industria`) una sola, `Data Produzione` — vedi §48).
- Convenzione: **qualunque** `trait_type` che inizia per `"Lotto "` è un
  candidato al matching automatico verso i `RawMaterialLot` già mintati
  (confermato coi dati reali: 8 trovati su Batch #131 senza logica ad hoc).

Il validatore (`frontend/traceability-json-validators.js`, vanilla JS, zero
dipendenze, stesso stile degli altri frontend ChainIntegrate) espone:

- `validateRawMaterialPurchaseJson(json)` / `validateProductionBatchJson(json)`
  → `{ valid, errors[], warnings[] }`.
- `extractRawMaterialPurchaseData(json)` → righe pronte per i tre array
  paralleli del mint batch.
- `extractProductionBatchData(json)` → codice, date candidate
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

- **`computeRawMaterialLotTokenId(registryAddress, fornitore, nomeIngrediente, lotto, dataAcquistoRaw)`**
  → `keccak256(abi.encodePacked(registryAddress, "RML", fornitore, nomeIngrediente, lotto, dataAcquistoRaw))`,
  identico a `solidityKeccak256` lato JS. L'indirizzo del registry è incluso
  come sale (isolamento extra, a costo zero); il prefisso `"RML"` separa lo
  spazio hash da quello dei batch, in aggiunta al controllo che il contratto
  fa già via `ENTRY_TYPE_KEY`. Testato su dati reali: 20/20 tokenId unici
  sui materiali dell'acquisto Pinta.
  **§42**: la data di acquisto è stata aggiunta alla firma della funzione
  dopo aver trovato un bug — senza data, lo stesso lotto ricevuto in due
  spedizioni reali diverse nello stesso anno generava lo stesso tokenId,
  bloccando (o facendo fallire l'intero import batch di) la seconda
  ricezione. Con la data, l'idempotenza voluta resta solo per il caso
  giusto: un doppio invio accidentale dello stesso identico acquisto.
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

**Decisione (non ancora scritta qui prima)**: l'i18n copre SOLO il chrome
della UI (etichette, pulsanti, messaggi) — non tocca mai il contenuto della
metadata (`name`, `description`, `attributes` del JSON caricato/compilato).
Quel testo resta nella lingua in cui l'azienda l'ha scritto, senza traduzione
automatica. Scelta deliberata: la lingua di chi scrive un batch/lotto è
quasi sempre la stessa di chi lo consulterà (stesso mercato locale), e
tradurre automaticamente introdurrebbe un livello di complessità/rischio
(traduzione errata di un termine tecnico o di un nome proprio) senza un
bisogno reale confermato finora. Se in futuro un cliente opera in un mercato
multilingue, si affronta come eccezione puntuale, non come default.

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

## 30. Cinque aggiustamenti UX su `user.html`

Richiesti dopo l'uso reale prolungato del pannello.

- **Pannello log a tetto fisso**: `log()` tiene solo le ultime 5 righe in un
  buffer (`LOG_MAX_LINES`), non solo scroll su una lista che cresce
  all'infinito. `max-height` del pannello ridotta di conseguenza (200px →
  110px). **Testato**: 8 messaggi in sequenza → restano visibili solo gli
  ultimi 5.
- **JSON importato reso modificabile**: ripensato il flusso — caricare un
  file ora **popola il form manuale** (`populateRawMaterialForm`/
  `populateBatchForm`) e porta l'utente lì, invece di generare subito
  un'anteprima non toccabile. Upload e compilazione a mano convergono sullo
  stesso percorso da questo punto in poi (`switchToSubtab` per il passaggio
  programmatico tra i due sotto-tab). **Testato con un vero round-trip**: un
  acquisto di 3 materiali (stessa struttura del caso reale Pinta a 20
  materiali) estratto, versato nel form, riletto senza modifiche — risultato
  byte-per-byte identico all'originale, nessuna perdita di dati nel giro.
- **Pulsante "Torna a modifica"**: accanto a "Conferma e registra" in
  entrambi i flussi (materie prime, batch) — riporta al sotto-tab manuale
  (dati già presenti, mai svuotati) senza reinserire nulla da capo.
- **Pulsante "Disconnetti"**: azzera `provider`/`signer`/`myAddress`/
  `factory`/`activeRegistryAddress`/`activeRegistry`, nasconde i pannelli,
  torna al pulsante di connessione. Nessuna vera revoca lato wallet (non
  esiste un'API universale tra estensioni per farlo) — stesso significato
  di "disconnetti" in qualunque dApp.
- **Terminologia ammorbidita**: "minta"/"mint" → "registra"/"registrazione",
  "Tx:" → "Riferimento:", "Firma e invio transazione" → "Registrazione in
  corso", "Scrittura on-chain" → "Salvataggio in corso", ecc. — su
  `user.html` soltanto; `admin.html` resta tecnico, è uno strumento interno
  ChainIntegrate, non per le aziende clienti.

Coerenza i18n: 151/151 (`user.html` + modulo condiviso), zero mancanti.

## 32. Logo, banner e favicon sulle tre pagine

File caricati direttamente sul VPS (non tramite di me): `logo.png`,
`logo_700x700.png`, `banner.png`, `banner._1800x1004.png` (nome così com'è,
non rinominato), `favicon.ico` — pensati anche per i metadata della
collezione al momento del deploy mainnet, usati fin da subito anche per la
UI.

- **Favicon**: `<link rel="icon">` su tutte e tre le pagine (`user.html`,
  `admin.html`, `explorer.html`).
- **Logo**: `logo_700x700.png` (versione già ridimensionata) accanto al
  titolo in ogni header.
- **Banner**: `banner._1800x1004.png` (versione ridimensionata) in cima a
  ogni pagina, sopra l'header.

I file immagine restano da committare sul repo (erano già sul VPS ma non
tracciati da git al momento di questa modifica).

## 34. Logo più grande, banner senza tagli, registri per nome

- **Logo**: 40px → 72px su tutte e tre le pagine.
- **Banner**: sostituito `max-height: 160px` (fisso, tagliava molto su
  schermi larghi dato che l'immagine è 1800×1004) con `aspect-ratio: 1800/1004`
  — lo spazio ora segue sempre la proporzione reale dell'immagine, niente
  taglio arbitrario indipendente dalla larghezza dello schermo.
- **Elenco registri per nome**: `loadMyRegistries()` ora legge il metadata
  di collezione di ciascun registro (`collectionMetadataValue`, stessa
  fonte già usata dal tab Esplora) e mostra il **nome** al posto del nudo
  indirizzo — indirizzo comunque visibile sotto, come riferimento tecnico,
  mai nascosto. Se un registro non ha ancora metadata (appena creato) o la
  lettura fallisce, ripiega silenziosamente sul solo indirizzo — **testato
  con jsdom sui tre casi** (nome presente, nessun metadata, errore di rete):
  mai un'interruzione dell'elenco.

## 36. Banner ridotto, footer su user/explorer (non admin)

- **Banner ridimensionato di nuovo**: l'`aspect-ratio: 1800/1004` di prima
  (§34) generava un'altezza reale di oltre 600px su un contenitore largo
  1100px — "prende quasi tutto lo schermo", segnalato subito. Tornato a
  un'altezza fissa modesta (100px, `object-fit: cover`) su tutti e tre i
  file — striscia decorativa, non hero image.
- **Footer aggiunto** su `user.html` ed `explorer.html` (non `admin.html`,
  come richiesto) — markup fornito verbatim, inserito prima di `</body>`.
  Usa tre variabili CSS (`--powder-line`, `--ink-soft`, `--blueprint`) non
  definite in nessun file di questo repo — probabile provenienza da
  un'altra pagina ChainIntegrate con la sua palette. Aggiunte con valori
  ragionevoli in un blocco `:root` (grigio bordo, testo attenuato, blu
  neutro per l'accento) — **da sostituire con i valori esatti** se esiste
  già una palette ChainIntegrate definita altrove.
- **Nota**: il testo del footer è statico in italiano, non passa dal
  sistema `t()` — resta in italiano anche con la pagina in EN. Lasciato
  così perché fornito verbatim; da agganciare al sistema di traduzione se
  serve che segua la lingua della pagina.

## 38. Banner corretto per davvero + footer agganciato alla traduzione

- **Banner**: il vero problema non era la dimensione in sé, ma il design
  dell'immagine (larga e bassa, con testo in alto e icone/lotti
  incrociati al centro-basso) contro una striscia troppo corta —
  `object-fit: cover` a 100px tagliava esattamente quella zona centrale.
  **Soluzione**: niente più `width: 100%` forzato — altezza capata
  (160px), larghezza libera secondo la proporzione reale dell'immagine,
  centrata. Immagine sempre intera, mai tagliata, ma comunque compatta.
- **Footer agganciato al sistema di traduzione**: aggiunti `data-i18n` a
  tutti e tre gli elementi testuali (diritti, consulenza, Telegram) su
  `user.html` ed `explorer.html`. **Bug evitato durante la scrittura, non
  dopo**: `applyLanguage()` usa `textContent`, che NON decodifica le
  entità HTML — scrivere `&amp;` nel dizionario JS lo avrebbe mostrato
  letteralmente come testo `&amp;` invece di `&`. Usato un `&` letterale
  nel dizionario. **Testato con jsdom**: nessun `&amp;` letterale nel
  risultato, e il cambio lingua aggiorna davvero il footer (verificato
  IT→EN).
- Coerenza i18n: 155/155 su `user.html`, 22/22 su `explorer.html`.

## 40. Mint senza controllo di tier/sospensione — falla trovata e corretta

- **Segnalazione**: test di mint con una Membership Corporate portata a
  tier sospeso (`0xeE1256Cc436c847D774BB6D686f98f41A2D4CF08`) — il mint è
  andato a buon fine, quando ci si aspettava un rifiuto.
- **Diagnosi**: confermato leggendo il contratto reale (non un'ipotesi).
  `mintRawMaterialLot`, `mintRawMaterialLotBatch` e `mintProductionBatch`
  usano tutti il modifier `onlyAuthorized`, che controllava **solo**
  `msg.sender == registryAdmin || delegates[msg.sender]` — mai
  `tierOf()`. Il tier viene controllato live solo in due punti separati:
  `onlyDelegationManager` (gestione deleghe, richiede Silver+) e
  `onlyGoldFeature` (`setDocumentHash`, richiede Gold). Il mint no.
  Non è quindi un bug di `tierOf()` (che restituisce probabilmente `0`
  correttamente per un'azienda sospesa) — è che il mint non lo ha mai
  controllato.
- **Escluso come causa alternativa**: nessun controllo di tier esiste
  nemmeno lato UI/backend per il caricamento file durante il mint
  (`pin-json`, `upload-photo` — solo `isRegistry` + `isAuthorized`, mai
  `tierOf`). L'unico punto dove il tier blocca davvero qualcosa oggi è
  la creazione di un nuovo registro (`deployRegistryBtn` disabilitato
  lato UI + `require(limit > 0)` in `Factory.deployRegistry`).
- **Fix applicato**: aggiunto a `onlyAuthorized` lo stesso controllo già
  usato in `Factory.deployRegistry()` — `tierOf(registryAdmin) != 0` —
  coerente con il commento già presente nel Factory ("tierOf == 0 copre
  sia mai mintata sia, se sospesa"). Il tier controllato resta sempre
  quello di `registryAdmin` (l'azienda), non del delegato chiamante:
  se l'azienda viene sospesa, anche i suoi delegati smettono di poter
  mintare. `invalidateEntry` resta **volutamente** fuori da questo
  controllo (usa un check inline separato) — un'azienda sospesa deve
  poter comunque annullare una voce sbagliata.
- **Limite strutturale**: `TraceabilityRegistry` non è dietro un proxy
  (`Factory` fa `new TraceabilityRegistry(...)` diretto), quindi i
  registri già deployati (inclusi quelli di test) restano sul bytecode
  vecchio senza questo controllo. La fix vale solo per i registri
  creati dopo un nuovo deploy della Factory con il bytecode aggiornato.
  Decisione presa: essendo ancora in fase di test con soli registri di
  prova, si procede con un nuovo deploy pulito invece di un pattern
  upgradeable.
- **Superato il limite EIP-170 al primo tentativo di deploy**: il modifier
  `onlyAuthorized` viene duplicato dal compilatore ad ogni sito d'uso (3
  funzioni di mint) — la stringa di errore in più bastava a far superare
  a `TraceabilityRegistryFactory` i 24576 byte (include il creation-code
  di `TraceabilityRegistry`), con conseguente `Cannot estimate gas` al
  deploy. **Fix**: logica spostata in una funzione interna
  `_requireAuthorizedAndActiveMembership()`, chiamata (non duplicata) dal
  modifier — stesso comportamento e stessi messaggi di errore, meno
  bytecode.
- **Redeploy fatto e verificato**: nuova `TraceabilityRegistryFactory` su
  testnet `0x216a01A2DD93E613eE9D36b5E0AF50428149B7A1`, verificata
  sull'explorer. `FACTORY_ADDRESS` aggiornato in `user.html`, `admin.html`
  e nel `.env` del backend (con `pm2 restart --update-env`, necessario
  altrimenti il processo tiene in memoria il vecchio indirizzo).
- **Testato su un registro reale, esito confermato**: mint con tier
  attivo riuscito; sospesa la membership senza nemmeno ricaricare la
  pagina, il mint successivo è stato bloccato — conferma che il check è
  davvero on-chain e non dipende da uno stato letto/cacheato lato UI.
  Chiuso.

## 41. UI per `setDocumentHash` (Gold-only) — mai esposta, ora aggiunta

- **Trovato controllando**: `setDocumentHash(tokenId, documentHash)` esiste
  nel contratto da tempo (`onlyGoldFeature`, richiede tier Gold), ma
  **nessuna delle tre pagine frontend la richiamava** — zero riferimenti
  a `setDocumentHash`/`documentHash` in `user.html`, `admin.html` o
  `explorer.html`. La funzionalità Gold non è mai stata esercitata,
  nemmeno una volta (coerente con quanto già annotato al §39).
- **Aggiunta nel tab "Esplora registro"** di `user.html`, come azione
  per-card nella galleria condivisa (`traceability-explorer-ui.js`),
  sullo stesso pattern del bottone di annullamento: selezione file →
  bottone "Registra hash documento" → hash `keccak256` calcolato
  client-side sui byte del file (il file stesso non viene mai caricato
  né su IPFS né altrove, solo l'hash finisce on-chain) → chiamata a
  `activeRegistry.setDocumentHash(tokenId, hash)`.
- **Nessun filtro di tier lato UI, di proposito**: il bottone compare
  sempre (come per "Deleghe", dove pure serve tier Silver+ ma non c'è
  disabilitazione lato UI) — l'obiettivo è verificare dal vivo che sia
  il contratto stesso a rifiutare la chiamata se il tier non è Gold,
  non nasconderlo prima che possa essere testato.
- **Testato**: sintassi JS/CSS, bilanciamento tag HTML, id non-ASCII,
  copertura i18n (IT/EN) e un test funzionale jsdom che simula il click
  con file selezionato — verifica bottone renderizzato, callback
  invocata con `(tokenId, file)` corretti, messaggio di successo, nessuna
  espansione indesiderata della card al click. **Non ancora testato
  contro un vero contratto/wallet** — da fare come prossimo passo, con
  un account Gold e uno non-Gold per confermare accettazione/rifiuto.

## 42. TokenId materia prima: bug di collisione trovato testando, corretto

- **Segnalazione**: "una materia prima con lo stesso lotto posso comprarla
  più volte nell'anno, quindi problema stesso tokenId?"
- **Confermato leggendo il codice**: `computeRawMaterialLotTokenId` non
  includeva la data di acquisto —
  `keccak256(registryAddress, "RML", fornitore, nomeIngrediente, lotto)`.
  Due spedizioni reali diverse dello stesso lotto (stesso fornitore, stesso
  ingrediente, stesso numero di lotto, capita quando un fornitore spedisce
  lo stesso lotto in più consegne) generavano lo stesso tokenId — la
  seconda falliva con `"tokenId already used"`, e se capitava in mezzo a un
  JSON con più righe faceva fallire **l'intero import batch**, non solo
  quella riga.
- **Fix**: aggiunta la data di acquisto (`dataAcquistoRaw`) alla firma
  della funzione. L'idempotenza voluta (un doppio invio accidentale dello
  stesso identico acquisto viene rifiutato) resta intatta — cambia solo
  che ora serve *anche* la data per considerare due mint "lo stesso
  acquisto". Solo frontend (`traceability-tokenid.js`,
  `traceability-mint-compose.js`), nessun contratto toccato, nessun
  redeploy. Testato con un vero calcolo: stesso lotto+data → stesso
  tokenId (idempotenza confermata); stesso lotto, data diversa → tokenId
  diverso (collisione risolta).

## 43. Import materia prima: 20 righe = 20 firme, corretto a 1

- **Segnalazione**: importando un JSON con 20 materie prime, la UP
  extension ha chiesto 20 firme, una per lotto.
- **Causa**: `composeRawMaterialLotBatchMintArgs` chiamava
  `pinMetadataToIpfs` (che firma un messaggio) dentro un `for` per ogni
  lotto, prima del mint vero e proprio. Il mint (`mintRawMaterialLotBatch`)
  resta effettivamente "una transazione", ma il pinning IPFS che lo
  precede era "N firme" — il messaggio firmato lega la firma all'hash di
  **un solo** contenuto JSON, quindi non copriva 20 contenuti diversi.
- **Fix**: nuovo endpoint `POST /api/traceability/pin-json-batch` —
  un'unica firma copre un hash aggregato (`keccak256` della concatenazione
  ordinata degli hash dei singoli contenuti, ricalcolati server-side dai
  byte ricevuti, mai da un aggregato dichiarato dal client), pinna ogni
  elemento separatamente su IPFS (nessun JSON cumulativo: ogni lotto resta
  un file IPFS indipendente, l'explorer non cambia) e ritorna N CID in
  ordine. Il frontend ora costruisce tutti i metadata **prima** di firmare
  qualsiasi cosa, poi fa una singola chiamata batch.
- **Bug evitato scrivendo il codice, non dopo**: `app.use("/api/.../pin-json", cors)`
  in `server.js` fa match per SEGMENTO di path, non per prefisso di
  stringa — non copre `/pin-json-batch` (il carattere dopo "pin-json" non
  è uno "/"). Verificato empiricamente con un mini server Express di prova
  prima di fidarmi: serviva una riga CORS a parte, altrimenti la nuova
  route avrebbe rifiutato ogni richiesta da browser con un errore CORS
  silenzioso e difficile da diagnosticare.
- **Testato**: `computeAggregateHash`/`buildBatchSignedMessage` producono
  byte-per-byte lo stesso output lato backend e lato frontend (requisito
  per far passare la verifica firma) — verificato con un confronto diretto
  tra i due file, non per ispezione visiva. Flusso end-to-end verificato
  con firma/fetch finti: esattamente 1 `signMessage` e 1 chiamata
  `pin-json-batch` per 3 lotti (non 3), ordine lotti→CID→tokenId
  preservato. **Confermato dal vivo**: import di un JSON multi-lotto con
  una sola firma, nessun problema con IPFS/wallet reali.

## 44. Libreria documenti + `setDocumentHash(Batch)` nei form di mint (Gold)

- **Richiesta**: il caricamento file atteso nell'area "Materie prime" (e
  "Batch produzione") non era un semplice hash on-chain retroattivo
  (come implementato inizialmente nella galleria "Esplora registro"), ma
  un vero file **caricato e recuperabile in seguito**, come già avviene
  per le foto — scelta confermata esplicitamente: "Salvato e recuperabile
  (come libreria foto)".
- **Modello scelto dall'utente**: un documento (es. certificato/DDT di
  una spedizione) può coprire **più tokenId** in una sola operazione di
  acquisto/produzione — non un documento per singolo lotto. Da qui
  `setDocumentHashBatch(bytes32[] tokenIds, bytes32 documentHash)` sul
  contratto, oltre al preesistente `setDocumentHash` singolo (usato nel
  batch di produzione, che genera un solo tokenId per operazione).
- **Contratto** (`TraceabilityRegistry.sol`): `onlyGoldFeature` refattorizzato
  nello stesso pattern già usato per `onlyAuthorized` (corpo del modifier
  estratto in una funzione interna `_requireAuthorizedAndGoldTier()`,
  richiamata anziché duplicata a ogni sito d'uso) — fatto **prima** di
  aggiungere un secondo sito d'uso, proprio per non ripetere il bug di
  overflow EIP-170 già capitato con `onlyAuthorized`. Aggiunto
  `setDocumentHashBatch` + helper interno condiviso `_setDocumentHash`.
  **Compilazione non verificabile in sandbox** (nessun accesso di rete al
  compilatore Solidity) — da compilare e controllare la dimensione
  (EIP-170) prima del deploy, esattamente come già fatto per la fix
  precedente sul tier.
- **Backend**: nuova tabella `documents` (mirror di `photos`, stesso
  pattern idempotente su `UNIQUE(registry_address, keccak256_hash)` e
  stesso "hide" non distruttivo), nuovo `documentRoutes.js` (mirror di
  `photoRoutes.js`: `POST /upload-document`, `GET /documents`,
  `POST /documents/:id/hide`), limite 16MB (contro 8MB delle foto,
  certificati scansionati possono pesare di più), MIME ammessi
  `application/pdf` oltre a PNG/JPEG/WEBP. Wired in `server.js` con le
  stesse attenzioni CORS già documentate al punto 43 (route a parte,
  niente assunzioni di prefisso).
- **Frontend**: nuovo `traceability-document-library.js` (mirror di
  `traceability-photo-library.js`), nuova tab "Libreria documenti" in
  `user.html` (upload + lista + nascondi), e un menu a tendina documento
  aggiunto sia nel form di conferma mint materie prime
  (`rmDocumentSelect`) sia in quello di conferma mint batch
  (`batchDocumentSelect`) — valore dell'opzione = `keccak256_hash` del
  documento, esattamente quello che serve passare a
  `setDocumentHash`/`setDocumentHashBatch`, nessun ricalcolo.
- **Sequenza post-mint**: la chiamata a `setDocumentHash(Batch)` avviene
  **dopo** che il mint è già confermato (`tx.wait()`), in un try/catch
  separato — un eventuale rifiuto (tier non Gold) non deve essere confuso
  con un fallimento del mint stesso, che a quel punto è già avvenuto.
- **Testato**: `node --check` su tutti i file JS toccati, bilanciamento
  tag HTML, nessun `id` non-ASCII, copertura chiavi i18n IT/EN completa
  (184 chiavi ciascuna, nessuna mancante/orfana), test funzionale jsdom
  che verifica: tab "documenti" esistente e navigabile, form di upload
  presente, `refreshDocumentLibraryList` popola la tabella dal client
  documenti, e il dropdown `rmDocumentSelect` nel form materie prime usa
  correttamente `keccak256_hash` come valore dell'opzione.
  **Confermato dal vivo** (dopo il redeploy Factory del §45): mint
  materie prime multi-lotto con un solo certificato aggregato selezionato
  — l'hash si propaga correttamente su tutti i tokenId del batch.
  **Ancora da testare**: lo stesso flusso con tier sotto Gold (deve
  fallire solo l'aggancio hash, mai il mint) e il mint batch di
  produzione con documento (`setDocumentHash` singolo).
- **Aggiornato nel §46**: il bottone "Registra hash documento" già
  esistente nella galleria "Esplora registro" ora usa la libreria
  documenti invece di un file grezzo.

## 45. Fix EIP-170 residuo, link di download e visibilità dell'hash documento

- **Fix EIP-170**: dopo il §44, la Factory sforava ancora di 44 byte pur
  avendo già estratto `onlyAuthorized`/`onlyGoldFeature` in funzioni
  interne. Causa: `onlyDelegationManager` (usato in `addDelegate`/
  `removeDelegate`) era rimasto l'unico modifier non ancora estratto — il
  compilatore ne duplicava il corpo nei 2 siti d'uso. Stesso fix degli
  altri due: corpo spostato in `_requireDelegationManager()`. Compilato
  con successo dall'utente, Factory ridistribuita su testnet e verificata
  su Blockscout.
- **Link di download nelle librerie**: "Libreria foto" e "Libreria
  documenti" mostravano il CID come testo semplice — nessun modo diretto
  di scaricare il file per chi lo aveva caricato. Aggiunta una colonna
  con link cliccabile (`TraceabilityDecode.ipfsToHttp(cid)`, funzione già
  esistente, prima usata solo per le immagini nell'explorer) in entrambe
  le tabelle.
- **Evidenza dell'hash documento nell'explorer**: l'hash registrato con
  `setDocumentHash`/`setDocumentHashBatch` non compariva da nessuna parte
  nella galleria (privata "Esplora registro" o pubblica explorer.html) —
  solo verificabile leggendo direttamente il contratto. Scelte fatte
  insieme all'utente:
  - **Explorer pubblico**: nessun download del documento originale (resta
    riservato a chi ha accesso alla libreria) — solo un badge "Documento
    registrato" con l'hash abbreviato, più uno strumento di **verifica
    locale**: l'utente sceglie un file dal proprio dispositivo, se ne
    calcola il keccak256 interamente nel browser (nessun byte lasciato
    dal browser) e lo confronta con l'hash on-chain. Stessa cosa
    nell'explorer privato.
  - **Upload "Registra hash documento" per-card**: se un token ha già un
    hash registrato, il bottone di upload sparisce (sostituito dal badge
    + verifica) — il contratto non impedisce la sovrascrittura, quindi il
    gate è lato UI, per evitare rimpiazzi accidentali. Scelta esplicita
    dell'utente rispetto a "permetti sostituzione con conferma".
  - **Backend** (`chainReadRoutes.js`): aggiunta lettura `getDocumentHash`
    (già esistente sul contratto, lettura pubblica come tutte le altre)
    per ogni entry, in parallelo al metadata — nessuna nuova route,
    nessuna nuova autenticazione. `registryAbi.js` esteso con la firma.
  - **Frontend** (`traceability-explorer-ui.js`, condiviso da user.html
    ed explorer.html): nuova funzione `computeFileKeccak256` (richiede
    ethers, ora caricato anche in `explorer.html`), badge + riga di
    verifica renderizzati quando `entry.documentHash` è diverso da
    `bytes32(0)`, riga di upload nascosta nello stesso caso. Ricarica
    della gallery dopo un `setDocumentHash` riuscito, così la card passa
    subito da "upload" a "badge" senza refresh manuale.
- **Testato**: `node --check` su tutti i file JS toccati, bilanciamento
  tag HTML su `user.html`/`explorer.html`, copertura i18n IT/EN (incluso
  un controllo incrociato delle chiavi usate da `traceability-explorer-
  ui.js` contro entrambi i dizionari — le 4 chiavi di upload risultano
  assenti nel dizionario di `explorer.html`, ma per costruzione mai
  raggiunte lì: quella pagina non passa `onSetDocumentHash` alla
  gallery). Test funzionale jsdom dedicato: verifica che la riga di
  upload compaia solo quando l'hash non è impostato e il badge/verifica
  solo quando lo è, su due entry sintetiche.
- **Confermato dal vivo**: badge + verifica compaiono sia nell'explorer
  privato che in quello pubblico per un token con hash registrato; la
  verifica segnala correttamente "mismatch" quando si sceglie un file
  diverso da quello originale.

## 46. Bug trovato subito dopo il deploy: "Registra hash documento" non salvava il file

- **Segnalazione**: appena provato in pratica, il bottone "Registra hash
  documento" nella card della galleria privata prendeva un file dal
  dispositivo, ne calcolava l'hash e lo scriveva on-chain — ma il file
  stesso **non veniva mai pinnato su IPFS**. L'hash risultava verificabile
  (`getDocumentHash` + confronto locale) ma il documento vero e proprio
  irrecuperabile: né dall'azienda che l'aveva "registrato", né da chi
  verifica in seguito. Era rimasto il comportamento della primissima
  versione di questa funzione (da prima del pivot al modello libreria
  documenti del §44), mai aggiornato — segnalato come punto aperto nel
  §44 ("da decidere insieme se serve ancora") e confermato ora dall'uso
  reale.
- **Scelta**: sostituire l'input file con una select che pesca dalla
  libreria documenti già esistente (stesso pattern di `rmDocumentSelect`/
  `batchDocumentSelect` nei form di mint), invece di rimuovere la
  funzionalità — così l'hash scritto on-chain corrisponde SEMPRE a un
  file realmente salvato e scaricabile.
- **Fix** (`traceability-explorer-ui.js`): `createGalleryInstance` accetta
  ora anche `listDocumentsForSelect` (funzione async che ritorna l'elenco
  documenti); la riga di upload per-card mostra una `<select>` invece di
  un `<input type=file>`, popolata una sola volta per l'intero caricamento
  della galleria (la libreria è la stessa per tutto il registry, non
  cambia per token). Il callback `onSetDocumentHash(tokenId, documentHash)`
  ora riceve direttamente l'hash scelto dalla libreria — non più un
  oggetto `File` da hashare in `user.html`, eliminando ogni possibilità
  di disallineamento tra "hash scritto" e "file davvero pinnato".
- **Testato**: `node --check`, test funzionale jsdom dedicato che verifica
  — su una entry senza hash — che compaia la select (non più l'input
  file), che si popoli correttamente dalla libreria fornita (valore
  opzione = `keccak256_hash`, testo = label), e che confermando la
  selezione `onSetDocumentHash` venga chiamato con l'hash della libreria
  (non un file). **Confermato dal vivo**: mint batch con hash allegato in
  fase di mint funziona perfettamente (§44); mint con una sola materia
  prima + un certificato aggregato si riproduce su tutti i tokenId; carica/
  scarica sia libreria documenti che libreria foto funziona; l'explorer
  privato propone la verifica per i tokenId con documento registrato;
  l'explorer pubblico propone la verifica e segnala correttamente il
  mismatch con un file sbagliato; la select "Registra hash documento" per
  card propone i file realmente pinnati su IPFS, e — dopo il fix del §47 —
  si popola correttamente anche su un tokenId che non aveva ricevuto un
  documento in fase di mint, con scrittura dell'hash on-chain riuscita.
  **Ancora non testato**: mint su un tokenId senza tier Gold, mint batch
  senza hash allegato.

## 47. Select "Registra hash documento" vuota su un tokenId non gestito al mint

- **Segnalazione**: dopo aver confermato che il mint batch con hash
  funziona perfettamente, provando a caricare un documento dal lato
  explorer privato (per-card, §46) su un tokenId che NON aveva ricevuto un
  documento durante il mint, la select si apriva **vuota** — nonostante la
  libreria documenti contenesse già file caricati e visibili nel tab
  "Libreria documenti". Confermato via domanda di chiarimento che non si
  trattava di un file picker nativo del sistema operativo (problema di
  cache/refresh), ma proprio della select dell'applicazione, vuota.
- **Causa**: `populateDocumentSelects()` in `traceability-explorer-ui.js`
  avvolgeva la chiamata a `listDocumentsForSelect()` in un `try/catch` che
  **inghiottiva silenziosamente qualsiasi errore** (firma rifiutata dal
  wallet, timeout di rete, verifica fallita lato backend, ecc.) e mostrava
  comunque la select con la sola opzione vuota — risultato identico,
  indistinguibile per l'utente, a "libreria realmente vuota". La libreria
  non era affatto vuota: qualcosa nella chiamata falliva silenziosamente.
- **Fix**: la funzione ora distingue i due casi. Se `listDocumentsForSelect()`
  fallisce, l'errore viene catturato separatamente e mostrato come opzione
  disabilitata dedicata (`card.documentListError`: "Errore caricamento
  libreria: {msg}"), invece di essere confuso con una libreria vuota
  (`common.noneF`: "— nessuna —"). Nuova chiave i18n aggiunta solo in
  `user.html` (IT/EN) — non in `explorer.html`, che non passa mai
  `onSetDocumentHash`/`listDocumentsForSelect` essendo una pagina
  pubblica, sola lettura.
- **Testato**: `node --check` su `traceability-explorer-ui.js`, cross-check
  automatico delle chiavi i18n IT/EN in `user.html` (194 chiavi per
  lingua, nessuna disallineata), test funzionale jsdom dedicato che
  simula sia il caso "libreria vuota" sia il caso "errore nel caricamento"
  e verifica che producano due contenuti HTML distinti per la select (il
  messaggio d'errore compare solo nel secondo caso). **Confermato dal
  vivo**: sullo stesso scenario che aveva fatto emergere il bug (tokenId
  senza documento assegnato al mint), la select ora si popola
  correttamente coi documenti realmente presenti in libreria, e la
  scrittura dell'hash on-chain per quella card funziona regolarmente.

## 48. Generalizzazione multi-settore — design deciso, implementazione in corso

Discussione lunga su come far uscire TraceabilityRegistry da "solo Birra20Venti"
verso più settori/clienti. Riporto qui le decisioni prese, perché toccano
contratto, backend e frontend e si rischia di perderne pezzi tra una sessione
e l'altra.

**Cosa NON serve cambiare (già generico di suo):**
- Il contratto `TraceabilityRegistry` non interpreta mai il JSON: `mintRawMaterialLotBatch`/
  `mintProductionBatch` scrivono `lsp4MetadataValue` come `bytes` opachi. Qualunque
  vocabolario di campi passa senza modifiche al contratto. L'unica struttura
  imposta on-chain è `EntryType` (RawMaterialLot/ProductionBatch) + il vincolo
  che un batch possa referenziare solo lotti — entrambi validi per qualsiasi
  settore, restano invariati.
- Non serve un Factory per settore, né domini/Factory duplicati: un solo
  Factory, un solo backend, un solo nodo IPFS servono tutti i settori.

**Cosa invece varia per settore (tutto lato frontend/off-chain):**
- Le date riconosciute per il batch (`RECOGNIZED_DATE_TRAIT_TYPES_BATCH` in
  `traceability-json-validators.js`) — birra ne ha due (Produzione +
  Imbottigliamento), altri settori una sola.
- I facet-key della galleria (`ALLOWED_FACET_KEYS` in `traceability-explorer-ui.js`).
- (Lo schema materie prime — fornitore/lotto/quantità — resta invece condiviso
  tra tutti i settori "alimentari": diverge solo se un settore ha un concetto
  di acquisto radicalmente diverso.)

**Rinomina decisa**: l'attributo che guida la selezione della foto per un
batch passa da `"Ricetta"` (specifico birra) a `"Codice"` — diventa una
convenzione condivisa da tutti i settori, come già lo è `"Lotto "` per il
collegamento materie-prime→batch. Non è più una voce di config per settore.

**Tre settori iniziali** (nomi scelti per struttura, non per prodotto — così
un cliente futuro con lo stesso pattern non richiede un rename):
- `alimentare_monodata` — una data di produzione, schema materie prime standard.
- `alimentare_bidata` — due date (produzione + imbottigliamento/confezionamento)
  — è lo schema di oggi (Birra20Venti), solo rinominato/generalizzato.
- `industria` — una data, verosimilmente senza il concetto "Codice"/foto-guida.

Anche se `alimentare_monodata` e `industria` partono quasi identici, restano
config separate fin dal primo giorno: condividere codice per una somiglianza
solo coincidentale (non strutturale) costringerebbe a disaccoppiarli sotto
pressione appena uno dei due evolve.

**Come si assegna il settore**: `sectorOf(address)` sul Factory (vedi sotto),
scritto SOLO da ChainIntegrate — mai auto-dichiarabile dall'azienda, perché è
ChainIntegrate a costruire la UI di quel settore ed è un impegno commerciale
(accordo prima dell'attivazione). Riassegnabile in qualunque momento: non
tocca mai i token già mintati (la loro metadata è uno snapshot immutabile),
incide solo su quale UI/config si propone da quel momento in poi per i mint
successivi.

**Come si instradano le UI**: pagine "tipizzate" sotto lo stesso dominio
(`traceability.chainintegrate.it/.../user-alimentare-bidata.html`, ecc.) come
default a costo zero — nessun nuovo DNS, nessun nuovo backend, nessuna
duplicazione delle librerie JS condivise (`traceability-decode.js`,
`traceability-json-validators.js`, `traceability-metadata.js`,
`traceability-mint-compose.js`, `traceability-tokenid.js`,
`traceability-document-library.js`, `traceability-photo-library.js`,
`traceability-explorer-ui.js`, `explorer.html` restano UNICI e condivisi da
tutti i settori). Un sottodominio dedicato (`birrificio.chainintegrate.it`)
resta un'opzione, riservata su richiesta a un cliente importante.

Meccanica concreta della differenziazione tra le pagine `user-*.html`: la
`CONFIG` di `traceability-json-validators.js` è già esposta come oggetto
mutabile (`global.TraceabilityValidators = { CONFIG, ... }`), quindi ogni
pagina di settore la sovrascrive con un paio di righe subito dopo aver
caricato lo script condiviso — nessuna duplicazione di logica. L'unica
eccezione che richiederà una vera modifica di codice (una tantum, non per
ogni settore) è `ALLOWED_FACET_KEYS`, oggi costante interna non esposta in
`traceability-explorer-ui.js`: va promossa a parametro di
`createGalleryInstance({...})`.

**Piano a fasi**:
1. Fase 0 (rifattorizzazione a costo zero, da fare quando capita di toccare
   quei file): rinomina "Ricetta"→"Codice", estrazione date/facet-key in
   config iniettabile.
2. **Fase 1 — Factory (INIZIATA in questa sessione)**: aggiunti a
   `TraceabilityRegistryFactory.sol` — `mapping(address => bytes32) public sectorOf`,
   `function setSector(address account, bytes32 sector) external onlyChainIntegrate`
   (stesso modifier già usato per `setMembershipCorporate`), evento
   `SectorAssigned`, e un require in `deployRegistry` che blocca il deploy se
   `sectorOf[msg.sender] == bytes32(0)` (nessun effetto sul registry già
   esistente di Birra20Venti — vale solo per nuovi deploy da questo momento).
   **Overflow EIP-170 (3° occorrenza) trovato e risolto**: `npx hardhat compile`
   segnalava il Factory a 24923 byte (limite 24576) — stesso meccanismo delle
   volte precedenti (il Factory incorpora nel proprio bytecode il bytecode di
   creazione di `TraceabilityRegistry` via `new TraceabilityRegistry(...)`,
   quindi cresce insieme a lui/alle proprie aggiunte). Risolto stavolta in
   `hardhat.config.js`, non nel contratto: `viaIR` disattivato (non
   risultava necessario per nessuno dei due file, verificato con una
   compilazione locale fuori da Hardhat) e `optimizer.runs` abbassato da 200
   a 1 (accettabile: le funzioni del Factory sono chiamate raramente, una
   tantum per azienda, non un hot path di gas). **Confermato**: `npx hardhat
   compile` ricompila 28 file senza alcun warning.
   **Fatto**: nuovo Factory deployato su testnet e verificato su Blockscout —
   [`0x5979cFcfdCC860C3273B83e89D9FCf4D8a2bfee9`](https://explorer.execution.testnet.lukso.network/address/0x5979cFcfdCC860C3273B83e89D9FCf4D8a2bfee9).
   `FACTORY_ADDRESS` aggiornato in `user-alimentare-bidata.html` e `admin.html`.
   **Fatto**: `.env` del backend sulla VPS aggiornato col nuovo
   `FACTORY_ADDRESS` e `pm2 restart --update-env` eseguito.
   **Testato su testnet, con un'azienda di prova**: `deployRegistry()`
   chiamato SENZA settore assegnato → fallito con l'errore atteso; assegnato
   `alimentare_bidata` via `setSector` (dalla nuova UI in `admin.html`) →
   `deployRegistry()` riuscito. Confermato anche che `admin.html` può
   riassegnare/cambiare il settore di un'azienda già assegnata. Sul nuovo
   registry: mint di un JSON materie prime e di un JSON batch (con
   `"Codice"`, non più `"Ricetta"`) con un lotto in comune tra i due →
   matching lotto→batch corretto e visibile, libreria foto associata via
   `Codice` funzionante. Explorer privato (`user-alimentare-bidata.html`) e
   pubblico (`explorer.html`) verificati sui dati appena mintati, entrambi
   OK. **Confermato indirettamente ma in modo solido che il backend usa il
   Factory nuovo**: ogni chiamata firmata (pin-json, upload foto) passa da
   `verifyRegistryIsKnown()` → `factoryContract.isRegistry(registryAddress)`
   (`backend/authGuard.js`) sulla Factory che il backend ha in memoria — se
   il backend fosse rimasto sul Factory vecchio, queste chiamate sul
   registry nuovo sarebbero fallite per registry non riconosciuto. Il mint
   riuscito è quindi una prova diretta dell'allineamento, non solo un
   indizio.
3. Fase 2 — backend: arricchire `/api/traceability/registry/:address/entries`
   con `sector`, risolto via `registry.registryAdmin()` → `factory.sectorOf(...)`,
   stesso pattern difensivo try/catch già usato per `documentHash` (§45).
   **Non ancora fatta.**
4. **Fase 3 — frontend (IN CORSO, buona parte fatta in questa sessione)**:
   - **Fatto**: `user.html` (Birra20Venti) rinominato in
     `user-alimentare-bidata.html`; `user.html` ora è uno stub di redirect
     automatico (`window.location.replace`) verso il nuovo nome, per non
     rompere i bookmark esistenti.
   - **Fatto**: rinomina "Ricetta"→"Codice" applicata ovunque —
     `traceability-json-validators.js` (`CONFIG.RECIPE_TRAIT_TYPE`→
     `CONFIG.CODE_TRAIT_TYPE`, funzioni di validazione/estrazione),
     `traceability-metadata.js` (commento), `traceability-mint-compose.js`
     (bugfix: `resolvePhoto(extracted.ricetta)`→`resolvePhoto(extracted.codice)`,
     era rimasto un riferimento al vecchio nome), `user-alimentare-bidata.html`
     (label, id, variabili JS, i18n IT/EN). **Non retrocompatibile per
     scelta**: un JSON batch con ancora `"Ricetta"` non valida più — azione
     operativa lato Birra20Venti già segnalata.
   - **Fatto**: `ALLOWED_FACET_KEYS` in `traceability-explorer-ui.js`
     promossa da costante privata del modulo a parametro opzionale
     `facetKeys` di `createGalleryInstance({...})` (default
     `DEFAULT_FACET_KEYS`, backward-compatible — `explorer.html` continua a
     funzionare senza modifiche).
   - **Fatto**: create `user-alimentare-monodata.html` e `user-industria.html`,
     entrambe copiate da `user-alimentare-bidata.html` con l'unica vera
     differenza strutturale — niente campo/logica "Data Imbottigliamento",
     una sola data (obbligatoria, non più "almeno una tra due"), e override
     `TraceabilityValidators.CONFIG.RECOGNIZED_DATE_TRAIT_TYPES_BATCH =
     ["Data Produzione"]` iniettato subito dopo il caricamento dello script
     condiviso (nessuna duplicazione di logica di validazione). Tenute come
     file separati pur essendo oggi identiche, per poterle evolvere in modo
     indipendente (deciso esplicitamente). Nessun'altra rinomina di
     terminologia (es. "materie prime") tentata per `industria`: non esiste
     ancora un cliente reale di quel settore da cui farsi confermare il
     vocabolario giusto.
   - **Fatto**: aggiunto ad `admin.html` un form "Assegna settore" —
     indirizzo azienda + select tra i tre settori noti, pulsanti "Controlla
     settore attuale" (`factory.sectorOf(...)`) e "Assegna settore"
     (`factory.setSector(...)`, hash del nome via `ethers.utils.id(...)`,
     stesso schema di `ENTRY_TYPE_KEY`). Mirror del pattern già esistente
     per `setMembershipCorporate` in questo stesso file.
   - **Fatto**: `alimentare_bidata` assegnato a un'azienda di prova ed
     end-to-end testato su testnet (vedi Fase 1 sopra per il dettaglio).
   - **Fatto**: `user-alimentare-monodata.html` testata live con dati di
     prova (una sola data, matching lotto, explorer) — nessun problema
     strutturale, solo un falso allarme iniziale dovuto a cache del browser
     su uno script condiviso (vedi §49). `user-industria.html` non ancora
     testata direttamente ma è identica strutturalmente a monodata.
   - **Ancora da fare**: generalizzare `explorer.html` a leggere
     `facetKeys`/config da un meccanismo iniettabile invece delle costanti
     fisse (oggi funziona solo perché il default coincide col caso
     Birra20Venti).

## 49. Tier sospeso (0): verifica completa e nuovo gate backend su IPFS

Ultima verifica prevista prima di mainnet (§30): simulare una Membership
Corporate portata a tier 0 e controllare cosa succede su ogni funzione
esposta dalle tre UI di settore.

**Comportamento confermato corretto, senza modifiche**:
- Mint (materie prime + batch): firma del messaggio raggiunta, ma il mint
  non prosegue — coerente col fix già fatto in §40 (`onlyAuthorized` ora
  controlla anche `tierOf(registryAdmin) != 0`).
- Deleghe: operazione va in revert — richiede Silver, coerente.

**Bug trovato e corretto**: il bottone "Carica documento" restava sempre
abilitato a tier 0, mentre quello foto si disabilitava correttamente.
Root cause: `applyMembershipGate()` toccava solo `uploadPhotoBtn`, mai
`uploadDocumentBtn` — un gate aggiunto a suo tempo solo per le foto e mai
esteso quando è arrivata la libreria documenti. Deciso di chiudere anche un
gap più profondo notato nello stesso momento: **nessuna delle due
route di upload aveva mai avuto un controllo di tier lato backend**
(gap già noto ed esplicitamente lasciato aperto in §40, perché il mint
comunque falliva a valle) — ma un'azienda sospesa può comunque intasare il
nodo IPFS self-hosted con upload inutili, indipendentemente dal fatto che
il mint non arriverà mai a buon fine. Non vale la pena lasciare aperta
questa porta solo perché "tanto non serve a niente" — è comunque un modo
per abusare gratuitamente delle risorse.

**Fix**: un solo punto centrale, `backend/authGuard.js` → `verifySignedRequest`
prende un nuovo parametro opzionale `requireActiveTier` (default `false`,
backward-compatible). Se `true`, dopo l'`isAuthorized` legge
`registryAdmin()`/`membershipCorporate()` dal registry e chiama
`tierOf(registryAdmin)` sulla Membership Corporate — stesso identico
pattern già usato per il fix on-chain del mint. Applicato a
`POST /pin-json`, `POST /pin-json-batch`, `POST /upload-photo`,
`POST /upload-document` (le uniche route che aggiungono davvero contenuto a
IPFS). **Lasciate fuori di proposito**: `GET /photos`, `GET /documents`,
`.../hide` — stessa filosofia già applicata a `invalidateEntry` (§40): un
account sospeso deve poter sempre gestire/correggere ciò che ha già,
solo non aggiungerne di nuovo. Testato con un mock di `ethers.Contract`
(nessun nodo reale coinvolto): tier 0 con `requireActiveTier: true` → 403;
tier attivo → ok; `requireActiveTier` omesso o `false` → comportamento
invariato (nessuna regressione sulle route esistenti).

Lato UI, allineato il gate documenti a quello foto su tutte e tre le
pagine `user-*.html`: bottone disabilitato + nota "Membership sospesa" a
tier 0, stesso meccanismo (`applyMembershipGate()`), stessa i18n IT/EN.

**Nota per il futuro**: essendo la logica duplicata in tre file HTML
(nessun meccanismo di config condivisa per questa parte, a differenza del
validatore JSON), un domani cambio a questo gate andrà applicato a mano in
tutte e tre — esattamente il rischio già segnalato in §48 per le pagine
tipizzate.

**Un quarto caso controllato, nessuna modifica necessaria**: "Registra hash
documento" nell'explorer privato (`setDocumentHash`/`setDocumentHashBatch`)
resta chiamabile a tier 0 — e va bene così. È una scrittura on-chain diretta
(`activeRegistry.setDocumentHash(...)`), l'hash è calcolato lato client o
preso dalla libreria già letta, **nessuna chiamata al backend né a IPFS** —
il costo di un tentativo a vuoto è solo il gas dell'azienda sospesa, non una
risorsa nostra. Il contratto la blocca comunque con `onlyGoldFeature`
(richiede tier Gold). Aggiungere un gate qui sarebbe complessità in più per
un rischio che non esiste — a differenza degli upload, dove il costo
ricadeva sul nostro nodo IPFS. **Resta comunque aperto, distinto da questo**:
il punto in §30 "Funzionalità Gold mai esercitata" — qui si è verificato solo
il caso tier 0 (revert atteso), non che `setDocumentHash` funzioni davvero
con un account Gold vero.

## 50. Rifiniture UX: errori comprensibili, messaggi di firma più chiari, pagina "How it works"

Con i test ormai ampi (§40-49), tre rifiniture rivolte a chi usa davvero le
pagine `user-*.html`, non a chi sviluppa:

**1. Errori senza gergo blockchain.** Finora ogni `catch (err)` mostrava
`err.message` grezzo — cioè l'errore ethers/UP così com'è
("execution reverted: TraceabilityRegistry: caller is not authorized", JSON
del provider, ecc.). Nuovo file condiviso
`frontend/traceability-error-messages.js`
(`TraceabilityErrors.friendlyMessage(err, lang)`), incluso dalle tre pagine
`user-*.html`: riconosce le stringhe `require()` note (da
`TraceabilityRegistry.sol`/`TraceabilityRegistryFactory.sol`) e i casi comuni
(firma/transazione annullata dall'utente in UP), e restituisce una frase
comprensibile **nella lingua corrente** — sempre seguita dal dettaglio
tecnico originale tra parentesi (mai al posto suo: serve a chi deve fare
supporto o segnalare un bug). Se una stringa non è in mappa, il fallback resta
onesto ("Operazione non riuscita. Dettaglio tecnico: ...") invece di sparire.
Tutte le circa 20 occorrenze di `{ msg: err.message }` nelle tre pagine sono
state sostituite con `{ msg: TraceabilityErrors.friendlyMessage(err,
currentLang) }`. **Nota di manutenzione**: se cambia (o si aggiunge) una
stringa `require()` nei contratti, va aggiornata anche la mappa in
`traceability-error-messages.js`.

**2. Messaggi di firma (`personal_sign`) più comprensibili.** Le 8 funzioni
`buildXSignedMessage` (pin metadata/batch, upload/list/hide foto,
upload/list/hide documento — duplicate byte-per-byte tra `frontend/*.js` e
`backend/*.js`, necessario perché il backend ricostruisce lo stesso messaggio
per verificare la firma) avevano solo il blocco tecnico
("Registry: .../Content hash: .../Timestamp: ..."), leggibile solo da chi sa
già cosa significa. Aggiunte due righe bilingui (IT poi EN, **sempre
entrambe**, indipendentemente dalla lingua scelta nella UI — necessario:
se il testo dipendesse dalla lingua della sessione, frontend e backend
firmerebbero/verificherebbero byte diversi) prima del blocco tecnico, che
resta invariato:
> Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun
> costo di gas — serve solo a dimostrare che sei davvero tu a chiedere questa
> operazione.
> Signature from your Universal Profile: no on-chain transaction, no gas
> cost — this only proves it's really you, asking for this.

Verificata l'identità byte-per-byte tra le 8 coppie frontend/backend dopo la
modifica (necessaria altrimenti le firme smettono di verificare).

**3. Nuova pagina `frontend/how-it-works.html`.** Guida pratica e non tecnica
(stesso impianto bilingue IT/EN a toggle delle altre pagine, non lo
switch-per-lingua-browser usato su Supplier Trust Registry): cosa sono lotti
e batch, **cosa viene scritto on-chain e cosa viene caricato su IPFS** (col
taglio di chiarezza già usato su Supplier Trust Registry — permanenza
on-chain vs. permanenza "di fatto" su IPFS anche in caso di rimozione dal
nostro nodo, perché chiunque l'abbia scaricato può ripinnarlo altrove),
avviso esplicito di non caricare foto/documenti con dati sensibili (nessun
modo di renderli privati o ritirarli), la differenza pratica tra libreria
documenti (il file finisce su IPFS, pubblico per sempre) e "Registra hash
documento" (il file non lascia mai il tuo computer, solo l'impronta finisce
on-chain), l'esploratore, le deleghe, e perché a volte si firma senza pagare
gas. **Deliberatamente non spiega le categorie di membership/tier**: irrilevante
per capire come funziona il sistema dal lato di chi lo usa. Le 8 funzioni di
firma ora includono anche il link a questa pagina
(`https://traceability.chainintegrate.it/how-it-works.html`) come terza riga
del preambolo, prima del blocco tecnico.

## 51. Firme in formato SIWE (pill cliccabili), una lettura foto sola, backend da riavviare

**Incidente dopo §50**: aprendo un registro arrivavano tre richieste di firma
invece di due, e fallivano tutte. Causa: il backend sul VPS non era stato
riavviato dopo il pull, quindi verificava ancora i messaggi *vecchi* (senza
preambolo) mentre le pagine firmavano già quelli nuovi → "Firma non valida".
Risolto con `pm2 restart`. **Regola**: ogni modifica al testo dei messaggi
firmati richiede di aggiornare frontend e backend insieme **e** di riavviare
il backend (più Ctrl+Shift+R nel browser, gli script non hanno versione).

**Perché tre firme**: `selectRegistry` leggeva la libreria foto due volte
(`refreshPhotoLibrarySelects` + `refreshPhotoLibraryList`), riusando la firma
in cache; ma se la prima lettura falliva la cache veniva svuotata e la
seconda chiedeva una nuova firma. Ora nelle tre pagine `user-*.html` c'è un
solo `refreshPhotoLibrary()` che legge una volta e passa la lista a
`renderPhotoLibrarySelects(photos)` e `renderPhotoLibraryList(photos)` —
anche dopo upload/nascondi foto. In caso di errore: un solo messaggio, nessuna
firma extra.

**Messaggi di firma in formato SIWE (EIP-4361)** — sostituisce il preambolo
di §50. Scoperto dal vivo: la UP extension mostra un messaggio di testo
libero tutto di seguito (a capo e righe vuote ignorati, link non cliccabili),
mentre riconosce il formato "Sign-In with Ethereum" e lo mostra strutturato:
badge "SIWE", lo *statement* come testo, e ogni riga di *Resources* come link
cliccabile (pill). Quindi ora ogni firma è un messaggio SIWE:
- **Statement**: una riga (vincolo EIP-4361), `[IT] ... [EN] ...` più
  `[Operazione / Operation: List photos]`. **Solo ASCII**: niente lettere
  accentate né trattino lungo, altrimenti il parser non riconosce il formato.
- **Resources** (le pill): `how-it-works.html` e
  `explorer.html?registry=<indirizzo>` (il registro su cui si sta operando).
- **Nonce** = keccak256 del vecchio blocco tecnico (Registry/Label/Content
  hash/Timestamp, le funzioni `buildXSignedMessage` di sempre): i dettagli non
  sono più mostrati per esteso ma restano coperti dalla firma — se ne cambia
  anche uno, il nonce ricostruito dal backend è diverso e la firma non verifica.
- **Domain/URI**: frontend `window.location.host/origin`, backend
  `ALLOWED_MINT_UI_ORIGIN` (coincidono per forza: è l'unica origin ammessa dal
  CORS delle route firmate). **Chain ID**: `signer.getChainId()` /
  `provider.getNetwork()`. **Issued At**: dal timestamp già usato per la
  freschezza (resta il controllo dei 5 minuti, nessun nonce lato server).

Codice: `backend/siweMessage.js` e `frontend/traceability-siwe.js`
(`buildSiweMessage`, duplicato byte-per-byte), avvolgimento in un solo punto
per lato: `TraceabilitySiwe.signDetails()` (8 punti di firma frontend) e
`verifySignedRequest()` in `authGuard.js` (unico punto di verifica backend).
`traceability-siwe.js` va incluso prima di mint-compose/photo/document library
nelle pagine `user-*.html`. **Testato** (Node, EOA al posto della UP): messaggio
frontend == backend per tutte le 8 operazioni, `verifySignedRequest` accetta
la firma e rifiuta un blocco tecnico alterato, e il messaggio è accettato dal
parser ABNF rigoroso della libreria di riferimento `siwe` (e `verify()` ok).
**Da verificare dal vivo** che la UP extension lo mostri come nello screenshot
Stakingverse (badge SIWE + pill).

## 52. Errori comprensibili anche nei popup delle card (hash documento, annullamento)

Trovato provando "Registra hash documento" con un account Silver (revert
atteso, `requires Gold tier`): il popup mostrava ancora l'errore grezzo.
Due cause:
- `traceability-explorer-ui.js` (modulo condiviso, card del tab "Esplora")
  non era stato toccato da §50: i suoi `window.alert` usavano `err.message`.
  Ora `createGalleryInstance({... formatError })` accetta un traduttore
  opzionale; le tre pagine `user-*.html` passano
  `TraceabilityErrors.friendlyMessage(err, currentLang)`. L'explorer pubblico
  non lo passa e resta sul messaggio grezzo (non include il modulo errori).
- Anche quando tradotto, il "dettaglio tecnico" tra parentesi era l'intero
  messaggio ethers (transazione, JSON del provider, codici). Ora
  `traceability-error-messages.js` isola la sola frase di revert del
  contratto: da `err.reason`, dal testo "execution reverted: ...", o
  decodificando i dati grezzi `Error(string)` (0x08c379a0) quando la UP
  extension restituisce solo quelli; cerca anche negli errori annidati
  (`err.error`, `err.data`, ...). Se non c'è un revert, prima frase del
  messaggio, max 160 caratteri. Risultato:
  > Registrazione dell'hash del documento non riuscita. Questa funzione
  > richiede una membership Gold. (dettaglio tecnico: TraceabilityRegistry:
  > requires Gold tier)

Testato in Node su tre forme d'errore (ethers estimateGas, solo dati
revert codificati, errore sconosciuto) più il rifiuto utente.

**Pulsante "Registra hash documento" disattivato se non Gold.** Nuovo
parametro opzionale `canSetDocumentHash()` di `createGalleryInstance`: se
ritorna false la card mostra il pulsante disattivato con la nota "Richiede
membership Gold." e nessuna select (quindi niente caricamento della libreria
documenti, niente firma, niente transazione destinata al revert). Le pagine
`user-*.html` lo passano come `activeRegistryTier === null ||
activeRegistryTier >= GOLD_TIER` (`GOLD_TIER = 3`, come nel contratto): con
tier non ancora letto resta attivo e decide il contratto. `activeRegistryTier`
ora viene azzerato a ogni `selectRegistry`, per non ereditare il tier del
registro aperto prima. Le select documento dei form di mint restano invece
utilizzabili (etichetta "richiede tier Gold" già presente).

## 53. Membership sospesa (tier 0) scambiata per "serve Gold"

A tier 0 il contratto rifiuta `setDocumentHash` con `requires Gold tier` (e
`addDelegate` con `not allowed to manage delegates`): la soglia Gold/Silver
fallisce prima di qualunque controllo esplicito sulla sospensione, quindi il
messaggio del contratto non distingue i due casi. Il contratto non si tocca
(servirebbe un redeploy); la distinzione la fa il frontend, che il tier lo
conosce già:
- `TraceabilityErrors.friendlyMessage(err, lang, { tier })`: le voci della
  mappa marcate `alsoWhenSuspended` (Gold, deleghe) a `tier === 0` diventano
  "La membership collegata a questo registro è sospesa…", sempre col
  dettaglio tecnico originale. Le pagine `user-*.html` passano
  `{ tier: activeRegistryTier }` in tutte le chiamate.
- `canSetDocumentHash()` ora può restituire la nota da mostrare: a tier 0
  "Membership sospesa." invece di "Richiede membership Gold.".
- Nota tier nella sezione deleghe: a tier 0 "membership sospesa" invece di
  "serve Silver o superiore".

**Metadata collezione allineati (tier 0).** Il salvataggio dei metadata
della collezione passa da `pin-json`, già rifiutato dal backend a tier 0
(§49), ma lato UI il pulsante restava attivo, a differenza di foto e
documenti. Ora `applyMembershipGate()` disattiva anche
`saveCollectionMetadataBtn` e mostra la nota "Membership sospesa: modifica
dei metadata disabilitata."; il click handler ha lo stesso controllo
anticipato degli upload. (On-chain `setRegistryMetadata` resta
`onlyRegistryAdmin` senza controllo di tier: il blocco è sul pin IPFS.)

## 39. Punti aperti / TODO

- [x] Confermare import esatti e versione `@lukso/lsp8-contracts` /
      `@lukso/lsp4-contracts` — **confermato**: la compilazione Hardhat
      reale (28 file) e il deploy testnet riuscito provano che le versioni
      risolte da `^0.15.0` funzionano correttamente.
- [x] `_LSP4_TOKEN_TYPE_NFT` — **era sbagliata**, non esiste come costante
      esportata (confermato da un vero errore di compilazione `HH600`).
      Corretto: è semplicemente il valore numerico `1`, non un identificatore
      con nome — coerente con `lsp4-metadata-notes.md`.
- [x] `_LSP8_TOKENID_FORMAT_HASH` — **confermata corretta**: compilazione
      completa riuscita (28 file Solidity) dopo la correzione sopra.
- [x] Confermare che `tierOf()` su Membership Corporate ritorni `0` anche per
      un'azienda sospesa — **risolto** (§40): non era un bug di `tierOf()`,
      ma un buco nel mint (`onlyAuthorized` non controllava mai il tier).
      Aggiunto `require(tierOf(registryAdmin) != 0)` a `onlyAuthorized`.
      Richiede un nuovo deploy della Factory per essere effettivo (i
      registri già esistenti restano sul bytecode vecchio).
- [x] `SILVER_TIER = 2` — **confermato indirettamente**: la delega concessa
      con successo durante i test reali richiede che `tierOf(registryAdmin)`
      ritorni davvero `>= 2` per l'account usato, altrimenti `addDelegate`
      sarebbe stato rifiutato on-chain. `GOLD_TIER = 3` resta **non
      verificato**: la funzionalità Gold (`setDocumentHash`) non è mai stata
      esercitata nemmeno una volta.
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
- [x] Configurare `.env` di produzione — **fatto**: `FACTORY_ADDRESS`,
      `ALLOWED_MINT_UI_ORIGIN`, chiave RPC dedicata, tutto configurato e in
      esecuzione da settimane di test reali su `traceability.chainintegrate.it`.
- [x] Data di scadenza opzionale (materie prime) — **già così**, verificato:
      non è nei campi obbligatori né nello schema né nel validatore.
- [x] Annullamento registrazione — **già implementato** (`invalidateEntry`,
      mai burn, resta visibile on-chain, escluso dai nuovi collegamenti).
- [x] Membership Corporate aggiornabile — **fatto** (§16), sia su Factory
      che su ogni singolo TraceabilityRegistry.
- [x] Metadata di collezione con square+banner — **fatto** (§17).
- [x] Client frontend libreria foto — **fatto** (§18).
- [x] **Verificare con un vero compilatore Solidity (`solc`/Hardhat)** le
      modifiche ai contratti — **chiuso, verificato con la cronologia git**:
      `contracts/TraceabilityRegistry.sol` e `TraceabilityRegistryFactory.sol`
      non hanno subito **nessuna** modifica dopo il commit `346f31f` (il fix
      `_LSP4_TOKEN_TYPE_NFT`), che è esattamente il codice compilato con
      successo e deployato su testnet. Questo include `setMembershipCorporate`
      su entrambi i contratti — **temevo fosse stato aggiunto dopo il deploy
      e quindi assente dal bytecode live, ma la cronologia conferma che era
      già presente prima**: nessun redeploy necessario, la funzione dovrebbe
      già funzionare sui contratti reali (mai chiamata per davvero, però —
      la verifica di compilazione è chiusa, quella funzionale sul campo no).

## 10. Prossimi passi (storico — tutto completato)

1. ~~Funzione di calcolo `tokenId`~~ — **fatto** (§7).
2. ~~Costruttore metadata LSP4~~ — **fatto** (§8), testato su dati reali.
3. ~~`POST /api/traceability/pin-json` (backend)~~ — **fatto** (§8).
4. ~~Script di orchestrazione lato client~~ — **fatto** (§9).
5. ~~UI di mint~~ — **fatto**, ampiamente superato: `user.html` copre mint,
   libreria foto, deleghe, metadata collezione, annullamento, esplorazione.
6. ~~Deploy Hardhat (testnet) di Factory + primo Registry~~ — **fatto**,
   Factory verificata su Blockscout, registro Birra20Venti live con dati
   reali (20+ lotti, batch, annullamenti).
7. ~~Widget di visualizzazione~~ — **fatto**, ampiamente superato:
   `explorer.html` con filtri, ricerca trasversale, motivo annullamento.

## 30. Cosa manca davvero prima di mainnet

Bilancio a freddo dopo settimane di test reali su testnet.

**Decisioni da prendere (non blocchi tecnici):**
- **Convivenza testnet/mainnet**: `traceability.chainintegrate.it` serve
  oggi solo testnet (`FACTORY_ADDRESS` testnet nel `.env` e nelle pagine
  `user-*.html`/`admin.html`). Per mainnet serve decidere: nuovo
  dominio/porta dedicati che convivono col testnet (come
  `matchpredictor`/`playmatchpredictor`), o si sostituisce la
  configurazione quando si è pronti a smettere di testare?
- ~~Bilinguismo dei metadata on-chain~~ — **deciso** (§19): resta solo il
  chrome della UI a tradursi, il contenuto della metadata resta nella
  lingua in cui l'azienda l'ha scritto, nessuna traduzione automatica.

**Verifiche mai fatte sul campo, a basso rischio ma da chiudere:**
- ~~`tierOf()` per un'azienda sospesa~~ — **fatto** (§49): mint, materie
  prime, deleghe e upload libreria tutti confermati bloccati/coerenti a
  tier 0; trovato e corretto un gap reale (upload documenti non era
  gated né lato UI né lato backend).
- Funzionalità Gold (`setDocumentHash`, hash fattura privata) — mai
  esercitata nemmeno una volta, a differenza di Silver (deleghe, confermate
  funzionanti sul campo).

**Da fare meccanicamente quando si decide di procedere:**
- `npm run deploy:mainnet` (già pronto, indirizzi Membership Corporate e
  ChainIntegrate owner mainnet già cablati in `scripts/deploy.js`).
- Assegnare il settore a Birra20Venti sul Factory mainnet via `setSector`
  (§48) — senza, `deployRegistry()` fallisce anche su mainnet.
- Aggiornare `CONFIG.FACTORY_ADDRESS` in `user-alimentare-bidata.html`/
  `admin.html`/`explorer.html` e `FACTORY_ADDRESS`/`LUKSO_RPC_URL` nel
  `.env` del backend con i valori mainnet (chiave RPC dedicata **nuova**,
  mai quella testnet).
- Verificare il nuovo contratto su Blockscout mainnet (stesso comando
  `hardhat verify`, rete `luksoMainnet`).

**Non è emerso nessun altro gap strutturale** dalla revisione — la parte
più a rischio che temevo (mismatch tra contratto deployato e sorgente nel
repo) si è rivelata infondata dopo aver controllato la cronologia git.