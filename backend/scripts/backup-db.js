/**
 * Copia di sicurezza del database SQLite del backend (librerie foto e
 * documenti). Usa l'API di backup di SQLite: la copia è coerente anche se il
 * backend sta scrivendo in quel momento, quindi non serve fermarlo.
 *
 * Uso (dalla cartella backend/):
 *
 *   node scripts/backup-db.js [cartella-di-destinazione] [copie-da-tenere]
 *
 * Default: cartella BACKUP_DIR del .env oppure ./backups, 30 copie. Le copie
 * più vecchie oltre quel numero vengono cancellate.
 *
 * Da programmare con cron, una volta al giorno (esempio alle 03:15):
 *   15 3 * * * cd /var/www/traceability-registry/backend && /usr/bin/node scripts/backup-db.js >> backups/backup.log 2>&1
 *
 * Importante: una copia che resta sullo stesso server non protegge da un
 * guasto del server. Il backup automatico del VPS (o una copia periodica
 * altrove) deve includere la cartella di destinazione. Vedi
 * docs/CHIAVE-DOCUMENTI.md.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "traceability.db");

async function main() {
  const destDir = path.resolve(process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, "..", "backups"));
  const keep = parseInt(process.argv[3] || "30", 10);
  if (!fs.existsSync(DB_PATH)) {
    console.error("Database non trovato: " + DB_PATH);
    process.exit(1);
  }
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(destDir, "traceability-" + stamp + ".db");
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  fs.chmodSync(dest, 0o600);
  console.log(new Date().toISOString() + " backup scritto: " + dest);

  const old = fs.readdirSync(destDir)
    .filter((f) => /^traceability-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    fs.unlinkSync(path.join(destDir, f));
    console.log("rimossa copia vecchia: " + f);
  }
}

main().catch((err) => {
  console.error("Errore backup:", err.message);
  process.exit(1);
});
