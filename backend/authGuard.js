const { ethers } = require("ethers");
const { verifyErc1271Signature } = require("./erc1271");
const { buildSiweMessage } = require("./siweMessage");
const { TRACEABILITY_REGISTRY_MINIMAL_ABI, MEMBERSHIP_CORPORATE_MINIMAL_ABI } = require("./registryAbi");

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
 * @param {boolean} [requireActiveTier=false] - se true, dopo l'autorizzazione
 *        controlla anche `tierOf(registryAdmin)` sulla Membership Corporate
 *        del registry e rifiuta se sospesa/mai avuta (tier 0). Introdotto in
 *        §49 per le route che aggiungono davvero contenuto a IPFS
 *        (pin-json, upload-photo, upload-document) — un'azienda sospesa non
 *        deve poter usare il nodo IPFS solo perché il mint fallirebbe
 *        comunque a valle. Le route che NON aggiungono contenuto (list,
 *        hide) restano volutamente escluse, stessa filosofia già applicata a
 *        `invalidateEntry`: un'azienda sospesa può sempre gestire/correggere
 *        quello che ha già, solo non aggiungerne di nuovo.
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 *          L'errore ritornato è sempre un messaggio generico e sicuro da
 *          mostrare al client — il dettaglio va loggato a parte dal chiamante.
 */
async function verifySignedRequest({ provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp, requireActiveTier = false }) {
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

  // `message` è il blocco tecnico dell'operazione: il testo firmato davvero
  // è il suo involucro SIWE (backend/siweMessage.js), con dominio/URI della
  // UI ufficiale — l'unica origin ammessa dal CORS delle route firmate.
  let siweMessage;
  try {
    const uiOrigin = new URL(process.env.ALLOWED_MINT_UI_ORIGIN);
    const { chainId } = await provider.getNetwork();
    siweMessage = buildSiweMessage({
      domain: uiOrigin.host, uri: uiOrigin.origin, address: signerAddress, chainId,
      registryAddress, details: message, timestamp,
    });
  } catch (err) {
    console.error("verifySignedRequest: impossibile costruire il messaggio SIWE:", err.message);
    return { ok: false, status: 400, error: "Verifica firma non riuscita." };
  }

  let validSignature;
  try {
    validSignature = await verifyErc1271Signature(provider, signerAddress, siweMessage, signature);
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

  if (requireActiveTier) {
    let tier;
    try {
      const registryAdmin = await registry.registryAdmin();
      const membershipAddr = await registry.membershipCorporate();
      const membership = new ethers.Contract(membershipAddr, MEMBERSHIP_CORPORATE_MINIMAL_ABI, provider);
      tier = (await membership.tierOf(registryAdmin)).toNumber();
    } catch (err) {
      console.error("verifySignedRequest: errore verifica tier:", err.message);
      return { ok: false, status: 400, error: "Impossibile verificare la membership di questo registry." };
    }
    if (tier === 0) {
      return { ok: false, status: 403, error: "Membership sospesa o mai attiva: upload non consentito." };
    }
  }

  return { ok: true };
}

module.exports = { verifySignedRequest, verifyRegistryIsKnown, MAX_SIGNATURE_AGE_SECONDS };