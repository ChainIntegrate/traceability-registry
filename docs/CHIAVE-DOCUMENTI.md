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
| il **nodo IPFS** (disco del VPS) | si perdono i file, cifrati e non, se non esiste un'altra copia. Coperto dal backup del VPS (vedi sotto). |

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

Una copia che resta sullo stesso server non protegge da un guasto del server:
il **backup automatico del VPS (Contabo Auto Backup)** deve essere attivo e
includere il disco con `backend/backups/` e il repository del nodo IPFS. Il
database è comodo da avere, ma non vitale: senza, i documenti si recuperano
comunque con la chiave madre.

## 4. Recuperare un documento senza database

```bash
cd /var/www/traceability-registry/backend
node scripts/decrypt-document.js <CID> fattura.pdf
# con verifica dell'impronta registrata on-chain:
node scripts/decrypt-document.js <CID> fattura.pdf 0x…impronta…
```

Per trovare i CID senza database: `ipfs pin ls --type=recursive` elenca tutti i
file conservati dal nodo. Quelli cifrati iniziano con i byte `TRDOC1`.

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
2. togli dal nodo il vecchio CID in chiaro:
   ```bash
   ipfs pin rm <CID-vecchio>
   ipfs repo gc
   ```

Il passo 2 impedisce al nostro nodo di continuare a servirlo; non può
cancellare copie che qualcuno avesse già scaricato.
