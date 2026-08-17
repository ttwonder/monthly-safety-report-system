(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.ReportAssetsStorage = api;
    root.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, root.MONTHLY_REPORT_ASSET_BUILDS, { assets: api.MONTHLY_BUILD_ID });
    root.TOPIC_REPORT_ASSET_BUILDS = Object.assign({}, root.TOPIC_REPORT_ASSET_BUILDS, { assets: api.TOPIC_BUILD_ID });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const BUCKET_NAME = 'report-assets';
  const MONTHLY_BUILD_ID = '7.5.0';
  const TOPIC_BUILD_ID = '1.11.0';
  const CACHE_CONTROL_SECONDS = '31536000';
  const DEFAULT_TIMEOUT_MS = 60000;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SAFE_DOMAINS = new Set(['monthly', 'topic']);
  const SAFE_KINDS = new Set(['images', 'attachments']);
  const IMAGE_EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
  });
  const MIME_EXTENSIONS = Object.freeze({
    ...IMAGE_EXTENSIONS,
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
  });

  function codedError(code, message, cause) {
    const error = new Error(message || code);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function safeSegment(value, fallback = 'report') {
    const text = String(value == null ? '' : value)
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 96);
    return text || fallback;
  }

  function fileExtension(file, kind) {
    const type = String(file && file.type || '').trim().toLowerCase();
    if (kind === 'images' && IMAGE_EXTENSIONS[type]) return IMAGE_EXTENSIONS[type];
    const name = String(file && file.name || '');
    const match = name.match(/\.([a-z0-9]{1,10})$/i);
    if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    return MIME_EXTENSIONS[type] || 'bin';
  }

  function randomUuid() {
    if (root && root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const suffix = Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
    return `00000000-0000-4000-8000-${suffix}`;
  }

  function createObjectPath(options = {}) {
    const domain = String(options.domain || '').trim().toLowerCase();
    const kind = String(options.kind || '').trim().toLowerCase();
    if (!SAFE_DOMAINS.has(domain)) throw codedError('REPORT_ASSET_DOMAIN_INVALID');
    if (!SAFE_KINDS.has(kind)) throw codedError('REPORT_ASSET_KIND_INVALID');
    const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUuid;
    const objectId = String(idFactory() || '').toLowerCase();
    if (!UUID_PATTERN.test(objectId)) throw codedError('REPORT_ASSET_OBJECT_ID_INVALID');
    const reportId = safeSegment(options.reportId, 'report');
    const extension = fileExtension(options.file, kind);
    return `${domain}/${reportId}/${kind}/${objectId}.${extension}`;
  }

  function isLocalHostname(hostname) {
    const value = String(hostname || '').toLowerCase();
    return value === 'localhost' || value === '127.0.0.1' || value === '[::1]';
  }

  function publicPathPrefix(baseUrl) {
    const basePath = String(baseUrl && baseUrl.pathname || '/').replace(/\/$/, '');
    return `${basePath}/storage/v1/object/public/${BUCKET_NAME}/`.replace(/^\/\//, '/');
  }

  function parsePublicAssetUrl(value, options = {}) {
    let url;
    try { url = new URL(String(value || '')); }
    catch (_error) { return null; }
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) return null;

    let expectedBase = null;
    if (options.supabaseUrl) {
      try { expectedBase = new URL(String(options.supabaseUrl)); }
      catch (_error) { return null; }
      if (url.origin !== expectedBase.origin) return null;
    }

    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); }
    catch (_error) { return null; }
    const prefix = publicPathPrefix(expectedBase || { pathname: '/' });
    if (!decodedPath.startsWith(prefix)) return null;
    const path = decodedPath.slice(prefix.length);
    if (!path || path.includes('..') || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) return null;
    const parts = path.split('/');
    if (parts.length !== 4) return null;
    const [domain, reportId, kind, filename] = parts;
    if (!SAFE_DOMAINS.has(domain) || !SAFE_KINDS.has(kind)) return null;
    if (!/^[a-z0-9_-]{1,96}$/.test(reportId)) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/i.test(filename)) return null;
    if (options.expectedDomain && domain !== options.expectedDomain) return null;
    if (options.expectedKind && kind !== options.expectedKind) return null;
    if (options.expectedReportId && reportId !== safeSegment(options.expectedReportId, 'report')) return null;
    if (options.expectedPath && path !== options.expectedPath) return null;
    return { bucket: BUCKET_NAME, path, url: url.href };
  }

  function normalizePublicAssetReference(value, options = {}) {
    if (!value || typeof value !== 'object') return null;
    const url = String(value.url || value.publicUrl || '');
    const parsed = parsePublicAssetUrl(url, {
      supabaseUrl: options.supabaseUrl,
      expectedDomain: options.expectedDomain,
      expectedKind: options.expectedKind,
      expectedReportId: options.expectedReportId,
      expectedPath: value.path || options.expectedPath
    });
    if (!parsed) return null;
    if (value.bucket && String(value.bucket) !== BUCKET_NAME) return null;
    return parsed;
  }

  function isTrustedPublicAssetUrl(value, options = {}) {
    return Boolean(parsePublicAssetUrl(value, options));
  }

  function publicAssetDownloadUrl(value, filename, options = {}) {
    const reference = normalizePublicAssetReference(value, options);
    if (!reference) throw codedError('REPORT_ASSET_PUBLIC_URL_INVALID');
    const safeName = String(filename || 'download')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 240) || 'download';
    const url = new URL(reference.url);
    url.searchParams.set('download', safeName);
    return url.href;
  }

  async function withTimeout(promise, timeoutMs) {
    const delay = Number(timeoutMs);
    if (!Number.isFinite(delay) || delay <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = (root.setTimeout || setTimeout)(() => reject(codedError('REPORT_ASSET_UPLOAD_TIMEOUT')), delay);
    });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer !== null) (root.clearTimeout || clearTimeout)(timer); }
  }

  async function uploadReportAsset(options = {}) {
    const client = options.client;
    const file = options.file;
    if (!client || !client.storage || typeof client.storage.from !== 'function') {
      throw codedError('REPORT_ASSET_CLIENT_NOT_READY', 'Storage client尚未就緒。');
    }
    if (!file || typeof file !== 'object') throw codedError('REPORT_ASSET_FILE_REQUIRED');
    const path = createObjectPath(options);
    const bucket = client.storage.from(BUCKET_NAME);
    if (!bucket || typeof bucket.upload !== 'function' || typeof bucket.getPublicUrl !== 'function') {
      throw codedError('REPORT_ASSET_CLIENT_NOT_READY', 'Storage client不支援檔案上傳。');
    }
    const type = String(file.type || 'application/octet-stream').trim().slice(0, 160) || 'application/octet-stream';
    const uploadOptions = {
      cacheControl: CACHE_CONTROL_SECONDS,
      contentType: type,
      upsert: false
    };
    let response;
    try {
      response = await withTimeout(bucket.upload(path, file, uploadOptions), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    } catch (error) {
      if (error && error.code === 'REPORT_ASSET_UPLOAD_TIMEOUT') throw error;
      throw codedError('REPORT_ASSET_UPLOAD_FAILED', 'Storage上傳失敗。', error);
    }
    if (!response || response.error || !response.data || String(response.data.path || '') !== path) {
      throw codedError('REPORT_ASSET_UPLOAD_FAILED', 'Storage上傳失敗。', response && response.error);
    }
    const publicResult = bucket.getPublicUrl(path);
    const publicUrl = publicResult && publicResult.data && publicResult.data.publicUrl;
    const reference = normalizePublicAssetReference({ bucket: BUCKET_NAME, path, url: publicUrl }, {
      supabaseUrl: options.supabaseUrl,
      expectedDomain: String(options.domain || '').toLowerCase(),
      expectedKind: String(options.kind || '').toLowerCase(),
      expectedReportId: options.reportId
    });
    if (!reference) throw codedError('REPORT_ASSET_PUBLIC_URL_INVALID', 'Storage public URL驗證失敗。');
    return {
      ...reference,
      name: String(file.name || 'file').slice(0, 240),
      type,
      size: Number.isFinite(Number(file.size)) && Number(file.size) >= 0 ? Number(file.size) : 0
    };
  }

  return Object.freeze({
    BUCKET_NAME,
    MONTHLY_BUILD_ID,
    TOPIC_BUILD_ID,
    CACHE_CONTROL_SECONDS,
    createObjectPath,
    normalizePublicAssetReference,
    isTrustedPublicAssetUrl,
    publicAssetDownloadUrl,
    uploadReportAsset
  });
});
