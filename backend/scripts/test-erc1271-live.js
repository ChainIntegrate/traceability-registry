/**
 * DA ESEGUIRE MANUALMENTE SU TESTNET prima di qualunque deploy reale.
 *
 * Verifica l'assunzione critica mai testata di erc1271.js: che
 * ethers.utils.hashMessage(message) (EIP-191, personal_sign standard) sia
 * il formato che la UP extension usa davvero per produrre firme verificabili
 * via isValidSignature() sul contratto della UP. Se la UP extension o il Key
 * Manager (LSP6) usano una convenzione diversa, OGNI firma del backend
 * verrebbe rifiutata sempre, silenziosamente — sembrerebbe "firma sbagliata"
 * invece che "formato sbagliato".
 *
 * USO:
 *   1. Apri una pagina con la UP browser extension connessa a una UP testnet.
 *   2. Firma un messaggio qualsiasi con signer.signMessage(message) (ethers v5).
 *   3. Esegui: node scripts/test-erc1271-live.js "<upAddress>" "<message>" "<signature>"
 *
 * Se stampa "OK: firma valida", il formato è confermato corretto e il resto
 * del backend è affidabile. Se stampa "FALLITO", NON deployare in
 * produzione finché non si capisce quale formato la UP usa davvero.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { verifyErc1271Signature } = require("../erc1271");

async function main() {
  const [, , upAddress, message, signature] = process.argv;

  if (!upAddress || !message || !signature) {
    console.error("Uso: node test-erc1271-live.js <upAddress> <message> <signature>");
    process.exit(1);
  }
  if (!ethers.utils.isAddress(upAddress)) {
    console.error("upAddress non è un indirizzo valido:", upAddress);
    process.exit(1);
  }
  if (!process.env.LUKSO_RPC_URL) {
    console.error("LUKSO_RPC_URL mancante in .env — serve un RPC testnet vero per questo test.");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.LUKSO_RPC_URL);

  console.log("UP address:", upAddress);
  console.log("Messaggio:", JSON.stringify(message));
  console.log("Firma:", signature);
  console.log("Digest EIP-191 calcolato:", ethers.utils.hashMessage(message));
  console.log("Verifica in corso...");

  try {
    const valid = await verifyErc1271Signature(provider, upAddress, message, signature);
    if (valid) {
      console.log("OK: firma valida — il formato EIP-191/hashMessage è confermato corretto.");
    } else {
      console.log("FALLITO: isValidSignature ha risposto, ma il valore non combacia col magic value EIP-1271.");
      console.log("Possibile causa: la UP usa una convenzione di hashing diversa da EIP-191 standard.");
    }
  } catch (err) {
    console.error("FALLITO: errore durante la verifica —", err.message);
    console.error("Possibile causa: upAddress non è una UP valida, o RPC irraggiungibile.");
  }
}

main();
