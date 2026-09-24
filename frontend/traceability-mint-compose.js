/**
 * TraceabilityRegistry — orchestrazione mint (vanilla JS).
 * Lega insieme: traceability-tokenid.js, traceability-metadata.js, il
 * backend /api/traceability/pin-json, e erc725.js per l'encoding
 * VerifiableURI. Richiede, già caricati in pagina PRIMA di questo script:
 *   - ethers v5 (CDN, come Batch.html)
 *   - traceability-json-validators.js
 *   - traceability-tokenid.js
 *   - traceability-metadata.js
 *
 * erc725.js viene caricato via dynamic import (nessuno script tag fisso
 * necessario, funziona anche senza <script type="module">).
 */
(function (global) {
  "use strict";

  const LSP4_METADATA_SCHEMA = [
    {
      name: "LSP4Metadata",
      key: "0x9afb95cacc9f95858ec44aa8c3b685511002e30ae54415823f406128b85b238e",
      keyType: "Singleton",
      valueType: "bytes",
      valueContent: "VerifiableURI",
    },
  ];

  // -----------------------------------------------------------------------
  // ATTENZIONE — duplicato intenzionale di backend/traceabilityRoutes.js
  // buildSignedMessage(). Il frontend deve produrre BYTE PER BYTE lo stesso
  // messaggio che il backend ricostruisce per verificare la firma — se uno
  // dei due cambia, aggiornare anche l'altro. Candidato futuro a diventare
  // un unico file condiviso invece di due copie mantenute a mano.
  // -----------------------------------------------------------------------
  function buildSignedMessage(registryAddress, metadataJsonString, timestamp) {
    const e = requireEthers();
    const contentHash = e.utils.keccak256(e.utils.toUtf8Bytes(metadataJsonString));
    return (
      "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
      "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
      "Come funziona: https://traceability.chainintegrate.it/how-it-works.html\n" +
      "\n" +
      "ChainIntegrate TraceabilityRegistry - Pin metadata\n" +
      "Registry: " + registryAddress + "\n" +
      "Content hash: " + contentHash + "\n" +
      "Timestamp: " + timestamp
    );
  }

  function requireEthers() {
    if (typeof ethers === "undefined") {
      throw new Error("ethers.js non trovato: includere lo script ethers v5 prima di questo modulo.");
    }
    return ethers;
  }

  // -----------------------------------------------------------------------
  // ATTENZIONE — duplicato intenzionale di backend/traceabilityRoutes.js
  // computeAggregateHash()/buildBatchSignedMessage(). Stesso principio già
  // segnalato sopra per buildSignedMessage: se uno dei due cambia, aggiornare
  // anche l'altro, byte per byte, altrimenti la firma non verifica più.
  // -----------------------------------------------------------------------
  function computeAggregateHash(contentHashes) {
    const e = requireEthers();
    return e.utils.keccak256(e.utils.concat(contentHashes));
  }

  function buildBatchSignedMessage(registryAddress, aggregateHash, count, timestamp) {
    return (
      "Firma dalla tua Universal Profile: nessuna transazione on-chain, nessun costo di gas \u2014 serve solo a dimostrare che sei davvero tu a chiedere questa operazione.\n" +
      "Signature from your Universal Profile: no on-chain transaction, no gas cost \u2014 this only proves it's really you, asking for this.\n" +
      "Come funziona: https://traceability.chainintegrate.it/how-it-works.html\n" +
      "\n" +
      "ChainIntegrate TraceabilityRegistry - Pin metadata batch\n" +
      "Registry: " + registryAddress + "\n" +
      "Count: " + count + "\n" +
      "Aggregate hash: " + aggregateHash + "\n" +
      "Timestamp: " + timestamp
    );
  }

  /**
   * Come pinMetadataToIpfs ma per N contenuti con UNA sola firma — vedi
   * commento su computeAggregateHash lato backend per il perché. Ritorna un
   * array di CID nello stesso ordine di metadataJsonStrings.
   */
  async function pinMetadataBatchToIpfs({ backendBaseUrl, registryAddress, signer, metadataJsonStrings }) {
    if (!backendBaseUrl) throw new Error("pinMetadataBatchToIpfs: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("pinMetadataBatchToIpfs: registryAddress mancante.");
    if (!signer) throw new Error("pinMetadataBatchToIpfs: signer mancante (UP non connessa?).");
    if (!Array.isArray(metadataJsonStrings) || metadataJsonStrings.length === 0) {
      throw new Error("pinMetadataBatchToIpfs: metadataJsonStrings mancante o vuoto.");
    }

    const e = requireEthers();
    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const contentHashes = metadataJsonStrings.map((s) => e.utils.keccak256(e.utils.toUtf8Bytes(s)));
    const aggregateHash = computeAggregateHash(contentHashes);
    const message = buildBatchSignedMessage(registryAddress, aggregateHash, metadataJsonStrings.length, timestamp);
    const signature = await signer.signMessage(message); // apre la UP extension — UNA volta sola

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/pin-json-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registryAddress,
        signerAddress,
        metadataJsonStrings,
        signature,
        timestamp,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("pinMetadataBatchToIpfs: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    if (!Array.isArray(data.cids) || data.cids.length !== metadataJsonStrings.length) {
      throw new Error("pinMetadataBatchToIpfs: risposta backend senza 'cids' o di lunghezza inattesa.");
    }
    return data.cids;
  }

  /**
   * Firma con la UP connessa (personal_sign, gestito dall'extension) e
   * chiama il backend per pinnare la metadata. Ritorna il CID.
   */
  async function pinMetadataToIpfs({ backendBaseUrl, registryAddress, signer, metadataJsonString }) {
    if (!backendBaseUrl) throw new Error("pinMetadataToIpfs: backendBaseUrl mancante.");
    if (!registryAddress) throw new Error("pinMetadataToIpfs: registryAddress mancante.");
    if (!signer) throw new Error("pinMetadataToIpfs: signer mancante (UP non connessa?).");
    if (!metadataJsonString) throw new Error("pinMetadataToIpfs: metadataJsonString mancante.");

    const signerAddress = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildSignedMessage(registryAddress, metadataJsonString, timestamp);
    const signature = await signer.signMessage(message); // apre la UP extension

    const res = await fetch(backendBaseUrl.replace(/\/$/, "") + "/api/traceability/pin-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registryAddress,
        signerAddress,
        metadataJsonString,
        signature,
        timestamp,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("pinMetadataToIpfs: backend ha risposto " + res.status + " — " + (data.error || "errore sconosciuto"));
    }
    if (!data.cid) {
      throw new Error("pinMetadataToIpfs: risposta backend senza 'cid'.");
    }
    return data.cid;
  }

  /**
   * Incapsula la metadata JSON già pinnata in un valore VerifiableURI
   * pronto per il mint — MAI costruito a mano, sempre via erc725.js.
   */
  async function encodeLsp4MetadataValue(metadataJsonObject, cid) {
    const { ERC725 } = await import("https://cdn.jsdelivr.net/npm/@erc725/erc725.js/+esm");
    const encoded = ERC725.encodeData(
      [{ keyName: "LSP4Metadata", value: { json: metadataJsonObject, url: "ipfs://" + cid } }],
      LSP4_METADATA_SCHEMA
    );
    return encoded.values[0];
  }

  /**
   * Compone i tre array paralleli per mintRawMaterialLotBatch, a partire da
   * un JSON acquisto già validato. Una sola indexDate per l'intero acquisto
   * (Data Acquisto è unica a questo livello, nessuna scelta da proporre).
   *
   * resolvePhoto(key) -> {cid, keccak256Hash, width, height} | null,
   * sincrona o che ritorna una Promise — chiave suggerita: fornitore, o una
   * chiave "default" fissa se non si vuole differenziare per fornitore.
   */
  async function composeRawMaterialLotBatchMintArgs({
    registryAddress,
    acquistoJson,
    resolvePhoto,
    signer,
    indexDate,
    backendBaseUrl,
  }) {
    if (!global.TraceabilityValidators || !global.TraceabilityMetadata || !global.TraceabilityTokenId) {
      throw new Error(
        "composeRawMaterialLotBatchMintArgs: moduli mancanti — includere prima validators, metadata e tokenid."
      );
    }
    if (!indexDate || indexDate <= 0) {
      throw new Error("composeRawMaterialLotBatchMintArgs: indexDate mancante o non valida.");
    }

    const validation = global.TraceabilityValidators.validateRawMaterialPurchaseJson(acquistoJson);
    if (!validation.valid) {
      throw new Error("JSON acquisto non valido: " + validation.errors.join("; "));
    }

    const extracted = global.TraceabilityValidators.extractRawMaterialPurchaseData(acquistoJson);
    const photoEntry = resolvePhoto ? await Promise.resolve(resolvePhoto(extracted.fornitore)) : null;

    // Fase 1: costruisco TUTTI i metadata prima di firmare/pinnare niente —
    // nessuna chiamata di rete qui, solo dati locali. Serve ad avere l'intero
    // array di metadataJsonString pronto per una singola firma batch (vedi
    // pinMetadataBatchToIpfs) invece di firmare una volta per lotto.
    const metadataObjects = extracted.lots.map((lot) =>
      global.TraceabilityMetadata.buildRawMaterialLotMetadata(
        lot,
        extracted.fornitore,
        extracted.dataAcquistoRaw,
        photoEntry
      )
    );
    const metadataJsonStrings = metadataObjects.map((m) => JSON.stringify(m));

    // Fase 2: una firma sola per l'intero acquisto (N elementi, N CID).
    const cids = await pinMetadataBatchToIpfs({ backendBaseUrl, registryAddress, signer, metadataJsonStrings });

    // Fase 3: incapsulo ogni CID nel proprio VerifiableURI e calcolo il
    // tokenId — l'ordine di extracted.lots, metadataObjects e cids è lo
    // stesso per costruzione (map preserva l'ordine), nessun disallineamento.
    const tokenIds = [];
    const lsp4MetadataValues = [];
    const indexDates = [];

    for (let i = 0; i < extracted.lots.length; i++) {
      const lot = extracted.lots[i];
      const encodedValue = await encodeLsp4MetadataValue(metadataObjects[i], cids[i]);
      const tokenId = global.TraceabilityTokenId.computeRawMaterialLotTokenId(
        registryAddress,
        extracted.fornitore,
        lot.nome,
        lot.lotto,
        extracted.dataAcquistoRaw
      );

      tokenIds.push(tokenId);
      lsp4MetadataValues.push(encodedValue);
      indexDates.push(indexDate);
    }

    return { tokenIds, lsp4MetadataValues, indexDates };
  }

  /**
   * Compone gli argomenti per mintProductionBatch (un solo batch per
   * chiamata — a differenza dei lotti materia prima, un batch non si
   * importa mai in gruppo). usedLotTokenIds va già risolto PRIMA di
   * chiamare questa funzione (matching + conferma utente, passo separato).
   */
  async function composeProductionBatchMintArgs({
    registryAddress,
    batchJson,
    usedLotTokenIds,
    resolvePhoto,
    signer,
    indexDate,
    backendBaseUrl,
  }) {
    if (!global.TraceabilityValidators || !global.TraceabilityMetadata || !global.TraceabilityTokenId) {
      throw new Error(
        "composeProductionBatchMintArgs: moduli mancanti — includere prima validators, metadata e tokenid."
      );
    }
    if (!indexDate || indexDate <= 0) {
      throw new Error("composeProductionBatchMintArgs: indexDate mancante o non valida.");
    }
    if (!Array.isArray(usedLotTokenIds)) {
      throw new Error("composeProductionBatchMintArgs: usedLotTokenIds deve essere un array (anche vuoto).");
    }

    const validation = global.TraceabilityValidators.validateProductionBatchJson(batchJson);
    if (!validation.valid) {
      throw new Error("JSON batch non valido: " + validation.errors.join("; "));
    }

    const extracted = global.TraceabilityValidators.extractProductionBatchData(batchJson);
    const photoEntry = resolvePhoto ? await Promise.resolve(resolvePhoto(extracted.codice)) : null;

    const metadataObject = global.TraceabilityMetadata.buildProductionBatchMetadata(batchJson, photoEntry);
    const metadataJsonString = JSON.stringify(metadataObject);

    const cid = await pinMetadataToIpfs({ backendBaseUrl, registryAddress, signer, metadataJsonString });
    const encodedValue = await encodeLsp4MetadataValue(metadataObject, cid);
    const tokenId = global.TraceabilityTokenId.computeProductionBatchTokenId(registryAddress, batchJson.name);

    return {
      tokenId,
      lsp4MetadataValue: encodedValue,
      usedLotTokenIds,
      indexDate,
    };
  }

  global.TraceabilityMintCompose = {
    buildSignedMessage: buildSignedMessage,
    buildBatchSignedMessage: buildBatchSignedMessage,
    computeAggregateHash: computeAggregateHash,
    pinMetadataToIpfs: pinMetadataToIpfs,
    pinMetadataBatchToIpfs: pinMetadataBatchToIpfs,
    encodeLsp4MetadataValue: encodeLsp4MetadataValue,
    composeRawMaterialLotBatchMintArgs: composeRawMaterialLotBatchMintArgs,
    composeProductionBatchMintArgs: composeProductionBatchMintArgs,
  };
})(typeof window !== "undefined" ? window : globalThis);