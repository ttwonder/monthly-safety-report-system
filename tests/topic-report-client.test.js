'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureMonthlyIdentity,
  storeIdentityHandoff,
  readIdentityHandoff,
  TopicReportClient
} = require('../topic-reports-client.js');
const core = require('../topic-reports-core.js');

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  key(index) { return Array.from(this.map.keys())[index] || null; }
  get length() { return this.map.size; }
}

function identity(overrides = {}) {
  return {
    version: 1,
    domain: 'topic-auth-handoff',
    workspaceKey: 'workspace-test',
    authorityEpoch: 2,
    clientSessionId: 'tab-a',
    siteSessionId: '11111111-1111-4111-8111-111111111111',
    userSessionId: '22222222-2222-4222-8222-222222222222',
    user: {
      id: '33333333-3333-4333-8333-333333333333',
      username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1
    },
    ...overrides
  };
}

function report(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    systemNumber: 'SR-20260816-001', title: '專題A', reportDate: '2026-08-16',
    revision: 1, status: 'draft', content: {
      schemaVersion: 1, domain: 'topic', title: '專題A', reportDate: '2026-08-16',
      period: { start: '2026-08-16', end: '2026-08-16' },
      settings: { globalFontEn: 'Arial', globalFontZh: 'Noto Sans TC', pdfScale: 95 },
      modules: [{
        id: 'module-a', icon: 'fas fa-file-lines', iconColor: '#4f46e5', title: '內容',
        colLayout: '1', colCount: 1, columns: ['初始'], attachments: [], selectedForPdf: true, pdfOrder: 1
      }]
    },
    ...overrides
  };
}

function lease(overrides = {}) {
  return {
    reportId: '44444444-4444-4444-8444-444444444444',
    leaseId: '55555555-5555-4555-8555-555555555555',
    fencingToken: 3,
    editorWindowId: '66666666-6666-4666-8666-666666666666',
    expiresAt: '2026-08-16T02:00:00.000Z',
    ...overrides
  };
}

test('月報身份交接只包含必要session與安全使用者投影，不攜帶月報內容或credential', () => {
  const monthly = {
    isActive: () => true,
    isWriteReady: () => true,
    client: {
      config: { workspaceKey: 'workspace-test', anonKey: 'do-not-copy', supabaseUrl: 'do-not-copy' },
      status: { authorityEpoch: 2 },
      clientSessionId: 'tab-a',
      siteSession: { id: '11111111-1111-4111-8111-111111111111' },
      userSession: { id: '22222222-2222-4222-8222-222222222222' },
      currentUser: () => ({
        id: '33333333-3333-4333-8333-333333333333', username: 'owner',
        displayName: 'Owner A', role: 'owner', active: true, version: 1,
        passwordHash: 'must-not-copy', token: 'must-not-copy'
      }),
      snapshot: { report: { title: '月報內容' }, modules: [{ title: '月報項次' }] }
    }
  };
  const handoff = captureMonthlyIdentity(monthly);
  assert.deepEqual(handoff, identity());
  const serialized = JSON.stringify(handoff);
  assert.doesNotMatch(serialized, /anonKey|supabaseUrl|password|token|snapshot|modules|月報內容|月報項次/i);
});

test('identity handoff只存於目前專題窗口sessionStorage且讀回時驗證完整shape', () => {
  const storage = new MemoryStorage();
  storeIdentityHandoff(storage, identity());
  assert.deepEqual(readIdentityHandoff(storage), identity());
  assert.equal(storage.length, 1);
  storage.setItem('topic:v1:identity-handoff', JSON.stringify({ ...identity(), domain: 'monthly' }));
  assert.equal(readIdentityHandoff(storage), null);
});

