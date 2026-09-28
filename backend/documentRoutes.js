const express = require("express");
const multer = require("multer");
const { ethers } = require("ethers");
const { pinFileToIpfs, catFromIpfs } = require("./ipfsClient");
const { loadMasterKey, encryptDocument, decryptDocument, HEADER_LENGTH } = require("./documentCrypto");
const { verifySignedRequest } = require("./authGuard");
const { insertDocument, listDocumentsByRegistry, hideDocument, getDocumentById , normalizeRegistryAddress } = require("./db");

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

/** ATTENZIONE: se la usi anche lato frontend, deve restare identica lì
 * (stesso principio già segnalato per buildSignedMessage). */
function buildDocumentUploadSignedMessage(registryAddress, label, contentHash, timestamp) {
  return (
    "ChainIntegrate TraceabilityRegistry - Upload document\n" +
    "Registry: " + registryAddress + "\n" +
    "Label: " + label + "\n" +
    "Content hash: " + contentHash + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildDocumentListSignedMessage(registryAddress, timestamp) {
  return (
    "ChainIntegrate TraceabilityRegistry - List documents\n" +
    "Registry: " + registryAddress + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildDocumentHideSignedMessage(registryAddress, documentId, timestamp) {
  return (
    "ChainIntegrate TraceabilityRegistry - Hide document\n" +
    "Registry: " + registryAddress + "\n" +
    "Document id: " + documentId + "\n" +
    "Timestamp: " + timestamp
  );
}

function buildDocumentDownloadSignedMessage(registryAddress, documentId, timestamp) {
  return (
    "ChainIntegrate TraceabilityRegistry - Download document\n" +
    "Registry: " + registryAddress + "\n" +
    "Document id: " + documentId + "\n" +
    "Timestamp: " + timestamp
  );
}

/** Nome file sicuro per l'header Content-Disposition: solo caratteri ASCII
 * innocui nella versione semplice, nome completo codificato in filename*. */
function contentDisposition(originalName) {
  const name = String(originalName || "documento").slice(0, 200);
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_") || "documento";
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name);
}

/**
 * @param {ethers.providers.Provider} provider
 * @param {ethers.Contract} factoryContract - per verificare che registryAddress
 *        sia stato davvero deployato dalla Factory ChainIntegrate.
 */
function buildDocumentRouter(provider, factoryContract) {
  const router = express.Router();

  // Chiave madre per la cifratura dei documenti (documentCrypto.js). Letta
  // una volta all'avvio: se è configurata male il backend si ferma subito
  // (loadMasterKey lancia), se manca gli upload di documenti vengono
  // rifiutati — mai un ripiego silenzioso sul caricamento in chiaro.
  const masterKey = loadMasterKey();
  if (!masterKey) {
    console.warn("DOCUMENT_MASTER_KEY non impostata: upload e download di documenti cifrati disattivati (vedi docs/CHIAVE-DOCUMENTI.md).");
  }

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
      if (!masterKey) {
        return res.status(503).json({ error: "Cifratura dei documenti non configurata sul server: upload non disponibile." });
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

      // Su IPFS va solo il file cifrato; l'impronta (contentHash, sopra) resta
      // quella del file originale ed è quella che finisce on-chain.
      const encryptedBlob = encryptDocument(file.buffer, masterKey);
      const cid = await pinFileToIpfs(encryptedBlob, "document.trdoc", "application/octet-stream");

      const record = insertDocument({
        registryAddress,
        label: label.trim(),
        cid,
        keccak256Hash: contentHash,
        mimeType: file.mimetype,
        originalName: file.originalname || null,
        uploadedBy: signerAddress,
        encrypted: true,
      });

      return res.json({ document: record });
    } catch (err) {
      console.error("POST /api/traceability/upload-document errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  /** Non pubblica, stesso motivo della libreria foto. */
  /** Lista della libreria: firma richiesta, riusata dal client per 5 minuti.
   * POST /documents/list (firma nel corpo) è quella usata dalle pagine: una
   * firma nella query string finisce nei log di accesso di nginx e resta
   * riutilizzabile finché è valida (audit §56 punto 9). GET resta solo per
   * compatibilità con pagine ancora in cache nel browser; da togliere. */
  async function listDocuments(req, res, source) {
    try {
      const { registryAddress, signerAddress, signature } = source;
      const timestamp = Number(source.timestamp);

      if (!registryAddress || !ethers.utils.isAddress(String(registryAddress))) {
        return res.status(400).json({ error: "registryAddress mancante o non valido." });
      }
      if (!signerAddress || !ethers.utils.isAddress(String(signerAddress))) {
        return res.status(400).json({ error: "signerAddress mancante o non valido." });
      }
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ error: "signature mancante." });
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
      console.error("GET/POST /api/traceability/documents errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  }
  router.post("/documents/list", (req, res) => listDocuments(req, res, req.body || {}));
  router.get("/documents", (req, res) => listDocuments(req, res, req.query));

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
      if (!existing || existing.registry_address !== normalizeRegistryAddress(registryAddress)) {
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

  /**
   * Download del documento originale, solo per chi è autorizzato sul registro
   * (firma SIWE). Il backend rilegge il file dal proprio nodo IPFS, lo
   * decifra e controlla che la sua impronta coincida con quella registrata:
   * così si restituisce esattamente il file la cui impronta è on-chain.
   * Non richiede una membership attiva: un'azienda sospesa deve poter
   * recuperare i propri documenti (stessa filosofia di list/hide).
   * POST e non GET: la firma viaggia nel corpo, non finisce nei log degli URL.
   */
  router.post("/documents/:id/download", async (req, res) => {
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
      if (!existing || existing.registry_address !== normalizeRegistryAddress(registryAddress)) {
        return res.status(404).json({ error: "Documento non trovato su questo registry." });
      }

      const message = buildDocumentDownloadSignedMessage(registryAddress, documentId, timestamp);
      const verification = await verifySignedRequest({
        provider, factoryContract, registryAddress, signerAddress, message, signature, timestamp,
      });
      if (!verification.ok) {
        return res.status(verification.status).json({ error: verification.error });
      }

      if (existing.encrypted && !masterKey) {
        return res.status(503).json({ error: "Cifratura dei documenti non configurata sul server: download non disponibile." });
      }

      const stored = await catFromIpfs(existing.cid, MAX_UPLOAD_BYTES + HEADER_LENGTH);
      const original = existing.encrypted ? decryptDocument(stored, masterKey) : stored;

      if (ethers.utils.keccak256(original).toLowerCase() !== String(existing.keccak256_hash).toLowerCase()) {
        console.error("download documento " + documentId + ": impronta del file diversa da quella registrata.");
        return res.status(500).json({ error: "Il file recuperato non corrisponde all'impronta registrata." });
      }

      res.set({
        "Content-Type": ALLOWED_MIME_TYPES.has(existing.mime_type) ? existing.mime_type : "application/octet-stream",
        "Content-Disposition": contentDisposition(existing.original_name),
        "Content-Length": String(original.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(original);
    } catch (err) {
      console.error("POST /api/traceability/documents/:id/download errore:", err);
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
  buildDocumentDownloadSignedMessage,
};