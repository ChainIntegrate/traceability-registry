/**
 * TraceabilityRegistry — traduzione errori in linguaggio comprensibile.
 *
 * Le pagine user-*.html mostravano finora l'errore grezzo di ethers/UP
 * direttamente all'utente (es. "err.message" interpolato in un log), quindi
 * pieno di gergo blockchain ("execution reverted: TraceabilityRegistry:
 * caller is not authorized", JSON-RPC error object, ecc.). Questo modulo fa
 * da traduttore: riconosce le stringhe require() note (dai contratti in
 * contracts/TraceabilityRegistry.sol e TraceabilityRegistryFactory.sol) e i
 * casi comuni (firma/transazione annullata dall'utente), e restituisce un
 * messaggio comprensibile nella lingua corrente — SEMPRE seguito dal
 * dettaglio tecnico originale, mai al posto suo (utile a chi deve fare
 * supporto o segnalare un bug).
 *
 * Include <script src="traceability-error-messages.js"></script> prima
 * dello script che gestisce le chiamate al contratto/i signedRequest.
 *
 * ATTENZIONE MANUTENZIONE: se cambia (o si aggiunge) una stringa require()
 * nei contratti, o un messaggio di errore del backend che vale la pena
 * tradurre, va aggiunta anche qui in REASON_MAP.
 */
