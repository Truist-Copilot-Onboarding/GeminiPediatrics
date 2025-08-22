// server.js — Heroku-compatible WS tunnel + live console + user-triggered download/upload (CommonJS)

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 80,
  APP_NAME: process.env.APP_NAME || 'ws-tunnel',
  FILES_DIR: process.env.FILES_DIR || path.join(__dirname, 'files'),
  CHUNK_SIZE: 64 * 1024,
  MAX_LOG_LINES: 100 // Limit server logs
};

// Ensure files directory exists
if (!fs.existsSync(CONFIG.FILES_DIR)) {
  fs.mkdirSync(CONFIG.FILES_DIR, { recursive: true });
  log(`Created files directory at ${CONFIG.FILES_DIR}`);
}

// Central log bus → broadcasts to SSE clients
const bus = new EventEmitter();
const logLines = [];
function log(...a) {
  const line = `${new Date().toISOString()} - ${a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > CONFIG.MAX_LOG_LINES) logLines.shift();
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

// List files in files directory
app.get('/files', async (_req, res) => {
  try {
    const files = await fsp.readdir(CONFIG.FILES_DIR);
    const fileDetails = await Promise.all(files.map(async (file) => {
      const stats = await fsp.stat(path.join(CONFIG.FILES_DIR, file));
      return { name: file, size: stats.size, mime: getMimeType(file) };
    }));
    res.status(200).json(fileDetails);
  } catch (e) {
    log('ERROR listing files:', e?.message || e);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Direct file download
let FILE_CACHE = new Map();
async function loadFileBuffer(fileName) {
  const filePath = path.join(CONFIG.FILES_DIR, fileName);
  try {
    const buffer = await fsp.readFile(filePath);
    FILE_CACHE.set(fileName, buffer);
    log(`File loaded bytes=${buffer.length} from ${filePath} (name=${fileName})`);
    return buffer;
  } catch (e) {
    log(`File not found at ${filePath}`);
    return null;
  }
}
app.get('/files/:fileName', async (req, res) => {
  const fileName = req.params.fileName;
  let buffer = FILE_CACHE.get(fileName);
  if (!buffer) buffer = await loadFileBuffer(fileName);
  if (!buffer) return res.status(404).type('text').send('File not found.');
  res
    .status(200)
    .setHeader('Content-Type', getMimeType(fileName))
    .setHeader('Content-Disposition', `inline; filename="${fileName}"`)
    .send(buffer);
});

// Root tester
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      log('ERROR sending index.html:', err?.message || err);
      res.status(500).type('text').send('Failed to load page');
    }
  });
});

// Console (SSE)
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
  // Send recent logs to new connections
  logLines.forEach(line => send(line));
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
  log(`UPGRADE ${req.url} origin=${req.headers.origin||'(none)'} ua="${req.headers['user-agent']||'(ua?)'}" key=${req.headers['sec-websocket-key']||'(none)'} protocol=${req.headers['sec-wesocket-protocol']||'(none)'} extensions=${req.headers['sec-websocket-extensions']||'(none)'}`);
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
    }, 2000); // Increased to 2 seconds

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
      if (m?.type === 'requestFile') {
        log('TUNNEL received file request id=' + m.id + ' file=' + m.fileName);
        if (!m.fileName) {
          return safeSend(ws, { type: 'error', message: 'No file name provided.' });
        }
        const filePath = path.join(CONFIG.FILES_DIR, m.fileName);
        let buffer = FILE_CACHE.get(m.fileName);
        if (!buffer) buffer = loadFileBuffer(m.fileName);
        if (!buffer) {
          return safeSend(ws, { type: 'error', message: `File ${m.fileName} not found on server.` });
        }
        try { 
          streamFileOverWS(ws, buffer, m.fileName, CONFIG.CHUNK_SIZE); 
        } catch (e) { 
          safeSend(ws, { type: 'error', message: 'File stream failed: ' + (e?.message || e) }); 
        }
        return;
      }
      if (m?.type === 'uploadFile') {
        log('TUNNEL received upload file chunk id=' + m.id + ' seq=' + m.seq);
        handleFileUpload(ws, m, clientId);
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

async function streamFileOverWS(ws, buffer, name, chunkSize) {
  const start = performance.now();
  const size = buffer.length;
  const chunks = Math.ceil(size / chunkSize);
  safeSend(ws, { type: 'fileMeta', name, mime: getMimeType(name), size, chunkSize, chunks });
  log('TUNNEL sent fileMeta');
  for (let i = 0; i < chunks; i++) {
    if (ws.readyState !== ws.OPEN) {
      log('TUNNEL stream aborted: socket closed');
      throw new Error('socket closed during stream');
    }
    const chunkStart = performance.now();
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = buffer.subarray(start, end);
    const b64 = slice.toString('base64');
    try {
      await new Promise((resolve, reject) => {
        ws.send(JSON.stringify({ type: 'fileChunk', seq: i, data: b64 }), (err) => err ? reject(err) : resolve());
      });
      if ((i % 16) === 0 || i === chunks - 1) {
        log(`TUNNEL sent file chunk ${i + 1}/${chunks} bytes=${slice.length} took ${(performance.now() - chunkStart).toFixed(1)}ms`);
      }
    } catch (e) {
      log('TUNNEL file chunk error: ' + e.message);
      throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  safeSend(ws, { type: 'fileEnd', name, ok: true });
  log(`TUNNEL sent fileEnd totalTime=${(performance.now() - start).toFixed(1)}ms`);
}

const uploadStreams = new Map();
async function handleFileUpload(ws, m, clientId) {
  const { id, fileName, seq, data, totalChunks, size, mime } = m;
  if (!fileName || !id) {
    return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
  }
  const filePath = path.join(CONFIG.FILES_DIR, sanitizeFileName(fileName));
  let stream = uploadStreams.get(id);
  if (!stream) {
    if (seq !== 0) {
      return safeSend(ws, { type: 'error', message: 'Upload must start with seq=0' });
    }
    stream = { fileName, size: Number(size) || 0, totalChunks: Number(totalChunks) || 0, chunks: [], ws, clientId };
    uploadStreams.set(id, stream);
    log(`TUNNEL upload started id=${id} file=${fileName} size=${size}`);
  }
  try {
    const bytes = Buffer.from(data, 'base64');
    stream.chunks[seq] = bytes;
    log(`TUNNEL upload chunk id=${id} seq=${seq}/${stream.totalChunks} bytes=${bytes.length}`);
    if (seq === stream.totalChunks - 1) {
      const totalBytes = stream.chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
      if (totalBytes !== stream.size) {
        log(`TUNNEL upload failed id=${id} size mismatch: expected ${stream.size}, got ${totalBytes}`);
        safeSend(ws, { type: 'error', message: 'Size mismatch' });
        uploadStreams.delete(id);
        return;
      }
      const buffer = Buffer.concat(stream.chunks);
      await fsp.writeFile(filePath, buffer);
      FILE_CACHE.set(fileName, buffer);
      safeSend(ws, { type: 'uploadComplete', id, fileName, size: totalBytes });
      log(`TUNNEL upload complete id=${id} file=${fileName} bytes=${totalBytes}`);
      uploadStreams.delete(id);
    }
  } catch (e) {
    log(`TUNNEL upload error id=${id}: ${e?.message || e}`);
    safeSend(ws, { type: 'error', message: `Upload failed: ${e?.message || e}` });
    uploadStreams.delete(id);
  }
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

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = {
    '.zip': 'application/zip',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.mp3': 'audio/mpeg'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/^_+|_+$/g, '');
}
