const express = require("express");
const multer = require("multer");
const sizeOf = require("image-size");
const { ethers } = require("ethers");
const { pinFileToIpfs } = require("./ipfsClient");
const { verifySignedRequest } = require("./authGuard");
const { insertPhoto, listPhotosByRegistry, hidePhoto, getPhotoById } = require("./db");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB, generoso per foto prodotto/ricetta
const MAX_LABEL_LENGTH = 200;
// Niente SVG: può contenere script, rischio se mai mostrato inline in un browser.
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const upload = multer({
  storage: multer.memoryStorage(), // mai su disco: serve solo il tempo di hashare+pinnare
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Middleware di errore per multer — SENZA questo, un file troppo grande
 * finiva nel gestore di errori di default di Express (pagina HTML), mai nel
 * nostro try/catch: multer fallisce PRIMA del nostro handler, non dentro. */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File troppo grande (limite " + MAX_UPLOAD_BYTES + " byte)." });
    }
    return res.status(400).json({ error: "Upload non valido: " + err.code });
  }
  if (err) {
    console.error("upload-photo: errore multer non gestito:", err);
    return res.status(500).json({ error: "Errore interno durante l'upload." });
  }
  next();
}

/** ATTENZIONE: se la usi anche lato frontend, deve restare identica lì (stesso
 * principio già segnalato per buildSignedMessage in traceability-mint-compose.js). */
function buildPhotoUploadSignedMessage(registryAddress, label, contentHash, timestamp) {
  return (
    "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
    "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
    "Come funziona: https://traceability.chainintegrate.it/how-it-works.html\n" +
    "\n" +
    "ChainIntegrate TraceabilityRegistry - Upload photo\n" +
    "Registry: " + registryAddress + "\n" +
    "Label: " + label + "\n" +
    "Content hash: " + contentHash + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildPhotoListSignedMessage(registryAddress, timestamp) {
  return (
    "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
    "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
    "Come funziona: https://traceability.chainintegrate.it/how-it-works.html\n" +
    "\n" +
    "ChainIntegrate TraceabilityRegistry - List photos\n" +
    "Registry: " + registryAddress + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildPhotoHideSignedMessage(registryAddress, photoId, timestamp) {
  return (
    "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
    "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
    "Come funziona: https://traceability.chainintegrate.it/how-it-works.html\n" +
    "\n" +
    "ChainIntegrate TraceabilityRegistry - Hide photo\n" +
    "Registry: " + registryAddress + "\n" +
    "Photo id: " + photoId + "\n" +
    "Timestamp: " + timestamp
  );
}

/**
 * @param {ethers.providers.Provider} provider
 * @param {ethers.Contract} factoryContract - per verificare che registryAddress
 *        sia stato davvero deployato dalla Factory ChainIntegrate.
 */
function buildPhotoRouter(provider, factoryContract) {
  const router = express.Router();

  router.post("/upload-photo", upload.single("file"), handleMulterError, async (req, res) => {
    try {
      const body = req.body || {};
      const { registryAddress, signerAddress, label, signature } = body;
      const timestamp = Number(body.timestamp);
      const file = req.file;

      if (!registryAddress || !ethers.utils.isAddress(registryAddress)) {
        return res.status(400).json({ error: "registryAddress mancante o non valido." });
      }
      if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
        return res.status(400).json({ error: "signerAddress mancante o non valido." });
      }
      if (!label || typeof label !== "string" || !label.trim()) {
        return res.status(400).json({ error: "label mancante o vuota." });
      }
      if (label.trim().length > MAX_LABEL_LENGTH) {
        return res.status(400).json({ error: "label troppo lunga (limite " + MAX_LABEL_LENGTH + " caratteri)." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante." });
      }
      if (!file || !file.buffer || !file.buffer.length) {
        return res.status(400).json({ error: "file immagine mancante (campo 'file')." });
      }
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return res.status(415).json({
          error: "Tipo di file non consentito (" + file.mimetype + "). Ammessi: " + Array.from(ALLOWED_MIME_TYPES).join(", ") + ".",
        });
      }

      // Hash ricalcolato SERVER-SIDE dai byte ricevuti, mai da un campo dichiarato dal client.
      const contentHash = ethers.utils.keccak256(file.buffer);
      const message = buildPhotoUploadSignedMessage(registryAddress, label.trim(), contentHash, timestamp);

      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
        requireActiveTier: true, // §49: aggiunge contenuto a IPFS, non solo lettura/gestione
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      let width = null;
      let height = null;
      try {
        const dims = sizeOf(file.buffer);
        width = dims.width || null;
        height = dims.height || null;
      } catch (err) {
        console.warn("upload-photo: impossibile determinare le dimensioni:", err.message);
      }

      const cid = await pinFileToIpfs(file.buffer, file.originalname || "photo", file.mimetype);

      const record = insertPhoto({
        registryAddress,
        label: label.trim(),
        cid,
        keccak256Hash: contentHash,
        width,
        height,
        mimeType: file.mimetype,
        uploadedBy: signerAddress,
      });

      return res.json({ photo: record });
    } catch (err) {
      console.error("POST /api/traceability/upload-photo errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /** Non pubblica: la libreria può contenere immagini non ancora usate in
   * nessun mint pubblico — diverso dai dati già mintati (quelli sì restano
   * pubblici per design). */
  router.get("/photos", async (req, res) => {
    try {
      const { registryAddress, signerAddress, signature } = req.query;
      const timestamp = Number(req.query.timestamp);

      if (!registryAddress || !ethers.utils.isAddress(String(registryAddress))) {
        return res.status(400).json({ error: "registryAddress mancante o non valido (query string)." });
      }
      if (!signerAddress || !ethers.utils.isAddress(String(signerAddress))) {
        return res.status(400).json({ error: "signerAddress mancante o non valido (query string)." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante (query string)." });
      }

      const message = buildPhotoListSignedMessage(registryAddress, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const photos = listPhotosByRegistry(registryAddress);
      return res.json({ photos });
    } catch (err) {
      console.error("GET /api/traceability/photos errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /** Mai una vera cancellazione — stessa filosofia di invalidateEntry on-chain:
   * una foto caricata per errore si nasconde, non sparisce. */
  router.post("/photos/:id/hide", async (req, res) => {
    try {
      const photoId = Number(req.params.id);
      const { registryAddress, signerAddress, signature } = req.body || {};
      const timestamp = Number((req.body || {}).timestamp);

      if (!Number.isInteger(photoId)) {
        return res.status(400).json({ error: "id foto non valido." });
      }
      if (!registryAddress || !ethers.utils.isAddress(registryAddress)) {
        return res.status(400).json({ error: "registryAddress mancante o non valido." });
      }
      if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
        return res.status(400).json({ error: "signerAddress mancante o non valido." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante." });
      }

      const existing = getPhotoById(photoId);
      if (!existing || existing.registry_address !== registryAddress) {
        return res.status(404).json({ error: "Foto non trovata su questo registry." });
      }

      const message = buildPhotoHideSignedMessage(registryAddress, photoId, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const updated = hidePhoto(photoId);
      return res.json({ photo: updated });
    } catch (err) {
      console.error("POST /api/traceability/photos/:id/hide errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  return router;
}

module.exports = {
  buildPhotoRouter,
  buildPhotoUploadSignedMessage,
  buildPhotoListSignedMessage,
  buildPhotoHideSignedMessage,
};