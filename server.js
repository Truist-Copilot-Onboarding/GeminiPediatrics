// server.js — Heroku-compatible WS tunnel + live console (CommonJS)

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  APP_NAME: process.env.APP_NAME || 'ws-tunnel',
};

// ──────────────────────────────────────────────
// Central log bus → broadcasts to SSE clients
// ──────────────────────────────────────────────
const bus = new EventEmitter();
function log(...a) {
  const line = `${new Date().toISOString()} - ${a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`;
  console.log(line);
  bus.emit('line', line);
}

const app = express();
app.set('trust proxy', true);

// Small header
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// Health
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ──────────────────────────────────────────────
// Root: WSS tester page
// ──────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>WS Tunnel (Heroku)</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui;padding:2rem;max-width:960px;margin:auto}
  .row{display:grid;grid-template-columns:140px 1fr;gap:.5rem 1rem;align-items:center}
  .card{border:1px solid #ccc3;padding:12px;border-radius:8px;margin:12px 0}
  .ok{color:#0b7}.bad{color:#b22}.muted{opacity:.8}
  pre{background:#111;color:#0f0;padding:12px;border-radius:8px;white-space:pre-wrap;max-height:260px;overflow:auto}
  input,button{font:inherit;padding:.45rem}
  button:disabled{opacity:.5}
  a{color:inherit}
</style>
<h1>WebSocket Tunnel (Heroku)</h1>
<p class="muted">Served over HTTPS; client connects to <code>wss://HOST/ws-tunnel</code>. Echo also at <code>/ws-echo</code>. See <a href="/console" target="_blank">/console</a> for live server logs.</p>

<div class="row"><div>Endpoint</div><div><code id="ep">…</code></div></div>
<div class="row"><div>Status</div><div id="status">Connecting…</div></div>
<div class="row"><div>RTT (avg)</div><div id="rtt">–</div></div>

<div class="card">
  <div class="row"><div>Send</div>
    <div>
      <input id="msg" placeholder='Type text (or "ping")'/>
      <button id="send" disabled>Send</button>
    </div>
  </div>
</div>

<div class="card">
  <div class="row"><div>Log</div><div><pre id="log"></pre></div></div>
</div>

<script>
(function(){
  const url = (location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/ws-tunnel';
  document.getElementById('ep').textContent = url;

  const status=document.getElementById('status');
  const logEl=document.getElementById('log');
  const rttEl=document.getElementById('rtt');
  const sendBtn=document.getElementById('send');
  const input=document.getElementById('msg');

  const log=(m)=>{ const s=new Date().toISOString()+' '+m; console.log(s); logEl.textContent += s+"\\n"; logEl.scrollTop = logEl.scrollHeight; };
  const setSend=(on)=> sendBtn.disabled = !on;
  const mean=(a)=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;

  let ws, sent = new Map(), rtts=[];

  function connect(){
    ws = new WebSocket(url);
    ws.onopen = ()=>{ status.innerHTML='<span class="ok">OPEN</span>'; log('OPEN '+url); setSend(true); };
    ws.onerror = ()=>{ log('ERROR (browser hides details)'); };
    ws.onclose = (e)=>{ status.innerHTML='<span class="bad">CLOSED</span> code='+e.code; setSend(false); log('CLOSE code='+e.code+' reason="'+e.reason+'"'); };
    ws.onmessage = (ev)=>{
      let m=null; try{ m = JSON.parse(ev.data); } catch { return log('TEXT '+ev.data); }
      if (m.type==='welcome'){ log('WELCOME id='+m.clientId+' serverT='+m.serverTs); return; }
      if (m.type==='serverPing'){ log('serverPing '+m.serverTs); return; }
      if (m.type==='pong'){
        const t0 = sent.get(m.id);
        if (t0){ const dt = performance.now()-t0; rtts.push(dt); if (rtts.length>20) rtts.shift(); rttEl.textContent = mean(rtts).toFixed(1)+' ms'; sent.delete(m.id); }
        log('PONG id='+m.id+' serverT='+m.serverTs); return;
      }
      if (m.type==='say'){ log('SAY '+JSON.stringify(m)); return; }
      if (m.type==='error'){ log('ERROR '+m.message); return; }
      log('MSG '+JSON.stringify(m));
    };
  }

  sendBtn.onclick = ()=>{
    if (!ws || ws.readyState !== ws.OPEN) { log('SEND blocked (socket not open)'); return; }
    const text = (input.value || 'ping').trim();
    if (text.toLowerCase()==='ping'){
      const id = Math.random().toString(36).slice(2);
      sent.set(id, performance.now());
      ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() }));
      log('PING id='+id);
    } else {
      ws.send(JSON.stringify({ type:'say', text, clientTs: Date.now() }));
      log('SEND text='+text);
    }
    input.value='';
  };

  connect();
})();
</script>`);
});

// ──────────────────────────────────────────────
// /console → Live server log viewer (SSE)
// /logs    → SSE stream (text lines)
// ──────────────────────────────────────────────
app.get('/console', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>WS Server Console</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:ui-monospace, Menlo, Consolas, monospace; margin:0; background:#0b0b0b; color:#c8facc}
  header{padding:10px 14px; background:#111; border-bottom:1px solid #222}
  main{padding:10px 14px}
  pre{white-space:pre-wrap; word-break:break-word}
</style>
<header>
  <strong>Server Console</strong> — live from /logs (SSE)
  <span style="opacity:.7"> | <a href="/" style="color:#9cf">tester</a></span>
</header>
<main>
  <pre id="out"></pre>
</main>
<script>
  const out = document.getElementById('out');
  const es = new EventSource('/logs');
  es.onmessage = (e) => {
    out.textContent += e.data + "\\n";
    out.scrollTop = out.scrollHeight;
  };
  es.onerror = () => {
    out.textContent += new Date().toISOString() + " [SSE] connection error / closed\\n";
  };
</script>`);
});

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (line) => res.write(`data: ${line}\n\n`);
  const onLine = (line) => send(line);
  bus.on('line', onLine);

  // Send a hello and keepalive every 25s (avoid idle proxies)
  send(`${new Date().toISOString()} - [SSE] connected from ${req.ip || req.socket.remoteAddress}`);
  const iv = setInterval(() => send(`${new Date().toISOString()} - [SSE] keepalive`), 25000);

  req.on('close', () => { clearInterval(iv); bus.off('line', onLine); });
});

