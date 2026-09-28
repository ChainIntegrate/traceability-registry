/**
 * Test dell'irrobustimento del backend (audit §56, punti 5, 7, 8, 9). Nessuna
 * rete: provider RPC, nodo IPFS e verifica della firma sono simulati.
 *
 *   node scripts/test-backend-hardening.js
 */
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const bRequire = (m) => require(path.join(BACKEND, "node_modules", m));
const { ethers } = bRequire("ethers");
const express = bRequire("express");
const Database = bRequire("better-sqlite3");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (err) {
    failures++;
    console.log("FAIL " + name + "\n     " + String(err && err.stack || err).split("\n").slice(0, 3).join("\n     "));
  }
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const urlOf = (server) => "http://127.0.0.1:" + server.address().port;

async function main() {
  // -------------------------------------------------------------------------
  // Punto 5a — limite di richieste per IP
  // -------------------------------------------------------------------------
  const { createRateLimiter } = require(path.join(BACKEND, "rateLimit.js"));
  const limApp = express();
  limApp.set("trust proxy", "loopback");
  limApp.use(createRateLimiter({ maxPerMinute: 3, name: "test" }));
  limApp.get("/x", (req, res) => res.json({ ip: req.ip }));
  const limServer = await listen(limApp);
  const origWarn = console.warn; console.warn = () => {};

  await check("limite: 3 richieste passano, la quarta riceve 429 con Retry-After", async () => {
    const h = { "x-forwarded-for": "203.0.113.1" };
    for (let i = 0; i < 3; i++) assert.strictEqual((await fetch(urlOf(limServer) + "/x", { headers: h })).status, 200);
    const r = await fetch(urlOf(limServer) + "/x", { headers: h });
    assert.strictEqual(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.match((await r.json()).error, /Troppe richieste/);
  });

  await check("limite per IP del client reale (X-Forwarded-For da nginx), non per tutti insieme", async () => {
    const r = await fetch(urlOf(limServer) + "/x", { headers: { "x-forwarded-for": "198.51.100.7" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ip, "198.51.100.7");
  });
  console.warn = origWarn;
  limServer.close();

  // -------------------------------------------------------------------------
  // Punto 5b — cache legata al blocco
  // -------------------------------------------------------------------------
  const cache = require(path.join(BACKEND, "chainReadCache.js"));

  await check("cache per blocco: stesso blocco = un solo calcolo, anche con richieste contemporanee", async () => {
    let calls = 0;
    const compute = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { n: calls }; };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.getForBlock("k1", 100, compute)));
    assert.strictEqual(calls, 1);
    assert.ok(results.every((r) => r.n === 1));
    await cache.getForBlock("k1", 100, compute);
    assert.strictEqual(calls, 1);
  });

  await check("cache per blocco: blocco nuovo = dati ricalcolati (niente dati vecchi dopo una registrazione)", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    assert.strictEqual(await cache.getForBlock("k2", 100, compute), 1);
    assert.strictEqual(await cache.getForBlock("k2", 101, compute), 2);
    assert.strictEqual(await cache.getForBlock("k2", 101, compute), 2);
  });

  await check("cache per blocco: un errore non resta in cache", async () => {
    let calls = 0;
    await assert.rejects(cache.getForBlock("k3", 5, async () => { calls++; throw new Error("rpc giù"); }));
    assert.strictEqual(await cache.getForBlock("k3", 5, async () => { calls++; return "ok"; }), "ok");
    assert.strictEqual(calls, 2);
  });

  // Route vere di lettura pubblica, con provider RPC simulato.
  let blockNumber = 1000;
  let getBlockCalls = 0;
  let scans = 0;
  const blockChunksPath = require.resolve(path.join(BACKEND, "blockChunks.js"));
  require(blockChunksPath);
  require.cache[blockChunksPath].exports.chunkedQueryFilter = async () => { scans++; return []; };
  class FakeProvider extends ethers.providers.BaseProvider {
    constructor() { super({ chainId: 4201, name: "test" }); }
    async detectNetwork() { return { chainId: 4201, name: "test" }; }
    async getBlockNumber() { getBlockCalls++; return blockNumber; }
    async perform(method) {
      if (method === "call") return ethers.utils.defaultAbiCoder.encode(["uint256"], [1]); // deployedAtBlock = 1
      throw new Error("non simulato: " + method);
    }
  }
  const factory = { isRegistry: async () => true };
  const { buildChainReadRouter } = require(path.join(BACKEND, "chainReadRoutes.js"));
  const readApp = express();
  readApp.use("/api/traceability", buildChainReadRouter(new FakeProvider(), factory));
  const readServer = await listen(readApp);
  const REG_CS = ethers.utils.getAddress("0x" + "ab".repeat(20));

  await check("/entries: 20 richieste nello stesso blocco = una sola scansione degli eventi", async () => {
    scans = 0;
    const rs = await Promise.all(Array.from({ length: 20 }, () => fetch(urlOf(readServer) + "/api/traceability/registry/" + REG_CS + "/entries")));
    assert.ok(rs.every((r) => r.status === 200));
    assert.strictEqual(scans, 3, "attese 3 query (lotti, batch, annullamenti) una volta sola, fatte " + scans);
  });

  await check("/entries: al blocco successivo i dati vengono ricalcolati", async () => {
    scans = 0;
    blockNumber = 1001;
    await new Promise((r) => setTimeout(r, 2100)); // il numero di blocco si rilegge al massimo ogni 2 s
    const r = await fetch(urlOf(readServer) + "/api/traceability/registry/" + REG_CS.toLowerCase() + "/entries");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(scans, 3);
  });

  await check("/delegates: stessa cache per blocco", async () => {
    scans = 0;
    await Promise.all(Array.from({ length: 10 }, () => fetch(urlOf(readServer) + "/api/traceability/registry/" + REG_CS + "/delegates")));
    assert.strictEqual(scans, 2, "attese 2 query (aggiunte, rimozioni), fatte " + scans);
  });
  readServer.close();

  await check("verifica Factory: risposta positiva ricordata, negativa no", async () => {
    delete require.cache[require.resolve(path.join(BACKEND, "authGuard.js"))];
    const { verifyRegistryIsKnown } = require(path.join(BACKEND, "authGuard.js"));
    let calls = 0;
    const f = { isRegistry: async (a) => { calls++; return a.toLowerCase().endsWith("1"); } };
    const yes = "0x" + "1".repeat(40), no = "0x" + "2".repeat(40);
    assert.strictEqual(await verifyRegistryIsKnown(f, yes), true);
    assert.strictEqual(await verifyRegistryIsKnown(f, yes.toUpperCase().replace("0X", "0x")), true);
    assert.strictEqual(calls, 1, "la seconda verifica positiva doveva venire dalla memoria");
    await verifyRegistryIsKnown(f, no);
    await verifyRegistryIsKnown(f, no);
    assert.strictEqual(calls, 3, "le negative vanno sempre richieste alla Factory");
  });

  // -------------------------------------------------------------------------
  // Punti 7 e 8 — database: indirizzi normalizzati, migrazione, nascosti
  // -------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trhard-"));
  process.env.DB_PATH = path.join(tmp, "old.db");
  const REG = ethers.utils.getAddress("0x" + "cd".repeat(20));
  const lower = REG.toLowerCase();
  {
    // Database "vecchio": come l'avrebbe lasciato il codice di prima.
    const old = new Database(process.env.DB_PATH);
    old.exec(`
      CREATE TABLE photos (id INTEGER PRIMARY KEY AUTOINCREMENT, registry_address TEXT NOT NULL, label TEXT NOT NULL,
        cid TEXT NOT NULL, keccak256_hash TEXT NOT NULL, width INTEGER, height INTEGER, mime_type TEXT,
        uploaded_by TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(registry_address, keccak256_hash));
      CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, registry_address TEXT NOT NULL, label TEXT NOT NULL,
        cid TEXT NOT NULL, keccak256_hash TEXT NOT NULL, mime_type TEXT, original_name TEXT, uploaded_by TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(registry_address, keccak256_hash));`);
    const p = old.prepare("INSERT INTO photos (registry_address,label,cid,keccak256_hash,uploaded_by,hidden,created_at) VALUES (?,?,?,?,?,?,1)");
    p.run(REG, "foto A", "QmA", "0xaa", "0x1", 0);
    p.run(lower, "foto A (doppione in minuscolo)", "QmA2", "0xaa", "0x1", 0);
    p.run(lower, "foto B solo in minuscolo", "QmB", "0xbb", "0x1", 1);
    const d = old.prepare("INSERT INTO documents (registry_address,label,cid,keccak256_hash,uploaded_by,hidden,created_at,encrypted) VALUES (?,?,?,?,?,?,1,?)");
    d.run(REG, "doc in chiaro", "QmD1", "0xdd", "0x1", 0, 0);
    d.run(lower, "stesso doc, cifrato", "QmD2", "0xdd", "0x1", 0, 1);
    old.close();
  }
  const origLog = console.log; const logs = []; console.log = (m) => logs.push(m);
  const db = require(path.join(BACKEND, "db.js"));
  console.log = origLog;

  await check("migrazione: indirizzi in minuscolo portati alla forma standard, doppioni uniti", () => {
    const photos = db.listPhotosByRegistry(REG, { includeHidden: true });
    assert.strictEqual(photos.length, 2, JSON.stringify(photos));
    assert.ok(photos.every((p) => p.registry_address === REG));
    assert.ok(photos.find((p) => p.label === "foto A"), "doveva restare la foto più vecchia");
    assert.ok(logs.some((l) => /normalizzati in photos: 1 aggiornati, 1 doppioni uniti/.test(l)), logs.join(" | "));
  });

  await check("migrazione: tra due copie dello stesso documento resta quella cifrata", () => {
    const docs = db.listDocumentsByRegistry(REG, { includeHidden: true });
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].encrypted, 1);
    assert.strictEqual(docs[0].cid, "QmD2");
  });

  await check("inserimento e lettura con l'indirizzo in minuscolo: stesso archivio", () => {
    db.insertPhoto({ registryAddress: lower, label: "foto C", cid: "QmC", keccak256Hash: "0xcc", uploadedBy: "0x1" });
    assert.ok(db.listPhotosByRegistry(lower).some((p) => p.label === "foto C"));
    assert.ok(db.listPhotosByRegistry(REG).some((p) => p.label === "foto C"));
  });

  await check("foto nascosta e poi ricaricata: torna visibile", () => {
    const hidden = db.listPhotosByRegistry(REG, { includeHidden: true }).find((p) => p.label === "foto B solo in minuscolo");
    assert.strictEqual(hidden.hidden, 1);
    const again = db.insertPhoto({ registryAddress: REG, label: "x", cid: "QmB", keccak256Hash: "0xbb", uploadedBy: "0x1" });
    assert.strictEqual(again.id, hidden.id);
    assert.strictEqual(again.hidden, 0);
  });

  await check("documento nascosto e poi ricaricato: torna visibile", () => {
    const doc = db.listDocumentsByRegistry(REG)[0];
    db.hideDocument(doc.id);
    assert.strictEqual(db.listDocumentsByRegistry(REG).length, 0);
    const again = db.insertDocument({ registryAddress: REG, label: "x", cid: "QmD2", keccak256Hash: "0xdd", uploadedBy: "0x1", encrypted: true });
    assert.strictEqual(again.hidden, 0);
    assert.strictEqual(db.listDocumentsByRegistry(REG).length, 1);
  });

  // -------------------------------------------------------------------------
  // Punti 7 e 9 — route: liste in POST, confronti con l'indirizzo standard
  // -------------------------------------------------------------------------
  const authGuardPath = require.resolve(path.join(BACKEND, "authGuard.js"));
  require(authGuardPath);
  require.cache[authGuardPath].exports.verifySignedRequest = async () => ({ ok: true });
  process.env.DOCUMENT_MASTER_KEY = "";
  const origWarn2 = console.warn; console.warn = () => {};
  const { buildPhotoRouter } = require(path.join(BACKEND, "photoRoutes.js"));
  const { buildDocumentRouter } = require(path.join(BACKEND, "documentRoutes.js"));
  console.warn = origWarn2;
  const app = express();
  app.use(express.json());
  app.use("/api/traceability", buildPhotoRouter(null, null));
  app.use("/api/traceability", buildDocumentRouter(null, null));
  const server = await listen(app);
  const base = urlOf(server) + "/api/traceability";
  const signed = (registryAddress) => ({ registryAddress, signerAddress: "0x" + "2".repeat(40), signature: "0xfirma", timestamp: Math.floor(Date.now() / 1000) });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  await check("POST /photos/list e /documents/list: firma nel corpo, liste corrette", async () => {
    const rp = await post("/photos/list", signed(lower));
    assert.strictEqual(rp.status, 200);
    assert.ok((await rp.json()).photos.length >= 2);
    const rd = await post("/documents/list", signed(REG));
    assert.strictEqual(rd.status, 200);
    assert.strictEqual((await rd.json()).documents.length, 1);
  });

  await check("GET /photos resta disponibile per le pagine ancora in cache", async () => {
    const q = new URLSearchParams(signed(REG)).toString();
    assert.strictEqual((await fetch(base + "/photos?" + q)).status, 200);
  });

  await check("nascondi con l'indirizzo scritto in minuscolo: trovato (prima rispondeva 404)", async () => {
    const photo = db.listPhotosByRegistry(REG).find((p) => p.label === "foto C");
    const r = await post("/photos/" + photo.id + "/hide", signed(lower));
    assert.strictEqual(r.status, 200, await r.text());
    const doc = db.listDocumentsByRegistry(REG)[0];
    const r2 = await post("/documents/" + doc.id + "/hide", signed(lower));
    assert.strictEqual(r2.status, 200);
  });

  await check("nascondi su un altro registro: ancora 404", async () => {
    const photo = db.listPhotosByRegistry(REG, { includeHidden: true })[0];
    const r = await post("/photos/" + photo.id + "/hide", signed("0x" + "9".repeat(40)));
    assert.strictEqual(r.status, 404);
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
