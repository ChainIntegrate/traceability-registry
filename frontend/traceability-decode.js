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
    const { ERC725 } = await import("/shared/erc725.js/0.28.2/erc725.min.js");
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

  // Nome del profilo (LSP3) di una Universal Profile, da mostrare al posto
  // dell'indirizzo. Letto dalla UP (chiave LSP3Profile, VerifiableURI) e dal
  // JSON su IPFS tramite il nostro gateway. null se l'indirizzo non è una UP,
  // se il profilo non ha un nome o se non è raggiungibile: chi chiama mostra
  // allora l'indirizzo abbreviato. Il nome è testo del profilo, non fidato:
  // ripulito qui (una riga, niente caratteri di controllo, max 64 caratteri) e
  // comunque da inserire nella pagina come testo o con escapeHtml.
  const LSP3_PROFILE_SCHEMA = [
    {
      name: "LSP3Profile",
      key: "0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5",
      keyType: "Singleton",
      valueType: "bytes",
      valueContent: "VerifiableURI",
    },
  ];
  const profileNameCache = new Map();

  function cleanProfileName(name) {
    if (typeof name !== "string") return null;
    const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").trim().slice(0, 64);
    return clean || null;
  }

  /** URL contenuto in un valore VerifiableURI (0x0000 + metodo + lunghezza
   * hash + hash + URL) o nel vecchio formato JSONURL (metodo + hash + URL),
   * ancora usato da profili creati prima di LSP2 v0.12. */
  function urlFromVerifiableUri(hex) {
    const v = String(hex || "").toLowerCase().replace(/^0x/, "");
    let urlHex;
    if (v.startsWith("0000") && v.length >= 16) {
      const hashLen = parseInt(v.slice(12, 16), 16);
      urlHex = v.slice(16 + hashLen * 2);
    } else if (v.length > 72) {
      urlHex = v.slice(72);
    } else {
      return null;
    }
    try { return global.ethers.utils.toUtf8String("0x" + urlHex); } catch (e) { return null; }
  }

  // Gateway IPFS di LUKSO, lo stesso che usa Universal Everything: il nostro
  // gateway serve solo i file pinnati da noi, mentre i JSON dei profili
  // stanno sui nodi di LUKSO. Usato solo come ripiego, e il file ricevuto si
  // accetta solo se corrisponde all'impronta registrata nel profilo.
  const PROFILE_FALLBACK_GATEWAY = "https://api.universalprofile.cloud/ipfs/";
  const KECCAK256_UTF8 = "6f357c6a";

  /** Impronta del file indicata nel valore (VerifiableURI o JSONURL), se il
   * metodo è keccak256(utf8), l'unico usato dai profili LUKSO. */
  function hashFromVerifiableUri(hex) {
    const v = String(hex || "").toLowerCase().replace(/^0x/, "");
    if (v.startsWith("0000") && v.length >= 16) {
      if (v.slice(4, 12) !== KECCAK256_UTF8) return null;
      const hashLen = parseInt(v.slice(12, 16), 16);
      return hashLen === 32 ? "0x" + v.slice(16, 16 + 64) : null;
    }
    if (v.length > 72 && v.slice(0, 8) === KECCAK256_UTF8) return "0x" + v.slice(8, 72);
    return null;
  }

  /** Dove leggere il JSON del profilo: ipfs://CID, oppure un gateway https
   * qualunque che contiene /ipfs/CID (riletto dai gateway ammessi dalla CSP).
   * data:application/json;base64 letto direttamente. */
  function profileJsonSource(url) {
    if (!url) return null;
    if (/^data:application\/json;base64,/i.test(url)) return { inline: url.slice(url.indexOf(",") + 1) };
    const m = url.match(/\/ipfs\/([A-Za-z0-9]{46,100}(?:\/[A-Za-z0-9._~-]+)*)/);
    const gatewayUrl = ipfsUrlToGatewayUrl(m ? m[1] : url);
    if (!gatewayUrl) return null;
    const ref = gatewayUrl.slice(gatewayUrl.indexOf("/ipfs/") + 6);
    return { urls: [gatewayUrl, PROFILE_FALLBACK_GATEWAY + ref] };
  }

  async function fetchBytes(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readProfileName(provider, address) {
    if ((await provider.getCode(address)) === "0x") return null; // non è un contratto: niente profilo
    const up = new global.ethers.Contract(address, ["function getData(bytes32 dataKey) view returns (bytes)"], provider);
    const value = await up.getData(LSP3_PROFILE_SCHEMA[0].key);
    if (!value || value === "0x") return null;
    const source = profileJsonSource(urlFromVerifiableUri(value));
    if (!source) return null;
    const expectedHash = hashFromVerifiableUri(value);
    let bytes = null;
    if (source.inline) {
      bytes = global.ethers.utils.base64.decode(source.inline);
    } else {
      for (const url of source.urls) {
        bytes = await fetchBytes(url);
        if (bytes) break;
      }
    }
    if (!bytes) return null;
    // Il file deve essere esattamente quello registrato nel profilo: un
    // gateway (nostro o di terzi) non può sostituirlo.
    if (expectedHash && global.ethers.utils.keccak256(bytes) !== expectedHash) return null;
    const json = JSON.parse(global.ethers.utils.toUtf8String(bytes));
    return cleanProfileName(json && json.LSP3Profile && json.LSP3Profile.name);
  }

  /** @returns {Promise<string|null>} nome del profilo, o null */
  function fetchProfileName(provider, address) {
    const key = String(address).toLowerCase();
    if (!profileNameCache.has(key)) {
      profileNameCache.set(key, readProfileName(provider, address).catch(() => {
        profileNameCache.delete(key); // errore di rete: si riprova la prossima volta
        return null;
      }));
    }
    return profileNameCache.get(key);
  }

  /** Come LUKSO: "nome#4be6" (le prime 4 cifre dell'indirizzo distinguono due
   * profili con lo stesso nome); senza nome, l'indirizzo abbreviato. */
  function profileLabel(name, address) {
    const a = global.ethers.utils.getAddress(address);
    return name ? name + "#" + a.slice(2, 6).toLowerCase() : a.slice(0, 6) + "…" + a.slice(-4);
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
    fetchProfileName: fetchProfileName,
    profileLabel: profileLabel,
    urlFromVerifiableUri: urlFromVerifiableUri,
    profileJsonSource: profileJsonSource,
    hashFromVerifiableUri: hashFromVerifiableUri,
    IPFS_GATEWAY_BASE: IPFS_GATEWAY_BASE,
  };
})(typeof window !== "undefined" ? window : globalThis);
