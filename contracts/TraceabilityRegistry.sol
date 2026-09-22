// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// BOZZA DI REVIEW — da allineare a versione esatta di @lukso/lsp8-contracts
// usata negli altri progetti ChainIntegrate (Supplier Trust Registry, MatchPredictor).
import { LSP8IdentifiableDigitalAsset } from "@lukso/lsp8-contracts/contracts/LSP8IdentifiableDigitalAsset.sol";
import { _LSP4_METADATA_KEY, _LSP4_TOKEN_TYPE_KEY } from "@lukso/lsp4-contracts/contracts/LSP4Constants.sol";
import { _LSP8_TOKENID_FORMAT_HASH } from "@lukso/lsp8-contracts/contracts/LSP8Constants.sol";

/// @dev Interfaccia minima verso ChainIntegrate Membership Corporate.
interface IMembershipCorporate {
    function tierOf(address account) external view returns (uint256);
}

/// @title TraceabilityRegistry
/// @notice Registro di tracciabilità dedicato a UNA azienda (deployato dal Factory).
///         Owner della collezione = ChainIntegrate UP (branding/creator).
///         registryAdmin = UP dell'azienda (mint, metadata propria collezione/token, deleghe).
contract TraceabilityRegistry is LSP8IdentifiableDigitalAsset {
    // ---------------------------------------------------------------------
    // Data keys custom (namespace ChainIntegrate, stesso pattern del
    // "Token story" di MatchPredictor: keccak256("TraceabilityRegistry...") )
    // ---------------------------------------------------------------------
    bytes32 public constant ENTRY_TYPE_KEY =
        keccak256("TraceabilityRegistryEntryType");
    bytes32 public constant USED_LOTS_KEY =
        keccak256("TraceabilityRegistryUsedLots");
    bytes32 public constant ENTRY_STATUS_KEY =
        keccak256("TraceabilityRegistryEntryStatus");
    bytes32 public constant INDEX_DATE_KEY =
        keccak256("TraceabilityRegistryIndexDate");
    bytes32 public constant DOCUMENT_HASH_KEY =
        keccak256("TraceabilityRegistryDocumentHash");

    enum EntryType {
        RawMaterialLot,   // 0
        ProductionBatch   // 1
    }

    enum EntryStatus {
        Valid,          // 0 — default implicito se la key non è mai stata scritta
        Invalidated     // 1
    }

    // Tier numerici della Membership Corporate: 1=Bronze, 2=Silver, 3=Gold
    // TODO: confermare che questi valori combacino esattamente con setTier()
    // sul contratto Membership Corporate reale.
    uint256 public constant SILVER_TIER = 2;
    uint256 public constant GOLD_TIER = 3;

    // NON immutable: se la Factory aggiorna il riferimento (vedi
    // Factory.setMembershipCorporate), ogni registry già deployato deve
    // poter essere allineato individualmente — altrimenti resterebbe
    // agganciato alla vecchia Membership Corporate per le proprie verifiche
    // (deleghe Silver, funzionalità Gold), anche dopo un aggiornamento globale.
    IMembershipCorporate public membershipCorporate;
    uint256 public immutable deployedAtBlock;
    address public registryAdmin;

    mapping(address => bool) public delegates;

    event RegistryAdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event DelegateAdded(address indexed delegate, address indexed grantedBy);
    event DelegateRemoved(address indexed delegate, address indexed revokedBy);
    event MembershipCorporateUpdated(address indexed oldAddress, address indexed newAddress);
    event RawMaterialLotMinted(bytes32 indexed tokenId, uint256 indexDate);
    event ProductionBatchMinted(bytes32 indexed tokenId, bytes32[] usedLots, uint256 indexDate);
    event EntryInvalidated(bytes32 indexed tokenId, address indexed by, string reason);
    event DocumentHashSet(bytes32 indexed tokenId, bytes32 documentHash, address indexed by);

    /// @dev Estratta dal modifier in una funzione interna: onlyAuthorized è
    ///      usato su 3 funzioni esterne di mint e, essendo un modifier, il
    ///      suo corpo viene duplicato ad ogni sito di utilizzo — con la
    ///      stringa di errore in più questo faceva superare a
    ///      TraceabilityRegistryFactory il limite EIP-170 di 24576 byte
    ///      (la Factory include il creation-code di TraceabilityRegistry).
    ///      Una funzione interna condivisa viene invece chiamata, non
    ///      duplicata, a parità di comportamento e messaggi di errore.
    function _requireAuthorizedAndActiveMembership() internal view {
        require(
            msg.sender == registryAdmin || delegates[msg.sender],
            "TraceabilityRegistry: caller is not authorized"
        );
        // tierOf(registryAdmin) == 0 copre sia "azienda mai stata membro"
        // sia "membership sospesa" — stesso significato già usato in
        // Factory.deployRegistry(). Il tier controllato è sempre quello
        // dell'azienda (registryAdmin), non del delegato che chiama: se
        // l'azienda viene sospesa, anche i suoi delegati smettono di poter
        // mintare, coerentemente con onlyGoldFeature.
        require(
            membershipCorporate.tierOf(registryAdmin) != 0,
            "TraceabilityRegistry: membership non valida o sospesa"
        );
    }

    modifier onlyAuthorized() {
        _requireAuthorizedAndActiveMembership();
        _;
    }

    modifier onlyRegistryAdmin() {
        require(msg.sender == registryAdmin, "TraceabilityRegistry: caller is not registryAdmin");
        _;
    }

    /// @dev Estratta in funzione interna per lo stesso motivo delle altre
    ///      due sopra: usata in 2 siti (addDelegate/removeDelegate), un
    ///      modifier duplicherebbe il corpo in entrambi — trovato durante
    ///      la caccia ai 44 byte mancanti per rientrare in EIP-170 dopo
    ///      l'aggiunta di setDocumentHashBatch (la Factory, che include il
    ///      bytecode di creazione di TraceabilityRegistry, sforava di 44
    ///      byte pur avendo già applicato lo stesso fix ad onlyAuthorized
    ///      e onlyGoldFeature — questo modifier era rimasto non estratto).
    function _requireDelegationManager() internal view {
        bool isChainIntegrate = msg.sender == owner();
        bool isAdminWithSilver = msg.sender == registryAdmin &&
            membershipCorporate.tierOf(registryAdmin) >= SILVER_TIER;
        require(
            isChainIntegrate || isAdminWithSilver,
            "TraceabilityRegistry: not allowed to manage delegates"
        );
    }

    modifier onlyDelegationManager() {
        _requireDelegationManager();
        _;
    }

    /// @dev Estratta in funzione interna per lo stesso motivo di
    ///      _requireAuthorizedAndActiveMembership(): con l'arrivo di
    ///      setDocumentHashBatch questo modifier ha un secondo sito d'uso,
    ///      e un modifier duplica il proprio corpo ad ogni uso — meglio
    ///      chiamarla che duplicarla, stiamo già al limite EIP-170.
    function _requireAuthorizedAndGoldTier() internal view {
        require(
            msg.sender == registryAdmin || delegates[msg.sender],
            "TraceabilityRegistry: caller is not authorized"
        );
        require(
            membershipCorporate.tierOf(registryAdmin) >= GOLD_TIER,
            "TraceabilityRegistry: requires Gold tier"
        );
    }

    /// @dev Autorizzato al mint/invalidazione E l'azienda ha tier Gold.
    ///      Il tier è sempre quello di registryAdmin (l'azienda), non del
    ///      singolo delegato che effettua la chiamata.
    modifier onlyGoldFeature() {
        _requireAuthorizedAndGoldTier();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address chainIntegrateOwner_,
        address registryAdmin_,
        address membershipCorporate_
    )
        LSP8IdentifiableDigitalAsset(
            name_,
            symbol_,
            chainIntegrateOwner_,
            1, // LSP4TokenType.NFT — non è una costante con nome esportata dalla libreria
               // (era un'ipotesi sbagliata, confermato dall'errore di compilazione),
               // è semplicemente il valore numerico, come da lsp4-metadata-notes.md
            _LSP8_TOKENID_FORMAT_HASH // tokenId = bytes32 (hash), disciplina GS1
        )
    {
        registryAdmin = registryAdmin_;
        membershipCorporate = IMembershipCorporate(membershipCorporate_);
        deployedAtBlock = block.number;
        emit RegistryAdminUpdated(address(0), registryAdmin_);
    }

    // ---------------------------------------------------------------------
    // Deleghe
    // ---------------------------------------------------------------------
    function addDelegate(address delegate) external onlyDelegationManager {
        require(delegate != address(0), "TraceabilityRegistry: zero address");
        require(!delegates[delegate], "TraceabilityRegistry: already a delegate");
        delegates[delegate] = true;
        emit DelegateAdded(delegate, msg.sender);
    }

    function removeDelegate(address delegate) external onlyDelegationManager {
        require(delegates[delegate], "TraceabilityRegistry: not a delegate");
        delegates[delegate] = false;
        emit DelegateRemoved(delegate, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Metadata della collezione — solo registryAdmin (è la "collezione" su
    // universaleverything.io, decisione di branding, non operatività).
    // ---------------------------------------------------------------------
    function setRegistryMetadata(bytes memory lsp4MetadataValue) external onlyRegistryAdmin {
        _setData(_LSP4_METADATA_KEY, lsp4MetadataValue);
    }

    // ---------------------------------------------------------------------
    // Mint lotto materia prima — singolo
    // ---------------------------------------------------------------------
    function mintRawMaterialLot(
        bytes32 tokenId,
        bytes memory lsp4MetadataValue,
        uint256 indexDate
    ) external onlyAuthorized {
        _mintRawMaterialLot(tokenId, lsp4MetadataValue, indexDate);
    }

    /// @notice Import di un JSON acquisto con N materiali: una transazione, una firma.
    function mintRawMaterialLotBatch(
        bytes32[] memory tokenIds,
        bytes[] memory lsp4MetadataValues,
        uint256[] memory indexDates
    ) external onlyAuthorized {
        require(
            tokenIds.length == lsp4MetadataValues.length &&
            tokenIds.length == indexDates.length,
            "TraceabilityRegistry: length mismatch"
        );
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _mintRawMaterialLot(tokenIds[i], lsp4MetadataValues[i], indexDates[i]);
        }
    }

    function _mintRawMaterialLot(
        bytes32 tokenId,
        bytes memory lsp4MetadataValue,
        uint256 indexDate
    ) internal {
        require(!_exists(tokenId), "TraceabilityRegistry: tokenId already used");
        require(indexDate > 0, "TraceabilityRegistry: indexDate required");

        _mint({ to: registryAdmin, tokenId: tokenId, force: true, data: "" });

        _setDataForTokenId(tokenId, ENTRY_TYPE_KEY, abi.encode(uint256(EntryType.RawMaterialLot)));
        _setDataForTokenId(tokenId, INDEX_DATE_KEY, abi.encode(indexDate));
        _setDataForTokenId(tokenId, _LSP4_METADATA_KEY, lsp4MetadataValue);

        emit RawMaterialLotMinted(tokenId, indexDate);
    }

    // ---------------------------------------------------------------------
    // Mint batch di produzione, con riferimento strutturato ai lotti usati.
    // Lotti non matchati restano SOLO in metadata (fallback testuale),
    // gestito lato UI prima di arrivare qui (tolleranza + conferma utente).
    // ---------------------------------------------------------------------
    function mintProductionBatch(
        bytes32 tokenId,
        bytes memory lsp4MetadataValue,
        bytes32[] memory usedLotTokenIds,
        uint256 indexDate
    ) external onlyAuthorized {
        require(!_exists(tokenId), "TraceabilityRegistry: tokenId already used");
        require(indexDate > 0, "TraceabilityRegistry: indexDate required");

        for (uint256 i = 0; i < usedLotTokenIds.length; i++) {
            bytes32 lotId = usedLotTokenIds[i];
            require(_exists(lotId), "TraceabilityRegistry: referenced lot does not exist");
            require(
                getEntryType(lotId) == EntryType.RawMaterialLot,
                "TraceabilityRegistry: referenced token is not a RawMaterialLot"
            );
            require(
                getEntryStatus(lotId) == EntryStatus.Valid,
                "TraceabilityRegistry: referenced lot is invalidated"
            );
        }

        _mint({ to: registryAdmin, tokenId: tokenId, force: true, data: "" });

        _setDataForTokenId(tokenId, ENTRY_TYPE_KEY, abi.encode(uint256(EntryType.ProductionBatch)));
        _setDataForTokenId(tokenId, USED_LOTS_KEY, abi.encode(usedLotTokenIds));
        _setDataForTokenId(tokenId, INDEX_DATE_KEY, abi.encode(indexDate));
        _setDataForTokenId(tokenId, _LSP4_METADATA_KEY, lsp4MetadataValue);

        emit ProductionBatchMinted(tokenId, usedLotTokenIds, indexDate);
    }

    // ---------------------------------------------------------------------
    // Invalidazione — mai burn, mai riscrittura dei metadata originali.
    // Autorizzato: registryAdmin/delegato (si accorgono del proprio errore)
    // o ChainIntegrate (supporto/contestazioni).
    // ---------------------------------------------------------------------
    function invalidateEntry(bytes32 tokenId, string calldata reason) external {
        require(_exists(tokenId), "TraceabilityRegistry: tokenId does not exist");
        require(
            msg.sender == registryAdmin || delegates[msg.sender] || msg.sender == owner(),
            "TraceabilityRegistry: not authorized to invalidate"
        );
        require(
            getEntryStatus(tokenId) == EntryStatus.Valid,
            "TraceabilityRegistry: already invalidated"
        );

        _setDataForTokenId(tokenId, ENTRY_STATUS_KEY, abi.encode(uint256(EntryStatus.Invalidated)));
        emit EntryInvalidated(tokenId, msg.sender, reason);
    }

    // ---------------------------------------------------------------------
    // Hash documento (fattura, ecc.) — solo Gold. Il file NON è on-chain,
    // solo il suo hash. Il CID resta privato nel backend ChainIntegrate.
    // ---------------------------------------------------------------------
    function setDocumentHash(bytes32 tokenId, bytes32 documentHash) external onlyGoldFeature {
        _setDocumentHash(tokenId, documentHash);
    }

    /// @notice Come setDocumentHash ma per più token con LO STESSO documento
    ///         (es. un certificato/DDT di una spedizione che copre più
    ///         lotti) — una sola transazione invece di una per token.
    function setDocumentHashBatch(bytes32[] calldata tokenIds, bytes32 documentHash) external onlyGoldFeature {
        require(tokenIds.length > 0, "TraceabilityRegistry: empty tokenIds");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _setDocumentHash(tokenIds[i], documentHash);
        }
    }

    function _setDocumentHash(bytes32 tokenId, bytes32 documentHash) internal {
        require(_exists(tokenId), "TraceabilityRegistry: tokenId does not exist");
        require(documentHash != bytes32(0), "TraceabilityRegistry: empty hash");
        _setDataForTokenId(tokenId, DOCUMENT_HASH_KEY, abi.encode(documentHash));
        emit DocumentHashSet(tokenId, documentHash, msg.sender);
    }

    function getDocumentHash(bytes32 tokenId) external view returns (bytes32) {
        bytes memory raw = _getDataForTokenId(tokenId, DOCUMENT_HASH_KEY);
        if (raw.length == 0) return bytes32(0);
        return abi.decode(raw, (bytes32));
    }

    // ---------------------------------------------------------------------
    // Letture
    // ---------------------------------------------------------------------
    function getEntryType(bytes32 tokenId) public view returns (EntryType) {
        bytes memory raw = _getDataForTokenId(tokenId, ENTRY_TYPE_KEY);
        require(raw.length > 0, "TraceabilityRegistry: tokenId has no EntryType set");
        return EntryType(abi.decode(raw, (uint256)));
    }

    function getEntryStatus(bytes32 tokenId) public view returns (EntryStatus) {
        bytes memory raw = _getDataForTokenId(tokenId, ENTRY_STATUS_KEY);
        if (raw.length == 0) return EntryStatus.Valid; // default implicito
        return EntryStatus(abi.decode(raw, (uint256)));
    }

    function getIndexDate(bytes32 tokenId) external view returns (uint256) {
        bytes memory raw = _getDataForTokenId(tokenId, INDEX_DATE_KEY);
        require(raw.length > 0, "TraceabilityRegistry: tokenId has no IndexDate set");
        return abi.decode(raw, (uint256));
    }

    function getUsedLots(bytes32 tokenId) external view returns (bytes32[] memory) {
        require(getEntryType(tokenId) == EntryType.ProductionBatch, "TraceabilityRegistry: not a ProductionBatch");
        bytes memory raw = _getDataForTokenId(tokenId, USED_LOTS_KEY);
        return abi.decode(raw, (bytes32[]));
    }

    function isAuthorized(address account) external view returns (bool) {
        return account == registryAdmin || delegates[account];
    }

    function setRegistryAdmin(address newAdmin) external onlyOwner {
        require(newAdmin != address(0), "TraceabilityRegistry: zero address");
        emit RegistryAdminUpdated(registryAdmin, newAdmin);
        registryAdmin = newAdmin;
    }

    /// @notice Allinea questo registry a una nuova Membership Corporate,
    ///         dopo che la Factory ne ha impostata una diversa per i nuovi
    ///         deploy. Va richiamata per ogni registry esistente che deve
    ///         restare coerente — non è automatica.
    function setMembershipCorporate(address newMembershipCorporate) external onlyOwner {
        require(newMembershipCorporate != address(0), "TraceabilityRegistry: zero address");
        address old = address(membershipCorporate);
        membershipCorporate = IMembershipCorporate(newMembershipCorporate);
        emit MembershipCorporateUpdated(old, newMembershipCorporate);
    }
}
