/**
 * TraceabilityRegistry — galleria condivisa (card + filtri a pillole).
 * Estratta da explorer.html per essere riusata anche in user.html (stessa
 * visualizzazione, richiesto esplicitamente) senza duplicare la logica.
 * Richiede traceability-decode.js e il foglio di stile
 * traceability-explorer-ui.css già caricati in pagina.
 *
 * Il chiamante fornisce i container DOM e una funzione t(key, params) con
 * le seguenti chiavi definite nel proprio dizionario i18n:
 *   badge.lot, badge.batch, badge.invalidated, card.usedLots, card.noImage,
 *   filters.clear, status.loading, status.error, status.empty, status.noMatch
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function ipfsToHttp(url) {
    return global.TraceabilityDecode.ipfsToHttp(url);
  }

  // bytes32(0) letto on-chain quando nessun hash è stato registrato per il
  // token — costruito con repeat() invece che scritto a mano per evitare un
  // banale errore di conteggio degli zeri.
  const ZERO_HASH = "0x" + "0".repeat(64);

  function hasDocumentHash(entry) {
    return !!entry.documentHash && entry.documentHash !== ZERO_HASH;
  }

  function shortHash(hash) {
    return hash.slice(0, 10) + "…" + hash.slice(-6);
  }

  /** Richiede ethers (keccak256) già caricato in pagina — sia user.html che
   * explorer.html lo includono per questo. Calcolo interamente lato client:
   * nessun byte del file scelto per la verifica lascia il browser. */
  async function computeFileKeccak256(file) {
    const buffer = await file.arrayBuffer();
    return global.ethers.utils.keccak256(new Uint8Array(buffer));
  }

  async function buildCardDataById(entries) {
    const cardDataById = {};
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const { json } = await global.TraceabilityDecode.decodeMetadataValue(entry.metadataValue);
          const meta = json.LSP4Metadata;
          const imageUrl = (meta.icon && meta.icon[0] && meta.icon[0].url) ||
            (meta.images && meta.images[0] && meta.images[0][0] && meta.images[0][0].url) || null;
          cardDataById[entry.tokenId] = {
            entry: entry,
            name: meta.name || entry.tokenId,
            description: meta.description || "",
            imageUrl: imageUrl ? ipfsToHttp(imageUrl) : null,
            attributes: meta.attributes || [],
          };
        } catch (err) {
          cardDataById[entry.tokenId] = { entry: entry, name: entry.tokenId, description: "", imageUrl: null, attributes: [], decodeError: err.message };
        }
      })
    );
    return cardDataById;
  }

  /** Intestazione con i metadata della COLLEZIONE (il registro stesso, non i singoli token). */
  async function renderCollectionHeader(containerEl, collectionMetadataValue) {
    if (!containerEl) return;
    if (!collectionMetadataValue) { containerEl.style.display = "none"; return; }

    try {
      const { json } = await global.TraceabilityDecode.decodeMetadataValue(collectionMetadataValue);
      const meta = json.LSP4Metadata;
      const iconUrl = meta.icon && meta.icon[0] && meta.icon[0].url ? ipfsToHttp(meta.icon[0].url) : null;
      const bannerUrl = meta.backgroundImage && meta.backgroundImage[0] && meta.backgroundImage[0].url
        ? ipfsToHttp(meta.backgroundImage[0].url) : null;

      let html = "";
      if (bannerUrl) html += "<img class='te-banner' src='" + bannerUrl + "' alt=''>";
      html += "<div class='te-collection-body'>";
      if (iconUrl) html += "<img class='te-collection-icon' src='" + iconUrl + "' alt=''>";
      html += "<div><h2>" + escapeHtml(meta.name || "") + "</h2>";
      if (meta.description) html += "<p>" + escapeHtml(meta.description) + "</p>";
      html += "</div></div>";

      containerEl.innerHTML = html;
      containerEl.style.display = "block";
    } catch (err) {
      containerEl.style.display = "none"; // metadata non decodificabile: non blocca il resto
    }
  }

  function collectFacets(cardDataById) {
    const facets = {};
    Object.values(cardDataById).forEach((cd) => {
      (cd.attributes || []).forEach((a) => {
        const k = String(a.key);
        const v = String(a.value);
        if (!facets[k]) facets[k] = new Set();
        facets[k].add(v);
      });
    });
    return facets;
  }

  /** OR tra valori della stessa chiave, AND tra chiavi diverse. */
  function cardMatchesFilters(cardData, activeFilters) {
    const activeKeys = Object.keys(activeFilters);
    if (activeKeys.length === 0) return true;
    return activeKeys.every((key) => {
      const selectedValues = activeFilters[key];
      return (cardData.attributes || []).some((a) => String(a.key) === key && selectedValues.has(String(a.value)));
    });
  }

  /**
   * Crea un'istanza di galleria indipendente sui container passati — più
   * istanze possono coesistere sulla stessa pagina (es. explorer.html e
   * user.html montano ciascuna la propria) senza interferire, dato che gli
   * elementi si distinguono per attributo data-token-id dentro il proprio
   * gridEl, non per id globale.
   */
  // Solo queste chiavi diventano pillole "normali" (corrispondenza esatta
  // chiave+valore) — tutto il resto (Nome, Quantità, e soprattutto ogni
  // "Lotto <ingrediente>" diverso per ogni batch) escluso apposta: con
  // decine di ingredienti diversi i filtri diventavano troppi da scorrere.
  const ALLOWED_FACET_KEYS = ["Fornitore", "Data Acquisto", "Data Scadenza", "Ricetta", "Data Produzione", "Data Imbottigliamento"];

  /** Tutti i valori di lotto esistenti, aggregati attraverso qualunque
   * chiave "Lotto" o "Lotto <ingrediente>" — usati per popolare la pillola
   * "Lotto" con un elenco selezionabile, invece di dover conoscere a
   * memoria il numero di lotto e digitarlo/incollarlo (pessima UX con solo
   * il campo di testo, come notato). */
  function collectLotValues(cardDataById) {
    const values = new Set();
    Object.values(cardDataById).forEach((cd) => {
      (cd.attributes || []).forEach((a) => {
        const key = String(a.key);
        if (key === "Lotto" || key.indexOf("Lotto ") === 0) values.add(String(a.value));
      });
    });
    return values;
  }

  function createGalleryInstance({ headerEl, statusEl, filtersEl, gridEl, t, onInvalidate, onSetDocumentHash }) {
    let currentCardDataById = {};
    let activeFilters = {};
    let lotSearchText = "";
    let lastLoadParams = null;

    /** Chiude ogni chip aperta di QUESTA istanza — serve a più gallerie
     * indipendenti sulla stessa pagina senza interferire tra loro. */
    function closeAllDropdowns() {
      if (filtersEl) filtersEl.querySelectorAll(".te-filter-chip.open").forEach((c) => c.classList.remove("open"));
    }
    // Click fuori da un menu chiude quello aperto — un solo listener per
    // istanza (aggiunto una volta sola qui, non ad ogni renderFilters, per
    // non accumularne uno ad ogni caricamento).
    document.addEventListener("click", closeAllDropdowns);

    function renderFilters(cardDataById) {
      if (!filtersEl) return;
      const facets = collectFacets(cardDataById);
      const allowedKeys = ALLOWED_FACET_KEYS.filter((k) => facets[k]);
      const lotValues = collectLotValues(cardDataById);
      if (allowedKeys.length === 0 && lotValues.size === 0) { filtersEl.style.display = "none"; return; }

      // Ricerca testuale trasversale per numero di lotto — resta anche il
      // campo libero (utile se il lotto lo si conosce già), in aggiunta
      // alla pillola "Lotto" sotto (utile se invece non lo si conosce e si
      // vuole scegliere da un elenco).
      let html = "<div class='te-lot-search'><input type='text' class='te-lot-search-input' placeholder='" + t("filters.lotSearchPlaceholder") + "' value='" + escapeHtml(lotSearchText) + "'></div>";

      html += "<div class='te-filters-row'>";

      // Chip "Lotto": aggregata su tutte le chiavi Lotto*, click = ricerca
      // trasversale (stessa logica del campo libero), NON corrispondenza
      // esatta chiave+valore come le altre pillole sotto.
      if (lotValues.size > 0) {
        html += "<div class='te-filter-chip te-lot-chip" + (lotSearchText ? " has-active" : "") + "' data-facet-key='Lotto'>";
        html += "<button type='button' class='te-chip-toggle'>Lotto (" + lotValues.size + ")</button>";
        html += "<div class='te-filter-dropdown'><div class='te-filter-pills'>";
        Array.from(lotValues).sort().forEach((value) => {
          const activeClass = value === lotSearchText ? " active" : "";
          html += "<button type='button' class='te-pill te-lot-pill" + activeClass + "' data-value='" + escapeHtml(value) + "'>" + escapeHtml(value) + "</button>";
        });
        html += "</div></div></div>";
      }

      // Chip orizzontali a capo automatico + menu a comparsa (overlay, non
      // spinge il contenuto) — stesso pattern di universaleverything.io.
      allowedKeys.forEach((key) => {
        html += "<div class='te-filter-chip' data-facet-key='" + escapeHtml(key) + "'>";
        html += "<button type='button' class='te-chip-toggle'>" + escapeHtml(key) + " (" + facets[key].size + ")</button>";
        html += "<div class='te-filter-dropdown'><div class='te-filter-pills'>";
        Array.from(facets[key]).sort().forEach((value) => {
          html += "<button type='button' class='te-pill' data-key='" + escapeHtml(key) + "' data-value='" + escapeHtml(value) + "'>" + escapeHtml(value) + "</button>";
        });
        html += "</div></div></div>";
      });
      html += "</div>";
      html += "<span class='te-filters-clear'>" + t("filters.clear") + "</span>";
      filtersEl.innerHTML = html;
      filtersEl.style.display = "block";

      const searchInput = filtersEl.querySelector(".te-lot-search-input");
      searchInput.addEventListener("input", () => {
        lotSearchText = searchInput.value;
        // Digitare a mano non corrisponde più necessariamente a un valore
        // esatto della lista — tolgo l'evidenziazione della pillola.
        filtersEl.querySelectorAll(".te-lot-pill.active").forEach((p) => p.classList.remove("active"));
        const lotChip = filtersEl.querySelector(".te-lot-chip");
        if (lotChip) lotChip.classList.toggle("has-active", !!lotSearchText);
        applyCardFilters();
      });

      filtersEl.querySelectorAll(".te-lot-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          const value = pill.dataset.value;
          const wasActive = pill.classList.contains("active");
          filtersEl.querySelectorAll(".te-lot-pill.active").forEach((p) => p.classList.remove("active"));
          lotSearchText = wasActive ? "" : value;
          if (!wasActive) pill.classList.add("active");
          searchInput.value = lotSearchText;
          const lotChip = filtersEl.querySelector(".te-lot-chip");
          if (lotChip) lotChip.classList.toggle("has-active", !!lotSearchText);
          applyCardFilters();
        });
      });

      filtersEl.querySelectorAll(".te-chip-toggle").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation(); // non far scattare subito closeAllDropdowns
          const chip = btn.closest(".te-filter-chip");
          const wasOpen = chip.classList.contains("open");
          closeAllDropdowns(); // un solo menu aperto alla volta
          if (!wasOpen) chip.classList.add("open");
        });
      });

      filtersEl.querySelectorAll(".te-filter-dropdown").forEach((dropdown) => {
        dropdown.addEventListener("click", (e) => e.stopPropagation()); // click dentro il menu non lo chiude
      });

      filtersEl.querySelectorAll(".te-pill:not(.te-lot-pill)").forEach((pill) => {
        pill.addEventListener("click", () => togglePill(pill));
      });
      filtersEl.querySelector(".te-filters-clear").addEventListener("click", (e) => {
        e.stopPropagation();
        lotSearchText = "";
        searchInput.value = "";
        clearFilters();
      });
    }

    function togglePill(pill) {
      const key = pill.dataset.key;
      const value = pill.dataset.value;
      if (!activeFilters[key]) activeFilters[key] = new Set();

      if (activeFilters[key].has(value)) {
        activeFilters[key].delete(value);
        if (activeFilters[key].size === 0) delete activeFilters[key];
        pill.classList.remove("active");
      } else {
        activeFilters[key].add(value);
        pill.classList.add("active");
      }

      const chip = pill.closest(".te-filter-chip");
      chip.classList.toggle("has-active", !!activeFilters[key] && activeFilters[key].size > 0);
      applyCardFilters();
    }

    function clearFilters() {
      activeFilters = {};
      if (filtersEl) {
        filtersEl.querySelectorAll(".te-pill.active").forEach((p) => p.classList.remove("active"));
        filtersEl.querySelectorAll(".te-filter-chip.has-active").forEach((c) => c.classList.remove("has-active"));
      }
      applyCardFilters();
    }

    /** Vero se QUALUNQUE attributo con chiave "Lotto" o che inizia per
     * "Lotto " contiene il testo cercato (case-insensitive) — stesso
     * prefisso già usato in traceability-json-validators.js per il
     * matching automatico all'inserimento, qui riusato per la ricerca. */
    function cardHasMatchingLot(cardData, searchText) {
      const needle = (searchText || "").trim().toLowerCase();
      if (!needle) return true;
      return (cardData.attributes || []).some((a) => {
        const key = String(a.key);
        if (key !== "Lotto" && key.indexOf("Lotto ") !== 0) return false;
        return String(a.value).toLowerCase().indexOf(needle) !== -1;
      });
    }

    function applyCardFilters() {
      let visibleCount = 0;
      Object.keys(currentCardDataById).forEach((tokenId) => {
        const cardEl = gridEl.querySelector("[data-token-id='" + tokenId + "']");
        if (!cardEl) return;
        const cardData = currentCardDataById[tokenId];
        const matches = cardMatchesFilters(cardData, activeFilters) && cardHasMatchingLot(cardData, lotSearchText);
        cardEl.style.display = matches ? "" : "none";
        if (matches) visibleCount++;
      });
      if (statusEl) statusEl.textContent = visibleCount === 0 ? t("status.noMatch") : "";
    }

    function renderGrid(entries, cardDataById) {
      gridEl.innerHTML = "";
      entries.forEach((entry) => {
        const cardData = cardDataById[entry.tokenId];
        const card = document.createElement("div");
        card.className = "te-card" + (entry.status === 1 ? " te-invalidated" : "");
        card.dataset.tokenId = entry.tokenId;

        const badgeClass = entry.entryType === 1 ? "te-badge-batch" : "te-badge-lot";
        const badgeLabel = entry.entryType === 1 ? t("badge.batch") : t("badge.lot");

        let html = "";
        if (cardData.imageUrl) html += "<img src='" + cardData.imageUrl + "' alt=''>";
        else html += "<div class='te-noimage'>" + t("card.noImage") + "</div>";

        html += "<div class='te-card-body'>";
        html += "<span class='te-badge " + badgeClass + "'>" + badgeLabel + "</span>";
        if (entry.status === 1) html += "<span class='te-badge te-badge-invalid'>" + t("badge.invalidated") + "</span>";
        html += "<h3>" + escapeHtml(cardData.name) + "</h3>";
        if (entry.status === 1 && entry.invalidationReason) {
          html += "<p class='te-invalid-reason'>" + t("card.invalidationReasonLabel") + " " + escapeHtml(entry.invalidationReason) + "</p>";
        }
        if (cardData.description) html += "<p class='te-desc'>" + escapeHtml(cardData.description) + "</p>";

        html += "<div class='te-attrs'>";
        cardData.attributes.forEach((a) => {
          html += "<div class='te-attr-row'><span>" + escapeHtml(String(a.key)) + "</span><span>" + escapeHtml(String(a.value)) + "</span></div>";
        });
        if (entry.entryType === 1 && entry.usedLots && entry.usedLots.length > 0) {
          html += "<div class='te-used-lots'><strong>" + t("card.usedLots") + "</strong>";
          entry.usedLots.forEach((lotTokenId) => {
            const lotData = cardDataById[lotTokenId];
            const label = lotData ? lotData.name : lotTokenId;
            html += "<a href='#' data-scroll-to='" + lotTokenId + "'>→ " + escapeHtml(label) + "</a>";
          });
          html += "</div>";
        }
        // Bottone di annullamento — solo se il chiamante l'ha abilitato
        // (mai su explorer.html, pubblica e senza wallet) e solo su entry
        // ancora valide (un token già annullato non si annulla di nuovo).
        if (onInvalidate && entry.status !== 1) {
          html += "<button type='button' class='te-invalidate-btn' data-invalidate-token='" + entry.tokenId + "'>" + t("card.invalidateButton") + "</button>";
        }
        // Badge + verifica locale — mostrati su QUALUNQUE gallery (privata o
        // pubblica su explorer.html) quando esiste un hash registrato:
        // l'hash è comunque pubblico on-chain, quindi non c'è nulla da
        // nascondere nel mostrarlo; la verifica avviene interamente lato
        // client (nessun file caricato da nessuna parte), coerente con la
        // scelta di non offrire un download pubblico del documento vero e
        // proprio dall'explorer pubblico.
        if (hasDocumentHash(entry)) {
          html += "<div class='te-dochash-info'>" +
            "<span class='te-dochash-badge'>" + t("card.documentHashBadge") + "</span> " +
            "<code class='te-dochash-value' title='" + escapeHtml(entry.documentHash) + "'>" + escapeHtml(shortHash(entry.documentHash)) + "</code>" +
            "<div class='te-verify-row'>" +
            "<input type='file' class='te-verify-input' data-verify-token='" + entry.tokenId + "'>" +
            "<button type='button' class='te-verify-btn' data-verify-token='" + entry.tokenId + "'>" + t("card.verifyButton") + "</button>" +
            "<span class='te-verify-result' data-verify-result='" + entry.tokenId + "'></span>" +
            "</div></div>";
        }
        // Attestazione hash documento (Gold-only lato contratto —
        // onlyGoldFeature — non filtrato qui: il bottone compare per
        // chiunque abbia accesso a questa gallery col callback abilitato,
        // il contratto stesso rifiuta la tx se il tier non è Gold). Nascosto
        // se un hash è già presente per non sovrascriverlo per sbaglio — il
        // contratto non impedisce la sostituzione, quindi il gate è qui.
        if (onSetDocumentHash && !hasDocumentHash(entry)) {
          html += "<div class='te-dochash-row'>" +
            "<input type='file' class='te-dochash-input' data-dochash-token='" + entry.tokenId + "'>" +
            "<button type='button' class='te-dochash-btn' data-dochash-token='" + entry.tokenId + "'>" + t("card.setDocumentHashButton") + "</button>" +
            "</div>";
        }
        html += "</div></div>";

        card.innerHTML = html;
        card.addEventListener("click", (e) => {
          if (e.target.tagName === "A" || e.target.tagName === "INPUT" ||
              e.target.classList.contains("te-invalidate-btn") ||
              e.target.classList.contains("te-dochash-btn") ||
              e.target.classList.contains("te-verify-btn")) return;
          card.classList.toggle("te-expanded");
        });
        gridEl.appendChild(card);
      });

      gridEl.querySelectorAll("a[data-scroll-to]").forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const el = gridEl.querySelector("[data-token-id='" + a.dataset.scrollTo + "']");
          if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("te-expanded"); }
        });
      });

      if (onInvalidate) {
        gridEl.querySelectorAll(".te-invalidate-btn").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const tokenId = btn.dataset.invalidateToken;
            const reason = window.prompt(t("card.invalidateReasonPrompt"));
            if (reason === null) return; // annullato dall'utente (Cancel sul prompt)
            btn.disabled = true;
            btn.textContent = t("card.invalidating");
            try {
              await onInvalidate(tokenId, reason);
              if (lastLoadParams) await load(lastLoadParams.backendBaseUrl, lastLoadParams.registryAddress);
            } catch (err) {
              btn.disabled = false;
              btn.textContent = t("card.invalidateButton");
              window.alert(t("card.invalidateError", { msg: err.message }));
            }
          });
        });
      }

      // Verifica locale — indipendente da onSetDocumentHash, disponibile
      // anche sull'explorer pubblico (senza wallet): confronta il keccak256
      // del file scelto con l'hash già letto on-chain per quell'entry.
      gridEl.querySelectorAll(".te-verify-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const tokenId = btn.dataset.verifyToken;
          const input = gridEl.querySelector(".te-verify-input[data-verify-token='" + tokenId + "']");
          const resultEl = gridEl.querySelector(".te-verify-result[data-verify-result='" + tokenId + "']");
          const file = input && input.files[0];
          if (!file) { window.alert(t("card.setDocumentHashNeedFile")); return; }
          try {
            const computedHash = await computeFileKeccak256(file);
            const expectedHash = currentCardDataById[tokenId].entry.documentHash;
            const matches = computedHash.toLowerCase() === String(expectedHash).toLowerCase();
            resultEl.textContent = matches ? t("card.verifyMatch") : t("card.verifyMismatch");
            resultEl.className = "te-verify-result " + (matches ? "te-verify-ok" : "te-verify-fail");
          } catch (err) {
            resultEl.textContent = t("card.verifyError", { msg: err.message });
            resultEl.className = "te-verify-result te-verify-fail";
          }
        });
      });

      if (onSetDocumentHash) {
        gridEl.querySelectorAll(".te-dochash-btn").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const tokenId = btn.dataset.dochashToken;
            const input = gridEl.querySelector(".te-dochash-input[data-dochash-token='" + tokenId + "']");
            const file = input && input.files[0];
            if (!file) { window.alert(t("card.setDocumentHashNeedFile")); return; }
            btn.disabled = true;
            btn.textContent = t("card.settingDocumentHash");
            try {
              await onSetDocumentHash(tokenId, file);
              window.alert(t("card.setDocumentHashSuccess"));
              if (input) input.value = "";
              // Ricarica: la card deve ora mostrare il badge e nascondere
              // l'upload, stessa logica già usata dopo onInvalidate.
              if (lastLoadParams) await load(lastLoadParams.backendBaseUrl, lastLoadParams.registryAddress);
            } catch (err) {
              window.alert(t("card.setDocumentHashError", { msg: err.message }));
              btn.disabled = false;
              btn.textContent = t("card.setDocumentHashButton");
            }
          });
        });
      }
    }

    async function load(backendBaseUrl, registryAddress) {
      lastLoadParams = { backendBaseUrl, registryAddress };
      if (statusEl) statusEl.textContent = t("status.loading");
      if (gridEl) gridEl.innerHTML = "";
      if (filtersEl) filtersEl.style.display = "none";

      let data;
      try {
        data = await global.TraceabilityDecode.fetchRegistryEntries(backendBaseUrl, registryAddress);
      } catch (err) {
        if (statusEl) statusEl.innerHTML = "<p class='te-err'>" + t("status.error", { msg: err.message }) + "</p>";
        return;
      }

      if (headerEl) await renderCollectionHeader(headerEl, data.collectionMetadataValue);

      if (!data.entries || data.entries.length === 0) {
        if (statusEl) statusEl.innerHTML = "<p class='te-empty'>" + t("status.empty") + "</p>";
        return;
      }
      if (statusEl) statusEl.textContent = "";

      const cardDataById = await buildCardDataById(data.entries);
      currentCardDataById = cardDataById;
      activeFilters = {};
      lotSearchText = "";
      renderFilters(cardDataById);
      renderGrid(data.entries, cardDataById);
    }

    return { load: load };
  }

  global.TraceabilityExplorerUI = {
    createGalleryInstance: createGalleryInstance,
    renderCollectionHeader: renderCollectionHeader,
    buildCardDataById: buildCardDataById,
    collectFacets: collectFacets,
    cardMatchesFilters: cardMatchesFilters,
  };
})(typeof window !== "undefined" ? window : globalThis);