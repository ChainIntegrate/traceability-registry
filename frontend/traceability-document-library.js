/**
 * TraceabilityRegistry — client libreria documenti (vanilla JS).
 * Mirror esatto di traceability-photo-library.js, stessa architettura,
 * per documenti generici (PDF/certificati) invece di foto — pensato per
 * essere usato insieme a setDocumentHash/setDocumentHashBatch (Gold-only
 * lato contratto): l'hash ritornato da uploadDocument è esattamente
 * quello da passare a quelle funzioni, nessun ricalcolo.
 *
 * Richiede ethers v5 già caricato in pagina.
 */
(function (global) {
  "use strict";

  function requireEthers() {
    if (typeof ethers === "undefined") {
      throw new Error("ethers.js non trovato: includere lo script ethers v5 prima di questo modulo.");
    }
    return ethers;
  }

  // ATTENZIONE — duplicati intenzionali di backend/documentRoutes.js. Devono
  // restare byte-per-byte identici alle controparti backend, stesso motivo
  // già segnalato per buildSignedMessage in traceability-mint-compose.js.
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

  /**
   * Carica un documento (File/Blob) sulla libreria del registro. Ritorna il
   * record completo, incluso keccak256_hash — è quell'hash, non uno
   * ricalcolato altrove, che va passato a setDocumentHash/Batch dopo il mint.
   */
  async function uploadDocument({ backendBaseUrl, registryAddress, signer, label, fileBlob, fileName }) {
    const e = requireEthers();
    if (!backendBaseUrl) throw new Error("uploadDocument: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("uploadDocument: registryAddress mancante.");
    if (!signer) throw new Error("uploadDocument: signer mancante (UP non connessa?).");
    if (!label || !label.trim()) throw new Error("uploadDocument: label mancante.");
    if (!fileBlob) throw new Error("uploadDocument: fileBlob mancante.");

    const arrayBuffer = await fileBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const contentHash = e.utils.keccak256(bytes);

    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildDocumentUploadSignedMessage(registryAddress, label.trim(), contentHash, timestamp);
    const signature = await global.TraceabilitySiwe.signDetails(signer, registryAddress, message, timestamp); // apre la UP extension

    const formData = new FormData();
    formData.append("registryAddress", registryAddress);
    formData.append("signerAddress", signerAddress);
    formData.append("label", label.trim());
    formData.append("signature", signature);
    formData.append("timestamp", String(timestamp));
    formData.append("file", fileBlob, fileName || "document");

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/upload-document", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("uploadDocument: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.document; // { id, cid, keccak256_hash, label, mime_type, original_name, ... }
  }

  // Stessa cache di firma già usata per la libreria foto — evita di
  // richiedere una firma ad ogni singola lista/refresh.
  const LIST_SIGNATURE_MAX_AGE_SECONDS = 300;
  const LIST_SIGNATURE_REUSE_MARGIN_SECONDS = 30;
  const listSignatureCache = {};

  async function listDocuments({ backendBaseUrl, registryAddress, signer }) {
    if (!backendBaseUrl) throw new Error("listDocuments: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("listDocuments: registryAddress mancante.");
    if (!signer) throw new Error("listDocuments: signer mancante (UP non connessa?).");

    const signerAddress = await signer.getAddress();
    const cacheKey = registryAddress.toLowerCase() + ":" + signerAddress.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const cached = listSignatureCache[cacheKey];

    let timestamp, signature;
    if (cached && now - cached.timestamp < LIST_SIGNATURE_MAX_AGE_SECONDS - LIST_SIGNATURE_REUSE_MARGIN_SECONDS) {
      timestamp = cached.timestamp;
      signature = cached.signature;
    } else {
      timestamp = now;
      const message = buildDocumentListSignedMessage(registryAddress, timestamp);
      signature = await global.TraceabilitySiwe.signDetails(signer, registryAddress, message, timestamp); // apre la UP extension SOLO se serve davvero
      listSignatureCache[cacheKey] = { timestamp, signature };
    }

    const params = new URLSearchParams({ registryAddress, signerAddress, signature, timestamp: String(timestamp) });
    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/documents?" + params.toString());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      delete listSignatureCache[cacheKey];
      throw new Error("listDocuments: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.documents || [];
  }

  /** Nasconde un documento caricato per errore — mai una vera cancellazione. */
  async function hideDocument({ backendBaseUrl, registryAddress, signer, documentId }) {
    if (!backendBaseUrl) throw new Error("hideDocument: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("hideDocument: registryAddress mancante.");
    if (!signer) throw new Error("hideDocument: signer mancante (UP non connessa?).");
    if (!documentId) throw new Error("hideDocument: documentId mancante.");

    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildDocumentHideSignedMessage(registryAddress, documentId, timestamp);
    const signature = await global.TraceabilitySiwe.signDetails(signer, registryAddress, message, timestamp);

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/documents/" + documentId + "/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registryAddress, signerAddress, signature, timestamp }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("hideDocument: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.document;
  }

  global.TraceabilityDocumentLibrary = {
    buildDocumentUploadSignedMessage: buildDocumentUploadSignedMessage,
    buildDocumentListSignedMessage: buildDocumentListSignedMessage,
    buildDocumentHideSignedMessage: buildDocumentHideSignedMessage,
    uploadDocument: uploadDocument,
    listDocuments: listDocuments,
    hideDocument: hideDocument,
  };
})(typeof window !== "undefined" ? window : globalThis);