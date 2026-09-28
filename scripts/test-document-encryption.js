/**
 * Test della cifratura dei documenti (backend/documentCrypto.js) e del
 * percorso completo upload → IPFS → download attraverso le route vere del
 * backend. Nessuna rete esterna: il nodo IPFS è simulato in memoria e la
 * verifica della firma (già coperta altrove) è sostituita da un "ok".
 *
 *   node scripts/test-document-encryption.js
 */
const assert = require("node:assert");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const bRequire = (m) => require(path.join(BACKEND, "node_modules", m));
const { ethers } = bRequire("ethers");

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

const MASTER_B64 = crypto.randomBytes(32).toString("base64");
const OTHER_B64 = crypto.randomBytes(32).toString("base64");

async function main() {
  const dc = require(path.join(BACKEND, "documentCrypto.js"));
  const master = dc.loadMasterKey(MASTER_B64);

  // -------------------------------------------------------------------------
  // 1. Cifratura
  // -------------------------------------------------------------------------
  await check("round-trip: file vuoto, 1 byte, 5 MB — byte identici", () => {
    for (const size of [0, 1, 5 * 1024 * 1024]) {
      const plain = crypto.randomBytes(size);
      const blob = dc.encryptDocument(plain, master);
      assert.ok(dc.isEncryptedDocument(blob), "intestazione TRDOC1 mancante");
      assert.ok(dc.decryptDocument(blob, master).equals(plain), "contenuto diverso dopo la decifratura, size " + size);
    }
  });

  await check("due cifrature dello stesso file sono diverse (chiavi e nonce casuali)", () => {
    const plain = Buffer.from("stessa fattura");
    assert.ok(!dc.encryptDocument(plain, master).equals(dc.encryptDocument(plain, master)));
  });

  await check("il contenuto non compare in chiaro nel file cifrato", () => {
    const plain = Buffer.from("%PDF-1.7 Fattura n. 123 — Mario Rossi, Via Roma 1");
    const blob = dc.encryptDocument(plain, master);
    assert.strictEqual(blob.indexOf("Mario Rossi"), -1);
    assert.strictEqual(blob.indexOf("%PDF"), -1);
  });

  await check("chiave madre sbagliata: rifiutata", () => {
    const blob = dc.encryptDocument(Buffer.from("x"), master);
    assert.throws(() => dc.decryptDocument(blob, dc.loadMasterKey(OTHER_B64)), /altra chiave madre/);
  });

  await check("un solo byte alterato in qualunque punto: rifiutato", () => {
    const blob = dc.encryptDocument(crypto.randomBytes(1000), master);
    // magic escluso: alterarlo fa semplicemente non riconoscere il formato
    for (let pos = 6; pos < blob.length; pos += 37) {
      const bad = Buffer.from(blob);
      bad[pos] ^= 0x01;
      assert.throws(() => dc.decryptDocument(bad, master), undefined, "alterazione non rilevata alla posizione " + pos);
    }
  });

  await check("loadMasterKey: base64 e hex validi, lunghezza sbagliata rifiutata, vuota = null", () => {
    assert.strictEqual(dc.loadMasterKey(MASTER_B64).length, 32);
    assert.strictEqual(dc.loadMasterKey(crypto.randomBytes(32).toString("hex")).length, 32);
    assert.throws(() => dc.loadMasterKey(crypto.randomBytes(16).toString("base64")), /32 byte/);
    assert.strictEqual(dc.loadMasterKey(""), null);
    assert.strictEqual(dc.loadMasterKey(undefined), null);
  });

  // -------------------------------------------------------------------------
  // 2. Messaggio firmato del download: identico tra frontend e backend
  // -------------------------------------------------------------------------
  global.ethers = ethers;
  global.window = globalThis;
  require(path.join(ROOT, "frontend", "traceability-document-library.js"));
  const docRoutesForMsg = require(path.join(BACKEND, "documentRoutes.js"));
  await check("messaggio di download identico tra frontend e backend", () => {
    const a = globalThis.TraceabilityDocumentLibrary.buildDocumentDownloadSignedMessage("0xAbc", 7, 1790000000);
    const b = docRoutesForMsg.buildDocumentDownloadSignedMessage("0xAbc", 7, 1790000000);
    assert.strictEqual(a, b);
  });

  // -------------------------------------------------------------------------
  // 3. Percorso completo attraverso le route vere
  // -------------------------------------------------------------------------
  const store = new Map(); // CID finto -> contenuto
  const ipfs = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/v0/add") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const boundary = "--" + req.headers["content-type"].split("boundary=")[1];
        const start = raw.indexOf("\r\n\r\n") + 4;
        const end = raw.lastIndexOf(Buffer.from("\r\n" + boundary));
        const content = raw.subarray(start, end);
        const cid = "Qm" + crypto.createHash("sha256").update(content).digest("hex").slice(0, 44);
        store.set(cid, content);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Hash: cid }));
      });
    } else if (url.pathname === "/api/v0/cat") {
      const content = store.get(url.searchParams.get("arg"));
      if (!content) { res.statusCode = 500; return res.end("not found"); }
      res.end(content);
    } else {
      res.statusCode = 404; res.end();
    }
  });
  await new Promise((r) => ipfs.listen(0, r));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trdoc-"));
  process.env.DB_PATH = path.join(tmp, "test.db");
  process.env.IPFS_API_URL = "http://127.0.0.1:" + ipfs.address().port;

  // Firma già testata altrove: qui la sostituiamo con un "ok".
  const authGuardPath = require.resolve(path.join(BACKEND, "authGuard.js"));
  require(authGuardPath);
  require.cache[authGuardPath].exports.verifySignedRequest = async () => ({ ok: true });

  async function startApp(masterKeyB64) {
    process.env.DOCUMENT_MASTER_KEY = masterKeyB64 || "";
    delete require.cache[require.resolve(path.join(BACKEND, "documentRoutes.js"))];
    const { buildDocumentRouter } = require(path.join(BACKEND, "documentRoutes.js"));
    const express = bRequire("express");
    const app = express();
    app.use(express.json());
    app.use("/api/traceability", buildDocumentRouter(null, null));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return { server, base: "http://127.0.0.1:" + server.address().port + "/api/traceability" };
  }

  const REG = "0x" + "1".repeat(40);
  const SIGNER = "0x" + "2".repeat(40);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\nFattura n. 123 — Mario Rossi\n"), crypto.randomBytes(20000)]);
  const pdfHash = ethers.utils.keccak256(pdf);

  async function upload(base, bytes, name) {
    const form = new FormData();
    form.append("registryAddress", REG);
    form.append("signerAddress", SIGNER);
    form.append("label", "Fattura di prova");
    form.append("signature", "0xfirma");
    form.append("timestamp", String(Math.floor(Date.now() / 1000)));
    form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
    const res = await fetch(base + "/upload-document", { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
  }
  const download = (base, id, registry = REG) => fetch(base + "/documents/" + id + "/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registryAddress: registry, signerAddress: SIGNER, signature: "0xfirma", timestamp: Math.floor(Date.now() / 1000) }),
  });

  let app = await startApp(MASTER_B64);
  let docId, docCid;

  await check("upload: su IPFS finisce solo il file cifrato, l'impronta è quella del PDF originale", async () => {
    const { status, body } = await upload(app.base, pdf, "fattura-123.pdf");
    assert.strictEqual(status, 200, JSON.stringify(body));
    docId = body.document.id; docCid = body.document.cid;
    assert.strictEqual(body.document.encrypted, 1);
    assert.strictEqual(body.document.keccak256_hash, pdfHash);
    const onIpfs = store.get(docCid);
    assert.ok(dc.isEncryptedDocument(onIpfs), "su IPFS non c'è un file TRDOC1");
    assert.strictEqual(onIpfs.indexOf("Mario Rossi"), -1, "testo in chiaro trovato su IPFS");
    assert.strictEqual(onIpfs.indexOf("%PDF"), -1, "intestazione PDF in chiaro su IPFS");
  });

  await check("download firmato: restituisce il PDF originale byte per byte, con nome e tipo", async () => {
    const res = await download(app.base, docId);
    assert.strictEqual(res.status, 200);
    const got = Buffer.from(await res.arrayBuffer());
    assert.ok(got.equals(pdf), "file scaricato diverso dall'originale");
    assert.strictEqual(ethers.utils.keccak256(got), pdfHash);
    assert.strictEqual(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /attachment; filename="fattura-123.pdf"/);
    assert.strictEqual(res.headers.get("cache-control"), "no-store");
  });

  await check("download con un altro registro: 404", async () => {
    const res = await download(app.base, docId, "0x" + "3".repeat(40));
    assert.strictEqual(res.status, 404);
  });

  await check("file su IPFS alterato: download rifiutato", async () => {
    const good = store.get(docCid);
    const bad = Buffer.from(good); bad[bad.length - 1] ^= 1;
    store.set(docCid, bad);
    const res = await download(app.base, docId);
    store.set(docCid, good);
    assert.strictEqual(res.status, 500);
  });

  await check("recupero senza database: con la sola chiave madre si riapre il file da IPFS", () => {
    const recovered = dc.decryptDocument(store.get(docCid), master);
    assert.strictEqual(ethers.utils.keccak256(recovered), pdfHash);
  });

  await check("documento vecchio in chiaro: si scarica ancora; ricaricarlo lo sostituisce con la versione cifrata", async () => {
    const legacy = Buffer.from("%PDF-1.4 vecchio documento " + crypto.randomBytes(8).toString("hex"));
    const legacyCid = "Qm" + "L".repeat(44);
    store.set(legacyCid, legacy);
    const db = require(path.join(BACKEND, "db.js"));
    const row = db.insertDocument({
      registryAddress: REG, label: "vecchio", cid: legacyCid,
      keccak256Hash: ethers.utils.keccak256(legacy), mimeType: "application/pdf",
      originalName: "vecchio.pdf", uploadedBy: SIGNER,
    });
    assert.strictEqual(row.encrypted, 0);
    let res = await download(app.base, row.id);
    assert.strictEqual(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(legacy));

    const { body } = await upload(app.base, legacy, "vecchio.pdf");
    assert.strictEqual(body.document.id, row.id, "doveva aggiornare lo stesso record");
    assert.strictEqual(body.document.encrypted, 1);
    assert.notStrictEqual(body.document.cid, legacyCid);
    assert.ok(dc.isEncryptedDocument(store.get(body.document.cid)));
    res = await download(app.base, row.id);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(legacy));
  });

  app.server.close();

  await check("senza DOCUMENT_MASTER_KEY: upload rifiutato (mai in chiaro), download cifrato non disponibile", async () => {
    const noKey = await startApp("");
    const before = store.size;
    const { status } = await upload(noKey.base, crypto.randomBytes(100), "x.pdf");
    assert.strictEqual(status, 503);
    assert.strictEqual(store.size, before, "qualcosa è stato caricato su IPFS senza cifratura");
    const res = await download(noKey.base, docId);
    assert.strictEqual(res.status, 503);
    noKey.server.close();
  });

  ipfs.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
