'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../topic-reports-core.js');

test('空白專題內容使用topic domain且只建立一個獨立模塊', () => {
  const content = core.createBlankTopicContent({ now: new Date('2026-08-16T01:30:00.000Z'), moduleId: 'module-a' });
  assert.equal(content.schemaVersion, 1);
  assert.equal(content.domain, 'topic');
  assert.equal(content.title, '未命名專題報告');
  assert.equal(content.reportDate, '2026-08-16');
  assert.equal(content.modules.length, 1);
  assert.deepEqual(content.modules[0], {
    id: 'module-a',
    icon: 'fas fa-file-lines',
    iconColor: '#4f46e5',
    title: '專題內容',
    colLayout: '1',
    colCount: 1,
    columns: ['<p>請輸入專題內容...</p>'],
    attachments: [],
    selectedForPdf: true,
    pdfOrder: 1
  });
  assert.equal(Object.hasOwn(content, 'reportData'), false);
  assert.equal(Object.hasOwn(content, 'currentFileId'), false);
});

test('系統編號依台北業務日期與三位序號格式化且拒絕越界序號', () => {
  assert.equal(core.formatTopicSystemNumber('2026-08-16', 1), 'SR-20260816-001');
  assert.equal(core.formatTopicSystemNumber('2026-08-16', 999), 'SR-20260816-999');
  assert.throws(() => core.formatTopicSystemNumber('2026-08-16', 0), /TOPIC_SEQUENCE_INVALID/);
  assert.throws(() => core.formatTopicSystemNumber('2026-08-16', 1000), /TOPIC_SEQUENCE_INVALID/);
  assert.throws(() => core.formatTopicSystemNumber('2026\/08\/16', 1), /TOPIC_DATE_INVALID/);
});

test('專題draft與pending key強制包含domain、report、actor和editor window且不碰月報key', () => {
  const scope = {
    reportId: '11111111-1111-4111-8111-111111111111',
    actorUserId: '22222222-2222-4222-8222-222222222222',
    editorWindowId: '33333333-3333-4333-8333-333333333333'
  };
  assert.equal(
    core.topicDraftKey(scope),
    'topic:v1:draft:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333'
  );
  assert.equal(
    core.topicPendingKey({ ...scope, operationType: 'save' }),
    'topic:v1:pending:save:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333'
  );
  assert.doesNotMatch(core.topicDraftKey(scope), /monthly_v7|latest_report|SafetyMeetingDB/);
});

test('附件normalize保留完整metadata與data URL，不在保存時無聲消失', () => {
  const content = core.createBlankTopicContent({ title: '附件專題', reportDate: '2026-08-16' });
  content.modules[0].attachments = [{
    id: '99999999-9999-4999-8999-999999999999',
    name: 'manual.pdf', type: 'application/pdf', size: 7,
    dataUrl: 'data:application/pdf;base64,QUJDRA=='
  }];
  const normalized = core.normalizeTopicContent(content);
  assert.deepEqual(normalized.modules[0].attachments, content.modules[0].attachments);
});

test('晚到回應只有domain、report、window及generation全部相符才能套用', () => {
  const active = core.createTopicScope({
    reportId: '11111111-1111-4111-8111-111111111111',
    editorWindowId: '33333333-3333-4333-8333-333333333333',
    generation: 7
  });
  assert.equal(core.matchesTopicScope(active, { ...active }), true);
  assert.equal(core.matchesTopicScope(active, { ...active, domain: 'monthly' }), false);
  assert.equal(core.matchesTopicScope(active, { ...active, reportId: '44444444-4444-4444-8444-444444444444' }), false);
  assert.equal(core.matchesTopicScope(active, { ...active, editorWindowId: '55555555-5555-4555-8555-555555555555' }), false);
  assert.equal(core.matchesTopicScope(active, { ...active, generation: 6 }), false);
});

test('正規化專題內容移除未知頂層authority欄位並保留模塊排版', () => {
  const normalized = core.normalizeTopicContent({
    domain: 'topic',
    schemaVersion: 1,
    title: '  海上作業專題  ',
    reportDate: '2026-08-16',
    period: { start: '2026-08-01', end: '2026-08-31' },
    settings: { globalFontEn: 'Arial', globalFontZh: 'Noto Sans TC', pdfScale: 95 },
    modules: [{
      id: 'module-a', title: '<b>作業重點</b>', columns: ['內容'], colLayout: '1:2',
      attachments: [{ name: 'proof.pdf', data: 'data:application/pdf;base64,AA==' }], selectedForPdf: false, pdfOrder: 4
    }],
    reportData: [{ title: '月報污染' }],
    monthlyRevision: 99
  });
  assert.equal(normalized.title, '海上作業專題');
  assert.equal(normalized.modules[0].colLayout, '1:2');
  assert.equal(normalized.modules[0].colCount, 2);
  assert.equal(normalized.modules[0].selectedForPdf, false);
  assert.equal(Object.hasOwn(normalized, 'reportData'), false);
  assert.equal(Object.hasOwn(normalized, 'monthlyRevision'), false);
});

test('編輯窗口、Excel與列印使用的公開命名API完整且可重現', () => {
  const reportId = '11111111-1111-4111-8111-111111111111';
  assert.equal(core.editorWindowName(reportId), `topic-report-${reportId}`);
  assert.equal(core.sanitizeExportName('主機／甲板:專題?', 'fallback'), '主機_甲板_專題');
  assert.equal(core.buildReportExportName({
    systemNumber: 'SR-20260816-001', title: '繫泊／專題'
  }, new Date('2026-08-16T01:00:00.000Z')), '專題報告_SR-20260816-001_繫泊_專題_2026-08-16');
});

test('專題PDF檔名含系統編號、清理不安全字元並使用本地日期', () => {
  assert.equal(
    core.topicReportPdfFilename({ systemNumber: 'SR-20260816-001', title: '主機／甲板:專題?', exportDate: '2026-08-16' }),
    '專題報告_SR-20260816-001_主機_甲板_專題_2026-08-16.pdf'
  );
  assert.equal(core.topicHistoryPdfFilename('2026-08-16'), '專題報告歷史清單_2026-08-16.pdf');
});
