/**
 * Collegamento con UP Wallet (estensione del browser o app Android di
 * ChainIntegrate) tramite WalletConnect.
 *
 * UP Wallet presenta al sito la Universal Profile dell'azienda; ogni firma e
 * ogni transazione la conferma l'utente nella finestra di UP Wallet, che firma
 * con la chiave del dispositivo (controller della UP) e passa dal Key Manager.
 * Per il sito non cambia nulla: l'account è la UP, le firme di accesso (SIWE)
 * si verificano con ERC-1271 sulla UP come con l'estensione LUKSO.
 *
 * Restituisce un provider EIP-1193 da passare a ethers.providers.Web3Provider:
 * - eth_accounts / eth_requestAccounts: la UP della sessione;
 * - eth_chainId: LUKSO mainnet (42), l'unica rete della piattaforma;
 * - personal_sign, eth_sendTransaction: a UP Wallet, che chiede conferma;
 * - tutto il resto (letture, stime, ricevute): all'RPC pubblico di LUKSO.
 *
 * Basato sul client lato sito di Cross_Chain (site-ui.js, MIT, ChainIntegrate):
 * stessi file WalletConnect (vendor/walletconnect, con controllo d'integrità),
 * telemetria di Reown disattivata.
 */
(function (global) {
  "use strict";

  const CHAIN_ID = 42;
  const CAIP = "eip155:" + CHAIN_ID;
  const RPC_URL = "https://rpc.mainnet.lukso.network";
  const WC_SRC = "./vendor/walletconnect/signclient-2.25.0.min.js";
  const WC_SRI = "sha384-c7w3byL5Bai+XyQvcREtZ7kvdwoPYwG+Rp5DN/jAW59Jy0osp0u/gsgdp4YOsVUJ";
  const QR_SRC = "./vendor/walletconnect/qrcode-generator-1.4.4.js";
  const QR_SRI = "sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k";
  const STORAGE_PREFIX = "traceability-wc";
  const SESSION_KEY = "traceability.wcSession";
  const WALLET_METHODS = ["eth_sendTransaction", "personal_sign"];

  const TEXTS = {
    it: {
      title: "Collega UP Wallet",
      intro: "Per collegare la Universal Profile della tua azienda con UP Wallet:",
      step1: "apri UP Wallet (l'estensione del browser) con la Universal Profile dell'azienda, sulla rete LUKSO;",
      step2: "premi \"Collega una dApp\" e incolla il link che copi qui sotto;",
      step3: "approva il collegamento in UP Wallet.",
      phone: "Con l'app UP Wallet sul telefono puoi invece inquadrare il codice.",
      copy: "Copia il link",
      copied: "Link copiato: incollalo in UP Wallet.",
      cancel: "Annulla",
      loading: "Preparazione del collegamento...",
      waiting: "In attesa dell'approvazione in UP Wallet...",
      rejected: "Collegamento rifiutato in UP Wallet.",
      failed: "Collegamento non riuscito:",
      wrongChain: "UP Wallet è collegato a un'altra rete: scegli LUKSO in UP Wallet e collega di nuovo.",
      noAccount: "UP Wallet non ha indicato nessuna Universal Profile.",
      pending: "Conferma la richiesta nella finestra di UP Wallet.",
      privacy: "Il collegamento passa dai server di WalletConnect (Reown), che vedono i dati della sessione. Portions © 2025 Reown, Inc. All Rights Reserved.",
    },
    en: {
      title: "Connect UP Wallet",
      intro: "To connect your company's Universal Profile with UP Wallet:",
      step1: "open UP Wallet (the browser extension) with the company's Universal Profile, on the LUKSO network;",
      step2: "press \"Connect a dApp\" and paste the link you copy below;",
      step3: "approve the connection in UP Wallet.",
      phone: "With the UP Wallet app on your phone you can scan the code instead.",
      copy: "Copy the link",
      copied: "Link copied: paste it in UP Wallet.",
      cancel: "Cancel",
      loading: "Preparing the connection...",
      waiting: "Waiting for approval in UP Wallet...",
      rejected: "Connection rejected in UP Wallet.",
      failed: "Connection failed:",
      wrongChain: "UP Wallet is connected to another network: choose LUKSO in UP Wallet and connect again.",
      noAccount: "UP Wallet did not provide a Universal Profile.",
      pending: "Confirm the request in the UP Wallet window.",
      privacy: "The connection goes through WalletConnect's (Reown) servers, which see the session data. Portions © 2025 Reown, Inc. All Rights Reserved.",
    },
  };

  let getLang = () => "it";
  const tt = (k) => (TEXTS[getLang()] || TEXTS.it)[k] || TEXTS.it[k] || k;

  const store = {
    get(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* storage non disponibile */ } },
    del(k) { try { global.localStorage.removeItem(k); } catch (e) { /* storage non disponibile */ } },
  };

  const loaded = {};
  function loadScript(src, integrity) {
    if (!loaded[src]) loaded[src] = new Promise((ok, no) => {
      const el = document.createElement("script");
      el.src = src;
      el.integrity = integrity;
      el.crossOrigin = "anonymous";
      el.onload = ok;
      el.onerror = () => { delete loaded[src]; no(new Error("impossibile caricare " + src)); };
      document.head.appendChild(el);
    });
    return loaded[src];
  }

  // L'SDK invia un evento "INIT" alla telemetria di Reown anche con la
  // telemetria disattivata: il suo client degli eventi viene zittito prima
  // dell'avvio (come in Cross_Chain, AUDIT W-tel).
  function muteTelemetry(core) {
    if (!core || !core.eventClient) return;
    core.eventClient.init = async () => {};
    core.eventClient.sendEvent = async () => ({ ok: true });
  }

  let clientPromise = null;
  function signClient(projectId) {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (!global.SignClientBundle) await loadScript(WC_SRC, WC_SRI);
        const { Core, SignClient } = global.SignClientBundle;
        const core = new Core({ projectId, customStoragePrefix: STORAGE_PREFIX, telemetryEnabled: false });
        muteTelemetry(core);
        return SignClient.init({
          core,
          projectId,
          customStoragePrefix: STORAGE_PREFIX,
          metadata: {
            name: "ChainIntegrate Traceability",
            description: "Tracciabilità di lotti e batch / Lot and batch traceability",
            url: global.location.origin,
            icons: [global.location.origin + "/favicon.ico"],
          },
        });
      })().catch((e) => { clientPromise = null; throw e; });
    }
    return clientPromise;
  }

  function sessionAccount(session) {
    const accs = (session && session.namespaces && session.namespaces.eip155 && session.namespaces.eip155.accounts) || [];
    const onLukso = accs.find((a) => a.startsWith(CAIP + ":"));
    const addr = onLukso ? onLukso.split(":")[2] : null;
    return addr && global.ethers && global.ethers.utils.isAddress(addr) ? global.ethers.utils.getAddress(addr) : null;
  }

  // ---- finestra di abbinamento -------------------------------------------
  const CSS = `
.tw-back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.tw-modal{background:#fff;color:#222;border-radius:10px;max-width:440px;width:100%;max-height:90vh;overflow:auto;padding:18px 20px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:.92rem}
.tw-modal h2{margin:0 0 10px;font-size:1.1rem}
.tw-modal ol{margin:6px 0 10px 18px;padding:0}
.tw-modal li{margin:3px 0}
.tw-qr{display:flex;justify-content:center;margin:10px 0}
.tw-qr svg{width:200px;height:200px}
.tw-state{margin:8px 0;font-weight:600}
.tw-state.tw-err{color:#c33}.tw-state.tw-ok{color:#1a7f37}
.tw-dim{color:#666;font-size:.78rem;margin-top:8px}
.tw-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
.tw-btns button{padding:7px 12px;border-radius:6px;border:1px solid #bbb;background:#f5f5f5;cursor:pointer}
.tw-btns .tw-copy{background:#1f6feb;color:#fff;border-color:#1f6feb}
.tw-btns button:disabled{opacity:.5;cursor:default}
#twPending{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;z-index:1001;font-size:.9rem}
`;
  function addCss() {
    if (document.getElementById("twCss")) return;
    const st = document.createElement("style");
    st.id = "twCss";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function pairWindow(client) {
    addCss();
    const back = document.createElement("div");
    back.className = "tw-back";
    back.innerHTML = "<div class='tw-modal' role='dialog' aria-modal='true'>" +
      "<h2 class='tw-title'></h2><div class='tw-intro'></div>" +
      "<ol><li class='tw-s1'></li><li class='tw-s2'></li><li class='tw-s3'></li></ol>" +
      "<div class='tw-state'></div><div class='tw-qr'></div><div class='tw-dim tw-phone'></div>" +
      "<div class='tw-dim tw-privacy'></div>" +
      "<div class='tw-btns'><button type='button' class='tw-cancel'></button><button type='button' class='tw-copy' disabled></button></div></div>";
    const $ = (s) => back.querySelector(s);
    $(".tw-title").textContent = tt("title");
    $(".tw-intro").textContent = tt("intro");
    $(".tw-s1").textContent = tt("step1");
    $(".tw-s2").textContent = tt("step2");
    $(".tw-s3").textContent = tt("step3");
    $(".tw-phone").textContent = tt("phone");
    $(".tw-privacy").textContent = tt("privacy");
    $(".tw-copy").textContent = tt("copy");
    $(".tw-cancel").textContent = tt("cancel");
    const state = (key, cls, extra) => {
      $(".tw-state").textContent = tt(key) + (extra ? " " + extra : "");
      $(".tw-state").className = "tw-state" + (cls ? " " + cls : "");
    };
    state("loading");
    document.body.appendChild(back);

    let done = false, uri = "", pairingTopic = null;
    return new Promise((resolve) => {
      const finish = (session) => {
        if (done) return;
        done = true;
        back.remove();
        resolve(session);
      };
      $(".tw-cancel").addEventListener("click", () => {
        if (pairingTopic) client.core.pairing.disconnect({ topic: pairingTopic }).catch(() => { /* non abbinato */ });
        finish(null);
      });
      $(".tw-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(uri); state("copied", "tw-ok"); }
        catch (e) { global.prompt(tt("copy"), uri); }
      });
      (async () => {
        try {
          const c = await client.connect({
            optionalNamespaces: { eip155: { chains: [CAIP], methods: WALLET_METHODS, events: ["accountsChanged", "chainChanged"] } },
          });
          if (done) return;
          uri = c.uri;
          pairingTopic = uri.slice(3).split("@")[0];
          $(".tw-copy").disabled = false;
          try {
            if (!global.qrcode) await loadScript(QR_SRC, QR_SRI);
            const q = global.qrcode(0, "M");
            q.addData(uri);
            q.make();
            $(".tw-qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
          } catch (e) { /* il link funziona comunque */ }
          state("waiting");
          const session = await c.approval();
          finish(session);
        } catch (e) {
          if (done) return;
          if (/reject/i.test((e && e.message) || "")) state("rejected", "tw-err");
          else state("failed", "tw-err", (e && e.message) || String(e));
        }
      })();
    });
  }

  function pendingBar(on) {
    let bar = document.getElementById("twPending");
    if (!on) { if (bar) bar.remove(); return; }
    addCss();
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "twPending";
      bar.setAttribute("role", "status");
      document.body.appendChild(bar);
    }
    bar.textContent = tt("pending");
  }

  // ---- provider EIP-1193 ---------------------------------------------------
  function makeProvider(client, session) {
    const topic = session.topic;
    const listeners = {};
    const emit = (ev, arg) => (listeners[ev] || []).slice().forEach((f) => { try { f(arg); } catch (e) { /* errore del listener */ } });
    const live = () => { try { return client.session.get(topic); } catch (e) { return null; } };
    const account = () => sessionAccount(live());
    let rid = 0;
    async function rpc(method, params) {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
      });
      const j = await res.json();
      if (j.error) throw Object.assign(new Error(j.error.message || "RPC error"), { code: j.error.code, data: j.error.data });
      return j.result;
    }
    const prov = {
      isWalletConnect: true,
      isUpWallet: true,
      on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return prov; },
      removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return prov; },
      async disconnect() {
        store.del(SESSION_KEY);
        try { await client.disconnect({ topic, reason: global.SignClientBundle.getSdkError("USER_DISCONNECTED") }); }
        catch (e) { /* già chiusa */ }
        emit("accountsChanged", []);
      },
      async request({ method, params = [] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") {
          const a = account();
          return a ? [a] : [];
        }
        if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
        if (method === "net_version") return String(CHAIN_ID);
        if (WALLET_METHODS.includes(method)) {
          if (!account()) throw new Error(tt("wrongChain"));
          pendingBar(true);
          try {
            return await client.request({ topic, chainId: CAIP, request: { method, params } });
          } catch (e) {
            const msg = (e && e.message) || String(e);
            // Il rifiuto di UP Wallet diventa il codice EIP-1193 usuale (4001),
            // così le pagine dicono "hai annullato" come con l'estensione LUKSO.
            if ((e && (e.code === 5000 || e.code === 4001)) || /reject|denied|cancel/i.test(msg)) {
              throw Object.assign(new Error(msg), { code: 4001 });
            }
            throw e;
          } finally {
            pendingBar(false);
          }
        }
        return rpc(method, params);
      },
    };
    client.on("session_delete", ({ topic: t }) => { if (t !== topic) return; store.del(SESSION_KEY); emit("accountsChanged", []); });
    client.on("session_update", ({ topic: t }) => { if (t === topic) emit("accountsChanged", account() ? [account()] : []); });
    return prov;
  }

  /**
   * Collega UP Wallet. Riusa la sessione già aperta in questo browser, se c'è;
   * altrimenti mostra la finestra di abbinamento.
   * @returns {Promise<object|null>} provider EIP-1193, o null se l'utente annulla
   */
  async function connect({ projectId, lang }) {
    if (lang) getLang = lang;
    if (!projectId) throw new Error("WalletConnect project ID mancante");
    const client = await signClient(projectId);
    const kept = store.get(SESSION_KEY);
    if (kept) {
      try {
        const s = client.session.get(kept);
        if (s && s.expiry * 1000 > Date.now() + 60000 && sessionAccount(s)) return makeProvider(client, s);
      } catch (e) { /* sessione scaduta o chiusa: nuovo abbinamento */ }
      store.del(SESSION_KEY);
    }
    const session = await pairWindow(client);
    if (!session) return null;
    if (!sessionAccount(session)) {
      try { await client.disconnect({ topic: session.topic, reason: global.SignClientBundle.getSdkError("USER_DISCONNECTED") }); }
      catch (e) { /* già chiusa */ }
      throw new Error(tt("wrongChain"));
    }
    store.set(SESSION_KEY, session.topic);
    return makeProvider(client, session);
  }

  global.TraceabilityWalletConnect = { connect, CHAIN_ID, RPC_URL };
})(typeof window !== "undefined" ? window : globalThis);
