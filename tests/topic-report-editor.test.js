'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../topic-report-editor.js');
const core = require('../topic-reports-core.js');

test('無DOM環境下stored HTML採fail-closed純文字轉義', () => {
  const input = '<b onclick="steal()">安全文字</b><script>alert(1)</script><img src="javascript:x">';
  const safe = editor.sanitizeStoredHtml(input);
  assert.doesNotMatch(safe, /<[^>]+>/);
  assert.match(safe, /&lt;b/);
  assert.match(safe, /安全文字/);
});

test('所有進階模塊模板不含全域id且包含可辨識class', () => {
  const types = {
    highlight: 'topic-highlight',
    'indicator-blue': 'topic-indicator-card',
    'indicator-orange': 'topic-indicator-card',
    kpi: 'topic-kpi-card',
    progress: 'topic-progress-card',
    zone: 'topic-zone-card',
    trend: 'topic-trend-card'
  };
  for (const [type, className] of Object.entries(types)) {
    const html = editor.buildBlockHtml(type);
    assert.match(html, new RegExp(className));
    assert.doesNotMatch(html, /\bid=["']/i);
    assert.doesNotMatch(html, /<script|\son[a-z]+\s*=|javascript:/i);
  }
});

test('Excel rows轉回topic內容時保留項次順序、版型與PDF設定', () => {
  const base = core.createBlankTopicContent({ title: 'Excel專題', reportDate: '2026-08-16' });
  const content = editor.workbookRowsToContent([
    { 項次: 2, 標題: '第二項', 版型: '1:1', 欄1HTML: '<b>B</b>', 欄2HTML: '右欄', PDF勾選: '否', PDF順序: 7 },
    { 項次: 1, 標題: '第一項', 版型: '1', 欄1HTML: '左欄', 欄2HTML: '', PDF勾選: '是', PDF順序: 1 }
  ], base, () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(content.domain, 'topic');
  assert.deepEqual(content.modules.map((module) => module.title), ['第一項', '第二項']);
  assert.equal(content.modules[1].colLayout, '1:1');
  assert.equal(content.modules[1].columns.length, 2);
  assert.equal(content.modules[1].selectedForPdf, false);
  assert.equal(content.modules[1].pdfOrder, 7);
});

test('Excel export不把附件base64資料嵌入儲存格', () => {
  const content = core.createBlankTopicContent({ title: '附件專題', reportDate: '2026-08-16' });
  content.modules[0].attachments = [{
    id: 'file-a', name: 'manual.pdf', type: 'application/pdf', size: 12,
    dataUrl: 'data:application/pdf;base64,QUJDREVGRw=='
  }];
  const rows = editor.contentToWorkbookRows(content);
  const text = JSON.stringify(rows);
  assert.match(text, /manual\.pdf/);
  assert.doesNotMatch(text, /base64|QUJDREVGRw/);
});

test('圖片與附件限制在明確類型及payload邊界', () => {
  assert.equal(editor.isAllowedImage({ type: 'image/png', size: 1024 }), true);
  assert.equal(editor.isAllowedImage({ type: 'image/svg+xml', size: 1024 }), false);
  assert.equal(editor.isAllowedImage({ type: 'image/png', size: 6 * 1024 * 1024 }), false);
  assert.equal(editor.isAllowedAttachment({ name: 'manual.pdf', type: 'application/pdf', size: 1024 }), true);
  assert.equal(editor.isAllowedAttachment({ name: 'malware.exe', type: 'application/x-msdownload', size: 1024 }), false);
  assert.equal(editor.isSafeAttachmentDataUrl({
    name: 'manual.pdf', type: 'application/pdf', size: 7,
    dataUrl: 'data:application/pdf;base64,QUJDREVGRw=='
  }), true);
  assert.equal(editor.isSafeAttachmentDataUrl({
    name: 'manual.pdf', type: 'application/pdf', size: 7,
    dataUrl: 'data:text/html;base64,PHNjcmlwdD4='
  }), false);
  assert.equal(editor.isAllowedAttachment({ name: 'huge.pdf', type: 'application/pdf', size: 7 * 1024 * 1024 }), false);
});

test('指標百分比處理除零、負數及超界值', () => {
  assert.equal(editor.clampedPercent(50, 0, 100), 50);
  assert.equal(editor.clampedPercent(-10, 0, 100), 0);
  assert.equal(editor.clampedPercent(120, 0, 100), 100);
  assert.equal(editor.clampedPercent(5, 5, 5), 0);
  assert.equal(editor.clampedPercent('bad', 0, 100), 0);
});
