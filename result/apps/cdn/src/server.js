const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const mime = require('mime-types');
const { Throttle } = require('stream-throttle');
const Database = require('better-sqlite3');

require('dotenv').config();

const PORT = parseInt(process.env.PORT || '9000', 10);
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`);
const STORAGE_ROOT = process.env.STORAGE_ROOT || 'storage';
const STATIC_ROOT = process.env.STATIC_ROOT || 'public';
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || UPLOAD_API_KEY;
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '512', 10);
const GENERAL_RATE_LIMIT_WINDOW_MS = parseInt(process.env.GENERAL_RATE_LIMIT_WINDOW_MS || '900000', 10);
const GENERAL_RATE_LIMIT_MAX = parseInt(process.env.GENERAL_RATE_LIMIT_MAX || '500', 10);
const UPLOAD_RATE_LIMIT_WINDOW_MS = parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || '3600000', 10);
const UPLOAD_RATE_LIMIT_MAX = parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || '0', 10);
const DOWNLOAD_SPEED_LIMIT_KBPS = parseInt(process.env.DOWNLOAD_SPEED_LIMIT_KBPS || '12207', 10);
const CACHE_MAX_AGE_SECONDS = parseInt(process.env.CACHE_MAX_AGE_SECONDS || '604800', 10);
const METRICS_FILE = process.env.METRICS_FILE || 'data/metrics.json';
const SQLITE_DB_FILE = process.env.SQLITE_DB_FILE || 'data/creeper.db';
const HASH_FILENAME_LENGTH = normalizeHashLength(process.env.HASH_FILENAME_LENGTH || '32');

const TMP_DIR = path.join(STORAGE_ROOT, '.tmp');

ensureDir(STORAGE_ROOT);
ensureDir(TMP_DIR);
ensureDir(path.dirname(SQLITE_DB_FILE));
ensureDir(path.dirname(METRICS_FILE));

const db = new Database(SQLITE_DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    version TEXT,
    storedFilename TEXT NOT NULL,
    originalFilename TEXT NOT NULL,
    hash TEXT NOT NULL,
    uploadedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS files_unique
    ON files (namespace, version, storedFilename);
  CREATE INDEX IF NOT EXISTS files_namespace
    ON files (namespace);
  CREATE TABLE IF NOT EXISTS download_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    version TEXT,
    storedFilename TEXT NOT NULL,
    ip TEXT,
    userAgent TEXT,
    bytes INTEGER NOT NULL,
    downloadedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS download_logs_file
    ON download_logs (namespace, version, storedFilename);
`);

const insertFileStmt = db.prepare(
  'INSERT OR REPLACE INTO files (namespace, version, storedFilename, originalFilename, hash, uploadedAt) VALUES (?, ?, ?, ?, ?, ?)'
);
const deleteFileStmt = db.prepare(
  'DELETE FROM files WHERE namespace = ? AND version IS ? AND storedFilename = ?'
);
const deleteFileStmtVersioned = db.prepare(
  'DELETE FROM files WHERE namespace = ? AND version = ? AND storedFilename = ?'
);
const listNamespacesStmt = db.prepare('SELECT DISTINCT namespace FROM files ORDER BY namespace');
const listVersionsStmt = db.prepare(
  'SELECT DISTINCT version FROM files WHERE namespace = ? AND version IS NOT NULL ORDER BY version'
);
const listNoVersionCountStmt = db.prepare(
  'SELECT COUNT(*) AS count FROM files WHERE namespace = ? AND version IS NULL'
);
const listFilesNoVersionStmt = db.prepare(
  'SELECT storedFilename, originalFilename, hash, uploadedAt FROM files WHERE namespace = ? AND version IS NULL ORDER BY uploadedAt DESC'
);
const listFilesVersionedStmt = db.prepare(
  'SELECT storedFilename, originalFilename, hash, uploadedAt FROM files WHERE namespace = ? AND version = ? ORDER BY uploadedAt DESC'
);
const getFileNoVersionStmt = db.prepare(
  'SELECT storedFilename, originalFilename, hash, uploadedAt FROM files WHERE namespace = ? AND version IS NULL AND storedFilename = ?'
);
const getFileVersionedStmt = db.prepare(
  'SELECT storedFilename, originalFilename, hash, uploadedAt FROM files WHERE namespace = ? AND version = ? AND storedFilename = ?'
);
const insertDownloadLogStmt = db.prepare(
  'INSERT INTO download_logs (namespace, version, storedFilename, ip, userAgent, bytes, downloadedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const listDownloadLogsNoVersionStmt = db.prepare(
  'SELECT ip, userAgent, bytes, downloadedAt FROM download_logs WHERE namespace = ? AND version IS NULL AND storedFilename = ? ORDER BY downloadedAt DESC LIMIT 200'
);
const listDownloadLogsVersionedStmt = db.prepare(
  'SELECT ip, userAgent, bytes, downloadedAt FROM download_logs WHERE namespace = ? AND version = ? AND storedFilename = ? ORDER BY downloadedAt DESC LIMIT 200'
);

