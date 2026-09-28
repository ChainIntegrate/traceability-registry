/**
 * TraceabilityRegistry — decodifica metadata e lettura registry (vanilla JS).
 * Verso opposto di encodeLsp4MetadataValue in traceability-mint-compose.js.
 */
(function (global) {
  "use strict";

  const LSP4_METADATA_SCHEMA = [
    {
      name: "LSP4Metadata",
      key: "0x9afb95cacc9f95858ec44aa8c3b685511002e30ae54415823f406128b85b238e",
      keyType: "Singleton",
      valueType: "bytes",
      valueContent: "VerifiableURI",
    },
  ];

  const IPFS_GATEWAY_BASE = "https://ipfs.chainintegrate.it"; // gateway pubblico, diverso dall'API 5001 (privata)

  // Un riferimento IPFS accettato: CID (lettere e cifre) più eventuale
  // percorso di soli caratteri "sicuri". Gli URL arrivano dai metadata dei
  // token, che chi possiede un registro controlla per intero: senza questo
  // controllo un URL costruito apposta ("x' onerror='...") finiva dentro
  // l'HTML dell'esploratore ed eseguiva codice (audit §56).
  const IPFS_REF_RE = /^[A-Za-z0-9]{46,100}(\/[A-Za-z0-9._~-]+)*$/;

  /** URL del gateway per un riferimento ipfs://CID (o CID nudo); null se il
   * riferimento non è un CID valido. */
  function ipfsUrlToGatewayUrl(ipfsUrl) {
    const ref = String(ipfsUrl || "").replace(/^ipfs:\/\//, "");
    if (!IPFS_REF_RE.test(ref)) return null;
    return IPFS_GATEWAY_BASE.replace(/\/$/, "") + "/ipfs/" + ref;
  }

  /** Decodifica un valore VerifiableURI (bytes hex) e scarica il JSON dal gateway pubblico. */
  async function decodeMetadataValue(metadataValueHex) {
    if (!metadataValueHex) throw new Error("decodeMetadataValue: metadataValueHex mancante.");
    const { ERC725 } = await import("./vendor/erc725-0.28.2.esm.min.js");
    const decoded = ERC725.decodeData(
      [{ keyName: "LSP4Metadata", value: metadataValueHex }],
      LSP4_METADATA_SCHEMA
    );
    const { url } = decoded[0].value;
    const gatewayUrl = ipfsUrlToGatewayUrl(url);
    if (!gatewayUrl) throw new Error("decodeMetadataValue: riferimento IPFS non valido nei metadata.");
    const res = await fetch(gatewayUrl);
    if (!res.ok) throw new Error("decodeMetadataValue: fetch gateway fallito, HTTP " + res.status);
    const json = await res.json();
    return { json, url, gatewayUrl };
  }

  /** Legge le entry pubbliche di un registry dal backend (mai RPC diretto dal browser). */
  async function fetchRegistryEntries(backendBaseUrl, registryAddress) {
    const res = await fetch(
      backendBaseUrl.replace(/\/$/, "") + "/api/traceability/registry/" + registryAddress + "/entries"
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("fetchRegistryEntries: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    return data; // { registryAddress, deployedAtBlock, entries: [...] }
  }

  function ipfsToHttp(ipfsUrl) {
    return ipfsUrlToGatewayUrl(ipfsUrl);
  }

  /** Rende una stringa sicura dentro l'HTML, anche come valore di attributo
   * tra apici singoli o doppi (escapa & < > " '). Da usare per OGNI dato che
   * non sia testo fisso della pagina: metadata dei token, etichette di
   * librerie, nomi di file, contenuto dei file importati. */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  global.TraceabilityDecode = {
    escapeHtml: escapeHtml,
    decodeMetadataValue: decodeMetadataValue,
    fetchRegistryEntries: fetchRegistryEntries,
    ipfsToHttp: ipfsToHttp,
    IPFS_GATEWAY_BASE: IPFS_GATEWAY_BASE,
  };
})(typeof window !== "undefined" ? window : globalThis);
