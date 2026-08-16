'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const read = (name) => readFile(join(ROOT, name), 'utf8');

function scriptSources(html) {
  return Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi), (match) => match[1]);
}

function ids(html) {
  return Array.from(html.matchAll(/\bid=["']([^"']+)["']/gi), (match) => match[1]);
}

test('月報只在數據管理右側新增外部專題入口且mirror逐byte一致', async () => {
  const [index, mirror] = await Promise.all([read('index.html'), read('月度安全會議報告-v4.html')]);
  assert.equal(index, mirror);
  const marker = '<a id="topicReportsEntry" class="v1-tab-btn v1-topic-entry" href="./topic-reports.html?v=1.4.0" target="topic-reports"';
  assert.equal(index.split(marker).length - 1, 1);
  const dataIndex = index.indexOf('>數據管理</button>');
  const topicIndex = index.indexOf(marker);
  const modeIndex = index.indexOf('<span class="v1-mode-indicator', topicIndex);
  assert.ok(dataIndex >= 0 && dataIndex < topicIndex && topicIndex < modeIndex);
  const anchor = index.slice(topicIndex, index.indexOf('</a>', topicIndex) + 4);
  assert.match(anchor, />專題報告<\/a>/);
  assert.doesNotMatch(anchor, /data-v1-tab|switchV1Tab|onclick=/);
});

test('專題清單頁只載入topic assets且具備新增、刷新、歷史清單與清單PDF入口', async () => {
  const html = await read('topic-reports.html');
  assert.match(html, /<html lang="zh-TW"/);
  assert.match(html, /<title>專題報告清單<\/title>/);
  const required = [
    'topicIdentityGate', 'topicReportsPage', 'topicCurrentUser', 'topicListStatus',
    'topicAddReport', 'topicRefreshReports', 'topicPrintHistory',
    'topicReportsTable', 'topicReportsEmpty', 'topicCreateDialog',
    'topicCreateTitle', 'topicCreateDate', 'topicCreateConfirm', 'topicHistoryPrintArea'
  ];
  const allIds = ids(html);
  required.forEach((id) => assert.ok(allIds.includes(id), `missing #${id}`));
  assert.equal(new Set(allIds).size, allIds.length, 'duplicate id');
  const sources = scriptSources(html).join('\n');
  assert.match(sources, /supabase-config\.js/);
  assert.match(sources, /vendor\/supabase-2\.112\.2\.js/);
  assert.match(sources, /topic-reports-core\.js/);
  assert.match(sources, /topic-reports-client\.js/);
  assert.match(sources, /topic-reports-page\.js/);
  assert.doesNotMatch(sources, /monthly-collaboration-(core|client|v7)\.js/);
  assert.doesNotMatch(html, /switchV1Tab|monthly_v7_change_events|monthly_v7_reports|monthly_v7_report_items/);

  const tableStart = html.indexOf('id="topicReportsTable"');
  const listTable = html.slice(tableStart, html.indexOf('</table>', tableStart) + 8);
  assert.ok(tableStart >= 0, 'missing list table');
  assert.doesNotMatch(listTable, /系統編號|模塊|Revision/i);
  assert.match(listTable, /資料大小/);
  assert.match(listTable, /topic-col-size/);
  ['title', 'reportDate', 'status', 'logicalBytes', 'updatedAt'].forEach((key) => {
    assert.match(listTable, new RegExp(`data-topic-sort=["']${key}["']`), `missing sortable ${key} header`);
  });
});

