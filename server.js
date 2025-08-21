// server.js — Heroku-compatible WS tunnel + live console + deep socket diagnostics (CommonJS)

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  APP_NAME: process.env.APP_NAME || 'ws-tunnel',
};

// Central log bus → broadcasts to SSE clients
const bus = new EventEmitter();
function log(...a) {
  const line = `${new Date().toISOString()} - ${a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`;
  console.log(line);
  bus.emit('line', line);
}

// Catch hidden crashes
process.on('uncaughtException', (e) => log('UNCAUGHT', e?.stack || e?.message || String(e)));
process.on('unhandledRejection', (e) => log('UNHANDLED_REJECTION', e?.stack || e?.message || String(e)));

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// Health
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ────────────────── Root tester ──────────────────
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
<p class="muted">Served over HTTPS; connects to <code>wss://HOST/ws-tunnel</code>. Echo at <code>/ws-echo</code>. Live server logs at <a href="/console" target="_blank">/console</a>.</p>

<div class="row"><div>Endpoint</div><div><code id="ep">…</code></div></div>
<div class="row"><div>Status</div><div id="status">Connecting…</div></div>
<div class="row"><div>RTT (avg)</div><div id="rtt">–</div></div>

<div class="card">
  <div class="row"><div>Send</div>
    <div>
      <input id="msg" placeholder='Type text (or "ping")'/>
      <button id="send" disabled>Send</button>
      <button id="reconnect">Reconnect</button>
    </div>
  </div>
</div>

<div class="card">
  <div class="row"><div>Log</div>
    <div>
      <pre id="log"></pre>
      <button id="copyLogs">Copy Logs</button> <!-- CHANGE: Add copy button -->
    </div>
  </div>
</div>

<script>
(function(){
  const url = (location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/ws-tunnel';
  document.getElementById('ep').textContent = url;

  const status=document.getElementById('status');
  const logEl=document.getElementById('log');
  const rttEl=document.getElementById('rtt');
  const sendBtn=document.getElementById('send');
  const reconnectBtn=document.getElementById('reconnect');
  const copyLogsBtn=document.getElementById('copyLogs'); // CHANGE: Get copy button
  const input=document.getElementById('msg');

  const log=(m)=>{ 
    const s=new Date().toISOString()+' '+m; 
    console.log(s); 
    logEl.textContent += s+"\\n"; 
    logEl.scrollTop = logEl.scrollHeight; 
  };
  const setSend=(on)=> sendBtn.disabled = !on;
  const mean=(a)=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;

  // CHANGE: Copy logs to clipboard
  copyLogsBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(logEl.textContent);
      log('Logs copied to clipboard');
    } catch (e) {
      log('Copy failed: '+e.message);
      // Fallback for non-secure contexts
      const textarea = document.createElement('textarea');
      textarea.value = logEl.textContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      log('Logs copied using fallback');
    }
  };

  let ws, sent = new Map(), rtts=[], reconnectAttempts = 0;

  function connect(){
    log('Attempting connection to '+url+' (attempt '+(reconnectAttempts+1)+')');
    ws = new WebSocket(url);
    ws.onopen = ()=>{ 
      status.innerHTML='<span class="ok">OPEN</span>'; 
      log('OPEN '+url); 
      setSend(true); 
      reconnectAttempts = 0;
      // CHANGE: Send application-level ping
      const id = Math.random().toString(36).slice(2);
      sent.set(id, performance.now());
      ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() }));
      log('Client sent ping id='+id);
      // CHANGE: Client heartbeat
      const heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          const id = Math.random().toString(36).slice(2);
          sent.set(id, performance.now());
          ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() }));
          log('Client heartbeat ping id='+id);
        } else {
          clearInterval(heartbeat);
        }
      }, 2000);
    };
    ws.onerror = (e)=>{ log('ERROR (browser hides details)'); };
    ws.onclose = (e)=>{
      status.innerHTML='<span class="bad">CLOSED</span> code='+e.code; 
      setSend(false); 
      log('CLOSE code='+e.code+' reason="'+e.reason+'"');
      reconnectAttempts++;
      const delay = Math.min(15000, 5000 + reconnectAttempts * 2000); // CHANGE: Exponential backoff
      setTimeout(connect, delay);
    };
    ws.onmessage = (ev)=>{
      log('MESSAGE received length='+ev.data.length);
      let m=null; try{ m = JSON.parse(ev.data); } catch { return log('TEXT '+ev.data); }
      if (m.type==='welcome'){ log('WELCOME id='+m.clientId+' serverT='+m.serverTs); return; }
      if (m.type==='serverPing'){ log('serverPing '+m.serverTs); return; }
      if (m.type==='pong'){
        const t0 = sent.get(m.id);
        if (t0){ const dt = performance.now()-t0; rtts.push(dt); if (rtts.length>20) rtts.shift(); rttEl.textContent = mean(rtts).toFixed(1)+' ms'; sent.delete(m.id); }
        log('PONG id='+m.id+' serverT='+m.serverTs); return; }
      if (m.type==='say'){ log('SAY '+JSON.stringify(m)); return; }
      if (m.type==='error'){ log('ERROR '+m.message); return; }
      log('MSG '+JSON.stringify(m));
    };
    // CHANGE: Removed ws.on('pong', ...)
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

  reconnectBtn.onclick = ()=>{
    if (ws) ws.close();
    connect();
  };

  connect();
})();
</script>`);
});

// ───────────── /console (SSE) ─────────────
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
  <button id="copyLogs">Copy Logs</button> <!-- CHANGE: Add copy button -->
</main>
<script>
  const out = document.getElementById('out');
  const copyLogsBtn = document.getElementById('copyLogs');
  const es = new EventSource('/logs');
  es.onmessage = (e) => { out.textContent += e.data + "\\n"; out.scrollTop = out.scrollHeight; };
  es.onerror = () => { out.textContent += new Date().toISOString() + " [SSE] error/closed\\n"; };
  copyLogsBtn.onclick = async () => { // CHANGE: Copy logs
    try {
      await navigator.clipboard.writeText(out.textContent);
      out.textContent += new Date().toISOString() + " Logs copied to clipboard\\n";
    } catch (e) {
      out.textContent += new Date().toISOString() + " Copy failed: " + e.message + "\\n";
      const textarea = document.createElement('textarea');
      textarea.value = out.textContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      out.textContent += new Date().toISOString() + " Logs copied using fallback\\n";
    }
    out.scrollTop = out.scrollHeight;
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
  send(`${new Date().toISOString()} - [SSE] connected from ${req.ip || req.socket.remoteAddress}`);
  const iv = setInterval(() => send(`${new Date().toISOString()} - [SSE] keepalive`), 15000);
  req.on('close', () => { clearInterval(iv); bus.off('line', onLine); });
});

// ─────────── HTTP server + WS on same port ───────────
const server = http.createServer(app);

// Extra diagnostics
server.on('clientError', (err, socket) => {
  log('HTTP clientError', err?.message || err);
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

server.on('upgrade', (req, socket, head) => {
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'} protocol=${req.headers['sec-websocket-protocol']||'(none)'} extensions=${req.headers['sec-websocket-extensions']||'(none)'}`);
});

