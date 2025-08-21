// server.js — WebSocket tunnel tester (dual ports: 80 + 443; CommonJS)
// - HTTP :80 serves ACME webroot + redirect to HTTPS (and WS endpoints)
// - HTTPS :443 serves hosted tester page and WSS endpoints
// - Optional Let's Encrypt automation (certbot, webroot)
// - Self-signed fallback cert if LE not available
// - Falls back to single-port mode if ONLY process.env.PORT is set

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const express = require('express');
const { WebSocketServer } = require('ws');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

// ─────────────────────────────────────────────────────────────
// CONFIG — edit these (or override with env vars)
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // Domain used for LE and links in logs/UI
  HOSTNAME: process.env.HOSTNAME || 'example.com',

  // Dual-port defaults; if only $PORT is set we run single-port
  HTTP_PORT: Number(process.env.HTTP_PORT || 80),
  HTTPS_PORT: Number(process.env.HTTPS_PORT || 443),
  PORT: process.env.PORT ? Number(process.env.PORT) : undefined, // single-port mode if defined

  // Let’s Encrypt via certbot (webroot)
  CERTBOT_ENABLED: (process.env.CERTBOT_ENABLED || 'true').toLowerCase() === 'true',
  CERTBOT_EMAIL: process.env.CERTBOT_EMAIL || '', // ← set an email to auto-issue
  CERTBOT_STAGING: (process.env.CERTBOT_STAGING || 'false').toLowerCase() === 'true',
  RENEW_EVERY_HOURS: Number(process.env.RENEW_EVERY_HOURS || 12),

  // ACME webroot dir for HTTP-01 challenges
  ACME_WEBROOT: path.join(__dirname, 'acme-webroot'),

  // Fallback self-signed certs (generated if missing)
  CERTS_DIR: path.join(__dirname, 'certs'),
  FALLBACK_CERT: path.join(__dirname, 'certs', 'server.crt'),
  FALLBACK_KEY:  path.join(__dirname, 'certs', 'server.key'),
  FALLBACK_CA:   '', // optional chain
};

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
const exists = async (p) => !!(await fsp.stat(p).catch(() => null));

// ─────────────────────────────────────────────────────────────
// LE helpers (webroot HTTP-01)
// ─────────────────────────────────────────────────────────────
function leLiveDir(domain) { return `/etc/letsencrypt/live/${domain}`; }
function lePaths(domain) {
  const dir = leLiveDir(domain);
  return {
    dir,
    fullchain: path.join(dir, 'fullchain.pem'),
    privkey:   path.join(dir, 'privkey.pem'),
    chain:     path.join(dir, 'chain.pem'),
  };
}
async function ensureAcmeWebroot() {
  const chal = path.join(CONFIG.ACME_WEBROOT, '.well-known', 'acme-challenge');
  await fsp.mkdir(chal, { recursive: true });
  return chal;
}
async function certbotInstalled() {
  try { const { stdout } = await execFileP('certbot', ['--version']); log(stdout.trim()); return true; } catch { return false; }
}
async function issueWithCertbotIfMissing() {
  if (!CONFIG.CERTBOT_ENABLED) return false;
  if (!CONFIG.CERTBOT_EMAIL) { log('CERTBOT_EMAIL not set; skipping issuance.'); return false; }
  if (!(await certbotInstalled())) { log('certbot not found; skipping issuance.'); return false; }
  const le = lePaths(CONFIG.HOSTNAME);
  if (await exists(le.fullchain) && await exists(le.privkey)) return false;

  log('Attempting first-time Let’s Encrypt issuance (HTTP-01 webroot)…');
  await ensureAcmeWebroot();
  const args = [
    'certonly','--non-interactive','--agree-tos',
    '--email', CONFIG.CERTBOT_EMAIL,
    '--webroot','-w', CONFIG.ACME_WEBROOT,
    '-d', CONFIG.HOSTNAME
  ];
  if (CONFIG.CERTBOT_STAGING) args.push('--staging');
  try {
    const { stdout, stderr } = await execFileP('certbot', args, { timeout: 5 * 60 * 1000 });
    if (stdout) log(stdout.trim());
    if (stderr) log(stderr.trim());
    log('certbot: initial certificate obtained.');
    return true;
  } catch (e) {
    log('certbot certonly failed:', e?.message || e);
    if (e?.stdout) log('stdout:', e.stdout.trim());
    if (e?.stderr) log('stderr:', e.stderr.trim());
    return false;
  }
}
async function ensureFallbackCerts() {
  await fsp.mkdir(CONFIG.CERTS_DIR, { recursive: true });
  const have = (await exists(CONFIG.FALLBACK_CERT)) && (await exists(CONFIG.FALLBACK_KEY));
  if (have) return true;
  try { await execFileP('openssl', ['version']); }
  catch {
    log('⚠️ openssl not found. Create a fallback cert manually:');
    log(`  mkdir -p ${CONFIG.CERTS_DIR}`);
    log(`  openssl req -x509 -nodes -newkey rsa:2048 -keyout ${CONFIG.FALLBACK_KEY} -out ${CONFIG.FALLBACK_CERT} -days 365 -subj "/CN=${CONFIG.HOSTNAME}" -addext "subjectAltName=DNS:${CONFIG.HOSTNAME}"`);
    return false;
  }
  log('Generating self-signed fallback cert…');
  await execFileP('openssl', [
    'req','-x509','-nodes','-newkey','rsa:2048',
    '-keyout', CONFIG.FALLBACK_KEY,
    '-out',   CONFIG.FALLBACK_CERT,
    '-days','365',
    '-subj', `/CN=${CONFIG.HOSTNAME}`,
    '-addext', `subjectAltName=DNS:${CONFIG.HOSTNAME}`
  ]);
  log('Self-signed fallback cert created in ./certs');
  return true;
}
async function loadTlsOptionsPreferLE() {
  const le = lePaths(CONFIG.HOSTNAME);
  if (await exists(le.fullchain) && await exists(le.privkey)) {
    log(`Loading LE certs from ${le.dir}`);
    const [cert, key, ca] = await Promise.all([
      fsp.readFile(le.fullchain),
      fsp.readFile(le.privkey),
      exists(le.chain).then(ok => ok ? fsp.readFile(le.chain) : null),
    ]);
    const opts = { cert, key }; if (ca) opts.ca = ca;
    return { opts, source: 'le' };
  }
  await ensureFallbackCerts();
  log('Using fallback certs from ./certs');
  const [cert, key, ca] = await Promise.all([
    fsp.readFile(CONFIG.FALLBACK_CERT),
    fsp.readFile(CONFIG.FALLBACK_KEY),
    CONFIG.FALLBACK_CA ? fsp.readFile(CONFIG.FALLBACK_CA).catch(() => null) : null
  ]);
  const opts = { cert, key }; if (ca) opts.ca = ca;
  return { opts, source: 'fallback' };
}

