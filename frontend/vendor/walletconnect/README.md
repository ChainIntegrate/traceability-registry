# vendor/walletconnect

File di terze parti per il collegamento con **UP Wallet** (estensione del
browser e app Android di ChainIntegrate) tramite WalletConnect, usati da
`traceability-walletconnect.js`. Sono gli stessi file di
[Cross_Chain](https://github.com/ChainIntegrate/Cross_Chain/tree/main/vendor)
(commit `4c3c5a9`), copiati senza modifiche: la ricetta per ricostruirli è nel
suo `vendor/README.md`.

| File | Origine | SHA-256 |
|---|---|---|
| `signclient-2.25.0.min.js` | `@walletconnect/sign-client` 2.25.0 (+ core e utils 2.25.0), bundle esbuild, espone `window.SignClientBundle` | `3bc27e35fce1194c0a454f6ef07d210b8718152e23c76fcbfa6546a1b9d673c8` |
| `qrcode-generator-1.4.4.js` | `qrcode-generator` 1.4.4 (MIT), `qrcode.js` del pacchetto npm | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |

Caricati solo quando serve (pulsante "Connetti con UP Wallet") e con
**Subresource Integrity**: i valori `sha384-…` sono in
`traceability-walletconnect.js` (`WC_SRI`, `QR_SRI`). Se un file cambia, il
browser lo rifiuta; per aggiornarlo:

```bash
openssl dgst -sha384 -binary signclient-2.25.0.min.js | openssl base64 -A
```

**Telemetria**: il client viene creato con `telemetryEnabled: false` e il suo
client degli eventi viene zittito prima dell'avvio. Verso Reown resta solo la
connessione al relay.

**Licenze**: i pacchetti Reown / WalletConnect sono sotto la WalletConnect
Community License Agreement (non open source), copia in
`WalletConnect-Community-License.md`; la finestra di collegamento mostra
"Portions © 2025 Reown, Inc. All Rights Reserved". Gli altri pacchetti del
bundle (MIT, ISC, 0BSD, Apache-2.0) sono elencati con le loro licenze in
`signclient-2.25.0.THIRD-PARTY.txt`. `qrcode-generator`: MIT.
