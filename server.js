// server.js — Heroku-compatible WS tunnel + live console + auto-download over WebSocket (CommonJS)

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  APP_NAME: process.env.APP_NAME || 'ws-tunnel',
  PDF_NAME: process.env.PDF_NAME || 'HelloWorld.exe',
  PDF_PATH: process.env.PDF_PATH || path.join(__dirname, 'files', 'HelloWorld.exe'),
  CHUNK_SIZE: 8 * 1024, // CHANGE: Reduced to 8 KiB
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

// Catch hidden crashes
process.on('uncaughtException', (e) => log('UNCAUGHT', e?.stack || e?.message || String(e)));
process.on('unhandledRejection', (e) => log('UNHANDLED_REJECTION', e?.stack || e?.message || String(e)));

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// Health
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Direct PDF (inline preview for troubleshooting)
let PDF_BUFFER = null;
async function loadPdfBufferOnce() {
  try {
    const b = await fsp.readFile(CONFIG.PDF_PATH);
    PDF_BUFFER = b;
    log(`File loaded bytes=${b.length} from ${CONFIG.PDF_PATH} (display name=${CONFIG.PDF_NAME})`);
  } catch (e) {
    PDF_BUFFER = null;
    log(`File not found at ${CONFIG.PDF_PATH} — WS download will be skipped until provided.`);
  }
}
app.get('/HelloWorld.exe', async (_req, res) => {
  if (!PDF_BUFFER) await loadPdfBufferOnce();
  if (!PDF_BUFFER) return res.status(404).type('text').send('No file configured on server.');
  res
    .status(200)
    .setHeader('Content-Type', 'application/vnd.microsoft.portable-executable')
    .setHeader('Content-Disposition', `inline; filename="${CONFIG.PDF_NAME}"`)
    .send(PDF_BUFFER);
});

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
  progress{width:100%}
</style>
<h1>WebSocket Tunnel (Heroku) — Auto Download</h1>
<p class="muted">
  On connect, the server auto-streams a file over <code>/ws-tunnel</code> and the browser saves it.<br>
  <strong>Troubleshooting link (inline preview):</strong> <a href="/HelloWorld.exe" target="_blank">/HelloWorld.exe</a><br>
  Live logs at <a href="/console" target="_blank">/console</a>.
</p>

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
  <div class="row"><div>Download</div>
    <div>
      <div id="pdfInfo" class="muted">waiting…</div>
      <progress id="pdfProg" max="100" value="0"></progress>
    </div>
  </div>
</div>

