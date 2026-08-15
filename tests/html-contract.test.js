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

test('正式 HTML 對所有 startup-coupled 本機 script 使用同一 build cache key，並保留 authority 分流', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  for (const [name, src] of [
    ['config', './supabase-config.js'],
    ['vendor', './vendor/supabase-2.112.2.js'],
    ['core', './monthly-collaboration-core.js'],
    ['client', './monthly-collaboration-client.js'],
    ['v7', './monthly-collaboration-v7.js']
  ]) {
    assert.match(html, new RegExp(`${name}: '${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(html, new RegExp(`monthlyReportWriteStartupScript\\('${name}'\\)`));
  }
  assert.match(html, /url\.searchParams\.set\('v', window\.MONTHLY_REPORT_PAGE_BUILD\)/);
  assert.match(html, /url\.searchParams\.set\('reload', reloadNonce\)/);
  assert.doesNotMatch(html, /monthly-collaboration-(?:core|client|v7)\.js\?v=7\.0\.16/);
  const uploadStart = html.indexOf('async function v4UploadToCloud');
  const activeBranch = html.indexOf('window.MonthlyV7App?.isActive?.()', uploadStart);
  const legacyWriter = html.indexOf("rpc/upsert_monthly_report_cloud_data", uploadStart);
  assert.ok(uploadStart > 0 && activeBranch > uploadStart && legacyWriter > activeBranch);
  assert.match(html, /persistReportData\(reportData,\s*\{/);
  assert.match(html, /persistRecords\(v2RecordsCache\)/);
  assert.match(html, /dataset\.v7EntityId/);
  assert.match(html, /async function v7GetLegacyLocalState\(snapshot\)/);
  assert.match(html, /clearLegacyRecovery:\s*v7ClearLegacyRecovery/);
  assert.match(html, /window\.MonthlyV7App\?\.isWriteReady\?\.\(\)/);
  assert.match(html, /confirmLegacyRecovery:\s*!silent/);
  assert.match(html, /帳號驗證已通過，但雲端資料載入失敗/);
});

test('page、config、core、client 與 V7 宣告同一 build ID 並提供 mixed-build 安全重載', async () => {
  const buildId = '7.0.21';
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /MONTHLY_REPORT_PAGE_BUILD = '7\.0\.21'/);
  for (const [file, asset] of [
    ['supabase-config.js', 'config'],
    ['monthly-collaboration-core.js', 'core'],
    ['monthly-collaboration-client.js', 'client'],
    ['monthly-collaboration-v7.js', 'v7']
  ]) {
    const source = await readFile(join(root, file), 'utf8');
    assert.match(source, new RegExp(buildId.replace(/\./g, '\\.')), file);
    assert.match(source, new RegExp(`${asset}: (?:buildId|'${buildId.replace(/\./g, '\\.')}')`), file);
  }
  assert.match(html, /MIXED_ASSET_BLOCKED/);
  assert.match(html, /id="site-safe-reload"/);
  assert.match(html, /function v7SafeReloadFromGate\(\)/);
});

test('登入便利功能只保存用戶名，不把密碼或權限資料寫入 app-managed storage', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /id="v5-remember-username"[^>]+type="checkbox"/);
  assert.match(html, /記住上次用戶名/);
  assert.match(html, /V5_REMEMBERED_USERNAME_KEY = 'monthly_report_remembered_username'/);
  assert.match(html, /V5_REMEMBER_USERNAME_ENABLED_KEY = 'monthly_report_remember_username_enabled'/);
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /id="v5-login-password" type="password" autocomplete="current-password"/);
  assert.doesNotMatch(html, /id="v5-login-password"[^>]+value=/);
  const rememberStart = html.indexOf('function v5RememberSuccessfulUsername');
  const rememberEnd = html.indexOf('function v5GetFormDrafts', rememberStart);
  assert.ok(rememberStart > 0 && rememberEnd > rememberStart);
  const rememberBlock = html.slice(rememberStart, rememberEnd);
  assert.doesNotMatch(rememberBlock, /password|hash|role|session|displayName/i);
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

test('列印目前內容固定沿用 PDF 勾選與排序，且輸出不帶版本提示', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const selectedBuilderStart = html.indexOf('function buildV1SelectedEditorPrintHtml(options = {})');
  const selectedBuilderEnd = html.indexOf('function buildV1EditorPrintCloneHtml()', selectedBuilderStart);
  const prepareStart = html.indexOf('async function prepareV1PdfPrintArea(options = {})');
  const prepareEnd = html.indexOf('async function prepareV7FormalSnapshotPrintArea', prepareStart);
  const currentPrintStart = html.indexOf('async function printCurrentEditorReport()');
  const currentPrintEnd = html.indexOf('async function v1LoadReportById', currentPrintStart);
  assert.ok(selectedBuilderStart > 0 && selectedBuilderEnd > selectedBuilderStart);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  assert.ok(currentPrintStart > 0 && currentPrintEnd > currentPrintStart);

  const selectedBuilder = html.slice(selectedBuilderStart, selectedBuilderEnd);
  const prepare = html.slice(prepareStart, prepareEnd);
  const currentPrint = html.slice(currentPrintStart, currentPrintEnd);
  assert.match(selectedBuilder, /v1GetSelectedModules\(\)/);
  assert.match(html, /\.sort\(\(a, b\) => \(a\.order - b\.order\) \|\| \(a\.index - b\.index\)\)/);
  assert.match(currentPrint, /prepareV1PdfPrintArea\(\)/);
  assert.doesNotMatch(currentPrint, /selectAll\s*:\s*true|currentDraft\s*:\s*true/);
  assert.doesNotMatch(prepare, /v1-local-draft-banner|不是正式版本|非正式版|草稿版/);
  assert.doesNotMatch(html, /class=["']v1-local-draft-banner/);
});
