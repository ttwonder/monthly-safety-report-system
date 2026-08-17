'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const assets = require('../report-assets-storage.js');

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPABASE_URL = 'https://project-ref.supabase.co';

function fakeStorageClient(options = {}) {
  const calls = [];
  const bucketApi = {
    async upload(path, file, uploadOptions) {
      calls.push({ action: 'upload', path, file, options: uploadOptions });
      if (options.error) return { data: null, error: options.error };
      return { data: { path }, error: null };
    },
    getPublicUrl(path) {
      calls.push({ action: 'getPublicUrl', path });
      return {
        data: {
          publicUrl: `${SUPABASE_URL}/storage/v1/object/public/report-assets/${path}`
        }
      };
    }
  };
  return {
    calls,
    client: {
      storage: {
        from(bucket) {
          calls.push({ action: 'from', bucket });
          return bucketApi;
        }
      }
    }
  };
}

test('Storage物件路徑使用domain/report/kind/UUID且不沿用原始檔名', () => {
  const path = assets.createObjectPath({
    domain: 'monthly', reportId: 'report_2026-08', kind: 'images',
    file: { name: '../敏感 船名.JPG', type: 'image/jpeg' }, idFactory: () => UUID
  });
  assert.equal(path, `monthly/report_2026-08/images/${UUID}.jpg`);
  assert.doesNotMatch(path, /敏感|船名|\.\./);
  assert.throws(() => assets.createObjectPath({
    domain: 'bad', reportId: 'r1', kind: 'images', file: { name: 'a.png', type: 'image/png' }, idFactory: () => UUID
  }), { code: 'REPORT_ASSET_DOMAIN_INVALID' });
});

test('上傳固定使用公開report-assets bucket、upsert false並回傳canonical public URL', async () => {
  const fake = fakeStorageClient();
  const result = await assets.uploadReportAsset({
    client: fake.client,
    supabaseUrl: SUPABASE_URL,
    domain: 'topic',
    reportId: '11111111-1111-4111-8111-111111111111',
    kind: 'attachments',
    file: { name: 'manual.PDF', type: 'application/pdf', size: 1234 },
    idFactory: () => UUID
  });
  assert.deepEqual(result, {
    bucket: 'report-assets',
    path: `topic/11111111-1111-4111-8111-111111111111/attachments/${UUID}.pdf`,
    url: `${SUPABASE_URL}/storage/v1/object/public/report-assets/topic/11111111-1111-4111-8111-111111111111/attachments/${UUID}.pdf`,
    name: 'manual.PDF',
    type: 'application/pdf',
    size: 1234
  });
  assert.equal(fake.calls[0].bucket, 'report-assets');
  const upload = fake.calls.find((call) => call.action === 'upload');
  assert.equal(upload.options.upsert, false);
  assert.equal(upload.options.cacheControl, '31536000');
  assert.equal(upload.options.contentType, 'application/pdf');
});

test('public URL只接受指定Supabase origin與report-assets canonical路徑', () => {
  const value = {
    bucket: 'report-assets',
    path: `topic/11111111-1111-4111-8111-111111111111/images/${UUID}.png`,
    url: `${SUPABASE_URL}/storage/v1/object/public/report-assets/topic/11111111-1111-4111-8111-111111111111/images/${UUID}.png`
  };
  assert.deepEqual(assets.normalizePublicAssetReference(value, {
    supabaseUrl: SUPABASE_URL, expectedDomain: 'topic', expectedKind: 'images'
  }), value);
  assert.equal(assets.isTrustedPublicAssetUrl('https://evil.example/storage/v1/object/public/report-assets/topic/r/images/x.png', {
    supabaseUrl: SUPABASE_URL
  }), false);
  assert.equal(assets.isTrustedPublicAssetUrl(`${SUPABASE_URL}/storage/v1/object/public/other/topic/r/images/x.png`, {
    supabaseUrl: SUPABASE_URL
  }), false);
  assert.equal(assets.isTrustedPublicAssetUrl(`${SUPABASE_URL}/storage/v1/object/public/report-assets/topic/r/images/../../x.png`, {
    supabaseUrl: SUPABASE_URL
  }), false);
});