test('專題client所有RPC都走topic namespace且參數帶report與editor window scope', async () => {
  const calls = [];
  const transport = {
    async ensureAnonymous() {},
    async rpc(name, params) {
      calls.push({ name, params });
      if (name.endsWith('list_reports')) return { ok: true, reports: [] };
      if (name.endsWith('get_report')) return { ok: true, report: report() };
      if (name.endsWith('acquire_report_lease')) return { ok: true, ...lease() };
      throw new Error(`unexpected ${name}`);
    }
  };
  const client = new TopicReportClient({ transport, config: { workspaceKey: 'workspace-test' }, identity: identity() });
  await client.initialize();
  await client.listReports();
  await client.openReport({
    reportId: report().id,
    editorWindowId: lease().editorWindowId
  });
  assert.ok(calls.length >= 3);
  calls.forEach(({ name }) => assert.match(name, /^monthly_v7_topic_/));
  assert.equal(calls.some(({ name }) => name === 'monthly_v7_get_snapshot'), false);
  const acquire = calls.find(({ name }) => name.endsWith('acquire_report_lease'));
  assert.equal(acquire.params.p_report_id, report().id);
  assert.equal(acquire.params.p_editor_window_id, lease().editorWindowId);
});

test('保存timeout保留actor/report/window分區draft與pending，重試沿用同operation ID', async () => {
  const sessionStorage = new MemoryStorage();
  const draftStorage = new MemoryStorage();
  const calls = [];
  let attempt = 0;
  const transport = {
    async ensureAnonymous() {},
    async rpc(name, params) {
      calls.push({ name, params: JSON.parse(JSON.stringify(params)) });
      if (name.endsWith('save_report')) {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error('RPC_TIMEOUT');
          error.code = 'RPC_TIMEOUT';
          throw error;
        }
        return { ok: true, report: report({ revision: 2, title: '已修改' }), lease: lease() };
      }
      return { ok: true };
    }
  };
  const client = new TopicReportClient({
    transport, config: { workspaceKey: 'workspace-test' }, identity: identity(),
    sessionStorage, draftStorage,
    idFactory: () => '77777777-7777-4777-8777-777777777777'
  });
  await client.initialize();
  const content = report().content;
  content.title = '已修改';
  await assert.rejects(
    () => client.saveReport({ report: report(), lease: lease(), editorWindowId: lease().editorWindowId, content }),
    /RPC_TIMEOUT/
  );
  assert.equal(sessionStorage.length, 1);
  assert.equal(draftStorage.length, 1);
  const pendingKey = sessionStorage.key(0);
  const pendingEnvelope = JSON.parse(sessionStorage.getItem(pendingKey));
  assert.equal(pendingEnvelope.rpcName, 'monthly_v7_topic_save_report');
  assert.equal(pendingEnvelope.request.p_expected_revision, 1);
  await assert.rejects(
    () => client.retryPendingOperation({ ...pendingEnvelope, rpcName: 'monthly_v7_get_snapshot' }),
    /TOPIC_PENDING_ENVELOPE_INVALID/
  );
  const saved = await client.saveReport({ report: report(), lease: lease(), editorWindowId: lease().editorWindowId, content });
  assert.equal(saved.report.revision, 2);
  const saveCalls = calls.filter(({ name }) => name.endsWith('save_report'));
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0].params.p_operation_id, saveCalls[1].params.p_operation_id);
  assert.equal(sessionStorage.length, 0);
  assert.equal(draftStorage.length, 0);
  assert.match(saveCalls[0].params.p_operation_id, /^[0-9a-f-]{36}$/i);
});

