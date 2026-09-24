const express = require("express");
const multer = require("multer");
const { ethers } = require("ethers");
const { pinFileToIpfs } = require("./ipfsClient");
const { verifySignedRequest } = require("./authGuard");
const { insertDocument, listDocumentsByRegistry, hideDocument, getDocumentById } = require("./db");

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16MB — certificati/DDT scansionati possono pesare più di una foto
const MAX_LABEL_LENGTH = 200;
// Niente SVG/HTML: possono contenere script, stesso motivo già applicato alla libreria foto.
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(), // mai su disco: serve solo il tempo di hashare+pinnare
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Stesso motivo del middleware equivalente in photoRoutes.js: senza
 * questo, un file troppo grande finisce nel gestore di errori di default
 * di Express (pagina HTML), mai nel nostro try/catch. */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File troppo grande (limite " + MAX_UPLOAD_BYTES + " byte)." });
    }
    return res.status(400).json({ error: "Upload non valido: " + err.code });
  }
  if (err) {
    console.error("upload-document: errore multer non gestito:", err);
    return res.status(500).json({ error: "Errore interno durante l'upload." });
  }
  next();
}

// Preambolo comune a TUTTI i messaggi da firmare: italiano, inglese e link
// alla guida, ognuno nel suo capoverso (riga vuota in mezzo) perché la UP
// extension li mostri separati. Duplicato byte-per-byte tra frontend
// (traceability-*.js) e backend (*Routes.js): se cambia qui, va cambiato
// in tutti e sei i file, e il backend va riavviato insieme al deploy del
// frontend — altrimenti ogni firma viene rifiutata.
const SIGN_PREAMBLE =
  "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
  "\n" +
  "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
  "\n" +
  "Come funziona / How it works: https://traceability.chainintegrate.it/how-it-works.html\n" +
  "\n";

/** ATTENZIONE: se la usi anche lato frontend, deve restare identica lì
 * (stesso principio già segnalato per buildSignedMessage). */
function buildDocumentUploadSignedMessage(registryAddress, label, contentHash, timestamp) {
  return (
    SIGN_PREAMBLE +
    "ChainIntegrate TraceabilityRegistry - Upload document\n" +
    "Registry: " + registryAddress + "\n" +
    "Label: " + label + "\n" +
    "Content hash: " + contentHash + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildDocumentListSignedMessage(registryAddress, timestamp) {
  return (
    SIGN_PREAMBLE +
    "ChainIntegrate TraceabilityRegistry - List documents\n" +
    "Registry: " + registryAddress + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildDocumentHideSignedMessage(registryAddress, documentId, timestamp) {
  return (
    SIGN_PREAMBLE +
    "ChainIntegrate TraceabilityRegistry - Hide document\n" +
    "Registry: " + registryAddress + "\n" +
    "Document id: " + documentId + "\n" +
    "Timestamp: " + timestamp
  );
}

/**
 * @param {ethers.providers.Provider} provider
 * @param {ethers.Contract} factoryContract - per verificare che registryAddress
 *        sia stato davvero deployato dalla Factory ChainIntegrate.
 */
function buildDocumentRouter(provider, factoryContract) {
  const router = express.Router();

  router.post("/upload-document", upload.single("file"), handleMulterError, async (req, res) => {
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
        return res.status(400).json({ error: "file mancante (campo 'file')." });
      }
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return res.status(415).json({
          error: "Tipo di file non consentito (" + file.mimetype + "). Ammessi: " + Array.from(ALLOWED_MIME_TYPES).join(", ") + ".",
        });
      }

      // Hash ricalcolato SERVER-SIDE dai byte ricevuti, mai da un campo
      // dichiarato dal client — è questo hash che finirà su
      // setDocumentHash/setDocumentHashBatch, deve essere quello vero.
      const contentHash = ethers.utils.keccak256(file.buffer);
      const message = buildDocumentUploadSignedMessage(registryAddress, label.trim(), contentHash, timestamp);

      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
        requireActiveTier: true, // §49: aggiunge contenuto a IPFS, non solo lettura/gestione
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const cid = await pinFileToIpfs(file.buffer, file.originalname || "document", file.mimetype);

      const record = insertDocument({
        registryAddress,
        label: label.trim(),
        cid,
        keccak256Hash: contentHash,
        mimeType: file.mimetype,
        originalName: file.originalname || null,
        uploadedBy: signerAddress,
      });

      return res.json({ document: record });
    } catch (err) {
      console.error("POST /api/traceability/upload-document errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /** Non pubblica, stesso motivo della libreria foto. */
  router.get("/documents", async (req, res) => {
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

      const message = buildDocumentListSignedMessage(registryAddress, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const documents = listDocumentsByRegistry(registryAddress);
      return res.json({ documents });
    } catch (err) {
      console.error("GET /api/traceability/documents errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /** Mai una vera cancellazione — stessa filosofia della libreria foto. */
  router.post("/documents/:id/hide", async (req, res) => {
    try {
      const documentId = Number(req.params.id);
      const { registryAddress, signerAddress, signature } = req.body || {};
      const timestamp = Number((req.body || {}).timestamp);

      if (!Number.isInteger(documentId)) {
        return res.status(400).json({ error: "id documento non valido." });
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

      const existing = getDocumentById(documentId);
      if (!existing || existing.registry_address !== registryAddress) {
        return res.status(404).json({ error: "Documento non trovato su questo registry." });
      }

      const message = buildDocumentHideSignedMessage(registryAddress, documentId, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      const updated = hideDocument(documentId);
      return res.json({ document: updated });
    } catch (err) {
      console.error("POST /api/traceability/documents/:id/hide errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  return router;
}

module.exports = {
  buildDocumentRouter,
  buildDocumentUploadSignedMessage,
  buildDocumentListSignedMessage,
  buildDocumentHideSignedMessage,
};