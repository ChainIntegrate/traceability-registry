/**
 * TraceabilityRegistry — calcolo tokenId e parsing date (vanilla JS, no build step).
 * Richiede ethers.js v5 già caricato in pagina (stesso CDN già usato in
 * Batch.html/Materie_Prime.html):
 *   <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
 *
 * Include questo script DOPO ethers e DOPO traceability-json-validators.js.
 */
(function (global) {
  "use strict";

  function requireEthers() {
    if (typeof ethers === "undefined") {
      throw new Error(
        "ethers.js non trovato: includere lo script ethers v5 prima di traceability-tokenid.js."
      );
    }
    return ethers;
  }

  // -----------------------------------------------------------------------
  // tokenId — bytes32, calcolato con lo stesso schema che userebbe
  // keccak256(abi.encodePacked(...)) in Solidity, tramite
  // ethers.utils.solidityKeccak256 (equivalente esatto lato JS).
  //
  // Include sempre l'indirizzo del registry come "sale": il tokenId deve
  // essere unico solo DENTRO quel contratto (isolamento per azienda), ma
  // includerlo costa nulla ed evita ambiguità se lo stesso JSON venisse
  // per errore inviato al registry sbagliato. Un prefisso "RML"/"PB" separa
  // inoltre lo spazio hash dei due EntryType, in aggiunta al controllo che
  // il contratto fa già via ENTRY_TYPE_KEY.
  // -----------------------------------------------------------------------

  /**
   * tokenId di un RawMaterialLot. Univoco per fornitore+ingrediente+lotto+
   * data di acquisto dentro un dato registry.
   *
   * La data di acquisto è inclusa DI PROPOSITO, non solo come dettaglio in
   * più: lo stesso numero di lotto può arrivare in due consegne reali
   * diverse nello stesso anno (un fornitore può spedire lo stesso lotto in
   * più spedizioni separate) — senza la data, la seconda consegna
   * genererebbe lo stesso tokenId della prima e il mint fallirebbe (o,
   * peggio, farebbe fallire l'intero import batch se capita in mezzo a un
   * JSON con più righe). Con la data, l'idempotenza voluta resta intatta
   * solo per il caso che deve davvero essere bloccato: un doppio invio
   * ACCIDENTALE dello stesso identico acquisto (stesso lotto, stessa data)
   * genera comunque lo stesso tokenId e viene correttamente rifiutato.
   */
  function computeRawMaterialLotTokenId(registryAddress, fornitore, nomeIngrediente, lotto, dataAcquistoRaw) {
    const e = requireEthers();
    if (!registryAddress) throw new Error("computeRawMaterialLotTokenId: registryAddress mancante.");
    if (!fornitore) throw new Error("computeRawMaterialLotTokenId: fornitore mancante.");
    if (!nomeIngrediente) throw new Error("computeRawMaterialLotTokenId: nomeIngrediente mancante.");
    if (!lotto) throw new Error("computeRawMaterialLotTokenId: lotto mancante.");
    if (!dataAcquistoRaw) throw new Error("computeRawMaterialLotTokenId: dataAcquistoRaw mancante.");

    return e.utils.solidityKeccak256(
      ["address", "string", "string", "string", "string", "string"],
      [registryAddress, "RML", fornitore, nomeIngrediente, lotto, dataAcquistoRaw]
    );
  }

  /**
   * tokenId di un ProductionBatch. Univoco per il 'name' del batch dentro un
   * dato registry (es. "Batch #131") — è già l'identificativo naturale che
   * l'azienda assegna ai propri batch, non serve reinventarne uno.
   */
  function computeProductionBatchTokenId(registryAddress, batchName) {
    const e = requireEthers();
    if (!registryAddress) throw new Error("computeProductionBatchTokenId: registryAddress mancante.");
    if (!batchName) throw new Error("computeProductionBatchTokenId: batchName mancante.");

    return e.utils.solidityKeccak256(
      ["address", "string", "string"],
      [registryAddress, "PB", batchName]
    );
  }

  // -----------------------------------------------------------------------
  // Parsing date → Unix timestamp (secondi), per indexDate.
  // Supporta i due formati visti nei JSON reali: "DD/MM/YYYY" e "DD-MM-YYYY".
  // Giorno SEMPRE per primo (mai MM/DD) — coerente con tutti i dati Birra20Venti.
  // Nessun fallback silenzioso: se il formato non è riconosciuto, lancia
  // un errore — la UI deve mostrarlo, mai indovinare una data.
  // -----------------------------------------------------------------------
  function parseItalianDateToUnixSeconds(dateStr) {
    if (typeof dateStr !== "string" || !dateStr.trim()) {
      throw new Error("parseItalianDateToUnixSeconds: data mancante o vuota.");
    }

    const match = dateStr.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) {
      throw new Error(
        "parseItalianDateToUnixSeconds: formato data non riconosciuto ('" + dateStr + "'). " +
        "Attesi DD/MM/YYYY o DD-MM-YYYY."
      );
    }

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    if (month < 1 || month > 12) {
      throw new Error("parseItalianDateToUnixSeconds: mese non valido in '" + dateStr + "'.");
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) {
      throw new Error("parseItalianDateToUnixSeconds: giorno non valido in '" + dateStr + "'.");
    }

    const utcMillis = Date.UTC(year, month - 1, day, 0, 0, 0);
    return Math.floor(utcMillis / 1000);
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------
  global.TraceabilityTokenId = {
    computeRawMaterialLotTokenId: computeRawMaterialLotTokenId,
    computeProductionBatchTokenId: computeProductionBatchTokenId,
    parseItalianDateToUnixSeconds: parseItalianDateToUnixSeconds,
  };
})(typeof window !== "undefined" ? window : globalThis);