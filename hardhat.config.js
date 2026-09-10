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
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
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