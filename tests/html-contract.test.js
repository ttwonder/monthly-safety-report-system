'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Script } = require('node:vm');

const root = join(__dirname, '..');

function inlineScripts(html) {
  return Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]);
}

test('兩份正式 HTML 保持完全一致且所有 inline JavaScript 可解析', async () => {
  const [index, download] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, '月度安全會議報告-v4.html'), 'utf8')
  ]);
  assert.equal(index, download);
  const scripts = inlineScripts(index);
  assert.ok(scripts.length >= 2);
  scripts.forEach((source, index) => assert.doesNotThrow(() => new Script(source, { filename: `inline-${index + 1}.js` }), `inline script ${index + 1}`));
});

test('正式 HTML 載入固定 Supabase bundle 與 V7 三層 client，並保留 authority 分流', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  for (const src of [
    './vendor/supabase-2.112.2.js',
    './monthly-collaboration-core.js'
  ]) assert.match(html, new RegExp(`<script src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  for (const src of [
    './monthly-collaboration-client.js?v=7.0.7',
    './monthly-collaboration-v7.js?v=7.0.7'
  ]) assert.match(html, new RegExp(`<script src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  const uploadStart = html.indexOf('async function v4UploadToCloud');
  const activeBranch = html.indexOf('window.MonthlyV7App?.isActive?.()', uploadStart);
  const legacyWriter = html.indexOf("rpc/upsert_monthly_report_cloud_data", uploadStart);
  assert.ok(uploadStart > 0 && activeBranch > uploadStart && legacyWriter > activeBranch);
  assert.match(html, /persistReportData\(reportData,\s*\{/);
  assert.match(html, /persistRecords\(v2RecordsCache\)/);
  assert.match(html, /dataset\.v7EntityId/);
});

test('進站與登入後共用使用者指定的本機 FPMC Logo，工具列控制具無障礙狀態', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /id="siteAccessBrandLogo"[^>]+src="\.\/assets\/fpmc-logo\.png"[^>]+alt="台塑海運 FPMC Logo"/);
  assert.match(html, /id="v1BrandLogo"[^>]+src="\.\/assets\/fpmc-logo\.png"[^>]+alt="台塑海運 FPMC Logo"/);
  assert.equal(Array.from(html.matchAll(/src="\.\/assets\/fpmc-logo\.png"/g)).length, 2);
  assert.match(html, /id="toolbarPreferenceControls"/);
  assert.match(html, /id="toolbarPinToggle"[^>]+aria-pressed="true"/);
  assert.match(html, /id="toolbarPinToggle"[^>]+aria-label="固定顯示工具列"/);
  assert.match(html, /id="toolbarCollapseToggle"[^>]+aria-expanded="true"[^>]+aria-controls="editorToolbarContent"/);
  assert.match(html, /id="editorToolbarContent"[^>]+class="editor-toolbar-stack/);

  const logo = await readFile(join(root, 'assets', 'fpmc-logo.png'));
  assert.equal(
    createHash('sha256').update(logo).digest('hex'),
    'bc79ff64d006cdc036117c3051dd70223db4dc10a8e1a58dca0b20e9d0dd9bc0'
  );
});
