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
};
