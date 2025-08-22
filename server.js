// server.js — Heroku-compatible WS tunnel + live console (CommonJS)

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
  CHUNK_SIZE: 1 * 1024, // CHANGE: Reduced to 1 KiB (for future re-enable)
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

// Root tester
app.get('/', (_req, res) => {
  // CHANGE: Minimal, clean template string
  res.type('html').send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WS Tunnel (Heroku)</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui; padding: 2rem; max-width: 960px; margin: auto; }
    .row { display: grid; grid-template-columns: 140px 1fr; gap: 0.5rem 1rem; align-items: center; }
    .card { border: 1px solid #ccc3; padding: 12px; border-radius: 8px; margin: 12px 0; }
    .ok { color: #0b7; } .bad { color: #b22; } .muted { opacity: 0.8; }
    pre { background: #111; color: #0f0; padding: 12px; border-radius: 8px; white-space: pre-wrap; max-height: 260px; overflow: auto; }
    input, button { font: inherit; padding: 0.45rem; }
    button:disabled { opacity: 0.5; }
    a { color: inherit; }
    progress { width: 100%; }
  </style>
</head>
<body>
  <h1>WebSocket Tunnel (Heroku)</h1>
  <p class="muted">
    Connects to <code>/ws-tunnel</code>. Echo at <code>/ws-echo</code>. Live logs at <a href="/console" target="_blank">/console</a>.<br>
    File download: <a href="/HelloWorld.exe" target="_blank">/HelloWorld.exe</a>.
  </p>
  <div class="row"><div>Endpoint</div><div><code id="ep"></code></div></div>
  <div class="row"><div>Status</div><div id="status">Connecting…</div></div>
  <div class="row"><div>RTT (avg)</div><div id="rtt">–</div></div>
  <div class="card">
    <div class="row"><div>Send</div>
      <div>
        <input id="msg" placeholder="Type text (or 'ping')"/>
        <button id="send" disabled>Send</button>
        <button id="reconnect">Reconnect</button>
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
      const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws-tunnel';
      document.getElementById('ep').textContent = url;
      const status = document.getElementById('status');
      const logEl = document.getElementById('log');
      const rttEl = document.getElementById('rtt');
      const sendBtn = document.getElementById('send');
      const reconnectBtn = document.getElementById('reconnect');
      const copyLogsBtn = document.getElementById('copyLogs');
      const input = document.getElementById('msg');
      const log = (m) => { 
        const s = new Date().toISOString() + ' ' + m; 
        console.log(s); 
        logEl.textContent += s + "\\n"; 
        logEl.scrollTop = logEl.scrollHeight; 
      };
      const setSend = (on) => sendBtn.disabled = !on;
      const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
      copyLogsBtn.onclick = async () => {
        try { 
          await navigator.clipboard.writeText(logEl.textContent); 
          log('Logs copied to clipboard'); 
        } catch (e) {
          log('Copy failed: ' + e.message);
          const t = document.createElement('textarea'); 
          t.value = logEl.textContent; 
          document.body.appendChild(t); 
          t.select(); 
          document.execCommand('copy'); 
          t.remove();
          log('Logs copied using fallback');
        }
      };
      let ws, sent = new Map(), rtts = [], reconnectAttempts = 0;
      function connect() {
        log('Attempting connection to ' + url + ' (attempt ' + (reconnectAttempts + 1) + ')');
        ws = new WebSocket(url);
        ws.onopen = () => { 
          status.innerHTML = '<span class="ok">OPEN</span>'; 
          log('OPEN ' + url); 
          setSend(true); 
          reconnectAttempts = 0;
          try {
            const id1 = Math.random().toString(36).slice(2);
            sent.set(id1, performance.now());
            ws.send(JSON.stringify({ type: 'ping', id: id1, clientTs: Date.now() }));
            log('Client sent initial ping id=' + id1);
            setTimeout(() => {
              if (ws.readyState === ws.OPEN) {
                const id2 = Math.random().toString(36).slice(2);
                sent.set(id2, performance.now());
                ws.send(JSON.stringify({ type: 'ping', id: id2, clientTs: Date.now() }));
                log('Client sent second ping id=' + id2);
              }
            }, 50);
          } catch (e) { 
            log('Client send error: ' + e.message); 
          }
          const heartbeat = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
              try {
                const id = Math.random().toString(36).slice(2);
                sent.set(id, performance.now());
                ws.send(JSON.stringify({ type: 'ping', id, clientTs: Date.now() }));
                log('Client heartbeat ping id=' + id);
              } catch (e) {
                log('Client heartbeat error: ' + e.message);
              }
            } else {
              clearInterval(heartbeat);
            }
          }, 1000); // CHANGE: 1s heartbeat
        };
        ws.onerror = () => { 
          log('ERROR (browser hides details)'); 
          status.innerHTML = '<span class="bad">ERROR</span> - Check logs or try <a href="/HelloWorld.exe">direct download</a>';
        };
        ws.onclose = (e) => {
          status.innerHTML = '<span class="bad">CLOSED</span> code=' + e.code; 
          setSend(false); 
          log('CLOSE code=' + e.code + ' reason="' + e.reason + '"');
          reconnectAttempts++;
          const delay = Math.min(20000, 5000 + reconnectAttempts * 3000);
          log('Reconnecting in ' + delay + 'ms');
          setTimeout(connect, delay);
        };
        ws.onmessage = (ev) => {
          log('MESSAGE received length=' + ev.data.length + ' content=' + ev.data.slice(0, 200));
          let m = null; 
          try { 
            m = JSON.parse(ev.data); 
          } catch { 
            return log('TEXT ' + String(ev.data).slice(0, 200)); 
          }
          if (m.type === 'welcome') { 
            log('WELCOME id=' + m.clientId + ' serverT=' + m.serverTs); 
            return; 
          }
          if (m.type === 'serverPing') { 
            log('serverPing ' + m.serverTs); 
            return; 
          }
          if (m.type === 'error') { 
            log('ERROR ' + m.message); 
            return; 
          }
          if (m.type === 'pong') {
            const t0 = sent.get(m.id);
            if (t0) { 
              const dt = performance.now() - t0; 
              rtts.push(dt); 
              if (rtts.length > 20) rtts.shift(); 
              rttEl.textContent = mean(rtts).toFixed(1) + ' ms'; 
              sent.delete(m.id); 
            }
            log('PONG id=' + m.id + ' serverT=' + m.serverTs); 
            return; 
          }
          if (m.type === 'say') { 
            log('SAY ' + JSON.stringify(m)); 
            return; 
          }
          log('MSG ' + JSON.stringify(m));
        };
      }
      sendBtn.onclick = () => {
        if (!ws || ws.readyState !== ws.OPEN) { 
          log('SEND blocked (socket not open)'); 
          return; 
        }
        const text = (input.value || 'ping').trim();
        if (text.toLowerCase() === 'ping') {
          const id = Math.random().toString(36).slice(2);
          sent.set(id, performance.now());
          try { 
            ws.send(JSON.stringify({ type: 'ping', id, clientTs: Date.now() })); 
            log('PING id=' + id); 
          } catch (e) { 
            log('Send ping error: ' + e.message); 
          }
        } else {
          try { 
            ws.send(JSON.stringify({ type: 'say', text, clientTs: Date.now() })); 
            log('SEND text=' + text); 
          } catch (e) { 
            log('Send text error: ' + e.message); 
          }
        }
        input.value = '';
      };
      reconnectBtn.onclick = () => { 
        try { if (ws) ws.close(); } catch {} 
        connect(); 
      };
      connect();
    })();
  </script>
