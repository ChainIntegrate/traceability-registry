/**
 * TraceabilityRegistry — validatori JSON lato UI (vanilla JS, no dipendenze).
 * Stesso spirito degli altri frontend ChainIntegrate: nessuna libreria esterna,
 * nessun build step. Include <script src="traceability-json-validators.js"></script>
 * prima dello script che gestisce l'upload/il mint.
 *
 * Fedele allo schema reale usato da Birra20Venti (acquisto_materie_prime_*.json,
 * Batch_*_nft.json) — non generalizza/rinomina campi.
 */
(function (global) {
  "use strict";

  // -----------------------------------------------------------------------
  // Configurazione — unico punto da toccare se in futuro si aggiungono
  // nuove chiavi riconosciute (nuove aziende, nuovi campi data, ecc.)
  // -----------------------------------------------------------------------
  const CONFIG = {
    LOT_PREFIX: "Lotto ", // qualunque trait_type che inizia così è un candidato al matching
    // Rinominato da "Ricetta" a "Codice" (§48): non è più un'etichetta
    // specifica del settore alimentare/birra, ma una convenzione condivisa
    // da tutti i settori — l'attributo che guida la selezione della foto
    // per un batch, qualunque cosa "codice" significhi per quell'azienda
    // (ricetta, codice prodotto, codice intervento, ecc.).
    CODE_TRAIT_TYPE: "Codice", // guida la libreria foto per i batch
    RECOGNIZED_DATE_TRAIT_TYPES_BATCH: ["Data Produzione", "Data Imbottigliamento"],
    RECOGNIZED_DATE_TRAIT_TYPES_LOT: ["Data Acquisto"],
    REQUIRED_ATTRIBUTES_RAW_MATERIAL_PURCHASE: ["Fornitore", "Data Acquisto"],
  };

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------
  function findAttribute(attributes, traitType) {
    return (attributes || []).find((a) => a && a.trait_type === traitType) || null;
  }

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  // -----------------------------------------------------------------------
  // Validazione: Acquisto Materie Prime
  // -----------------------------------------------------------------------
  function validateRawMaterialPurchaseJson(json) {
    const errors = [];
    const warnings = [];

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { valid: false, errors: ["Il file non è un oggetto JSON valido."], warnings: [] };
    }

    if (!isNonEmptyString(json.name)) errors.push("Campo 'name' mancante o vuoto.");
    if (!isNonEmptyString(json.description)) errors.push("Campo 'description' mancante o vuoto.");

    if (!Array.isArray(json.attributes) || json.attributes.length === 0) {
      errors.push("Campo 'attributes' mancante o vuoto.");
    } else {
      CONFIG.REQUIRED_ATTRIBUTES_RAW_MATERIAL_PURCHASE.forEach((traitType) => {
        const attr = findAttribute(json.attributes, traitType);
        if (!attr || !isNonEmptyString(String(attr.value))) {
          errors.push("Attributo obbligatorio mancante: '" + traitType + "'.");
        }
      });

      // Coerenza numero materie prime dichiarato vs array reale — solo warning,
      // non blocca il mint (può essere un refuso non critico).
      const numeroAttr = findAttribute(json.attributes, "Numero Materie Prime");
      if (numeroAttr && Array.isArray(json.materie_prime)) {
        const dichiarato = Number(numeroAttr.value);
        if (!Number.isNaN(dichiarato) && dichiarato !== json.materie_prime.length) {
          warnings.push(
            "'Numero Materie Prime' dichiara " + dichiarato +
            " ma l'array 'materie_prime' ne contiene " + json.materie_prime.length + "."
          );
        }
      }
    }

    if (!Array.isArray(json.materie_prime) || json.materie_prime.length === 0) {
      errors.push("Campo 'materie_prime' mancante o vuoto: deve contenere almeno un elemento.");
    } else {
      json.materie_prime.forEach((materia, idx) => {
        const label = "materie_prime[" + idx + "]";
        if (typeof materia !== "object" || materia === null) {
          errors.push(label + ": elemento non valido.");
          return;
        }
        if (!isNonEmptyString(materia.nome)) errors.push(label + ".nome mancante o vuoto.");
        if (!isNonEmptyString(materia.quantità)) errors.push(label + ".quantità mancante o vuota.");
        // lotto: RIGOROSO, blocca sempre se mancante — a differenza di nome/quantità
        // per cui in futuro potremmo tollerare qualche variazione di nomenclatura.
        if (!isNonEmptyString(materia.lotto)) {
          errors.push(label + ".lotto mancante o vuoto — obbligatorio, nessuna tolleranza.");
        }
        // data_scadenza: opzionale, nessun controllo oltre al tipo.
        if (materia.data_scadenza !== undefined && typeof materia.data_scadenza !== "string") {
          errors.push(label + ".data_scadenza deve essere una stringa (anche vuota).");
        }
      });
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  /**
   * Estrae dal JSON acquisto già validato le informazioni necessarie al mint:
   * una entry per riga di materie_prime, pronta per diventare un elemento
   * dei tre array paralleli (tokenId si calcola altrove, serve fornitore+nome+lotto).
   */
  function extractRawMaterialPurchaseData(json) {
    const fornitoreAttr = findAttribute(json.attributes, "Fornitore");
    const dataAcquistoAttr = findAttribute(json.attributes, "Data Acquisto");

    return {
      fornitore: fornitoreAttr ? String(fornitoreAttr.value) : null,
      dataAcquistoRaw: dataAcquistoAttr ? String(dataAcquistoAttr.value) : null,
      // Un solo campo data riconosciuto per i lotti materia prima: nessuna
      // scelta da proporre in UI in questo caso specifico.
      lots: json.materie_prime.map(function (materia) {
        return {
          nome: materia.nome,
          quantità: materia.quantità,
          data_scadenza: materia.data_scadenza || "",
          lotto: materia.lotto,
        };
      }),
    };
  }

  // -----------------------------------------------------------------------
  // Validazione: Batch di Produzione
  // -----------------------------------------------------------------------
  function validateProductionBatchJson(json) {
    const errors = [];
    const warnings = [];

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { valid: false, errors: ["Il file non è un oggetto JSON valido."], warnings: [] };
    }

    if (!isNonEmptyString(json.name)) errors.push("Campo 'name' mancante o vuoto.");
    if (!isNonEmptyString(json.description)) errors.push("Campo 'description' mancante o vuoto.");

    if (!Array.isArray(json.attributes) || json.attributes.length === 0) {
      errors.push("Campo 'attributes' mancante o vuoto.");
      return { valid: false, errors: errors, warnings: warnings };
    }

    const codiceAttr = findAttribute(json.attributes, CONFIG.CODE_TRAIT_TYPE);
    if (!codiceAttr || !isNonEmptyString(String(codiceAttr.value))) {
      errors.push("Attributo obbligatorio mancante: '" + CONFIG.CODE_TRAIT_TYPE + "' (serve per la libreria foto).");
    }

    const dateCandidates = CONFIG.RECOGNIZED_DATE_TRAIT_TYPES_BATCH.filter(function (traitType) {
      return !!findAttribute(json.attributes, traitType);
    });
    if (dateCandidates.length === 0) {
      errors.push(
        "Nessuna data riconosciuta trovata tra: " + CONFIG.RECOGNIZED_DATE_TRAIT_TYPES_BATCH.join(", ") + "."
      );
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  /**
   * Estrae dal JSON batch già validato:
   * - il codice (per la libreria foto)
   * - le date candidate (se più di una, la UI DEVE far scegliere l'utente —
   *   mai un fallback automatico, come deciso)
   * - i riferimenti a lotti da tentare di collegare (ogni trait_type che
   *   inizia per "Lotto ")
   */
  function extractProductionBatchData(json) {
    const codiceAttr = findAttribute(json.attributes, CONFIG.CODE_TRAIT_TYPE);

    const dateCandidates = json.attributes
      .filter(function (a) {
        return CONFIG.RECOGNIZED_DATE_TRAIT_TYPES_BATCH.indexOf(a.trait_type) !== -1;
      })
      .map(function (a) {
        return { trait_type: a.trait_type, value: String(a.value) };
      });

    const lotReferences = json.attributes
      .filter(function (a) {
        return typeof a.trait_type === "string" && a.trait_type.indexOf(CONFIG.LOT_PREFIX) === 0;
      })
      .map(function (a) {
        return {
          trait_type: a.trait_type,
          ingredienteNome: a.trait_type.slice(CONFIG.LOT_PREFIX.length), // es. "Pilsen (2-Row)"
          lotto: String(a.value),
        };
      });

    return {
      codice: codiceAttr ? String(codiceAttr.value) : null,
      dateCandidates: dateCandidates, // [] impossibile qui: la validazione l'avrebbe già bloccato
      requiresDateSelection: dateCandidates.length > 1,
      lotReferences: lotReferences,
    };
  }

  // -----------------------------------------------------------------------
  // Export (namespace globale, coerente con lo stile vanilla esistente)
  // -----------------------------------------------------------------------
  global.TraceabilityValidators = {
    CONFIG: CONFIG,
    validateRawMaterialPurchaseJson: validateRawMaterialPurchaseJson,
    extractRawMaterialPurchaseData: extractRawMaterialPurchaseData,
    validateProductionBatchJson: validateProductionBatchJson,
    extractProductionBatchData: extractProductionBatchData,
  };
})(typeof window !== "undefined" ? window : globalThis);