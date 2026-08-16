(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.TopicReportsCore = api;
    root.TOPIC_REPORT_ASSET_BUILDS = Object.assign({}, root.TOPIC_REPORT_ASSET_BUILDS, { core: api.BUILD_ID });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUILD_ID = '1.0.0';
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const SYSTEM_NUMBER_PATTERN = /^SR-\d{8}-\d{3}$/;
  const DEFAULT_MODULE_HTML = '<p>請輸入專題內容...</p>';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
  }

  function taipeiDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('TOPIC_DATE_INVALID');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function assertUuid(value, code) {
    const text = String(value || '');
    if (!UUID_PATTERN.test(text)) throw new Error(code);
    return text.toLowerCase();
  }

  function formatTopicSystemNumber(businessDate, sequence) {
    const date = String(businessDate || '');
    const number = Number(sequence);
    if (!DATE_PATTERN.test(date)) throw new Error('TOPIC_DATE_INVALID');
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('TOPIC_DATE_INVALID');
    if (!Number.isInteger(number) || number < 1 || number > 999) throw new Error('TOPIC_SEQUENCE_INVALID');
    return `SR-${date.replace(/-/g, '')}-${String(number).padStart(3, '0')}`;
  }

  function normalizeLayout(value) {
    const text = String(value || '1').trim();
    return /^\d+(?::\d+){0,2}$/.test(text) ? text : '1';
  }

  function normalizeAttachment(value) {
    if (!value || typeof value !== 'object') return null;
    const name = String(value.name || '').slice(0, 240);
    const dataUrl = String(value.dataUrl || value.data || '');
    if (!name || !/^data:[^;,]+;base64,[a-z0-9+/=\s]+$/i.test(dataUrl)) return null;
    const mimeMatch = dataUrl.match(/^data:([^;,]+);base64,/i);
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s+/g, '');
    const calculatedSize = Math.max(0, Math.floor((encoded.length * 3) / 4) - ((encoded.match(/=+$/) || [''])[0].length));
    const providedId = String(value.id || '');
    return {
      id: UUID_PATTERN.test(providedId) ? providedId.toLowerCase() : uuid(),
      name,
      type: String(value.type || (mimeMatch && mimeMatch[1]) || 'application/octet-stream').slice(0, 160),
      size: Number.isFinite(Number(value.size)) && Number(value.size) >= 0 ? Number(value.size) : calculatedSize,
      dataUrl
    };
  }

  function normalizeModule(value, index) {
    const module = value && typeof value === 'object' ? value : {};
    const layout = normalizeLayout(module.colLayout);
    const count = layout.split(':').length;
    const columns = Array.isArray(module.columns) ? module.columns.slice(0, 3).map((entry) => String(entry || '')) : [''];
    while (columns.length < count) columns.push('');
    return {
      id: String(module.id || uuid()),
      icon: String(module.icon || 'fas fa-file-lines'),
      iconColor: /^#[0-9a-f]{6}$/i.test(String(module.iconColor || '')) ? String(module.iconColor) : '#4f46e5',
      title: String(module.title || `專題項次 ${index + 1}`),
      colLayout: layout,
      colCount: count,
      columns: columns.slice(0, count),
      attachments: (Array.isArray(module.attachments) ? module.attachments : []).map(normalizeAttachment).filter(Boolean),
      selectedForPdf: module.selectedForPdf !== false,
      pdfOrder: Number.isInteger(Number(module.pdfOrder)) && Number(module.pdfOrder) > 0 ? Number(module.pdfOrder) : index + 1
    };
  }

  function createBlankTopicContent(options = {}) {
    const date = taipeiDate(options.now || new Date());
    return {
      schemaVersion: 1,
      domain: 'topic',
      title: '未命名專題報告',
      reportDate: date,
      period: { start: date, end: date },
      settings: { globalFontEn: 'Arial', globalFontZh: 'Noto Sans TC', pdfScale: 95 },
      modules: [{
        id: String(options.moduleId || uuid()),
        icon: 'fas fa-file-lines',
        iconColor: '#4f46e5',
        title: '專題內容',
        colLayout: '1',
        colCount: 1,
        columns: [DEFAULT_MODULE_HTML],
        attachments: [],
        selectedForPdf: true,
        pdfOrder: 1
      }]
    };
  }

  function normalizeTopicContent(value) {
    const source = value && typeof value === 'object' ? value : {};
    const fallback = createBlankTopicContent();
    const date = DATE_PATTERN.test(String(source.reportDate || '')) ? String(source.reportDate) : fallback.reportDate;
    const period = source.period && typeof source.period === 'object' ? source.period : {};
    const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const modules = (Array.isArray(source.modules) && source.modules.length ? source.modules : fallback.modules)
      .slice(0, 100)
      .map(normalizeModule);
    return {
      schemaVersion: 1,
      domain: 'topic',
      title: String(source.title || fallback.title).trim().slice(0, 240) || fallback.title,
      reportDate: date,
      period: {
        start: DATE_PATTERN.test(String(period.start || '')) ? String(period.start) : date,
        end: DATE_PATTERN.test(String(period.end || '')) ? String(period.end) : date
      },
      settings: {
        globalFontEn: String(settings.globalFontEn || fallback.settings.globalFontEn).slice(0, 120),
        globalFontZh: String(settings.globalFontZh || fallback.settings.globalFontZh).slice(0, 120),
        pdfScale: [85, 90, 95, 100].includes(Number(settings.pdfScale)) ? Number(settings.pdfScale) : 95
      },
      modules
    };
  }

  function requireStorageScope(scope) {
    const value = scope && typeof scope === 'object' ? scope : {};
    return {
      reportId: assertUuid(value.reportId, 'TOPIC_REPORT_ID_INVALID'),
      actorUserId: assertUuid(value.actorUserId, 'TOPIC_ACTOR_ID_INVALID'),
      editorWindowId: assertUuid(value.editorWindowId, 'TOPIC_EDITOR_WINDOW_ID_INVALID')
    };
  }

  function topicDraftKey(scope) {
    const value = requireStorageScope(scope);
    return `topic:v1:draft:${value.reportId}:${value.actorUserId}:${value.editorWindowId}`;
  }

  function topicPendingKey(scope) {
    const value = requireStorageScope(scope);
    const operationType = String(scope && scope.operationType || '');
    if (!/^[a-z][a-z0-9_-]{1,31}$/i.test(operationType)) throw new Error('TOPIC_OPERATION_TYPE_INVALID');
    return `topic:v1:pending:${operationType}:${value.reportId}:${value.actorUserId}:${value.editorWindowId}`;
  }

  function createTopicScope(value) {
    const input = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      domain: 'topic',
      reportId: assertUuid(input.reportId, 'TOPIC_REPORT_ID_INVALID'),
      editorWindowId: assertUuid(input.editorWindowId, 'TOPIC_EDITOR_WINDOW_ID_INVALID'),
      generation: Number.isInteger(Number(input.generation)) && Number(input.generation) >= 0
        ? Number(input.generation)
        : 0
    });
  }

  function matchesTopicScope(active, candidate) {
    if (!active || !candidate) return false;
    return String(active.domain) === 'topic'
      && String(candidate.domain) === 'topic'
      && String(active.reportId) === String(candidate.reportId)
      && String(active.editorWindowId) === String(candidate.editorWindowId)
      && Number(active.generation) === Number(candidate.generation);
  }

  function safeFilenamePart(value, fallback = '未命名') {
    const text = String(value || '')
      .replace(/[\\/:*?"<>|／]/g, '_')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .replace(/\s+/g, ' ')
      .replace(/_+/g, '_')
      .replace(/^[_ .]+|[_ .]+$/g, '')
      .slice(0, 80);
    return text || fallback;
  }

  function assertExportDate(value) {
    const text = String(value || '');
    if (!DATE_PATTERN.test(text)) throw new Error('TOPIC_DATE_INVALID');
    return text;
  }

  function topicReportPdfFilename({ systemNumber, title, exportDate } = {}) {
    const number = String(systemNumber || '');
    if (!SYSTEM_NUMBER_PATTERN.test(number)) throw new Error('TOPIC_SYSTEM_NUMBER_INVALID');
    return `專題報告_${number}_${safeFilenamePart(title)}_${assertExportDate(exportDate)}.pdf`;
  }

  function editorWindowName(reportId) {
    return `topic-report-${assertUuid(reportId, 'TOPIC_REPORT_ID_INVALID')}`;
  }

  function sanitizeExportName(value, fallback = '未命名') {
    return safeFilenamePart(value, fallback);
  }

  function buildReportExportName(report, now = new Date()) {
    const value = report && typeof report === 'object' ? report : {};
    return topicReportPdfFilename({
      systemNumber: value.systemNumber,
      title: value.title,
      exportDate: taipeiDate(now)
    }).replace(/\.pdf$/i, '');
  }

  function topicHistoryPdfFilename(exportDate) {
    return `專題報告歷史清單_${assertExportDate(exportDate)}.pdf`;
  }

  return Object.freeze({
    BUILD_ID,
    DEFAULT_MODULE_HTML,
    UUID_PATTERN,
    SYSTEM_NUMBER_PATTERN,
    clone,
    taipeiDate,
    formatTopicSystemNumber,
    createBlankTopicContent,
    normalizeTopicContent,
    topicDraftKey,
    topicPendingKey,
    createTopicScope,
    matchesTopicScope,
    safeFilenamePart,
    sanitizeExportName,
    editorWindowName,
    buildReportExportName,
    topicReportPdfFilename,
    topicHistoryPdfFilename
  });
});
