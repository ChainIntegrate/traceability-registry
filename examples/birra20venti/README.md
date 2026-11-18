# Pagine del sito di Birra20Venti dal registro Track & Trace

`Batch.html` e `Materie_Prime.html` del sito di Birra20Venti, che prima leggevano
i vecchi token ERC721 e ora leggono il registro di tracciabilità su LUKSO mainnet
(`0xf60ca7d63db8baaaa4e2b2d34ad24d7aa9d40409`), che contiene anche quei dati.

- Stessa struttura, grafica (nero/oro, Rajdhani), meta, intro, CTA e footer degli
  originali: cambia solo lo script che carica i dati, più un link al registro
  nell'intro.
- Dati dall'API pubblica del backend (`/api/traceability/registry/<indirizzo>/entries`,
  CORS aperto in lettura) e metadata dal gateway IPFS `ipfs.chainintegrate.it`.
  Nessun wallet, nessun RPC diretto.
- **Batch**: una card per batch; le righe "Lotto …" portano alla pagina delle
  materie prime sul lotto giusto (una voce per consegna, con avviso se
  acquistata dopo la produzione); batch senza foto → foto del batch più recente
  con lo stesso Codice.
- **Materie prime**: una card per acquisto (fornitore + data) con la tabella dei
  materiali e la colonna "Usato nei batch".
- Il titolo di ogni card apre la scheda su Track & Trace
  (`explorer.html?registry=…&type=batch|lot&token=…`).
- Tutto il testo dei metadata è inserito con escape.

Per un'altra azienda: cambiare `REGISTRY` (e, se diversi, `BATCH_PAGE` /
`LOTS_PAGE`) nello script.
