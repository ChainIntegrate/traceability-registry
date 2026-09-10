/**
 * TraceabilityRegistry backend — verifica firma ERC-1271.
 * Una Universal Profile NON firma come una EOA: il messaggio va verificato
 * chiamando isValidSignature(hash, signature) sul CONTRATTO della UP,
 * confrontando il valore ritornato con il magic value EIP-1271.
 */
const { ethers } = require("ethers");

const ERC725_ACCOUNT_ABI = [
  "function isValidSignature(bytes32 _hash, bytes memory _signature) public view returns (bytes4 magicValue)",
];

const EIP1271_MAGIC_VALUE = "0x1626ba7e";

/**
 * @param {ethers.providers.Provider} provider
 * @param {string} claimedSignerAddress - indirizzo della UP che dichiara di aver firmato
 * @param {string} message - messaggio in chiaro (stesso testo mostrato dalla UP extension)
 * @param {string} signature
 * @returns {Promise<boolean>}
 */
async function verifyErc1271Signature(provider, claimedSignerAddress, message, signature) {
  const digest = ethers.utils.hashMessage(message); // digest EIP-191 (personal_sign)
  const account = new ethers.Contract(claimedSignerAddress, ERC725_ACCOUNT_ABI, provider);

  let magicValue;
  try {
    magicValue = await account.isValidSignature(digest, signature);
  } catch (err) {
    // Indirizzo non è una UP valida, o firma malformata, o RPC irraggiungibile.
    throw new Error("Verifica ERC-1271 fallita: " + err.message);
  }

  return typeof magicValue === "string" && magicValue.toLowerCase() === EIP1271_MAGIC_VALUE;
}

module.exports = { verifyErc1271Signature, EIP1271_MAGIC_VALUE };
