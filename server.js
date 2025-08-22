  connectedClients.set(clientId, { ws, ip, clientId, connectedAt: Date.now(), userAgent: ua, referrer });
  log(`TUNNEL connected ip=${ip} ua="${ua}" referrer="${referrer}" origin=${origin} id=${clientId}`);

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
    if (m.type === 'listFiles') {
      log(`TUNNEL received file list request id=${m.id} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
      try {
        const files = await fsp.readdir(CONFIG.FILES_DIR);
        const fileDetails = await Promise.all(files.map(async (file) => {
          const stats = await fsp.stat(path.join(CONFIG.FILES_DIR, file));
          if (stats.size > 0) {
            return { name: file, size: stats.size, mime: getMimeType(file) };
          }
          return null;
        }));
        const filteredFiles = fileDetails.filter(f => f);
        safeSend(ws, { type: 'fileList', id: m.id, files: filteredFiles });
        log(`TUNNEL sent file list id=${m.id} files=${filteredFiles.map(f => f.name).join(', ')} to ip=${ip} ua="${ua}" referrer="${referrer}"`);
      } catch (e) {
        log(`ERROR listing files for id=${m.id} from ip=${ip} ua="${ua}" referrer="${referrer}":`, e?.message || e);
        safeSend(ws, { type: 'error', message: 'Failed to list files' });
      }
      return;
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
      await handleFileUpload(ws, m, transfer, ip, ua, referrer, transfers);
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
    connectedClients.delete(clientId);
  });
  ws.on('close', (code, reason) => {
    clearInterval(appBeat);
    const r = reason && reason.toString ? reason.toString() : '';
    log(`TUNNEL closed id=${clientId} code=${code} reason="${r}" socketState=${s.readyState} bufferLength=${s.bufferLength || 0} from ip=${ip} ua="${ua}" referrer="${referrer}"`);
    connectedClients.delete(clientId);
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

async function handleFileUpload(ws, m, transfer, ip, ua, referrer, transfers) {
  try {
    if (!transfers) {
      throw new Error('Transfers map is undefined');
    }
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
    if (transfers && transfers.has(transfer.id)) {
      transfers.delete(transfer.id);
    }
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
