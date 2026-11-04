/**
 * TraceabilityRegistry — involucro SIWE (EIP-4361) dei messaggi firmati (vanilla JS).
 *
 * La UP extension riconosce i messaggi "Sign-In with Ethereum" e li mostra
 * strutturati: lo statement come testo, ogni riga di "Resources" come link
 * cliccabile. Il blocco tecnico dell'operazione (buildXSignedMessage) entra
 * come Nonce = keccak256 del blocco, quindi la firma copre ancora tutti i
 * dettagli. Spiegazione completa in backend/siweMessage.js.
 *
 * ATTENZIONE — buildSiweMessage è un duplicato byte-per-byte di
 * backend/siweMessage.js: se cambia qui va cambiato anche lì, e il backend
 * va riavviato insieme al deploy del frontend.
 *
 * Richiede ethers v5 già caricato in pagina. Va incluso PRIMA di
 * traceability-mint-compose.js, traceability-photo-library.js e
 * traceability-document-library.js.
 */
(function (global) {
  "use strict";

  function requireEthers() {
    if (typeof ethers === "undefined") {
      throw new Error("ethers.js non trovato: includere lo script ethers v5 prima di questo modulo.");
    }
    return ethers;
  }

  // SOLO caratteri ASCII ammessi da EIP-4361 (niente lettere accentate): con
  // un carattere fuori standard la UP extension non riconosce il messaggio
  // SIWE e lo mostra come testo grezzo, senza i link cliccabili.
  const SIWE_STATEMENT =
    "[IT] Firma di conferma dalla tua Universal Profile: non si tratta di un pagamento, non costa nulla " +
    "e non scrive niente sulla blockchain. Serve solo a dimostrare che sei davvero tu a chiedere questa operazione. " +
    "[EN] Confirmation signature from your Universal Profile: it is not a payment, costs nothing " +
    "and writes nothing on the blockchain. It only proves it's really you asking for this.";

  // Nome dell'operazione mostrato nel messaggio da firmare, in italiano e
  // inglese. Deve restare IDENTICO tra frontend/traceability-siwe.js e
  // backend/siweMessage.js: il backend ricostruisce il messaggio e lo confronta.
  const OPERATION_LABELS = {
    "Upload document": "Caricamento documento / Upload document",
    "List documents": "Elenco documenti / List documents",
    "Hide document": "Nascondi documento / Hide document",
    "Download document": "Scarica documento / Download document",
    "Upload photo": "Caricamento foto / Upload photo",
    "List photos": "Elenco foto / List photos",
    "Hide photo": "Nascondi foto / Hide photo",
    "Pin metadata": "Salvataggio dati / Save data",
    "Pin metadata batch": "Salvataggio dati / Save data",
    "Read library": "Consultazione delle librerie, valida 1 ora / Library access, valid 1 hour",
  };

  function buildSiweMessage({ domain, uri, address, chainId, registryAddress, details, timestamp, expiresAt }) {
    const e = requireEthers();
    const rawOperation = details.split("\n")[0].replace("ChainIntegrate TraceabilityRegistry - ", "");
    const operation = OPERATION_LABELS[rawOperation] || rawOperation;
    const nonce = e.utils.keccak256(e.utils.toUtf8Bytes(details)).slice(2);
    const issuedAt = new Date(timestamp * 1000).toISOString();
    return (
      domain + " wants you to sign in with your Ethereum account:\n" +
      e.utils.getAddress(address) + "\n" +
      "\n" +
      SIWE_STATEMENT + " [Operazione / Operation: " + operation + "]\n" +
      "\n" +
      "URI: " + uri + "\n" +
      "Version: 1\n" +
      "Chain ID: " + chainId + "\n" +
      "Nonce: " + nonce + "\n" +
      "Issued At: " + issuedAt + "\n" +
      // Solo per le firme valide più a lungo (consultazione delle librerie):
      // la UP extension mostra la scadenza.
      (expiresAt ? "Expiration Time: " + new Date(expiresAt * 1000).toISOString() + "\n" : "") +
      "Resources:\n" +
      "- " + uri + "/how-it-works.html\n" +
      "- " + uri + "/explorer.html?registry=" + e.utils.getAddress(registryAddress)
    );
  }

  /**
   * Firma il blocco tecnico `details` avvolto in SIWE. Dominio e URI sono
   * quelli della pagina corrente: il backend usa ALLOWED_MINT_UI_ORIGIN, che
   * coincide per forza (è l'unica origin ammessa dal CORS delle route firmate).
   */
  async function signDetails(signer, registryAddress, details, timestamp, expiresAt) {
    const message = buildSiweMessage({
      domain: global.location.host,
      uri: global.location.origin,
      address: await signer.getAddress(),
      chainId: await signer.getChainId(),
      registryAddress,
      details,
      timestamp,
      expiresAt,
    });
    return signer.signMessage(message); // apre la UP extension
  }

  // -----------------------------------------------------------------------
  // Firma di consultazione delle librerie (elenco foto e documenti): UNA sola
  // firma per entrambe, valida 1 ora (backend: LIBRARY_READ_MAX_AGE_SECONDS),
  // riusata finché mancano almeno 5 minuti alla scadenza. Prima erano due
  // firme da 5 minuti, chieste di nuovo di continuo durante l'uso.
  // -----------------------------------------------------------------------
  const LIBRARY_READ_MAX_AGE_SECONDS = 3600;
  const LIBRARY_READ_REUSE_MARGIN_SECONDS = 300;
  const libraryReadCache = {};

  /** Blocco firmato: identico a backend/authGuard.js (buildLibraryReadSignedMessage). */
  function buildLibraryReadSignedMessage(registryAddress, timestamp) {
    return (
      "ChainIntegrate TraceabilityRegistry - Read library\n" +
      "Registry: " + registryAddress + "\n" +
      "Timestamp: " + timestamp
    );
  }

  /** @returns {Promise<{signerAddress, timestamp, signature}>} firma valida,
   * riusata se recente. Richieste contemporanee (foto e documenti caricati
   * insieme) condividono la stessa richiesta di firma. */
  async function getLibraryReadSignature(signer, registryAddress) {
    const signerAddress = await signer.getAddress();
    const key = String(registryAddress).toLowerCase() + ":" + signerAddress.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const cached = libraryReadCache[key];
    if (cached && cached.pending) return cached.pending;
    if (cached && now - cached.timestamp < LIBRARY_READ_MAX_AGE_SECONDS - LIBRARY_READ_REUSE_MARGIN_SECONDS) {
      return { signerAddress, timestamp: cached.timestamp, signature: cached.signature };
    }
    const pending = (async () => {
      const timestamp = now;
      const message = buildLibraryReadSignedMessage(registryAddress, timestamp);
      const signature = await signDetails(signer, registryAddress, message, timestamp, timestamp + LIBRARY_READ_MAX_AGE_SECONDS);
      libraryReadCache[key] = { timestamp, signature };
      return { signerAddress, timestamp, signature };
    })();
    libraryReadCache[key] = { pending };
    try {
      return await pending;
    } catch (err) {
      delete libraryReadCache[key]; // firma annullata o fallita: si richiede la prossima volta
      throw err;
    }
  }

  /** Dopo un rifiuto del backend (es. firma scaduta): la prossima volta se ne chiede una nuova. */
  function invalidateLibraryReadSignature(signerAddress, registryAddress) {
    delete libraryReadCache[String(registryAddress).toLowerCase() + ":" + String(signerAddress).toLowerCase()];
  }

  global.TraceabilitySiwe = {
    SIWE_STATEMENT: SIWE_STATEMENT,
    buildSiweMessage: buildSiweMessage,
    signDetails: signDetails,
    buildLibraryReadSignedMessage: buildLibraryReadSignedMessage,
    getLibraryReadSignature: getLibraryReadSignature,
    invalidateLibraryReadSignature: invalidateLibraryReadSignature,
  };
})(typeof window !== "undefined" ? window : globalThis);
