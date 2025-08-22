// server.js — Heroku-compatible WS tunnel + live console + user-triggered download/upload/delete (CommonJS)

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const CONFIG = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 80,
  APP_NAME: process.env.APP_NAME || 'ws-tunnel',
  FILES_DIR: process.env.FILES_DIR || path.join(__dirname, 'files'),
  CHUNK_SIZE: 64 * 1024,
  MAX_LOG_LINES: 100,
  MAX_FILE_SIZE: 10 * 1024 * 1024 // 10MB limit
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
app.get('/healthz', (req, res) => {
  log(`HEALTH check from ip=${req.ip || req.socket.remoteAddress}`);
  res.type('text').send('ok');
});

// List files in files directory
app.get('/files', async (req, res) => {
  log(`FILES request from ip=${req.ip || req.socket.remoteAddress}`);
  try {
    const files = await fsp.readdir(CONFIG.FILES_DIR);
    const fileDetails = await Promise.all(files.map(async (file) => {
      const stats = await fsp.stat(path.join(CONFIG.FILES_DIR, file));
      if (stats.size > 0) {
        return { name: file, size: stats.size, mime: 'application/zip' };
      }
      return null;
    }));
    res.status(200).json(fileDetails.filter(f => f));
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
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    FILE_CACHE.set(fileName, { buffer, hash });
    log(`File loaded bytes=${buffer.length} hash=${hash} from ${filePath} (name=${fileName}, mime=application/zip)`);
    return { buffer, hash };
  } catch (e) {
    log(`File not found at ${filePath}: ${e.message}`);
    return null;
  }
}
app.get('/files/:fileName', async (req, res) => {
  const fileName = sanitizeFileName(req.params.fileName);
  log(`FILE download request for ${fileName} from ip=${req.ip || req.socket.remoteAddress}`);
  const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
  if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
    log(`Invalid file path: ${filePath}`);
    return res.status(403).type('text').send('Invalid file path.');
  }
  let file = FILE_CACHE.get(fileName);
  if (!file) file = await loadFileBuffer(fileName);
  if (!file) return res.status(404).type('text').send('File not found.');
  res
    .status(200)
    .setHeader('Content-Type', 'application/zip')
    .setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    .send(file.buffer);
});

// Delete file
app.delete('/files/:fileName', async (req, res) => {
  const fileName = sanitizeFileName(req.params.fileName);
  log(`DELETE request for ${fileName} from ip=${req.ip || req.socket.remoteAddress}`);
  const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
  if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
    log(`Invalid delete path: ${filePath}`);
    return res.status(403).type('text').send('Invalid file path.');
  }
  try {
    await fsp.unlink(filePath);
    FILE_CACHE.delete(fileName);
    log(`File deleted: ${fileName}`);
    res.status(200).type('text').send('File deleted.');
  } catch (e) {
    log(`ERROR deleting file ${fileName}: ${e?.message || e}`);
    res.status(404).type('text').send('File not found or cannot be deleted.');
  }
});

// Root tester
app.get('/', (req, res) => {
  log(`ROOT request from ip=${req.ip || req.socket.remoteAddress}`);
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      log('ERROR sending index.html:', err?.message || err);
      res.status(500).type('text').send('Failed to load page');
    }
  });
});

