# Librerie di terze parti (self-hosted)

Le pagine non caricano librerie da CDN: le servono dallo stesso dominio, con
versione fissata. Motivo (audit §56 in `docs/STORICO.md`): una libreria presa
da CDN senza versione fissata cambia senza preavviso, e il codice gira su pagine
collegate alla Universal Profile dell'utente.

| File | Libreria | Versione | Licenza | Origine |
|---|---|---|---|---|
| `ethers-5.7.2.umd.min.js` | [ethers](https://github.com/ethers-io/ethers.js) | 5.7.2 | MIT | `ethers@5.7.2/dist/ethers.umd.min.js` dal pacchetto npm, invariato |
| `erc725-0.28.2.esm.min.js` | [@erc725/erc725.js](https://github.com/ERC725Alliance/erc725.js) | 0.28.2 | Apache-2.0 | bundle ESM unico generato da npm (vedi sotto); licenze delle dipendenze in coda al file |

SHA-256:

```
a66293a6a2bb4dee061a68612be0be3c5c0ab7e4068ab8d98a4a357baf664c73  ethers-5.7.2.umd.min.js
7732baab258c628878d4b72aa6f78b21f343730aeb4ade57f77278ecbc90783e  erc725-0.28.2.esm.min.js
```

## Rigenerare il bundle erc725.js

Solo se si decide di aggiornare la versione (in quel caso aggiornare anche il
nome del file, i due `import()` in `traceability-decode.js` e
`traceability-mint-compose.js`, e questa tabella):

```bash
npm i @erc725/erc725.js@0.28.2 esbuild
echo 'export { ERC725 } from "@erc725/erc725.js";' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify \
  --legal-comments=eof --outfile=erc725-0.28.2.esm.min.js
# poi in testa al file la riga di licenza:
# /*! @erc725/erc725.js 0.28.2 | Apache-2.0 | https://github.com/ERC725Alliance/erc725.js | ... */
```

Verifica fatta alla generazione: `ERC725.encodeData` sul bundle, in Chromium,
produce lo stesso valore LSP4Metadata (VerifiableURI) della libreria eseguita in
Node, e `decodeData` lo rilegge correttamente.
