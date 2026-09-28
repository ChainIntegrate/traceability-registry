/**
 * Elenca i documenti della libreria caricati PRIMA della cifratura: sono
 * ancora in chiaro su IPFS. Per metterli al sicuro:
 *   1. ricaricare lo stesso file dalla pagina privata del registro: il
 *      backend lo sostituisce con la versione cifrata (stessa impronta);
 *   2. togliere dal nodo IPFS il vecchio CID in chiaro:
 *        ipfs pin rm <CID>  e poi  ipfs repo gc   (sul server del nodo IPFS)
 * Il passo 2 impedisce al nostro nodo di continuare a servirlo; non può però
 * cancellare copie che qualcuno avesse già scaricato.
 *
 * Uso (dalla cartella backend/):  node scripts/list-plaintext-documents.js
 */
require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "traceability.db");
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const columns = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
const rows = columns.includes("encrypted")
  ? db.prepare("SELECT id, registry_address, label, original_name, cid, hidden FROM documents WHERE encrypted = 0 ORDER BY id").all()
  : db.prepare("SELECT id, registry_address, label, original_name, cid, hidden FROM documents ORDER BY id").all();
db.close();

if (rows.length === 0) {
  console.log("Nessun documento in chiaro: tutti i documenti della libreria sono cifrati.");
} else {
  console.log(rows.length + " documenti ancora in chiaro su IPFS:\n");
  for (const r of rows) {
    console.log("#" + r.id + "  " + r.registry_address + "  \"" + r.label + "\"  (" + (r.original_name || "?") + ")" + (r.hidden ? "  [nascosto]" : ""));
    console.log("     CID: " + r.cid);
  }
}