// ─────────────────────────────────────────────────────────────
// Express apps
// ─────────────────────────────────────────────────────────────
const appHttps = express();
const appHttp  = express();

appHttps.use((req,res,next)=>{ res.setHeader('X-Content-Type-Options','nosniff'); next(); });

// Hosted tester (served over HTTPS so the browser will use wss://)
appHttps.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>WS Tunnel (443 + 80)</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui;padding:2rem;max-width:960px;margin:auto}
  .row{display:grid;grid-template-columns:140px 1fr;gap:.5rem 1rem;align-items:center}
  .card{border:1px solid #ccc3;padding:12px;border-radius:8px;margin:12px 0}
  .ok{color:#0b7}.bad{color:#b22}.muted{opacity:.8}
  pre{background:#111;color:#0f0;padding:12px;border-radius:8px;white-space:pre-wrap;max-height:260px;overflow:auto}
  input,button{font:inherit;padding:.45rem} button:disabled{opacity:.5}
</style>
<h1>WebSocket Tunnel (dual-port)</h1>
<p class="muted">Served over HTTPS; client connects to <code>wss://HOST/ws-tunnel</code>. Echo also at <code>/ws-echo</code>.</p>
<div class="row"><div>Endpoint</div><div><code id="ep">…</code></div></div>
<div class="row"><div>Status</div><div id="status">Connecting…</div></div>
<div class="row"><div>RTT (avg)</div><div id="rtt">–</div></div>
<div class="card"><div class="row"><div>Send</div><div>
  <input id="msg" placeholder='Type text (or "ping")'/>
  <button id="send" disabled>Send</button>
</div></div></div>
<div class="card"><div class="row"><div>Log</div><div><pre id="log"></pre></div></div></div>
<script>
(function(){
  const url = 'wss://' + location.host + '/ws-tunnel';
  document.getElementById('ep').textContent = url;
  const status = document.getElementById('status');
  const logEl  = document.getElementById('log');
  const rttEl  = document.getElementById('rtt');
  const send   = document.getElementById('send');
  const input  = document.getElementById('msg');
  const log = (m) => { const s = new Date().toISOString() + ' ' + m; console.log(s); logEl.textContent += s + "\\n"; logEl.scrollTop = logEl.scrollHeight; };
  const setSend = (on) => send.disabled = !on;
  const mean = (a)=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;
  let ws, rtts=[], sent = new Map();
  function connect(){
    ws = new WebSocket(url);
    ws.onopen = () => { status.innerHTML = '<span class="ok">OPEN</span>'; log('OPEN ' + url); setSend(true); };
    ws.onerror = () => { log('ERROR (browser hides details)'); };
    ws.onclose = (e) => { status.innerHTML = '<span class="bad">CLOSED</span> code='+e.code; setSend(false); log('CLOSE code='+e.code+' reason="'+e.reason+'"'); };
    ws.onmessage = (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch { return log('TEXT ' + ev.data); }
      if (m.type === 'welcome') { log('WELCOME id=' + m.clientId + ' serverT=' + m.serverTs); return; }
      if (m.type === 'serverPing') { log('serverPing ' + m.serverTs); return; }
      if (m.type === 'pong') {
        const t0 = sent.get(m.id);
        if (t0) { const dt = performance.now() - t0; rtts.push(dt); if (rtts.length>20) rtts.shift(); rttEl.textContent = mean(rtts).toFixed(1) + ' ms'; sent.delete(m.id); }
        log('PONG id=' + m.id + ' serverT=' + m.serverTs); return;
      }
      if (m.type === 'say') { log('SAY ' + JSON.stringify(m)); return; }
      if (m.type === 'error') { log('ERROR ' + m.message); return; }
      log('MSG ' + JSON.stringify(m));
    };
  }
  send.onclick = () => {
    if (!ws || ws.readyState !== ws.OPEN) { log('SEND blocked (socket not open)'); return; }
    const text = (input.value || 'ping').trim();
    if (text.toLowerCase() === 'ping') {
      const id = Math.random().toString(36).slice(2);
      sent.set(id, performance.now());
      ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() }));
      log('PING id=' + id);
    } else {
      ws.send(JSON.stringify({ type:'say', text, clientTs: Date.now() }));
      log('SEND text=' + text);
    }
    input.value = '';
  };
  connect();
})();
</script>`);
});

// HTTP: ACME webroot + redirect to HTTPS (keeps WS endpoints too)
appHttp.use('/.well-known/acme-challenge',
  express.static(path.join(CONFIG.ACME_WEBROOT, '.well-known', 'acme-challenge'), { dotfiles:'allow' }));

appHttp.get('/', (req, res) => {
  const host = CONFIG.HOSTNAME || req.headers.host;
  res.writeHead(301, { Location: `https://${host}/` }).end();
});