test('新增報告lost ACK重送沿用同一operation ID，不產生第二份報告', async () => {
  const sessionStorage = new MemoryStorage();
  const observedOperationIds = [];
  let first = true;
  const transport = {
    ensureAnonymous: async () => undefined,
    rpc: async (name, params) => {
      assert.equal(name, 'monthly_v7_topic_create_report');
      observedOperationIds.push(params.p_operation_id);
      if (first) {
        first = false;
        const error = new Error('RPC_TIMEOUT');
        error.code = 'RPC_TIMEOUT';
        throw error;
      }
      return {
        ok: true,
        report: {
          id: '77777777-7777-4777-8777-777777777777',
          systemNumber: 'SR-20260816-001', revision: 1
        },
        lease: {
          leaseId: '88888888-8888-4888-8888-888888888888', fencingToken: 1
        }
      };
    }
  };
  const client = new TopicReportClient({
    transport, identity: identity(), sessionStorage, draftStorage: new MemoryStorage()
  });
  await client.initialize();
  const args = {
    editorWindowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'lost ACK建立', reportDate: '2026-08-16',
    content: core.createBlankTopicContent({ title: 'lost ACK建立', reportDate: '2026-08-16' })
  };
  await assert.rejects(client.createReport(args), /RPC_TIMEOUT/);
  assert.equal(sessionStorage.length, 1);
  const replay = await client.createReport(args);
  assert.equal(replay.report.systemNumber, 'SR-20260816-001');
  assert.equal(observedOperationIds.length, 2);
  assert.equal(observedOperationIds[1], observedOperationIds[0]);
  assert.equal(sessionStorage.length, 0);
});

test('完成編輯必須先獲保存ACK才釋放；保存失敗時完全不呼叫release', async () => {
  const calls = [];
  const transport = {
    async ensureAnonymous() {},
    async rpc(name) {
      calls.push(name);
      if (name.endsWith('save_report')) return { ok: false, error: 'REVISION_CONFLICT', currentRevision: 2 };
      if (name.endsWith('release_report_lease')) return { ok: true, released: true };
      return { ok: true };
    }
  };
  const client = new TopicReportClient({ transport, config: { workspaceKey: 'workspace-test' }, identity: identity() });
  await client.initialize();
  await assert.rejects(
    () => client.completeEditing({ report: report(), lease: lease(), editorWindowId: lease().editorWindowId, content: report().content }),
    /REVISION_CONFLICT/
  );
  assert.equal(calls.some((name) => name.endsWith('release_report_lease')), false);

  calls.length = 0;
  transport.rpc = async (name) => {
    calls.push(name);
    if (name.endsWith('save_report')) return { ok: true, report: report({ revision: 2 }), lease: lease() };
    if (name.endsWith('release_report_lease')) return { ok: true, released: true };
    return { ok: true };
  };
  const completed = await client.completeEditing({
    report: report(), lease: lease(), editorWindowId: lease().editorWindowId, content: report().content
  });
  assert.equal(completed.released, true);
  assert.deepEqual(calls.filter((name) => /save_report|release_report_lease/.test(name)), [
    'monthly_v7_topic_save_report', 'monthly_v7_topic_release_report_lease'
  ]);
});

test('身份generation改變後晚到的舊窗口回應被拒絕且不清除新窗口draft', async () => {
  const draftStorage = new MemoryStorage();
  let resolveList;
  const transport = {
    async ensureAnonymous() {},
    rpc(name) {
      if (name.endsWith('list_reports')) return new Promise((resolve) => { resolveList = resolve; });
      return Promise.resolve({ ok: true });
    }
  };
  const client = new TopicReportClient({ transport, config: { workspaceKey: 'workspace-test' }, identity: identity(), draftStorage });
  await client.initialize();
  const pending = client.listReports();
  client.replaceIdentity(identity({ userSessionId: '88888888-8888-4888-8888-888888888888' }));
  draftStorage.setItem('topic:v1:draft:survivor', 'newer');
  resolveList({ ok: true, reports: [{ id: report().id }] });
  await assert.rejects(() => pending, /STALE_TOPIC_CONTEXT/);
  assert.equal(draftStorage.getItem('topic:v1:draft:survivor'), 'newer');
});

