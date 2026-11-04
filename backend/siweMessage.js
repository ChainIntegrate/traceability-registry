/**
 * TraceabilityRegistry backend — involucro SIWE (EIP-4361) dei messaggi firmati.
 *
 * Perché: la UP extension riconosce i messaggi in formato "Sign-In with
 * Ethereum" e li mostra in modo strutturato — lo "statement" come testo
 * leggibile e ogni riga di "Resources" come link cliccabile (pill). Un
 * messaggio di testo libero invece viene mostrato tutto di seguito, a capo
 * e righe vuote compresi.
 *
 * Il blocco tecnico di ogni operazione ("ChainIntegrate TraceabilityRegistry
 * - Upload photo / Registry / Label / Content hash / Timestamp", costruito
 * dalle funzioni buildXSignedMessage) NON compare più per esteso: entra nel
 * messaggio come Nonce = keccak256 del blocco. La firma quindi copre ancora
 * tutti i dettagli dell'operazione — se anche uno solo cambia, il nonce
 * ricostruito dal backend è diverso e la firma non verifica.
 *
 * ATTENZIONE — duplicato byte-per-byte di frontend/traceability-siwe.js
 * (buildSiweMessage). Se cambia qui va cambiato anche lì, e il backend va
 * riavviato insieme al deploy del frontend: altrimenti ogni firma viene
 * rifiutata.
 *
 * Vincolo EIP-4361: lo statement è UNA riga, solo caratteri ASCII "da URI"
 * (niente lettere accentate, niente trattino lungo) — altrimenti l'extension
 * non riconosce il formato e ricade sulla vista a testo semplice.
 */
const { ethers } = require("ethers");

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

/**
 * @param {object} p
 * @param {string} p.domain - host della UI (es. "traceability.chainintegrate.it")
 * @param {string} p.uri - origin della UI (es. "https://traceability.chainintegrate.it")
 * @param {string} p.address - indirizzo della UP che firma (verrà normalizzato EIP-55)
 * @param {number} p.chainId
 * @param {string} p.registryAddress
 * @param {string} p.details - blocco tecnico dell'operazione (buildXSignedMessage)
 * @param {number} p.timestamp - secondi Unix, lo stesso già verificato per freschezza
 * @param {number} [p.expiresAt] - secondi Unix: aggiunge "Expiration Time"
 */
function buildSiweMessage({ domain, uri, address, chainId, registryAddress, details, timestamp, expiresAt }) {
  const rawOperation = details.split("\n")[0].replace("ChainIntegrate TraceabilityRegistry - ", "");
  const operation = OPERATION_LABELS[rawOperation] || rawOperation;
  const nonce = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(details)).slice(2);
  const issuedAt = new Date(timestamp * 1000).toISOString();
  return (
    domain + " wants you to sign in with your Ethereum account:\n" +
    ethers.utils.getAddress(address) + "\n" +
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
    "- " + uri + "/explorer.html?registry=" + ethers.utils.getAddress(registryAddress)
  );
}

module.exports = { buildSiweMessage, SIWE_STATEMENT };