// ─────────────────────────────────────────────────────────────
// WebSocket endpoints (attached to servers below)
// ─────────────────────────────────────────────────────────────
function attachEchoWSS(server, label) {
  const wss = new WebSocketServer({ server, path: '/ws-echo', perMessageDeflate: false });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    log(`ECHO[${label}] connected ip=${ip} origin=${origin}`);
    try { ws.send(JSON.stringify({ type: 'hello', host: CONFIG.HOSTNAME, label })); } catch {}
    setTimeout(() => { try { ws.close(1000, 'bye'); } catch {} }, 200);
  });
}

function attachTunnelWSS(server, label) {
  const wss = new WebSocketServer({ server, path: '/ws-tunnel', perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    const ua = req.headers['user-agent'] || '(ua?)';
    const clientId = Math.random().toString(36).slice(2);
    log(`TUNNEL[${label}] connected ip=${ip} origin=${origin} ua="${ua}" id=${clientId}`);

    // Welcome text frame
    safeSend(ws, { type: 'welcome', clientId, serverTs: Date.now(), label });

    // Control keepalive (browser auto-pongs); choose < typical idle timeouts
    const ctrlPing = setInterval(() => {
      if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch {} }
    }, 25000);

    // App heartbeat
    const appBeat = setInterval(() => {
      safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
    }, 15000);

    ws.on('message', (data) => {
      let m = null;
      try { m = JSON.parse(data.toString('utf8')); } catch {
        return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
      }
      if (m?.type === 'ping') {
        return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
      }
      if (m?.type === 'say') {
        return safeSend(ws, { type: 'say', echo: m.text ?? '', serverTs: Date.now() });
      }
      safeSend(ws, { type: 'error', message: 'Unsupported message type' });
    });

    ws.on('error', (err) => { log(`TUNNEL[${label}] error:`, err?.message || err); });
    ws.on('close', (code, reason) => {
      clearInterval(ctrlPing); clearInterval(appBeat);
      const r = reason && reason.toString ? reason.toString() : '';
      log(`TUNNEL[${label}] closed id=${clientId} code=${code} reason="${r}"`);
    });
  });
}
function safeSend(ws, obj) { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {} }

