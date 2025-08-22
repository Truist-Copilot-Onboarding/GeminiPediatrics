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
  MAX_LOG_LINES: 5000, // Increased for longer history
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

// Basic authentication middleware
function basicAuth(req, res, next) {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    log(`AUTH failed: No authorization header from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
    return res.status(401).type('text').send('Authentication required');
  }
  const auth = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString().split(':');
  const username = auth[0];
  const password = auth[1];
  if (username === 'womprats' && password === 'womprats') {
    log(`AUTH success: User womprats authenticated from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    return next();
  }
  log(`AUTH failed: Invalid credentials from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
  return res.status(401).type('text').send('Invalid credentials');
}

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => { 
  res.setHeader('X-Content-Type-Options', 'nosniff'); 
  next(); 
});

// Health
app.get('/healthz', (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  log(`HEALTH check from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  res.type('text').send('ok');
});

// List files in files directory
app.get('/files', async (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  log(`FILES request from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  try {
    const files = await fsp.readdir(CONFIG.FILES_DIR);
    const fileDetails = await Promise.all(files.map(async (file) => {
      const stats = await fsp.stat(path.join(CONFIG.FILES_DIR, file));
      if (stats.size > 0) {
        return { name: file, size: stats.size, mime: getMimeType(file) };
      }
      return null;
    }));
    res.status(200).json(fileDetails.filter(f => f));
  } catch (e) {
    log(`ERROR listing files from ip=${ip} ua="${ua}" referrer="${referrer}":`, e?.message || e);
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
    let isValidZip = false;
    try {
      const zip = new AdmZip(buffer);
      zip.getEntries(); // Test if valid ZIP
      isValidZip = true;
    } catch (e) {
      log(`File ${fileName} is not a valid ZIP: ${e.message}`);
    }
    FILE_CACHE.set(fileName, { buffer, hash, isValidZip });
    log(`File loaded bytes=${buffer.length} hash=${hash} isValidZip=${isValidZip} from ${filePath} (name=${fileName}, mime=${getMimeType(fileName)})`);
    return { buffer, hash, isValidZip };
  } catch (e) {
    log(`File not found at ${filePath}: ${e.message}`);
    return null;
  }
}
app.get('/files/:fileName', async (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  const fileName = sanitizeFileName(req.params.fileName);
  log(`FILE download request for ${fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
  if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
    log(`Invalid file path: ${filePath} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    return res.status(403).type('text').send('Invalid file path.');
  }
  let file = FILE_CACHE.get(fileName);
  if (!file) file = await loadFileBuffer(fileName);
  if (!file) return res.status(404).type('text').send('File not found.');
  let finalBuffer = file.buffer;
  let finalMime = getMimeType(fileName);
  if (!file.isValidZip && finalMime !== 'application/zip') {
    log(`Wrapping non-ZIP file ${fileName} in ZIP for direct download from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    const zip = new AdmZip();
    zip.addFile(fileName, file.buffer);
    finalBuffer = zip.toBuffer();
    finalMime = 'application/zip';
  }
  res
    .status(200)
    .setHeader('Content-Type', finalMime)
    .setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    .send(finalBuffer);
});

// Delete file
app.delete('/files/:fileName', async (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  const fileName = sanitizeFileName(req.params.fileName);
  log(`DELETE request for ${fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
  if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
    log(`Invalid delete path: ${filePath} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    return res.status(403).type('text').send('Invalid file path.');
  }
  try {
    await fsp.unlink(filePath);
    FILE_CACHE.delete(fileName);
    log(`File deleted: ${fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    res.status(200).type('text').send('File deleted.');
  } catch (e) {
    log(`ERROR deleting file ${fileName} from ip=${ip} ua="${ua}" referrer="${referrer}":`, e?.message || e);
    res.status(404).type('text').send('File not found or cannot be deleted.');
  }
});

// Root tester (client interface) with basic auth
app.get('/', basicAuth, (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  log(`ROOT request from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      log(`ERROR sending index.html from ip=${ip} ua="${ua}" referrer="${referrer}":`, err?.message || err);
      res.status(500).type('text').send('Failed to load page');
    }
  });
});

// Console (SSE) with basic auth
app.get('/console', basicAuth, (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  log(`CONSOLE request from ip=${ip} ua="${ua}" referrer="${referrer}"`);
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
    input, select, button { padding: 0.5rem; border: 1px solid #ccc; border-radius: 5px; background: #fff; color: #000; }
    @media (prefers-color-scheme: dark) {
      input, select, button { background: #444; color: #fff; }
    }
    select { width: 200px; }
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
      <button id="downloadLogs">Download Logs</button>
      <button id="pauseLogs">Pause Logs</button>
      <input id="searchLogs" placeholder="Search logs..."/>
      <select id="logFilter">
        <option value="all">All Logs</option>
        <option value="ping">Ping</option>
        <option value="pong">Pong</option>
        <option value="file-transfers">File Transfers</option>
        <option value="errors">Errors</option>
        <option value="connections">Connection Events</option>
        <option value="messages">Messages</option>
      </select>
    </div>
    <pre id="out"></pre>
  </main>
  <script>
    (function() {
      const out = document.getElementById('out');
      const copyLogsBtn = document.getElementById('copyLogs');
      const downloadLogsBtn = document.getElementById('downloadLogs');
      const pauseLogsBtn = document.getElementById('pauseLogs');
      const searchLogs = document.getElementById('searchLogs');
      const logFilter = document.getElementById('logFilter');
      let logLines = [], isPaused = false;
      const debounce = (fn, delay) => {
        let timeout;
        return (...args) => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => {
            fn(...args);
            timeout = null;
          }, delay);
        };
      };
      const log = (m) => {
        const s = new Date().toISOString() + ' [CONSOLE] ' + m;
        console.log(s);
        logLines.push(s);
        if (logLines.length > 5000) logLines.shift();
        updateLogDisplay();
      };
      const updateLogDisplay = debounce(() => {
        if (isPaused) return;
        const searchTerm = searchLogs.value.toLowerCase();
        const selectedFilter = logFilter.value;
        const filteredLogs = logLines.filter(line => {
          const isPing = line.includes('PING');
          const isPong = line.includes('PONG');
          const isFileTransfer = line.includes('FILE CHUNK') || line.includes('FILE META') || line.includes('FILE END') || 
                                line.includes('UPLOAD COMPLETE') || line.includes('DELETE COMPLETE') || line.includes('Unzip file error');
          const isError = line.includes('ERROR') || line.includes('failed') || line.includes('mismatch');
          const isConnection = line.includes('OPEN') || line.includes('CLOSE') || line.includes('ERROR') || line.includes('WELCOME');
          const isMessage = line.includes('SAY') || line.includes('MSG');
          if (selectedFilter === 'all') return searchTerm ? line.toLowerCase().includes(searchTerm) : true;
          if (selectedFilter === 'ping') return isPing && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          if (selectedFilter === 'pong') return isPong && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          if (selectedFilter === 'file-transfers') return isFileTransfer && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          if (selectedFilter === 'errors') return isError && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          if (selectedFilter === 'connections') return isConnection && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          if (selectedFilter === 'messages') return isMessage && (searchTerm ? line.toLowerCase().includes(searchTerm) : true);
          return true;
        });
        out.textContent = filteredLogs.join('\n');
        out.scrollTop = out.scrollHeight;
      }, 100);
      copyLogsBtn.onclick = async () => {
        try { 
          await navigator.clipboard.writeText(out.textContent); 
          log('Logs copied to clipboard'); 
        } catch (e) {
          log('Copy failed: ' + e.message);
          const t = document.createElement('textarea'); 
          t.value = out.textContent; 
          document.body.appendChild(t); 
          t.select(); 
          document.execCommand('copy'); 
          t.remove();
          log('Logs copied using fallback');
        }
      };
      downloadLogsBtn.onclick = () => {
        try {
          const blob = new Blob([logLines.join('\n')], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `console_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
          log('Logs downloaded as file');
        } catch (e) {
          log('Download logs failed: ' + e.message);
        }
      };
      pauseLogsBtn.onclick = () => {
        isPaused = !isPaused;
        pauseLogsBtn.textContent = isPaused ? 'Resume Logs' : 'Pause Logs';
        if (!isPaused) updateLogDisplay();
        log(isPaused ? 'Logs paused' : 'Logs resumed');
      };
      searchLogs.oninput = () => {
        log('Search logs: ' + searchLogs.value);
        updateLogDisplay();
      };
      logFilter.onchange = () => {
        log('Log filter changed to: ' + logFilter.value);
        updateLogDisplay();
      };
      const es = new EventSource('/logs');
      es.onopen = () => log('SSE connection opened');
      es.onmessage = (e) => { 
        logLines.push(e.data); 
        if (logLines.length > 5000) logLines.shift();
        updateLogDisplay();
      };
      es.onerror = () => { 
        log('SSE connection error or closed');
        updateLogDisplay();
      };
    })();
  </script>
</body>
</html>
`);
});

app.get('/logs', (req, res) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  log(`LOGS SSE connected from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30');
  res.flushHeaders?.();
  const send = (line) => {
    try {
      res.write(`data: ${line}\n\n`);
    } catch (e) {
      log(`SSE send error from ip=${ip} ua="${ua}" referrer="${referrer}": ${e.message}`);
    }
  };
  const onLine = (line) => send(line);
  logLines.forEach(line => send(line));
  bus.on('line', onLine);
  send(`${new Date().toISOString()} - [SSE] connected from ip=${ip}`);
  const iv = setInterval(() => send(`${new Date().toISOString()} - [SSE] keepalive`), 10000);
  req.on('close', () => { 
    log(`LOGS SSE closed from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    clearInterval(iv); 
    bus.off('line', onLine); 
    res.end();
  });
});

// HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('headers', (headers, req) => {
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  headers = headers.filter(h => !h.toLowerCase().startsWith('sec-websocket-extensions'));
  headers.push('Sec-WebSocket-Extensions: none');
  log(`HEADERS ws-tunnel from ip=${ip} ua="${ua}" referrer="${referrer}"`, JSON.stringify(headers));
});

wss.on('connection', (ws, req) => {
  const s = ws._socket;
  const ip = req.ip === '::1' ? '127.0.0.1' : req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '(unknown)';
  const referrer = req.headers['referer'] || '(none)';
  try { 
    s.setNoDelay(true); 
    s.setKeepAlive(true, 500);
    log(`TUNNEL socket options set: noDelay=true, keepAlive=500ms from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  } catch (e) {
    log(`TUNNEL socket options error from ip=${ip} ua="${ua}" referrer="${referrer}"`, e?.message || e);
  }

  attachRawSocketLogs(ws, 'TUNNEL', ip, ua, referrer);

  const origin = req.headers.origin || '(null)';
  const clientId = Math.random().toString(36).slice(2);
  log(`TUNNEL connected ip=${ip} ua="${ua}" referrer="${referrer}" origin=${origin} id=${clientId}`);

  const transfers = new Map();

  try {
    log(`TUNNEL socket state before send: readyState=${s.readyState} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    ws.send(JSON.stringify({ type: 'welcome', clientId, serverTs: Date.now() }));
    log(`TUNNEL sent welcome to ip=${ip} ua="${ua}" referrer="${referrer}"`);
    ws.send(JSON.stringify({ type: 'ping', id: 'server-init', serverTs: Date.now() }));
    log(`TUNNEL sent initial ping to ip=${ip} ua="${ua}" referrer="${referrer}"`);
  } catch (e) {
    log(`TUNNEL initial send error to ip=${ip} ua="${ua}" referrer="${referrer}"`, e?.message || e);
  }

  const appBeat = setInterval(() => {
    safeSend(ws, { type: 'serverPing', serverTs: Date.now() });
    log(`TUNNEL sent heartbeat ping to ip=${ip} ua="${ua}" referrer="${referrer}"`);
  }, 2000);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      log(`TUNNEL received unexpected binary data from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return safeSend(ws, { type: 'error', message: 'Binary data not supported' });
    }
    log(`TUNNEL message received length=${data.length} content=${data.toString('utf8').slice(0, 200)} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    let m = null;
    try { 
      m = JSON.parse(data.toString('utf8')); 
    } catch {
      return safeSend(ws, { type: 'say', text: String(data).slice(0, 200), serverTs: Date.now() });
    }
    if (m.type === 'ping') {
      log(`TUNNEL received client ping id=${m.id} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return safeSend(ws, { type: 'pong', id: m.id || null, clientTs: m.clientTs || null, serverTs: Date.now() });
    }
    if (m.type === 'requestFile') {
      log(`TUNNEL received file request id=${m.id} file=${m.fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      const fileName = sanitizeFileName(m.fileName);
      const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
      if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid file path: ${filePath} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      let file = FILE_CACHE.get(fileName);
      if (!file) file = await loadFileBuffer(fileName);
      if (!file) {
        return safeSend(ws, { type: 'error', message: `File ${fileName} not found on server.` });
      }
      transfers.set(m.id, { type: 'download', id: m.id, fileName, originalName: fileName, size: file.buffer.length, chunks: Math.ceil(file.buffer.length / CONFIG.CHUNK_SIZE), chunkSize: CONFIG.CHUNK_SIZE, hash: file.hash, ready: false });
      try { 
        await streamFileOverWS(ws, file.buffer, fileName, CONFIG.CHUNK_SIZE, m.id, file.hash, fileName, ip, transfers, file.isValidZip, ua, referrer); 
      } catch (e) { 
        safeSend(ws, { type: 'error', message: 'File stream failed: ' + (e?.message || e) }); 
        transfers.delete(m.id);
      }
      return;
    }
    if (m.type === 'ready') {
      log(`TUNNEL received ready id=${m.id} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      const transfer = transfers.get(m.id);
      if (!transfer || transfer.type !== 'download') {
        return safeSend(ws, { type: 'error', message: 'No active download for ID ' + m.id });
      }
      transfer.ready = true;
      return;
    }
    if (m.type === 'uploadFileMeta') {
      log(`TUNNEL received upload file meta id=${m.id} file=${m.fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      if (m.size > CONFIG.MAX_FILE_SIZE) {
        return safeSend(ws, { type: 'error', message: 'File too large (max 10MB)' });
      }
      let fileName = sanitizeFileName(m.fileName);
      let finalFileName = fileName;
      let counter = 1;
      while (fs.existsSync(path.join(CONFIG.FILES_DIR, finalFileName))) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        finalFileName = `${base}_${counter}${ext}`;
        counter++;
      }
      const finalFilePath = path.join(CONFIG.FILES_DIR, finalFileName);
      if (!finalFilePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid upload path: ${finalFilePath} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      transfers.set(m.id, { type: 'upload', id: m.id, fileName: finalFileName, filePath: finalFilePath, originalName: m.originalName || finalFileName.replace(/\.zip$/, ''), size: Number(m.size) || 0, totalChunks: Number(m.totalChunks) || 0, chunks: [], receivedBytes: 0, mime: 'application/zip' });
      safeSend(ws, { type: 'readyForUpload', id: m.id, fileName: finalFileName });
      log(`TUNNEL ready for upload id=${m.id} file=${finalFileName} size=${m.size} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return;
    }
    if (m.type === 'uploadFile') {
      log(`TUNNEL received upload file chunk id=${m.id} seq=${m.seq} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      const transfer = transfers.get(m.id);
      if (!transfer || transfer.type !== 'upload') {
        return safeSend(ws, { type: 'error', message: 'No active upload for ID ' + m.id });
      }
      await handleFileUpload(ws, m, transfer, ip, ua, referrer);
      return;
    }
    if (m.type === 'deleteFile') {
      log(`TUNNEL received delete file request id=${m.id} file=${m.fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      if (!m.fileName || !m.id) {
        return safeSend(ws, { type: 'error', message: 'Missing file name or ID' });
      }
      const fileName = sanitizeFileName(m.fileName);
      const filePath = path.resolve(CONFIG.FILES_DIR, fileName);
      if (!filePath.startsWith(path.resolve(CONFIG.FILES_DIR))) {
        log(`Invalid delete path: ${filePath} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'Invalid file path.' });
      }
      try {
        await fsp.unlink(filePath);
        FILE_CACHE.delete(fileName);
        safeSend(ws, { type: 'deleteComplete', id: m.id, fileName });
        log(`TUNNEL deleted file: ${fileName} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      } catch (e) {
        log(`TUNNEL delete error from ip=${ip} ua="${ua}" referrer="${referrer}": ${e?.message || e}`);
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
    log(`TUNNEL error from ip=${ip} ua="${ua}" referrer="${referrer}":`, err?.message || err); 
    transfers.clear();
  });
  ws.on('close', (code, reason) => {
    clearInterval(appBeat);
    const r = reason && reason.toString ? reason.toString() : '';
    log(`TUNNEL closed id=${clientId} code=${code} reason="${r}" socketState=${s.readyState} bufferLength=${s.bufferLength || 0} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    transfers.clear();
  });
});

function attachRawSocketLogs(ws, label, ip, ua, referrer) {
  const s = ws._socket;
  if (!s) return;
  try { s.setNoDelay(true); } catch {}
  s.on('close', (hadErr) => log(`${label} RAW close hadErr=${hadErr} socketState=${s.readyState} from ip=${ip} ua="${ua}" referrer="${referrer}"`));
  s.on('end', () => log(`${label} RAW end socketState=${s.readyState} from ip=${ip} ua="${ua}" referrer="${referrer}"`));
  s.on('error', (e) => log(`${label} RAW error from ip=${ip} ua="${ua}" referrer="${referrer}"`, e?.code || '', e?.message || e));
  s.on('timeout', () => log(`${label} RAW timeout from ip=${ip} ua="${ua}" referrer="${referrer}"`));
  s.on('data', (data) => log(`${label} RAW data length=${data.length} content=${data.toString('utf8').slice(0, 200)} from ip=${ip} ua="${ua}" referrer="${referrer}"`));
}

async function streamFileOverWS(ws, buffer, name, chunkSize, id, hash, originalName, ip, transfers, isValidZip, ua, referrer) {
  const start = performance.now();
  let finalBuffer = buffer;
  let finalHash = hash;
  let finalMime = getMimeType(name);

  if (!isValidZip && finalMime !== 'application/zip') {
    log(`Wrapping non-ZIP file ${name} in ZIP for WebSocket transfer from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    const zip = new AdmZip();
    zip.addFile(originalName, buffer);
    finalBuffer = zip.toBuffer();
    finalHash = crypto.createHash('sha256').update(finalBuffer).digest('hex');
    finalMime = 'application/zip';
  }

  const size = finalBuffer.length;
  const chunks = Math.ceil(size / chunkSize);
  log(`Starting stream for ${name} id=${id} size=${size} mime=${finalMime} chunks=${chunks} hash=${finalHash} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  safeSend(ws, { type: 'fileMeta', id, name, originalName, mime: finalMime, size, chunkSize, chunks, hash: finalHash });
  log(`TUNNEL sent fileMeta from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  const transfer = transfers.get(id);
  if (!transfer) {
    log(`TUNNEL stream error: No transfer found for id=${id} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    throw new Error('Transfer not found for ID ' + id);
  }
  let i = 0;
  while (i < chunks) {
    if (ws.readyState !== ws.OPEN) {
      log(`TUNNEL stream aborted: socket closed from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      throw new Error('socket closed during stream');
    }
    if (!transfer.ready) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const chunkStart = performance.now();
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = finalBuffer.subarray(start, end);
    const b64 = slice.toString('base64');
    const chunkHash = crypto.createHash('sha256').update(slice).digest('hex');
    try {
      await new Promise((resolve, reject) => {
        ws.send(JSON.stringify({ type: 'fileChunk', id, seq: i, data: b64, hash: chunkHash }), (err) => err ? reject(err) : resolve());
      });
      log(`TUNNEL sent file chunk ${i + 1}/${chunks} bytes=${slice.length} hash=${chunkHash} took ${(performance.now() - chunkStart).toFixed(1)}ms from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      i++;
    } catch (e) {
      log(`TUNNEL file chunk error from ip=${ip} ua="${ua}" referrer="${referrer}": ` + e.message);
      throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  safeSend(ws, { type: 'fileEnd', id, name, ok: true });
  log(`TUNNEL sent fileEnd id=${id} totalTime=${(performance.now() - start).toFixed(1)}ms from ip=${ip} ua="${ua}" referrer="${referrer}"`);
  transfers.delete(id);
}

async function handleFileUpload(ws, m, transfer, ip, ua, referrer) {
  try {
    if (m.seq !== transfer.chunks.length) {
      log(`TUNNEL upload chunk out of order id=${transfer.id} seq=${m.seq}, expected=${transfer.chunks.length} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return safeSend(ws, { type: 'error', message: `Out of order chunk: expected ${transfer.chunks.length}, got ${m.seq}` });
    }
    const bytes = Buffer.from(m.data, 'base64');
    if (bytes.length === 0) {
      log(`TUNNEL upload chunk empty id=${transfer.id} seq=${m.seq} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return safeSend(ws, { type: 'error', message: 'Empty chunk received' });
    }
    const chunkHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (chunkHash !== m.hash) {
      log(`TUNNEL upload chunk hash mismatch id=${transfer.id} seq=${m.seq} expected=${m.hash}, got=${chunkHash} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      return safeSend(ws, { type: 'error', message: 'Chunk hash mismatch' });
    }
    transfer.chunks[m.seq] = bytes;
    transfer.receivedBytes += bytes.length;
    log(`TUNNEL upload chunk id=${transfer.id} seq=${m.seq}/${transfer.totalChunks} bytes=${bytes.length} hash=${chunkHash} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    if (m.seq === transfer.totalChunks - 1) {
      if (transfer.receivedBytes !== transfer.size) {
        log(`TUNNEL upload failed id=${transfer.id} size mismatch: expected ${transfer.size}, got ${transfer.receivedBytes} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'Size mismatch' });
      }
      const buffer = Buffer.concat(transfer.chunks.filter(chunk => chunk));
      const finalHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (finalHash !== m.hash) {
        log(`TUNNEL upload final hash mismatch id=${transfer.id} expected=${m.hash}, got=${finalHash} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'Final hash mismatch' });
      }
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const entry = entries.find(e => e.entryName === transfer.originalName);
      if (!entry) {
        log(`TUNNEL upload failed: file ${transfer.originalName} not found in zip from ip=${ip} ua="${ua}" referrer="${referrer}"`);
        return safeSend(ws, { type: 'error', message: 'File not found in zip' });
      }
      const filePath = transfer.filePath;
      await fsp.writeFile(filePath, buffer); // Store as zip
      FILE_CACHE.set(transfer.fileName, { buffer, hash: finalHash });
      safeSend(ws, { type: 'uploadComplete', id: transfer.id, fileName: transfer.fileName, size: transfer.receivedBytes, hash: finalHash });
      log(`TUNNEL upload complete id=${transfer.id} file=${transfer.fileName} bytes=${transfer.receivedBytes} hash=${finalHash} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      transfers.delete(transfer.id);
    }
  } catch (e) {
    log(`TUNNEL upload error id=${transfer.id} from ip=${ip} ua="${ua}" referrer="${referrer}": ${e?.message || e}`);
    safeSend(ws, { type: 'error', message: `Upload failed: ${e?.message || e}` });
    transfers.delete(transfer.id);
  }
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
    '.exe': 'application/octet-stream',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.png': 'image/png'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/^_+|_+$/g, '');
}

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  log(`Web listening on :${CONFIG.PORT}`);
});
