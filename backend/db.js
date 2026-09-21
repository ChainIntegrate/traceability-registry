const path = require("path");
const Database = require("better-sqlite3");

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

/**
 * Idempotente: se la stessa immagine (stesso hash) è già stata caricata su
 * questo registry, ritorna il record esistente invece di crearne un
 * duplicato — copre il caso doppio-click / retry di rete dopo un timeout,
 * che prima creava righe identiche nel database.
 */
function insertPhoto({ registryAddress, label, cid, keccak256Hash, width, height, mimeType, uploadedBy }) {
  const existing = db
    .prepare("SELECT * FROM photos WHERE registry_address = ? AND keccak256_hash = ?")
    .get(registryAddress, keccak256Hash);
  if (existing) return existing;

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
function insertDocument({ registryAddress, label, cid, keccak256Hash, mimeType, originalName, uploadedBy }) {
  const existing = db
    .prepare("SELECT * FROM documents WHERE registry_address = ? AND keccak256_hash = ?")
    .get(registryAddress, keccak256Hash);
  if (existing) return existing;

  const createdAt = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO documents (registry_address, label, cid, keccak256_hash, mime_type, original_name, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    registryAddress,
    label,
    cid,
    keccak256Hash,
    mimeType || null,
    originalName || null,
    uploadedBy,
    createdAt
  );
  return getDocumentById(info.lastInsertRowid);
}

function getDocumentById(id) {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
}

function listDocumentsByRegistry(registryAddress, { includeHidden = false } = {}) {
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
};