<div class="card">
  <div class="row"><div>Log</div>
    <div>
      <pre id="log"></pre>
      <button id="copyLogs">Copy Logs</button>
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
  const copyLogsBtn=document.getElementById('copyLogs');
  const input=document.getElementById('msg');
  const pdfInfo=document.getElementById('pdfInfo');
  const pdfProg=document.getElementById('pdfProg');

  const log=(m)=>{ const s=new Date().toISOString()+' '+m; console.log(s); logEl.textContent += s+"\\n"; logEl.scrollTop = logEl.scrollHeight; };
  const setSend=(on)=> sendBtn.disabled = !on;
  const mean=(a)=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;

  copyLogsBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(logEl.textContent); log('Logs copied to clipboard'); }
    catch (e) {
      log('Copy failed: '+e.message);
      const t=document.createElement('textarea'); t.value=logEl.textContent; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
      log('Logs copied using fallback');
    }
  };

  let ws, sent = new Map(), rtts=[], reconnectAttempts = 0;

  // PDF receive state
  let rx = null;
  function b64ToBytes(b64) {
    try {
      const bin = atob(b64); const len = bin.length;
      const out = new Uint8Array(len);
      for (let i=0;i<len;i++) out[i] = bin.charCodeAt(i) & 0xFF;
      return out;
    } catch (e) {
      log('b64ToBytes error: '+e.message); // CHANGE: Log decode errors
      return new Uint8Array(0);
    }
  }
  function resetRx(){ rx=null; pdfInfo.textContent='waiting…'; pdfProg.value=0; }

  function connect(){
    log('Attempting connection to '+url+' (attempt '+(reconnectAttempts+1)+')');
    ws = new WebSocket(url);
    ws.onopen = ()=>{ 
      status.innerHTML='<span class="ok">OPEN</span>'; 
      log('OPEN '+url); 
      setSend(true); 
      reconnectAttempts = 0; // CHANGE: Reset attempts
      try {
        const id1 = Math.random().toString(36).slice(2);
        sent.set(id1, performance.now());
        ws.send(JSON.stringify({ type:'ping', id: id1, clientTs: Date.now() }));
        log('Client sent initial ping id='+id1);
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            const id2 = Math.random().toString(36).slice(2);
            sent.set(id2, performance.now());
            ws.send(JSON.stringify({ type:'ping', id: id2, clientTs: Date.now() }));
            log('Client sent second ping id='+id2);
          }
        }, 50);
      } catch (e) { log('Client send error: '+e.message); }
      const heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          try {
            const id = Math.random().toString(36).slice(2);
            sent.set(id, performance.now());
            ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() }));
            log('Client heartbeat ping id='+id);
          } catch (e) {
            log('Client heartbeat error: '+e.message);
          }
        } else {
          clearInterval(heartbeat);
        }
      }, 2000); // CHANGE: 2s heartbeat
    };
    ws.onerror = ()=>{ log('ERROR (browser hides details)'); };
    ws.onclose = (e)=>{
      status.innerHTML='<span class="bad">CLOSED</span> code='+e.code; 
      setSend(false); 
      log('CLOSE code='+e.code+' reason="'+e.reason+'"');
      reconnectAttempts++; // CHANGE: Fix increment
      const delay = Math.min(20000, 5000 + reconnectAttempts * 3000);
      log('Reconnecting in '+delay+'ms');
      setTimeout(connect, delay);
    };
    ws.onmessage = (ev)=>{
      log('MESSAGE received length='+ev.data.length+' content='+ev.data.slice(0, 200)); // CHANGE: Log message content
      let m=null; try{ m = JSON.parse(ev.data); } catch { return log('TEXT '+String(ev.data).slice(0,200)); }

      if (m.type==='welcome'){ 
        log('WELCOME id='+m.clientId+' serverT='+m.serverTs); 
        // CHANGE: Send ready after welcome
        try {
          const id = Math.random().toString(36).slice(2);
          sent.set(id, performance.now());
          ws.send(JSON.stringify({ type:'ready', id, clientTs: Date.now() }));
          log('Client sent ready id='+id);
        } catch (e) { log('Client ready error: '+e.message); }
        return; 
      }
      if (m.type==='serverPing'){ log('serverPing '+m.serverTs); return; }
      if (m.type==='error'){ log('ERROR '+m.message); return; }

      if (m.type==='pong'){
        const t0 = sent.get(m.id);
        if (t0){ const dt = performance.now()-t0; rtts.push(dt); if (rtts.length>20) rtts.shift(); rttEl.textContent = mean(rtts).toFixed(1)+' ms'; sent.delete(m.id); }
        log('PONG id='+m.id+' serverT='+m.serverTs); return;
      }

      // File transfer
      if (m.type==='fileMeta'){
        resetRx();
        rx = {
          name: m.name || 'download.bin',
          size: Number(m.size)||0,
          mime: m.mime || 'application/octet-stream',
          totalChunks: Number(m.chunks)||0,
          chunkSize: Number(m.chunkSize)||0,
          offset: 0,
          gotChunks: 0,
          buf: new Uint8Array(Number(m.size)||0)
        };
        pdfInfo.textContent = `Receiving ${rx.name} (${rx.size} bytes) in ${rx.totalChunks} chunks...`;
        pdfProg.max = rx.size || 100;
        log('FILE META '+JSON.stringify(m));
        return;
      }
      if (m.type==='fileChunk' && rx){
        try {
          const bytes = b64ToBytes(m.data||'');
          if (bytes.length === 0) {
            log('FILE CHUNK empty or invalid');
            return;
          }
          rx.buf.set(bytes, rx.offset);
          rx.offset += bytes.length;
          rx.gotChunks++;
          if (rx.size) pdfProg.value = rx.offset;
          if ((rx.gotChunks % 16)===0 || rx.gotChunks===rx.totalChunks) {
            log(`FILE CHUNK ${rx.gotChunks}/${rx.totalChunks} (+${bytes.length}B)`);
          }
        } catch (e) {
          log('FILE CHUNK error: '+e.message);
        }
        return;
      }
      if (m.type==='fileEnd' && rx){
        log('FILE END ok='+(!!m.ok)+' total='+rx.offset+' bytes');
        try {
          const blob = new Blob([rx.buf], { type: rx.mime });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = rx.name;
          document.body.appendChild(a);
          a.click();
          setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 15000);
          pdfInfo.textContent = 'Downloaded: ' + rx.name + ' ('+rx.offset+' bytes)';
        } catch (e) {
          log('DOWNLOAD trigger failed: '+e.message);
          pdfInfo.textContent = 'Download failed: ' + e.message + ' — try /HelloWorld.exe';
        }
        rx = null;
        return;
      }

      if (m.type==='say'){ log('SAY '+JSON.stringify(m)); return; }
      log('MSG '+JSON.stringify(m));
    };
  }

  sendBtn.onclick = ()=>{
    if (!ws || ws.readyState !== ws.OPEN) { log('SEND blocked (socket not open)'); return; }
    const text = (input.value || 'ping').trim();
    if (text.toLowerCase()==='ping'){
      const id = Math.random().toString(36).slice(2);
      sent.set(id, performance.now());
      try { ws.send(JSON.stringify({ type:'ping', id, clientTs: Date.now() })); log('PING id='+id); }
      catch (e) { log('Send ping error: '+e.message); }
    } else {
      try { ws.send(JSON.stringify({ type:'say', text, clientTs: Date.now() })); log('SEND text='+text); }
      catch (e) { log('Send text error: '+e.message); }
    }
    input.value='';
  };

  reconnectBtn.onclick = ()=>{ try { if (ws) ws.close(); } catch{}; connect(); };
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
  <button id="copyLogs">Copy Logs</button>
