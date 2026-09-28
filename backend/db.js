const path = require("path");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "traceability.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_address TEXT NOT NULL,
    label TEXT NOT NULL,
    cid TEXT NOT NULL,
    keccak256_hash TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    mime_type TEXT,
    uploaded_by TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(registry_address, keccak256_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_photos_registry ON photos(registry_address);

  -- Stessa struttura della libreria foto, per documenti generici (Gold-only
  -- lato uso: setDocumentHash/setDocumentHashBatch sul contratto richiedono
  -- Gold, ma l'upload/lista qui non lo impone — è il mint successivo a
  -- essere rifiutato on-chain se il tier non basta, stessa filosofia già
  -- adottata altrove in questo backend).
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_address TEXT NOT NULL,
    label TEXT NOT NULL,
    cid TEXT NOT NULL,
    keccak256_hash TEXT NOT NULL,
    mime_type TEXT,
    original_name TEXT,
    uploaded_by TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(registry_address, keccak256_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_documents_registry ON documents(registry_address);
`);

// Migrazione: colonna `encrypted` sui documenti (audit §56, punto 2).
// 1 = su IPFS c'è il file cifrato (documentCrypto.js), 0 = documento
// caricato prima della cifratura, ancora in chiaro su IPFS. Idempotente:
// aggiunge la colonna solo se manca, i documenti esistenti restano a 0.
const documentColumns = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
if (!documentColumns.includes("encrypted")) {
  db.exec("ALTER TABLE documents ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0");
}

/**
 * Forma canonica dell'indirizzo di un registro (checksum EIP-55). Audit §56
 * punto 7: prima l'indirizzo era salvato come arrivava dal client, quindi un
 * delegato che lo scriveva in minuscolo vedeva la libreria vuota, caricava in
 * un "archivio" separato e "nascondi" rispondeva 404. Ora tutte le funzioni
 * qui sotto normalizzano da sole: nessun chiamante può sbagliare.
 */
function normalizeRegistryAddress(address) {
  return ethers.utils.getAddress(String(address));
}

// Migrazione: porta alla forma canonica le righe già salvate. Se due righe
// diventano uguali (stesso registro, stesso file), ne tiene una sola: quella
// cifrata se c'è (documenti), altrimenti la più vecchia; resta visibile se
// almeno una delle due lo era. Idempotente: alla seconda esecuzione non trova
// più niente da fare.
function normalizeRegistryColumn(table) {
  const hasEncrypted = db.prepare("PRAGMA table_info(" + table + ")").all().some((c) => c.name === "encrypted");
  const rows = db.prepare("SELECT * FROM " + table + " ORDER BY id").all();
  let fixed = 0;
  let merged = 0;
  db.transaction(() => {
    for (const r of rows) {
      let canonical;
      try { canonical = normalizeRegistryAddress(r.registry_address); } catch (e) { continue; }
      if (canonical === r.registry_address) continue;
      const current = db.prepare("SELECT * FROM " + table + " WHERE id = ?").get(r.id);
      if (!current) continue; // già unita a un'altra riga
      const twin = db.prepare("SELECT * FROM " + table + " WHERE registry_address = ? AND keccak256_hash = ?")
        .get(canonical, current.keccak256_hash);
      if (!twin) {
        db.prepare("UPDATE " + table + " SET registry_address = ? WHERE id = ?").run(canonical, current.id);
        fixed++;
        continue;
      }
      let keep = twin.id < current.id ? twin : current;
      if (hasEncrypted && twin.encrypted !== current.encrypted) keep = twin.encrypted ? twin : current;
      const drop = keep.id === twin.id ? current : twin;
      db.prepare("DELETE FROM " + table + " WHERE id = ?").run(drop.id);
      db.prepare("UPDATE " + table + " SET registry_address = ?, hidden = ? WHERE id = ?")
        .run(canonical, keep.hidden && drop.hidden ? 1 : 0, keep.id);
      merged++;
    }
  })();
  if (fixed || merged) {
    console.log("db: indirizzi registro normalizzati in " + table + ": " + fixed + " aggiornati, " + merged + " doppioni uniti.");
  }
}
normalizeRegistryColumn("photos");
normalizeRegistryColumn("documents");

/**
 * Idempotente: se la stessa immagine (stesso hash) è già stata caricata su
 * questo registry, ritorna il record esistente invece di crearne un
 * duplicato — copre il caso doppio-click / retry di rete dopo un timeout,
 * che prima creava righe identiche nel database.
 */
function insertPhoto({ registryAddress, label, cid, keccak256Hash, width, height, mimeType, uploadedBy }) {
  registryAddress = normalizeRegistryAddress(registryAddress);
  const existing = db
    .prepare("SELECT * FROM photos WHERE registry_address = ? AND keccak256_hash = ?")
    .get(registryAddress, keccak256Hash);
  if (existing) {
    // Ricaricare una foto nascosta la rende di nuovo visibile (audit §56
    // punto 8): prima rispondeva "caricata" ma restava nascosta.
    if (existing.hidden) {
      db.prepare("UPDATE photos SET hidden = 0 WHERE id = ?").run(existing.id);
      return getPhotoById(existing.id);
    }
    return existing;
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO photos (registry_address, label, cid, keccak256_hash, width, height, mime_type, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    registryAddress,
    label,
    cid,
    keccak256Hash,
    width || null,
    height || null,
    mimeType || null,
    uploadedBy,
    createdAt
  );
  return getPhotoById(info.lastInsertRowid);
}

function getPhotoById(id) {
  return db.prepare("SELECT * FROM photos WHERE id = ?").get(id);
}

/** Più recenti prima — così una nuova immagine caricata diventa il suggerimento
 * di default. id DESC come criterio secondario: created_at ha risoluzione al
 * secondo, due upload ravvicinati altrimenti avrebbero ordine imprevedibile
 * (bug trovato testando due inserimenti nello stesso secondo). Nasconde di
 * default le foto marcate 'hidden' (mai cancellate, stessa filosofia di
 * invalidazione già adottata on-chain per lotti/batch). */
function listPhotosByRegistry(registryAddress, { includeHidden = false } = {}) {
  registryAddress = normalizeRegistryAddress(registryAddress);
  const query = includeHidden
    ? "SELECT * FROM photos WHERE registry_address = ? ORDER BY created_at DESC, id DESC"
    : "SELECT * FROM photos WHERE registry_address = ? AND hidden = 0 ORDER BY created_at DESC, id DESC";
  return db.prepare(query).all(registryAddress);
}

/** Mai una vera cancellazione — coerente con invalidateEntry on-chain. */
function hidePhoto(id) {
  db.prepare("UPDATE photos SET hidden = 1 WHERE id = ?").run(id);
  return getPhotoById(id);
}

/** Idempotente come insertPhoto — stesso motivo (doppio-click/retry di rete). */
function insertDocument({ registryAddress, label, cid, keccak256Hash, mimeType, originalName, uploadedBy, encrypted = false }) {
  registryAddress = normalizeRegistryAddress(registryAddress);
  const existing = db
    .prepare("SELECT * FROM documents WHERE registry_address = ? AND keccak256_hash = ?")
    .get(registryAddress, keccak256Hash);
  if (existing) {
    // Stesso documento già in libreria ma caricato prima della cifratura
    // (in chiaro su IPFS): ricaricarlo lo sostituisce con la versione
    // cifrata. È il modo per mettere al sicuro i documenti vecchi; il CID in
    // chiaro va poi tolto dal nodo (docs/CHIAVE-DOCUMENTI.md).
    if (encrypted && !existing.encrypted) {
      db.prepare("UPDATE documents SET cid = ?, encrypted = 1, hidden = 0 WHERE id = ?").run(cid, existing.id);
      return getDocumentById(existing.id);
    }
    // Ricaricare un documento nascosto lo rende di nuovo visibile (punto 8).
    if (existing.hidden) {
      db.prepare("UPDATE documents SET hidden = 0 WHERE id = ?").run(existing.id);
      return getDocumentById(existing.id);
    }
    return existing;
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO documents (registry_address, label, cid, keccak256_hash, mime_type, original_name, uploaded_by, created_at, encrypted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    registryAddress,
    label,
    cid,
    keccak256Hash,
    mimeType || null,
    originalName || null,
    uploadedBy,
    createdAt,
    encrypted ? 1 : 0
  );
  return getDocumentById(info.lastInsertRowid);
}

function getDocumentById(id) {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
}

function listDocumentsByRegistry(registryAddress, { includeHidden = false } = {}) {
  registryAddress = normalizeRegistryAddress(registryAddress);
  const query = includeHidden
    ? "SELECT * FROM documents WHERE registry_address = ? ORDER BY created_at DESC, id DESC"
    : "SELECT * FROM documents WHERE registry_address = ? AND hidden = 0 ORDER BY created_at DESC, id DESC";
  return db.prepare(query).all(registryAddress);
}

function hideDocument(id) {
  db.prepare("UPDATE documents SET hidden = 1 WHERE id = ?").run(id);
  return getDocumentById(id);
}

module.exports = {
  insertPhoto, listPhotosByRegistry, getPhotoById, hidePhoto,
  insertDocument, listDocumentsByRegistry, getDocumentById, hideDocument,
  normalizeRegistryAddress,
};