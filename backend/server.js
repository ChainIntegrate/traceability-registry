require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const { buildTraceabilityRouter } = require("./traceabilityRoutes");
const { buildPhotoRouter } = require("./photoRoutes");
const { buildChainReadRouter } = require("./chainReadRoutes");
const { TRACEABILITY_FACTORY_MINIMAL_ABI } = require("./factoryAbi");

const PORT = process.env.PORT || 3014; // TODO: confermare porta libera sul VPS Aruba
const RPC_URL = process.env.LUKSO_RPC_URL;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
// Regola d'oro: una API key RPC dedicata per ogni servizio, mai riusata da
// un altro backend — così un problema (o un abuso) si isola e si monitora
// per servizio, non genericamente su "il nodo RPC". Questa chiave NON deve
// essere la stessa già usata da MatchPredictor v3 o altri backend.
const ALLOWED_MINT_UI_ORIGIN = process.env.ALLOWED_MINT_UI_ORIGIN; // es. https://app.chainintegrate.it

if (!RPC_URL) {
  console.error("LUKSO_RPC_URL mancante in .env");
  process.exit(1);
}
if (!FACTORY_ADDRESS || !ethers.utils.isAddress(FACTORY_ADDRESS)) {
  console.error("FACTORY_ADDRESS mancante o non valido in .env");
  process.exit(1);
}
if (!ALLOWED_MINT_UI_ORIGIN) {
  console.warn(
    "ALLOWED_MINT_UI_ORIGIN non impostato: le route firmate (pin-json, upload-photo, photos) " +
    "non accetteranno richieste da nessun dominio browser finché non viene configurato."
  );
}

// Unico punto in cui l'RPC (con API key nel path) viene chiamato — sempre
// lato backend, mai esposto al browser (rpc.chainintegrate.it non è un
// dominio pubblico).
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, TRACEABILITY_FACTORY_MINIMAL_ABI, provider);

const app = express();
app.use(express.json({ limit: "2mb" }));

// Due politiche CORS diverse per due gruppi di endpoint:
// - lettura pubblica (widget embeddabile su siti terzi): permissiva
// - route firmate (pin-json, upload-photo, photos): solo la UI ufficiale
const publicReadCors = cors({ origin: "*", methods: ["GET"] });
const restrictedWriteCors = cors({
  origin: ALLOWED_MINT_UI_ORIGIN || false, // false = nessuna origin ammessa finché non configurato
  methods: ["GET", "POST"],
});

app.use("/api/traceability/registry", publicReadCors);
app.use("/api/traceability/pin-json", restrictedWriteCors);
// ATTENZIONE: app.use() fa match per SEGMENTO di path, non per prefisso di
// stringa — "/pin-json" sopra NON copre "/pin-json-batch" (il carattere
// dopo "pin-json" non è uno "/"), serve una riga a parte. Stesso principio
// da tenere a mente per qualsiasi futura route con un nome che "contiene"
// un'altra route già registrata.
app.use("/api/traceability/pin-json-batch", restrictedWriteCors);
app.use("/api/traceability/upload-photo", restrictedWriteCors);
app.use("/api/traceability/photos", restrictedWriteCors);

app.use("/api/traceability", buildTraceabilityRouter(provider, factoryContract));
app.use("/api/traceability", buildPhotoRouter(provider, factoryContract));
app.use("/api/traceability", buildChainReadRouter(provider, factoryContract));

// Gestore errori di ultima istanza: mai propagare dettagli interni al client.
app.use((err, req, res, next) => {
  console.error("Errore non gestito:", err);
  res.status(500).json({ error: "Errore interno." });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("traceability-backend in ascolto sulla porta " + PORT + " (solo localhost, coerente con gli altri backend)");
});