/**
 * Limite di richieste per indirizzo IP (finestra fissa di un minuto), in
 * memoria, senza dipendenze. Audit §56 punto 5: gli endpoint pubblici
 * (lettura on-chain) e anche quelli firmati fanno chiamate RPC a ogni
 * richiesta — anche una firma non valida costa una verifica ERC-1271 — quindi
 * senza un tetto chiunque può consumare la quota della chiave RPC dedicata.
 *
 * L'IP è quello del client reale: il backend ascolta solo su localhost dietro
 * nginx, che passa l'indirizzo in X-Forwarded-For; server.js imposta
 * `trust proxy` su loopback perché Express lo usi (req.ip).
 *
 * In memoria vuol dire: si azzera al riavvio e vale per un solo processo —
 * adeguato a un backend singolo sotto pm2. Con più istanze servirebbe un
 * archivio condiviso (Redis) o il limite in nginx (limit_req).
 */
function createRateLimiter({ maxPerMinute, name = "api" }) {
  const hits = new Map(); // ip -> { windowStart, count }
  const WINDOW_MS = 60 * 1000;

  // Pulizia periodica: le finestre scadute non restano in memoria.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) {
      if (now - h.windowStart >= WINDOW_MS) hits.delete(ip);
    }
  }, WINDOW_MS);
  sweeper.unref();

  return function rateLimit(req, res, next) {
    if (!maxPerMinute || maxPerMinute <= 0) return next(); // 0 = disattivato
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.windowStart >= WINDOW_MS) {
      h = { windowStart: now, count: 0 };
      hits.set(ip, h);
    }
    h.count++;
    const remainingMs = WINDOW_MS - (now - h.windowStart);
    res.set("RateLimit-Limit", String(maxPerMinute));
    res.set("RateLimit-Remaining", String(Math.max(0, maxPerMinute - h.count)));
    if (h.count > maxPerMinute) {
      res.set("Retry-After", String(Math.ceil(remainingMs / 1000)));
      if (h.count === maxPerMinute + 1) {
        console.warn("rate limit " + name + ": superato da " + ip);
      }
      return res.status(429).json({ error: "Troppe richieste: riprova tra qualche secondo." });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
