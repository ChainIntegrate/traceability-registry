/**
 * Diagnosi del nome del profilo (LSP3) mostrato nelle pagine al posto
 * dell'indirizzo: ripete passo per passo quello che fa la pagina
 * (frontend/traceability-decode.js, fetchProfileName) e dice dove si ferma.
 *
 * USO (dalla cartella backend, sulla VPS):
 *   node scripts/check-profile-name.js 0xIndirizzoDellaUP
 *
 * Legge LUKSO_RPC_URL e IPFS_API_URL dal .env. Non scrive nulla.
 */
require("dotenv").config();
const { ethers } = require("ethers");

const LSP3_PROFILE_KEY = "0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5";
const GATEWAY = "https://ipfs.chainintegrate.it";
const IPFS_REF_RE = /^[A-Za-z0-9]{46,100}(\/[A-Za-z0-9._~-]+)*$/;

function urlFromVerifiableUri(hex) {
  const v = String(hex || "").toLowerCase().replace(/^0x/, "");
  let urlHex;
  if (v.startsWith("0000") && v.length >= 16) urlHex = v.slice(16 + parseInt(v.slice(12, 16), 16) * 2);
  else if (v.length > 72) urlHex = v.slice(72);
  else return null;
  try { return ethers.utils.toUtf8String("0x" + urlHex); } catch (e) { return null; }
}

function ipfsRef(url) {
  const m = String(url).match(/\/ipfs\/([A-Za-z0-9]{46,100}(?:\/[A-Za-z0-9._~-]+)*)/);
  const ref = (m ? m[1] : String(url)).replace(/^ipfs:\/\//, "");
  return IPFS_REF_RE.test(ref) ? ref : null;
}

async function timed(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function main() {
  const address = process.argv[2];
  if (!address || !ethers.utils.isAddress(address)) {
    console.error("Uso: node scripts/check-profile-name.js 0xIndirizzoDellaUP");
    process.exit(1);
  }
  if (!process.env.LUKSO_RPC_URL) { console.error("LUKSO_RPC_URL mancante nel .env"); process.exit(1); }
  const provider = new ethers.providers.JsonRpcProvider(process.env.LUKSO_RPC_URL);

  const net = await provider.getNetwork();
  console.log("1. Rete RPC:", net.chainId, net.chainId === 42 ? "(LUKSO mainnet)" : "(ATTENZIONE: non è mainnet)");

  const code = await provider.getCode(address);
  console.log("2. Contratto all'indirizzo:", code === "0x" ? "NO — non è una Universal Profile" : "sì (" + (code.length / 2 - 1) + " byte)");
  if (code === "0x") return;

  const up = new ethers.Contract(address, ["function getData(bytes32) view returns (bytes)"], provider);
  const value = await up.getData(LSP3_PROFILE_KEY);
  console.log("3. Valore LSP3Profile:", value === "0x" ? "VUOTO — il profilo non ha dati LSP3" : value.slice(0, 80) + (value.length > 80 ? "…" : ""));
  if (value === "0x") return;
  console.log("   formato:", value.toLowerCase().startsWith("0x0000") ? "VerifiableURI" : "JSONURL (vecchio formato)");

  const url = urlFromVerifiableUri(value);
  console.log("4. URL del JSON:", url || "NON DECODIFICABILE");
  if (!url) return;

  let json;
  if (/^data:application\/json;base64,/i.test(url)) {
    json = JSON.parse(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString("utf8"));
    console.log("5. JSON incorporato nel valore (data:), nessun download");
  } else {
    const ref = ipfsRef(url);
    if (!ref) { console.log("5. L'URL non è un riferimento IPFS: la pagina non può leggerlo (la CSP ammette solo il nostro gateway)"); return; }
    const gw = GATEWAY + "/ipfs/" + ref;
    console.log("5. Gateway usato dalla pagina:", gw);
    try {
      const res = await timed(gw);
      console.log("   risposta del gateway: HTTP", res.status, res.headers.get("content-type") || "");
      if (res.ok) json = await res.json().catch(() => null);
    } catch (e) {
      console.log("   gateway NON raggiungibile o lento:", e.name === "AbortError" ? "timeout dopo 15 s" : e.message);
    }
    if (!json) {
      const fb = "https://api.universalprofile.cloud/ipfs/" + ref;
      console.log("   ripiego della pagina (gateway LUKSO):", fb);
      try {
        const res = await timed(fb);
        console.log("   risposta: HTTP", res.status, "| CORS:", res.headers.get("access-control-allow-origin") || "(nessuna intestazione: il browser la bloccherebbe)");
        if (res.ok) {
          const bytes = Buffer.from(await res.arrayBuffer());
          const v = value.toLowerCase().replace(/^0x/, "");
          const expected = v.startsWith("0000") ? "0x" + v.slice(16, 80) : "0x" + v.slice(8, 72);
          const ok = ethers.utils.keccak256(bytes) === expected;
          console.log("   impronta del file:", ok ? "coincide con quella del profilo" : "NON coincide: la pagina lo scarterebbe");
          if (ok) json = JSON.parse(bytes.toString("utf8"));
        }
      } catch (e) {
        console.log("   ripiego non raggiungibile:", e.name === "AbortError" ? "timeout dopo 15 s" : e.message);
      }
    }
    if (!json && process.env.IPFS_API_URL) {
      try {
        const res = await timed(process.env.IPFS_API_URL.replace(/\/$/, "") + "/api/v0/cat?arg=" + encodeURIComponent(ref), { method: "POST" });
        console.log("   prova dal nodo IPFS (API):", res.ok ? "il nodo LO TROVA → il problema è la configurazione del gateway" : "HTTP " + res.status);
      } catch (e) {
        console.log("   prova dal nodo IPFS (API): fallita —", e.name === "AbortError" ? "timeout (il nodo non trova il file sulla rete)" : e.message);
      }
    }
  }
  const name = json && json.LSP3Profile && json.LSP3Profile.name;
  console.log("6. Nome nel profilo:", name ? JSON.stringify(name) : "NON TROVATO");
  if (name) console.log("\nOK: la pagina dovrebbe mostrare", JSON.stringify(name + "#" + ethers.utils.getAddress(address).slice(2, 6).toLowerCase()));
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