test('USER_SESSION_INVALID清除專題identity但保留尚未保存的專題draft', async () => {
  const sessionStorage = new MemoryStorage();
  const draftStorage = new MemoryStorage();
  storeIdentityHandoff(sessionStorage, identity());
  draftStorage.setItem('topic:v1:draft:survivor', 'unsaved');
  const transport = {
    async ensureAnonymous() {},
    async rpc() { return { ok: false, error: 'USER_SESSION_INVALID' }; }
  };
  const client = new TopicReportClient({
    transport, config: { workspaceKey: 'workspace-test' }, identity: identity(), sessionStorage, draftStorage
  });
  await client.initialize();
  await assert.rejects(() => client.listReports(), /USER_SESSION_INVALID/);
  assert.equal(readIdentityHandoff(sessionStorage), null);
  assert.equal(draftStorage.getItem('topic:v1:draft:survivor'), 'unsaved');
  assert.equal(client.currentUser(), null);
});

test('Owner刪除專題使用獨立topic RPC且lost ACK重送沿用同一operation ID', async () => {
  const sessionStorage = new MemoryStorage();
  const calls = [];
  let first = true;
  const transport = {
    async ensureAnonymous() {},
    async rpc(name, params) {
      calls.push({ name, params: JSON.parse(JSON.stringify(params)) });
      assert.equal(name, 'monthly_v7_topic_delete_report');
      if (first) {
        first = false;
        const error = new Error('RPC_TIMEOUT');
        error.code = 'RPC_TIMEOUT';
        throw error;
      }
      return { ok: true, deleted: true, reportId: report().id, operationId: params.p_operation_id };
    }
  };
  const client = new TopicReportClient({
    transport, config: { workspaceKey: 'workspace-test' }, identity: identity(),
    sessionStorage, draftStorage: new MemoryStorage(),
    idFactory: () => '99999999-9999-4999-8999-999999999999'
  });
  await client.initialize();
  await assert.rejects(
    () => client.deleteReport({ reportId: report().id, expectedRevision: 1 }),
    /RPC_TIMEOUT/
  );
  assert.equal(sessionStorage.length, 1);
  const deleted = await client.deleteReport({ reportId: report().id, expectedRevision: 1 });
  assert.equal(deleted.deleted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.p_operation_id, calls[1].params.p_operation_id);
  assert.equal(calls[0].params.p_report_id, report().id);
  assert.equal(calls[0].params.p_expected_revision, 1);
  assert.equal(sessionStorage.length, 0);
});

test('不保存退出只在無pending save時釋放，且release ACK後才清草稿', async () => {
  const sessionStorage = new MemoryStorage();
  const draftStorage = new MemoryStorage();
  const calls = [];
  const transport = {
    async ensureAnonymous() {},
    async rpc(name) {
      calls.push(name);
      assert.equal(name, 'monthly_v7_topic_release_report_lease');
      return { ok: true, released: true };
    }
  };
  const client = new TopicReportClient({
    transport, config: { workspaceKey: 'workspace-test' }, identity: identity(),
    sessionStorage, draftStorage
  });
  await client.initialize();
  const scope = client.operationScope('save', report().id, lease().editorWindowId);
  client.writeDraft(scope, { version: 1, domain: 'topic', content: report().content });
  client.writePending(scope, {
    version: 1, domain: 'topic', operationType: 'save', operationId: '77777777-7777-4777-8777-777777777777',
    actorUserId: identity().user.id, reportId: report().id, editorWindowId: lease().editorWindowId,
    rpcName: 'monthly_v7_topic_save_report', request: {}, requestHash: 'pending'
  });
  await assert.rejects(
    () => client.discardEditing({ reportId: report().id, editorWindowId: lease().editorWindowId, lease: lease() }),
    /TOPIC_PENDING_SAVE_UNCERTAIN/
  );
  assert.equal(calls.length, 0);
  assert.notEqual(client.readDraft(scope), null);

  client.clearPending(scope);
  const discarded = await client.discardEditing({
    reportId: report().id, editorWindowId: lease().editorWindowId, lease: lease()
  });
  assert.equal(discarded.released, true);
  assert.deepEqual(calls, ['monthly_v7_topic_release_report_lease']);
  assert.equal(client.readDraft(scope), null);
});
