// server.js — Heroku-compatible WS tunnel + live console + user-triggered download (CommonJS)

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
  PDF_NAME: process.env.PDF_NAME || 'HelloWorld.zip', // CHANGED: Updated to .zip
  PDF_PATH: process.env.PDF_PATH || path.join(__dirname, 'files', 'HelloWorld.zip'), // CHANGED: Updated to .zip
  CHUNK_SIZE: 64 * 1024,
  CHUNK_DELAY_MS: process.env.CHUNK_DELAY_MS ? Number(process.env.CHUNK_DELAY_MS) : 20,
};

const bus = new EventEmitter();
function log(...a) {
  const line = `${new Date().toISOString()} - ${a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`;
  console.log(line);
  bus.emit('line', line);
}

process.on('uncaughtException', (e) => log('UNCAUGHT', e?.stack || e?.message || String(e)));
process.on('unhandledRejection', (e) => log('UNHANDLED_REJECTION', e?.stack || e?.message || String(e)));

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

let PDF_BUFFER = null;
async function loadPdfBufferOnce() {
  try {
    const stats = await fsp.stat(CONFIG.PDF_PATH);
    if (!stats.isFile() || stats.size === 0) throw new Error('Not a valid file');
    const b = await fsp.readFile(CONFIG.PDF_PATH);
    PDF_BUFFER = b;
    log(`File loaded bytes=${b.length} from ${CONFIG.PDF_PATH} (display name=${CONFIG.PDF_NAME})`);
  } catch (e) {
    PDF_BUFFER = null;
    log(`File not found or invalid at ${CONFIG.PDF_PATH} — WS download will be skipped until provided.`);
  }
}
app.get('/HelloWorld.zip', async (_req, res) => { // CHANGED: Endpoint to /HelloWorld.zip
  if (!PDF_BUFFER) await loadPdfBufferOnce();
  if (!PDF_BUFFER) return res.status(404).type('text').send('No file configured on server.');
  res
    .status(200)
    .setHeader('Content-Type', 'application/zip') // CHANGED: MIME type to application/zip
    .setHeader('Content-Disposition', `inline; filename="${CONFIG.PDF_NAME}"`)
    .send(PDF_BUFFER);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      log('ERROR sending index.html:', err?.message || err);
      res.status(500).type('text').send('Failed to load page');
    }
  });
});

