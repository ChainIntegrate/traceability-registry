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
  function createGalleryInstance({ headerEl, statusEl, filtersEl, gridEl, t, onInvalidate }) {
    let currentCardDataById = {};
    let activeFilters = {};
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
      const keys = Object.keys(facets);
      if (keys.length === 0) { filtersEl.style.display = "none"; return; }

      // Chip orizzontali a capo automatico + menu a comparsa (overlay, non
      // spinge il contenuto) — stesso pattern di universaleverything.io.
      // Le tendine <details> impilate verticalmente (versione precedente)
      // con molte chiavi (ogni ingrediente di un batch ne genera una
      // propria) rendevano la pagina troppo lunga anche da chiuse.
      let html = "<div class='te-filters-row'>";
      keys.forEach((key) => {
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

      filtersEl.querySelectorAll(".te-pill").forEach((pill) => {
        pill.addEventListener("click", () => togglePill(pill));
      });
      filtersEl.querySelector(".te-filters-clear").addEventListener("click", (e) => { e.stopPropagation(); clearFilters(); });
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

    function applyCardFilters() {
      let visibleCount = 0;
      Object.keys(currentCardDataById).forEach((tokenId) => {
        const cardEl = gridEl.querySelector("[data-token-id='" + tokenId + "']");
        if (!cardEl) return;
        const matches = cardMatchesFilters(currentCardDataById[tokenId], activeFilters);
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
        html += "</div></div>";

        card.innerHTML = html;
        card.addEventListener("click", (e) => {
          if (e.target.tagName === "A" || e.target.classList.contains("te-invalidate-btn")) return;
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