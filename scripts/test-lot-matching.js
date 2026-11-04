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

check("acquisto registrato dopo la produzione: proposto e preselezionato, ma segnalato", () => {
  const prod = M.parseDayMonthYear("15/04/2026");
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "2341" }, LOTS, prod);
  assert.deepStrictEqual(r.exact.map((l) => [l.tokenId, l.preselected, l.afterProduction]),
    [["0x01", true, false], ["0x02", true, true], ["0x03", false, false]]);
});

check("stesso giorno della produzione: non successivo; date illeggibili: nessun avviso", () => {
  const prod = M.parseDayMonthYear("12/03/2026");
  assert.strictEqual(M.purchasedAfterProduction(M.parseDayMonthYear("12/03/2026"), prod), false);
  assert.strictEqual(M.purchasedAfterProduction(M.parseDayMonthYear("12-03-2026") + 86400, prod), true);
  assert.strictEqual(M.purchasedAfterProduction(M.parseDayMonthYear("marzo 2026"), prod), false);
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "2341" }, LOTS);
  assert.ok(r.exact.every((l) => l.afterProduction === false), "senza data di produzione nessun avviso");
});

check("data di produzione dagli attributi del batch (trait_type o key)", () => {
  assert.strictEqual(M.batchProductionDate([{ trait_type: "Data Produzione", value: "15/04/2026" }]), M.parseDayMonthYear("15/04/2026"));
  assert.strictEqual(M.batchProductionDate([{ key: "Data Produzione", value: "15/04/2026" }]), M.parseDayMonthYear("15/04/2026"));
  assert.strictEqual(M.batchProductionDate([{ key: "Data Imbottigliamento", value: "15/04/2026" }]), null);
});

check("due cifre di differenza su un codice lungo (caso reale EAN-13) → suggerimento", () => {
  const lots = LOTS.concat([lot("0x07", "8025427025452", "Fiocchi di segale", "Molino")]);
  const r = M.matchLotReference({ ingredienteNome: "Fiocchi di segale", lotto: "8025427058452" }, lots);
  assert.strictEqual(r.suggestions[0].lotto, "8025427025452");
});

check("una differenza viene prima di due", () => {
  const lots = [lot("0x10", "AB-1234", "Malto"), lot("0x11", "AB-1299", "Malto")];
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "AB-1239" }, lots);
  assert.deepStrictEqual(r.suggestions.map((x) => x.lotto), ["AB-1234", "AB-1299"]);
});

check("tre differenze → niente", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "1987" }, [lot("0x12", "1234", "Malto")]);
  assert.strictEqual(M.editDistance("1987", "1234", 5), 3);
  assert.strictEqual(r.suggestions.length, 0);
  const r2 = M.matchLotReference({ ingredienteNome: "Malto", lotto: "8025427058999" }, [lot("0x13", "8025427025452", "Malto")]);
  assert.strictEqual(r2.suggestions.length, 0, "EAN con 4 cifre diverse: niente");
});

check("codice parziale, in entrambi i versi → suggerimento \"partial\"", () => {
  const r1 = M.matchLotReference({ ingredienteNome: "Malto", lotto: "220425" }, [lot("0x20", "220425 271E", "Malto")]);
  assert.deepStrictEqual(r1.suggestions.map((x) => [x.lotto, x.reason]), [["220425 271E", "partial"]]);
  const r2 = M.matchLotReference({ ingredienteNome: "Malto", lotto: "220425 271E" }, [lot("0x21", "220425", "Malto")]);
  assert.deepStrictEqual(r2.suggestions.map((x) => [x.lotto, x.reason]), [["220425", "partial"]]);
});

check("codice parziale: più lotti con lo stesso inizio, tutti proposti", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "220425" },
    [lot("0x22", "220425 271E", "Malto"), lot("0x23", "220425-300A", "Malto"), lot("0x24", "220426 271E", "Malto")]);
  assert.deepStrictEqual(r.suggestions.map((x) => x.lotto).sort(), ["220425 271E", "220425-300A", "220426 271E"].sort().filter((c) => c !== "220426 271E"));
});

check("codice parziale: blocco centrale sì, pezzo a metà blocco no, parte corta no", () => {
  assert.ok(M.isPartialCode("LT-220425-01", "220425"), "blocco centrale");
  assert.ok(!M.isPartialCode("220425 271E", "0425"), "pezzo a metà blocco (e corto)");
  assert.ok(!M.isPartialCode("A2204251B", "20425"), "a metà di un blocco unico");
  assert.ok(!M.isPartialCode("220425 271E", "271E"), "parte sotto i 5 caratteri");
  assert.ok(M.isPartialCode("220425271E", "220425"), "inizio senza separatori");
});

check("i refusi vengono prima dei codici parziali", () => {
  const r = M.matchLotReference({ ingredienteNome: "Malto", lotto: "220425" }, [lot("0x25", "220425 271E", "Malto"), lot("0x26", "220426", "Malto")]);
  assert.deepStrictEqual(r.suggestions.map((x) => x.reason), ["typo", "partial"]);
});

console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
process.exit(failures === 0 ? 0 : 1);
