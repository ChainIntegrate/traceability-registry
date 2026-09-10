/**
 * Molti provider RPC impongono un tetto massimo di blocchi per chiamata
 * eth_getLogs (es. 10.000). queryFilter(fromBlock, "latest") in un colpo
 * solo funziona finché il range resta sotto quel tetto — non urgente ora
 * (Birra20Venti ha pochi blocchi di storia), ma il costo di prepararsi è
 * basso: se in futuro il range cresce, la chiamata comincerebbe a fallire
 * con un errore poco chiaro invece che degradare in più chiamate.
 *
 * Logica pura, nessuna chiamata di rete — testabile in isolamento.
 */
function computeBlockChunks(fromBlock, toBlock, maxBlockRange) {
  if (fromBlock > toBlock) return [];
  if (!maxBlockRange || maxBlockRange <= 0) return [[fromBlock, toBlock]];

  const chunks = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + maxBlockRange - 1, toBlock);
    chunks.push([start, end]);
    start = end + 1;
  }
  return chunks;
}

/**
 * Esegue queryFilter a chunk, concatenando i risultati. `contract` è
 * un'istanza ethers.Contract, `filterFn` è tipicamente contract.filters.X().
 */
async function chunkedQueryFilter(contract, filterFn, fromBlock, toBlock, maxBlockRange) {
  const chunks = computeBlockChunks(fromBlock, toBlock, maxBlockRange);
  const results = [];
  for (const [start, end] of chunks) {
    const events = await contract.queryFilter(filterFn, start, end);
    results.push(...events);
  }
  return results;
}

module.exports = { computeBlockChunks, chunkedQueryFilter };
