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
    trend: 'topic-trend-card',
    'content-blue': 'topic-content-block-blue',
    'content-green': 'topic-content-block-green',
    'content-red': 'topic-content-block-red',
    'content-orange': 'topic-content-block-orange',
    'content-purple': 'topic-content-block-purple'
  };
  for (const [type, className] of Object.entries(types)) {
    const html = editor.buildBlockHtml(type);
    assert.match(html, new RegExp(className));
    assert.doesNotMatch(html, /\bid=["']/i);
    assert.doesNotMatch(html, /<script|\son[a-z]+\s*=|javascript:/i);
  }
});

test('五色內容區塊沿用月報標題語義且標題正文可編輯', () => {
  const expectations = {
    'content-blue': ['資訊標題', 'fa-info-circle'],
    'content-green': ['數據/達標', 'fa-check-circle'],
    'content-red': ['異常/警示', 'fa-exclamation-triangle'],
    'content-orange': ['分析/趨勢', 'fa-chart-line'],
    'content-purple': ['行動/要求', 'fa-tasks']
  };
  for (const [type, [title, icon]] of Object.entries(expectations)) {
    const html = editor.buildBlockHtml(type);
    assert.match(html, new RegExp(title.replace('/', '\\/')));
    assert.match(html, new RegExp(icon));
    assert.ok((html.match(/data-topic-editable=/g) || []).length >= 2);
    assert.match(html, /請輸入內容/);
  }
});

