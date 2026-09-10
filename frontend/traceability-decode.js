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

  function ipfsUrlToGatewayUrl(ipfsUrl) {
    const cid = ipfsUrl.replace(/^ipfs:\/\//, "");
    return IPFS_GATEWAY_BASE.replace(/\/$/, "") + "/ipfs/" + cid;
  }

  /** Decodifica un valore VerifiableURI (bytes hex) e scarica il JSON dal gateway pubblico. */
  async function decodeMetadataValue(metadataValueHex) {
    if (!metadataValueHex) throw new Error("decodeMetadataValue: metadataValueHex mancante.");
    const { ERC725 } = await import("https://cdn.jsdelivr.net/npm/@erc725/erc725.js/+esm");
    const decoded = ERC725.decodeData(
      [{ keyName: "LSP4Metadata", value: metadataValueHex }],
      LSP4_METADATA_SCHEMA
    );
    const { url } = decoded[0].value;
    const gatewayUrl = ipfsUrlToGatewayUrl(url);
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

  global.TraceabilityDecode = {
    decodeMetadataValue: decodeMetadataValue,
    fetchRegistryEntries: fetchRegistryEntries,
    ipfsToHttp: ipfsToHttp,
    IPFS_GATEWAY_BASE: IPFS_GATEWAY_BASE,
  };
})(typeof window !== "undefined" ? window : globalThis);