// Console (SSE)
app.get('/console', (req, res) => {
  log(`CONSOLE request from ip=${req.ip || req.socket.remoteAddress}`);
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
    .log-controls { position: sticky; top: 0; background: #111; padding: 0.5rem 0; z-index: 10; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    input { padding: 0.5rem; border: 1px solid #ccc; border-radius: 5px; background: #fff; color: #000; }
    @media (prefers-color-scheme: dark) {
      input { background: #444; color: #fff; }
    }
    #searchLogs { max-width: 150px; }
  </style>
</head>
<body>
  <header>
    <strong>Server Console</strong> — live from /logs (SSE)
    <span style="opacity: 0.7"> | <a href="/" style="color: #9cf">tester</a></span>
  </header>
  <main>
    <div class="log-controls">
      <button id="copyLogs">Copy Logs</button>
      <input id="searchLogs" placeholder="Search logs..."/>
    </div>
    <pre id="out"></pre>
  </main>
  <script>
    const out = document.getElementById('out');
    const copyLogsBtn = document.getElementById('copyLogs');
    const searchLogs = document.getElementById('searchLogs');
    let logLines = [];
    const es = new EventSource('/logs');
    es.onmessage = (e) => { 
      logLines.push(e.data); 
      if (logLines.length > 100) logLines.shift();
      updateLogDisplay();
    };
    es.onerror = () => { 
      const line = new Date().toISOString() + " [SSE] error/closed";
      logLines.push(line); 
      updateLogDisplay();
    };
    function updateLogDisplay() {
      const searchTerm = searchLogs.value.toLowerCase();
      const filteredLogs = searchTerm ? logLines.filter(line => line.toLowerCase().includes(searchTerm)) : logLines;
      out.textContent = filteredLogs.join("\\n"); 
      out.scrollTop = out.scrollHeight;
    }
    copyLogsBtn.onclick = async () => {
      try { 
        await navigator.clipboard.writeText(out.textContent); 
        logLines.push(new Date().toISOString() + " Logs copied");
        updateLogDisplay();
      } catch (e) {
        logLines.push(new Date().toISOString() + " Copy failed: " + e.message);
        const t = document.createElement('textarea'); 
        t.value = out.textContent; 
        document.body.appendChild(t); 
        t.select(); 
        document.execCommand('copy'); 
        t.remove();
        logLines.push(new Date().toISOString() + " Logs copied (fallback)");
        updateLogDisplay();
      }
    };
    searchLogs.oninput = () => updateLogDisplay();
  </script>
</body>
</html>
`);
});

app.get('/logs', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  log(`LOGS SSE connected from ip=${ip}`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30');
  res.flushHeaders?.();
  const send = (line) => res.write(`data: ${line}\n\n`);
  const onLine = (line) => send(line);
  logLines.forEach(line => send(line));
  bus.on('line', onLine);
  send(`${new Date().toISOString()} - [SSE] connected from ip=${ip}`);
  const iv = setInterval(() => send(`${new Date().toISOString()} - [SSE] keepalive`), 10000);
  req.on('close', () => { 
    log(`LOGS SSE closed from ip=${ip}`);
    clearInterval(iv); 
    bus.off('line', onLine); 
  });
});

// HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('headers', (headers, req) => {
  const ip = req.ip || req.socket.remoteAddress;
  headers = headers.filter(h => !h.toLowerCase().startsWith('sec-websocket-extensions'));
  headers.push('Sec-WebSocket-Extensions: none');
  log(`HEADERS ws-tunnel from ip=${ip}`, JSON.stringify(headers));
});

wss.on('connection', (ws, req) => {
  const s = ws._socket;
  const ip = req.ip || req.socket.remoteAddress;
  try { 
    s.setNoDelay(true); 
    s.setKeepAlive(true, 500);
    log(`TUNNEL socket options set: noDelay=true, keepAlive=500ms from ip=${ip}`);
  } catch (e) {
    log(`TUNNEL socket options error from ip=${ip}`, e?.message || e);
  }

  attachRawSocketLogs(ws, 'TUNNEL', ip);

  const origin = req.headers.origin || '(null)';
  const ua = req.headers['user-agent'] || '(ua?)';
  const clientId = Math.random().toString(36).slice(2);
  log(`TUNNEL connected ip=${ip} origin=${origin} ua="${ua}" id=${clientId}`);

  const transfers = new Map();

  try {
    log(`TUNNEL socket state before send: readyState=${s.readyState} from ip=${ip}`);
    ws.send(JSON.stringify({ type: 'welcome', clientId, serverTs: Date.now() }));
    log(`TUNNEL sent welcome to ip=${ip}`);
    ws.send(JSON.stringify({ type: 'ping', id: 'server-init', serverTs: Date.now() }));
    log(`TUNNEL sent initial ping to ip=${ip}`);
  } catch (e) {
    log(`TUNNEL initial send error to ip=${ip}`, e?.message || e);
  }

  const appBeat = setInterval(() => {
    safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
    log(`TUNNEL sent heartbeat ping to ip=${ip}`);
  }, 2000);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      log(`TUNNEL received unexpected binary data from ip=${ip}`);
      return safeSend(ws, { type: 'error', message: 'Binary data not supported' });
    }
    log(`TUNNEL message received length=${data.length} content=${data.toString('utf8').slice(0, 200)} from ip=${ip}`);
    let m = null;
    try { 
      m = JSON.parse(data.toString('utf8')); 
    } catch {
      return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
    }
    if (m.type === 'ping') {
      log(`TUNNEL received client ping id=${m.id} from ip=${ip}`);
      return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
    }
    if (m.type === 'requestFile') {
      log(`TUNNEL received file request id=${m.id} file=${m.fileName} from ip=${ip}`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      const fileName = sanitizeFileName(m.fileName);
      const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
      if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid file path: ${filePath} from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      let file = FILE_CACHE.get(fileName);
      if (!file) file = await loadFileBuffer(fileName);
      if (!file) {
        return safeSend(ws, { type: 'error', message: `File ${fileName} not found on server.` });
      }
      transfers.set(m.id, { type: 'download', id: m.id, fileName, originalName: m.originalName || fileName.replace(/\.zip$/, ''), size: file.buffer.length, chunks: Math.ceil(file.buffer.length / CONFIG.CHUNK_SIZE), chunkSize: CONFIG.CHUNK_SIZE, hash: file.hash, ready: false });
      try { 
        await streamFileOverWS(ws, file.buffer, fileName, CONFIG.CHUNK_SIZE, m.id, file.hash, m.originalName || fileName.replace(/\.zip$/, ''), ip, transfers); 
      } catch (e) { 
        safeSend(ws, { type: 'error', message: 'File stream failed: ' + (e?.message || e) }); 
        transfers.delete(m.id);
      }
      return;
    }
    if (m.type === 'ready') {
      log(`TUNNEL received ready id=${m.id} from ip=${ip}`);
      const transfer = transfers.get(m.id);
      if (!transfer || transfer.type !== 'download') {
        return safeSend(ws, { type: 'error', message: 'No active download for ID ' + m.id });
      }
      transfer.ready = true;
      return;
    }
    if (m.type === 'uploadFileMeta') {
      log(`TUNNEL received upload file meta id=${m.id} file=${m.fileName} from ip=${ip}`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      if (m.size > CONFIG.MAX_FILE_SIZE) {
        return safeSend(ws, { type: 'error', message: 'File too large (max 10MB)' });
      }
      const fileName = sanitizeFileName(m.fileName);
      const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
      if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid upload path: ${filePath} from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      transfers.set(m.id, { type: 'upload', id: m.id, fileName, filePath, originalName: m.originalName || fileName.replace(/\.zip$/, ''), size: Number(m.size) || 0, totalChunks: Number(m.totalChunks) || 0, chunks: [], receivedBytes: 0, mime: 'application/zip' });
      safeSend(ws, { type: 'readyForUpload', id: m.id });
      log(`TUNNEL ready for upload id=${m.id} file=${fileName} size=${m.size} from ip=${ip}`);
      return;
    }
    if (m.type === 'uploadFile') {
      log(`TUNNEL received upload file chunk id=${m.id} seq=${m.seq} from ip=${ip}`);
      const transfer = transfers.get(m.id);
      if (!transfer || transfer.type !== 'upload') {
        return safeSend(ws, { type: 'error', message: 'No active upload for ID ' + m.id });
      }
      await handleFileUpload(ws, m, transfer, ip);
      return;
    }
    if (m.type === 'deleteFile') {
      log(`TUNNEL received delete file request id=${m.id} file=${m.fileName} from ip=${ip}`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      const fileName = sanitizeFileName(m.fileName);
      const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
      if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid delete path: ${filePath} from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      try {
        await fsp.unlink(filePath);
        FILE_CACHE.delete(fileName);
        safeSend(ws, { type: 'deleteComplete', id: m.id, fileName });
        log(`TUNNEL deleted file: ${fileName} from ip=${ip}`);
      } catch (e) {
        log(`TUNNEL delete error: ${e?.message || e} from ip=${ip}`);
        safeSend(ws, { type: 'error', message: `Delete failed: ${e?.message || e}` });
      }
      return;
    }
    if (m.type === 'say') {
      return safeSend(ws, { type: 'say', echo: m.text ?? '', serverTs: Date.now() });
    }
    safeSend(ws, { type: 'error', message: 'Unsupported message type' });
  });

  ws.on('error', (err) => { 
    log(`TUNNEL error from ip=${ip}:`, err?.message || err); 
    transfers.clear();
  });
  ws.on('close', (code, reason) => {
    clearInterval(appBeat);
    const r = reason && reason.toString ? reason.toString() : '';
    log(`TUNNEL closed id=${clientId} code=${code} reason="${r}" socketState=${s.readyState} bufferLength=${s.bufferLength || 0} from ip=${ip}`);
    transfers.clear();
  });
});

function attachRawSocketLogs(ws, label, ip) {
  const s = ws._socket;
  if (!s) return;
  try { s.setNoDelay(true); } catch {}
  s.on('close', (hadErr) => log(`${label} RAW close hadErr=${hadErr} socketState=${s.readyState} from ip=${ip}`));
  s.on('end', () => log(`${label} RAW end socketState=${s.readyState} from ip=${ip}`));
  s.on('error', (e) => log(`${label} RAW error from ip=${ip}`, e?.code || '', e?.message || e));
  s.on('timeout', () => log(`${label} RAW timeout from ip=${ip}`));
  s.on('data', (data) => log(`${label} RAW data length=${data.length} content=${data.toString('utf8').slice(0, 200)} from ip=${ip}`));
}

async function streamFileOverWS(ws, buffer, name, chunkSize, id, hash, originalName, ip, transfers) {
  const start = performance.now();
  const size = buffer.length;
  const chunks = Math.ceil(size / chunkSize);
  log(`Starting stream for ${name} id=${id} size=${size} mime=application/zip chunks=${chunks} hash=${hash} from ip=${ip}`);
  safeSend(ws, { type: 'fileMeta', id, name, originalName, mime: 'application/zip', size, chunkSize, chunks, hash });
  log(`TUNNEL sent fileMeta from ip=${ip}`);
  const transfer = transfers.get(id);
  if (!transfer) {
    log(`TUNNEL stream error: No transfer found for id=${id} from ip=${ip}`);
    throw new Error('Transfer not found for ID ' + id);
  }
  let i = 0;
  while (i < chunks) {
    if (ws.readyState !== ws.OPEN) {
      log(`TUNNEL stream aborted: socket closed from ip=${ip}`);
      throw new Error('socket closed during stream');
    }
    if (!transfer.ready) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const chunkStart = performance.now();
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = buffer.subarray(start, end);
    const b64 = slice.toString('base64');
    const chunkHash = crypto.createHash('sha256').update(slice).digest('hex');
    try {
      await new Promise((resolve, reject) => {
        ws.send(JSON.stringify({ type: 'fileChunk', id, seq: i, data: b64, hash: chunkHash }), (err) => err ? reject(err) : resolve());
      });
      log(`TUNNEL sent file chunk ${i + 1}/${chunks} bytes=${slice.length} hash=${chunkHash} took ${(performance.now() - chunkStart).toFixed(1)}ms from ip=${ip}`);
      i++;
    } catch (e) {
      log(`TUNNEL file chunk error from ip=${ip}: ` + e.message);
      throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  safeSend(ws, { type: 'fileEnd', id, name, ok: true });
  log(`TUNNEL sent fileEnd id=${id} totalTime=${(performance.now() - start).toFixed(1)}ms from ip=${ip}`);
  transfers.delete(id);
}

async function handleFileUpload(ws, m, transfer, ip) {
  try {
    if (m.seq !== transfer.chunks.length) {
      log(`TUNNEL upload chunk out of order id=${transfer.id} seq=${m.seq}, expected=${transfer.chunks.length} from ip=${ip}`);
      return safeSend(ws, { type: 'error', message: `Out of order chunk: expected ${transfer.chunks.length}, got ${m.seq}` });
    }
    const bytes = Buffer.from(m.data, 'base64');
    if (bytes.length === 0) {
      log(`TUNNEL upload chunk empty id=${transfer.id} seq=${m.seq} from ip=${ip}`);
      return safeSend(ws, { type: 'error', message: 'Empty chunk received' });
    }
    const chunkHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (chunkHash !== m.hash) {
      log(`TUNNEL upload chunk hash mismatch id=${transfer.id} seq=${m.seq} expected=${m.hash}, got=${chunkHash} from ip=${ip}`);
      return safeSend(ws, { type: 'error', message: 'Chunk hash mismatch' });
    }
    transfer.chunks[m.seq] = bytes;
    transfer.receivedBytes += bytes.length;
    log(`TUNNEL upload chunk id=${transfer.id} seq=${m.seq}/${transfer.totalChunks} bytes=${bytes.length} hash=${chunkHash} from ip=${ip}`);
    if (m.seq === transfer.totalChunks - 1) {
      if (transfer.receivedBytes !== transfer.size) {
        log(`TUNNEL upload failed id=${transfer.id} size mismatch: expected ${transfer.size}, got ${transfer.receivedBytes} from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'Size mismatch' });
      }
      const buffer = Buffer.concat(transfer.chunks.filter(chunk => chunk));
      const finalHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (finalHash !== m.hash) {
        log(`TUNNEL upload final hash mismatch id=${transfer.id} expected=${m.hash}, got=${finalHash} from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'Final hash mismatch' });
      }
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const entry = entries.find(e => e.entryName === transfer.originalName);
      if (!entry) {
        log(`TUNNEL upload failed: file ${transfer.originalName} not found in zip from ip=${ip}`);
        return safeSend(ws, { type: 'error', message: 'File not found in zip' });
      }
      const filePath = path.join(CONFIG.FILES_DIR, transfer.fileName);
      await fsp.writeFile(filePath, buffer); // Store as zip
      FILE_CACHE.set(transfer.fileName, { buffer, hash: finalHash });
      safeSend(ws, { type: 'uploadComplete', id: transfer.id, fileName: transfer.fileName, size: transfer.receivedBytes, hash: finalHash });
      log(`TUNNEL upload complete id=${transfer.id} file=${transfer.fileName} bytes=${transfer.receivedBytes} hash=${finalHash} from ip=${ip}`);
      transfers.delete(transfer.id);
    }
  } catch (e) {
    log(`TUNNEL upload error id=${transfer.id} from ip=${ip}: ${e?.message || e}`);
    safeSend(ws, { type: 'error', message: `Upload failed: ${e?.message || e}` });
    transfers.delete(transfer.id);
  }
}

function attachRawSocketLogs(ws, label, ip) {
  const s = ws._socket;
  if (!s) return;
  try { s.setNoDelay(true); } catch {}
  s.on('close', (hadErr) => log(`${label} RAW close hadErr=${hadErr} socketState=${s.readyState} from ip=${ip}`));
  s.on('end', () => log(`${label} RAW end socketState=${s.readyState} from ip=${ip}`));
  s.on('error', (e) => log(`${label} RAW error from ip=${ip}`, e?.code || '', e?.message || e));
  s.on('timeout', () => log(`${label} RAW timeout from ip=${ip}`));
  s.on('data', (data) => log(`${label} RAW data length=${data.length} content=${data.toString('utf8').slice(0, 200)} from ip=${ip}`));
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
  return 'application/zip'; // All files are zips
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/^_+|_+$/g, '');
}

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  log(`Web listening on :${CONFIG.PORT}`);
});
