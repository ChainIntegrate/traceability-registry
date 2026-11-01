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
    console.log("ok   " + op + " → " + statementLine.slice(statementLine.indexOf("[Operazione")));
  } catch (err) {
    failures++;
    console.log("FAIL " + op + ": " + err.message);
  }
}
console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
process.exit(failures === 0 ? 0 : 1);