</main>
<script>
  const out = document.getElementById('out');
  const copyLogsBtn = document.getElementById('copyLogs');
  const es = new EventSource('/logs');
  es.onmessage = (e) => { out.textContent += e.data + "\\n"; out.scrollTop = out.scrollHeight; };
  es.onerror = () => { out.textContent += new Date().toISOString() + " [SSE] error/closed\\n"; };
  copyLogsBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(out.textContent); out.textContent += new Date().toISOString() + " Logs copied\\n"; }
    catch (e) {
      const t=document.createElement('textarea'); t.value=out.textContent; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
      out.textContent += new Date().toISOString() + " Logs copied (fallback)\\n";
    }
    out.scrollTop = out.scrollHeight;
  };
</script>`);
});

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30');
  res.flushHeaders?.();
  const send = (line) => res.write(`data: ${line}\n\n`);
  const onLine = (line) => send(line);
  bus.on('line', onLine);
  send(`${new Date().toISOString()} - [SSE] connected from ${req.ip || req.socket.remoteAddress}`);
  const iv = setInterval(() => send(`${new Date().toISOString()} - [SSE] keepalive`), 10000);
  req.on('close', () => { clearInterval(iv); bus.off('line', onLine); });
});

// ─────────── HTTP server + WS on same port ───────────
const server = http.createServer(app);

// Diagnostics
server.on('clientError', (err, socket) => {
  log('HTTP clientError', err?.message || err);
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
server.on('upgrade', (req, socket, head) => {
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'} protocol=${req.headers['sec-websocket-protocol']||'(none)'} extensions=${req.headers['sec-websocket-extensions']||'(none)'}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

attachTunnelWSS(server);
attachEchoWSS(server);

server.listen(CONFIG.PORT, '0.0.0.0', async () => {
  await loadPdfBufferOnce();
  log(`web listening on :${CONFIG.PORT}`);
});

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
    maxPayload: 100 * 1024 * 1024
  });

  wss.on('headers', (headers, req) => {
    headers.push('Keep-Alive: timeout=30');
    log('HEADERS ws-tunnel', JSON.stringify(headers));
  });

  wss.on('connection', async (ws, req) => {
    const s = ws._socket;
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 2000); // CHANGE: Reduced to 2s
      log('TUNNEL socket options set: noDelay=true, keepAlive=2s');
    } catch (e) {
      log('TUNNEL socket options error', e?.message || e);
    }

    attachRawSocketLogs(ws, 'TUNNEL');

    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin || '(null)';
    const ua = req.headers['user-agent'] || '(ua?)';
    const clientId = Math.random().toString(36).slice(2);
    log(`TUNNEL connected ip=${ip} origin=${origin} ua="${ua}" id=${clientId}`);

    // CHANGE: Send welcome and ping
    try {
      log('TUNNEL socket state before send: readyState='+s.readyState);
      ws.send(JSON.stringify({ type: 'welcome', clientId, serverTs: Date.now() }));
      log('TUNNEL sent welcome');
      ws.send(JSON.stringify({ type: 'ping', id: 'server-init', serverTs: Date.now() }));
      log('TUNNEL sent initial ping');
    } catch (e) {
      log('TUNNEL initial send error', e?.message || e);
    }

    // CHANGE: Track client readiness
    let clientReady = false;

    // App heartbeat
    const appBeat = setInterval(() => {
      safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
      log('TUNNEL sent heartbeat ping');
    }, 2000); // CHANGE: 2s heartbeat

    // Handle messages
    ws.on('message', (data, isBinary) => {
      log(`TUNNEL message received isBinary=${isBinary} length=${data.length} content=${data.toString('utf8').slice(0, 200)}`);
      let m = null;
      try { m = JSON.parse(data.toString('utf8')); } catch {
        return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
      }
      if (m?.type === 'ping') {
        log('TUNNEL received client ping id='+m.id);
        return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
      }
      if (m?.type === 'ready') {
        clientReady = true;
        log('TUNNEL client ready id='+m.id);
        if (PDF_BUFFER && ws.readyState === ws.OPEN) {
          try { streamPdfOverWS(ws, PDF_BUFFER, CONFIG.PDF_NAME, CONFIG.CHUNK_SIZE); }
          catch (e) { safeSend(ws, { type:'error', message: 'PDF stream failed: '+(e?.message||e) }); }
        } else {
          safeSend(ws, { type:'error', message: 'No file configured on server. Upload to '+CONFIG.PDF_PATH+' or set PDF_PATH.' });
        }
        return;
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

// Send file as JSON-base64 chunks: fileMeta → fileChunk* → fileEnd
async function streamPdfOverWS(ws, buffer, name, chunkSize) {
  const size = buffer.length;
  const chunks = Math.ceil(size / chunkSize);
  safeSend(ws, { type:'fileMeta', name, mime:'application/vnd.microsoft.portable-executable', size, chunkSize, chunks });
  log('TUNNEL sent fileMeta');
  for (let i = 0; i < chunks; i++) {
    if (ws.readyState !== ws.OPEN) {
      log('TUNNEL stream aborted: socket closed');
      throw new Error('socket closed during stream');
    }
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = buffer.subarray(start, end);
    const b64 = slice.toString('base64');
    try {
      await new Promise((resolve, reject) => {
        ws.send(JSON.stringify({ type:'fileChunk', seq:i, data:b64 }), (err)=> err ? reject(err) : resolve());
      });
      if ((i % 16) === 0 || i === chunks-1) {
        log(`TUNNEL sent file chunk ${i+1}/${chunks} bytes=${slice.length}`);
      }
    } catch (e) {
      log('TUNNEL file chunk error: '+e.message);
      throw e;
    }
    // CHANGE: Add 100ms delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  safeSend(ws, { type:'fileEnd', name, ok:true });
  log('TUNNEL sent fileEnd');
}

function attachRawSocketLogs(ws, label) {
  const s = ws._socket;
  if (!s) return;
  try { s.setNoDelay(true); } catch {}
  s.on('close', (hadErr) => log(`${label} RAW close hadErr=${hadErr} socketState=${s.readyState}`));
  s.on('end', () => log(`${label} RAW end socketState=${s.readyState}`));
  s.on('error', (e) => log(`${label} RAW error`, e?.code || '', e?.message || e));
  s.on('timeout', () => log(`${label} RAW timeout`));
  s.on('data', (data) => log(`${label} RAW data length=${data.length} content=${data.toString('utf8').slice(0, 200)}`));
}

function safeSend(ws, obj) {
  try { 
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
      log('safeSend success: '+JSON.stringify(obj).slice(0, 200));
    }
  } catch (e) { 
    log('safeSend error', e?.message || e); 
  } 
}
