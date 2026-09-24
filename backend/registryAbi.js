const TRACEABILITY_REGISTRY_MINIMAL_ABI = [
  "function isAuthorized(address account) external view returns (bool)",
  // Aggiunte per il check di tier lato backend sugli upload (§49): serve
  // risalire a CHI è registryAdmin e a QUALE Membership Corporate rispetto
  // a un registry qualsiasi, prima di poter chiamare tierOf().
  "function registryAdmin() view returns (address)",
  "function membershipCorporate() view returns (address)",
];

/** Solo tierOf(): stessa interfaccia minima già usata lato frontend
 * (MEMBERSHIP_ABI in user-*.html) — mai l'ABI completa, non serve altro qui. */
const MEMBERSHIP_CORPORATE_MINIMAL_ABI = [
  "function tierOf(address account) view returns (uint256)",
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
  "function getData(bytes32 dataKey) view returns (bytes)",
  "function getDocumentHash(bytes32 tokenId) view returns (bytes32)",
  "event RawMaterialLotMinted(bytes32 indexed tokenId, uint256 indexDate)",
  "event ProductionBatchMinted(bytes32 indexed tokenId, bytes32[] usedLots, uint256 indexDate)",
  "event EntryInvalidated(bytes32 indexed tokenId, address indexed by, string reason)",
  "event DelegateAdded(address indexed delegate, address indexed grantedBy)",
  "event DelegateRemoved(address indexed delegate, address indexed revokedBy)",
];

const LSP4_METADATA_KEY = "0x9afb95cacc9f95858ec44aa8c3b685511002e30ae54415823f406128b85b238e";

module.exports = {
  TRACEABILITY_REGISTRY_MINIMAL_ABI,
  TRACEABILITY_REGISTRY_READ_ABI,
  MEMBERSHIP_CORPORATE_MINIMAL_ABI,
  LSP4_METADATA_KEY,
};