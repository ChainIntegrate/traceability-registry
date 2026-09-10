/**
 * Cache in-memory con TTL per le letture on-chain (GET /registry/:address/entries).
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

module.exports = { get, set, invalidate, clear };