(function (global) {
  "use strict";

  // -----------------------------------------------------------------------
  // Mappa: frammento caratteristico della stringa require()/errore backend
  // -> spiegazione comprensibile nelle due lingue. Cerchiamo una sottostringa
  // (non un match esatto) perché ethers avvolge il messaggio originale dentro
  // formati diversi a seconda del provider/versione (err.reason, err.error.message,
  // "... reverted with reason string '...'", ecc.) ma la stringa require()
  // vera e propria compare sempre per intero da qualche parte.
  // -----------------------------------------------------------------------
  const REASON_MAP = [
    // --- TraceabilityRegistry.sol ---
    {
      match: "caller is not registryAdmin",
      it: "Questa operazione può farla solo il titolare del registro.",
      en: "Only the registry's owner can do this.",
    },
    {
      match: "caller is not authorized",
      it: "Questo indirizzo non è autorizzato su questo registro: non è né il titolare né un delegato.",
      en: "This address isn't authorized on this registry: it's neither the owner nor a delegate.",
    },
    {
      match: "membership non valida o sospesa",
      it: "La membership collegata a questo registro non è attiva: l'operazione non è consentita finché non viene riattivata.",
      en: "The membership linked to this registry isn't active: this action isn't allowed until it's reactivated.",
    },
    {
      match: "not allowed to manage delegates",
      // Il contratto dà questo stesso errore anche a membership sospesa
      // (tier 0 < soglia): con context.tier === 0 si usa il messaggio "sospesa".
      alsoWhenSuspended: true,
      it: "Gestire le deleghe richiede una membership almeno Silver.",
      en: "Managing delegates requires at least a Silver membership.",
    },
    {
      match: "requires Gold tier",
      // Il contratto dà questo stesso errore anche a membership sospesa
      // (tier 0 < soglia): con context.tier === 0 si usa il messaggio "sospesa".
      alsoWhenSuspended: true,
      it: "Questa funzione richiede una membership Gold.",
      en: "This feature requires a Gold membership.",
    },
    {
      match: "tokenId already used",
      it: "Questo codice risulta già registrato in questo registro: non può essere usato due volte.",
      en: "This code is already registered in this registry: it can't be used twice.",
    },
    {
      match: "indexDate required",
      it: "Manca la data richiesta per questa registrazione.",
      en: "The date required for this entry is missing.",
    },
    {
      match: "referenced lot does not exist",
      it: "Uno dei lotti di materia prima richiamati non risulta registrato in questo registro.",
      en: "One of the referenced raw-material lots isn't registered in this registry.",
    },
    {
      match: "tokenId does not exist",
      it: "Questa voce non risulta registrata in questo registro.",
      en: "This entry isn't registered in this registry.",
    },
    {
      match: "tokenId has no EntryType set",
      it: "Questa voce non risulta registrata in questo registro.",
      en: "This entry isn't registered in this registry.",
    },
    {
      match: "tokenId has no IndexDate set",
      it: "Questa voce non risulta registrata in questo registro.",
      en: "This entry isn't registered in this registry.",
    },
    {
      match: "not a ProductionBatch",
      it: "Questa operazione vale solo per un batch di produzione, non per un lotto di materia prima.",
      en: "This action only applies to a production batch, not a raw-material lot.",
    },
    {
      match: "empty hash",
      it: "Manca l'hash del documento da registrare.",
      en: "The document hash to record is missing.",
    },
    {
      match: "empty tokenIds",
      it: "Nessun elemento selezionato per questa operazione.",
      en: "No items selected for this action.",
    },
    {
      match: "already a delegate",
      it: "Questo indirizzo è già un delegato.",
      en: "This address is already a delegate.",
    },
    {
      match: "not a delegate",
      it: "Questo indirizzo non è (o non è più) un delegato.",
      en: "This address isn't (or is no longer) a delegate.",
    },
    {
      match: "zero address",
      it: "Manca un indirizzo valido.",
      en: "A valid address is missing.",
    },
    // --- TraceabilityRegistryFactory.sol (soprattutto admin.html, ma innocuo
    //     lasciarlo qui: se mai comparisse altrove viene comunque tradotto) ---
    {
      match: "no sector assigned",
      it: "A questo indirizzo non è ancora stato assegnato un settore: contatta ChainIntegrate.",
      en: "No sector has been assigned to this address yet: contact ChainIntegrate.",
    },
    {
      match: "no valid membership",
      it: "Nessuna membership valida trovata per questo indirizzo.",
      en: "No valid membership found for this address.",
    },
    {
      match: "caller is not ChainIntegrate",
      it: "Questa operazione può farla solo ChainIntegrate.",
      en: "Only ChainIntegrate can do this.",
    },
    {
      match: "sector required",
      it: "Manca il settore da assegnare.",
      en: "The sector to assign is missing.",
    },
    // --- Errori backend §49 (gate tier sull'upload IPFS) ---
    {
      match: "Membership sospesa o mai attiva",
      it: "Membership sospesa: l'upload non è consentito finché non viene riattivata.",
      en: "Membership suspended: uploads aren't allowed until it's reactivated.",
    },
    {
      match: "Indirizzo non autorizzato",
      it: "Questo indirizzo non è autorizzato su questo registro: non è né il titolare né un delegato.",
      en: "This address isn't authorized on this registry: it's neither the owner nor a delegate.",
    },
    // --- Errori tipici del provider RPC/UP extension ---
    {
      match: "insufficient funds",
      it: "Fondi insufficienti per pagare il gas della transazione.",
      en: "Insufficient funds to pay the transaction's gas.",
    },
    {
      match: "network changed",
      it: "La rete è cambiata durante l'operazione: riprova dopo aver verificato di essere sulla rete corretta.",
      en: "The network changed during the operation: please check you're on the right network and try again.",
    },
  ];

  /** Le firme UP annullate arrivano in forme diverse a seconda del provider:
   * codice numerico standard EIP-1193 (4001), stringa ethers v5, o testo
   * libero nel messaggio — copriamo tutte e tre. */
  function isUserRejection(err, raw) {
    if (!err) return false;
    if (err.code === 4001 || err.code === "ACTION_REJECTED") return true;
    const msg = (raw || "").toLowerCase();
    return (
      msg.indexOf("user rejected") !== -1 ||
      msg.indexOf("user denied") !== -1 ||
      msg.indexOf("rejected the request") !== -1
    );
  }

  /** Raccoglie i testi utili da err e dai suoi errori annidati (ethers v5
   * incapsula l'errore del provider in err.error, a volte in err.error.error,
   * e la UP extension ha la sua forma ancora diversa). Profondità limitata. */
  function collectStrings(obj, depth, out) {
    if (!obj || typeof obj !== "object" || depth > 4) return out;
    ["reason", "shortMessage", "message", "data", "body"].forEach(function (k) {
      if (typeof obj[k] === "string" && obj[k].length > 0) out.push(obj[k]);
    });
    ["error", "data", "info", "cause"].forEach(function (k) {
      if (obj[k] && typeof obj[k] === "object") collectStrings(obj[k], depth + 1, out);
    });
    return out;
  }

  /** La sola frase di revert del contratto (es. "TraceabilityRegistry:
   * requires Gold tier"), se si riesce a isolarla: dal campo reason di
   * ethers, dal testo "execution reverted: ...", o decodificando i dati
   * grezzi Error(string) (selettore 0x08c379a0) quando arriva solo quelli. */
  function extractRevertReason(err, strings) {
    if (err && typeof err.reason === "string" && err.reason.indexOf("TraceabilityRegistry") !== -1) {
      return err.reason.replace(/^execution reverted:?\s*/, "");
    }
    for (let i = 0; i < strings.length; i++) {
      const m = /reverted(?: with reason string)?:?\s*'?([^"'|\\\n]+)/.exec(strings[i]);
      if (m && m[1].trim().length > 0) return m[1].trim();
    }
    if (typeof ethers !== "undefined") {
      for (let i = 0; i < strings.length; i++) {
        const hex = /0x08c379a0[0-9a-fA-F]+/.exec(strings[i]);
        if (!hex) continue;
        try {
          return ethers.utils.defaultAbiCoder.decode(["string"], "0x" + hex[0].slice(10))[0];
        } catch (e) { /* dati non decodificabili: si prosegue */ }
      }
    }
    return "";
  }

  /** Dettaglio tecnico da mostrare tra parentesi: breve. Prima il motivo del
   * revert se c'è, altrimenti la prima frase del messaggio d'errore — mai
   * l'intero messaggio ethers con transazione e JSON del provider. */
  function shortDetail(err, strings, revertReason) {
    if (revertReason) return revertReason;
    const first = (strings[0] || "").split(" [ See:")[0].split(" (")[0].trim();
    return first.length > 160 ? first.slice(0, 157) + "..." : first;
  }

  /**
   * @param {*} err - l'errore catturato (ethers v5, fetch, o generico)
   * @param {"it"|"en"} lang - lingua corrente della UI
   * @param {{tier: ?number}} [context] - tier del registro, se noto: a tier 0
   *        gli errori "serve Gold/Silver" diventano "membership sospesa"
   * @returns {string} messaggio comprensibile, con il dettaglio tecnico in coda
   */
  const SUSPENDED_MESSAGE = {
    it: "La membership collegata a questo registro è sospesa: l'operazione non è consentita finché non viene riattivata.",
    en: "The membership linked to this registry is suspended: this action isn't allowed until it's reactivated.",
  };

  function friendlyMessage(err, lang, context) {
    const isIt = lang !== "en";
    const strings = collectStrings(err, 0, []);
    if (typeof err === "string") strings.push(err);
    const raw = strings.join(" | ");
    const revertReason = extractRevertReason(err, strings);
    const detail = shortDetail(err, strings, revertReason) || (isIt ? "errore sconosciuto" : "unknown error");

    if (isUserRejection(err, raw)) {
      return isIt
        ? "Hai annullato la richiesta nella tua Universal Profile."
        : "You cancelled the request in your Universal Profile.";
    }

    for (let i = 0; i < REASON_MAP.length; i++) {
      const entry = REASON_MAP[i];
      if (raw.indexOf(entry.match) !== -1 || revertReason.indexOf(entry.match) !== -1) {
        if (entry.alsoWhenSuspended && context && context.tier === 0) {
          return (isIt ? SUSPENDED_MESSAGE.it + " (dettaglio tecnico: " : SUSPENDED_MESSAGE.en + " (technical detail: ") + detail + ")";
        }
        return isIt
          ? entry.it + " (dettaglio tecnico: " + detail + ")"
          : entry.en + " (technical detail: " + detail + ")";
      }
    }

    // Nessuna corrispondenza nota: mai la sola stringa blockchain da sola —
    // un'introduzione onesta e comprensibile, poi il dettaglio tecnico grezzo.
    return isIt
      ? "Operazione non riuscita. Dettaglio tecnico: " + detail
      : "The operation failed. Technical detail: " + detail;
  }

  global.TraceabilityErrors = { friendlyMessage: friendlyMessage };
})(typeof window !== "undefined" ? window : this);
