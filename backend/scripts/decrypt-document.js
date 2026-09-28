/**
 * Recupero di un documento cifrato con la sola chiave madre — funziona anche
 * se il database è andato perso. Il file su IPFS contiene già la propria
 * chiave, chiusa con la chiave madre (vedi ../documentCrypto.js).
 *
 * Uso (dalla cartella backend/, con DOCUMENT_MASTER_KEY nel .env):
 *
 *   node scripts/decrypt-document.js <CID oppure file.trdoc> <file-di-uscita> [impronta-attesa]
 *
 * Esempi:
 *   node scripts/decrypt-document.js QmXyz... fattura.pdf
 *   node scripts/decrypt-document.js QmXyz... fattura.pdf 0x7a3f...   # verifica anche l'impronta on-chain
 *
 * Se il primo argomento è un file esistente lo legge dal disco, altrimenti lo
 * tratta come CID e lo chiede al nodo IPFS (IPFS_API_URL).
 */
require("dotenv").config();
const fs = require("fs");
const { ethers } = require("ethers");
const { loadMasterKey, decryptDocument, isEncryptedDocument } = require("../documentCrypto");
const { catFromIpfs } = require("../ipfsClient");

async function main() {
  const [, , source, output, expectedHash] = process.argv;
  if (!source || !output) {
    console.error("Uso: node scripts/decrypt-document.js <CID|file.trdoc> <file-di-uscita> [impronta-attesa]");
    process.exit(1);
  }

  const masterKey = loadMasterKey();
  if (!masterKey) {
    console.error("DOCUMENT_MASTER_KEY non impostata nel .env.");
    process.exit(1);
  }

  const blob = fs.existsSync(source) ? fs.readFileSync(source) : await catFromIpfs(source);
  if (!isEncryptedDocument(blob)) {
    console.error("Il file non è un documento cifrato (manca l'intestazione TRDOC1): probabilmente è un documento caricato prima della cifratura, già leggibile così com'è.");
    process.exit(1);
  }

  const original = decryptDocument(blob, masterKey);
  const hash = ethers.utils.keccak256(original);
  fs.writeFileSync(output, original);
  console.log("Scritto " + output + " (" + original.length + " byte).");
  console.log("Impronta keccak256: " + hash);

  if (expectedHash) {
    if (hash.toLowerCase() === expectedHash.toLowerCase()) {
      console.log("OK: coincide con l'impronta attesa.");
    } else {
      console.error("ATTENZIONE: NON coincide con l'impronta attesa " + expectedHash + ".");
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error("Errore:", err.message);
  process.exit(1);
});