</body>
</html>
`);
});

// Console (SSE)
app.get('/console', (_req, res) => {
  res.type('html').send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WS Server Console</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 0; background: #0b0b0b; color: #c8facc; }
    header { padding: 10px 14px; background: #111; border-bottom: 1px solid #222; }
    main { padding: 10px 14px; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <header>
    <strong>Server Console</strong> — live from /logs (SSE)
    <span style="opacity: 0.7"> | <a href="/" style="color: #9cf">tester</a></span>
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
      try { 
        await navigator.clipboard.writeText(out.textContent); 
        out.textContent += new Date().toISOString() + " Logs copied\\n"; 
      } catch (e) {
        const t = document.createElement('textarea'); 
        t.value = out.textContent; 
        document.body.appendChild(t); 
        t.select(); 
        document.execCommand('copy'); 
        t.remove();
        out.textContent += new Date().toISOString() + " Logs copied (fallback)\\n";
      }
      out.scrollTop = out.scrollHeight;
    };
  </script>
</body>
</html>
`);
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

// HTTP server + WS on same port
const server = http.createServer(app);

// Diagnostics
server.on('clientError', (err, socket) => {
  log('HTTP clientError', err?.message || err);
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
server.on('upgrade', (req, socket, head) => {
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'} protocol=${req.headers['sec-websocket-protocol']||'(none)'} extensions=${req.headers['sec-wesocket-extensions']||'(none)'}`);
  // CHANGE: Custom upgrade handler
  if (req.url === '/ws-tunnel') {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\n' +
                 'Connection: Upgrade\r\n' +
                 `Sec-WebSocket-Accept: ${require('ws').createWebSocketStream({}).acceptKey(req.headers['sec-websocket-key'])}\r\n` +
                 'Sec-WebSocket-Protocol: tunnel\r\n' +
                 'Keep-Alive: timeout=30\r\n' +
                 '\r\n');
  }
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

// WS endpoints
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
    perMessageDeflate: false, // CHANGE: Explicitly disable compression
    maxPayload: 1024 * 1024 // CHANGE: Reduced to 1MB
  });

  wss.on('headers', (headers, req) => {
    headers.push('Keep-Alive: timeout=30');
    // CHANGE: Explicitly disable permessage-deflate
    headers.push('Sec-WebSocket-Extensions: none');
    log('HEADERS ws-tunnel', JSON.stringify(headers));
  });

  wss.on('connection', (ws, req) => {
    const s = ws._socket;
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 1000); // CHANGE: Reduced to 1s
      log('TUNNEL socket options set: noDelay=true, keepAlive=1s');
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
      log('TUNNEL socket state before send: readyState=' + s.readyState);
      ws.send(JSON.stringify({ type: 'welcome', clientId, serverTs: Date.now() }));
      log('TUNNEL sent welcome');
      ws.send(JSON.stringify({ type: 'ping', id: 'server-init', serverTs: Date.now() }));
      log('TUNNEL sent initial ping');
    } catch (e) {
      log('TUNNEL initial send error', e?.message || e);
    }

    const appBeat = setInterval(() => {
      safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
      log('TUNNEL sent heartbeat ping');
    }, 1000); // CHANGE: 1s heartbeat

    ws.on('message', (data, isBinary) => {
      log(`TUNNEL message received isBinary=${isBinary} length=${data.length} content=${data.toString('utf8').slice(0, 200)}`);
      let m = null;
      try { 
        m = JSON.parse(data.toString('utf8')); 
      } catch {
        return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
      }
      if (m?.type === 'ping') {
        log('TUNNEL received client ping id=' + m.id);
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
  s.on('data', (data) => log(`${label} RAW data length=${data.length} content=${data.toString('utf8').slice(0, 200)}`));
}

function safeSend(ws, obj) {
  try { 
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
      log('safeSend success: ' + JSON.stringify(obj).slice(0, 200));
    }
  } catch (e) { 
    log('safeSend error', e?.message || e); 
  } 
}