const metrics = loadMetrics(METRICS_FILE);
let metricsDirty = false;

setInterval(() => {
  if (!metricsDirty) {
    return;
  }
  flushMetrics();
}, 30000).unref();

process.on('SIGINT', () => {
  flushMetrics();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushMetrics();
  process.exit(0);
});

const app = express();
app.set('trust proxy', TRUST_PROXY);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const generalLimiter = rateLimit({
  windowMs: GENERAL_RATE_LIMIT_WINDOW_MS,
  max: GENERAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

const uploadLimiter = rateLimit({
  windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
  max: UPLOAD_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => {
      const suffix = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${suffix}`);
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024
  }
});

app.use(express.static(STATIC_ROOT));

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.post(
  '/api/upload',
  UPLOAD_RATE_LIMIT_MAX > 0 ? uploadLimiter : (req, _res, next) => next(),
  requireUploadKey,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const namespace = normalizeSegment(req.body.namespace, 'default');
    if (!namespace) {
      return res.status(400).json({ error: 'invalid namespace' });
    }

    const version = normalizeSegment(req.body.version, null);
    if (req.body.version && !version) {
      return res.status(400).json({ error: 'invalid version' });
    }

    try {
      const hash = await hashFile(req.file.path);
      const extension = path.extname(req.file.originalname) || '';
      const storedFilename = `${hash.slice(0, HASH_FILENAME_LENGTH)}${extension}`;
      const destDir = version
        ? path.join(STORAGE_ROOT, namespace, version)
        : path.join(STORAGE_ROOT, namespace);
      ensureDir(destDir);
      const destPath = path.join(destDir, storedFilename);

      if (!fs.existsSync(destPath)) {
        await fs.promises.rename(req.file.path, destPath);
      } else {
        await fs.promises.unlink(req.file.path);
      }

      const uploadedAt = new Date().toISOString();
      insertFileStmt.run(namespace, version, storedFilename, req.file.originalname, hash, uploadedAt);

      const urlLatest = `${PUBLIC_BASE_URL}/${namespace}/${storedFilename}`;
      const urlVersioned = version
        ? `${PUBLIC_BASE_URL}/${namespace}/${version}/${storedFilename}`
        : `${PUBLIC_BASE_URL}/${namespace}/latest/${storedFilename}`;

      const response = {
        namespace,
        version: version ?? null,
        filename: storedFilename,
        hash,
        originalFilename: req.file.originalname,
        uploadedAt,
        url: version ? urlVersioned : urlLatest,
        urlLatest: version ? undefined : urlLatest,
        urlVersioned: version ? undefined : urlVersioned
      };

      return res.status(200).json(response);
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'upload_failed' });
    }
  }
);

app.get('/api/admin/metrics/downloads', requireAdminKey, (_req, res) => {
  res.json(metrics);
});

app.get('/api/admin/files', requireAdminKey, (req, res) => {
  const namespace = normalizeSegment(req.query.namespace, null);
  const version = normalizeVersionQuery(req.query.version);
  const file = normalizeFilename(req.query.file);
  if (req.query.file && !file) {
    return res.status(400).json({ error: 'invalid filename' });
  }

  if (!namespace) {
    const namespaces = listNamespacesStmt.all().map((row) => row.namespace);
    return res.json({ namespaces });
  }

  if (version === undefined) {
    const versions = listVersionsStmt.all(namespace).map((row) => row.version);
    const noVersionCount = listNoVersionCountStmt.get(namespace).count;
    return res.json({ namespace, versions, hasNoVersion: noVersionCount > 0 });
  }

  const files = version === null
    ? listFilesNoVersionStmt.all(namespace)
    : listFilesVersionedStmt.all(namespace, version);

  const mapped = files.map((entry) => ({
    filename: entry.storedFilename,
    originalFilename: entry.originalFilename,
    hash: entry.hash,
    uploadedAt: entry.uploadedAt
  }));

  if (file) {
    const target = version === null
      ? getFileNoVersionStmt.get(namespace, file)
      : getFileVersionedStmt.get(namespace, version, file);
    if (!target) {
      return res.status(404).json({ error: 'file not found' });
    }
    const logs = version === null
      ? listDownloadLogsNoVersionStmt.all(namespace, file)
      : listDownloadLogsVersionedStmt.all(namespace, version, file);
    return res.json({
      namespace,
      version: version ?? null,
      files: mapped,
      downloadLogs: logs
    });
  }

  return res.json({
    namespace,
    version: version ?? null,
    files: mapped
  });
});

app.post('/api/admin/files/delete', requireAdminKey, (req, res) => {
  const result = handleDelete(req.body, res);
  if (result) {
    res.json(result);
  }
});

app.delete('/api/admin/files', requireAdminKey, (req, res) => {
  const result = handleDelete(req.query, res);
  if (result) {
    res.json(result);
  }
});

app.get('/admin/downloads', requireAdminKey, (req, res) => {
  const token = getApiKey(req);
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  res.redirect(`/admin/files${query}`);
});

app.get('/admin/files', requireAdminKey, (req, res) => {
  const namespace = normalizeSegment(req.query.namespace, null);
  const version = normalizeVersionQuery(req.query.version);
  const file = normalizeFilename(req.query.file);
  if (req.query.file && !file) {
    return res.status(400).send('Invalid filename');
  }
  const token = getApiKey(req);
  const tokenQuery = token ? `token=${encodeURIComponent(token)}` : '';

  if (!namespace) {
    const namespaces = listNamespacesStmt.all().map((row) => row.namespace);
    return res.send(renderNamespaceList(namespaces, tokenQuery));
  }

  if (version === undefined) {
    const versions = listVersionsStmt.all(namespace).map((row) => row.version);
    const noVersionFiles = listFilesNoVersionStmt.all(namespace);
    return res.send(renderVersionList({ namespace, versions, noVersionFiles, tokenQuery }));
  }

  const files = version === null
    ? listFilesNoVersionStmt.all(namespace)
    : listFilesVersionedStmt.all(namespace, version);
  const logs = file
    ? (version === null
        ? listDownloadLogsNoVersionStmt.all(namespace, file)
        : listDownloadLogsVersionedStmt.all(namespace, version, file))
    : [];

  return res.send(renderFileList({ namespace, version, files, file, logs, tokenQuery }));
});

app.get('/:namespace/:version/:filename', async (req, res) => {
  const namespace = normalizeSegment(req.params.namespace, null);
  const versionParam = normalizeSegment(req.params.version, null);
  const filename = normalizeFilename(req.params.filename);
  if (!namespace || !versionParam || !filename) {
    return res.status(404).end();
  }

  const version = versionParam === 'latest' ? null : versionParam;
  const resolved = resolveFilePath(namespace, version, filename);
  if (!resolved) {
    return res.status(404).end();
  }

  return streamFile(req, res, resolved, { namespace, version, filename });
});

app.get('/:namespace/:filename', async (req, res) => {
  const namespace = normalizeSegment(req.params.namespace, null);
  const filename = normalizeFilename(req.params.filename);
  if (!namespace || !filename) {
    return res.status(404).end();
  }

  const resolved = resolveFilePath(namespace, null, filename);
  if (!resolved) {
    return res.status(404).end();
  }

  return streamFile(req, res, resolved, { namespace, version: null, filename });
});

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file too large' });
  }
  return res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.warn(`Creeper CDN listening on :${PORT}`);
});

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function normalizeHashLength(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 2) {
    return 32;
  }
  if (parsed % 2 === 1) {
    return parsed - 1;
  }
  return parsed;
}

function ensureDir(dirPath) {
  if (!dirPath || dirPath === '.') {
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeSegment(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeVersionQuery(value) {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  if (value === '__noversion__') {
    return null;
  }
  const normalized = normalizeSegment(value, null);
  return normalized ?? undefined;
}

function normalizeFilename(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function resolveFilePath(namespace, version, filename) {
  const base = path.join(STORAGE_ROOT, namespace);
  if (version) {
    const candidate = path.join(base, version, filename);
    return fs.existsSync(candidate) ? candidate : null;
  }
  const direct = path.join(base, filename);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const legacy = path.join(base, 'latest', filename);
  if (fs.existsSync(legacy)) {
    return legacy;
  }
  return null;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function streamFile(req, res, filePath, context) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.status(404).end();
      return;
    }

    const totalSize = stats.size;
    const range = parseRange(req.headers.range, totalSize);

    const contentType = mime.lookup(filePath) || 'application/octet-stream';
    const etag = `"${stats.size}-${stats.mtimeMs}"`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stats.mtime.toUTCString());

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.status(200);
      res.setHeader('Content-Length', totalSize);
    }

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    let readStream = fs.createReadStream(filePath, range || undefined);
    if (DOWNLOAD_SPEED_LIMIT_KBPS > 0) {
      const rate = DOWNLOAD_SPEED_LIMIT_KBPS * 1024;
      readStream = readStream.pipe(new Throttle({ rate }));
    }

    const bytesSent = range ? range.end - range.start + 1 : totalSize;
    recordDownload(context, bytesSent, req);

    readStream.pipe(res);
  });
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return null;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) {
    return null;
  }
  const startText = match[1];
  const endText = match[2];
  let start;
  let end;
  if (!startText && endText) {
    const suffixLength = parseInt(endText, 10);
    if (Number.isNaN(suffixLength)) {
      return null;
    }
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = startText ? parseInt(startText, 10) : 0;
    end = endText ? parseInt(endText, 10) : totalSize - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= totalSize) {
    return null;
  }
  return { start, end };
}

function recordDownload(context, bytes, req) {
  if (!context || !context.namespace || !context.filename) {
    return;
  }

  const versionKey = context.version ?? '__noversion__';
  const fileKey = `${context.namespace}/${versionKey}/${context.filename}`;

  metrics.totalDownloads = (metrics.totalDownloads || 0) + 1;
  metrics.totalBytes = (metrics.totalBytes || 0) + bytes;
  if (!metrics.files) {
    metrics.files = {};
  }
  if (!metrics.files[fileKey]) {
    metrics.files[fileKey] = { downloads: 0, bytes: 0, lastDownloadedAt: null };
  }
  metrics.files[fileKey].downloads += 1;
  metrics.files[fileKey].bytes += bytes;
  metrics.files[fileKey].lastDownloadedAt = new Date().toISOString();
  metricsDirty = true;

  insertDownloadLogStmt.run(
    context.namespace,
    context.version,
    context.filename,
    req.ip || null,
    req.get('user-agent') || null,
    bytes,
    new Date().toISOString()
  );
}

function loadMetrics(metricsPath) {
  try {
    if (fs.existsSync(metricsPath)) {
      const raw = fs.readFileSync(metricsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (_err) {
    // ignore parse errors
  }
  return { totalDownloads: 0, totalBytes: 0, files: {} };
}

function flushMetrics() {
  try {
    ensureDir(path.dirname(METRICS_FILE));
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    metricsDirty = false;
  } catch (_err) {
    // ignore write errors
  }
}

function requireUploadKey(req, res, next) {
  if (!UPLOAD_API_KEY) {
    return res.status(403).json({ error: 'upload disabled' });
  }
  const key = getApiKey(req);
  if (key !== UPLOAD_API_KEY) {
    return res.status(403).json({ error: 'invalid api key' });
  }
  return next();
}

function requireAdminKey(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(403).json({ error: 'admin disabled' });
  }
  const key = getApiKey(req);
  if (key !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'invalid api key' });
  }
  return next();
}

function getApiKey(req) {
  const headerKey = req.get('x-api-key');
  if (headerKey) {
    return headerKey;
  }
  if (typeof req.query.token === 'string') {
    return req.query.token;
  }
  if (typeof req.query.apiKey === 'string') {
    return req.query.apiKey;
  }
  return null;
}

function handleDelete(source, res) {
  const namespace = normalizeSegment(source.namespace, null);
  const version = normalizeVersionQuery(source.version);
  const filename = normalizeFilename(source.filename);

  if (!namespace || !filename || version === undefined) {
    res.status(400).json({ error: 'namespace, version, filename required' });
    return null;
  }

  const resolved = resolveFilePath(namespace, version, filename);
  if (!resolved) {
    res.status(404).json({ error: 'file not found' });
    return null;
  }

  try {
    fs.unlinkSync(resolved);
  } catch (_err) {
    // ignore file delete errors
  }

  if (version === null) {
    deleteFileStmt.run(namespace, null, filename);
    db.prepare('DELETE FROM download_logs WHERE namespace = ? AND version IS NULL AND storedFilename = ?')
      .run(namespace, filename);
  } else {
    deleteFileStmtVersioned.run(namespace, version, filename);
    db.prepare('DELETE FROM download_logs WHERE namespace = ? AND version = ? AND storedFilename = ?')
      .run(namespace, version, filename);
  }

  const versionKey = version ?? '__noversion__';
  const fileKey = `${namespace}/${versionKey}/${filename}`;
  if (metrics.files && metrics.files[fileKey]) {
    delete metrics.files[fileKey];
    metricsDirty = true;
  }

  return { deleted: true, namespace, version: version ?? null, filename };
}

function renderNamespaceList(namespaces, tokenQuery) {
  const items = namespaces.length
    ? namespaces.map((name) => {
        const href = `/admin/files?namespace=${encodeURIComponent(name)}${tokenQuery ? `&${tokenQuery}` : ''}`;
        return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
      }).join('')
    : '<li>No namespaces found.</li>';

  return wrapHtml(`
    <h1>Namespaces</h1>
    <ul>${items}</ul>
  `);
}

function renderVersionList({ namespace, versions, noVersionFiles, tokenQuery }) {
  const versionLinks = versions.length
    ? versions.map((version) => {
        const href = `/admin/files?namespace=${encodeURIComponent(namespace)}&version=${encodeURIComponent(version)}${tokenQuery ? `&${tokenQuery}` : ''}`;
        return `<li><a href="${href}">${escapeHtml(version)}</a></li>`;
      }).join('')
    : '<li>No versions found.</li>';

  const noVersionLink = `/admin/files?namespace=${encodeURIComponent(namespace)}&version=__noversion__${tokenQuery ? `&${tokenQuery}` : ''}`;

  const noVersionTable = renderFilesTable({
    namespace,
    version: null,
    files: noVersionFiles,
    tokenQuery
  });

  return wrapHtml(`
    <h1>Namespace: ${escapeHtml(namespace)}</h1>
    <h2>Versions</h2>
    <ul>${versionLinks}</ul>
    <p><a href="${noVersionLink}">View versionless files</a></p>
    <h2>Versionless Files</h2>
    ${noVersionTable}
  `);
}

function renderFileList({ namespace, version, files, file, logs, tokenQuery }) {
  const title = version === null
    ? `Namespace: ${namespace} (versionless)`
    : `Namespace: ${namespace} / Version: ${version}`;

  const table = renderFilesTable({ namespace, version, files, tokenQuery, selectedFile: file });
  const logSection = file
    ? renderLogsTable(file, logs)
    : '<p>Select a file to view logs.</p>';

  return wrapHtml(`
    <h1>${escapeHtml(title)}</h1>
    ${table}
    <h2>Download Logs</h2>
    ${logSection}
  `);
}

function renderFilesTable({ namespace, version, files, tokenQuery, selectedFile }) {
  if (!files || files.length === 0) {
    return '<p>No files found.</p>';
  }

  const rows = files.map((entry) => {
    const filename = entry.storedFilename;
    const logLink = `/admin/files?namespace=${encodeURIComponent(namespace)}&version=${encodeVersionParam(version)}&file=${encodeURIComponent(filename)}${tokenQuery ? `&${tokenQuery}` : ''}`;
    const deleteAction = tokenQuery
      ? `/api/admin/files/delete?${tokenQuery}`
      : '/api/admin/files/delete';
    const selected = selectedFile === filename ? ' style="font-weight:bold"' : '';

    return `
      <tr${selected}>
        <td>${escapeHtml(filename)}</td>
        <td>${escapeHtml(entry.originalFilename || '')}</td>
        <td>${escapeHtml(entry.hash || '')}</td>
        <td>${escapeHtml(entry.uploadedAt || '')}</td>
        <td><a href="${logLink}">View logs</a></td>
        <td>
          <form method="post" action="${deleteAction}">
            <input type="hidden" name="namespace" value="${escapeHtml(namespace)}" />
            <input type="hidden" name="version" value="${escapeHtml(version ?? '__noversion__')}" />
            <input type="hidden" name="filename" value="${escapeHtml(filename)}" />
            <button type="submit">Delete</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Stored Filename</th>
          <th>Original Filename</th>
          <th>Hash</th>
          <th>Uploaded At</th>
          <th>Logs</th>
          <th>Delete</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderLogsTable(file, logs) {
  if (!logs || logs.length === 0) {
    return `<p>No logs for ${escapeHtml(file)}.</p>`;
  }

  const rows = logs.map((entry) => {
    return `
      <tr>
        <td>${escapeHtml(entry.downloadedAt || '')}</td>
        <td>${escapeHtml(entry.ip || '')}</td>
        <td>${escapeHtml(entry.userAgent || '')}</td>
        <td>${escapeHtml(String(entry.bytes || 0))}</td>
      </tr>
    `;
  }).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Downloaded At</th>
          <th>IP</th>
          <th>User-Agent</th>
          <th>Bytes</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function wrapHtml(body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Creeper CDN Admin</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    form { margin: 0; }
    button { padding: 6px 10px; }
    a { color: #1a73e8; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function encodeVersionParam(version) {
  return version === null ? '__noversion__' : encodeURIComponent(version);
}
