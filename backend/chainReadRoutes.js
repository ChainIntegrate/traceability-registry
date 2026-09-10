const express = require("express");
const { ethers } = require("ethers");
const { TRACEABILITY_REGISTRY_READ_ABI, LSP4_METADATA_KEY } = require("./registryAbi");
const { verifyRegistryIsKnown } = require("./authGuard");
const { chunkedQueryFilter } = require("./blockChunks");
const cache = require("./chainReadCache");

const MAX_BLOCK_RANGE = parseInt(process.env.MAX_BLOCK_RANGE_PER_CALL || "10000", 10);
const CACHE_TTL_SECONDS = parseInt(process.env.CHAIN_READ_CACHE_TTL_SECONDS || "0", 10); // 0 = disattivata di default

/**
 * Logica pura (nessuna chiamata di rete) di combinazione e ordinamento —
 * separata dalla route per essere testabile senza un nodo RPC vero.
 */
function mergeEntries(lotEvents, batchEvents, invalidatedTokenIds) {
  const lots = lotEvents.map((e) => ({
    tokenId: e.args.tokenId,
    entryType: 0, // RawMaterialLot
    indexDate: Number(e.args.indexDate),
    usedLots: [],
  }));

  const batches = batchEvents.map((e) => ({
    tokenId: e.args.tokenId,
    entryType: 1, // ProductionBatch
    indexDate: Number(e.args.indexDate),
    usedLots: e.args.usedLots,
  }));

  const merged = lots.concat(batches).map((entry) => ({
    ...entry,
    status: invalidatedTokenIds.has(entry.tokenId) ? 1 : 0, // 1 = Invalidated
  }));

  merged.sort((a, b) => b.indexDate - a.indexDate);
  return merged;
}

/**
 * @param {ethers.providers.Provider} provider - stesso provider backend-side
 *        di tutte le altre route, mai esposto al browser.
 * @param {ethers.Contract} factoryContract - verifica di legittimità: senza
 *        questo controllo, chiunque potrebbe puntare un contratto proprio
 *        qui e usare gratis il nostro nodo RPC.
 */
function buildChainReadRouter(provider, factoryContract) {
  const router = express.Router();

  /**
   * Pubblica, nessuna firma richiesta: i dati già mintati sono per design
   * verificabili da chiunque — diverso dalla libreria foto. Usata sia dal
   * widget pubblico sia, internamente, dalla UI di mint per il matching
   * automatico lotto→tokenId.
   */
  router.get("/registry/:address/entries", async (req, res) => {
    try {
      const registryAddress = req.params.address;
      if (!registryAddress || !ethers.utils.isAddress(registryAddress)) {
        return res.status(400).json({ error: "Indirizzo registry non valido." });
      }

      let known;
      try {
        known = await verifyRegistryIsKnown(factoryContract, registryAddress);
      } catch (err) {
        console.error("GET entries: errore verifica Factory:", err.message);
        return res.status(400).json({ error: "Impossibile verificare il registry." });
      }
      if (!known) {
        return res.status(403).json({ error: "registryAddress non riconosciuto (non deployato dalla Factory ChainIntegrate)." });
      }

      const cacheKey = "entries:" + registryAddress.toLowerCase();
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const registry = new ethers.Contract(registryAddress, TRACEABILITY_REGISTRY_READ_ABI, provider);

      let deployedAtBlockBN;
      try {
        deployedAtBlockBN = await registry.deployedAtBlock();
      } catch (err) {
        return res.status(400).json({ error: "Indirizzo non corrisponde a un TraceabilityRegistry valido." });
      }
      const fromBlock = deployedAtBlockBN.toNumber();
      const latestBlock = await provider.getBlockNumber();

      // Enumerazione via eventi, non tokenIdsOf/loop su contatore — i
      // tokenId sono hash, non sequenziali. Suddivisa in chunk: molti
      // provider RPC impongono un tetto massimo di blocchi per chiamata.
      const [lotEvents, batchEvents, invalidatedEvents] = await Promise.all([
        chunkedQueryFilter(registry, registry.filters.RawMaterialLotMinted(), fromBlock, latestBlock, MAX_BLOCK_RANGE),
        chunkedQueryFilter(registry, registry.filters.ProductionBatchMinted(), fromBlock, latestBlock, MAX_BLOCK_RANGE),
        chunkedQueryFilter(registry, registry.filters.EntryInvalidated(), fromBlock, latestBlock, MAX_BLOCK_RANGE),
      ]);

      const invalidatedTokenIds = new Set(invalidatedEvents.map((e) => e.args.tokenId));
      const entries = mergeEntries(lotEvents, batchEvents, invalidatedTokenIds);

      // Metadata grezza (bytes VerifiableURI) per ogni entry, in parallelo.
      // La decodifica (CID + hash, poi fetch dal gateway IPFS pubblico) resta
      // lato client — stessa logica già scritta in traceability-mint-compose.js.
      const entriesWithMetadata = await Promise.all(
        entries.map(async (entry) => {
          let metadataValue = null;
          try {
            metadataValue = await registry.getDataForTokenId(entry.tokenId, LSP4_METADATA_KEY);
          } catch (err) {
            metadataValue = null; // entry esiste ma senza metadata leggibile: non blocca la risposta
          }
          return { ...entry, metadataValue };
        })
      );

      const responseBody = { registryAddress, deployedAtBlock: fromBlock, entries: entriesWithMetadata };
      cache.set(cacheKey, responseBody, CACHE_TTL_SECONDS);

      return res.json(responseBody);
    } catch (err) {
      console.error("GET /api/traceability/registry/:address/entries errore:", err);
      return res.status(500).json({ error: "Errore interno." });
    }
  });

  return router;
}

module.exports = { buildChainReadRouter, mergeEntries };
