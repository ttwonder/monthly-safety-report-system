(function (root, factory) {
  const commonJs = typeof module === 'object' && module.exports;
  const api = factory(root, commonJs ? require('./topic-reports-core.js') : root.TopicReportsCore,
    commonJs ? require('./topic-reports-client.js') : root.TopicReportsClient);
  if (commonJs) module.exports = api;
  if (root) {
    root.TopicReportEditor = api;
    root.TOPIC_REPORT_ASSET_BUILDS = Object.assign({}, root.TOPIC_REPORT_ASSET_BUILDS, { editor: api.BUILD_ID });
  }
  if (root && root.document) root.document.addEventListener('DOMContentLoaded', () => api.mount());
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, core, clientApi) {
  'use strict';

  const BUILD_ID = '1.8.0';
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;
  const ATTACHMENT_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
  const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const SAFE_ATTACHMENT_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip',
    'png', 'jpg', 'jpeg', 'webp', 'gif'
  ]);
  const SAFE_ATTACHMENT_TYPES = new Set([
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
    ...SAFE_IMAGE_TYPES
  ]);
  const SAFE_TAGS = new Set([
    'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI',
    'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
    'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL', 'IMG', 'A', 'HR', 'SMALL', 'SUP', 'SUB', 'CANVAS'
  ]);
  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM',
    'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'SOURCE'
  ]);
  const SAFE_ATTRIBUTES = new Set([
    'class', 'style', 'title', 'alt', 'src', 'href', 'target', 'rel', 'colspan', 'rowspan',
    'width', 'height', 'contenteditable', 'role', 'aria-label', 'aria-hidden'
  ]);

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function stripHtml(value) {
    if (root.document) {
      const template = sanitizeTemplate(value);
      return String(template.content.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function safeClassList(value) {
    return String(value || '').split(/\s+/).filter((name) => /^topic-[a-z0-9_-]+$/i.test(name)).join(' ');
  }
  function safeStyle(value) {
    const declarations = String(value || '').split(';');
    const allowed = [];
    declarations.forEach((declaration) => {
      const split = declaration.indexOf(':');
      if (split <= 0) return;
      const property = declaration.slice(0, split).trim().toLowerCase();
      const raw = declaration.slice(split + 1).trim();
      if (!raw || /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i.test(raw)) return;
      if (property === '--card-color' && /^#[0-9a-f]{3,8}$/i.test(raw)) allowed.push(`${property}:${raw}`);
      if (property === 'width' && /^(?:100|[0-9]{1,2}(?:\.[0-9]+)?)%$/.test(raw)) allowed.push(`${property}:${raw}`);
      if (property === 'font-size' && /^(?:[89]|[1-6][0-9]|7[0-2])px$/.test(raw)) allowed.push(`${property}:${raw}`);
      if (property === 'color' && /^(?:#[0-9a-f]{3,8}|rgb\([0-9 ,.%]+\)|[a-z]+)$/i.test(raw)) allowed.push(`${property}:${raw}`);
      if (property === 'text-align' && /^(left|right|center|justify)$/.test(raw)) allowed.push(`${property}:${raw}`);
    });
    return allowed.join(';');
  }
  function isSafeImageDataUrl(value) {
    return /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(String(value || ''));
  }

  function sanitizeTemplate(value) {
    const source = String(value == null ? '' : value);
    const template = root.document.createElement('template');
    // 唯一的不可信HTML解析點：template內容不連接document且不執行script；下方逐tag／attribute allowlist後才可取用。
    template.innerHTML = source;
    const elements = Array.from(template.content.querySelectorAll('*'));
    elements.forEach((element) => {
      if (DROP_TAGS.has(element.tagName)) {
        element.remove();
        return;
      }
      if (!SAFE_TAGS.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        return;
      }
      Array.from(element.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const valueText = attribute.value;
        const dataAllowed = /^data-topic-[a-z0-9_-]+$/i.test(name);
        const ariaAllowed = /^aria-(?:label|hidden)$/i.test(name);
        if (/^on/i.test(name) || name === 'id' || (!SAFE_ATTRIBUTES.has(name) && !dataAllowed && !ariaAllowed)) {
          element.removeAttribute(attribute.name);
          return;
        }
        if (name === 'class') {
          const classes = safeClassList(valueText);
          if (classes) element.setAttribute('class', classes); else element.removeAttribute('class');
        } else if (name === 'style') {
          const style = safeStyle(valueText);
          if (style) element.setAttribute('style', style); else element.removeAttribute('style');
        } else if (name === 'src') {
          if (element.tagName !== 'IMG' || !isSafeImageDataUrl(valueText)) element.removeAttribute('src');
        } else if (name === 'href') {
          let safe = false;
          try {
            const url = new URL(valueText, root.location ? root.location.href : 'https://invalid.local/');
            safe = ['https:', 'http:', 'mailto:'].includes(url.protocol);
          } catch (_error) { safe = false; }
          if (!safe) element.removeAttribute('href');
        } else if (name === 'target') {
          if (valueText !== '_blank') element.removeAttribute('target');
        } else if (name === 'contenteditable') {
          if (!['true', 'false', 'plaintext-only'].includes(valueText)) element.removeAttribute('contenteditable');
        } else if (['colspan', 'rowspan', 'width', 'height'].includes(name)) {
          if (!/^\d{1,4}$/.test(valueText)) element.removeAttribute(attribute.name);
        }
      });
      if (element.tagName === 'A' && element.hasAttribute('href')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
      if (element.tagName === 'IMG') {
        element.classList.add('topic-inline-image');
        element.setAttribute('alt', element.getAttribute('alt') || '專題報告圖片');
        element.dataset.topicAlign = normalizeImageAlignment(element.dataset.topicAlign);
      }
    });
    template.content.querySelectorAll('table.topic-indicator-card').forEach((table) => normalizeIndicatorCardStructure(table));
    return template;
  }

  function sanitizeStoredHtml(value) {
    const source = String(value == null ? '' : value).replace(/\u200b/g, '');
    if (!root.document || typeof root.document.createElement !== 'function') return escapeHtml(source);
    return sanitizeTemplate(source).innerHTML;
  }

  function sanitizedFragment(value) {
    return sanitizeTemplate(value).content.cloneNode(true);
  }

  function setSanitizedHtml(target, value) {
    target.replaceChildren(sanitizedFragment(value));
  }

  function clampedPercent(current, minimum, maximum) {
    const value = Number(current);
    const min = Number(minimum);
    const max = Number(maximum);
    if (![value, min, max].every(Number.isFinite) || max <= min) return 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  const OBJECT_WIDTHS = Object.freeze([20, 25, 30, 45, 70, 100]);
  const PDF_SCALES = Object.freeze([60, 70, 80, 90, 100, 110, 120]);
  function normalizeObjectWidth(value) {
    const numeric = Number(String(value == null ? '' : value).replace('%', '').trim());
    return OBJECT_WIDTHS.includes(numeric) ? `${numeric}%` : '100%';
  }
  function normalizeImageAlignment(value) {
    const alignment = String(value == null ? '' : value).trim().toLowerCase();
    return ['left', 'center', 'right'].includes(alignment) ? alignment : 'center';
  }
  function normalizeChartHeight(value) {
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) ? Math.max(160, Math.min(500, numeric)) : 220;
  }
  function normalizePdfScale(value) {
    const numeric = Number.parseInt(String(value == null ? '' : value).replace('%', '').trim(), 10);
    return PDF_SCALES.includes(numeric) ? numeric : 100;
  }
  function normalizePdfOrientation(value) {
    return String(value == null ? '' : value).trim().toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
  }

  function normalizePrintObjectWidth(value, layout, columnIndex) {
    const match = /^([0-9]{1,3}(?:\.[0-9]+)?)%$/.exec(String(value || '').trim());
    if (!match) return '';
    const numeric = Number(match[1]);
    if (!(numeric > 0 && numeric <= 100)) return '';
    return `${Math.round(numeric * 1000) / 1000}%`;
  }

  function isAllowedImage(file) {
    return !!file && SAFE_IMAGE_TYPES.has(String(file.type || '').toLowerCase())
      && Number(file.size) > 0 && Number(file.size) <= IMAGE_MAX_BYTES;
  }

  function isAllowedAttachment(file) {
    if (!file || Number(file.size) <= 0 || Number(file.size) > ATTACHMENT_MAX_BYTES) return false;
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    const type = String(file.type || '').toLowerCase();
    return SAFE_ATTACHMENT_EXTENSIONS.has(extension) && (SAFE_ATTACHMENT_TYPES.has(type) || type === '');
  }

  function isSafeAttachmentDataUrl(attachment) {
    if (!isAllowedAttachment(attachment)) return false;
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(attachment.dataUrl || ''));
    if (!match) return false;
    const mime = String(match[1] || '').toLowerCase();
    const declared = String(attachment.type || '').toLowerCase();
    if (!SAFE_ATTACHMENT_TYPES.has(mime) || (declared && declared !== mime)) return false;
    const payload = match[2].replace(/\s+/g, '');
    const padding = (payload.match(/=+$/) || [''])[0].length;
    const decodedBytes = Math.floor(payload.length * 3 / 4) - padding;
    return decodedBytes === Number(attachment.size) && decodedBytes <= ATTACHMENT_MAX_BYTES;
  }

  function buildBlockHtml(type) {
    const templates = {
      highlight: '<span class="topic-inline-block topic-highlight" data-topic-block="highlight" data-topic-editable="true" contenteditable="true">  重要數值 100  </span>',
      'indicator-blue': '<table class="topic-inline-block topic-indicator-card topic-data-table" data-topic-block="indicator" style="width:30%;--card-color:#2563eb" contenteditable="false"><colgroup><col style="width:66.66%"><col style="width:33.34%"></colgroup><thead><tr><th class="topic-indicator-title" colspan="2" data-topic-editable="true" contenteditable="true">指標名稱</th></tr></thead><tbody><tr><td data-topic-editable="true" contenteditable="true">檢查次數</td><td data-topic-editable="true" contenteditable="true">0</td></tr><tr><td data-topic-editable="true" contenteditable="true">檢查缺失數</td><td data-topic-editable="true" contenteditable="true">0</td></tr><tr><td data-topic-editable="true" contenteditable="true">平均缺失數</td><td data-topic-editable="true" contenteditable="true">0.0</td></tr></tbody></table>',
      'indicator-orange': '<table class="topic-inline-block topic-indicator-card topic-data-table" data-topic-block="indicator" style="width:30%;--card-color:#f97316" contenteditable="false"><colgroup><col style="width:66.66%"><col style="width:33.34%"></colgroup><thead><tr><th class="topic-indicator-title" colspan="2" data-topic-editable="true" contenteditable="true">指標名稱</th></tr></thead><tbody><tr><td data-topic-editable="true" contenteditable="true">檢查次數</td><td data-topic-editable="true" contenteditable="true">0</td></tr><tr><td data-topic-editable="true" contenteditable="true">檢查缺失數</td><td data-topic-editable="true" contenteditable="true">0</td></tr><tr><td data-topic-editable="true" contenteditable="true">平均缺失數</td><td data-topic-editable="true" contenteditable="true">0.0</td></tr></tbody></table>',
      kpi: '<div class="topic-inline-block topic-kpi-card" data-topic-block="kpi" data-topic-show-avg="true" style="width:30%" contenteditable="false"><div class="topic-card-head"><strong data-topic-editable="true" contenteditable="true">KPI 指標</strong><div class="topic-card-values"><span class="topic-kpi-avg-group"><span data-topic-editable="true" contenteditable="true">Avg</span> <b class="topic-metric-avg" data-topic-editable="true" contenteditable="true">65</b></span><span><span data-topic-editable="true" contenteditable="true">現值</span> <b class="topic-metric-current" data-topic-editable="true" contenteditable="true">50</b></span><span><span data-topic-editable="true" contenteditable="true">KPI</span> <b class="topic-metric-target" data-topic-editable="true" contenteditable="true">80</b></span><span class="topic-kpi-avg-toggle" data-topic-kpi-toggle="true" role="button" aria-label="顯示或隱藏Avg標線" contenteditable="false">Avg◉</span></div></div><div class="topic-kpi-track"><span class="topic-kpi-marker topic-kpi-target-marker"></span><span class="topic-kpi-marker topic-kpi-current-marker"></span><span class="topic-kpi-marker topic-kpi-avg-marker topic-kpi-avg-group"></span></div><div class="topic-card-boundaries"><span class="topic-metric-min" data-topic-editable="true" contenteditable="true">0</span><span class="topic-metric-max" data-topic-editable="true" contenteditable="true">100</span></div></div>',
      progress: '<div class="topic-inline-block topic-progress-card" data-topic-block="progress" style="width:30%" contenteditable="false"><div class="topic-card-head"><strong data-topic-editable="true" contenteditable="true">項目名稱</strong><span><span data-topic-editable="true" contenteditable="true">完成度</span> <b class="topic-metric-current" data-topic-editable="true" contenteditable="true">50</b>%</span></div><div class="topic-progress-track"><div class="topic-progress-fill" style="width:50%"></div><span class="topic-progress-marker"></span></div></div>',
      zone: '<div class="topic-inline-block topic-zone-card" data-topic-block="zone" style="width:30%" contenteditable="false"><div class="topic-card-head"><strong data-topic-editable="true" contenteditable="true">評估指標</strong><span><span data-topic-editable="true" contenteditable="true">現值</span> <b class="topic-metric-current" data-topic-editable="true" contenteditable="true">1.55</b></span></div><div class="topic-zone-upper"><span class="topic-zone-limit-mid" data-topic-editable="true" contenteditable="true">2.45</span></div><div class="topic-zone-track"><span class="topic-zone-marker"></span></div><div class="topic-zone-boundaries"><span class="topic-metric-min" data-topic-editable="true" contenteditable="true">0</span><span class="topic-zone-limit1" data-topic-editable="true" contenteditable="true">1.45</span><span class="topic-zone-limit2" data-topic-editable="true" contenteditable="true">3.45</span><span class="topic-metric-max" data-topic-editable="true" contenteditable="true">5</span></div></div>',
      trend: '<div class="topic-trend-card" data-topic-block="trend" style="width:45%" contenteditable="false"><div class="topic-card-head"><strong data-topic-editable="true" contenteditable="true">多維度趨勢比較圖</strong></div><div class="topic-chart-layout"><div class="topic-chart-table-area"><table class="topic-data-table topic-chart-data" contenteditable="false"><thead><tr><th data-topic-editable="true" contenteditable="true">週期</th><th data-topic-editable="true" contenteditable="true">指標 1</th><th data-topic-editable="true" contenteditable="true">指標 2</th></tr></thead><tbody><tr><td data-topic-editable="true" contenteditable="true">Q1</td><td data-topic-editable="true" contenteditable="true">10</td><td data-topic-editable="true" contenteditable="true">15</td></tr><tr><td data-topic-editable="true" contenteditable="true">Q2</td><td data-topic-editable="true" contenteditable="true">20</td><td data-topic-editable="true" contenteditable="true">18</td></tr><tr><td data-topic-editable="true" contenteditable="true">Q3</td><td data-topic-editable="true" contenteditable="true">15</td><td data-topic-editable="true" contenteditable="true">22</td></tr></tbody></table></div><div class="topic-chart-canvas-area" data-topic-chart-height="220"><canvas class="topic-chart-canvas" contenteditable="false" aria-label="趨勢圖"></canvas></div></div></div>'
    };
    return templates[type] || '';
  }

  function normalizeLayout(value) {
    return ['1', '1:1', '1:2', '2:1'].includes(String(value || '')) ? String(value) : '1';
  }

  function contentToWorkbookRows(content) {
    const normalized = core.normalizeTopicContent(content);
    return normalized.modules.map((module, index) => ({
      項次: index + 1,
      模塊ID: module.id,
      標題: module.title,
      版型: module.colLayout,
      欄1HTML: module.columns[0] || '',
      欄2HTML: module.columns[1] || '',
      PDF勾選: module.selectedForPdf ? '是' : '否',
      PDF順序: Number(module.pdfOrder || index + 1),
      附件名稱: (module.attachments || []).map((attachment) => attachment.name).join('；')
    }));
  }

  function workbookRowsToContent(rows, baseContent, idFactory) {
    const base = core.normalizeTopicContent(baseContent);
    const makeId = typeof idFactory === 'function'
      ? idFactory
      : () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : `module-${Date.now()}-${Math.random()}`);
    const baseById = new Map(base.modules.map((module) => [module.id, module]));
    const normalizedRows = (Array.isArray(rows) ? rows : [])
      .filter((row) => row && (row.標題 || row['欄1HTML'] || row['欄2HTML']))
      .sort((a, b) => Number(a.項次 || 0) - Number(b.項次 || 0));
    const modules = normalizedRows.map((row, index) => {
      const id = String(row.模塊ID || '').trim() || makeId();
      const prior = baseById.get(id);
      const layout = normalizeLayout(row.版型);
      const columnCount = layout === '1' ? 1 : 2;
      const columns = [sanitizeStoredHtml(row.欄1HTML || '')];
      if (columnCount === 2) columns.push(sanitizeStoredHtml(row.欄2HTML || ''));
      return {
        id,
        icon: prior && prior.icon || 'fas fa-file-lines',
        iconColor: prior && prior.iconColor || '#4f46e5',
        title: String(row.標題 || `專題內容 ${index + 1}`).trim().slice(0, 240),
        colLayout: layout,
        colCount: columnCount,
        columns,
        attachments: prior && Array.isArray(prior.attachments) ? clone(prior.attachments) : [],
        selectedForPdf: !['否', 'false', '0', 'no'].includes(String(row.PDF勾選 || '是').toLowerCase()),
        pdfOrder: Math.max(1, Number(row.PDF順序 || index + 1) || index + 1)
      };
    });
    return core.normalizeTopicContent({ ...base, modules: modules.length ? modules : base.modules });
  }

  const state = {
    mounted: false,
    identity: null,
    client: null,
    reportId: '',
    report: null,
    lease: null,
    mode: 'readonly',
    editorWindowId: '',
    currentContent: null,
    dirty: false,
    dirtySince: 0,
    editGeneration: 0,
    printing: false,
    saving: false,
    uncertain: false,
    releaseUncertain: false,
    bootGeneration: 0,
    toastTimer: null,
    draftTimer: null,
    heartbeatTimer: null,
    autosaveTimer: null,
    readonlyTimer: null,
    chartTimer: null,
    charts: new Map(),
    lastRange: null,
    activeEditor: null,
    activeObject: null,
    activeIndicatorCell: null,
    tableResize: null,
    pendingFileModuleId: '',
    broadcastChannel: null,
    released: false
  };

  const $ = (id) => root.document && root.document.getElementById(id);
  function setIconButton(button, iconClass, label) {
    const icon = root.document.createElement('i');
    icon.className = iconClass;
    button.replaceChildren(icon, root.document.createTextNode(String(label || '')));
  }
  function assertTopicAssetBuilds() {
    const builds = root.TOPIC_REPORT_ASSET_BUILDS || {};
    const required = ['core', 'client', 'editor'];
    if (!core || !clientApi || required.some((key) => builds[key] !== BUILD_ID)) {
      throw new Error(`TOPIC_ASSET_BUILD_MISMATCH:${required.map((key) => `${key}=${builds[key] || 'missing'}`).join(',')}`);
    }
  }
  function randomUuid() { return root.crypto.randomUUID(); }
  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }
  function showGate(message) {
    if (!$('topicEditorGate')) return;
    $('topicEditorPage').hidden = true;
    $('topicEditorGate').hidden = false;
    if (message) $('topicEditorGateMessage').textContent = message;
  }
  function showPage() {
    $('topicEditorGate').hidden = true;
    $('topicEditorPage').hidden = false;
  }
  function toast(message, tone = '') {
    const node = $('topicToast');
    if (!node) return;
    root.clearTimeout(state.toastTimer);
    node.textContent = String(message || '');
    node.className = `topic-toast${tone ? ` ${tone}` : ''} show`;
    state.toastTimer = root.setTimeout(() => { node.className = 'topic-toast'; }, 2800);
  }
  function errorLabel(error) {
    const code = String(error && (error.code || error.message) || 'UNKNOWN_ERROR');
    if (code.startsWith('TOPIC_ASSET_BUILD_MISMATCH')) return '專題報告資產版本不一致，請按 Ctrl+F5 重新整理後再試。';
    const labels = {
      TOPIC_IDENTITY_REQUIRED: '找不到已登入身份，請由專題清單或月報系統重新開啟。',
      ENTITY_NOT_FOUND: '找不到這份專題報告。',
      LEASE_HELD: '這份專題目前由其他窗口編輯，本窗口只讀。',
      LEASE_LOST: '編輯權已失效；本機草稿仍保留，本窗口已轉為只讀。',
      REVISION_CONFLICT: '雲端revision已更新；本機草稿仍保留，未覆蓋雲端。',
      USER_SESSION_INVALID: '登入身份已失效，請回月報系統重新登入。',
      SITE_SESSION_INVALID: '進站狀態已失效，請回月報系統重新進站。',
      AUTHORITY_NOT_ACTIVE: '雲端權威模式尚未啟用，已停止專題讀寫。',
      RPC_TIMEOUT: '保存結果尚未確認；內容已保留，請再次按保存確認同一operation。',
      TOPIC_PENDING_SAVE_UNCERTAIN: '上一筆保存結果尚未確認，不能丟棄草稿或釋放編輯權；請先按保存確認。',
      TOPIC_RELEASE_NOT_CONFIRMED: '編輯權釋放尚未獲得確認；草稿仍保留，請稍後重試。',
      TOPIC_PENDING_OPERATION_MISMATCH: '上一筆保存結果尚未確認；請先還原到原內容並重試保存。',
      TOPIC_EDITOR_REPORT_ID_INVALID: '專題報告網址缺少有效report ID。',
      TOPIC_SAVE_SCOPE_INVALID: '保存範圍不完整，已停止寫入。',
      TOPIC_PRINT_CONTENT_CHANGED: '列印等待期間內容已變更；未輸出混合版本，請保存後重新輸出 PDF。',
      TOPIC_PRINT_IMAGE_NOT_READY: '列印圖片尚未完成解碼；已停止輸出，請稍後重試。',
      TOPIC_CHART_PRINT_NOT_READY: '趨勢圖尚未完成繪製；已停止輸出，請稍後重試。'
    };
    if (/Could not find the function|PGRST202|schema cache/i.test(String(error && error.message || ''))) {
      return '專題報告雲端migration尚未安裝；本窗口不會改動月報資料。';
    }
    return labels[code] || `專題報告操作失敗：${code}`;
  }
  function setLeaseNotice(message, tone = '') {
    const node = $('topicLeaseNotice');
    if (!node) return;
    node.textContent = message;
    node.style.color = tone === 'danger' ? '#b91c1c' : tone === 'warning' ? '#92400e' : tone === 'success' ? '#047857' : '#475569';
  }
  function sameOriginOpener() {
    try {
      if (!root.opener || root.opener.closed || root.opener.location.origin !== root.location.origin) return null;
      return root.opener;
    } catch (_error) { return null; }
  }
  function captureIdentity() {
    const stored = clientApi.readIdentityHandoff(root.sessionStorage);
    if (stored) return stored;
    const opener = sameOriginOpener();
    if (!opener) return null;
    let identity = null;
    try {
      if (opener.TopicReportsPage && typeof opener.TopicReportsPage.getIdentity === 'function') {
        identity = opener.TopicReportsPage.getIdentity();
      } else if (opener.TopicReportEditor && typeof opener.TopicReportEditor.getIdentity === 'function') {
        identity = opener.TopicReportEditor.getIdentity();
      } else if (opener.MonthlyV7App) {
        identity = clientApi.captureMonthlyIdentity(opener.MonthlyV7App);
      }
    } catch (_error) { identity = null; }
    return identity ? clientApi.storeIdentityHandoff(root.sessionStorage, identity) : null;
  }
  function consumeLaunch(reportId) {
    const opener = sameOriginOpener();
    try {
      if (opener && opener.TopicReportsPage && typeof opener.TopicReportsPage.consumeEditorLaunch === 'function') {
        return opener.TopicReportsPage.consumeEditorLaunch(reportId);
      }
    } catch (_error) { return null; }
    return null;
  }

  async function uniqueEditorWindowId(reportId, launchId) {
    const key = `topic:v1:editor-window:${reportId}`;
    const stored = root.sessionStorage.getItem(key);
    const navigation = root.performance && root.performance.getEntriesByType
      ? root.performance.getEntriesByType('navigation')[0] : null;
    let candidate = core.UUID_PATTERN.test(String(launchId || '')) ? String(launchId)
      : (navigation && navigation.type === 'reload' && core.UUID_PATTERN.test(String(stored || '')) ? stored : randomUuid());
    if (typeof root.BroadcastChannel === 'function') {
      const channel = new root.BroadcastChannel(`topic:v1:window-registry:${reportId}`);
      const probeId = randomUuid();
      let collision = false;
      const probeHandler = (event) => {
        const data = event.data || {};
        if (data.type === 'probe' && data.editorWindowId === candidate) {
          channel.postMessage({ type: 'present', probeId: data.probeId, editorWindowId: candidate });
        }
        if (data.type === 'present' && data.probeId === probeId && data.editorWindowId === candidate) collision = true;
      };
      channel.addEventListener('message', probeHandler);
      channel.postMessage({ type: 'probe', probeId, editorWindowId: candidate });
      await new Promise((resolve) => root.setTimeout(resolve, 140));
      channel.removeEventListener('message', probeHandler);
      if (collision) candidate = randomUuid();
      channel.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'probe' && data.editorWindowId === state.editorWindowId) {
          channel.postMessage({ type: 'present', probeId: data.probeId, editorWindowId: state.editorWindowId });
        }
      });
      state.broadcastChannel = channel;
    }
    root.sessionStorage.setItem(key, candidate);
    return candidate;
  }

  function renderIdentity() {
    const node = $('topicCurrentUser');
    const user = state.identity && state.identity.user;
    node.replaceChildren();
    if (!user) return;
    const icon = root.document.createElement('i');
    icon.className = 'fas fa-user-circle';
    const name = root.document.createElement('span');
    name.textContent = user.displayName;
    const role = root.document.createElement('span');
    role.className = 'topic-role';
    role.textContent = ({ owner: 'Owner', admin: '管理員', operator: '操作員' })[user.role] || user.role;
    node.append(icon, name, role);
  }

  function moduleById(moduleId) {
    return state.currentContent && state.currentContent.modules.find((module) => module.id === moduleId);
  }
  function createButton(label, iconClass, action, moduleId) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'topic-tool-btn';
    button.dataset.moduleAction = action;
    button.dataset.moduleId = moduleId;
    const icon = root.document.createElement('i');
    icon.className = iconClass;
    button.append(icon, root.document.createTextNode(label));
    return button;
  }
  function attachmentSize(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  function renderAttachments(module, container) {
    container.replaceChildren();
    (module.attachments || []).forEach((attachment) => {
      const row = root.document.createElement('div');
      row.className = 'topic-attachment';
      const icon = root.document.createElement('i');
      icon.className = 'fas fa-paperclip';
      const name = root.document.createElement('span');
      name.className = 'topic-attachment-name';
      name.textContent = `${attachment.name} · ${attachmentSize(attachment.size)}`;
      const download = root.document.createElement('button');
      download.type = 'button';
      download.className = 'topic-tool-btn';
      download.dataset.attachmentAction = 'download';
      download.dataset.moduleId = module.id;
      download.dataset.attachmentId = attachment.id;
      download.textContent = '下載';
      const remove = root.document.createElement('button');
      remove.type = 'button';
      remove.className = 'topic-tool-btn';
      remove.dataset.attachmentAction = 'remove';
      remove.dataset.moduleId = module.id;
      remove.dataset.attachmentId = attachment.id;
      remove.textContent = '移除';
      row.append(icon, name, download, remove);
      container.appendChild(row);
    });
  }

  function renderModules(content) {
    hideObjectToolbar();
    state.charts.forEach((chart) => { try { chart.destroy(); } catch (_error) { /* noop */ } });
    state.charts.clear();
    const rootNode = $('topicModules');
    rootNode.replaceChildren();
    content.modules.forEach((module, index) => {
      const article = root.document.createElement('article');
      article.className = 'topic-module';
      article.dataset.moduleId = module.id;

      const heading = root.document.createElement('div');
      heading.className = 'topic-module-heading';
      const titleRow = root.document.createElement('div');
      titleRow.className = 'topic-module-title-row';
      const icon = root.document.createElement('i');
      icon.className = `${module.icon || 'fas fa-file-lines'} topic-module-icon`;
      if (/^#[0-9a-f]{6}$/i.test(module.iconColor || '')) icon.style.color = module.iconColor;
      const title = root.document.createElement('input');
      title.className = 'topic-module-title';
      title.value = module.title;
      title.maxLength = 240;
      title.dataset.moduleTitle = module.id;
      const count = root.document.createElement('small');
      count.className = 'topic-module-index';
      count.textContent = `項次 ${index + 1}`;
      titleRow.append(icon, title, count);
      heading.append(titleRow);

      const contentCell = root.document.createElement('div');
      contentCell.className = 'topic-module-content';
      const columns = root.document.createElement('div');
      columns.className = 'topic-columns';
      columns.dataset.layout = module.colLayout;
      module.columns.forEach((columnHtml, columnIndex) => {
        const editor = root.document.createElement('div');
        editor.className = 'topic-editable';
        editor.dataset.moduleId = module.id;
        editor.dataset.columnIndex = String(columnIndex);
        editor.contentEditable = state.mode === 'edit' ? 'true' : 'false';
        setSanitizedHtml(editor, columnHtml);
        columns.appendChild(editor);
      });
      const attachments = root.document.createElement('div');
      attachments.className = 'topic-attachments';
      attachments.dataset.attachmentsFor = module.id;
      renderAttachments(module, attachments);
      contentCell.append(columns, attachments);

      const actions = root.document.createElement('div');
      actions.className = 'topic-module-actions no-print';
      const layout = root.document.createElement('select');
      layout.className = 'topic-tool-select';
      layout.dataset.moduleLayout = module.id;
      [['1', '單欄'], ['1:1', '雙欄 1:1'], ['1:2', '雙欄 1:2'], ['2:1', '雙欄 2:1']].forEach(([value, label]) => {
        const option = root.document.createElement('option');
        option.value = value; option.textContent = label; option.selected = module.colLayout === value;
        layout.appendChild(option);
      });
      const pdfLabel = root.document.createElement('label');
      pdfLabel.className = 'topic-tool-btn';
      const pdfCheck = root.document.createElement('input');
      pdfCheck.type = 'checkbox';
      pdfCheck.checked = module.selectedForPdf !== false;
      pdfCheck.dataset.modulePdf = module.id;
      pdfLabel.append(pdfCheck, root.document.createTextNode(' PDF勾選'));
      const pdfOrder = root.document.createElement('input');
      pdfOrder.type = 'number'; pdfOrder.min = '1'; pdfOrder.max = '999';
      pdfOrder.className = 'topic-input topic-pdf-order-input';
      pdfOrder.setAttribute('aria-label', 'PDF順序');
      pdfOrder.title = 'PDF順序';
      pdfOrder.value = String(module.pdfOrder || index + 1);
      pdfOrder.dataset.modulePdfOrder = module.id;
      actions.append(
        layout, pdfLabel, pdfOrder,
        createButton('上移', 'fas fa-arrow-up', 'up', module.id),
        createButton('下移', 'fas fa-arrow-down', 'down', module.id),
        createButton('附件', 'fas fa-paperclip', 'attachment', module.id),
        createButton('刪除', 'fas fa-trash', 'delete', module.id)
      );
      const topbar = root.document.createElement('div');
      topbar.className = 'topic-module-topbar';
      topbar.append(heading, actions);
      article.append(topbar, contentCell);
      rootNode.appendChild(article);
    });
    updateDynamic(rootNode);
    updateControls();
  }

  function renderContent(content) {
    const normalized = core.normalizeTopicContent(content);
    state.editGeneration += 1;
    state.currentContent = normalized;
    $('topicReportTitle').value = normalized.title;
    $('topicReportDate').value = normalized.reportDate;
    $('topicFontEn').value = normalized.settings.globalFontEn || $('topicFontEn').options[0].value;
    $('topicFontZh').value = normalized.settings.globalFontZh || $('topicFontZh').options[0].value;
    renderModules(normalized);
  }
  function updateMeta() {
    if (!state.report) return;
    root.document.title = `${state.report.systemNumber} · ${state.report.title} · 專題報告編輯器`;
    const badge = $('topicModeBadge');
    badge.dataset.mode = state.mode;
    badge.textContent = state.mode === 'edit' ? '可編輯' : '唯讀';
  }
  function updateControls() {
    const editable = state.mode === 'edit' && !state.saving && !state.printing
      && !state.uncertain && !state.releaseUncertain;
    const releaseRecord = state.releaseUncertain ? readReleaseCheck() : null;
    const releaseAction = releaseRecord && releaseRecord.action || 'complete';
    const mutations = root.document.querySelectorAll(
      '[data-command],[data-insert],[data-text-color],#topicFontSize,[data-topic-object-width],[data-topic-object-delete],[data-topic-indicator-action],[data-topic-image-align],[data-topic-trend-action],[data-topic-trend-height],#topicAddModule,#topicExcelImport,#topicReset,#topicComplete,#topicDiscardExit,' +
      '#topicFontEn,#topicFontZh,#topicTextColor,#topicPdfScale,#topicPdfOrientation,' +
      '[data-module-action],[data-module-layout],[data-module-pdf],[data-module-pdf-order]'
    );
    mutations.forEach((control) => { control.disabled = !editable; });
    $('topicSave').disabled = state.saving || state.printing || state.releaseUncertain || (!state.uncertain && state.mode !== 'edit');
    $('topicComplete').disabled = state.saving || state.printing || state.uncertain
      || (state.releaseUncertain ? releaseAction !== 'complete' : state.mode !== 'edit');
    $('topicDiscardExit').disabled = state.saving || state.printing || state.uncertain
      || (state.releaseUncertain ? releaseAction !== 'discard' : state.mode !== 'edit');
    $('topicSync').disabled = state.saving || state.printing || state.releaseUncertain;
    $('topicPrint').disabled = state.saving || state.printing;
    $('topicExcelExport').disabled = state.saving || state.printing;
    root.document.querySelectorAll('[data-footer-action]').forEach((control) => {
      const action = control.dataset.footerAction;
      if (action === 'save') control.disabled = state.saving || state.printing || state.uncertain || state.releaseUncertain || state.mode !== 'edit';
      else if (action === 'discard') {
        control.disabled = state.saving || state.printing || state.uncertain
          || (state.releaseUncertain ? releaseAction !== 'discard' : state.mode !== 'edit');
      } else {
        control.disabled = state.saving || state.printing || state.uncertain
          || (state.releaseUncertain ? releaseAction !== 'complete' : state.mode !== 'edit');
      }
    });
    $('topicReportTitle').readOnly = !editable;
    $('topicReportDate').readOnly = !editable;
    root.document.querySelectorAll('.topic-module-title').forEach((input) => { input.readOnly = !editable; });
    root.document.querySelectorAll('.topic-editable').forEach((editor) => { editor.contentEditable = editable ? 'true' : 'false'; });
    root.document.querySelectorAll('[data-topic-editable="true"]').forEach((element) => { element.contentEditable = editable ? 'true' : 'false'; });
    const acquireBlocked = state.mode === 'edit' || state.saving || state.printing
      || state.uncertain || state.releaseUncertain;
    $('topicAcquireEdit').hidden = acquireBlocked;
    $('topicAcquireEdit').disabled = acquireBlocked;
  }
  function setMode(mode, message, tone = '') {
    state.mode = mode === 'edit' ? 'edit' : 'readonly';
    if (state.mode !== 'edit') {
      hideObjectToolbar();
      root.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    updateMeta();
    updateControls();
    setLeaseNotice(message || (state.mode === 'edit' ? '已取得整份報告編輯權。' : '本窗口目前只讀。'), tone);
  }

  function serializeEditorHtml(editor) {
    const cloneNode = editor.cloneNode(true);
    cloneNode.querySelectorAll('[data-topic-table-resize-handle]').forEach((handle) => handle.remove());
    return sanitizeStoredHtml(cloneNode.innerHTML);
  }

  function collectContent() {
    const base = state.currentContent || core.createBlankTopicContent();
    const modules = Array.from($('topicModules').querySelectorAll('.topic-module')).map((article, index) => {
      const moduleId = article.dataset.moduleId;
      const prior = moduleById(moduleId) || {};
      const layout = normalizeLayout(article.querySelector('[data-module-layout]').value);
      const columns = Array.from(article.querySelectorAll('.topic-editable'))
        .slice(0, layout === '1' ? 1 : 2)
        .map((editor) => serializeEditorHtml(editor));
      while (columns.length < (layout === '1' ? 1 : 2)) columns.push('');
      return {
        id: moduleId,
        icon: prior.icon || 'fas fa-file-lines',
        iconColor: prior.iconColor || '#4f46e5',
        title: article.querySelector('.topic-module-title').value.trim() || `專題內容 ${index + 1}`,
        colLayout: layout,
        colCount: layout === '1' ? 1 : 2,
        columns,
        attachments: clone(prior.attachments || []),
        selectedForPdf: article.querySelector('[data-module-pdf]').checked,
        pdfOrder: Math.max(1, Number(article.querySelector('[data-module-pdf-order]').value || index + 1) || index + 1)
      };
    });
    state.currentContent = core.normalizeTopicContent({
      ...base,
      title: $('topicReportTitle').value.trim(),
      reportDate: $('topicReportDate').value,
      settings: {
        ...base.settings,
        globalFontEn: $('topicFontEn').value,
        globalFontZh: $('topicFontZh').value
      },
      modules
    });
    return clone(state.currentContent);
  }
  function draftScope() {
    return state.client.operationScope('save', state.reportId, state.editorWindowId);
  }
  function releaseCheckKey() {
    return `topic:v1:release-check:${state.reportId}:${state.identity.user.id}:${state.editorWindowId}`;
  }
  function writeReleaseCheck(report, lease, action = 'complete') {
    root.sessionStorage.setItem(releaseCheckKey(), JSON.stringify({
      version: 1,
      domain: 'topic',
      reportId: state.reportId,
      actorUserId: state.identity.user.id,
      editorWindowId: state.editorWindowId,
      action: action === 'discard' ? 'discard' : 'complete',
      report: clone(report),
      lease: clone(lease)
    }));
  }
  function readReleaseCheck() {
    let saved = null;
    try { saved = JSON.parse(root.sessionStorage.getItem(releaseCheckKey()) || 'null'); }
    catch (_error) { /* malformed envelope is removed below */ }
    const valid = saved && saved.version === 1 && saved.domain === 'topic'
      && saved.reportId === state.reportId && saved.actorUserId === state.identity.user.id
      && saved.editorWindowId === state.editorWindowId
      && (!saved.action || ['complete', 'discard'].includes(saved.action))
      && saved.report && saved.report.id === state.reportId
      && saved.lease && core.UUID_PATTERN.test(String(saved.lease.leaseId || ''))
      && Number.isInteger(Number(saved.lease.fencingToken));
    if (!valid) {
      root.sessionStorage.removeItem(releaseCheckKey());
      return null;
    }
    return saved;
  }
  function clearReleaseCheck() {
    root.sessionStorage.removeItem(releaseCheckKey());
    state.releaseUncertain = false;
  }
  function persistDraft() {
    if (!state.client || !state.report || state.mode !== 'edit' || (!state.dirty && !state.uncertain)) return null;
    const content = collectContent();
    state.client.writeDraft(draftScope(), {
      version: 1, domain: 'topic', reportId: state.reportId,
      actorUserId: state.identity.user.id, editorWindowId: state.editorWindowId,
      baseRevision: Number(state.report.revision), content, savedLocallyAt: new Date().toISOString()
    });
    return content;
  }
  function cancelDraftTimer() {
    root.clearTimeout(state.draftTimer);
    state.draftTimer = null;
  }
  function scheduleDraft() {
    cancelDraftTimer();
    state.draftTimer = root.setTimeout(() => {
      state.draftTimer = null;
      try { persistDraft(); } catch (_error) { /* draft must not interrupt typing */ }
    }, 800);
  }
  function markDirty() {
    if (state.mode !== 'edit' || state.saving || state.uncertain) return;
    if (!state.dirty) state.dirtySince = Date.now();
    state.editGeneration += 1;
    state.dirty = true;
    setLeaseNotice('尚未保存；本機草稿將在800ms內更新。', 'warning');
    scheduleDraft();
  }

  function rememberSelection() {
    const selection = root.getSelection && root.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const editor = node && node.closest && node.closest('.topic-editable');
    if (!editor || !$('topicModules').contains(editor)) return;
    state.lastRange = range.cloneRange();
    state.activeEditor = editor;
  }
  function ensureSelection() {
    if (state.lastRange && state.activeEditor && root.document.contains(state.activeEditor)) {
      const selection = root.getSelection();
      selection.removeAllRanges(); selection.addRange(state.lastRange);
      return state.activeEditor;
    }
    const editor = $('topicModules').querySelector('.topic-editable');
    if (!editor) return null;
    editor.focus();
    const range = root.document.createRange();
    range.selectNodeContents(editor); range.collapse(false);
    const selection = root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    state.lastRange = range.cloneRange(); state.activeEditor = editor;
    return editor;
  }
  function insertHtml(html) {
    if (state.mode !== 'edit' || state.saving || state.uncertain) return;
    const editor = ensureSelection();
    if (!editor) return;
    const selection = root.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = sanitizedFragment(html);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
      state.lastRange = range.cloneRange();
    }
    markDirty();
    updateDynamic(editor);
    if (last && last.nodeType === 1) {
      const insertedObject = objectFromTarget(last);
      if (insertedObject) selectObject(insertedObject);
    }
  }
  function runCommand(command, value) {
    if (state.mode !== 'edit') return;
    const editor = ensureSelection();
    if (!editor) return;
    if (command === 'foreColor') root.document.execCommand('styleWithCSS', false, true);
    root.document.execCommand(command, false, value == null ? null : value);
    editor.querySelectorAll('font').forEach((font) => {
      const span = root.document.createElement('span');
      const color = String(font.getAttribute('color') || font.style.color || '');
      if (/^(?:#[0-9a-f]{3,8}|rgb\([0-9 ,.%]+\)|[a-z]+)$/i.test(color)) span.style.color = color;
      span.append(...Array.from(font.childNodes));
      font.replaceWith(span);
    });
    rememberSelection(); markDirty();
  }

  function applyFontSize(value) {
    const size = Number(value);
    if (![12, 14, 16, 18, 20, 24, 28, 32, 40].includes(size) || state.mode !== 'edit') return;
    const editor = ensureSelection();
    const selection = root.getSelection();
    if (!editor || !selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const span = root.document.createElement('span');
    span.style.fontSize = `${size}px`;
    if (range.collapsed) {
      const placeholder = root.document.createTextNode('\u200b');
      span.appendChild(placeholder);
      range.insertNode(span);
      range.setStart(placeholder, 1);
      range.collapse(true);
    } else {
      span.appendChild(range.extractContents());
      range.insertNode(span);
      range.selectNodeContents(span);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    state.lastRange = range.cloneRange();
    state.activeEditor = editor;
    markDirty();
  }

  function objectFromTarget(target) {
    if (!target || !target.closest) return null;
    return target.closest('[data-topic-block]')
      || target.closest('.topic-inline-image,.topic-data-table');
  }
  function hideObjectToolbar() {
    if (state.activeObject && state.activeObject.classList) state.activeObject.classList.remove('topic-object-selected');
    state.activeObject = null;
    state.activeIndicatorCell = null;
    const toolbar = $('topicObjectToolbar');
    if (toolbar) toolbar.hidden = true;
    if ($('topicIndicatorControls')) $('topicIndicatorControls').hidden = true;
    if ($('topicImageControls')) $('topicImageControls').hidden = true;
    if ($('topicTrendControls')) $('topicTrendControls').hidden = true;
  }
  function positionObjectToolbar() {
    const object = state.activeObject;
    const toolbar = $('topicObjectToolbar');
    if (!object || !toolbar || !root.document.contains(object)) { hideObjectToolbar(); return; }
    toolbar.hidden = false;
    const rect = object.getBoundingClientRect();
    const gap = 8;
    let top = rect.top - toolbar.offsetHeight - gap;
    if (top < gap) top = Math.min(root.innerHeight - toolbar.offsetHeight - gap, rect.bottom + gap);
    const left = Math.max(gap, Math.min(root.innerWidth - toolbar.offsetWidth - gap, rect.left));
    toolbar.style.top = `${Math.max(gap, top)}px`;
    toolbar.style.left = `${left}px`;
    const explicitWidth = String(object.style.width || '').trim();
    const current = explicitWidth ? normalizeObjectWidth(explicitWidth) : '';
    toolbar.querySelectorAll('[data-topic-object-width]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Boolean(current) && `${button.dataset.topicObjectWidth}%` === current));
    });
    const imageAlignment = object.classList.contains('topic-inline-image')
      ? normalizeImageAlignment(object.dataset.topicAlign) : '';
    toolbar.querySelectorAll('[data-topic-image-align]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.topicImageAlign === imageAlignment));
    });
  }
  function selectObject(object, target) {
    if (state.mode !== 'edit' || !object || !object.closest('.topic-editable')) return;
    if (state.activeObject && state.activeObject !== object) state.activeObject.classList.remove('topic-object-selected');
    state.activeObject = object;
    object.classList.add('topic-object-selected');
    const isIndicator = object.classList.contains('topic-indicator-card');
    if (isIndicator) {
      normalizeIndicatorCardStructure(object);
      const candidate = target && target.closest && target.closest('td');
      state.activeIndicatorCell = candidate && object.contains(candidate) ? candidate : currentIndicatorCell(object);
    } else state.activeIndicatorCell = null;
    const isImage = object.classList.contains('topic-inline-image');
    const isTrend = object.classList.contains('topic-trend-card');
    $('topicIndicatorControls').hidden = !isIndicator;
    $('topicImageControls').hidden = !isImage;
    $('topicTrendControls').hidden = !isTrend;
    if (isTrend) {
      const area = object.querySelector('.topic-chart-canvas-area');
      $('topicTrendHeight').value = String(normalizeChartHeight(area && area.dataset.topicChartHeight));
    }
    $('topicObjectToolbar').hidden = false;
    root.requestAnimationFrame(positionObjectToolbar);
  }
  function setObjectWidth(value) {
    if (state.mode !== 'edit' || !state.activeObject || !root.document.contains(state.activeObject)) return;
    state.activeObject.style.width = normalizeObjectWidth(value);
    if (state.activeObject.classList.contains('topic-highlight')) state.activeObject.dataset.topicWidthUser = 'true';
    markDirty();
    updateDynamic(state.activeObject.closest('.topic-module') || $('topicModules'));
    positionObjectToolbar();
  }
  function setImageAlignment(value) {
    const image = state.activeObject;
    if (state.mode !== 'edit' || !image || !image.classList.contains('topic-inline-image')) return;
    image.dataset.topicAlign = normalizeImageAlignment(value);
    markDirty();
    positionObjectToolbar();
  }
  function deleteActiveObject() {
    const object = state.activeObject;
    if (state.mode !== 'edit' || !object || !root.document.contains(object)) return;
    if (!root.confirm('確定刪除這個插入內容？')) return;
    const module = object.closest('.topic-module');
    object.querySelectorAll?.('canvas.topic-chart-canvas').forEach((canvas) => {
      const chart = state.charts.get(canvas);
      if (chart) { try { chart.destroy(); } catch (_error) { /* noop */ } state.charts.delete(canvas); }
    });
    object.remove();
    hideObjectToolbar();
    markDirty();
    updateDynamic(module || $('topicModules'));
  }
  function setTrendHeight(value) {
    const card = state.activeObject;
    if (!card || !card.classList.contains('topic-trend-card')) return;
    const area = card.querySelector('.topic-chart-canvas-area');
    if (!area) return;
    const height = normalizeChartHeight(value);
    area.dataset.topicChartHeight = String(height);
    area.style.height = `${height}px`;
    $('topicTrendHeight').value = String(height);
    markDirty();
    updateDynamic(card);
    positionObjectToolbar();
  }
  function createTrendCell(tag, text) {
    const cell = root.document.createElement(tag);
    cell.dataset.topicEditable = 'true';
    cell.contentEditable = state.mode === 'edit' ? 'true' : 'false';
    cell.textContent = text;
    return cell;
  }
  function trendAction(action) {
    const card = state.activeObject;
    const table = card && card.classList.contains('topic-trend-card') && card.querySelector('.topic-chart-data');
    if (!table || state.mode !== 'edit') return;
    const header = table.tHead && table.tHead.rows[0];
    const body = table.tBodies[0] || table.createTBody();
    if (!header) return;
    if (action === 'series-add') {
      if (header.cells.length >= 6) { toast('最多支援5個指標。', 'warning'); return; }
      header.appendChild(createTrendCell('th', `指標 ${header.cells.length}`));
      Array.from(body.rows).forEach((row) => row.appendChild(createTrendCell('td', '0')));
    } else if (action === 'series-remove') {
      if (header.cells.length <= 2) { toast('至少保留1個指標。', 'warning'); return; }
      Array.from(table.rows).forEach((row) => row.deleteCell(-1));
    } else if (action === 'period-add') {
      if (body.rows.length >= 24) { toast('最多支援24個週期。', 'warning'); return; }
      const row = body.insertRow();
      row.appendChild(createTrendCell('td', `新週期 ${body.rows.length}`));
      for (let index = 1; index < header.cells.length; index += 1) row.appendChild(createTrendCell('td', '0'));
    } else if (action === 'period-remove') {
      if (body.rows.length <= 1) { toast('至少保留1個週期。', 'warning'); return; }
      body.deleteRow(-1);
    } else return;
    markDirty();
    updateDynamic(card);
    selectObject(card);
  }

  function createIndicatorCell(text) {
    const cell = root.document.createElement('td');
    cell.dataset.topicEditable = 'true';
    cell.contentEditable = state.mode === 'edit' ? 'true' : 'false';
    cell.textContent = String(text == null ? '' : text);
    return cell;
  }

  function normalizeIndicatorCardStructure(card) {
    if (!card || !card.classList || !card.classList.contains('topic-indicator-card')) return 0;
    let body = card.tBodies && card.tBodies[0];
    if (!body) body = card.createTBody();
    if (!body.rows.length) {
      const row = body.insertRow();
      row.append(createIndicatorCell('新指標'), createIndicatorCell('0'));
    }
    const columnCount = Math.max(2, ...Array.from(body.rows).map((row) => row.cells.length));
    Array.from(body.rows).forEach((row) => {
      while (row.cells.length < columnCount) row.appendChild(createIndicatorCell(row.cells.length === 0 ? '新指標' : '0'));
    });

    let head = card.tHead;
    if (!head) head = card.createTHead();
    let headerRow = head.rows[0];
    if (!headerRow) headerRow = head.insertRow();
    let title = headerRow.cells[0];
    if (!title) {
      title = root.document.createElement('th');
      title.className = 'topic-indicator-title';
      title.textContent = '指標名稱';
      headerRow.appendChild(title);
    }
    while (headerRow.cells.length > 1) headerRow.deleteCell(-1);
    title.classList.add('topic-indicator-title');
    title.dataset.topicEditable = 'true';
    title.contentEditable = state.mode === 'edit' ? 'true' : 'false';
    title.colSpan = columnCount;

    let colgroup = Array.from(card.children).find((child) => child.tagName === 'COLGROUP');
    if (!colgroup) {
      colgroup = root.document.createElement('colgroup');
      card.insertBefore(colgroup, card.firstChild);
    }
    const widths = columnCount === 2
      ? [66.66, 33.34]
      : [50, ...Array.from({ length: columnCount - 1 }, () => 50 / (columnCount - 1))];
    const columns = widths.map((width) => {
      const column = root.document.createElement('col');
      column.style.width = `${Math.round(width * 1000) / 1000}%`;
      return column;
    });
    colgroup.replaceChildren(...columns);
    return columnCount;
  }

  function currentIndicatorCell(card) {
    const cell = state.activeIndicatorCell;
    if (cell && root.document.contains(cell) && card.contains(cell) && cell.tagName === 'TD') return cell;
    const body = card.tBodies && card.tBodies[0];
    return body && body.rows[0] && body.rows[0].cells[0] || null;
  }

  function indicatorAction(action) {
    const card = state.activeObject;
    if (state.mode !== 'edit' || !card || !card.classList.contains('topic-indicator-card')) return;
    const body = card.tBodies[0] || card.createTBody();
    const columnCount = normalizeIndicatorCardStructure(card);
    let cell = currentIndicatorCell(card);
    if (!cell) return;
    let row = cell.parentElement;
    let rowIndex = Array.from(body.rows).indexOf(row);
    let columnIndex = Array.from(row.cells).indexOf(cell);

    if (action === 'row-before' || action === 'row-after') {
      if (body.rows.length >= 20) { toast('指標卡最多支援20個資料列。', 'warning'); return; }
      const insertIndex = rowIndex + (action === 'row-after' ? 1 : 0);
      const newRow = body.insertRow(insertIndex);
      for (let index = 0; index < columnCount; index += 1) {
        newRow.appendChild(createIndicatorCell(index === 0 ? '新指標' : '0'));
      }
      state.activeIndicatorCell = newRow.cells[Math.min(columnIndex, columnCount - 1)];
    } else if (action === 'row-remove') {
      if (body.rows.length <= 1) { toast('指標卡至少保留1個資料列。', 'warning'); return; }
      body.deleteRow(rowIndex);
      rowIndex = Math.min(rowIndex, body.rows.length - 1);
      state.activeIndicatorCell = body.rows[rowIndex].cells[Math.min(columnIndex, columnCount - 1)];
    } else if (action === 'column-before' || action === 'column-after') {
      if (columnCount >= 10) { toast('指標卡最多支援10欄。', 'warning'); return; }
      const insertIndex = columnIndex + (action === 'column-after' ? 1 : 0);
      Array.from(body.rows).forEach((dataRow) => {
        const newCell = dataRow.insertCell(insertIndex);
        newCell.dataset.topicEditable = 'true';
        newCell.contentEditable = 'true';
        newCell.textContent = insertIndex === 0 ? '新欄位' : '0';
      });
      state.activeIndicatorCell = body.rows[rowIndex].cells[insertIndex];
    } else if (action === 'column-remove') {
      if (columnCount <= 2) { toast('指標卡至少保留名稱與數值2欄。', 'warning'); return; }
      Array.from(body.rows).forEach((dataRow) => dataRow.deleteCell(columnIndex));
      columnIndex = Math.min(columnIndex, columnCount - 2);
      state.activeIndicatorCell = body.rows[rowIndex].cells[columnIndex];
    } else return;

    normalizeIndicatorCardStructure(card);
    markDirty();
    updateDynamic(card);
    selectObject(card, state.activeIndicatorCell);
  }

  function makeTable() {
    const rows = Math.max(1, Math.min(20, Number(root.prompt('表格列數', '3')) || 3));
    const columns = Math.max(1, Math.min(10, Number(root.prompt('表格欄數', '3')) || 3));
    const columnWidth = Math.round((100 / columns) * 1000) / 1000;
    let html = '<table class="topic-data-table topic-resizable-table" data-topic-table="resizable" style="width:100%"><colgroup>';
    for (let column = 0; column < columns; column += 1) html += `<col style="width:${columnWidth}%">`;
    html += '</colgroup><tbody>';
    for (let row = 0; row < rows; row += 1) {
      html += '<tr>';
      for (let column = 0; column < columns; column += 1) {
        const tag = row === 0 ? 'th' : 'td';
        html += `<${tag} data-topic-editable="true" contenteditable="true">${row === 0 ? `欄${column + 1}` : ''}</${tag}>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  function normalizeTableColumns(table) {
    const firstRow = table.rows && table.rows[0];
    const count = firstRow ? firstRow.cells.length : 0;
    if (count < 2) return [];
    let colgroup = Array.from(table.children).find((child) => child.tagName === 'COLGROUP');
    if (!colgroup) {
      colgroup = root.document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    let columns = Array.from(colgroup.children).filter((child) => child.tagName === 'COL');
    if (columns.length !== count) {
      colgroup.replaceChildren();
      const width = 100 / count;
      for (let index = 0; index < count; index += 1) {
        const column = root.document.createElement('col');
        column.style.width = `${Math.round(width * 1000) / 1000}%`;
        colgroup.appendChild(column);
      }
      columns = Array.from(colgroup.children);
    }
    const parsed = columns.map((column) => Number.parseFloat(column.style.width));
    const valid = parsed.every((width) => Number.isFinite(width) && width > 0);
    const total = valid ? parsed.reduce((sum, width) => sum + width, 0) : 0;
    if (!valid || total <= 0) {
      const width = 100 / count;
      columns.forEach((column) => { column.style.width = `${Math.round(width * 1000) / 1000}%`; });
    } else if (Math.abs(total - 100) > 0.01) {
      columns.forEach((column, index) => {
        column.style.width = `${Math.round((parsed[index] / total * 100) * 1000) / 1000}%`;
      });
    }
    return columns;
  }

  function prepareResizableTables(scope) {
    scope.querySelectorAll('table.topic-resizable-table,table.topic-data-table:not(.topic-indicator-card):not(.topic-chart-data):not([data-topic-block])').forEach((table) => {
      const columns = normalizeTableColumns(table);
      if (columns.length < 2) return;
      table.classList.add('topic-resizable-table');
      table.dataset.topicTable = 'resizable';
      table.querySelectorAll('[data-topic-table-resize-handle]').forEach((handle) => handle.remove());
      const headerCells = Array.from(table.rows[0].cells);
      headerCells.slice(0, -1).forEach((cell, index) => {
        const handle = root.document.createElement('span');
        handle.className = 'topic-table-resize-handle';
        handle.dataset.topicTableResizeHandle = String(index);
        handle.contentEditable = 'false';
        handle.title = '拖曳調整欄寬';
        handle.setAttribute('aria-hidden', 'true');
        cell.appendChild(handle);
      });
    });
  }

  function startTableResize(event, handle) {
    if (state.mode !== 'edit') return;
    const table = handle.closest('table.topic-resizable-table');
    const columns = table ? normalizeTableColumns(table) : [];
    const index = Number.parseInt(handle.dataset.topicTableResizeHandle, 10);
    if (!table || !Number.isInteger(index) || index < 0 || index >= columns.length - 1) return;
    const widths = columns.map((column) => Number.parseFloat(column.style.width));
    const tableWidth = table.getBoundingClientRect().width;
    if (!(tableWidth > 0)) return;
    state.tableResize = {
      pointerId: event.pointerId,
      table,
      columns,
      index,
      startX: event.clientX,
      tableWidth,
      startLeft: widths[index],
      startRight: widths[index + 1],
      moved: false
    };
    try { handle.setPointerCapture(event.pointerId); } catch (_error) { /* document listeners still complete the drag */ }
    root.document.body.classList.add('topic-table-resizing');
    event.preventDefault();
    event.stopPropagation();
  }

  function moveTableResize(event) {
    const resize = state.tableResize;
    if (!resize || event.pointerId !== resize.pointerId) return;
    const pairTotal = resize.startLeft + resize.startRight;
    const maximumMinimum = Math.max(1, pairTotal / 2 - 0.1);
    const minimum = Math.min(maximumMinimum, Math.max(8, 70 / resize.tableWidth * 100));
    const delta = (event.clientX - resize.startX) / resize.tableWidth * 100;
    const left = Math.max(minimum, Math.min(pairTotal - minimum, resize.startLeft + delta));
    const roundedLeft = Math.round(left * 1000) / 1000;
    const roundedRight = Math.round((pairTotal - roundedLeft) * 1000) / 1000;
    resize.columns[resize.index].style.width = `${roundedLeft}%`;
    resize.columns[resize.index + 1].style.width = `${roundedRight}%`;
    resize.moved = resize.moved || Math.abs(delta) > 0.05;
    event.preventDefault();
  }

  function finishTableResize(event) {
    const resize = state.tableResize;
    if (!resize || (event && event.pointerId !== resize.pointerId)) return;
    state.tableResize = null;
    root.document.body.classList.remove('topic-table-resizing');
    if (resize.moved) markDirty();
  }

  function numericText(container, selector, fallback) {
    const value = Number(String(container.querySelector(selector)?.textContent || '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(value) ? value : fallback;
  }
  function updateDynamic(container) {
    const scope = container || $('topicModules');
    if (!scope) return;
    scope.querySelectorAll('table.topic-indicator-card').forEach((table) => normalizeIndicatorCardStructure(table));
    prepareResizableTables(scope);
    scope.querySelectorAll('.topic-highlight').forEach((highlight) => {
      if (highlight.style.width === '25%' && highlight.dataset.topicWidthUser !== 'true') {
        highlight.style.removeProperty('width');
      }
    });
    scope.querySelectorAll('.topic-kpi-card').forEach((card) => {
      const min = numericText(card, '.topic-metric-min', 0);
      const max = numericText(card, '.topic-metric-max', 100);
      const current = numericText(card, '.topic-metric-current', min);
      const target = numericText(card, '.topic-metric-target', max);
      const average = numericText(card, '.topic-metric-avg', min);
      const positions = [
        ['.topic-kpi-current-marker', current],
        ['.topic-kpi-target-marker', target],
        ['.topic-kpi-avg-marker', average]
      ];
      positions.forEach(([selector, value]) => {
        const marker = card.querySelector(selector);
        if (marker) marker.style.left = `${clampedPercent(value, min, max)}%`;
      });
    });
    scope.querySelectorAll('.topic-progress-card').forEach((card) => {
      const current = Math.max(0, Math.min(100, numericText(card, '.topic-metric-current', 0)));
      const fill = card.querySelector('.topic-progress-fill');
      const marker = card.querySelector('.topic-progress-marker');
      if (fill) fill.style.width = `${current}%`;
      if (marker) marker.style.left = `${current}%`;
    });
    scope.querySelectorAll('.topic-zone-card').forEach((card) => {
      const min = numericText(card, '.topic-metric-min', 0);
      const max = numericText(card, '.topic-metric-max', 5);
      const limit1 = numericText(card, '.topic-zone-limit1', 1.45);
      const limitMid = numericText(card, '.topic-zone-limit-mid', 2.45);
      const limit2 = numericText(card, '.topic-zone-limit2', 3.45);
      const current = numericText(card, '.topic-metric-current', min);
      const p1 = clampedPercent(limit1, min, max);
      const pMid = clampedPercent(limitMid, min, max);
      const p2 = Math.max(p1, clampedPercent(limit2, min, max));
      const currentPercent = clampedPercent(current, min, max);
      const track = card.querySelector('.topic-zone-track');
      if (track) track.style.background = `linear-gradient(90deg,#22c55e 0 ${p1}%,#eab308 ${p1}% ${p2}%,#ef4444 ${p2}% 100%)`;
      const positions = [
        ['.topic-zone-limit1', p1], ['.topic-zone-limit-mid', pMid],
        ['.topic-zone-limit2', p2], ['.topic-zone-marker', currentPercent]
      ];
      positions.forEach(([selector, value]) => {
        const target = card.querySelector(selector);
        if (target) target.style.left = `${value}%`;
      });
    });
    scope.querySelectorAll('.topic-chart-canvas-area').forEach((area) => {
      const height = normalizeChartHeight(area.dataset.topicChartHeight);
      area.dataset.topicChartHeight = String(height);
      area.style.height = `${height}px`;
    });
    root.clearTimeout(state.chartTimer);
    state.chartTimer = root.setTimeout(renderCharts, 120);
  }
  function chartValues(card) {
    const headers = Array.from(card.querySelectorAll('.topic-chart-data thead th'));
    const labels = [];
    const series = headers.slice(1).map((header, index) => ({
      label: String(header.textContent || '').trim() || `指標 ${index + 1}`,
      values: []
    }));
    card.querySelectorAll('.topic-chart-data tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('th,td'));
      if (cells.length < 2) return;
      labels.push(String(cells[0].textContent || '').trim());
      series.forEach((item, index) => {
        const value = Number(String(cells[index + 1]?.textContent || '').replace(/[^0-9.-]/g, ''));
        item.values.push(Number.isFinite(value) ? value : 0);
      });
    });
    return { labels, series };
  }
  function createChartForCard(card, chartMap, options = {}) {
    const canvas = card.querySelector('canvas.topic-chart-canvas');
    const area = card.querySelector('.topic-chart-canvas-area');
    if (!canvas || !area || !root.Chart) return null;
    const height = normalizeChartHeight(area.dataset.topicChartHeight);
    const responsive = options.responsive !== false;
    area.dataset.topicChartHeight = String(height);
    area.style.height = `${height}px`;
    if (responsive) {
      canvas.removeAttribute('width');
      canvas.removeAttribute('height');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    } else {
      const width = Math.max(320, Number(options.width) || 720);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const existing = chartMap.get(canvas);
    if (existing) { try { existing.destroy(); } catch (_error) { /* noop */ } }
    const attached = typeof root.Chart.getChart === 'function' ? root.Chart.getChart(canvas) : null;
    if (attached && attached !== existing) { try { attached.destroy(); } catch (_error) { /* noop */ } }
    const palette = ['#4f46e5', '#0f766e', '#dc2626', '#ca8a04', '#7c3aed'];
    const data = chartValues(card);
    const datasets = data.series.map((item, index) => ({
      label: item.label,
      data: item.values,
      borderColor: palette[index % palette.length],
      backgroundColor: `${palette[index % palette.length]}22`,
      borderWidth: 2,
      pointRadius: 3,
      fill: false,
      tension: .28
    }));
    const chart = new root.Chart(canvas, {
      type: 'line',
      data: { labels: data.labels, datasets },
      options: {
        responsive,
        maintainAspectRatio: false,
        animation: false,
        resizeDelay: responsive ? 80 : 0,
        layout: { padding: { top: 8, right: 8 } },
        plugins: { legend: { display: true, position: 'top' } },
        scales: { y: { beginAtZero: true }, x: { grid: { display: false } } }
      }
    });
    chartMap.set(canvas, chart);
    return chart;
  }

  function renderCharts() {
    if (!root.Chart || !$('topicModules')) return;
    state.charts.forEach((chart, canvas) => {
      if (!root.document.contains(canvas)) {
        try { chart.destroy(); } catch (_error) { /* noop */ }
        state.charts.delete(canvas);
      }
    });
    $('topicModules').querySelectorAll('.topic-trend-card').forEach((card) => {
      createChartForCard(card, state.charts);
    });
  }

  function activeModuleId() {
    const editor = state.activeEditor && root.document.contains(state.activeEditor)
      ? state.activeEditor : $('topicModules').querySelector('.topic-editable');
    return editor && editor.closest('.topic-module')?.dataset.moduleId || state.currentContent.modules[0]?.id || '';
  }
  function changeLayout(moduleId, layout) {
    const content = collectContent();
    const module = content.modules.find((item) => item.id === moduleId);
    if (!module) return;
    const next = normalizeLayout(layout);
    if (module.columns.length > 1 && next === '1') {
      if (!root.confirm('切換單欄會把右欄接到左欄下方，是否繼續？')) {
        renderContent(content); return;
      }
      module.columns = [`${module.columns[0]}<hr>${module.columns[1]}`];
    } else if (module.columns.length === 1 && next !== '1') module.columns.push('');
    module.colLayout = next; module.colCount = next === '1' ? 1 : 2;
    renderContent(content); markDirty();
  }
  function addModule() {
    const content = collectContent();
    content.modules.push({
      id: randomUuid(), icon: 'fas fa-file-lines', iconColor: '#4f46e5',
      title: `專題內容 ${content.modules.length + 1}`, colLayout: '1', colCount: 1,
      columns: [''], attachments: [], selectedForPdf: true, pdfOrder: content.modules.length + 1
    });
    renderContent(content); markDirty();
    $('topicModules').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function moduleAction(action, moduleId) {
    const content = collectContent();
    const index = content.modules.findIndex((module) => module.id === moduleId);
    if (index < 0) return;
    if (action === 'delete') {
      if (content.modules.length === 1) { toast('至少保留一個專題項次。', 'danger'); return; }
      if (!root.confirm(`確定刪除「${content.modules[index].title}」？`)) return;
      content.modules.splice(index, 1);
    } else if (action === 'up' && index > 0) {
      [content.modules[index - 1], content.modules[index]] = [content.modules[index], content.modules[index - 1]];
    } else if (action === 'down' && index < content.modules.length - 1) {
      [content.modules[index + 1], content.modules[index]] = [content.modules[index], content.modules[index + 1]];
    } else if (action === 'attachment') {
      state.pendingFileModuleId = moduleId;
      $('topicAttachmentFile').click();
      return;
    }
    content.modules.forEach((module, order) => { if (!module.pdfOrder) module.pdfOrder = order + 1; });
    renderContent(content); markDirty();
  }

  function fileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('FILE_READ_FAILED'));
      reader.readAsDataURL(file);
    });
  }
  async function insertImageFile(file) {
    if (!isAllowedImage(file)) throw new Error('圖片僅支援PNG/JPEG/WebP/GIF，且不得超過5MB。');
    const dataUrl = await fileDataUrl(file);
    if (!isSafeImageDataUrl(dataUrl)) throw new Error('圖片資料格式不安全。');
    insertHtml(`<img class="topic-inline-image" data-topic-align="center" style="width:45%" src="${dataUrl}" alt="${escapeHtml(file.name || '專題報告圖片')}">`);
  }
  function totalAttachmentBytes(content) {
    return content.modules.reduce((total, module) => total + (module.attachments || []).reduce((sum, item) => sum + Number(item.size || 0), 0), 0);
  }
  async function addAttachmentFile(file) {
    if (!isAllowedAttachment(file)) throw new Error('附件類型不允許，或單檔超過6MB。');
    const content = collectContent();
    if (totalAttachmentBytes(content) + Number(file.size) > ATTACHMENT_TOTAL_MAX_BYTES) throw new Error('本報告附件總量不得超過16MB。');
    const module = content.modules.find((item) => item.id === state.pendingFileModuleId) || content.modules[0];
    const dataUrl = await fileDataUrl(file);
    if (!/^data:[^;,]+;base64,[a-z0-9+/=\s]+$/i.test(dataUrl)) throw new Error('附件資料格式不安全。');
    module.attachments.push({ id: randomUuid(), name: String(file.name).slice(0, 240), type: String(file.type || 'application/octet-stream'), size: Number(file.size), dataUrl });
    renderContent(content); markDirty();
  }
  function attachmentAction(action, moduleId, attachmentId) {
    const content = collectContent();
    const module = content.modules.find((item) => item.id === moduleId);
    const attachment = module && module.attachments.find((item) => item.id === attachmentId);
    if (!attachment) return;
    if (action === 'download') {
      if (!isSafeAttachmentDataUrl(attachment)) throw new Error('附件資料與允許的類型或大小不一致，已阻止下載。');
      const anchor = root.document.createElement('a');
      anchor.href = attachment.dataUrl; anchor.download = core.sanitizeExportName(attachment.name, 'attachment');
      anchor.rel = 'noopener'; anchor.click();
      return;
    }
    if (state.mode !== 'edit') return;
    module.attachments = module.attachments.filter((item) => item.id !== attachmentId);
    renderContent(content); markDirty();
  }

  async function handleSaveFailure(error) {
    try { persistDraft(); } catch (_draftError) { /* preserve existing draft */ }
    const code = String(error && (error.code || error.message) || '');
    if (code === 'RPC_TIMEOUT') {
      state.uncertain = true;
      setLeaseNotice(errorLabel(error), 'warning');
    } else if (['LEASE_LOST', 'REVISION_CONFLICT'].includes(code)) {
      if (code === 'REVISION_CONFLICT' && state.lease) {
        state.client.releaseLease({ reportId: state.reportId, editorWindowId: state.editorWindowId, lease: state.lease }).catch(() => {});
      }
      state.lease = null;
      setMode('readonly', errorLabel(error), 'danger');
    } else if (/SESSION_INVALID/.test(code)) showGate(errorLabel(error));
    if (code !== 'RPC_TIMEOUT' && state.client && state.report
      && !state.client.readPending(draftScope())) state.uncertain = false;
    toast(errorLabel(error), 'danger');
  }
  async function reconcilePendingSave(options = {}) {
    const scope = draftScope();
    const pending = state.client.readPending(scope);
    if (!pending || pending.operationType !== 'save') {
      const error = new Error('TOPIC_PENDING_SAVE_NOT_FOUND');
      error.code = 'TOPIC_PENDING_SAVE_NOT_FOUND';
      throw error;
    }
    const result = await state.client.retryPendingOperation(pending);
    if (!result || !result.report || result.report.id !== state.reportId) {
      throw new Error('TOPIC_PENDING_SAVE_RESULT_INVALID');
    }
    const returnedLease = result.lease || null;
    if (!state.lease || (returnedLease && returnedLease.leaseId === state.lease.leaseId
      && Number(returnedLease.fencingToken) === Number(state.lease.fencingToken))) {
      state.lease = returnedLease || state.lease;
    }
    state.report = result.report;
    state.currentContent = core.normalizeTopicContent(result.report.content);
    state.client.clearDraft(scope);
    cancelDraftTimer();
    state.dirty = false; state.dirtySince = 0; state.uncertain = false;
    updateMeta();
    setLeaseNotice(`已保存至雲端 R${state.report.revision} · ${formatDateTime(state.report.updatedAt)}`, 'success');
    if (!options.silent) toast(`已確認保存 R${state.report.revision}`, 'success');
    return result;
  }

  async function saveNow(options = {}) {
    if (state.saving) throw new Error('SAVE_IN_PROGRESS');
    if (state.uncertain) {
      state.saving = true; updateControls();
      setLeaseNotice('正在確認上一筆保存operation…', 'warning');
      try {
        return await reconcilePendingSave(options);
      } catch (error) {
        await handleSaveFailure(error);
        throw error;
      } finally { state.saving = false; updateControls(); }
    }
    if (state.mode !== 'edit') throw new Error('LEASE_LOST');
    const content = collectContent();
    if (!content.title || !content.reportDate) throw new Error('專題名稱與報告日期不可空白。');
    state.saving = true; updateControls();
    setLeaseNotice(state.uncertain ? '正在確認上一筆保存operation…' : '正在保存至專題雲端authority…');
    try {
      const result = await state.client.saveReport({
        report: state.report, lease: state.lease, editorWindowId: state.editorWindowId,
        content, status: state.report.status || 'draft'
      });
      state.report = result.report;
      state.lease = result.lease || state.lease;
      state.currentContent = core.normalizeTopicContent(result.report.content);
      cancelDraftTimer();
      state.dirty = false; state.dirtySince = 0; state.uncertain = false;
      updateMeta();
      setLeaseNotice(`已保存至雲端 R${state.report.revision} · ${formatDateTime(state.report.updatedAt)}`, 'success');
      if (!options.silent) toast(`已保存 R${state.report.revision}`, 'success');
      return result;
    } catch (error) {
      await handleSaveFailure(error);
      throw error;
    } finally { state.saving = false; updateControls(); }
  }
  async function retryReleaseCheck() {
    const record = readReleaseCheck();
    if (!record) throw new Error('TOPIC_RELEASE_CHECK_NOT_FOUND');
    try {
      await state.client.releaseLease({
        reportId: state.reportId,
        editorWindowId: state.editorWindowId,
        lease: record.lease
      });
    } catch (error) {
      const code = String(error && (error.code || error.message) || '');
      if (code !== 'LEASE_LOST') throw error;
    }
    const discarded = record.action === 'discard';
    state.report = record.report;
    state.currentContent = core.normalizeTopicContent(record.report.content);
    if (discarded) {
      state.client.clearDraft(draftScope());
      cancelDraftTimer();
      renderContent(record.report.content);
    }
    clearReleaseCheck();
    state.lease = null; state.released = true; state.dirty = false; state.dirtySince = 0;
    setMode(
      'readonly',
      discarded
        ? `已放棄未保存修改並釋放編輯權；雲端仍為 R${state.report.revision}。`
        : `已完成編輯，編輯權已釋放；保存 R${state.report.revision}。`,
      'success'
    );
    toast(discarded ? '未保存修改已放棄，編輯權已釋放' : '完成編輯並已釋放', 'success');
    return discarded
      ? { discarded: true, released: true, report: clone(state.report) }
      : { saved: clone(state.report), released: true };
  }

  function exitToTopicList() {
    const opener = sameOriginOpener();
    if (opener && opener.TopicReportsPage) {
      try { opener.TopicReportsPage.refresh(); } catch (_error) { /* list will also auto-refresh */ }
      opener.focus();
      root.close();
      return;
    }
    root.location.replace('./topic-reports.html');
  }

  async function discardAndExit() {
    if (state.saving) return null;
    const pendingSave = state.client && state.client.readPending(draftScope());
    if (state.uncertain || pendingSave) {
      const error = new Error('TOPIC_PENDING_SAVE_UNCERTAIN');
      error.code = 'TOPIC_PENDING_SAVE_UNCERTAIN';
      throw error;
    }
    if (state.releaseUncertain) {
      const record = readReleaseCheck();
      if (!record || record.action !== 'discard') throw new Error('TOPIC_RELEASE_CHECK_ACTION_MISMATCH');
      state.saving = true; updateControls();
      setLeaseNotice('正在確認上一筆放棄編輯的釋放結果；草稿確認前仍保留…', 'warning');
      try {
        const result = await retryReleaseCheck();
        exitToTopicList();
        return result;
      } catch (error) {
        setLeaseNotice('釋放結果仍未確認；草稿未清除，請稍後再按「不保存並退出」。', 'warning');
        throw error;
      } finally { state.saving = false; updateControls(); }
    }
    if (state.mode !== 'edit' || !state.lease) throw new Error('LEASE_LOST');
    if (!root.confirm('確定放棄本窗口所有未保存修改並退出？\n\n此操作不會保存，也不會新增雲端 Revision。')) return null;

    persistDraft();
    cancelDraftTimer();
    writeReleaseCheck(state.report, state.lease, 'discard');
    state.releaseUncertain = true;
    state.saving = true;
    setMode('readonly', '正在釋放編輯權；收到ACK前草稿仍保留且不會保存…', 'warning');
    try {
      const result = await retryReleaseCheck();
      exitToTopicList();
      return result;
    } catch (error) {
      state.releaseUncertain = true;
      setMode('readonly', '釋放結果未確認；草稿仍保留，請稍後再按「不保存並退出」確認。', 'warning');
      throw error;
    } finally { state.saving = false; updateControls(); }
  }

  async function completeEditing() {
    if (state.saving) return null;
    if (state.releaseUncertain) {
      state.saving = true; updateControls();
      setLeaseNotice('正在確認上一筆編輯權釋放結果…', 'warning');
      try { return await retryReleaseCheck(); }
      catch (error) {
        setLeaseNotice(`內容已保存至 R${state.report.revision}；釋放結果未確認，請稍後再按完成編輯。`, 'warning');
        toast(errorLabel(error), 'warning');
        return { saved: clone(state.report), releasePending: true };
      } finally { state.saving = false; updateControls(); }
    }
    if (state.mode !== 'edit' || state.uncertain) throw new Error(state.uncertain ? 'RPC_TIMEOUT' : 'LEASE_LOST');
    const content = collectContent();
    if (!root.confirm('完成編輯會先保存，收到雲端ACK後立即釋放編輯權。是否繼續？')) return null;
    state.saving = true; updateControls();
    setLeaseNotice('正在保存並確認無pending；尚未釋放編輯權…');
    let saved = null;
    try {
      const saveResult = await state.client.saveReport({
        report: state.report, lease: state.lease, editorWindowId: state.editorWindowId,
        content, status: 'final'
      });
      saved = saveResult.report;
      state.report = saved;
      state.currentContent = core.normalizeTopicContent(saved.content);
      cancelDraftTimer();
      state.dirty = false; state.dirtySince = 0; state.uncertain = false;
      writeReleaseCheck(saved, state.lease);
      state.releaseUncertain = true;
      setMode('readonly', `內容已保存至 R${saved.revision}；正在釋放編輯權…`, 'warning');
    } catch (error) {
      await handleSaveFailure(error);
      throw error;
    }
    try {
      return await retryReleaseCheck();
    } catch (error) {
      const code = String(error && (error.code || error.message) || '');
      if (/SESSION_INVALID/.test(code)) showGate(errorLabel(error));
      setLeaseNotice(`內容已保存至 R${saved.revision}；釋放結果未確認，請稍後再按完成編輯。`, 'warning');
      toast('內容已保存；編輯權釋放結果待確認', 'warning');
      return { saved: clone(saved), releasePending: true };
    } finally { state.saving = false; updateControls(); }
  }
  async function syncLatest() {
    if (state.saving) return;
    if (state.uncertain) {
      await saveNow();
      return;
    }
    if (state.dirty) {
      persistDraft();
      if (!root.confirm('目前有未保存內容；本機草稿會保留。是否以雲端最新revision重新載入？')) return;
    }
    state.saving = true; updateControls();
    try {
      const result = await state.client.getReport(state.reportId);
      if (state.mode === 'edit' && state.lease) {
        try {
          state.lease = await state.client.heartbeatLease({ reportId: state.reportId, editorWindowId: state.editorWindowId, lease: state.lease });
        } catch (error) {
          state.lease = null;
          setMode('readonly', errorLabel(error), 'danger');
        }
      }
      state.report = result.report;
      renderContent(result.report.content);
      state.dirty = false; state.dirtySince = 0;
      updateMeta();
      setLeaseNotice(`已讀取雲端 R${state.report.revision} · ${formatDateTime(state.report.updatedAt)}`, 'success');
      toast('已同步最新', 'success');
    } finally { state.saving = false; updateControls(); }
  }
  async function acquireEditing() {
    if (state.saving) return;
    state.saving = true; updateControls();
    setLeaseNotice('正在檢查最新revision並取得新編輯權…');
    try {
      const lease = await state.client.acquireLease(state.reportId, state.editorWindowId);
      if (!lease || lease.ok !== true) {
        if (lease && lease.error === 'LEASE_HELD') {
          setMode('readonly', `目前由${lease.holderDisplayName || '其他使用者'}編輯中，約於${formatDateTime(lease.expiresAt)}到期。`, 'warning');
          return;
        }
        throw state.client.resultError(lease);
      }
      const latest = await state.client.getReport(state.reportId);
      state.lease = lease; state.report = latest.report; state.released = false; state.uncertain = false;
      renderContent(latest.report.content);
      state.dirty = false; state.dirtySince = 0;
      setMode('edit', `已取得新編輯權（fencing ${lease.fencingToken}）。`, 'success');
      restoreDraft();
      startHeartbeat();
    } catch (error) {
      setMode('readonly', errorLabel(error), 'danger');
      toast(errorLabel(error), 'danger');
    } finally { state.saving = false; updateControls(); }
  }
  function resetDraft() {
    if (state.mode !== 'edit') return;
    if (!root.confirm('只清除本窗口本機草稿，回到最近已保存的雲端內容；不會刪除報告。是否繼續？')) return;
    state.client.clearDraft(draftScope());
    renderContent(state.report.content);
    state.dirty = false; state.dirtySince = 0; state.uncertain = false;
    setLeaseNotice(`已回到雲端 R${state.report.revision}，尚未新增雲端revision。`, 'success');
  }
  function restoreDraft() {
    if (state.mode !== 'edit') return;
    const draft = state.client.readDraft(draftScope());
    if (!draft || !draft.content) return;
    const server = JSON.stringify(core.normalizeTopicContent(state.report.content));
    const local = JSON.stringify(core.normalizeTopicContent(draft.content));
    if (server === local) { state.client.clearDraft(draftScope()); return; }
    if (Number(draft.baseRevision) !== Number(state.report.revision)) {
      setLeaseNotice(`保留了一份基於R${draft.baseRevision}的本機草稿；因雲端已是R${state.report.revision}，未自動覆蓋。`, 'warning');
      return;
    }
    if (root.confirm(`偵測到本窗口未保存草稿（基於R${draft.baseRevision}），是否恢復？`)) {
      renderContent(draft.content); state.dirty = true; state.dirtySince = Date.now();
      setLeaseNotice('已恢復本機草稿，尚未保存至雲端。', 'warning');
    }
  }

  async function heartbeat() {
    if (state.mode !== 'edit' || !state.lease || state.saving) return;
    try {
      state.lease = await state.client.heartbeatLease({ reportId: state.reportId, editorWindowId: state.editorWindowId, lease: state.lease });
      if (!state.dirty) setLeaseNotice(`編輯權有效至 ${formatDateTime(state.lease.expiresAt)} · fencing ${state.lease.fencingToken}`, 'success');
    } catch (error) {
      try { persistDraft(); } catch (_draftError) { /* noop */ }
      state.lease = null;
      setMode('readonly', errorLabel(error), 'danger');
    }
  }
  function startHeartbeat() {
    root.clearInterval(state.heartbeatTimer);
    if (state.mode !== 'edit') return;
    state.heartbeatTimer = root.setInterval(heartbeat, 20000);
  }
  async function pollReadonly() {
    if (state.mode !== 'readonly' || state.saving || !state.client || state.dirty) return;
    try {
      const result = await state.client.getReport(state.reportId);
      if (Number(result.report.revision) !== Number(state.report.revision)) {
        state.report = result.report; renderContent(result.report.content); updateMeta();
        setLeaseNotice(`已自動讀取最新R${state.report.revision}。`, 'success');
      } else if (!result.editing) {
        setLeaseNotice('目前沒有其他編輯者，可按「重新取得編輯權」。', 'success');
      } else {
        setLeaseNotice(`目前由${result.holderDisplayName || '其他使用者'}編輯中。`, 'warning');
      }
    } catch (_error) { /* silent readonly polling */ }
  }
  function startTimers() {
    startHeartbeat();
    root.clearInterval(state.autosaveTimer);
    state.autosaveTimer = root.setInterval(() => {
      if (state.mode === 'edit' && state.dirty && !state.saving && !state.uncertain && Date.now() - state.dirtySince >= 60000) {
        saveNow({ silent: true }).catch(() => {});
      }
    }, 10000);
    root.clearInterval(state.readonlyTimer);
    state.readonlyTimer = root.setInterval(pollReadonly, 20000);
  }

  function exportExcel() {
    if (!root.XLSX) throw new Error('SheetJS未載入。');
    const content = collectContent();
    const workbook = root.XLSX.utils.book_new();
    const info = root.XLSX.utils.json_to_sheet([{
      系統編號: state.report.systemNumber, 專題名稱: content.title, 報告日期: content.reportDate,
      Revision: state.report.revision, 匯出時間: formatDateTime(new Date())
    }]);
    const rows = root.XLSX.utils.json_to_sheet(contentToWorkbookRows(content));
    root.XLSX.utils.book_append_sheet(workbook, info, '報告資訊');
    root.XLSX.utils.book_append_sheet(workbook, rows, '專題內容');
    root.XLSX.writeFile(workbook, `${core.sanitizeExportName(`${state.report.systemNumber}_${content.title}`, 'topic-report')}.xlsx`);
  }
  async function importExcel(file) {
    if (!root.XLSX) throw new Error('SheetJS未載入。');
    const data = await file.arrayBuffer();
    const workbook = root.XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets['專題內容'] || workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Excel沒有可讀取的工作表。');
    const rows = root.XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('Excel「專題內容」沒有資料。');
    const content = workbookRowsToContent(rows, collectContent(), randomUuid);
    renderContent(content); markDirty();
    toast(`已匯入 ${content.modules.length} 個項次，尚未保存`, 'success');
  }

  function applyPrintObjectWidths(column, layout, columnIndex) {
    column.querySelectorAll('[data-topic-block]').forEach((block) => {
      if (block.classList.contains('topic-highlight')) {
        block.style.removeProperty('width');
        return;
      }
      const width = normalizePrintObjectWidth(block.style.width, layout, columnIndex);
      if (width) block.style.width = width;
    });
  }

  function applyPrintPageOrientation(value) {
    const orientation = normalizePdfOrientation(value);
    let style = $('topicPrintPageStyle');
    if (!style) {
      style = root.document.createElement('style');
      style.id = 'topicPrintPageStyle';
      style.media = 'print';
      root.document.head.appendChild(style);
    }
    style.textContent = `@page { size: A4 ${orientation}; margin: 10mm; }`;
    return orientation;
  }

  function capturePrintIntent() {
    return Object.freeze({
      reportId: state.reportId,
      revision: Number(state.report && state.report.revision),
      editGeneration: state.editGeneration,
      scale: normalizePdfScale($('topicPdfScale') && $('topicPdfScale').value),
      orientation: normalizePdfOrientation($('topicPdfOrientation') && $('topicPdfOrientation').value)
    });
  }

  function assertPrintIntent(intent) {
    if (!intent || intent.reportId !== state.reportId
      || intent.revision !== Number(state.report && state.report.revision)
      || intent.editGeneration !== state.editGeneration) {
      throw new Error('TOPIC_PRINT_CONTENT_CHANGED');
    }
  }

  function waitAnimationFrames() {
    const frame = typeof root.requestAnimationFrame === 'function'
      ? root.requestAnimationFrame.bind(root) : (callback) => root.setTimeout(callback, 0);
    return new Promise((resolve) => frame(() => frame(resolve)));
  }

  async function waitBounded(promise, timeoutMs, code) {
    let timer = null;
    try {
      await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = root.setTimeout(() => reject(new Error(code)), timeoutMs);
        })
      ]);
    } finally {
      root.clearTimeout(timer);
    }
  }

  async function waitForPrintImages(scope) {
    const images = Array.from(scope.querySelectorAll('img'));
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await waitBounded(new Promise((resolve, reject) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', () => reject(new Error('TOPIC_PRINT_IMAGE_NOT_READY')), { once: true });
        }), 4000, 'TOPIC_PRINT_IMAGE_NOT_READY');
      }
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('TOPIC_PRINT_IMAGE_NOT_READY');
      if (typeof image.decode === 'function') {
        await waitBounded(Promise.resolve().then(() => image.decode()), 4000, 'TOPIC_PRINT_IMAGE_NOT_READY');
      }
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('TOPIC_PRINT_IMAGE_NOT_READY');
    }));
  }

  async function renderPrintAreaCharts() {
    const printArea = $('topicPrintArea');
    const cards = Array.from(printArea.querySelectorAll('.topic-trend-card'));
    if (cards.length && !root.Chart) throw new Error('TOPIC_CHART_PRINT_NOT_READY');
    const printCharts = new Map();
    const chartWidth = printArea.dataset.pdfOrientation === 'landscape' ? 840 : 620;
    try {
      cards.forEach((card) => {
        if (!createChartForCard(card, printCharts, { responsive: false, width: chartWidth })) {
          throw new Error('TOPIC_CHART_PRINT_NOT_READY');
        }
      });
      await waitAnimationFrames();
      printCharts.forEach((chart) => chart.update('none'));
      await waitAnimationFrames();
      printCharts.forEach((chart, canvas) => {
        const source = chart.toBase64Image('image/png', 1);
        if (!/^data:image\/png;base64,/i.test(source)) throw new Error('TOPIC_CHART_PRINT_NOT_READY');
        const image = root.document.createElement('img');
        image.className = 'topic-inline-image topic-chart-print-image';
        image.src = source;
        image.alt = '趨勢圖';
        canvas.replaceWith(image);
      });
    } finally {
      printCharts.forEach((chart) => { try { chart.destroy(); } catch (_error) { /* noop */ } });
    }
    await waitForPrintImages(printArea);
  }

  function buildPrintArea(reportProjection, intent) {
    const content = core.normalizeTopicContent(reportProjection.content);
    const scale = intent.scale;
    const orientation = applyPrintPageOrientation(intent.orientation);
    const printArea = $('topicPrintArea');
    printArea.dataset.pdfScale = String(scale);
    printArea.dataset.pdfOrientation = orientation;
    printArea.style.setProperty('--topic-pdf-scale', String(scale / 100));
    printArea.style.setProperty('--topic-pdf-width', `${10000 / scale}%`);
    $('topicPrintTitle').textContent = content.title;
    $('topicPrintMeta').textContent = `${reportProjection.systemNumber}　報告日期：${content.reportDate}　Revision：R${reportProjection.revision}`;
    const rootNode = $('topicPrintModules');
    rootNode.replaceChildren();
    const selected = content.modules.filter((module) => module.selectedForPdf !== false)
      .sort((a, b) => Number(a.pdfOrder || 0) - Number(b.pdfOrder || 0));
    selected.forEach((module) => {
      const section = root.document.createElement('section');
      section.className = 'topic-print-module';
      const heading = root.document.createElement('h2'); heading.textContent = module.title;
      const columns = root.document.createElement('div');
      columns.className = 'topic-print-columns';
      const renderedColumns = module.columns.map((html, columnIndex) => {
        const column = root.document.createElement('div'); column.className = 'topic-print-column';
        setSanitizedHtml(column, html);
        applyPrintObjectWidths(column, module.colLayout, columnIndex);
        return column;
      });
      const meaningfulColumns = renderedColumns.filter((column) => {
        const text = String(column.textContent || '').replace(/\u00a0/g, ' ').trim();
        return !!text || !!column.querySelector('img,table,[data-topic-block],ul,ol,hr,svg,canvas,video,audio');
      });
      const printableColumns = meaningfulColumns.length ? meaningfulColumns : renderedColumns.slice(0, 1);
      columns.dataset.layout = printableColumns.length === 1 ? '1' : module.colLayout;
      printableColumns.forEach((column) => columns.appendChild(column));
      section.append(heading, columns);
      if (module.attachments && module.attachments.length) {
        const attachments = root.document.createElement('small');
        attachments.textContent = `附件：${module.attachments.map((item) => item.name).join('、')}`;
        section.appendChild(attachments);
      }
      rootNode.appendChild(section);
    });
  }
  async function printReport() {
    if (state.printing) return;
    state.printing = true;
    updateControls();
    try {
      if (state.mode === 'edit' && (state.dirty || state.uncertain)) await saveNow();
      const intent = capturePrintIntent();
      const snapshot = await state.client.createSnapshot({
        reportId: intent.reportId, expectedRevision: intent.revision, editorWindowId: state.editorWindowId
      });
      const projection = snapshot.snapshot && snapshot.snapshot.report;
      if (!projection || projection.id !== intent.reportId || Number(projection.revision) !== intent.revision) {
        throw new Error('SNAPSHOT_VERIFICATION_FAILED');
      }
      assertPrintIntent(intent);
      buildPrintArea(projection, intent);
      await renderPrintAreaCharts();
      assertPrintIntent(intent);
      const oldTitle = root.document.title;
      root.document.title = core.buildReportExportName(projection);
      root.document.body.classList.add('topic-printing-report');
      const cleanup = () => {
        root.document.body.classList.remove('topic-printing-report');
        root.document.title = oldTitle;
        root.removeEventListener('afterprint', cleanup);
      };
      root.addEventListener('afterprint', cleanup, { once: true });
      try { root.print(); }
      finally { root.setTimeout(cleanup, 1200); }
    } finally {
      state.printing = false;
      updateControls();
    }
  }

  function runAction(action) {
    Promise.resolve().then(action).catch((error) => {
      toast(errorLabel(error), 'danger');
      setLeaseNotice(errorLabel(error), 'danger');
    });
  }
  function bind() {
    $('topicEditorRetry').addEventListener('click', boot);
    $('topicToolbarPin').addEventListener('click', () => {
      const toolbar = $('topicEditorToolbar');
      const pinned = toolbar.dataset.pinned !== 'true';
      toolbar.dataset.pinned = String(pinned);
      $('topicToolbarPin').setAttribute('aria-pressed', String(pinned));
      setIconButton($('topicToolbarPin'), 'fas fa-thumbtack', pinned ? '固定顯示 · 已固定' : '隨頁面捲動');
      root.localStorage.setItem('topic:v1:toolbar-pinned', String(pinned));
    });
    $('topicToolbarCollapse').addEventListener('click', () => {
      const content = $('topicToolbarContent');
      const collapsed = !content.hidden;
      content.hidden = collapsed;
      $('topicEditorToolbar').dataset.collapsed = String(collapsed);
      $('topicToolbarCollapse').setAttribute('aria-expanded', String(!collapsed));
      setIconButton($('topicToolbarCollapse'), `fas fa-chevron-${collapsed ? 'down' : 'up'}`, collapsed ? '展開' : '收合');
      root.localStorage.setItem('topic:v1:toolbar-collapsed', String(collapsed));
    });
    $('topicToolbarContent').addEventListener('mousedown', (event) => {
      if (event.target.closest('[data-command],[data-insert],[data-text-color]')) event.preventDefault();
    });
    $('topicToolbarContent').addEventListener('click', (event) => {
      const command = event.target.closest('[data-command]');
      if (command) { runCommand(command.dataset.command); return; }
      const color = event.target.closest('[data-text-color]');
      if (color) { runCommand('foreColor', color.dataset.textColor); return; }
      const insert = event.target.closest('[data-insert]');
      if (!insert) return;
      const type = insert.dataset.insert;
      if (type === 'image') { $('topicImageFile').click(); return; }
      if (type === 'attachment') { state.pendingFileModuleId = activeModuleId(); $('topicAttachmentFile').click(); return; }
      if (type === 'table') { insertHtml(makeTable()); return; }
      insertHtml(buildBlockHtml(type));
    });
    $('topicFontSize').addEventListener('change', (event) => applyFontSize(event.target.value));
    $('topicFontEn').addEventListener('change', markDirty);
    $('topicFontZh').addEventListener('change', markDirty);
    $('topicPdfScale').addEventListener('change', (event) => {
      const scale = normalizePdfScale(event.target.value);
      event.target.value = String(scale);
      root.localStorage.setItem('topic:v1:pdf-scale', String(scale));
    });
    $('topicPdfOrientation').addEventListener('change', (event) => {
      const orientation = normalizePdfOrientation(event.target.value);
      event.target.value = orientation;
      root.localStorage.setItem('topic:v1:pdf-orientation', orientation);
    });
    $('topicAddModule').addEventListener('click', addModule);
    $('topicSave').addEventListener('click', () => runAction(saveNow));
    $('topicComplete').addEventListener('click', () => runAction(completeEditing));
    $('topicDiscardExit').addEventListener('click', () => runAction(discardAndExit));
    $('topicSync').addEventListener('click', () => runAction(syncLatest));
    $('topicPrint').addEventListener('click', () => runAction(printReport));
    $('topicReset').addEventListener('click', resetDraft);
    $('topicAcquireEdit').addEventListener('click', () => runAction(acquireEditing));
    $('topicExcelExport').addEventListener('click', () => runAction(exportExcel));
    $('topicExcelImport').addEventListener('click', () => $('topicExcelFile').click());
    root.document.querySelectorAll('[data-footer-action="save"]').forEach((button) => button.addEventListener('click', () => runAction(saveNow)));
    root.document.querySelectorAll('[data-footer-action="complete"]').forEach((button) => button.addEventListener('click', () => runAction(completeEditing)));
    root.document.querySelectorAll('[data-footer-action="discard"]').forEach((button) => button.addEventListener('click', () => runAction(discardAndExit)));
    $('topicModules').addEventListener('click', (event) => {
      const action = event.target.closest('[data-module-action]');
      if (action) { moduleAction(action.dataset.moduleAction, action.dataset.moduleId); return; }
      const attachment = event.target.closest('[data-attachment-action]');
      if (attachment) { attachmentAction(attachment.dataset.attachmentAction, attachment.dataset.moduleId, attachment.dataset.attachmentId); return; }
      const avgToggle = event.target.closest('[data-topic-kpi-toggle]');
      if (avgToggle) {
        const card = avgToggle.closest('.topic-kpi-card');
        card.dataset.topicShowAvg = card.dataset.topicShowAvg === 'false' ? 'true' : 'false';
        markDirty(); updateDynamic(card); selectObject(card); return;
      }
      const object = objectFromTarget(event.target);
      if (object) selectObject(object, event.target);
    });
    $('topicModules').addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('[data-topic-table-resize-handle]');
      if (handle) startTableResize(event, handle);
    });
    root.document.addEventListener('pointermove', moveTableResize);
    root.document.addEventListener('pointerup', finishTableResize);
    root.document.addEventListener('pointercancel', finishTableResize);
    $('topicObjectToolbar').addEventListener('click', (event) => {
      const width = event.target.closest('[data-topic-object-width]');
      if (width) { setObjectWidth(width.dataset.topicObjectWidth); return; }
      const indicator = event.target.closest('[data-topic-indicator-action]');
      if (indicator) { indicatorAction(indicator.dataset.topicIndicatorAction); return; }
      const imageAlignment = event.target.closest('[data-topic-image-align]');
      if (imageAlignment) { setImageAlignment(imageAlignment.dataset.topicImageAlign); return; }
      const trend = event.target.closest('[data-topic-trend-action]');
      if (trend) { trendAction(trend.dataset.topicTrendAction); return; }
      if (event.target.closest('[data-topic-object-delete]')) deleteActiveObject();
    });
    $('topicTrendHeight').addEventListener('change', (event) => setTrendHeight(event.target.value));
    root.document.addEventListener('pointerdown', (event) => {
      if (!state.activeObject || event.target.closest('#topicObjectToolbar') || objectFromTarget(event.target) === state.activeObject) return;
      hideObjectToolbar();
    });
    root.addEventListener('scroll', positionObjectToolbar, true);
    root.addEventListener('resize', positionObjectToolbar);
    $('topicModules').addEventListener('change', (event) => {
      if (event.target.matches('[data-module-layout]')) changeLayout(event.target.dataset.moduleLayout, event.target.value);
      else markDirty();
    });
    $('topicEditorPage').addEventListener('input', (event) => {
      if (event.target.closest('#topicModules,#topicReportTitle,#topicReportDate')) {
        markDirty(); updateDynamic(event.target.closest('.topic-module') || $('topicModules'));
      }
    });
    root.document.addEventListener('selectionchange', rememberSelection);
    $('topicImageFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0]; event.target.value = '';
      if (file) runAction(() => insertImageFile(file));
    });
    $('topicAttachmentFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0]; event.target.value = '';
      if (file) runAction(() => addAttachmentFile(file));
    });
    $('topicExcelFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0]; event.target.value = '';
      if (file) runAction(() => importExcel(file));
    });
    root.addEventListener('beforeunload', (event) => {
      if (state.dirty || state.uncertain) { event.preventDefault(); event.returnValue = ''; }
    });
    root.addEventListener('pagehide', () => {
      try { if (state.dirty) persistDraft(); } catch (_error) { /* noop */ }
      if (state.mode === 'edit' && state.lease && !state.released) {
        state.client.releaseLease({ reportId: state.reportId, editorWindowId: state.editorWindowId, lease: state.lease }).catch(() => {});
      }
    });
  }

  async function boot() {
    const generation = ++state.bootGeneration;
    showGate('正在確認身份、讀取已保存revision及取得編輯權。');
    try {
      assertTopicAssetBuilds();
      const reportId = new URL(root.location.href).searchParams.get('report') || '';
      if (!core.UUID_PATTERN.test(reportId)) throw new Error('TOPIC_EDITOR_REPORT_ID_INVALID');
      const identity = captureIdentity();
      if (!identity) throw new Error('TOPIC_IDENTITY_REQUIRED');
      const config = root.MONTHLY_REPORT_SUPABASE_CONFIG;
      if (!config) throw new Error('SUPABASE_CONFIG_REQUIRED');
      const launch = consumeLaunch(reportId);
      state.reportId = reportId; state.identity = identity;
      state.editorWindowId = await uniqueEditorWindowId(reportId, launch && launch.editorWindowId);
      root.name = core.editorWindowName(reportId);
      const transport = new clientApi.SupabaseTopicTransport(root.supabase, {
        requestTimeoutMs: Number(config.topicRequestTimeoutMs) || 30000
      });
      const client = new clientApi.TopicReportClient({
        transport,
        config: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, workspaceKey: identity.workspaceKey },
        identity, sessionStorage: root.sessionStorage, draftStorage: root.localStorage
      });
      await client.initialize();
      state.client = client;
      const pendingSave = client.readPending(client.operationScope('save', reportId, state.editorWindowId));
      const releaseCheck = readReleaseCheck();
      let releaseCheckPending = false;
      let releaseCheckResolved = false;
      if (releaseCheck) {
        try {
          await client.releaseLease({ reportId, editorWindowId: state.editorWindowId, lease: releaseCheck.lease });
          releaseCheckResolved = true;
        } catch (error) {
          const code = String(error && (error.code || error.message) || '');
          if (code === 'LEASE_LOST') releaseCheckResolved = true;
          else releaseCheckPending = true;
        }
        if (releaseCheckResolved) {
          if (releaseCheck.action === 'discard') client.clearDraft(client.operationScope('save', reportId, state.editorWindowId));
          clearReleaseCheck();
        }
      }
      let opened = null;
      if (releaseCheck) {
        const loaded = await client.getReport(reportId);
        opened = { ok: true, mode: 'readonly', report: loaded.report, lease: null };
      }
      if (!opened && launch && launch.report && launch.lease && launch.editorWindowId === state.editorWindowId) {
        const loaded = await client.getReport(reportId);
        try {
          const renewed = await client.heartbeatLease({ reportId, editorWindowId: state.editorWindowId, lease: launch.lease });
          opened = { ok: true, mode: 'edit', report: loaded.report, lease: renewed };
        } catch (_error) { opened = null; }
      }
      if (!opened) opened = await client.openReport({ reportId, editorWindowId: state.editorWindowId });
      if (generation !== state.bootGeneration) return;
      state.report = opened.report; state.lease = opened.lease || null;
      state.mode = opened.mode === 'edit' ? 'edit' : 'readonly';
      state.dirty = false; state.uncertain = Boolean(pendingSave);
      state.releaseUncertain = Boolean(releaseCheckPending); state.released = Boolean(releaseCheckResolved);
      renderIdentity(); renderContent(opened.report.content); updateMeta(); showPage();
      if (releaseCheck) {
        if (releaseCheckPending) {
          setMode(
            'readonly',
            releaseCheck.action === 'discard'
              ? '放棄編輯的釋放結果未確認；草稿仍保留，請再按「不保存並退出」確認。'
              : `內容已保存至 R${state.report.revision}；釋放結果未確認，請稍後再按完成編輯。`,
            'warning'
          );
        } else {
          setMode(
            'readonly',
            releaseCheck.action === 'discard'
              ? `已確認放棄未保存修改並釋放編輯權；雲端仍為 R${state.report.revision}。`
              : `已完成編輯，編輯權已釋放；保存 R${state.report.revision}。`,
            'success'
          );
        }
      } else if (state.mode === 'edit') {
        setMode('edit', `已取得整份報告編輯權（fencing ${state.lease.fencingToken}）。`, 'success');
        restoreDraft();
      } else {
        setMode('readonly', `目前由${opened.holderDisplayName || '其他使用者'}編輯中；本窗口可查看、同步及輸出已保存PDF。`, 'warning');
      }
      if (pendingSave) {
        setLeaseNotice('上一筆保存未確認；請按保存重播同一operation，在確認前內容保持唯讀。', 'warning');
        updateControls();
      }
      startTimers();
    } catch (error) {
      if (generation !== state.bootGeneration) return;
      showGate(errorLabel(error));
    }
  }

  function mount() {
    if (state.mounted || !$('topicEditorPage')) return;
    state.mounted = true;
    bind();
    const pinned = root.localStorage.getItem('topic:v1:toolbar-pinned');
    if (pinned === 'false') $('topicToolbarPin').click();
    const collapsed = root.localStorage.getItem('topic:v1:toolbar-collapsed');
    if (collapsed === 'true') $('topicToolbarCollapse').click();
    $('topicPdfScale').value = String(normalizePdfScale(root.localStorage.getItem('topic:v1:pdf-scale') || 100));
    $('topicPdfOrientation').value = normalizePdfOrientation(root.localStorage.getItem('topic:v1:pdf-orientation') || 'portrait');
    boot();
  }

  return Object.freeze({
    BUILD_ID,
    IMAGE_MAX_BYTES,
    ATTACHMENT_MAX_BYTES,
    sanitizeStoredHtml,
    buildBlockHtml,
    contentToWorkbookRows,
    workbookRowsToContent,
    isAllowedImage,
    isAllowedAttachment,
    isSafeAttachmentDataUrl,
    clampedPercent,
    normalizeObjectWidth,
    normalizeImageAlignment,
    normalizeChartHeight,
    normalizePdfScale,
    normalizePdfOrientation,
    normalizePrintObjectWidth,
    mount,
    getIdentity: () => state.identity ? clone(state.identity) : null,
    getState: () => ({
      reportId: state.reportId,
      mode: state.mode,
      dirty: state.dirty,
      uncertain: state.uncertain,
      editorWindowId: state.editorWindowId,
      fencingToken: state.lease ? Number(state.lease.fencingToken) : null,
      revision: state.report && state.report.revision
    })
  });
});
