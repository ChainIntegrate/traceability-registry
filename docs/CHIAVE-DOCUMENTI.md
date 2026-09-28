# Chiave madre dei documenti e backup

I documenti della libreria documenti (fatture, DDT, certificati) sono cifrati
prima di andare su IPFS (`backend/documentCrypto.js`, audit §56 punto 2).
Questa pagina spiega cosa custodire, dove, e come recuperare un documento.

## Come funziona, in breve

- Ogni documento è cifrato con una **chiave sua**, casuale (AES-256-GCM).
- Quella chiave è chiusa con la **chiave madre** (`DOCUMENT_MASTER_KEY` nel
  `.env` del backend) e salvata **dentro il file cifrato**.
- Su IPFS c'è solo il file cifrato. Il database tiene l'indice (etichetta,
  CID, registro, chi l'ha caricato).
- Il download dalla pagina privata passa dal backend: firma, autorizzazione,
  decifratura, controllo che l'impronta coincida con quella registrata.

| Se si perde… | Conseguenza |
|---|---|
| il **database** | si perde l'indice. I file restano recuperabili: con la chiave madre si riapre qualunque file cifrato presente su IPFS (`scripts/decrypt-document.js`). |
| la **chiave madre** | **nessun documento cifrato è più recuperabile**, da nessuno. È l'unica cosa davvero da non perdere. |
| il **nodo IPFS** (è su un **server separato** dal backend) | si perdono i file, cifrati e non, se non esiste un'altra copia. Serve il backup **del server del nodo** (vedi sotto). |

## 1. Generare la chiave madre (una volta sola)

Sul VPS, nella cartella del backend:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copia il risultato nel `.env` del backend:

```
DOCUMENT_MASTER_KEY=…la stringa generata…
```

Poi riavvia: `pm2 restart <processo> --update-env`.

**Non generarla una seconda volta**: una chiave nuova non apre i documenti
cifrati con quella vecchia. Se il `.env` esiste già con una chiave, non
toccarla.

## 2. Custodire la chiave madre

Due copie **fuori dal server**, subito dopo averla generata:

1. nel password manager (voce "Traceability — DOCUMENT_MASTER_KEY");
2. stampata su carta, conservata in un luogo sicuro.

Mai su GitHub, in una chat, in un'email o in un documento condiviso. Chi ha la
chiave madre **e** accesso ai file su IPFS può leggere tutti i documenti.

Se si sospetta che la chiave sia uscita: i documenti già caricati restano
leggibili a chi la possiede. La rotazione della chiave (ricifrare tutto con una
nuova) non è ancora implementata; il formato dei file la prevede già (ogni file
porta l'identificativo della chiave madre con cui è stato cifrato).

## 3. Backup del database

Copia coerente anche a backend acceso:

```bash
cd /var/www/traceability-registry/backend
node scripts/backup-db.js            # in backend/backups/, tiene le ultime 30 copie
```

Automatico ogni notte con cron (`crontab -e` dell'utente che gestisce il backend):

```
15 3 * * * cd /var/www/traceability-registry/backend && /usr/bin/node scripts/backup-db.js >> backups/backup.log 2>&1
```

Una copia che resta sullo stesso server non protegge da un guasto del server.
Backend e nodo IPFS sono su **due server diversi**, quindi servono due backup:

| Server | Cosa protegge il suo backup automatico (es. Contabo Auto Backup) |
|---|---|
| **backend** (`/var/www/traceability-registry`) | database e sue copie in `backend/backups/`, `.env` (compresa la chiave madre: una copia in più, oltre a quelle fuori dai server) |
| **nodo IPFS** | i file: foto, metadata dei token, documenti cifrati. Senza, un guasto del nodo lascia i token on-chain senza nomi e immagini e i documenti irrecuperabili |

Il database è comodo da avere, ma non vitale: senza, i documenti si recuperano
comunque con la chiave madre, **purché i file esistano ancora sul nodo IPFS**.

## 4. Recuperare un documento senza database

Verificato dal vivo il 28/09/2026: documento cifrato illeggibile dal gateway
pubblico, intestazione `TRDOC1` sul nodo, recuperato con la sola chiave madre.


```bash
cd /var/www/traceability-registry/backend
node scripts/decrypt-document.js <CID> fattura.pdf
# con verifica dell'impronta registrata on-chain:
node scripts/decrypt-document.js <CID> fattura.pdf 0x…impronta…
```

Lo script va lanciato **dal server del backend** (ha la chiave madre e l'accesso
all'API del nodo IPFS tramite `IPFS_API_URL`). Il comando `ipfs` invece esiste
solo sul server del nodo; dal backend si può interrogare il nodo con la sua API:

```bash
IPFS=$(grep '^IPFS_API_URL=' .env | cut -d= -f2-)
curl -s -X POST "$IPFS/api/v0/cat?arg=<CID>" | head -c 6; echo   # "TRDOC1" = cifrato
```

Per trovare i CID senza database: sul server del nodo, `ipfs pin ls --type=recursive`
elenca tutti i file conservati. Quelli cifrati iniziano con i byte `TRDOC1`.

## 5. Mettere al sicuro i documenti caricati prima della cifratura

I documenti caricati prima di questa modifica sono ancora **in chiaro** su IPFS.

```bash
cd /var/www/traceability-registry/backend
node scripts/list-plaintext-documents.js
```

Per ciascuno:

1. dalla pagina privata del registro, **ricarica lo stesso file** nella
   libreria documenti: il backend lo sostituisce con la versione cifrata
   (stessa impronta, stesso record);
2. togli dal nodo il vecchio CID in chiaro, **sul server del nodo IPFS**:
   ```bash
   ipfs pin rm <CID-vecchio>
   ipfs repo gc
   ```
   Solo dopo aver ricaricato il file in **tutti** i registri in cui compare
   (lo stesso file caricato in più registri ha lo stesso CID in chiaro):
   altrimenti quei registri non riescono più a scaricarlo.

Il passo 2 impedisce al nostro nodo di continuare a servirlo; non può
cancellare copie che qualcuno avesse già scaricato.