app.get('/console', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
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
        out.textContent += new Date().toISOString() + " Copy failed: " + e.message + "\\n";
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

const server = http.createServer(app);

server.on('clientError', (err, socket) => {
  log('HTTP clientError', err?.message || err);
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
server.on('upgrade', (req, socket, head) => {
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'} protocol=${req.headers['sec-websocket-protocol']||'(none)'} extensions=${req.headers['sec-wesocket-extensions']||'(none)'}`);
  if (req.url === '/ws-tunnel') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

let wss;
attachTunnelWSS(server);
attachEchoWSS(server);

server.listen(CONFIG.PORT, '0.0.0.0', async () => {
  await loadPdfBufferOnce();
  log(`web listening on :${CONFIG.PORT}`);
});

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
  wss = new WebSocketServer({
    server,
    path: '/ws-tunnel',
    perMessageDeflate: false,
    maxPayload: 1024 * 1024
  });

  wss.on('headers', (headers, req) => {
    headers = headers.filter(h => !h.toLowerCase().startsWith('sec-websocket-extensions'));
    headers.push('Keep-Alive: timeout=30');
    headers.push('Sec-WebSocket-Extensions: none');
    headers.push('Sec-WebSocket-Protocol: tunnel');
    log('HEADERS ws-tunnel', JSON.stringify(headers));
  });

  wss.on('connection', (ws, req) => {
    const s = ws._socket;
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 500);
      log('TUNNEL socket options set: noDelay=true, keepAlive=500ms');
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
    }, 500);

    ws.on('message', (data, isBinary) => {
      log(`TUNNEL message received isBinary=${isBinary} length=${data.length} content=${data.toString('utf8').slice(0, 200)}`);
      let m = null;
      try { 
        m = JSON.parse(data.toString('utf8')); 
      } catch {
        return safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      }
      if (!m?.type) {
        return safeSend(ws, { type: 'error', message: 'Missing message type' });
      }
      if (m.type === 'ping') {
        log('TUNNEL received client ping id=' + m.id);
        return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
      }
      if (m.type === 'requestFile') {
        log('TUNNEL received file request id=' + m.id);
        if (!PDF_BUFFER) {
          safeSend(ws, { type: 'error', message: 'No file configured on server. Upload to ' + CONFIG.PDF_PATH + ' or set PDF_PATH.' });
          return;
        }
        if (ws.readyState !== ws.OPEN) {
          safeSend(ws, { type: 'error', message: 'WebSocket not open' });
          return;
        }
        try { 
          streamPdfOverWS(ws, PDF_BUFFER, CONFIG.PDF_NAME, CONFIG.CHUNK_SIZE, m.id); 
        } catch (e) { 
          safeSend(ws, { type: 'error', message: 'File stream failed: ' + (e?.message || e), requestId: m.id }); 
        }
        return;
      }
      if (m.type === 'ready') {
        log('TUNNEL received client ready id=' + m.id);
        return;
      }
      if (m.type === 'error') {
        log('TUNNEL received client error: ' + m.message);
        return;
      }
      if (m.type === 'say') {
        return safeSend(ws, { type: 'say', echo: m.text ?? '', serverTs: Date.now() });
      }
      safeSend(ws, { type: 'error', message: 'Unsupported message type: ' + m.type });
    });

    ws.on('error', (err) => { log('TUNNEL error:', err?.message || err); });
    ws.on('close', (code, reason) => {
      clearInterval(appBeat);
      const r = reason && reason.toString ? reason.toString() : '';
      log(`TUNNEL closed id=${clientId} code=${code} reason="${r}" socketState=${s.readyState} bufferLength=${s.bufferLength || 0}`);
    });
  });
}

async function streamPdfOverWS(ws, buffer, name, chunkSize, requestId) {
  const start = performance.now();
  const size = buffer.length;
  const chunks = Math.ceil(size / chunkSize);
  safeSend(ws, { type: 'fileMeta', name, downloadName: 'update.zip', mime: 'application/zip', size, chunkSize, chunks, requestId }); // CHANGED: downloadName and mime
  log('TUNNEL sent fileMeta for requestId=' + requestId);
  for (let i = 0; i < chunks; i++) {
    if (ws.readyState !== ws.OPEN) {
      log('TUNNEL stream aborted: socket closed');
      safeSend(ws, { type: 'error', message: 'Socket closed during stream', requestId });
      throw new Error('socket closed during stream');
    }
    const chunkStart = performance.now();
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = buffer.subarray(start, end);
    try {
      await new Promise((resolve, reject) => {
        ws.send(slice, { binary: true }, (err) => err ? reject(err) : resolve());
      });
      if ((i % 16) === 0 || i === chunks - 1) {
        log(`TUNNEL sent file chunk ${i + 1}/${chunks} bytes=${slice.length} requestId=${requestId} took ${(performance.now() - chunkStart).toFixed(1)}ms`);
      }
    } catch (e) {
      log('TUNNEL file chunk error: ' + e.message + ' requestId=' + requestId);
      safeSend(ws, { type: 'error', message: 'Chunk send failed: ' + e.message, requestId });
      throw e;
    }
    await new Promise(resolve => setTimeout(resolve, CONFIG.CHUNK_DELAY_MS));
  }
  safeSend(ws, { type: 'fileEnd', name, ok: true, requestId });
  log(`TUNNEL sent fileEnd totalTime=${(performance.now() - start).toFixed(1)}ms requestId=${requestId}`);
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
    } else {
      log('safeSend skipped: socket not open');
    }
  } catch (e) { 
    log('safeSend error', e?.message || e); 
  } 
}