test('附件下載URL由canonical public URL衍生download參數且不改寫保存值', () => {
  const savedUrl = 'https://project.supabase.co/storage/v1/object/public/report-assets/monthly/report-1/attachments/123e4567-e89b-42d3-a456-426614174000.pdf';
  const reference = {
    bucket: 'report-assets',
    path: 'monthly/report-1/attachments/123e4567-e89b-42d3-a456-426614174000.pdf',
    url: savedUrl
  };
  const downloadUrl = assets.publicAssetDownloadUrl(reference, '安全 報告.pdf', {
    supabaseUrl: 'https://project.supabase.co', expectedDomain: 'monthly', expectedKind: 'attachments'
  });
  const parsed = new URL(downloadUrl);
  assert.equal(parsed.origin + parsed.pathname, savedUrl);
  assert.equal(parsed.searchParams.get('download'), '安全 報告.pdf');
  assert.equal(reference.url, savedUrl);
  assert.throws(() => assets.publicAssetDownloadUrl({ url: 'https://evil.example/file.pdf' }, 'x.pdf'), /REPORT_ASSET_PUBLIC_URL_INVALID/);
});

test('Storage失敗時不回退Base64且API不提供刪除物件操作', async () => {
  const fake = fakeStorageClient({ error: { message: 'bucket missing', statusCode: '404' } });
  await assert.rejects(assets.uploadReportAsset({
    client: fake.client,
    supabaseUrl: SUPABASE_URL,
    domain: 'monthly', reportId: 'report-1', kind: 'images',
    file: { name: 'image.png', type: 'image/png', size: 10 }, idFactory: () => UUID
  }), { code: 'REPORT_ASSET_UPLOAD_FAILED' });
  assert.equal(Object.hasOwn(assets, 'deleteReportAsset'), false);
  assert.equal(Object.hasOwn(assets, 'removeReportAsset'), false);
});

test('SQL建立公開bucket且只授權authenticated INSERT，不建立UPDATE或DELETE policy', async () => {
  const sql = await readFile(join(ROOT, 'docs', 'supabase-storage-report-assets.sql'), 'utf8');
  assert.match(sql, /insert\s+into\s+storage\.buckets[\s\S]*'report-assets'[\s\S]*public/gi);
  assert.match(sql, /create\s+policy[\s\S]*for\s+insert[\s\S]*to\s+authenticated[\s\S]*bucket_id\s*=\s*'report-assets'/gi);
  assert.match(sql, /storage\.foldername\(name\)\)\[2\][\s\S]*~\s*'\^\[a-z0-9_-\]\{1,96\}\$'/i);
  assert.doesNotMatch(sql, /create\s+policy[\s\S]*for\s+(?:update|delete)/gi);
  assert.doesNotMatch(sql, /storage\.objects[\s\S]*\bdelete\s+from\b/gi);
});

test('月報與專題的新圖片／附件流程都呼叫Storage且不再readAsDataURL', async () => {
  const [html, editor] = await Promise.all([
    readFile(join(ROOT, 'index.html'), 'utf8'),
    readFile(join(ROOT, 'topic-report-editor.js'), 'utf8')
  ]);
  const monthlyImage = html.slice(html.indexOf('async function insertImagesToEditor'), html.indexOf("document.addEventListener('click'", html.indexOf('async function insertImagesToEditor')));
  const monthlyAttachment = html.slice(html.indexOf('async function handleFileUpload'), html.indexOf('// 終極安全純文字萃取', html.indexOf('async function handleFileUpload')));
  const topicImage = editor.slice(editor.indexOf('async function insertImageFile'), editor.indexOf('function totalAttachmentBytes'));
  const topicAttachment = editor.slice(editor.indexOf('async function addAttachmentFile'), editor.indexOf('function attachmentAction'));
  for (const [label, source] of Object.entries({ monthlyImage, monthlyAttachment, topicImage, topicAttachment })) {
    assert.match(source, /uploadReportAsset/, `${label}應上傳Storage`);
    assert.doesNotMatch(source, /readAsDataURL|FileReader|dataUrl\s*=|base64/i, `${label}不可產生新Base64`);
  }
});
