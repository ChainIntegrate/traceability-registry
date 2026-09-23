require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.warn(
    "ATTENZIONE: PRIVATE_KEY mancante in .env — le reti luksoTestnet/luksoMainnet " +
    "non avranno un account per firmare le transazioni di deploy."
  );
}

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      // viaIR disattivato e runs abbassato da 200 a 1: il Factory è tornato
      // sopra il limite EIP-170 dopo l'aggiunta di sectorOf/setSector (§48).
      // Verificato con una compilazione locale (solc puro, fuori da Hardhat,
      // stesso compilatore 0.8.28) che entrambi i contratti compilano senza
      // errori con viaIR disattivato — non risultava necessario per nessuno
      // dei due file, solo impostato in precedenza. runs basso dice
      // all'ottimizzatore di preferire bytecode più piccolo al costo di gas
      // leggermente più alto per chiamata — accettabile qui: deployRegistry/
      // setSector sono chiamate rare (una tantum per azienda), non un hot
      // path come un trasferimento token. TraceabilityRegistry.sol ha
      // comunque ampio margine (~18.5KB su 24.576) in ogni combinazione
      // testata, nessun rischio di farlo scendere sotto quel limite.
      viaIR: false,
      optimizer: { enabled: true, runs: 1 },
    },
  },
  networks: {
    luksoTestnet: {
      url: process.env.LUKSO_TESTNET_RPC_URL || "https://rpc.testnet.lukso.network",
      chainId: 4201,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    luksoMainnet: {
      // Nodo self-hosted ChainIntegrate — API key dedicata, mai quella già
      // usata da altri backend (stessa regola d'oro già applicata al backend).
      url: process.env.LUKSO_MAINNET_RPC_URL || "https://rpc.chainintegrate.it/rpc/<api-key>",
      chainId: 42,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  // Verifica via Blockscout — nessuna API key richiesta per LUKSO (fonte:
  // github.com/lukso-network/lsp-smart-contracts/blob/develop/DEPLOYMENT.md),
  // ma il campo apiKey va comunque presente (anche solo come stringa
  // segnaposto) perché il plugin hardhat-verify lo richiede strutturalmente.
  etherscan: {
    apiKey: {
      luksoTestnet: "no-api-key-needed",
      luksoMainnet: "no-api-key-needed",
    },
    customChains: [
      {
        network: "luksoTestnet",
        chainId: 4201,
        urls: {
          apiURL: "https://explorer.execution.testnet.lukso.network/api",
          browserURL: "https://explorer.execution.testnet.lukso.network",
        },
      },
      {
        network: "luksoMainnet",
        chainId: 42,
        urls: {
          apiURL: "https://explorer.execution.mainnet.lukso.network/api",
          browserURL: "https://explorer.execution.mainnet.lukso.network",
        },
      },
    ],
  },
};