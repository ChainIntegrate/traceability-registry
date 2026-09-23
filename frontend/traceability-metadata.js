/**
 * TraceabilityRegistry — costruzione della metadata LSP4Metadata (JSON puro,
 * nessuna chiamata di rete qui dentro: IPFS/encoding sono un passo successivo,
 * vedi traceability-mint-compose.js).
 *
 * "Libreria foto" attesa in ingresso: { cid, keccak256Hash, width, height }.
 * L'hash va calcolato UNA VOLTA al primo upload dell'immagine (vedi
 * lsp4-metadata-notes.md §3) e riusato da qui in poi — non ricalcolato ad
 * ogni mint.
 */
(function (global) {
  "use strict";

  function buildIconAndImages(photoLibraryEntry) {
    if (!photoLibraryEntry || !photoLibraryEntry.cid || !photoLibraryEntry.keccak256Hash) {
      return { icon: [], images: [] };
    }
    const visual = {
      width: photoLibraryEntry.width || 750,
      height: photoLibraryEntry.height || 750,
      url: "ipfs://" + photoLibraryEntry.cid,
      verification: {
        method: "keccak256(bytes)",
        data: photoLibraryEntry.keccak256Hash,
      },
    };
    return { icon: [visual], images: [[visual]] };
  }

  /**
   * Metadata per UN RawMaterialLot (una riga di materie_prime[]).
   * fornitore/dataAcquistoRaw vengono dal livello "acquisto" del JSON
   * originale — ogni lotto se li porta dietro come attributi propri, come
   * deciso (§ "Sarebbe sempre importante tenere traccia e del lotto e della
   * data di acquisto").
   */
  function buildRawMaterialLotMetadata(lot, fornitore, dataAcquistoRaw, photoLibraryEntry) {
    if (!lot || !lot.nome || !lot.lotto) {
      throw new Error("buildRawMaterialLotMetadata: 'lot' incompleto (nome/lotto mancanti).");
    }
    if (!fornitore) throw new Error("buildRawMaterialLotMetadata: fornitore mancante.");
    if (!dataAcquistoRaw) throw new Error("buildRawMaterialLotMetadata: dataAcquistoRaw mancante.");

    const visuals = buildIconAndImages(photoLibraryEntry);

    return {
      LSP4Metadata: {
        name: lot.nome + " — Lotto " + lot.lotto,
        description:
          "Materia prima acquistata da " + fornitore + " il " + dataAcquistoRaw + ". Quantità: " + lot.quantità + ".",
        links: [],
        icon: visuals.icon,
        images: visuals.images,
        assets: [],
        attributes: [
          { key: "Nome", value: lot.nome, type: "string" },
          { key: "Lotto", value: lot.lotto, type: "string" },
          { key: "Fornitore", value: fornitore, type: "string" },
          { key: "Data Acquisto", value: dataAcquistoRaw, type: "string" },
          { key: "Quantità", value: lot.quantità, type: "string" },
          { key: "Data Scadenza", value: lot.data_scadenza || "", type: "string" },
        ],
      },
    };
  }

  /**
   * Metadata per UN ProductionBatch. Il JSON originale (es. Batch_131_nft.json)
   * è già quasi nel formato giusto — qui si riusano name/description/attributes
   * as-is (le righe "Lotto X" RESTANO nella metadata per leggibilità, anche
   * se il collegamento vero ora è on-chain via usedLotTokenIds) e si sostituisce
   * solo l'immagine con quella della libreria (chiave: attributo "Codice",
   * rinominato da "Ricetta" per non essere legato al settore alimentare/birra).
   */
  function buildProductionBatchMetadata(originalBatchJson, photoLibraryEntry) {
    if (!originalBatchJson || !originalBatchJson.name || !Array.isArray(originalBatchJson.attributes)) {
      throw new Error("buildProductionBatchMetadata: JSON batch incompleto.");
    }

    const visuals = buildIconAndImages(photoLibraryEntry);

    return {
      LSP4Metadata: {
        name: originalBatchJson.name,
        description: originalBatchJson.description || "",
        links: [],
        icon: visuals.icon,
        images: visuals.images,
        assets: [],
        attributes: originalBatchJson.attributes.map(function (a) {
          return { key: a.trait_type, value: a.value, type: typeof a.value === "number" ? "number" : "string" };
        }),
      },
    };
  }

  /**
   * Metadata della COLLEZIONE (non di un singolo token) — quella che
   * registryAdmin imposta via setRegistryMetadata(), visibile come
   * "collezione" su universaleverything.io. Immagine square (icon/images,
   * standard LSP4) e banner (backgroundImage, campo NON ufficiale ma già
   * visto funzionare altrove — vedi lsp4-metadata-notes.md §3, trattalo
   * come "bonus se il target lo renderizza").
   */
  function buildRegistryCollectionMetadata(name, description, squarePhotoLibraryEntry, bannerPhotoLibraryEntry) {
    if (!name) throw new Error("buildRegistryCollectionMetadata: name mancante.");

    const squareVisuals = buildIconAndImages(squarePhotoLibraryEntry);

    const metadata = {
      LSP4Metadata: {
        name: name,
        description: description || "",
        links: [],
        icon: squareVisuals.icon,
        images: squareVisuals.images,
        assets: [],
        attributes: [],
      },
    };

    if (bannerPhotoLibraryEntry && bannerPhotoLibraryEntry.cid && bannerPhotoLibraryEntry.keccak256Hash) {
      metadata.LSP4Metadata.backgroundImage = [
        {
          width: bannerPhotoLibraryEntry.width || 1800,
          height: bannerPhotoLibraryEntry.height || 480,
          url: "ipfs://" + bannerPhotoLibraryEntry.cid,
          verification: {
            method: "keccak256(bytes)",
            data: bannerPhotoLibraryEntry.keccak256Hash,
          },
        },
      ];
    }

    return metadata;
  }

  global.TraceabilityMetadata = {
    buildRawMaterialLotMetadata: buildRawMaterialLotMetadata,
    buildProductionBatchMetadata: buildProductionBatchMetadata,
    buildRegistryCollectionMetadata: buildRegistryCollectionMetadata,
  };
})(typeof window !== "undefined" ? window : globalThis);