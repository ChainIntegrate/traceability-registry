/**
 * TraceabilityRegistry backend — pin su IPFS self-hosted ChainIntegrate
 * (Kubo). La porta 5001 è whitelistata solo all'IP Aruba: questa chiamata
 * funziona SOLO se eseguita dal backend su quel VPS, mai dal browser.
 *
 * Richiede Node >= 18 (fetch/FormData/Blob globali, nessuna dipendenza extra).
 */

const IPFS_TIMEOUT_MS = parseInt(process.env.IPFS_TIMEOUT_MS || "15000", 10);

async function pinBufferToIpfs(buffer, filename, mimeType) {
  if (!buffer || !buffer.length) {
    throw new Error("pinBufferToIpfs: buffer mancante o vuoto.");
  }

  const ipfsApiUrl = (process.env.IPFS_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
  const url = ipfsApiUrl + "/api/v0/add?pin=true";

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  formData.append("file", blob, filename || "file");

  // Timeout esplicito: senza, una richiesta al nodo IPFS che si blocca
  // terrebbe la connessione backend appesa indefinitamente.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IPFS_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { method: "POST", body: formData, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("pinBufferToIpfs: timeout dopo " + IPFS_TIMEOUT_MS + "ms contattando il nodo IPFS.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("pinBufferToIpfs: IPFS add fallito, HTTP " + res.status + " " + text);
  }

  const data = await res.json();
  if (!data || !data.Hash) {
    throw new Error("pinBufferToIpfs: risposta IPFS inattesa, nessun campo 'Hash'.");
  }

  return data.Hash; // CID
}

async function pinJsonToIpfs(jsonString, filename) {
  if (typeof jsonString !== "string" || !jsonString.trim()) {
    throw new Error("pinJsonToIpfs: jsonString mancante o vuoto.");
  }
  const buffer = Buffer.from(jsonString, "utf8");
  return pinBufferToIpfs(buffer, filename || "metadata.json", "application/json");
}

/**
 * Legge un file dal nodo IPFS (API `cat`, sempre il nostro nodo, mai un
 * gateway pubblico). Usata per il download firmato dei documenti: il file
 * cifrato viene riletto, decifrato dal backend e restituito all'utente
 * autorizzato. `maxBytes` evita di caricare in memoria file più grandi del
 * previsto (i documenti sono limitati a 16 MB all'upload).
 */
async function catFromIpfs(cid, maxBytes) {
  if (!cid || !/^[A-Za-z0-9]{46,100}$/.test(cid)) {
    throw new Error("catFromIpfs: CID non valido.");
  }
  const ipfsApiUrl = (process.env.IPFS_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
  // length = limite + 1: se il nodo restituisce più del limite, il file è
  // troppo grande e lo scartiamo senza scaricarlo tutto.
  const url = ipfsApiUrl + "/api/v0/cat?arg=" + encodeURIComponent(cid) + (maxBytes ? "&length=" + (maxBytes + 1) : "");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IPFS_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: "POST", signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("catFromIpfs: IPFS cat fallito, HTTP " + res.status + " " + text);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) {
      throw new Error("catFromIpfs: file più grande del limite (" + maxBytes + " byte).");
    }
    return buffer;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("catFromIpfs: timeout dopo " + IPFS_TIMEOUT_MS + "ms contattando il nodo IPFS.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { pinJsonToIpfs, pinFileToIpfs: pinBufferToIpfs, catFromIpfs };

