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

  const BUILD_ID = '1.0.0';
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
    'TH', 'TD', 'CAPTION', 'IMG', 'A', 'HR', 'SMALL', 'SUP', 'SUB', 'CANVAS'
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
      }
    });
    return template;
  }

  function sanitizeStoredHtml(value) {
    const source = String(value == null ? '' : value);
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
      highlight: '<span class="topic-inline-block topic-highlight" data-topic-block="highlight" data-topic-editable="true" contenteditable="true">重要數值 100</span>',
      'indicator-blue': '<div class="topic-inline-block topic-indicator-card" data-topic-block="indicator" style="--card-color:#2563eb" contenteditable="false"><strong data-topic-editable="true" contenteditable="true">指標名稱</strong><div><span data-topic-editable="true" contenteditable="true">目前值 88</span>／<span data-topic-editable="true" contenteditable="true">目標值 100</span></div></div>',
      'indicator-orange': '<div class="topic-inline-block topic-indicator-card" data-topic-block="indicator" style="--card-color:#f97316" contenteditable="false"><strong data-topic-editable="true" contenteditable="true">指標名稱</strong><div><span data-topic-editable="true" contenteditable="true">目前值 88</span>／<span data-topic-editable="true" contenteditable="true">目標值 100</span></div></div>',
      kpi: '<div class="topic-inline-block topic-kpi-card" data-topic-block="kpi" contenteditable="false"><strong data-topic-editable="true" contenteditable="true">KPI 指標</strong><div class="topic-kpi-track"><div class="topic-kpi-fill" style="width:60%"></div></div><div class="topic-metric-row"><span>最小 <b class="topic-metric-min" data-topic-editable="true" contenteditable="true">0</b></span><span>目前 <b class="topic-metric-current" data-topic-editable="true" contenteditable="true">60</b></span><span>目標 <b class="topic-metric-max" data-topic-editable="true" contenteditable="true">100</b></span></div></div>',
      progress: '<div class="topic-inline-block topic-progress-card" data-topic-block="progress" contenteditable="false"><strong data-topic-editable="true" contenteditable="true">工作進度</strong><div class="topic-progress-track"><div class="topic-progress-fill" style="width:50%"></div></div><div class="topic-metric-row"><span>完成率</span><b class="topic-metric-current" data-topic-editable="true" contenteditable="true">50</b><span>%</span></div></div>',
      zone: '<div class="topic-inline-block topic-zone-card" data-topic-block="zone" contenteditable="false"><strong data-topic-editable="true" contenteditable="true">狀態區間</strong><div class="topic-zone-track"></div><div class="topic-metric-row"><span>最小 <b class="topic-metric-min" data-topic-editable="true" contenteditable="true">0</b></span><span>目前 <b class="topic-metric-current" data-topic-editable="true" contenteditable="true">2.4</b></span><span>最大 <b class="topic-metric-max" data-topic-editable="true" contenteditable="true">5</b></span></div></div>',
      trend: '<div class="topic-trend-card" data-topic-block="trend"><strong data-topic-editable="true" contenteditable="true">趨勢圖</strong><table class="topic-data-table topic-chart-data"><thead><tr><th data-topic-editable="true" contenteditable="true">期間</th><th data-topic-editable="true" contenteditable="true">數值</th></tr></thead><tbody><tr><td data-topic-editable="true" contenteditable="true">1月</td><td data-topic-editable="true" contenteditable="true">12</td></tr><tr><td data-topic-editable="true" contenteditable="true">2月</td><td data-topic-editable="true" contenteditable="true">18</td></tr><tr><td data-topic-editable="true" contenteditable="true">3月</td><td data-topic-editable="true" contenteditable="true">15</td></tr></tbody></table><canvas class="topic-chart-canvas" contenteditable="false" aria-label="趨勢圖"></canvas></div>'
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
      TOPIC_PENDING_OPERATION_MISMATCH: '上一筆保存結果尚未確認；請先還原到原內容並重試保存。',
      TOPIC_EDITOR_REPORT_ID_INVALID: '專題報告網址缺少有效report ID。',
      TOPIC_SAVE_SCOPE_INVALID: '保存範圍不完整，已停止寫入。'
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
      titleRow.append(icon, title);
      const count = root.document.createElement('small');
      count.textContent = `項次 ${index + 1}`;
      heading.append(titleRow, count);

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
      pdfOrder.className = 'topic-input'; pdfOrder.style.minHeight = '34px';
      pdfOrder.value = String(module.pdfOrder || index + 1);
      pdfOrder.dataset.modulePdfOrder = module.id;
      actions.append(
        layout, pdfLabel, pdfOrder,
        createButton('上移', 'fas fa-arrow-up', 'up', module.id),
        createButton('下移', 'fas fa-arrow-down', 'down', module.id),
        createButton('附件', 'fas fa-paperclip', 'attachment', module.id),
        createButton('刪除', 'fas fa-trash', 'delete', module.id)
      );
      article.append(heading, contentCell, actions);
      rootNode.appendChild(article);
    });
    updateDynamic(rootNode);
    updateControls();
  }

  function renderContent(content) {
    const normalized = core.normalizeTopicContent(content);
    state.currentContent = normalized;
    $('topicReportTitle').value = normalized.title;
    $('topicReportDate').value = normalized.reportDate;
    $('topicFontEn').value = normalized.settings.globalFontEn || $('topicFontEn').options[0].value;
    $('topicFontZh').value = normalized.settings.globalFontZh || $('topicFontZh').options[0].value;
    renderModules(normalized);
  }
  function updateMeta() {
    if (!state.report) return;
    $('topicSystemNumber').textContent = state.report.systemNumber;
    $('topicRevision').textContent = String(state.report.revision);
    root.document.title = `${state.report.systemNumber} · ${state.report.title} · 專題報告編輯器`;
    const badge = $('topicModeBadge');
    badge.dataset.mode = state.mode;
    badge.textContent = state.mode === 'edit' ? '可編輯' : '唯讀';
  }
  function updateControls() {
    const editable = state.mode === 'edit' && !state.saving && !state.uncertain && !state.releaseUncertain;
    const mutations = root.document.querySelectorAll(
      '[data-command],[data-insert],#topicAddModule,#topicExcelImport,#topicReset,#topicComplete,' +
      '#topicFontEn,#topicFontZh,#topicTextColor,[data-module-action],[data-module-layout],[data-module-pdf],[data-module-pdf-order]'
    );
    mutations.forEach((control) => { control.disabled = !editable; });
    $('topicSave').disabled = state.saving || state.releaseUncertain || (!state.uncertain && state.mode !== 'edit');
    $('topicComplete').disabled = state.saving || state.uncertain || (!state.releaseUncertain && state.mode !== 'edit');
    $('topicSync').disabled = state.saving || state.releaseUncertain;
    $('topicPrint').disabled = state.saving;
    $('topicExcelExport').disabled = state.saving;
    root.document.querySelectorAll('[data-footer-action]').forEach((control) => {
      const action = control.dataset.footerAction;
      control.disabled = state.saving || state.uncertain
        || (action === 'save' ? (state.releaseUncertain || state.mode !== 'edit')
          : (!state.releaseUncertain && state.mode !== 'edit'));
    });
    $('topicReportTitle').readOnly = !editable;
    $('topicReportDate').readOnly = !editable;
    root.document.querySelectorAll('.topic-module-title').forEach((input) => { input.readOnly = !editable; });
    root.document.querySelectorAll('.topic-editable').forEach((editor) => { editor.contentEditable = editable ? 'true' : 'false'; });
    root.document.querySelectorAll('[data-topic-editable="true"]').forEach((element) => { element.contentEditable = editable ? 'true' : 'false'; });
    $('topicAcquireEdit').hidden = state.mode === 'edit' || state.saving || state.uncertain || state.releaseUncertain;
  }
  function setMode(mode, message, tone = '') {
    state.mode = mode === 'edit' ? 'edit' : 'readonly';
    if (state.mode !== 'edit') {
      root.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    updateMeta();
    updateControls();
    setLeaseNotice(message || (state.mode === 'edit' ? '已取得整份報告編輯權。' : '本窗口目前只讀。'), tone);
  }

  function collectContent() {
    const base = state.currentContent || core.createBlankTopicContent();
    const modules = Array.from($('topicModules').querySelectorAll('.topic-module')).map((article, index) => {
      const moduleId = article.dataset.moduleId;
      const prior = moduleById(moduleId) || {};
      const layout = normalizeLayout(article.querySelector('[data-module-layout]').value);
      const columns = Array.from(article.querySelectorAll('.topic-editable'))
        .slice(0, layout === '1' ? 1 : 2)
        .map((editor) => sanitizeStoredHtml(editor.innerHTML));
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
  function writeReleaseCheck(report, lease) {
    root.sessionStorage.setItem(releaseCheckKey(), JSON.stringify({
      version: 1,
      domain: 'topic',
      reportId: state.reportId,
      actorUserId: state.identity.user.id,
      editorWindowId: state.editorWindowId,
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
  }
  function runCommand(command, value) {
    if (state.mode !== 'edit' || !ensureSelection()) return;
    root.document.execCommand(command, false, value == null ? null : value);
    rememberSelection(); markDirty();
  }
  function makeTable() {
    const rows = Math.max(1, Math.min(20, Number(root.prompt('表格列數', '3')) || 3));
    const columns = Math.max(1, Math.min(10, Number(root.prompt('表格欄數', '3')) || 3));
    let html = '<table class="topic-data-table"><tbody>';
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

  function updateDynamic(container) {
    const scope = container || $('topicModules');
    if (!scope) return;
    scope.querySelectorAll('.topic-kpi-card').forEach((card) => {
      const min = Number(card.querySelector('.topic-metric-min')?.textContent || 0);
      const current = Number(card.querySelector('.topic-metric-current')?.textContent || 0);
      const max = Number(card.querySelector('.topic-metric-max')?.textContent || 100);
      const fill = card.querySelector('.topic-kpi-fill');
      if (fill) fill.style.width = `${clampedPercent(current, min, max)}%`;
    });
    scope.querySelectorAll('.topic-progress-card').forEach((card) => {
      const current = Number(card.querySelector('.topic-metric-current')?.textContent || 0);
      const fill = card.querySelector('.topic-progress-fill');
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number.isFinite(current) ? current : 0))}%`;
    });
    root.clearTimeout(state.chartTimer);
    state.chartTimer = root.setTimeout(renderCharts, 120);
  }
  function chartValues(card) {
    const labels = [];
    const values = [];
    card.querySelectorAll('.topic-chart-data tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('th,td');
      if (cells.length < 2) return;
      const value = Number(String(cells[1].textContent || '').replace(/[^0-9.-]/g, ''));
      labels.push(String(cells[0].textContent || '').trim());
      values.push(Number.isFinite(value) ? value : 0);
    });
    return { labels, values };
  }
  function renderCharts() {
    if (!root.Chart || !$('topicModules')) return;
    $('topicModules').querySelectorAll('.topic-trend-card').forEach((card) => {
      const canvas = card.querySelector('canvas.topic-chart-canvas');
      if (!canvas) return;
      const data = chartValues(card);
      const existing = state.charts.get(canvas);
      if (existing) existing.destroy();
      const chart = new root.Chart(canvas, {
        type: 'line',
        data: { labels: data.labels, datasets: [{ label: stripHtml(card.querySelector('strong')?.textContent || '趨勢'), data: data.values, borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,.12)', fill: true, tension: .28 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: true } } }
      });
      state.charts.set(canvas, chart);
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
    insertHtml(`<img class="topic-inline-image" src="${dataUrl}" alt="${escapeHtml(file.name || '專題報告圖片')}">`);
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
    state.report = record.report;
    state.currentContent = core.normalizeTopicContent(record.report.content);
    clearReleaseCheck();
    state.lease = null; state.released = true; state.dirty = false; state.dirtySince = 0;
    setMode('readonly', `已完成編輯，編輯權已釋放；保存 R${state.report.revision}。`, 'success');
    toast('完成編輯並已釋放', 'success');
    return { saved: clone(state.report), released: true };
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

  function buildPrintArea(reportProjection) {
    const content = core.normalizeTopicContent(reportProjection.content);
    $('topicPrintTitle').textContent = content.title;
    $('topicPrintMeta').textContent = `${reportProjection.systemNumber}　報告日期：${content.reportDate}　Revision：R${reportProjection.revision}`;
    const rootNode = $('topicPrintModules');
    rootNode.replaceChildren();
    const selected = content.modules.filter((module) => module.selectedForPdf !== false)
      .sort((a, b) => Number(a.pdfOrder || 0) - Number(b.pdfOrder || 0));
    const liveImages = Array.from(state.charts.values()).map((chart) => {
      try { return chart.toBase64Image('image/png', 1); } catch (_error) { return ''; }
    });
    let chartIndex = 0;
    selected.forEach((module) => {
      const section = root.document.createElement('section');
      section.className = 'topic-print-module';
      const heading = root.document.createElement('h2'); heading.textContent = module.title;
      const columns = root.document.createElement('div');
      columns.className = 'topic-print-columns'; columns.dataset.layout = module.colLayout;
      module.columns.forEach((html) => {
        const column = root.document.createElement('div'); column.className = 'topic-print-column';
        setSanitizedHtml(column, html);
        column.querySelectorAll('canvas.topic-chart-canvas').forEach((canvas) => {
          const source = liveImages[chartIndex++] || '';
          if (source) {
            const image = root.document.createElement('img'); image.className = 'topic-inline-image'; image.src = source; image.alt = '趨勢圖';
            canvas.replaceWith(image);
          } else canvas.remove();
        });
        columns.appendChild(column);
      });
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
    if (state.mode === 'edit' && (state.dirty || state.uncertain)) await saveNow();
    const snapshot = await state.client.createSnapshot({
      reportId: state.reportId, expectedRevision: state.report.revision, editorWindowId: state.editorWindowId
    });
    const projection = snapshot.snapshot && snapshot.snapshot.report;
    if (!projection || projection.id !== state.reportId || Number(projection.revision) !== Number(state.report.revision)) {
      throw new Error('SNAPSHOT_VERIFICATION_FAILED');
    }
    buildPrintArea(projection);
    const oldTitle = root.document.title;
    root.document.title = core.buildReportExportName(projection);
    root.document.body.classList.add('topic-printing-report');
    const cleanup = () => {
      root.document.body.classList.remove('topic-printing-report');
      root.document.title = oldTitle;
      root.removeEventListener('afterprint', cleanup);
    };
    root.addEventListener('afterprint', cleanup, { once: true });
    root.print();
    root.setTimeout(cleanup, 1200);
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
      if (event.target.closest('[data-command],[data-insert],label[for="topicTextColor"]')) event.preventDefault();
    });
    $('topicToolbarContent').addEventListener('click', (event) => {
      const command = event.target.closest('[data-command]');
      if (command) { runCommand(command.dataset.command); return; }
      const insert = event.target.closest('[data-insert]');
      if (!insert) return;
      const type = insert.dataset.insert;
      if (type === 'image') { $('topicImageFile').click(); return; }
      if (type === 'attachment') { state.pendingFileModuleId = activeModuleId(); $('topicAttachmentFile').click(); return; }
      if (type === 'table') { insertHtml(makeTable()); return; }
      insertHtml(buildBlockHtml(type));
    });
    $('topicTextColor').addEventListener('input', (event) => runCommand('foreColor', event.target.value));
    $('topicFontEn').addEventListener('change', markDirty);
    $('topicFontZh').addEventListener('change', markDirty);
    $('topicAddModule').addEventListener('click', addModule);
    $('topicSave').addEventListener('click', () => runAction(saveNow));
    $('topicComplete').addEventListener('click', () => runAction(completeEditing));
    $('topicSync').addEventListener('click', () => runAction(syncLatest));
    $('topicPrint').addEventListener('click', () => runAction(printReport));
    $('topicReset').addEventListener('click', resetDraft);
    $('topicAcquireEdit').addEventListener('click', () => runAction(acquireEditing));
    $('topicExcelExport').addEventListener('click', () => runAction(exportExcel));
    $('topicExcelImport').addEventListener('click', () => $('topicExcelFile').click());
    root.document.querySelectorAll('[data-footer-action="save"]').forEach((button) => button.addEventListener('click', () => runAction(saveNow)));
    root.document.querySelectorAll('[data-footer-action="complete"]').forEach((button) => button.addEventListener('click', () => runAction(completeEditing)));
    $('topicModules').addEventListener('click', (event) => {
      const action = event.target.closest('[data-module-action]');
      if (action) { moduleAction(action.dataset.moduleAction, action.dataset.moduleId); return; }
      const attachment = event.target.closest('[data-attachment-action]');
      if (attachment) attachmentAction(attachment.dataset.attachmentAction, attachment.dataset.moduleId, attachment.dataset.attachmentId);
    });
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
        if (releaseCheckResolved) clearReleaseCheck();
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
          setMode('readonly', `內容已保存至 R${state.report.revision}；釋放結果未確認，請稍後再按完成編輯。`, 'warning');
        } else {
          setMode('readonly', `已完成編輯，編輯權已釋放；保存 R${state.report.revision}。`, 'success');
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
