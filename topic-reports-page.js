(function (root) {
  'use strict';

  const core = root.TopicReportsCore;
  const clientApi = root.TopicReportsClient;
  const BUILD_ID = '1.2.0';
  const CREATE_ATTEMPT_STORAGE_KEY = 'topic:v1:create-attempt';
  root.TOPIC_REPORT_ASSET_BUILDS = Object.assign({}, root.TOPIC_REPORT_ASSET_BUILDS, { page: BUILD_ID });
  const state = {
    identity: null,
    client: null,
    reports: [],
    pendingLaunches: new Map(),
    createAttempt: null,
    bootGeneration: 0,
    refreshTimer: null,
    refreshQueued: false,
    toastTimer: null,
    sortKey: 'updatedAt',
    sortDirection: 'desc',
    busy: false
  };

  const $ = (id) => root.document.getElementById(id);

  function assertTopicAssetBuilds() {
    const builds = root.TOPIC_REPORT_ASSET_BUILDS || {};
    const required = ['core', 'client', 'page'];
    if (!core || !clientApi || required.some((key) => builds[key] !== BUILD_ID)) {
      throw new Error(`TOPIC_ASSET_BUILD_MISMATCH:${required.map((key) => `${key}=${builds[key] || 'missing'}`).join(',')}`);
    }
  }

  function taipeiDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let amount = bytes / 1024;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
  }

  function setStatus(message, tone = '') {
    const node = $('topicListStatus');
    if (!node) return;
    node.textContent = message;
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  }

  function toast(message, tone = '') {
    const node = $('topicToast');
    if (!node) return;
    root.clearTimeout(state.toastTimer);
    node.textContent = String(message || '');
    node.className = `topic-toast${tone ? ` ${tone}` : ''} show`;
    state.toastTimer = root.setTimeout(() => { node.className = 'topic-toast'; }, 2600);
  }

  function errorLabel(error) {
    const code = String(error && (error.code || error.message) || 'UNKNOWN_ERROR');
    if (code.startsWith('TOPIC_ASSET_BUILD_MISMATCH')) return '專題報告資產版本不一致，請按 Ctrl+F5 重新整理後再試。';
    if (code === 'LEASE_HELD') {
      const result = error && error.result || {};
      return `目前由${result.holderDisplayName || '其他使用者'}編輯中；請先在編輯器完成或放棄編輯，最遲於lease到期後再刪除。`;
    }
    const labels = {
      TOPIC_IDENTITY_REQUIRED: '找不到已登入身份，請由月報系統的「專題報告」入口重新開啟。',
      TOPIC_MONTHLY_IDENTITY_NOT_READY: '月報身份尚未完成驗證，請回月報頁登入後再開啟。',
      TOPIC_MONTHLY_IDENTITY_INVALID: '月報身份資料不完整，請回月報頁重新登入。',
      USER_SESSION_INVALID: '登入身份已失效，請回月報系統重新登入。',
      SITE_SESSION_INVALID: '進站狀態已失效，請回月報系統重新進站。',
      AUTHORITY_NOT_ACTIVE: '雲端權威模式尚未啟用，專題報告已停止讀寫。',
      RPC_TIMEOUT: '雲端回應逾時；未確認成功前不會重複建立，請按「同步最新」重試。',
      OWNER_REQUIRED: '只有 Owner 可以刪除整份專題報告。',
      REVISION_CONFLICT: '專題已由其他窗口更新；請同步最新後再刪除。',
      SYSTEM_NUMBER_EXHAUSTED: '今天的專題系統編號已達上限。',
      SUPABASE_CONFIG_REQUIRED: 'Supabase公開設定未載入。',
      SUPABASE_ANONYMOUS_AUTH_REQUIRED: '無法建立安全的Supabase連線。'
    };
    if (/Could not find the function|PGRST202|schema cache/i.test(String(error && error.message || ''))) {
      return '專題報告雲端migration尚未安裝；目前不會改動月報資料。';
    }
    return labels[code] || `專題報告操作失敗：${code}`;
  }

  function sameOriginOpener() {
    try {
      if (!root.opener || root.opener.closed) return null;
      if (root.opener.location.origin !== root.location.origin) return null;
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
    if (identity) return clientApi.storeIdentityHandoff(root.sessionStorage, identity);
    return null;
  }

  function returnToMonthly(event) {
    const opener = sameOriginOpener();
    if (!opener || !opener.MonthlyV7App) return;
    event.preventDefault();
    opener.focus();
    root.close();
  }

  function showGate(message) {
    $('topicReportsPage').hidden = true;
    $('topicIdentityGate').hidden = false;
    if (message) $('topicIdentityGateMessage').textContent = message;
  }

  function showPage() {
    $('topicIdentityGate').hidden = true;
    $('topicReportsPage').hidden = false;
  }

  function renderIdentity() {
    const user = state.identity && state.identity.user;
    const node = $('topicCurrentUser');
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

  function appendTextCell(row, value, className = '') {
    const cell = root.document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value == null || value === '' ? '—' : String(value);
    row.appendChild(cell);
    return cell;
  }

  function statusText(report) {
    return ({ draft: '草稿', final: '已完成', archived: '封存' })[report.status] || report.status || '草稿';
  }

  function isOwner() {
    return state.identity && state.identity.user && state.identity.user.role === 'owner';
  }

  function sortedReports() {
    const direction = state.sortDirection === 'asc' ? 1 : -1;
    const key = state.sortKey;
    return (Array.isArray(state.reports) ? state.reports.slice() : []).sort((left, right) => {
      let a;
      let b;
      if (key === 'status') {
        a = left.editing ? `編輯中 ${left.holderDisplayName || ''}` : statusText(left);
        b = right.editing ? `編輯中 ${right.holderDisplayName || ''}` : statusText(right);
      } else {
        a = left[key] == null ? '' : left[key];
        b = right[key] == null ? '' : right[key];
      }
      const primary = String(a).localeCompare(String(b), 'zh-Hant', { numeric: true, sensitivity: 'base' });
      if (primary) return primary * direction;
      return String(left.systemNumber || left.id).localeCompare(String(right.systemNumber || right.id), 'en', { numeric: true }) * direction;
    });
  }

  function updateSortHeaders() {
    root.document.querySelectorAll('[data-topic-sort-header]').forEach((header) => {
      const key = header.dataset.topicSortHeader;
      const active = key === state.sortKey;
      header.setAttribute('aria-sort', active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      const indicator = header.querySelector('.topic-sort-indicator');
      if (indicator) indicator.textContent = active ? (state.sortDirection === 'asc' ? '↑' : '↓') : '↕';
    });
  }

  function changeSort(key) {
    if (!['title', 'reportDate', 'status', 'logicalBytes', 'updatedAt'].includes(key)) return;
    if (state.sortKey === key) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      state.sortKey = key;
      state.sortDirection = key === 'updatedAt' ? 'desc' : 'asc';
    }
    renderReports();
  }

  function renderReports() {
    const body = $('topicReportsBody');
    body.replaceChildren();
    const reports = sortedReports();
    $('topicReportsTable').hidden = reports.length === 0;
    $('topicReportsEmpty').hidden = reports.length !== 0;
    reports.forEach((report) => {
      const row = root.document.createElement('tr');
      row.dataset.reportId = report.id;
      appendTextCell(row, report.title, 'topic-title-cell');
      appendTextCell(row, report.reportDate);
      const statusCell = root.document.createElement('td');
      const status = root.document.createElement('span');
      status.className = `topic-pill ${report.editing ? 'topic-pill-edit' : 'topic-pill-free'}`;
      status.textContent = report.editing
        ? `由${report.holderDisplayName || '其他使用者'}編輯中`
        : statusText(report);
      statusCell.appendChild(status);
      row.appendChild(statusCell);
      appendTextCell(row, formatBytes(report.logicalBytes), 'topic-size-cell');
      appendTextCell(row, `${formatDateTime(report.updatedAt)}${report.updatedBy ? ` · ${report.updatedBy}` : ''}`);
      const actionCell = root.document.createElement('td');
      actionCell.className = 'no-print topic-row-actions-cell';
      const actions = root.document.createElement('div');
      actions.className = 'topic-row-actions';
      const open = root.document.createElement('button');
      open.type = 'button';
      open.className = 'topic-btn topic-row-open';
      open.dataset.openReport = report.id;
      const icon = root.document.createElement('i');
      icon.className = report.editing ? 'fas fa-eye' : 'fas fa-pen-to-square';
      open.append(icon, root.document.createTextNode(report.editing ? '唯讀開啟' : '開啟'));
      actions.appendChild(open);
      if (isOwner()) {
        const remove = root.document.createElement('button');
        remove.type = 'button';
        remove.className = 'topic-btn topic-btn-danger topic-row-delete';
        remove.dataset.deleteReport = report.id;
        remove.disabled = Boolean(report.editing);
        remove.title = report.editing
          ? `目前由${report.holderDisplayName || '其他使用者'}編輯，釋放編輯權後才能刪除`
          : `刪除專題「${report.title}」`;
        const removeIcon = root.document.createElement('i');
        removeIcon.className = report.editing ? 'fas fa-lock' : 'fas fa-trash-alt';
        remove.append(removeIcon, root.document.createTextNode('刪除'));
        actions.appendChild(remove);
      }
      actionCell.appendChild(actions);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
    updateSortHeaders();
    renderPrintHistory();
  }

  function renderPrintHistory() {
    const body = $('topicHistoryPrintBody');
    body.replaceChildren();
    sortedReports().forEach((report) => {
      const row = root.document.createElement('tr');
      appendTextCell(row, report.systemNumber);
      appendTextCell(row, report.title);
      appendTextCell(row, report.reportDate);
      appendTextCell(row, report.editing ? `編輯中（${report.holderDisplayName || '其他使用者'}）` : statusText(report));
      appendTextCell(row, `R${Number(report.revision || 0)}`);
      appendTextCell(row, formatBytes(report.logicalBytes));
      appendTextCell(row, formatDateTime(report.updatedAt));
      body.appendChild(row);
    });
    $('topicHistoryPrintMeta').textContent = `列印時間：${formatDateTime(new Date())}　共 ${state.reports.length} 份報告`;
  }

  async function refreshReports(options = {}) {
    if (!state.client) return;
    if (state.busy) { state.refreshQueued = true; return; }
    state.busy = true;
    if (!options.silent) setStatus('正在同步專題報告清單…');
    try {
      const result = await state.client.listReports();
      state.reports = Array.isArray(result.reports) ? result.reports : [];
      renderReports();
      setStatus(`已同步 ${state.reports.length} 份專題報告 · ${formatDateTime(new Date())}`, 'success');
    } catch (error) {
      setStatus(errorLabel(error), 'danger');
      if (/SESSION_INVALID|IDENTITY_REQUIRED/.test(String(error && (error.code || error.message)))) showGate(errorLabel(error));
      if (!options.silent) toast(errorLabel(error), 'danger');
    } finally {
      state.busy = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        root.setTimeout(() => refreshReports({ silent: true }), 0);
      }
    }
  }

  function openCreateDialog() {
    const attempt = state.createAttempt;
    $('topicCreateTitle').value = attempt ? attempt.title : '';
    $('topicCreateDate').value = attempt ? attempt.reportDate : taipeiDate();
    $('topicCreateTitle').readOnly = Boolean(attempt);
    $('topicCreateDate').readOnly = Boolean(attempt);
    $('topicCreateConfirm').textContent = attempt ? '確認上次建立結果' : '建立並開啟';
    $('topicCreateDialog').showModal();
    root.setTimeout(() => (attempt ? $('topicCreateConfirm') : $('topicCreateTitle')).focus(), 0);
  }

  function persistCreateAttempt(attempt) {
    root.sessionStorage.setItem(CREATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      version: 1,
      domain: 'topic',
      workspaceKey: state.identity.workspaceKey,
      actorUserId: state.identity.user.id,
      editorWindowId: attempt.editorWindowId,
      title: attempt.title,
      reportDate: attempt.reportDate,
      content: attempt.content
    }));
  }

  function restoreCreateAttempt() {
    let saved = null;
    try { saved = JSON.parse(root.sessionStorage.getItem(CREATE_ATTEMPT_STORAGE_KEY) || 'null'); }
    catch (_error) { /* invalid envelope is removed below */ }
    const valid = saved && saved.version === 1 && saved.domain === 'topic'
      && saved.workspaceKey === state.identity.workspaceKey
      && saved.actorUserId === state.identity.user.id
      && core.UUID_PATTERN.test(String(saved.editorWindowId || ''))
      && String(saved.title || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(saved.reportDate || ''))
      && saved.content && saved.content.domain === 'topic' && Array.isArray(saved.content.modules);
    if (!valid) {
      root.sessionStorage.removeItem(CREATE_ATTEMPT_STORAGE_KEY);
      state.createAttempt = null;
      return null;
    }
    const attempt = {
      editorWindowId: saved.editorWindowId,
      title: String(saved.title).trim(),
      reportDate: String(saved.reportDate),
      content: saved.content
    };
    const scope = state.client.operationScope('create', clientApi.CREATE_SENTINEL_ID, attempt.editorWindowId);
    if (!state.client.readPending(scope)) {
      root.sessionStorage.removeItem(CREATE_ATTEMPT_STORAGE_KEY);
      state.createAttempt = null;
      return null;
    }
    state.createAttempt = attempt;
    return attempt;
  }

  function clearCreateAttempt() {
    state.createAttempt = null;
    root.sessionStorage.removeItem(CREATE_ATTEMPT_STORAGE_KEY);
    $('topicCreateTitle').readOnly = false;
    $('topicCreateDate').readOnly = false;
    $('topicCreateConfirm').textContent = '建立並開啟';
  }

  async function createReport(event) {
    event.preventDefault();
    if (state.busy) return;
    const title = $('topicCreateTitle').value.trim();
    const reportDate = $('topicCreateDate').value;
    if (!title || !reportDate) return;
    let attempt = state.createAttempt;
    if (attempt && (attempt.title !== title || attempt.reportDate !== reportDate)) {
      setStatus('上一筆建立結果仍未確認；請先重試原本的名稱與日期。', 'danger');
      return;
    }
    if (!attempt) {
      attempt = {
        editorWindowId: root.crypto.randomUUID(),
        title,
        reportDate,
        content: core.createBlankTopicContent({ title, reportDate })
      };
      state.createAttempt = attempt;
      persistCreateAttempt(attempt);
    }
    const editorWindowId = attempt.editorWindowId;
    const pendingName = `topic-editor-pending-${editorWindowId}`;
    const child = root.open('', pendingName);
    if (child) {
      try {
        child.document.title = '正在建立專題報告…';
        child.document.body.textContent = '正在建立專題報告，請稍候…';
      } catch (_error) { /* same-origin about:blank expected */ }
    }
    state.busy = true;
    $('topicCreateConfirm').disabled = true;
    setStatus('正在建立專題報告並配置永久系統編號…');
    let created = null;
    let launched = false;
    try {
      created = await state.client.createReport({
        editorWindowId,
        content: attempt.content,
        title: attempt.title,
        reportDate: attempt.reportDate
      });
      clearCreateAttempt();
      $('topicCreateDialog').close();
      state.pendingLaunches.set(created.report.id, {
        editorWindowId,
        report: created.report,
        lease: created.lease,
        createdAt: Date.now()
      });
      if (!child) {
        try {
          await state.client.releaseLease({ reportId: created.report.id, editorWindowId, lease: created.lease });
        } catch (_releaseError) { /* TTL is the safe fallback */ }
        throw new Error('TOPIC_EDITOR_POPUP_BLOCKED');
      }
      child.name = core.editorWindowName(created.report.id);
      child.location.replace(`./topic-report-editor.html?report=${encodeURIComponent(created.report.id)}`);
      launched = true;
      toast(`${created.report.systemNumber} 已建立`, 'success');
      state.busy = false;
      await refreshReports({ silent: true });
    } catch (error) {
      const scope = state.client.operationScope('create', clientApi.CREATE_SENTINEL_ID, editorWindowId);
      const pending = state.client.readPending(scope);
      if (pending) {
        $('topicCreateTitle').readOnly = true;
        $('topicCreateDate').readOnly = true;
        $('topicCreateConfirm').textContent = '確認上次建立結果';
      } else if (!created) {
        clearCreateAttempt();
      }
      if (created && !launched) {
        state.pendingLaunches.delete(created.report.id);
        try {
          await state.client.releaseLease({ reportId: created.report.id, editorWindowId, lease: created.lease });
        } catch (_releaseError) { /* TTL is the safe fallback */ }
      }
      if (child && !child.closed) child.close();
      const message = error && error.message === 'TOPIC_EDITOR_POPUP_BLOCKED'
        ? '瀏覽器阻擋新窗口；報告已建立但編輯權已釋放，請由清單重新開啟。'
        : errorLabel(error);
      setStatus(message, 'danger');
      toast(message, 'danger');
    } finally {
      state.busy = false;
      $('topicCreateConfirm').disabled = false;
    }
  }

  function openReport(reportId) {
    if (!core.UUID_PATTERN.test(String(reportId || ''))) return;
    const targetName = core.editorWindowName(reportId);
    const targetUrl = `./topic-report-editor.html?report=${encodeURIComponent(reportId)}`;
    const opened = root.open('', targetName);
    if (!opened) {
      toast('瀏覽器阻擋新窗口，請允許此網站開啟分頁。', 'danger');
      return;
    }
    let alreadyOpen = false;
    try {
      const current = new URL(opened.location.href);
      alreadyOpen = current.origin === root.location.origin
        && /\/topic-report-editor\.html$/.test(current.pathname)
        && current.searchParams.get('report') === reportId;
    } catch (_error) { alreadyOpen = false; }
    if (!alreadyOpen) opened.location.replace(targetUrl);
    opened.focus();
  }

  async function deleteReport(reportId) {
    if (state.busy || !isOwner()) return;
    const report = state.reports.find((entry) => entry.id === reportId);
    if (!report) return;
    if (report.editing) {
      toast(`目前由${report.holderDisplayName || '其他使用者'}編輯中；釋放編輯權後才能刪除。`, 'danger');
      return;
    }
    const confirmed = root.confirm(
      `確定刪除專題「${report.title}」？\n\n刪除後會立即從所有人的清單移除，系統編號不會重用。`
    );
    if (!confirmed) return;
    state.busy = true;
    setStatus(`正在刪除專題「${report.title}」…`);
    renderReports();
    try {
      const result = await state.client.deleteReport({
        reportId: report.id,
        expectedRevision: Number(report.revision)
      });
      if (!result || result.deleted !== true) throw new Error('TOPIC_DELETE_NOT_CONFIRMED');
      state.reports = state.reports.filter((entry) => entry.id !== report.id);
      renderReports();
      setStatus(`已刪除專題「${report.title}」 · ${formatDateTime(new Date())}`, 'success');
      toast('專題報告已刪除', 'success');
    } catch (error) {
      const message = errorLabel(error);
      setStatus(message, 'danger');
      toast(message, 'danger');
    } finally {
      state.busy = false;
      renderReports();
    }
  }

  function consumeEditorLaunch(reportId) {
    const value = state.pendingLaunches.get(String(reportId || '')) || null;
    if (value) state.pendingLaunches.delete(String(reportId));
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function printHistory() {
    renderPrintHistory();
    const oldTitle = root.document.title;
    root.document.title = `專題報告歷史清單_${taipeiDate()}`;
    root.document.body.classList.add('topic-printing-history');
    const cleanup = () => {
      root.document.body.classList.remove('topic-printing-history');
      root.document.title = oldTitle;
      root.removeEventListener('afterprint', cleanup);
    };
    root.addEventListener('afterprint', cleanup, { once: true });
    root.print();
    root.setTimeout(cleanup, 1200);
  }

  async function boot() {
    const generation = ++state.bootGeneration;
    showGate('正在確認已登入身份；本頁不會讀取月報內容。');
    try {
      assertTopicAssetBuilds();
      const identity = captureIdentity();
      if (!identity) throw new Error('TOPIC_IDENTITY_REQUIRED');
      const config = root.MONTHLY_REPORT_SUPABASE_CONFIG;
      if (!config) throw new Error('SUPABASE_CONFIG_REQUIRED');
      state.identity = identity;
      const transport = new clientApi.SupabaseTopicTransport(root.supabase, {
        requestTimeoutMs: Number(config.topicRequestTimeoutMs) || 30000
      });
      const client = new clientApi.TopicReportClient({
        transport,
        config: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, workspaceKey: identity.workspaceKey },
        identity,
        sessionStorage: root.sessionStorage,
        draftStorage: root.localStorage
      });
      await client.initialize();
      if (generation !== state.bootGeneration) return;
      state.client = client;
      restoreCreateAttempt();
      renderIdentity();
      showPage();
      await refreshReports();
      root.clearInterval(state.refreshTimer);
      state.refreshTimer = root.setInterval(() => {
        if (root.document.visibilityState === 'visible') refreshReports({ silent: true });
      }, 20000);
    } catch (error) {
      if (generation !== state.bootGeneration) return;
      showGate(errorLabel(error));
    }
  }

  function bind() {
    $('topicIdentityRetry').addEventListener('click', boot);
    $('topicBackMonthly').addEventListener('click', returnToMonthly);
    $('topicAddReport').addEventListener('click', openCreateDialog);
    $('topicRefreshReports').addEventListener('click', () => refreshReports());
    $('topicPrintHistory').addEventListener('click', printHistory);
    $('topicCreateCancel').addEventListener('click', () => $('topicCreateDialog').close());
    $('topicCreateForm').addEventListener('submit', createReport);
    $('topicReportsTable').querySelector('thead').addEventListener('click', (event) => {
      const button = event.target.closest('[data-topic-sort]');
      if (button) changeSort(button.dataset.topicSort);
    });
    $('topicReportsBody').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-delete-report]');
      if (remove) {
        deleteReport(remove.dataset.deleteReport);
        return;
      }
      const open = event.target.closest('[data-open-report]');
      if (open) openReport(open.dataset.openReport);
    });
    root.addEventListener('beforeunload', () => root.clearInterval(state.refreshTimer));
  }

  root.TopicReportsPage = Object.freeze({
    getIdentity: () => state.identity ? JSON.parse(JSON.stringify(state.identity)) : null,
    consumeEditorLaunch,
    refresh: refreshReports,
    openReport,
    changeSort
  });

  root.document.addEventListener('DOMContentLoaded', () => {
    bind();
    boot();
  });
})(window);
