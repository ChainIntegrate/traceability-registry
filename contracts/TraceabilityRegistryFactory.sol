// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { TraceabilityRegistry } from "./TraceabilityRegistry.sol";

/// @dev Interfaccia minima verso ChainIntegrate Membership Corporate
///      (0x18BaFeD9B151Fb29b3cFEa35A3197F4830072a3e su mainnet).
///      Riuso as-is: nessuna membership dedicata.
interface IMembershipCorporate {
    function tierOf(address account) external view returns (uint256);
}

/// @title TraceabilityRegistryFactory
/// @notice Deploya TraceabilityRegistry dedicati per ogni azienda, gated
///         dalla Membership Corporate esistente. Numero massimo di registri
///         per azienda dipendente dal tier — stesso schema già in uso sul
///         Supplier Trust Registry: Bronze 1, Silver 2, Gold 5.
contract TraceabilityRegistryFactory {
    // Tier numerici della Membership Corporate: 1=Bronze, 2=Silver, 3=Gold
    // TODO: confermare che questi valori combacino esattamente con setTier()
    // sul contratto Membership Corporate reale (stesso TODO già segnato su
    // TraceabilityRegistry.sol).
    uint256 public constant BRONZE_TIER = 1;
    uint256 public constant SILVER_TIER = 2;
    uint256 public constant GOLD_TIER = 3;

    // NON immutable: la Membership Corporate potrebbe essere sostituita in
    // futuro (redeploy, migrazione) — solo ChainIntegrate può aggiornarla.
    IMembershipCorporate public membershipCorporate;
    address public immutable chainIntegrateOwner;

    mapping(address => address[]) public registriesOf; // azienda -> tutti i suoi registry
    address[] public allRegistries; // enumerabile, per directory pubblica / indexer futuro
    mapping(address => bool) public isRegistry; // lookup O(1): "questo indirizzo è un nostro registry?"
    // Usato dal backend per rifiutare richieste (pin, upload foto, letture)
    // verso contratti che NON sono stati deployati da questa Factory — senza
    // questo controllo, chiunque potrebbe deployare un proprio contratto con
    // una isAuthorized() che ritorna sempre true e usare il nostro backend
    // (IPFS, RPC) gratuitamente.

    // Settore merceologico dell'azienda (es. keccak256("alimentare_bidata")),
    // NON un tier: puramente informativo/di instradamento per il frontend
    // (quale UI di mint proporre), scritto SOLO da ChainIntegrate — mai
    // auto-dichiarabile dall'azienda. bytes32(0) = "nessun settore assegnato
    // ancora", stato che blocca deployRegistry (vedi sotto): un'azienda deve
    // avere un accordo commerciale e un settore assegnato prima di poter
    // creare il proprio registry. Riassegnabile in qualunque momento senza
    // effetto retroattivo sui registry già deployati (la loro metadata
    // resta quella con cui sono stati mintati, il settore incide solo su
    // quale UI viene proposta per le operazioni successive).
    mapping(address => bytes32) public sectorOf;

    event RegistryDeployed(address indexed company, address indexed registry, uint256 registryIndex);
    event MembershipCorporateUpdated(address indexed oldAddress, address indexed newAddress);
    event SectorAssigned(address indexed account, bytes32 sector);

    modifier onlyChainIntegrate() {
        require(msg.sender == chainIntegrateOwner, "TraceabilityRegistryFactory: caller is not ChainIntegrate");
        _;
    }

    constructor(address membershipCorporate_, address chainIntegrateOwner_) {
        membershipCorporate = IMembershipCorporate(membershipCorporate_);
        chainIntegrateOwner = chainIntegrateOwner_;
    }

    /// @notice Sostituisce l'indirizzo della Membership Corporate usata per
    ///         tutti i controlli di tier (deploy nuovi registry, deleghe,
    ///         funzionalità Gold). NON tocca i registry già deployati — quelli
    ///         hanno il proprio riferimento immutabile fissato al momento del
    ///         loro deploy (vedi TraceabilityRegistry.sol); solo i NUOVI
    ///         deploy da questo momento in poi useranno il nuovo indirizzo.
    function setMembershipCorporate(address newMembershipCorporate) external onlyChainIntegrate {
        require(newMembershipCorporate != address(0), "TraceabilityRegistryFactory: zero address");
        address old = address(membershipCorporate);
        membershipCorporate = IMembershipCorporate(newMembershipCorporate);
        emit MembershipCorporateUpdated(old, newMembershipCorporate);
    }

    /// @notice Assegna (o riassegna) il settore merceologico di un'azienda.
    ///         Solo ChainIntegrate — l'azienda non può auto-dichiararsi un
    ///         settore diverso da quello concordato commercialmente.
    /// @dev bytes32 e non string per costo gas e per confronto diretto con
    ///      costanti lato frontend (stesso schema di ENTRY_TYPE_KEY su
    ///      TraceabilityRegistry.sol), es. keccak256("alimentare_bidata").
    function setSector(address account, bytes32 sector) external onlyChainIntegrate {
        require(account != address(0), "TraceabilityRegistryFactory: zero address");
        require(sector != bytes32(0), "TraceabilityRegistryFactory: sector required");
        sectorOf[account] = sector;
        emit SectorAssigned(account, sector);
    }

    /// @notice Numero massimo di registry consentiti per un dato tier.
    ///         0 = nessuna membership valida = nessun registry.
    /// @dev Nessuna retroattività: se un'azienda scende di tier dopo aver
    ///      già deployato più registry di quanti il nuovo tier permetta, i
    ///      registry esistenti restano validi — semplicemente non può
    ///      deployarne di nuovi finché non risale, stessa filosofia già
    ///      applicata alle deleghe (mai revoca retroattiva automatica).
    function maxRegistriesForTier(uint256 tier) public pure returns (uint256) {
        if (tier == BRONZE_TIER) return 1;
        if (tier == SILVER_TIER) return 2;
        if (tier == GOLD_TIER) return 5;
        return 0;
    }

    /// @notice Deploya un nuovo registro per l'azienda chiamante, se il suo
    ///         tier attuale lo consente.
    /// @dev tierOf(...) == 0 viene trattato come "nessuna membership valida"
    ///      (copre sia mai mintata sia, se in futuro Corporate lo esporrà,
    ///      sospesa — DA VERIFICARE che tierOf ritorni 0 anche se sospesa,
    ///      altrimenti serve un controllo separato es. isSuspended()).
    function deployRegistry(
        string memory name_,
        string memory symbol_
    ) external returns (address registry) {
        require(sectorOf[msg.sender] != bytes32(0), "TraceabilityRegistryFactory: no sector assigned");

        uint256 tier = membershipCorporate.tierOf(msg.sender);
        uint256 limit = maxRegistriesForTier(tier);
        require(limit > 0, "TraceabilityRegistryFactory: no valid membership");
        require(
            registriesOf[msg.sender].length < limit,
            "TraceabilityRegistryFactory: registry limit reached for current tier"
        );

        registry = address(
            new TraceabilityRegistry(
                name_,
                symbol_,
                chainIntegrateOwner,
                msg.sender,
                address(membershipCorporate)
            )
        );

        registriesOf[msg.sender].push(registry);
        allRegistries.push(registry);
        isRegistry[registry] = true;
        emit RegistryDeployed(msg.sender, registry, registriesOf[msg.sender].length - 1);
    }

    function registryCountOf(address company) external view returns (uint256) {
        return registriesOf[company].length;
    }

    function getRegistries(address company) external view returns (address[] memory) {
        return registriesOf[company];
    }

    function totalRegistries() external view returns (uint256) {
        return allRegistries.length;
    }
}