// ──────────────────────────────────────────────
// Single HTTP server + WS upgrades (Heroku style)
// ──────────────────────────────────────────────
const server = http.createServer(app);

// Loud upgrade logs to prove the Upgrade reaches the dyno
server.on('upgrade', (req, _sock) => {
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'}`);
});

// Attach WS endpoints
attachTunnelWSS(server);
attachEchoWSS(server);

// Listen
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  log(`web listening on :${CONFIG.PORT}`);
});

// ──────────────────────────────────────────────
// WS handlers
// ──────────────────────────────────────────────
function attachEchoWSS(server) {
  const wss = new WebSocketServer({ server, path: '/ws-echo', perMessageDeflate: false });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    log(`ECHO connected ip=${ip} origin=${origin}`);
    try { ws.send(JSON.stringify({ type: 'hello', app: CONFIG.APP_NAME })); } catch {}
    setTimeout(() => { try { ws.close(1000, 'bye'); } catch {} }, 200);
  });
}

function attachTunnelWSS(server) {
  const wss = new WebSocketServer({ server, path: '/ws-tunnel', perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    const ua = req.headers['user-agent'] || '(ua?)';
    const clientId = Math.random().toString(36).slice(2);
    log(`TUNNEL connected ip=${ip} origin=${origin} ua="${ua}" id=${clientId}`);

    // Welcome text frame
    safeSend(ws, { type: 'welcome', clientId, serverTs: Date.now() });

    // Control keepalive (browser auto-pongs); keep < Heroku idle (~55s)
    const ctrlPing = setInterval(() => {
      if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch {} }
    }, 25000);

    // App heartbeat (visible to client)
    const appBeat = setInterval(() => {
      safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
    }, 15000);

    ws.on('message', (data) => {
      let m = null;
      try { m = JSON.parse(data.toString('utf8')); } catch {
        return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
      }
      if (m && m.type === 'ping') {
        return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
      }
      if (m && m.type === 'say') {
        return safeSend(ws, { type: 'say', echo: m.text ?? '', serverTs: Date.now() });
      }
      safeSend(ws, { type: 'error', message: 'Unsupported message type' });
    });

    ws.on('error', (err) => { log('TUNNEL error:', err?.message || err); });
    ws.on('close', (code, reason) => {
      clearInterval(ctrlPing); clearInterval(appBeat);
      const r = reason && reason.toString ? reason.toString() : '';
      log(`TUNNEL closed id=${clientId} code=${code} reason="${r}"`);
    });
  });
}

function safeSend(ws, obj) { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {} }

