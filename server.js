'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  probeVideo,
  detectHardwareEncoders,
  buildEncodingPlan,
  compressVideo
} = require('./compressor');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// In-memory stores
const uploadedFiles = new Map(); // fileId -> { id, originalName, tempPath, meta, createdAt, pendingDelete }
const jobs = new Map(); // jobId -> { ... }
const jobQueue = [];
let isProcessingQueue = false;
let isShuttingDown = false;
const sseClients = new Set();

function safeUnlink(filePath, retries = 3) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    if (retries > 0 && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      setTimeout(() => safeUnlink(filePath, retries - 1), 350);
    }
  }
}

function hasActiveJobsForFile(fileId) {
  for (const job of jobs.values()) {
    if (job.fileId === fileId && (job.status === 'queued' || job.status === 'running')) {
      return true;
    }
  }
  return false;
}

function tryCleanupPendingFile(fileId) {
  const fileInfo = uploadedFiles.get(fileId);
  if (!fileInfo || !fileInfo.pendingDelete) return;
  if (!hasActiveJobsForFile(fileId)) {
    safeUnlink(fileInfo.tempPath);
    uploadedFiles.delete(fileId);
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    fileId: job.fileId,
    originalName: job.originalName,
    options: job.options,
    status: job.status,
    percent: job.percent,
    stage: job.stage,
    message: job.message,
    speed: job.speed,
    etaSec: job.etaSec,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  };
}

