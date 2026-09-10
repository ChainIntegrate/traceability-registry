const { ethers } = require("ethers");
const { verifyErc1271Signature } = require("./erc1271");
const { TRACEABILITY_REGISTRY_MINIMAL_ABI } = require("./registryAbi");

const MAX_SIGNATURE_AGE_SECONDS = parseInt(process.env.MAX_SIGNATURE_AGE_SECONDS || "300", 10);

/**
 * Verifica che registryAddress sia stato davvero deployato dalla nostra
 * Factory — senza questo controllo, chiunque potrebbe puntare un contratto
 * proprio (con una isAuthorized() che ritorna sempre true) al nostro
 * backend e usare gratis IPFS/RPC. Usata sia dalle route firmate sia da
 * quella di sola lettura pubblica (chainReadRoutes) — il rischio di abuso
 * del nodo RPC esiste comunque anche senza firma.
 */
async function verifyRegistryIsKnown(factoryContract, registryAddress) {
  try {
    return await factoryContract.isRegistry(registryAddress);
  } catch (err) {
    throw new Error("Impossibile verificare la legittimità del registry presso la Factory: " + err.message);
  }
}

/**
 * Blocco di verifica unico, condiviso da tutte le route che richiedono una
 * firma UP: freschezza del timestamp, legittimità del registry, firma
 * ERC-1271, autorizzazione on-chain. Prima era copiato a mano in tre punti
 * diversi — un copia-incolla dimenticato in una copia è già causa del bug
 * (GET /photos partita senza controllo). Ora un solo punto da mantenere.
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 *          L'errore ritornato è sempre un messaggio generico e sicuro da
 *          mostrare al client — il dettaglio va loggato a parte dal chiamante.
 */
async function verifySignedRequest({ provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { ok: false, status: 400, error: "timestamp mancante o non numerico." };
  }
  if (Math.abs(nowSeconds - timestamp) > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, status: 401, error: "Firma scaduta o timestamp non plausibile." };
  }

  let known;
  try {
    known = await verifyRegistryIsKnown(factoryContract, registryAddress);
  } catch (err) {
    console.error("verifySignedRequest: errore verifica Factory:", err.message);
    return { ok: false, status: 400, error: "Impossibile verificare il registry." };
  }
  if (!known) {
    return { ok: false, status: 403, error: "registryAddress non riconosciuto (non deployato dalla Factory ChainIntegrate)." };
  }

  let validSignature;
  try {
    validSignature = await verifyErc1271Signature(provider, signerAddress, message, signature);
  } catch (err) {
    console.error("verifySignedRequest: errore verifica ERC-1271:", err.message);
    return { ok: false, status: 400, error: "Verifica firma non riuscita." };
  }
  if (!validSignature) {
    return { ok: false, status: 401, error: "Firma non valida per l'indirizzo dichiarato." };
  }

  const registry = new ethers.Contract(registryAddress, TRACEABILITY_REGISTRY_MINIMAL_ABI, provider);
  let authorized;
  try {
    authorized = await registry.isAuthorized(signerAddress);
  } catch (err) {
    console.error("verifySignedRequest: errore isAuthorized:", err.message);
    return { ok: false, status: 400, error: "Impossibile verificare l'autorizzazione su questo registry." };
  }
  if (!authorized) {
    return { ok: false, status: 403, error: "Indirizzo non autorizzato (né registryAdmin né delegato) su questo registry." };
  }

  return { ok: true };
}

module.exports = { verifySignedRequest, verifyRegistryIsKnown, MAX_SIGNATURE_AGE_SECONDS };
