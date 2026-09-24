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
    "[IT] Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas. " +
    "Serve solo a dimostrare che sei davvero tu a chiedere questa operazione. " +
    "[EN] Signature from your Universal Profile: no on-chain transaction, no gas cost. " +
    "It only proves it's really you asking for this.";

  function buildSiweMessage({ domain, uri, address, chainId, registryAddress, details, timestamp }) {
    const e = requireEthers();
    const operation = details.split("\n")[0].replace("ChainIntegrate TraceabilityRegistry - ", "");
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
