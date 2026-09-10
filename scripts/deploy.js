const hre = require("hardhat");

/**
 * Indirizzi noti — Membership Corporate (esistente, riusata as-is) e
 * ChainIntegrate UP (owner della collezione di ogni registry deployato).
 * NB: il "deployer" (chi firma la transazione di deploy, da PRIVATE_KEY in
 * .env) è un account SEPARATO da chainIntegrateOwner — deve solo avere gas
 * sufficiente, non deve necessariamente essere la UP ChainIntegrate stessa.
 */
const NETWORK_CONFIG = {
  luksoTestnet: {
    membershipCorporate: "0x08EA03294d6A27f4f819f0136d13fc5046175840",
    chainIntegrateOwner: "0x83cBE526D949A3AaaB4EF9a03E48dd862e81472C",
  },
  luksoMainnet: {
    membershipCorporate: "0x18BaFeD9B151Fb29b3cFEa35A3197F4830072a3e",
    chainIntegrateOwner: "0x4a2605796e0d91A9667d6E30365aEEC384C48c27",
  },
};

async function main() {
  const networkName = hre.network.name;
  const config = NETWORK_CONFIG[networkName];
  if (!config) {
    throw new Error(
      "Rete non configurata: '" + networkName + "'. Reti disponibili: " +
      Object.keys(NETWORK_CONFIG).join(", ") + ". Usa --network luksoTestnet o --network luksoMainnet."
    );
  }

  console.log("Rete:", networkName);
  console.log("Membership Corporate:", config.membershipCorporate);
  console.log("ChainIntegrate owner (collezioni):", config.chainIntegrateOwner);
  console.log();

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("Nessun account disponibile — controlla PRIVATE_KEY in .env.");
  }
  console.log("Deployer (paga il gas):", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance deployer:", hre.ethers.formatEther(balance), "LYX");
  console.log();

  const Factory = await hre.ethers.getContractFactory("TraceabilityRegistryFactory");
  const factory = await Factory.deploy(config.membershipCorporate, config.chainIntegrateOwner);
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  console.log("✅ TraceabilityRegistryFactory deployata a:", factoryAddress);
  console.log();
  console.log("Prossimi passi:");
  console.log("1. Aggiungi FACTORY_ADDRESS=" + factoryAddress + " nel .env del backend.");
  console.log("2. Esegui scripts/test-erc1271-live.js con una UP reale prima di usare il backend in produzione.");
  console.log("3. Verifica il contratto sull'explorer, se disponibile per questa rete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
