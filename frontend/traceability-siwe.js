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

  const SIWE_STATEMENT =
    "[IT] Firma di conferma dalla tua Universal Profile: non è un pagamento, non costa nulla " +
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
  };

  function buildSiweMessage({ domain, uri, address, chainId, registryAddress, details, timestamp }) {
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
  async function signDetails(signer, registryAddress, details, timestamp) {
    const message = buildSiweMessage({
      domain: global.location.host,
      uri: global.location.origin,
      address: await signer.getAddress(),
      chainId: await signer.getChainId(),
      registryAddress,
      details,
      timestamp,
    });
    return signer.signMessage(message); // apre la UP extension
  }

  global.TraceabilitySiwe = {
    SIWE_STATEMENT: SIWE_STATEMENT,
    buildSiweMessage: buildSiweMessage,
    signDetails: signDetails,
  };
})(typeof window !== "undefined" ? window : globalThis);
