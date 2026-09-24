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

const SIWE_STATEMENT =
  "[IT] Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas. " +
  "Serve solo a dimostrare che sei davvero tu a chiedere questa operazione. " +
  "[EN] Signature from your Universal Profile: no on-chain transaction, no gas cost. " +
  "It only proves it's really you asking for this.";

/**
 * @param {object} p
 * @param {string} p.domain - host della UI (es. "traceability.chainintegrate.it")
 * @param {string} p.uri - origin della UI (es. "https://traceability.chainintegrate.it")
 * @param {string} p.address - indirizzo della UP che firma (verrà normalizzato EIP-55)
 * @param {number} p.chainId
 * @param {string} p.registryAddress
 * @param {string} p.details - blocco tecnico dell'operazione (buildXSignedMessage)
 * @param {number} p.timestamp - secondi Unix, lo stesso già verificato per freschezza
 */
function buildSiweMessage({ domain, uri, address, chainId, registryAddress, details, timestamp }) {
  const operation = details.split("\n")[0].replace("ChainIntegrate TraceabilityRegistry - ", "");
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
    "Resources:\n" +
    "- " + uri + "/how-it-works.html\n" +
    "- " + uri + "/explorer.html?registry=" + ethers.utils.getAddress(registryAddress)
  );
}

module.exports = { buildSiweMessage, SIWE_STATEMENT };
