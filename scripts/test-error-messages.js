/**
 * Test di frontend/traceability-error-messages.js — nessuna dipendenza oltre
 * a ethers v5 (quello già installato in backend/). Uso:
 *
 *   node scripts/test-error-messages.js
 *
 * Due gruppi di controlli:
 * 1. Copertura: OGNI stringa require() dei contratti deve avere una voce in
 *    REASON_MAP. Se si aggiunge un require() nei .sol senza tradurlo, questo
 *    test fallisce e dice quale.
 * 2. Parsing del dettaglio tecnico: le forme d'errore reali (ethers v5,
 *    UP extension, provider) devono dare il messaggio tradotto e un
 *    dettaglio breve, mai la stringa esadecimale o frammenti come
 *    "without a reason string".
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
global.ethers = require(path.join(ROOT, "backend", "node_modules", "ethers"));
global.window = globalThis;
require(path.join(ROOT, "frontend", "traceability-error-messages.js"));
const { friendlyMessage } = globalThis.TraceabilityErrors;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok   " + name);
  } catch (err) {
    failures++;
    console.log("FAIL " + name + "\n     " + err.message.split("\n").join("\n     "));
  }
}

// ---------------------------------------------------------------------------
// 1. Copertura dei require() dei contratti
// ---------------------------------------------------------------------------
const GENERIC_IT = "Operazione non riuscita.";
const reasons = [];
for (const file of fs.readdirSync(path.join(ROOT, "contracts")).filter((f) => f.endsWith(".sol"))) {
  const src = fs.readFileSync(path.join(ROOT, "contracts", file), "utf8");
  for (const m of src.matchAll(/require\s*\(([\s\S]*?)\);/g)) {
    const strings = m[1].match(/"([^"]+)"/g);
    if (strings) reasons.push(strings[strings.length - 1].slice(1, -1));
  }
}
assert.ok(reasons.length > 20, "trovati troppo pochi require() nei contratti: " + reasons.length);

for (const reason of reasons) {
  check("tradotto: " + reason, () => {
    const msg = friendlyMessage({ reason: "execution reverted: " + reason, message: "cannot estimate gas" }, "it");
    assert.ok(!msg.startsWith(GENERIC_IT), "cade nel messaggio generico: " + msg);
  });
}

// ---------------------------------------------------------------------------
// 2. Parsing del dettaglio tecnico
// ---------------------------------------------------------------------------
const GOLD = "TraceabilityRegistry: requires Gold tier";
const GOLD_IT = "Questa funzione richiede una membership Gold.";
const goldHex = ethers.utils.hexConcat([
  "0x08c379a0",
  ethers.utils.defaultAbiCoder.encode(["string"], [GOLD]),
]);
const expectGold = (msg) => {
  assert.ok(msg.startsWith(GOLD_IT), "atteso il messaggio Gold, ottenuto: " + msg);
  assert.ok(msg.endsWith("(dettaglio tecnico: " + GOLD + ")"), "dettaglio tecnico non pulito: " + msg);
};

check("ethers v5 estimateGas (err.reason)", () => {
  expectGold(friendlyMessage({
    reason: "execution reverted: " + GOLD,
    code: "UNPREDICTABLE_GAS_LIMIT",
    error: { message: "execution reverted: " + GOLD },
    message: "cannot estimate gas; transaction may fail [ See: https://links.ethers.org/v5-errors-UNPREDICTABLE_GAS_LIMIT ] (reason=\"execution reverted: " + GOLD + "\", code=UNPREDICTABLE_GAS_LIMIT)",
  }, "it"));
});

check("solo dati codificati (forma UP extension)", () => {
  expectGold(friendlyMessage({ code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data: goldHex } }, "it"));
});

check("\"reverted, data: 0x...\" — prima catturava la stringa esadecimale", () => {
  expectGold(friendlyMessage({ message: "execution reverted, data: " + goldHex }, "it"));
});

check("motivo tra virgolette doppie", () => {
  expectGold(friendlyMessage({ shortMessage: "execution reverted: \"" + GOLD + "\"" }, "it"));
});

check("risposta JSON del provider in err.error.body", () => {
  expectGold(friendlyMessage({
    message: "processing response error",
    error: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: goldHex } }) },
  }, "it"));
});

check("\"reverted without a reason string\" non diventa un motivo", () => {
  const msg = friendlyMessage({ message: "Transaction reverted without a reason string" }, "it");
  assert.ok(msg.startsWith(GENERIC_IT), msg);
  assert.ok(msg.indexOf("Dettaglio tecnico: without") === -1, "frammento spacciato per motivo: " + msg);
});

check("\"reverted with custom error\" non diventa un motivo", () => {
  const msg = friendlyMessage({ message: "reverted with custom error 'LSP8TokenIdAlreadyMinted(0x01)'" }, "it");
  assert.ok(msg.indexOf("Dettaglio tecnico: with custom error") === -1, "frammento spacciato per motivo: " + msg);
});

check("firma annullata dall'utente", () => {
  assert.strictEqual(friendlyMessage({ code: 4001, message: "User rejected the request." }, "it"),
    "Hai annullato la richiesta nella tua Universal Profile.");
});

check("tier 0: \"serve Gold\" diventa \"membership sospesa\"", () => {
  const msg = friendlyMessage({ reason: "execution reverted: " + GOLD }, "it", { tier: 0 });
  assert.ok(msg.startsWith("La membership collegata a questo registro è sospesa"), msg);
});

check("inglese", () => {
  const msg = friendlyMessage({ reason: "execution reverted: " + GOLD }, "en");
  assert.ok(msg.startsWith("This feature requires a Gold membership."), msg);
});

console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
process.exit(failures === 0 ? 0 : 1);
