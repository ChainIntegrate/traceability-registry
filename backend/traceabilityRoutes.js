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

  return router;
}

module.exports = { buildTraceabilityRouter, buildSignedMessage };