test('專題編輯頁是獨立窗口且完整列出編輯、模塊、保存、Excel、PDF及重置控制', async () => {
  const html = await read('topic-report-editor.html');
  assert.match(html, /<title>專題報告編輯器<\/title>/);
  const required = [
    'topicEditorGate', 'topicEditorPage', 'topicEditorToolbar', 'topicToolbarContent',
    'topicToolbarPin', 'topicToolbarCollapse', 'topicCurrentUser', 'topicModeBadge',
    'topicLeaseNotice', 'topicReportTitle',
    'topicReportDate', 'topicModules', 'topicAddModule', 'topicSave', 'topicComplete',
    'topicDiscardExit', 'topicSync', 'topicPrint', 'topicReset', 'topicExcelImport', 'topicExcelExport',
    'topicPdfScale',
    'topicTextColorPalette', 'topicFontSize', 'topicObjectToolbar', 'topicTrendControls', 'topicTrendHeight',
    'topicExcelFile', 'topicImageFile', 'topicAttachmentFile', 'topicPrintArea'
  ];
  const allIds = ids(html);
  required.forEach((id) => assert.ok(allIds.includes(id), `missing #${id}`));
  assert.equal(new Set(allIds).size, allIds.length, 'duplicate id');
  [
    '粗體', '文字顏色', '自動編號', '文字大小', '圖片', '表格', '數值框', '指標卡', 'KPI卡',
    '進度卡', '三色卡', '趨勢圖', '單欄', '雙欄', '附件'
  ].forEach((label) => assert.match(html, new RegExp(label)));
  assert.match(html, /data-command=["']insertOrderedList["']/);
  assert.doesNotMatch(html, /id=["']topicTextColor["'][^>]*type=["']color["']/i);
  assert.ok((html.match(/data-text-color=/g) || []).length >= 8, '文字顏色應直接提供至少8個色塊');
  ['20', '25', '30', '45', '70', '100'].forEach((width) => {
    assert.match(html, new RegExp(`data-topic-object-width=["']${width}["']`));
  });
  assert.match(html, /data-topic-object-delete/);
  ['series-add', 'series-remove', 'period-add', 'period-remove'].forEach((action) => {
    assert.match(html, new RegExp(`data-topic-trend-action=["']${action}["']`));
  });
  const sources = scriptSources(html).join('\n');
  assert.match(sources, /xlsx\/0\.18\.5/);
  assert.match(sources, /chart\.js/);
  assert.match(sources, /topic-reports-core\.js/);
  assert.match(sources, /topic-reports-client\.js/);
  assert.match(sources, /topic-report-editor\.js/);
  assert.doesNotMatch(sources, /monthly-collaboration-(core|client|v7)\.js/);
  assert.doesNotMatch(html, /switchV1Tab|monthly_v7_change_events|monthly_v7_reports|monthly_v7_report_items/);
});

test('專題編輯頁不顯示系統編號與Revision欄位', async () => {
  const html = await read('topic-report-editor.html');
  assert.doesNotMatch(html, /系統編號\s*／\s*Revision/);
  assert.doesNotMatch(html, /id=["']topicSystemNumber["']|id=["']topicRevision["']/);
});

test('topic資產版本完全一致且list/editor啟動前執行混版fail-closed檢查', async () => {
  const core = require(join(ROOT, 'topic-reports-core.js'));
  const client = require(join(ROOT, 'topic-reports-client.js'));
  const editor = require(join(ROOT, 'topic-report-editor.js'));
  assert.equal(core.BUILD_ID, '1.4.0');
  assert.equal(client.BUILD_ID, core.BUILD_ID);
  assert.equal(editor.BUILD_ID, core.BUILD_ID);
  for (const file of ['topic-reports-page.js', 'topic-report-editor.js']) {
    const source = await read(file);
    assert.match(source, /assertTopicAssetBuilds\(\)/);
    assert.match(source, /TOPIC_ASSET_BUILD_MISMATCH/);
  }
  for (const file of ['topic-reports.html', 'topic-report-editor.html']) {
    const html = await read(file);
    const versions = [...html.matchAll(/(?:topic-reports-(?:core|client)|topic-reports-page|topic-report-editor)\.js\?v=([^"']+)/g)]
      .map((match) => match[1]);
    assert.ok(versions.length >= 3, `${file}應載入三個versioned topic資產`);
    assert.deepEqual([...new Set(versions)], ['1.4.0']);
  }
});

test('所有新增topic JavaScript可由Node parser解析', async () => {
  const files = [
    'topic-reports-core.js', 'topic-reports-client.js',
    'topic-reports-page.js', 'topic-report-editor.js'
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
  }
});