// ─────────────────────────────────────────────────────────────
// Bootstrap: dual-port if no $PORT; otherwise single-port ($PORT)
// ─────────────────────────────────────────────────────────────
(async () => {
  await ensureAcmeWebroot();

  if (CONFIG.PORT && !process.env.HTTP_PORT && !process.env.HTTPS_PORT) {
    // SINGLE-PORT mode (e.g., Heroku). No TLS inside dyno; TLS at edge.
    const appSingle = express();
    appSingle.use((req,res,next)=>{ res.setHeader('X-Content-Type-Options','nosniff'); next(); });
    appSingle.get('/', (_req, res) => res.redirect('/https-tester'));
    appSingle.get('/https-tester', (_req, res) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>WS Tunnel (single port)</title>
      <p>Auto-connects to <code>ws(s)://HOST/ws-tunnel</code> based on page protocol.</p>
      <script>
        location.href = (location.protocol==='https:'?'https':'http') + '://' + location.host + '/';
      </script>`);
    });
    // Reuse HTTPS app for UI (it’s protocol-agnostic HTML)
    const server = http.createServer((_req, res) => appHttps(_req, res));
    server.on('upgrade', (req, _sock) => {
      console.log(new Date().toISOString(),
        ` - UPGRADE[${CONFIG.PORT}] ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'}`);
    });
    attachTunnelWSS(server, `${CONFIG.PORT}`);
    attachEchoWSS(server, `${CONFIG.PORT}`);
    server.listen(CONFIG.PORT, '0.0.0.0', () => log(`HTTP :${CONFIG.PORT} (single-port mode)`));
    return;
  }

  // DUAL-PORT mode
  // HTTP :80 (ACME + redirect + WS)
  const httpServer = http.createServer(appHttp);
  httpServer.on('upgrade', (req, _sock) => {
    console.log(new Date().toISOString(),
      ` - UPGRADE[80] ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'}`);
  });
  attachTunnelWSS(httpServer, '80');
  attachEchoWSS(httpServer, '80');
  httpServer.listen(CONFIG.HTTP_PORT, '0.0.0.0', () => log(`HTTP  :${CONFIG.HTTP_PORT} (ACME webroot, redirect, WS)`));

  // Try initial LE issuance (non-blocking if fails)
  await issueWithCertbotIfMissing().catch(()=>{});

  // HTTPS :443 (WSS + hosted tester)
  const { opts: tlsOpts, source } = await loadTlsOptionsPreferLE();
  const httpsServer = https.createServer({
    ...tlsOpts,
    minVersion: 'TLSv1.2',
    requestCert: false,
    honorCipherOrder: true,
  }, appHttps);

  httpsServer.on('secureConnection', (s) => {
    const sni = s.servername || '(none)';
    const proto = s.getProtocol?.() || '(unknown)';
    const cipher = s.getCipher?.().name || '(unknown)';
    log(`TLS secureConnection: sni=${sni} proto=${proto} cipher=${cipher}`);
  });
  httpsServer.on('upgrade', (req, _sock) => {
    console.log(new Date().toISOString(),
      ` - UPGRADE[443] ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'}`);
  });
  attachTunnelWSS(httpsServer, '443');
  attachEchoWSS(httpsServer, '443');
  httpsServer.listen(CONFIG.HTTPS_PORT, '0.0.0.0', () => {
    log(`HTTPS :${CONFIG.HTTPS_PORT} (tls=${source})`);
    log(`WSS   wss://${CONFIG.HOSTNAME}:${CONFIG.HTTPS_PORT}/ws-tunnel`);
  });

  // LE renew + hot reload (best-effort)
  if (CONFIG.CERTBOT_ENABLED && await certbotInstalled()) {
    const runRenew = async () => {
      try { await execFileP('certbot', ['renew','--quiet']); } catch (e) { log('certbot renew failed:', e?.message || e); }
      const le = lePaths(CONFIG.HOSTNAME);
      if (await exists(le.fullchain) && await exists(le.privkey)) {
        try {
          const [cert, key, ca] = await Promise.all([
            fsp.readFile(le.fullchain),
            fsp.readFile(le.privkey),
            exists(le.chain).then(ok => ok ? fsp.readFile(le.chain) : null),
          ]);
          const newOpts = { cert, key }; if (ca) newOpts.ca = ca;
          if (typeof httpsServer.setSecureContext === 'function') {
            httpsServer.setSecureContext(newOpts);
            log('TLS context reloaded after renew.');
          }
        } catch (e) { log('TLS reload failed:', e?.message || e); }
      }
    };
    setInterval(runRenew, Math.max(CONFIG.RENEW_EVERY_HOURS,1)*60*60*1000);
  }
})();

