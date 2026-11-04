/**
 * Collegamento tra le righe "Lotto <ingrediente>" di un batch di produzione e
 * i lotti di materia prima già registrati. Funzioni pure, senza pagina:
 * provate da scripts/test-lot-matching.js.
 *
 * - Corrispondenza ESATTA sul codice del lotto: tutti gli acquisti con quel
 *   codice sono candidati (lo stesso lotto può arrivare in più consegne, e il
 *   batch va collegato a tutte quelle usate). Sono preselezionati quelli in cui
 *   anche il nome dell'ingrediente corrisponde.
 * - Nessuna corrispondenza esatta: SUGGERIMENTI per probabili refusi (trattini,
 *   spazi, maiuscole, zeri iniziali, fino a due caratteri in più/in meno/diversi;
 *   codice scritto solo in parte, es. "220425" per "220425 271E"). Un
 *   suggerimento non collega niente da solo: l'utente può solo correggere il
 *   codice scritto nel batch e ripetere l'anteprima.
 */
(function (global) {
  "use strict";

  /** Codice "di confronto": maiuscole, solo lettere e cifre, senza zeri
   * iniziali nei gruppi di cifre ("L-0023/a" → "L23A"). */
  function normalizeLotCode(code) {
    return String(code || "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""))
      .replace(/[^A-Z0-9]/g, "");
  }

  // Refusi suggeriti: fino a 2 caratteri di differenza, solo per codici di
  // almeno 4 caratteri (su "A1"/"B2" sarebbe un tiro a indovinare).
  const MAX_TYPO_DISTANCE = 2;
  const MIN_LENGTH_FOR_TYPOS = 4;

  // Codice parziale: la parte in comune deve avere almeno 5 caratteri, per non
  // agganciare blocchi corti (es. "271E") a mezzo registro.
  const MIN_PARTIAL_LENGTH = 5;
  const MAX_SUGGESTIONS = 5;

  /** Blocchi di un codice separati da spazi, trattini, barre… (normalizzati). */
  function lotSegments(code) {
    return String(code || "").split(/[^A-Za-z0-9]+/).map(normalizeLotCode).filter(Boolean);
  }

  /**
   * Uno dei due codici è una parte INTERA dell'altro? ("220425" e "220425 271E")
   * Parte intera = uno o più blocchi consecutivi del codice più lungo, oppure
   * il suo inizio o la sua fine; mai un pezzo a metà di un blocco.
   */
  function isPartialCode(codeA, codeB) {
    const a = normalizeLotCode(codeA), b = normalizeLotCode(codeB);
    if (!a || !b || a === b) return false;
    const [shortN, longCode, longN] = a.length < b.length ? [a, codeB, b] : [b, codeA, a];
    if (shortN.length < MIN_PARTIAL_LENGTH) return false;
    if (longN.startsWith(shortN) || longN.endsWith(shortN)) return true;
    const segs = lotSegments(longCode);
    for (let i = 0; i < segs.length; i++) {
      let joined = "";
      for (let j = i; j < segs.length; j++) {
        joined += segs[j];
        if (joined === shortN) return true;
        if (joined.length >= shortN.length) break;
      }
    }
    return false;
  }

  /** Distanza di modifica (Levenshtein), interrotta oltre `max`. */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /** Parole significative di un nome di ingrediente (minuscole, senza accenti). */
  function nameWords(name) {
    return String(name || "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
  }

  /** Il nome nel batch ("Malto") e quello del lotto ("Malto Pilsner") si
   * riferiscono allo stesso ingrediente? Basta una parola in comune. */
  function ingredientMatches(batchName, lotName) {
    const a = nameWords(batchName), b = new Set(nameWords(lotName));
    return a.length > 0 && a.some((w) => b.has(w));
  }

  /** "GG/MM/AAAA" (o con trattini) → secondi UTC a mezzanotte; null se non
   * leggibile. Stessa convenzione di parseItalianDateToUnixSeconds. */
  function parseDayMonthYear(str) {
    const m = String(str || "").trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!m) return null;
    const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  /** Data di produzione di un batch dai suoi attributi ("Data Produzione"),
   * altrimenti null: chi chiama usa allora la data di riferimento del batch. */
  function batchProductionDate(attributes) {
    const a = (attributes || []).find((x) => (x.key || x.trait_type) === "Data Produzione");
    return a ? parseDayMonthYear(a.value) : null;
  }

  /**
   * Acquisto registrato DOPO la produzione del batch: la consegna davvero
   * usata non era tracciata (tracciamento iniziato dopo). Il collegamento
   * resta corretto a livello di lotto del fornitore, ma va dichiarato.
   * Stesso giorno = non successivo.
   */
  function purchasedAfterProduction(purchaseSeconds, productionSeconds) {
    return purchaseSeconds != null && productionSeconds != null && purchaseSeconds > productionSeconds;
  }

  /**
   * @param {{ingredienteNome: string, lotto: string}} ref riga del batch
   * @param {Array<{tokenId, lotto, nome, fornitore, dataAcquisto, quantita}>} lots lotti attivi registrati
   * @param {number|null} [productionSeconds] data di produzione del batch: segna
   *   gli acquisti successivi (afterProduction), che restano proposti
   * @returns {{ exact: Array<lot & {preselected, afterProduction}>, nameMismatch: boolean, suggestions: Array<lot & {reason, afterProduction}> }}
   */
  function matchLotReference(ref, lots, productionSeconds) {
    const after = (l) => purchasedAfterProduction(parseDayMonthYear(l.dataAcquisto), productionSeconds == null ? null : productionSeconds);
    const exact = lots
      .filter((l) => l.lotto === ref.lotto)
      .map((l) => Object.assign({}, l, { preselected: ingredientMatches(ref.ingredienteNome, l.nome), afterProduction: after(l) }));
    const nameMismatch = exact.length > 0 && !exact.some((l) => l.preselected);
    if (exact.length > 0) return { exact, nameMismatch, suggestions: [] };

    const target = normalizeLotCode(ref.lotto);
    const seen = new Set();
    const suggestions = [];
    lots.forEach((l) => {
      const n = normalizeLotCode(l.lotto);
      if (!n || !target) return;
      let score = null, reason = null;
      if (n === target) { score = 0; reason = "format"; }
      else if (Math.min(n.length, target.length) >= MIN_LENGTH_FOR_TYPOS) {
        // Fino a due caratteri di differenza: i codici di lotto veri sono di
        // solito molto diversi tra loro, e resta comunque un suggerimento.
        const distance = editDistance(n, target, MAX_TYPO_DISTANCE);
        if (distance <= MAX_TYPO_DISTANCE) { score = distance; reason = "typo"; }
      }
      // Codice scritto solo in parte (o con una parte in più): dopo i refusi.
      if (score === null && isPartialCode(ref.lotto, l.lotto)) { score = 3; reason = "partial"; }
      if (score === null) return;
      if (ingredientMatches(ref.ingredienteNome, l.nome)) score -= 0.5;
      // un suggerimento per codice: le consegne dello stesso lotto si
      // collegano tutte insieme dopo la correzione
      if (seen.has(l.lotto)) return;
      seen.add(l.lotto);
      suggestions.push(Object.assign({}, l, { reason, score, afterProduction: after(l) }));
    });
    suggestions.sort((x, y) => x.score - y.score);
    return { exact: [], nameMismatch: false, suggestions: suggestions.slice(0, MAX_SUGGESTIONS) };
  }

  global.TraceabilityLotMatching = {
    normalizeLotCode, editDistance, ingredientMatches, matchLotReference, isPartialCode,
    parseDayMonthYear, batchProductionDate, purchasedAfterProduction,
  };
})(typeof window !== "undefined" ? window : globalThis);
