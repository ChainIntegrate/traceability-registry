/**
 * Il messaggio da firmare (SIWE) deve essere IDENTICO tra pagina e backend:
 * il backend lo ricostruisce e verifica la firma su quello. Uso:
 *
 *   node scripts/test-siwe-message.js
 */
const assert = require("node:assert");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
global.ethers = require(path.join(ROOT, "backend", "node_modules", "ethers"));
require(path.join(ROOT, "frontend", "traceability-siwe.js"));
const front = globalThis.TraceabilitySiwe;
const back = require(path.join(ROOT, "backend", "siweMessage.js"));

let failures = 0;
const OPS = ["Upload document", "List documents", "Hide document", "Download document",
  "Upload photo", "List photos", "Hide photo", "Pin metadata", "Pin metadata batch", "Operazione sconosciuta"];
const base = {
  domain: "traceability.chainintegrate.it", uri: "https://traceability.chainintegrate.it",
  address: "0x4be6502a3ad8ce1ab5127a042c678918f07af351", chainId: 42,
  registryAddress: "0x110ad6777eb8d92c576c4d81b179463e2cdc93f1", timestamp: 1767225600,
};
assert.strictEqual(front.SIWE_STATEMENT, back.SIWE_STATEMENT, "statement diverso tra pagina e backend");
for (const op of OPS) {
  const details = "ChainIntegrate TraceabilityRegistry - " + op + "\nRegistry: " + base.registryAddress + "\nTimestamp: " + base.timestamp;
  try {
    const a = front.buildSiweMessage({ ...base, details });
    const b = back.buildSiweMessage({ ...base, details });
    assert.strictEqual(a, b);
    // regole SIWE (EIP-4361): lo statement è una riga sola
    const statementLine = a.split("\n")[3];
    assert.ok(!/[\r\n]/.test(statementLine) && statementLine.length > 0);
    // EIP-4361: statement = *( reserved / unreserved / " " ), solo ASCII.
    // Un carattere fuori standard (es. "è") fa mostrare alla UP extension il
    // messaggio come testo grezzo, senza link cliccabili.
    const bad = statementLine.match(/[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;= ]/g);
    assert.ok(!bad, "caratteri non ammessi nello statement SIWE: " + JSON.stringify(bad));
    assert.ok(a.includes("\nResources:\n- "), "mancano i link (Resources)");
    console.log("ok   " + op + " → " + statementLine.slice(statementLine.indexOf("[Operazione")));
  } catch (err) {
    failures++;
    console.log("FAIL " + op + ": " + err.message);
  }
}
// Firma di consultazione delle librerie: blocco identico e scadenza nel messaggio
try {
  assert.strictEqual(front.buildLibraryReadSignedMessage(base.registryAddress, base.timestamp),
    require(path.join(ROOT, "backend", "authGuard.js")).buildLibraryReadSignedMessage(base.registryAddress, base.timestamp));
  const details = front.buildLibraryReadSignedMessage(base.registryAddress, base.timestamp);
  const expiresAt = base.timestamp + 3600;
  const a = front.buildSiweMessage({ ...base, details, expiresAt });
  const b = back.buildSiweMessage({ ...base, details, expiresAt });
  assert.strictEqual(a, b);
  assert.ok(a.includes("\nExpiration Time: " + new Date(expiresAt * 1000).toISOString() + "\nResources:"), "scadenza mancante o fuori posto");
  assert.ok(a.includes("valida 1 ora"));
  assert.ok(!/[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;= ]/.test(a.split("\n")[3]), "statement non ASCII");
  console.log("ok   consultazione librerie: stesso messaggio, scadenza tra Issued At e Resources");
} catch (err) {
  failures++;
  console.log("FAIL consultazione librerie: " + err.message);
}

console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
process.exit(failures === 0 ? 0 : 1);
