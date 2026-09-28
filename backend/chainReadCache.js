/**
 * Cache in-memory per le letture on-chain (GET /registry/:address/entries e /delegates).
 * Oggi si usa la cache legata al blocco (getForBlock, in fondo); get/set con TTL restano
 * per usi futuri.
 * Non serve oggi (pochi batch), ma il costo di ogni richiesta è "tutte le
 * chiamate RPC da zero" — con TTL=0 la cache è di fatto disattivata (utile
 * per debug), altrimenti riduce il carico sul nodo RPC senza introdurre un
 * vero indexer. Pensata per essere sostituita in futuro da qualcosa di più
 * robusto (Redis, SQLite) senza cambiare la firma delle funzioni qui sotto.
 */

const store = new Map(); // key -> { value, expiresAt }

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return; // TTL 0/negativo = cache disattivata
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function invalidate(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

// ---------------------------------------------------------------------------
// Cache legata al blocco (audit §56 punto 5).
//
// Un TTL a tempo avrebbe mostrato dati vecchi subito dopo una registrazione
// ("l'ho registrato ma non lo vedo"). Qui invece un risultato vale finché non
// arriva un blocco nuovo: ogni nuova transazione (mint, annullamento, hash
// documento, delega) sta per forza in un blocco nuovo, quindi i dati sono
// sempre aggiornati all'ultimo blocco, e la scansione pesante degli eventi
// si fa al massimo una volta per blocco e per registro, non a ogni richiesta.
// Richieste contemporanee per lo stesso registro e blocco condividono lo
// stesso calcolo.
// ---------------------------------------------------------------------------
const byKey = new Map(); // key -> { block, value }
const inflight = new Map(); // key@block -> Promise
let blockMemo = { value: null, at: 0, pending: null };
const BLOCK_NUMBER_MAX_AGE_MS = 2000;

/** Numero dell'ultimo blocco, riletto dal nodo al massimo ogni 2 secondi. */
async function latestBlockNumber(provider) {
  const now = Date.now();
  if (blockMemo.value !== null && now - blockMemo.at < BLOCK_NUMBER_MAX_AGE_MS) return blockMemo.value;
  if (!blockMemo.pending) {
    blockMemo.pending = provider.getBlockNumber()
      .then((n) => { blockMemo = { value: n, at: Date.now(), pending: null }; return n; })
      .catch((err) => { blockMemo.pending = null; throw err; });
  }
  return blockMemo.pending;
}

/** Valore per `key` aggiornato al blocco `block`: riusa quello già calcolato
 * per lo stesso blocco, altrimenti chiama `compute()` una sola volta anche
 * con più richieste contemporanee. Gli errori non vengono messi in cache. */
async function getForBlock(key, block, compute) {
  const hit = byKey.get(key);
  if (hit && hit.block === block) return hit.value;
  const flightKey = key + "@" + block;
  if (!inflight.has(flightKey)) {
    inflight.set(flightKey, (async () => {
      try {
        const value = await compute();
        const current = byKey.get(key);
        if (!current || current.block <= block) byKey.set(key, { block, value });
        return value;
      } finally {
        inflight.delete(flightKey);
      }
    })());
  }
  return inflight.get(flightKey);
}

module.exports = { get, set, invalidate, clear, latestBlockNumber, getForBlock };
