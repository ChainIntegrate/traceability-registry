/**
 * Test delle regole del contratto TraceabilityRegistry su una blockchain
 * locale in memoria (rete "hardhat"): impronta unica e correzione motivata
 * (audit §56 punto 4), token non trasferibili verso terzi (punto 10), dati
 * dei token non riscrivibili dal proprietario del contratto.
 *
 * Compila i contratti con il compilatore Solidity 0.8.28 del pacchetto npm
 * `solc` (stessa versione e stesse impostazioni di hardhat.config.js), così
 * funziona anche dove Hardhat non può scaricare il compilatore.
 *
 *   npx hardhat run --no-compile scripts/test-contract-rules.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");
const hre = require("hardhat");

const { ethers } = hre;
const ROOT = path.join(__dirname, "..");

// Membership Corporate simulata: il tier di ogni indirizzo si imposta a mano.
const MOCK_MEMBERSHIP = `
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract MockMembership {
    mapping(address => uint256) public tierOf;
    function setTier(address a, uint256 t) external { tierOf[a] = t; }
}`;

function compile() {
  assert.strictEqual(solc.version().split("+")[0], "0.8.28", "serve solc 0.8.28, trovato " + solc.version());
  const sources = { "test/MockMembership.sol": { content: MOCK_MEMBERSHIP } };
  for (const f of ["TraceabilityRegistry.sol", "TraceabilityRegistryFactory.sol"]) {
    sources["contracts/" + f] = { content: fs.readFileSync(path.join(ROOT, "contracts", f), "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 1 }, // come hardhat.config.js
      viaIR: false,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const findImports = (p) => {
    const fp = path.join(ROOT, "node_modules", p);
    return fs.existsSync(fp) ? { contents: fs.readFileSync(fp, "utf8") } : { error: "non trovato: " + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const get = (file, name) => out.contracts[file][name];
  return {
    registry: get("contracts/TraceabilityRegistry.sol", "TraceabilityRegistry"),
    factory: get("contracts/TraceabilityRegistryFactory.sol", "TraceabilityRegistryFactory"),
    membership: get("test/MockMembership.sol", "MockMembership"),
  };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (err) {
    failures++;
    console.log("FAIL " + name + "\n     " + String((err && err.message) || err).split("\n").slice(0, 3).join("\n     "));
  }
}

/** Attende che la transazione venga rifiutata con il motivo indicato. */
async function expectRevert(promise, reason) {
  try {
    const tx = await promise;
    if (tx && tx.wait) await tx.wait();
  } catch (err) {
    const msg = String(err.message || err);
    assert.ok(msg.includes(reason), "rifiutata, ma con un altro motivo: " + msg.slice(0, 200));
    return;
  }
  throw new Error("doveva essere rifiutata con: " + reason);
}

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const LSP4_METADATA = "0x00";

