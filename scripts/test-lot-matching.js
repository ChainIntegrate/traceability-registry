/**
 * Test di frontend/traceability-lot-matching.js (collegamento batch → lotti).
 *
 *   node scripts/test-lot-matching.js
 */
const assert = require("node:assert");
const path = require("node:path");
require(path.join(__dirname, "..", "frontend", "traceability-lot-matching.js"));
const M = globalThis.TraceabilityLotMatching;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("ok   " + name); }
  catch (err) { failures++; console.log("FAIL " + name + "\n     " + err.message); }
}

const lot = (tokenId, lotto, nome, fornitore = "Weyermann", dataAcquisto = "12/03/2026") => ({ tokenId, lotto, nome, fornitore, dataAcquisto, quantita: "25 kg" });
const LOTS = [
  lot("0x01", "2341", "Malto Pilsner", "Weyermann", "12/03/2026"),
  lot("0x02", "2341", "Malto Pilsner", "Weyermann", "02/05/2026"),
  lot("0x03", "2341", "Luppolo Citra", "Yakima"),
  lot("0x04", "L-0088", "Luppolo Citra", "Yakima"),
  lot("0x05", "MP-2026-031", "Malto Pilsen"),
  lot("0x06", "A1", "Lievito"),
];

check("normalizzazione: trattini, maiuscole, zeri iniziali", () => {
  assert.strictEqual(M.normalizeLotCode("l-0088"), "L88");
  assert.strictEqual(M.normalizeLotCode(" MP 2026/031 "), "MP202631");
  assert.strictEqual(M.normalizeLotCode("0"), "0");
});

check("stesso lotto in più consegne: tutte candidate, preselezionate per ingrediente", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "2341" }, LOTS);
  assert.deepStrictEqual(r.exact.map((l) => [l.tokenId, l.preselected]), [["0x01", true], ["0x02", true], ["0x03", false]]);
  assert.strictEqual(r.nameMismatch, false);
  assert.strictEqual(r.suggestions.length, 0);
});

check("codice uguale ma ingrediente diverso: nessuna preselezione, avviso", () => {
  const r = M.matchLotReference({ ingredienteNome: "Lievito", lotto: "2341" }, LOTS);
  assert.ok(r.exact.length === 3 && r.exact.every((l) => !l.preselected));
  assert.strictEqual(r.nameMismatch, true);
});

check("refuso di formato (trattino, zero iniziale) → suggerimento, nessun collegamento", () => {
  const r = M.matchLotReference({ ingredienteNome: "Luppolo", lotto: "L88" }, LOTS);
  assert.strictEqual(r.exact.length, 0);
  assert.strictEqual(r.suggestions[0].lotto, "L-0088");
  assert.strictEqual(r.suggestions[0].reason, "format");
});

check("uno zero in più in mezzo → suggerimento", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "MP-2026-0310" }, LOTS);
  assert.strictEqual(r.suggestions[0].lotto, "MP-2026-031");
  assert.strictEqual(r.suggestions[0].reason, "typo");
});

check("un carattere in meno → suggerimento; stesso codice suggerito una volta sola", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "231" }, LOTS);
  assert.strictEqual(r.suggestions.length, 0, "codici troppo corti: niente suggerimenti azzardati");
  const r2 = M.matchLotReference({ ingredienteNome: "Malto", lotto: "23411" }, LOTS);
  assert.deepStrictEqual(r2.suggestions.map((s) => s.lotto), ["2341"]);
});

check("codici corti: nessun suggerimento per distanza (A1 vs A2)", () => {
  const r = M.matchLotReference({ ingredienteNome: "Lievito", lotto: "A2" }, LOTS);
  assert.strictEqual(r.suggestions.length, 0);
});

check("niente di simile → nessun candidato e nessun suggerimento", () => {
  const r = M.matchLotReference({ ingredienteNome: "Zucchero", lotto: "ZZ-999" }, LOTS);
  assert.strictEqual(r.exact.length + r.suggestions.length, 0);
});

check("nomi con accenti e parole corte", () => {
  assert.ok(M.ingredientMatches("Caffè", "caffe arabica"));
  assert.ok(!M.ingredientMatches("Di", "Di Malto"));
});

console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
process.exit(failures === 0 ? 0 : 1);
