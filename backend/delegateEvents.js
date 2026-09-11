/**
 * Calcola l'insieme delle deleghe ATTIVE a partire dagli eventi
 * DelegateAdded/DelegateRemoved, in ordine cronologico reale (blockNumber +
 * logIndex, non l'ordine in cui i due array vengono concatenati).
 * Logica pura, nessuna chiamata di rete — testabile in isolamento.
 */
function computeActiveDelegates(addedEvents, removedEvents) {
  const merged = addedEvents
    .map((e) => ({ address: e.args.delegate, type: "added", blockNumber: e.blockNumber, logIndex: e.logIndex }))
    .concat(
      removedEvents.map((e) => ({ address: e.args.delegate, type: "removed", blockNumber: e.blockNumber, logIndex: e.logIndex }))
    );

  merged.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

  const active = new Set();
  merged.forEach((ev) => {
    if (ev.type === "added") active.add(ev.address);
    else active.delete(ev.address);
  });

  return Array.from(active);
}

module.exports = { computeActiveDelegates };
