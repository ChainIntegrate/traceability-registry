const express = require("express");
const { ethers } = require("ethers");
const { pinJsonToIpfs } = require("./ipfsClient");
const { verifySignedRequest } = require("./authGuard");

/**
 * Messaggio in chiaro che la UP deve firmare (personal_sign). Lega insieme
 * registry + contenuto (via hash, non il JSON intero — il messaggio deve
 * restare leggibile nella UP extension) + timestamp anti-replay.
 * Esportata perché anche il frontend deve costruire ESATTAMENTE lo stesso
 * messaggio per firmarlo.
 */
function buildSignedMessage(registryAddress, metadataJsonString, timestamp) {
  const contentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(metadataJsonString));
  return (
    "ChainIntegrate TraceabilityRegistry - Pin metadata\n" +
    "Registry: " + registryAddress + "\n" +
    "Content hash: " + contentHash + "\n" +
    "Timestamp: " + timestamp
  );
}

const MAX_BATCH_ITEMS = 200; // generoso per un acquisto reale, limite anti-abuso

/**
 * Hash aggregato di N contenuti, nell'ORDINE dato — una sola firma copre
 * tutto l'array invece di una firma per elemento (motivo: un JSON acquisto
 * con N materie prime richiedeva N pop-up di firma UP, uno per elemento,
 * perché buildSignedMessage() lega la firma al content hash di UN solo
 * JSON). L'ordine conta: cambiare l'ordine degli elementi cambia l'hash
 * aggregato, quindi frontend e backend devono processare l'array nello
 * stesso ordine in cui è stato firmato (qui: l'ordine ricevuto).
 */
function computeAggregateHash(contentHashes) {
  return ethers.utils.keccak256(ethers.utils.concat(contentHashes));
}

function buildBatchSignedMessage(registryAddress, aggregateHash, count, timestamp) {
  return (
    "ChainIntegrate TraceabilityRegistry - Pin metadata batch\n" +
    "Registry: " + registryAddress + "\n" +
    "Count: " + count + "\n" +
    "Aggregate hash: " + aggregateHash + "\n" +
    "Timestamp: " + timestamp
  );
}

/**
 * @param {ethers.providers.Provider} provider
 * @param {ethers.Contract} factoryContract - per verificare che registryAddress
 *        sia stato davvero deployato dalla Factory ChainIntegrate.
 */
function buildTraceabilityRouter(provider, factoryContract) {
  const router = express.Router();

  router.post("/pin-json", async (req, res) => {
    try {
      const body = req.body || {};
      const { registryAddress, signerAddress, metadataJsonString, signature } = body;
      const timestamp = Number(body.timestamp);

      if (!registryAddress || !ethers.utils.isAddress(registryAddress)) {
        return res.status(400).json({ error: "registryAddress mancante o non valido." });
      }
      if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
        return res.status(400).json({ error: "signerAddress mancante o non valido." });
      }
      if (typeof metadataJsonString !== "string" || !metadataJsonString.trim()) {
        return res.status(400).json({ error: "metadataJsonString mancante o vuoto." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante." });
      }

      const message = buildSignedMessage(registryAddress, metadataJsonString, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
        requireActiveTier: true, // §49: pin su IPFS, non solo lettura/gestione
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const cid = await pinJsonToIpfs(metadataJsonString);
      return res.json({ cid });
    } catch (err) {
      console.error("POST /api/traceability/pin-json errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /**
   * Una firma sola per N contenuti — vedi computeAggregateHash. Pinna ogni
   * elemento separatamente (ognuno resta un file IPFS indipendente, stessa
   * struttura di sempre — nessun JSON cumulativo, non tocca l'explorer),
   * ma la firma UP viene chiesta una volta sola per l'intero import.
   */
  router.post("/pin-json-batch", async (req, res) => {
    try {
      const body = req.body || {};
      const { registryAddress, signerAddress, metadataJsonStrings, signature } = body;
      const timestamp = Number(body.timestamp);

      if (!registryAddress || !ethers.utils.isAddress(registryAddress)) {
        return res.status(400).json({ error: "registryAddress mancante o non valido." });
      }
      if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
        return res.status(400).json({ error: "signerAddress mancante o non valido." });
      }
      if (!Array.isArray(metadataJsonStrings) || metadataJsonStrings.length === 0) {
        return res.status(400).json({ error: "metadataJsonStrings mancante o vuoto (deve essere un array non vuoto)." });
      }
      if (metadataJsonStrings.length > MAX_BATCH_ITEMS) {
        return res.status(400).json({ error: "Troppi elementi (limite " + MAX_BATCH_ITEMS + ")." });
      }
      if (metadataJsonStrings.some((s) => typeof s !== "string" || !s.trim())) {
        return res.status(400).json({ error: "Ogni elemento di metadataJsonStrings deve essere una stringa JSON non vuota." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante." });
      }

      // Hash ricalcolati SERVER-SIDE dal contenuto ricevuto, mai da un
      // aggregato dichiarato dal client — stesso principio già seguito per
      // le foto (contentHash ricalcolato dai byte, non dal client).
      const contentHashes = metadataJsonStrings.map((s) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s)));
      const aggregateHash = computeAggregateHash(contentHashes);
      const message = buildBatchSignedMessage(registryAddress, aggregateHash, metadataJsonStrings.length, timestamp);

      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
        requireActiveTier: true, // §49: pin su IPFS, non solo lettura/gestione
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      // Sequenziale, non Promise.all: evita di bombardare il nodo IPFS
      // self-hosted con N richieste concorrenti per un solo import.
      const cids = [];
      for (const jsonString of metadataJsonStrings) {
        cids.push(await pinJsonToIpfs(jsonString));
      }

      return res.json({ cids });
    } catch (err) {
      console.error("POST /api/traceability/pin-json-batch errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  return router;
}

module.exports = { buildTraceabilityRouter, buildSignedMessage, buildBatchSignedMessage, computeAggregateHash };