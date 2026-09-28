/**
 * TraceabilityRegistry backend — cifratura dei documenti della libreria.
 *
 * Perché (audit §56, punto 2): i documenti (fatture, DDT, certificati) finivano
 * su IPFS in chiaro. L'unica protezione era la segretezza del CID, che però
 * circola (delegati, link inoltrati, annunci del nodo alla rete) e, una volta
 * uscito, non si può ritirare. Ora su IPFS va solo il file cifrato: chi ottiene
 * il CID trova dati illeggibili. Il file originale resta conservato byte per
 * byte (serve: l'impronta on-chain è calcolata sui byte esatti, un PDF
 * riesportato avrebbe un'impronta diversa) e si scarica solo dalla pagina
 * privata, con firma.
 *
 * Schema a due livelli ("envelope encryption"):
 * - ogni documento è cifrato con una chiave sua, casuale (AES-256-GCM);
 * - quella chiave è a sua volta cifrata con la CHIAVE MADRE
 *   (DOCUMENT_MASTER_KEY nel .env) e salvata DENTRO il file cifrato stesso.
 * Così il file su IPFS è autosufficiente: con la sola chiave madre si riapre
 * qualunque documento, anche se il database andasse perso
 * (scripts/decrypt-document.js). Se invece si perde la chiave madre, nessun
 * documento cifrato è più recuperabile: vedi docs/CHIAVE-DOCUMENTI.md.
 *
 * Formato del file cifrato (tutti i campi a lunghezza fissa tranne il testo):
 *   magic        6 byte  "TRDOC1"
 *   keyId        8 byte  primi 8 byte di SHA-256(chiave madre): dice con quale
 *                        chiave madre è stato cifrato (utile per una futura
 *                        rotazione) e fa fallire subito una chiave sbagliata
 *   wrapNonce   12 byte  nonce AES-GCM per la chiave del documento
 *   wrappedKey  32 byte  chiave del documento cifrata con la chiave madre
 *   wrapTag     16 byte  tag di autenticazione di wrappedKey
 *   dataNonce   12 byte  nonce AES-GCM per il contenuto
 *   dataTag     16 byte  tag di autenticazione del contenuto
 *   ciphertext   N byte  contenuto cifrato
 * L'intestazione (magic + keyId) è autenticata come dato aggiuntivo in
 * entrambe le cifrature: se viene alterata, la decifratura fallisce.
 */
const crypto = require("crypto");

const MAGIC = Buffer.from("TRDOC1", "ascii");
const KEY_ID_LENGTH = 8;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + KEY_ID_LENGTH + NONCE_LENGTH + KEY_LENGTH + TAG_LENGTH + NONCE_LENGTH + TAG_LENGTH;

/**
 * Legge e valida la chiave madre: 32 byte, in base64 o esadecimale (64
 * caratteri). Ritorna null se non configurata; lancia se configurata male
 * (meglio fermarsi che cifrare con una chiave sbagliata).
 */
function loadMasterKey(value = process.env.DOCUMENT_MASTER_KEY) {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error("DOCUMENT_MASTER_KEY non valida: servono 32 byte (base64 o 64 caratteri esadecimali).");
  }
  return key;
}

function keyIdOf(masterKey) {
  return crypto.createHash("sha256").update(masterKey).digest().subarray(0, KEY_ID_LENGTH);
}

function isEncryptedDocument(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= HEADER_LENGTH && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Cifra il contenuto di un documento. Ritorna il file cifrato (Buffer). */
function encryptDocument(plaintext, masterKey) {
  if (!Buffer.isBuffer(plaintext)) throw new Error("encryptDocument: plaintext deve essere un Buffer.");
  if (!masterKey || masterKey.length !== KEY_LENGTH) throw new Error("encryptDocument: chiave madre mancante o non valida.");

  const keyId = keyIdOf(masterKey);
  const aad = Buffer.concat([MAGIC, keyId]);
  const documentKey = crypto.randomBytes(KEY_LENGTH);

  const wrapNonce = crypto.randomBytes(NONCE_LENGTH);
  const wrapCipher = crypto.createCipheriv("aes-256-gcm", masterKey, wrapNonce);
  wrapCipher.setAAD(aad);
  const wrappedKey = Buffer.concat([wrapCipher.update(documentKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  const dataNonce = crypto.randomBytes(NONCE_LENGTH);
  const dataCipher = crypto.createCipheriv("aes-256-gcm", documentKey, dataNonce);
  dataCipher.setAAD(aad);
  const ciphertext = Buffer.concat([dataCipher.update(plaintext), dataCipher.final()]);
  const dataTag = dataCipher.getAuthTag();

  documentKey.fill(0);
  return Buffer.concat([MAGIC, keyId, wrapNonce, wrappedKey, wrapTag, dataNonce, dataTag, ciphertext]);
}

/**
 * Decifra un file prodotto da encryptDocument. Lancia se il file non è nel
 * formato atteso, se la chiave madre è un'altra, o se il file è stato
 * alterato anche di un solo byte (autenticazione GCM).
 */
function decryptDocument(blob, masterKey) {
  if (!isEncryptedDocument(blob)) throw new Error("decryptDocument: il file non è un documento cifrato TRDOC1.");
  if (!masterKey || masterKey.length !== KEY_LENGTH) throw new Error("decryptDocument: chiave madre mancante o non valida.");

  let offset = MAGIC.length;
  const take = (n) => { const part = blob.subarray(offset, offset + n); offset += n; return part; };
  const keyId = take(KEY_ID_LENGTH);
  const wrapNonce = take(NONCE_LENGTH);
  const wrappedKey = take(KEY_LENGTH);
  const wrapTag = take(TAG_LENGTH);
  const dataNonce = take(NONCE_LENGTH);
  const dataTag = take(TAG_LENGTH);
  const ciphertext = blob.subarray(offset);

  if (!keyId.equals(keyIdOf(masterKey))) {
    throw new Error("decryptDocument: il documento è stato cifrato con un'altra chiave madre.");
  }
  const aad = Buffer.concat([MAGIC, keyId]);

  const wrapDecipher = crypto.createDecipheriv("aes-256-gcm", masterKey, wrapNonce);
  wrapDecipher.setAAD(aad);
  wrapDecipher.setAuthTag(wrapTag);
  const documentKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()]);

  const dataDecipher = crypto.createDecipheriv("aes-256-gcm", documentKey, dataNonce);
  dataDecipher.setAAD(aad);
  dataDecipher.setAuthTag(dataTag);
  try {
    return Buffer.concat([dataDecipher.update(ciphertext), dataDecipher.final()]);
  } finally {
    documentKey.fill(0);
  }
}

module.exports = {
  loadMasterKey,
  encryptDocument,
  decryptDocument,
  isEncryptedDocument,
  keyIdOf,
  HEADER_LENGTH,
};