test('數值框預設貼合內容並保留前後各兩個空格', () => {
  const html = editor.buildBlockHtml('highlight');
  assert.doesNotMatch(html, /style=["'][^"']*width\s*:/i);
  const text = html.match(/>([^<]*)<\/span>$/)?.[1];
  assert.equal(text, '  重要數值 100  ');
});

test('趨勢與動態卡片具備月報同級資料結構及固定圖表容器', () => {
  const trend = editor.buildBlockHtml('trend');
  assert.match(trend, /topic-chart-canvas-area/);
  assert.match(trend, /data-topic-chart-height=["']220["']/);
  assert.ok((trend.match(/<th\b/g) || []).length >= 3, '至少週期加兩個指標');
  assert.ok((trend.match(/<tr\b/g) || []).length >= 4, '至少表頭加三個週期');

  const kpi = editor.buildBlockHtml('kpi');
  ['topic-kpi-current-marker', 'topic-kpi-target-marker', 'topic-kpi-avg-marker', 'topic-metric-avg'].forEach((name) => assert.match(kpi, new RegExp(name)));
  assert.match(editor.buildBlockHtml('progress'), /topic-progress-marker/);
  const zone = editor.buildBlockHtml('zone');
  ['topic-zone-limit1', 'topic-zone-limit-mid', 'topic-zone-limit2', 'topic-zone-marker'].forEach((name) => assert.match(zone, new RegExp(name)));
  const indicator = editor.buildBlockHtml('indicator-blue');
  assert.ok((indicator.match(/<tr\b/g) || []).length >= 4, '指標卡應有標題與三行資料');
  assert.match(indicator, /<colgroup>\s*<col[^>]*width\s*:\s*66\.66/i);
  assert.equal((indicator.match(/<col\b/g) || []).length, 2, '指標卡預設必須只有兩個權威欄寬');
});

test('圖片對齊只接受左中右且無效值回到置中', () => {
  assert.equal(editor.normalizeImageAlignment('left'), 'left');
  assert.equal(editor.normalizeImageAlignment('center'), 'center');
  assert.equal(editor.normalizeImageAlignment('right'), 'right');
  assert.equal(editor.normalizeImageAlignment('bad'), 'center');
  assert.equal(editor.normalizeImageAlignment(null), 'center');
});

test('趨勢高度限制在固定安全範圍', () => {
  assert.equal(editor.normalizeChartHeight(100), 160);
  assert.equal(editor.normalizeChartHeight(220), 220);
  assert.equal(editor.normalizeChartHeight(999), 500);
  assert.equal(editor.normalizeChartHeight('bad'), 220);
});

test('PDF方向只接受直向與橫向，無效值回退直向', () => {
  assert.equal(editor.normalizePdfOrientation('portrait'), 'portrait');
  assert.equal(editor.normalizePdfOrientation('landscape'), 'landscape');
  assert.equal(editor.normalizePdfOrientation('LANDSCAPE'), 'landscape');
  assert.equal(editor.normalizePdfOrientation('bad'), 'portrait');
  assert.equal(editor.normalizePdfOrientation(null), 'portrait');
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

test('三欄與四欄在normalize及Excel往返時完整保留', () => {
  const source = core.normalizeTopicContent({
    title: '多欄專題', reportDate: '2026-08-17',
    modules: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '四欄內容',
      colLayout: '1:1:1:1', colCount: 4, columns: ['第一欄', '第二欄', '第三欄', '第四欄']
    }]
  });
  assert.equal(source.modules[0].colCount, 4);
  assert.deepEqual(source.modules[0].columns, ['第一欄', '第二欄', '第三欄', '第四欄']);
  const rows = editor.contentToWorkbookRows(source);
  assert.equal(rows[0].版型, '1:1:1:1');
  assert.deepEqual(
    [rows[0].欄1HTML, rows[0].欄2HTML, rows[0].欄3HTML, rows[0].欄4HTML],
    ['第一欄', '第二欄', '第三欄', '第四欄']
  );
  const restored = editor.workbookRowsToContent(rows, core.createBlankTopicContent(), () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(restored.modules[0].colLayout, '1:1:1:1');
  assert.equal(restored.modules[0].colCount, 4);
  assert.deepEqual(restored.modules[0].columns, ['第一欄', '第二欄', '第三欄', '第四欄']);
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

test('專題附件normalize同時保留舊Base64與新Storage public URL', () => {
  const reportId = '11111111-1111-4111-8111-111111111111';
  const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const content = core.normalizeTopicContent({
    title: '新舊附件並存',
    reportDate: '2026-08-17',
    modules: [{
      id: '22222222-2222-4222-8222-222222222222',
      title: '附件', colLayout: '1', columns: [''],
      attachments: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'legacy.txt', type: 'text/plain', size: 3,
          dataUrl: 'data:text/plain;base64,QUJD'
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          name: 'future.pdf', type: 'application/pdf', size: 456,
          bucket: 'report-assets',
          path: `topic/${reportId}/attachments/${objectId}.pdf`,
          url: `https://project-ref.supabase.co/storage/v1/object/public/report-assets/topic/${reportId}/attachments/${objectId}.pdf`
        }
      ]
    }]
  });
  assert.equal(content.modules[0].attachments.length, 2);
  assert.match(content.modules[0].attachments[0].dataUrl, /^data:text\/plain;base64,/);
  assert.equal(content.modules[0].attachments[1].bucket, 'report-assets');
  assert.equal(content.modules[0].attachments[1].path, `topic/${reportId}/attachments/${objectId}.pdf`);
  assert.equal(content.modules[0].attachments[1].url,
    `https://project-ref.supabase.co/storage/v1/object/public/report-assets/topic/${reportId}/attachments/${objectId}.pdf`);
  assert.equal(Object.hasOwn(content.modules[0].attachments[1], 'dataUrl'), false);
});

test('PDF保留物件相對所屬欄位的百分比以維持編輯頁排布', () => {
  assert.equal(editor.normalizePrintObjectWidth('30%', '1', 0), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '1:1', 0), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '1:1', 1), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '1:2', 0), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '1:2', 1), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '2:1', 0), '30%');
  assert.equal(editor.normalizePrintObjectWidth('30%', '2:1', 1), '30%');
  assert.equal(editor.normalizePrintObjectWidth('70%', '1:1', 0), '70%');
  assert.equal(editor.normalizePrintObjectWidth('', '1:1', 0), '');
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

test('PDF縮放只接受明確百分比且無效值回到100%', () => {
  for (const value of [60, 70, 80, 90, 100, 110, 120]) {
    assert.equal(editor.normalizePdfScale(value), value);
    assert.equal(editor.normalizePdfScale(`${value}%`), value);
  }
  assert.equal(editor.normalizePdfScale('95%'), 100);
  assert.equal(editor.normalizePdfScale('javascript:1'), 100);
});

test('插入內容百分比只接受月報同級預設值', () => {
  for (const value of [20, 25, 30, 45, 70, 100]) {
    assert.equal(editor.normalizeObjectWidth(`${value}%`), `${value}%`);
    assert.equal(editor.normalizeObjectWidth(value), `${value}%`);
  }
  assert.equal(editor.normalizeObjectWidth('999%'), '100%');
  assert.equal(editor.normalizeObjectWidth('javascript:1'), '100%');
});