// Attach WS endpoints
attachTunnelWSS(server);
attachEchoWSS(server);

// Listen
server.listen(CONFIG.PORT, '0.0.0.0', () => log(`web listening on :${CONFIG.PORT}`));

// ─────────── WS endpoints ───────────
function attachEchoWSS(server) {
  const wss = new WebSocketServer({ server, path: '/ws-echo', perMessageDeflate: false });
  wss.on('connection', (ws, req) => {
    attachRawSocketLogs(ws, 'ECHO');
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    log(`ECHO connected ip=${ip} origin=${origin}`);
    try { ws.send(JSON.stringify({ type: 'hello', app: CONFIG.APP_NAME })); } catch {}
    setTimeout(() => { try { ws.close(1000, 'bye'); } catch {} }, 200);
  });
}

function attachTunnelWSS(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws-tunnel',
    perMessageDeflate: false,
    maxPayload: 1024 * 1024
  });

  wss.on('headers', (headers, req) => {
    log('HEADERS ws-tunnel', JSON.stringify(headers));
  });

  wss.on('connection', (ws, req) => {
    const s = ws._socket;
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 5000); 
      log('TUNNEL socket options set: noDelay=true, keepAlive=5s');
    } catch (e) {
      log('TUNNEL socket options error', e?.message || e);
    }

    attachRawSocketLogs(ws, 'TUNNEL');

    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    const ua = req.headers['user-agent'] || '(ua?)';
    const clientId = Math.random().toString(36).slice(2);
    log(`TUNNEL connected ip=${ip} origin=${origin} ua="${ua}" id=${clientId}`);

    try {
      ws.send(JSON.stringify({ type: 'welcome', clientId, serverTs: Date.now() }));
      log('TUNNEL sent welcome');
      ws.ping(); // CHANGE: Keep server ping for Heroku compatibility
      log('TUNNEL sent initial ping');
    } catch (e) {
      log('TUNNEL initial send error', e?.message || e);
    }

    ws.on('ping', () => { 
      try { 
        ws.pong(); 
        log('TUNNEL pong sent'); 
      } catch {} 
    });

    ws.on('pong', () => {
      log('TUNNEL received pong');
    });

    const appBeat = setInterval(() => {
      safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
      try { 
        ws.ping(); 
        log('TUNNEL heartbeat ping sent');
      } catch {}
    }, 2000);

    ws.on('message', (data, isBinary) => {
      log(`TUNNEL message received isBinary=${isBinary} length=${data.length} content=${data.toString('utf8').slice(0, 200)}`);
      let m = null;
      try { m = JSON.parse(data.toString('utf8')); } catch {
        return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
      }
      if (m?.type === 'ping') {
        log('TUNNEL received client ping id='+m.id); // CHANGE: Log client ping
        return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
      }
      if (m?.type === 'say') {
        return safeSend(ws, { type: 'say', echo: m.text ?? '', serverTs: Date.now() });
      }
      safeSend(ws, { type: 'error', message: 'Unsupported message type' });
    });

    ws.on('error', (err) => { log('TUNNEL error:', err?.message || err); });
    ws.on('close', (code, reason) => {
      clearInterval(appBeat);
      const r = reason && reason.toString ? reason.toString() : '';
      log(`TUNNEL closed id=${clientId} code=${code} reason="${r}" socketState=${s.readyState} bufferLength=${s.bufferLength || 0}`);
    });
  });
}

function attachRawSocketLogs(ws, label) {
  const s = ws._socket;
  if (!s) return;
  try { s.setNoDelay(true); } catch {}
  s.on('close', (hadErr) => log(`${label} RAW close hadErr=${hadErr} socketState=${s.readyState}`));
  s.on('end', () => log(`${label} RAW end socketState=${s.readyState}`));
  s.on('error', (e) => log(`${label} RAW error`, e?.code || '', e?.message || e));
  s.on('timeout', () => log(`${label} RAW timeout`));
  s.on('data', (data) => log(`${label} RAW data length=${data.length}`));
}

function safeSend(ws, obj) { 
  try { 
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); 
  } catch (e) { 
    log('safeSend error', e?.message || e); 
  } 
}