async function main() {
  const artifacts = compile();
  const [chainIntegrate, admin, delegate, stranger, newAdmin] = await ethers.getSigners();

  const sizes = {
    TraceabilityRegistry: artifacts.registry.evm.deployedBytecode.object.length / 2,
    TraceabilityRegistryFactory: artifacts.factory.evm.deployedBytecode.object.length / 2,
  };
  await check("dimensioni entro il limite EIP-170 (24.576 byte)", () => {
    for (const [n, size] of Object.entries(sizes)) {
      assert.ok(size <= 24576, n + " è " + size + " byte");
      console.log("     " + n + ": " + size + " byte (margine " + (24576 - size) + ")");
    }
  });

  const deploy = async (art, args, signer) => {
    const f = new ethers.ContractFactory(art.abi, art.evm.bytecode.object, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const membership = await deploy(artifacts.membership, [], chainIntegrate);
  await (await membership.setTier(admin.address, 3)).wait(); // Gold
  const registry = await deploy(
    artifacts.registry,
    ["Registro di prova", "TRC", chainIntegrate.address, admin.address, await membership.getAddress()],
    chainIntegrate
  );
  const asAdmin = registry.connect(admin);

  // Due lotti e un batch di prova.
  const LOT1 = id("lotto-1"), LOT2 = id("lotto-2"), LOT3 = id("lotto-3");
  await (await asAdmin.mintRawMaterialLot(LOT1, LSP4_METADATA, 1)).wait();
  await (await asAdmin.mintRawMaterialLot(LOT2, LSP4_METADATA, 2)).wait();
  await (await asAdmin.mintRawMaterialLot(LOT3, LSP4_METADATA, 3)).wait();
  const H1 = id("fattura-123.pdf"), H2 = id("fattura-123-corretta.pdf"), H3 = id("altro.pdf");

  // -------------------------------------------------------------------------
  // Impronta unica
  // -------------------------------------------------------------------------
  await check("impronta: la prima registrazione riesce", async () => {
    await (await asAdmin.setDocumentHash(LOT1, H1)).wait();
    assert.strictEqual(await registry.getDocumentHash(LOT1), H1);
  });

  await check("impronta: una seconda registrazione sullo stesso token viene rifiutata", async () => {
    await expectRevert(asAdmin.setDocumentHash(LOT1, H2), "document hash already set");
    assert.strictEqual(await registry.getDocumentHash(LOT1), H1, "l'impronta è cambiata");
  });

  await check("impronta: in blocco su più token, se uno ce l'ha già viene rifiutato tutto", async () => {
    await expectRevert(asAdmin.setDocumentHashBatch([LOT2, LOT1], H3), "document hash already set");
    assert.strictEqual(await registry.getDocumentHash(LOT2), ethers.ZeroHash, "LOT2 non doveva cambiare");
    await (await asAdmin.setDocumentHashBatch([LOT2, LOT3], H3)).wait();
    assert.strictEqual(await registry.getDocumentHash(LOT3), H3);
  });

  // -------------------------------------------------------------------------
  // Correzione motivata
  // -------------------------------------------------------------------------
  await check("correzione: riesce con motivo, ed emette l'evento con impronta precedente, nuova, autore e motivo", async () => {
    const tx = await asAdmin.correctDocumentHash(LOT1, H2, "caricato il DDT al posto della fattura");
    const receipt = await tx.wait();
    assert.strictEqual(await registry.getDocumentHash(LOT1), H2);
    const ev = receipt.logs.map((l) => { try { return registry.interface.parseLog(l); } catch (e) { return null; } })
      .find((e) => e && e.name === "DocumentHashCorrected");
    assert.ok(ev, "evento DocumentHashCorrected mancante");
    assert.strictEqual(ev.args.tokenId, LOT1);
    assert.strictEqual(ev.args.previousHash, H1);
    assert.strictEqual(ev.args.newHash, H2);
    assert.strictEqual(ev.args.by, admin.address);
    assert.strictEqual(ev.args.reason, "caricato il DDT al posto della fattura");
  });

  await check("correzione: senza motivo viene rifiutata", async () => {
    await expectRevert(asAdmin.correctDocumentHash(LOT1, H3, ""), "correction reason required");
  });

  await check("correzione: con la stessa impronta viene rifiutata", async () => {
    await expectRevert(asAdmin.correctDocumentHash(LOT1, H2, "nessun cambiamento"), "same document hash");
  });

  await check("correzione: su un token senza impronta viene rifiutata (prima va registrata)", async () => {
    const LOT4 = id("lotto-4");
    await (await asAdmin.mintRawMaterialLot(LOT4, LSP4_METADATA, 4)).wait();
    await expectRevert(asAdmin.correctDocumentHash(LOT4, H1, "motivo"), "no document hash to correct");
  });

  await check("correzione: impronta vuota rifiutata", async () => {
    await expectRevert(asAdmin.correctDocumentHash(LOT1, ethers.ZeroHash, "motivo"), "empty hash");
  });

  await check("correzione: chi non è autorizzato viene rifiutato", async () => {
    await expectRevert(registry.connect(stranger).correctDocumentHash(LOT1, H3, "motivo"), "caller is not authorized");
  });

  await check("correzione: un delegato può correggere (registro Gold)", async () => {
    await (await asAdmin.addDelegate(delegate.address)).wait();
    await (await registry.connect(delegate).correctDocumentHash(LOT1, H3, "seconda correzione")).wait();
    assert.strictEqual(await registry.getDocumentHash(LOT1), H3);
  });

  await check("correzione: senza tier Gold rifiutata; a membership sospesa idem", async () => {
    await (await membership.setTier(admin.address, 2)).wait();
    await expectRevert(asAdmin.correctDocumentHash(LOT1, H1, "motivo"), "requires Gold tier");
    await (await membership.setTier(admin.address, 0)).wait();
    await expectRevert(asAdmin.correctDocumentHash(LOT1, H1, "motivo"), "requires Gold tier");
    await (await membership.setTier(admin.address, 3)).wait();
  });

  // -------------------------------------------------------------------------
  // Dati dei token protetti anche dal proprietario del contratto
  // -------------------------------------------------------------------------
  const DOCUMENT_HASH_KEY = await registry.DOCUMENT_HASH_KEY();
  const ENTRY_STATUS_KEY = await registry.ENTRY_STATUS_KEY();

  await check("ChainIntegrate (proprietario) non può riscrivere l'impronta con setDataForTokenId", async () => {
    await expectRevert(
      registry.connect(chainIntegrate).setDataForTokenId(LOT1, DOCUMENT_HASH_KEY, ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [H1])),
      "token data is write-protected"
    );
    assert.strictEqual(await registry.getDocumentHash(LOT1), H3);
  });

  await check("…né togliere un annullamento o cambiare dati in blocco con setDataBatchForTokenIds", async () => {
    await (await asAdmin.invalidateEntry(LOT2, "errore di prova")).wait();
    await expectRevert(
      registry.connect(chainIntegrate).setDataBatchForTokenIds([LOT2], [ENTRY_STATUS_KEY], [ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0])]),
      "token data is write-protected"
    );
    assert.strictEqual(Number(await registry.getEntryStatus(LOT2)), 1, "l'annullamento è stato tolto");
  });

  // -------------------------------------------------------------------------
  // Token non trasferibili verso terzi
  // -------------------------------------------------------------------------
  await check("token: al conio vanno al titolare del registro", async () => {
    assert.strictEqual(await registry.tokenOwnerOf(LOT1), admin.address);
  });

  await check("token: il titolare non può trasferirli a terzi", async () => {
    await expectRevert(asAdmin.transfer(admin.address, stranger.address, LOT1, true, "0x"), "tokens can only move to registryAdmin");
    assert.strictEqual(await registry.tokenOwnerOf(LOT1), admin.address);
  });

  await check("token: nemmeno un operatore autorizzato può trasferirli a terzi", async () => {
    await (await asAdmin.authorizeOperator(stranger.address, LOT3, "0x")).wait();
    await expectRevert(registry.connect(stranger).transfer(admin.address, stranger.address, LOT3, true, "0x"), "tokens can only move to registryAdmin");
  });

  await check("token: dopo un cambio di UP (setRegistryAdmin) si riportano dal vecchio al nuovo titolare", async () => {
    await (await registry.connect(chainIntegrate).setRegistryAdmin(newAdmin.address)).wait();
    await (await asAdmin.transfer(admin.address, newAdmin.address, LOT1, true, "0x")).wait();
    assert.strictEqual(await registry.tokenOwnerOf(LOT1), newAdmin.address);
  });

  await check("token: dopo il cambio, i nuovi token vanno al nuovo titolare e il vecchio non può mandarli a terzi", async () => {
    await (await membership.setTier(newAdmin.address, 3)).wait();
    const LOT5 = id("lotto-5");
    await (await registry.connect(newAdmin).mintRawMaterialLot(LOT5, LSP4_METADATA, 5)).wait();
    assert.strictEqual(await registry.tokenOwnerOf(LOT5), newAdmin.address);
    await expectRevert(asAdmin.transfer(admin.address, stranger.address, LOT2, true, "0x"), "tokens can only move to registryAdmin");
  });

  // -------------------------------------------------------------------------
  // Factory: il registro deployato dalla Factory ha le stesse regole
  // -------------------------------------------------------------------------
  await check("Factory: un registro creato dalla Factory ha impronta unica e token non trasferibili", async () => {
    const factory = await deploy(artifacts.factory, [await membership.getAddress(), chainIntegrate.address], chainIntegrate);
    await (await factory.setSector(admin.address, id("alimentare_bidata"))).wait();
    await (await membership.setTier(admin.address, 3)).wait();
    await (await factory.connect(admin).deployRegistry("Da Factory", "FCT")).wait();
    const [addr] = await factory.getRegistries(admin.address);
    const r = new ethers.Contract(addr, artifacts.registry.abi, admin);
    const T = id("lotto-factory");
    await (await r.mintRawMaterialLot(T, LSP4_METADATA, 1)).wait();
    await (await r.setDocumentHash(T, H1)).wait();
    await expectRevert(r.setDocumentHash(T, H2), "document hash already set");
    await expectRevert(r.transfer(admin.address, stranger.address, T, true, "0x"), "tokens can only move to registryAdmin");
  });

  console.log(failures === 0 ? "\nTutti i test superati." : "\n" + failures + " test falliti.");
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