function sanitizeFileName(name) {
  const base = path.basename(name || 'video.mp4');
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function makeUniqueOutputPath(baseName, suffix, ext) {
  const parsed = path.parse(sanitizeFileName(baseName));
  const cleanStem = (parsed.name || 'video').slice(0, 80);
  let candidate = path.join(OUTPUT_DIR, `${cleanStem}_${suffix}.${ext}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(OUTPUT_DIR, `${cleanStem}_${suffix}_${counter}.${ext}`);
    counter++;
  }
  return candidate;
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (jobQueue.length > 0 && !isShuttingDown) {
    const jobId = jobQueue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status === 'cancelled') continue;

    const fileInfo = uploadedFiles.get(job.fileId);
    if (!fileInfo || !fs.existsSync(fileInfo.tempPath)) {
      job.status = 'error';
      job.error = '元ファイルが見つかりません。もう一度動画を読み込んでください。';
      broadcast('job_update', serializeJob(job));
      continue;
    }

    job.status = 'running';
    job.percent = 0;
    job.etaSec = null;
    job.message = '変換を準備中...';
    broadcast('job_update', serializeJob(job));

    const hw = await detectHardwareEncoders();
    const previewPlan = buildEncodingPlan(fileInfo.meta, job.options, hw);
    const suffix = previewPlan.mode === 'target_size' && previewPlan.format !== 'gif'
      ? `${previewPlan.targetSizeMB}MB`
      : previewPlan.format === 'gif'
        ? 'gif'
        : `crf${previewPlan.crf}`;
    const outputPath = makeUniqueOutputPath(fileInfo.originalName, suffix, previewPlan.ext);

    try {
      const result = await compressVideo({
        inputPath: fileInfo.tempPath,
        outputPath,
        options: job.options,
        onProgress: (p) => {
          job.percent = typeof p.percent === 'number' ? p.percent : job.percent;
          job.stage = p.stage || job.stage;
          job.message = p.message || job.message;
          if (p.speed !== undefined) job.speed = p.speed;
          if (p.etaSec !== undefined) job.etaSec = p.etaSec;
          broadcast('job_update', serializeJob(job));
        },
        onCancelRegister: (fn) => {
          job.cancelFn = fn;
        }
      });

      job.status = 'done';
      job.percent = 100;
      job.etaSec = 0;
      job.message = '完了しました';
      job.completedAt = Date.now();
      job.result = {
        ...result,
        fileName: path.basename(outputPath),
        downloadUrl: `/api/output/${encodeURIComponent(path.basename(outputPath))}?download=1`,
        previewUrl: `/api/output/${encodeURIComponent(path.basename(outputPath))}`
      };
      broadcast('job_update', serializeJob(job));
    } catch (err) {
      safeUnlink(outputPath, 4);

      if (err.message === 'CANCELLED' || job.status === 'cancelled') {
        job.status = 'cancelled';
        job.message = 'キャンセルしました';
        job.etaSec = null;
      } else {
        job.status = 'error';
        job.error = err.message || '圧縮中にエラーが発生しました';
        job.message = 'エラーが発生しました';
        job.etaSec = null;
      }
      broadcast('job_update', serializeJob(job));
    } finally {
      job.cancelFn = null;
      tryCleanupPendingFile(job.fileId);
    }
  }

  isProcessingQueue = false;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  return map[ext] || 'application/octet-stream';
}

function pipeStreamSafely(stream, req, res) {
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Stream error');
    } else {
      res.destroy();
    }
  });
  req.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}

function serveMediaFile(req, res, filePath, forceDownload) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const mime = getMimeType(filePath);
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  };

  if (forceDownload) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }

  const range = req.headers.range;
  if (range && !forceDownload && stat.size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    let start;
    let end;
    if (match[1] === '' && match[2] !== '') {
      // Suffix byte range: bytes=-500
      const suffixLen = parseInt(match[2], 10);
      start = Math.max(0, stat.size - suffixLen);
      end = stat.size - 1;
    } else {
      start = match[1] ? parseInt(match[1], 10) : 0;
      end = match[2] ? Math.min(stat.size - 1, parseInt(match[2], 10)) : stat.size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    pipeStreamSafely(fs.createReadStream(filePath, { start, end }), req, res);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    pipeStreamSafely(fs.createReadStream(filePath), req, res);
  }
}

function shutdownServer(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      if (job.cancelFn) {
        try { job.cancelFn(); } catch {}
      }
    }
  }

  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();

  try { server.close(); } catch {}
  setTimeout(() => {
    cleanupTempDir();
    process.exit(exitCode);
  }, 450);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  try {
    // Health & capabilities
    if (req.method === 'GET' && pathname === '/api/info') {
      const hw = await detectHardwareEncoders();
      return sendJson(res, 200, {
        outputDir: OUTPUT_DIR,
        hw,
        jobs: Array.from(jobs.values()).map(serializeJob)
      });
    }

    // SSE stream
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`event: connected\ndata: {}\n\n`);
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // Raw binary streaming upload with abort cleanup
    if (req.method === 'POST' && pathname === '/api/upload') {
      const encodedName = req.headers['x-file-name'] || 'video.mp4';
      let originalName = 'video.mp4';
      try {
        originalName = decodeURIComponent(String(encodedName));
      } catch {
        originalName = String(encodedName);
      }
      originalName = sanitizeFileName(originalName);
      const ext = path.extname(originalName) || '.mp4';
      const fileId = crypto.randomBytes(8).toString('hex');
      const tempPath = path.join(TEMP_DIR, `${fileId}${ext}`);

      const writeStream = fs.createWriteStream(tempPath);
      let aborted = false;

      try {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            writeStream.destroy();
            reject(new Error('Upload aborted'));
          };
          req.on('aborted', onAbort);
          req.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', () => {
            req.off('aborted', onAbort);
            resolve();
          });
          req.pipe(writeStream);
        });
      } catch (uploadErr) {
        safeUnlink(tempPath, 3);
        if (aborted || res.destroyed) return;
        return sendJson(res, 400, { error: `アップロードに失敗しました: ${uploadErr.message}` });
      }

      try {
        const meta = await probeVideo(tempPath);
        const info = {
          id: fileId,
          originalName,
          tempPath,
          meta,
          createdAt: Date.now(),
          pendingDelete: false
        };
        uploadedFiles.set(fileId, info);
        return sendJson(res, 200, {
          fileId,
          originalName,
          meta
        });
      } catch (probeErr) {
        safeUnlink(tempPath, 3);
        return sendJson(res, 400, { error: `動画の解析に失敗しました: ${probeErr.message}` });
      }
    }

    // Batch plan preview for loaded files
    if (req.method === 'POST' && pathname === '/api/plan') {
      const body = await readJsonBody(req);
      const hw = await detectHardwareEncoders();
      if (Array.isArray(body.fileIds)) {
        const plans = {};
        for (const fid of body.fileIds) {
          const info = uploadedFiles.get(fid);
          if (info) {
            plans[fid] = buildEncodingPlan(info.meta, body.options || {}, hw);
          }
        }
        return sendJson(res, 200, { plans });
      }
      const fileInfo = uploadedFiles.get(body.fileId);
      if (!fileInfo) return sendJson(res, 404, { error: 'ファイルが見つかりません' });
      const plan = buildEncodingPlan(fileInfo.meta, body.options || {}, hw);
      return sendJson(res, 200, { plan });
    }

    // Start compression job
    if (req.method === 'POST' && pathname === '/api/compress') {
      const body = await readJsonBody(req);
      const fileInfo = uploadedFiles.get(body.fileId);
      if (!fileInfo || fileInfo.pendingDelete) {
        return sendJson(res, 404, { error: 'アップロード済みファイルが見つかりません' });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const job = {
        id: jobId,
        fileId: body.fileId,
        originalName: fileInfo.originalName,
        options: body.options || {},
        status: 'queued',
        percent: 0,
        stage: 'queued',
        message: '待機中...',
        speed: '',
        etaSec: null,
        result: null,
        error: null,
        cancelFn: null,
        createdAt: Date.now(),
        completedAt: null
      };
      jobs.set(jobId, job);
      jobQueue.push(jobId);
      broadcast('job_update', serializeJob(job));
      processQueue();

      return sendJson(res, 200, { job: serializeJob(job) });
    }

    // Cancel job
    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'ジョブが見つかりません' });
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'cancelled';
        job.message = 'キャンセルしました';
        job.etaSec = null;
        if (job.cancelFn) {
          job.cancelFn();
        }
        broadcast('job_update', serializeJob(job));
        tryCleanupPendingFile(job.fileId);
      }
      return sendJson(res, 200, { ok: true });
    }

    // Clear finished jobs from UI history (does not delete output files on disk)
    if (req.method === 'POST' && pathname === '/api/jobs/clear') {
      const removed = [];
      for (const [id, job] of jobs.entries()) {
        if (job.status === 'done' || job.status === 'cancelled' || job.status === 'error') {
          jobs.delete(id);
          removed.push(id);
        }
      }
      broadcast('jobs_cleared', { removed });
      return sendJson(res, 200, { ok: true, removed });
    }

    // Delete uploaded temp file (deferred if referenced by active jobs)
    const delMatch = pathname.match(/^\/api\/upload\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const fileId = delMatch[1];
      const fileInfo = uploadedFiles.get(fileId);
      if (fileInfo) {
        if (hasActiveJobsForFile(fileId)) {
          fileInfo.pendingDelete = true;
          return sendJson(res, 200, { ok: true, deferred: true });
        }
        safeUnlink(fileInfo.tempPath);
        uploadedFiles.delete(fileId);
      }
      return sendJson(res, 200, { ok: true, deferred: false });
    }

    // Open output folder in system file manager
    if (req.method === 'POST' && pathname === '/api/open-output') {
      const body = await readJsonBody(req).catch(() => ({}));
      const targetFile = body.fileName ? path.join(OUTPUT_DIR, path.basename(body.fileName)) : null;
      if (process.platform === 'win32') {
        if (targetFile && fs.existsSync(targetFile)) {
          spawn('explorer.exe', [`/select,${targetFile}`], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('explorer.exe', [OUTPUT_DIR], { detached: true, stdio: 'ignore' }).unref();
        }
      } else if (process.platform === 'darwin') {
        const args = targetFile && fs.existsSync(targetFile) ? ['-R', targetFile] : [OUTPUT_DIR];
        spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [OUTPUT_DIR], { detached: true, stdio: 'ignore' }).unref();
      }
      return sendJson(res, 200, { ok: true, outputDir: OUTPUT_DIR });
    }

    // Graceful shutdown from Web UI
    if (req.method === 'POST' && pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => shutdownServer(0), 100);
      return;
    }

    // Serve output video (preview or download)
    if (req.method === 'GET' && pathname.startsWith('/api/output/')) {
      const fileName = decodeURIComponent(pathname.slice('/api/output/'.length));
      const safeName = path.basename(fileName);
      const filePath = path.join(OUTPUT_DIR, safeName);
      const forceDownload = urlObj.searchParams.get('download') === '1';
      return serveMediaFile(req, res, filePath, forceDownload);
    }

    // Serve static frontend with strict boundary check
    if (req.method === 'GET') {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(PUBLIC_DIR, relPath);
      const relative = path.relative(PUBLIC_DIR, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
      pipeStreamSafely(fs.createReadStream(filePath), req, res);
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  } catch (err) {
    console.error('[Server Error]', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  }
});

// Clean old temp files on startup / exit
function cleanupTempDir() {
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      safeUnlink(path.join(TEMP_DIR, f), 1);
    }
  } catch {}
}

function startServer(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3950) {
      startServer(port + 1);
    } else {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}`;
    const hw = await detectHardwareEncoders();
    console.log('====================================================');
    console.log('  ローカル動画圧縮ツール (Local Video Compressor)');
    console.log(`  URL: ${url}`);
    console.log(`  保存先: ${OUTPUT_DIR}`);
    console.log(`  GPU検出: ${hw.hasGpu ? hw.available.map((g) => `${g.label} [H.264:${g.supportsH264 ? 'OK' : 'NG'} / HEVC:${g.supportsHevc ? 'OK' : 'NG'}]`).join(', ') : 'CPUモード (libx264/libx265)'}`);
    console.log('  ※ Web画面右上の「終了」ボタン、またはこのウィンドウを閉じると終了します');
    console.log('====================================================');

    if (process.argv.includes('--open')) {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    }
  });
}

cleanupTempDir();
process.on('SIGINT', () => shutdownServer(0));
process.on('SIGTERM', () => shutdownServer(0));

const initialPort = parseInt(process.env.PORT, 10) || 3890;
startServer(initialPort);
