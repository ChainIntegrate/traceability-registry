const TRACEABILITY_REGISTRY_MINIMAL_ABI = [
  "function isAuthorized(address account) external view returns (bool)",
];

/**
 * ABI estesa per le letture on-chain (widget pubblico + matching lotti
 * nella UI di mint). Include gli eventi: l'enumerazione dei tokenId passa
 * da lì (non sono sequenziali), non da un loop su un contatore.
 */
const TRACEABILITY_REGISTRY_READ_ABI = [
  "function deployedAtBlock() view returns (uint256)",
  "function getEntryType(bytes32 tokenId) view returns (uint8)",
  "function getEntryStatus(bytes32 tokenId) view returns (uint8)",
  "function getIndexDate(bytes32 tokenId) view returns (uint256)",
  "function getUsedLots(bytes32 tokenId) view returns (bytes32[])",
  "function getDataForTokenId(bytes32 tokenId, bytes32 dataKey) view returns (bytes)",
  "event RawMaterialLotMinted(bytes32 indexed tokenId, uint256 indexDate)",
  "event ProductionBatchMinted(bytes32 indexed tokenId, bytes32[] usedLots, uint256 indexDate)",
  "event EntryInvalidated(bytes32 indexed tokenId, address indexed by, string reason)",
];

const LSP4_METADATA_KEY = "0x9afb95cacc9f95858ec44aa8c3b685511002e30ae54415823f406128b85b238e";

module.exports = { TRACEABILITY_REGISTRY_MINIMAL_ABI, TRACEABILITY_REGISTRY_READ_ABI, LSP4_METADATA_KEY };
