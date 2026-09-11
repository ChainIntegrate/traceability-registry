/**
 * TraceabilityRegistry — client libreria foto (vanilla JS).
 * Usato sia per caricare foto in anticipo (gestione libreria) sia "strada
 * facendo" durante il mint di un token (in quel caso, la foto appena
 * caricata arricchisce comunque la libreria per i mint futuri — stesso
 * endpoint, stesso comportamento, nessuna distinzione lato backend).
 * Tutti gli upload richiedono firma UP (ERC-1271) — nessuna eccezione.
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

  // ATTENZIONE — duplicati intenzionali di backend/photoRoutes.js. Devono
  // restare byte-per-byte identici alle controparti backend, stesso motivo
  // già segnalato per buildSignedMessage in traceability-mint-compose.js.
  function buildPhotoUploadSignedMessage(registryAddress, label, contentHash, timestamp) {
    return (
      "ChainIntegrate TraceabilityRegistry - Upload photo\n" +
      "Registry: " + registryAddress + "\n" +
      "Label: " + label + "\n" +
      "Content hash: " + contentHash + "\n" +
      "Timestamp: " + timestamp
    );
  }

  function buildPhotoListSignedMessage(registryAddress, timestamp) {
    return (
      "ChainIntegrate TraceabilityRegistry - List photos\n" +
      "Registry: " + registryAddress + "\n" +
      "Timestamp: " + timestamp
    );
  }

  function buildPhotoHideSignedMessage(registryAddress, photoId, timestamp) {
    return (
      "ChainIntegrate TraceabilityRegistry - Hide photo\n" +
      "Registry: " + registryAddress + "\n" +
      "Photo id: " + photoId + "\n" +
      "Timestamp: " + timestamp
    );
  }

  /**
   * Carica una foto (File/Blob) sulla libreria del registro — sia per uso
   * anticipato sia inline durante un mint. `fileBlob` è un File/Blob del
   * browser (es. da <input type="file">).
   */
  async function uploadPhoto({ backendBaseUrl, registryAddress, signer, label, fileBlob, fileName }) {
    const e = requireEthers();
    if (!backendBaseUrl) throw new Error("uploadPhoto: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("uploadPhoto: registryAddress mancante.");
    if (!signer) throw new Error("uploadPhoto: signer mancante (UP non connessa?).");
    if (!label || !label.trim()) throw new Error("uploadPhoto: label mancante.");
    if (!fileBlob) throw new Error("uploadPhoto: fileBlob mancante.");

    const arrayBuffer = await fileBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const contentHash = e.utils.keccak256(bytes);

    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildPhotoUploadSignedMessage(registryAddress, label.trim(), contentHash, timestamp);
    const signature = await signer.signMessage(message); // apre la UP extension

    const formData = new FormData();
    formData.append("registryAddress", registryAddress);
    formData.append("signerAddress", signerAddress);
    formData.append("label", label.trim());
    formData.append("signature", signature);
    formData.append("timestamp", String(timestamp));
    formData.append("file", fileBlob, fileName || "photo");

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/upload-photo", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("uploadPhoto: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.photo; // { id, cid, keccak256_hash, width, height, label, ... }
  }

  // Cache della firma di lettura per registry+indirizzo — evita di firmare
  // di nuovo ad ogni singola chiamata (es. lista + menu a tendina dopo un
  // upload chiamavano entrambe listPhotos, causando 2 firme evitabili in
  // più oltre a quella dell'upload stesso). Riusata finché resta entro la
  // stessa finestra di validità già accettata dal backend (5 minuti), con
  // un margine di sicurezza per non rischiare uno scarto per timestamp
  // scaduto proprio mentre la richiesta è in volo.
  const LIST_SIGNATURE_MAX_AGE_SECONDS = 300;
  const LIST_SIGNATURE_REUSE_MARGIN_SECONDS = 30;
  const listSignatureCache = {};

  /** Lista la libreria foto del registro — richiede firma (non è pubblica),
   * ma riusa una firma recente invece di chiederne una nuova ogni volta. */
  async function listPhotos({ backendBaseUrl, registryAddress, signer }) {
    if (!backendBaseUrl) throw new Error("listPhotos: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("listPhotos: registryAddress mancante.");
    if (!signer) throw new Error("listPhotos: signer mancante (UP non connessa?).");

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
      const message = buildPhotoListSignedMessage(registryAddress, timestamp);
      signature = await signer.signMessage(message); // apre la UP extension SOLO se serve davvero
      listSignatureCache[cacheKey] = { timestamp, signature };
    }

    const params = new URLSearchParams({ registryAddress, signerAddress, signature, timestamp: String(timestamp) });
    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/photos?" + params.toString());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Se il backend rifiuta (es. firma scaduta nonostante il margine),
      // invalida la cache così il prossimo tentativo ne richiede una nuova.
      delete listSignatureCache[cacheKey];
      throw new Error("listPhotos: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.photos || [];
  }

  /** Nasconde una foto caricata per errore — mai una vera cancellazione. */
  async function hidePhoto({ backendBaseUrl, registryAddress, signer, photoId }) {
    if (!backendBaseUrl) throw new Error("hidePhoto: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("hidePhoto: registryAddress mancante.");
    if (!signer) throw new Error("hidePhoto: signer mancante (UP non connessa?).");
    if (!photoId) throw new Error("hidePhoto: photoId mancante.");

    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildPhotoHideSignedMessage(registryAddress, photoId, timestamp);
    const signature = await signer.signMessage(message);

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/photos/" + photoId + "/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registryAddress, signerAddress, signature, timestamp }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("hidePhoto: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data.photo;
  }

  global.TraceabilityPhotoLibrary = {
    buildPhotoUploadSignedMessage: buildPhotoUploadSignedMessage,
    buildPhotoListSignedMessage: buildPhotoListSignedMessage,
    buildPhotoHideSignedMessage: buildPhotoHideSignedMessage,
    uploadPhoto: uploadPhoto,
    listPhotos: listPhotos,
    hidePhoto: hidePhoto,
  };
})(typeof window !== "undefined" ? window : globalThis);