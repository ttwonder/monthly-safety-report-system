'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonthlyV7Client } = require('../monthly-collaboration-client.js');
const { SupabaseV7Transport, MonthlyV7BrowserApp } = require('../monthly-collaboration-v7.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function fakeTransport(responses) {
  const calls = [];
  return {
    calls,
    async ensureAnonymous() { calls.push({ name: 'ensureAnonymous' }); },
    async rpc(name, params) {
      calls.push({ name, params });
      const response = responses[name];
      return typeof response === 'function' ? response(params, calls) : response;
    }
  };
}

test('initialize 僅在 NORMALIZED_ACTIVE 啟用 V7，LEGACY_ACTIVE 保持 V6 writer', async () => {
  const legacyTransport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'LEGACY_ACTIVE', authority_epoch: 1, minimum_client_version: 6 }
  });
  const legacy = new MonthlyV7Client({ transport: legacyTransport, sessionStorage: memoryStorage(), draftStorage: memoryStorage() });
  const legacyStatus = await legacy.initialize({ workspaceKey: 'workspace-test' });
  assert.equal(legacyStatus.mode, 'legacy');
  assert.equal(legacy.isActive(), false);

  const activeTransport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 }
  });
  const active = new MonthlyV7Client({ transport: activeTransport, sessionStorage: memoryStorage(), draftStorage: memoryStorage() });
  const activeStatus = await active.initialize({ workspaceKey: 'workspace-test' });
  assert.equal(activeStatus.mode, 'v7');
  assert.equal(active.isActive(), true);
});

test('initialize 對空白、未知、錯誤與不相容 authority status 一律 fail closed', async () => {
  const cases = [
    { label: 'null', response: null, code: 'V7_AUTHORITY_STATUS_INVALID' },
    { label: 'empty', response: { ok: true }, code: 'V7_AUTHORITY_STATUS_INVALID' },
    { label: 'missing-epoch', response: { ok: true, authority_state: 'NORMALIZED_ACTIVE', minimum_client_version: 7 }, code: 'V7_AUTHORITY_STATUS_INVALID' },
    { label: 'missing-version', response: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2 }, code: 'V7_AUTHORITY_STATUS_INVALID' },
    { label: 'wrong-number-type', response: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: '2', minimum_client_version: 7 }, code: 'V7_AUTHORITY_STATUS_INVALID' },
    { label: 'unknown', response: { ok: true, authority_state: 'MIGRATION_UNKNOWN', authority_epoch: 2, minimum_client_version: 7 }, code: 'V7_AUTHORITY_STATE_UNSUPPORTED' },
    { label: 'malformed', response: ['NORMALIZED_ACTIVE'], code: 'V7_AUTHORITY_STATUS_INVALID' },
    {
      label: 'client-version',
      response: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 8 },
      code: 'V7_CLIENT_VERSION_UNSUPPORTED'
    }
  ];

  for (const fixture of cases) {
    const transport = fakeTransport({ monthly_v7_get_status: fixture.response });
    const client = new MonthlyV7Client({
      transport,
      sessionStorage: memoryStorage(),
      draftStorage: memoryStorage(),
      clientVersion: 7
    });
    await assert.rejects(client.initialize({ workspaceKey: 'workspace-test' }), (error) => {
      assert.equal(error.code, fixture.code, fixture.label);
      return true;
    });
    assert.equal(client.status.mode, 'error', fixture.label);
    assert.equal(client.isActive(), false, fixture.label);
    assert.deepEqual(transport.calls.map((call) => call.name), ['ensureAnonymous', 'monthly_v7_get_status'], fixture.label);
  }

  const statusError = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  const transport = fakeTransport({ monthly_v7_get_status: () => { throw statusError; } });
  const client = new MonthlyV7Client({ transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage() });
  await assert.rejects(client.initialize({ workspaceKey: 'workspace-test' }), { code: 'RPC_TIMEOUT' });
  assert.equal(client.status.mode, 'error');
  assert.equal(client.status.errorCode, 'RPC_TIMEOUT');
});

test('session operation context 綁定 generation、actor 與 session IDs', async () => {
  const sessions = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', revision: 1 }, modules: [], records: [], users: []
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: memoryStorage(), idFactory: () => 'tab-context'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  const context = client.captureSessionContext();
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(context, {
    generation: client.sessionGeneration,
    actorUserId: 'u1',
    userSessionId: 'user-1',
    siteSessionId: 'site-1',
    clientSessionId: 'tab-context'
  });
  assert.equal(client.isSessionContextCurrent(context), true);
  client.clearUserSession('test-switch');
  assert.equal(client.isSessionContextCurrent(context), false);
  assert.throws(() => client.assertSessionContext(context, 'queued-save'), (error) => {
    assert.equal(error.code, 'STALE_SESSION_RESPONSE');
    assert.equal(error.rpcName, 'queued-save');
    return true;
  });
});

test('Browser adapter 轉交本機實體與 legacy 救援 hooks 給核心 client', async () => {
  const calls = [];
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.setHost({
    async getLocalEntity(...args) {
      calls.push(['local', ...args]);
      return { id: args[1], title: '本機內容' };
    },
    async getLegacyLocalState(snapshot) {
      calls.push(['legacy', snapshot.report.id]);
      return { fileId: 'legacy-report', modules: [{ id: 101 }] };
    },
    async clearLegacyRecovery(reportId) {
      calls.push(['clear', reportId]);
      return true;
    }
  });

  const host = app.clientHost();
  assert.deepEqual(await host.getLocalEntity('module', 'm1'), { id: 'm1', title: '本機內容' });
  assert.deepEqual(await host.getLegacyLocalState({ report: { id: 'r1' } }), {
    fileId: 'legacy-report', modules: [{ id: 101 }]
  });
  assert.equal(await host.clearLegacyRecovery('r1'), true);
  assert.deepEqual(calls, [
    ['local', 'module', 'm1'],
    ['legacy', 'r1'],
    ['clear', 'r1']
  ]);
});

test('Supabase RPC 超時會明確失敗而不是讓保存狀態永久等待', async () => {
  const transport = new SupabaseV7Transport(null, { requestTimeoutMs: 25 });
  transport.client = { rpc: () => new Promise(() => {}) };

  const outcome = await Promise.race([
    transport.rpc('monthly_v7_save_module', {}).then(
      () => ({ code: 'UNEXPECTED_SUCCESS' }),
      (error) => ({ code: error.code, operation: error.operation, rpcName: error.rpcName, elapsedMs: error.elapsedMs })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ code: 'STILL_PENDING' }), 100))
  ]);

  assert.equal(outcome.code, 'RPC_TIMEOUT');
  assert.equal(outcome.operation, 'monthly_v7_save_module');
  assert.equal(outcome.rpcName, 'monthly_v7_save_module');
  assert.ok(outcome.elapsedMs >= 20, `elapsedMs=${outcome.elapsedMs}`);
});

test('背景 Failed to fetch 顯示結果未確認而非誤稱雲端操作或保存失敗', () => {
  const statuses = [];
  const reported = [];
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.client = { sessionErrorCode: () => '' };
  app.setHost({
    onTransportError(error) { reported.push(error); },
    setStatus(text, kind) { statuses.push({ text, kind }); }
  });
  const error = new TypeError('Failed to fetch');

  app.reportError(error);

  assert.deepEqual(reported, [error]);
  assert.equal(statuses.at(-1).kind, 'warn');
  assert.match(statuses.at(-1).text, /雲端連線.*暫時無法確認/);
  assert.match(statuses.at(-1).text, /本機草稿.*保留/);
  assert.doesNotMatch(statuses.at(-1).text, /雲端操作失敗|保存失敗/);
});

test('非網路的確定協作錯誤仍維持 error 狀態', () => {
  const statuses = [];
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.client = { sessionErrorCode: () => '' };
  app.setHost({ setStatus(text, kind) { statuses.push({ text, kind }); } });

  app.reportError(Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }));

  assert.equal(statuses.at(-1).kind, 'error');
  assert.match(statuses.at(-1).text, /逐項雲端操作失敗：PERMISSION_DENIED/);
});

test('site/user session 綁定分頁 ID，登入後套用不含 hash 的 normalized snapshot', async () => {
  let appliedBundle;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1', expires_at: '2026-08-11T00:00:00Z' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', displayName: 'Owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true,
      watermark: 9,
      report: { id: 'r1', legacyFileId: 'legacy', title: 'V7 月報', date: '2026-08-10', period: {}, revision: 3 },
      modules: [{ id: 'm1', legacyItemId: 'legacy-m1', revision: 2, payload: { title: '模塊', columns: ['內容'] } }],
      records: [],
      users: [{ id: 'u1', username: 'owner', displayName: 'Owner', role: 'owner', password_hash: 'NEVER' }]
    }
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: memoryStorage(),
    idFactory: () => 'tab-session-1',
    host: { async applyBundle(bundle) { appliedBundle = bundle; } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate-pass');
  await client.login('owner', 'owner-pass');

  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.currentUser().role, 'owner');
  assert.equal(appliedBundle.report.modules[0]._v7Id, 'm1');
  assert.equal(JSON.stringify(appliedBundle).includes('NEVER'), false);
  const siteCall = transport.calls.find((call) => call.name === 'monthly_v7_open_site');
  const loginCall = transport.calls.find((call) => call.name === 'monthly_v7_login_user');
  assert.equal(siteCall.params.p_client_session_id, 'tab-session-1');
  assert.equal(loginCall.params.p_client_session_id, 'tab-session-1');
});

test('登入 RPC 成功但 snapshot 失敗時保留原始錯誤，不得留下半登入身份或啟用雲端寫入', async () => {
  for (const fixture of [
    {
      label: 'timeout',
      snapshot: () => { throw Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' }); },
      expectedCode: 'RPC_TIMEOUT',
      siteRemains: true
    },
    {
      label: 'site-invalid',
      snapshot: { ok: false, error: 'SITE_SESSION_INVALID' },
      expectedCode: 'SITE_SESSION_INVALID',
      siteRemains: false
    }
  ]) {
    const sessions = memoryStorage();
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_open_site: { ok: true, site_session_id: `site-${fixture.label}` },
      monthly_v7_login_user: {
        ok: true, user_session_id: `user-${fixture.label}`,
        user: { id: 'u1', username: 'owner', displayName: 'Owner', role: 'owner' }
      },
      monthly_v7_get_snapshot: fixture.snapshot
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: sessions, draftStorage: memoryStorage(), idFactory: () => `tab-login-${fixture.label}`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    await client.openSite('gate');

    await assert.rejects(client.login('owner', 'owner-pass'), (error) => {
      assert.equal(error.code, fixture.expectedCode, fixture.label);
      assert.equal(error.loginStage, 'snapshot', fixture.label);
      assert.equal(error.credentialsAccepted, true, fixture.label);
      return true;
    });
    assert.equal(client.hasSiteSession(), fixture.siteRemains, fixture.label);
    assert.equal(client.currentUser(), null, fixture.label);
    assert.equal(client.isWriteReady(), false, fixture.label);
    assert.equal(client.userSession, null, fixture.label);
    assert.equal(sessions.getItem('monthly_v7_user_session'), null, fixture.label);
    assert.equal(sessions.getItem('monthly_v7_user_projection'), null, fixture.label);
  }
});

test('恢復的舊 site/user session 在 snapshot 驗證完成前不得解鎖或被視為已登入', async () => {
  const sessions = memoryStorage();
  sessions.setItem('monthly_v7_site_session', JSON.stringify({ id: 'site-old' }));
  sessions.setItem('monthly_v7_user_session', JSON.stringify({ id: 'user-old' }));
  sessions.setItem('monthly_v7_user_projection', JSON.stringify({ id: 'u1', username: 'owner', role: 'owner' }));
  const sessionEvents = [];
  const client = new MonthlyV7Client({
    transport: fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_get_snapshot: {
        ok: true,
        watermark: 1,
        report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
        modules: [], records: [], users: [{ id: 'u1', username: 'owner', role: 'owner' }]
      }
    }),
    sessionStorage: sessions,
    draftStorage: memoryStorage(),
    host: { onSessionStateChanged: (event) => sessionEvents.push(event) }
  });

  await client.initialize({ workspaceKey: 'workspace-test' });

  assert.equal(client.isSiteSessionPendingValidation(), true);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
  assert.equal(client.isWriteReady(), false);
  assert.equal(client.userSession.id, 'user-old');
  await assert.rejects(client.login('owner', 'pass'), /SITE_SESSION_REQUIRED/);

  await client.loadSnapshot();

  assert.equal(client.isSiteSessionPendingValidation(), false);
  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.currentUser().role, 'owner');
  assert.equal(client.isWriteReady(), true);
  assert.equal(sessionEvents.at(-1).reason, 'user-session-validated');
});

test('恢復的 site session 驗證失效時清除 session 並保留本機草稿', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const sessionEvents = [];
  sessions.setItem('monthly_v7_site_session', JSON.stringify({ id: 'site-old' }));
  const client = new MonthlyV7Client({
    transport: fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_get_snapshot: { ok: false, error: 'SITE_SESSION_INVALID' }
    }),
    sessionStorage: sessions,
    draftStorage: drafts,
    host: { onSessionStateChanged: (event) => sessionEvents.push(event) }
  });

  await client.initialize({ workspaceKey: 'workspace-test' });
  client.saveDraft('module', 'm1', { title: '保留草稿' }, 1);

  await assert.rejects(client.loadSnapshot(), /SITE_SESSION_INVALID/);

  assert.equal(client.siteSession, null);
  assert.equal(client.isSiteSessionPendingValidation(), false);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(client.readDraft('module', 'm1').payload.title, '保留草稿');
  assert.equal(sessionEvents.at(-1).code, 'SITE_SESSION_INVALID');
});

test('首次 V7 只恢復來源一致且較新的既有項目，本機獨有項隔離且登入後仍不進 live bundle', async () => {
  const drafts = memoryStorage();
  const bundles = [];
  const sourceTimestamp = Date.parse('2026-08-11T00:00:00.000Z');
  const snapshot = {
    ok: true, workspaceId: 'w1', authorityState: 'NORMALIZED_ACTIVE', authorityEpoch: 2,
    watermark: 9,
    report: { id: 'r1', legacyFileId: 'legacy-report', title: '月報', period: {}, revision: 2 },
    modules: [
      { id: 'm2', legacyItemId: '2', sortRank: 1, revision: 2, updatedAt: '2026-08-10T00:00:00.000Z', payload: { id: 2, title: '雲端二', columns: ['雲端二'] } },
      { id: 'm1', legacyItemId: '1', sortRank: 2, revision: 3, updatedAt: '2026-08-10T00:00:00.000Z', payload: { id: 1, title: '雲端一', columns: ['雲端一'] } }
    ],
    records: [], users: [{ id: 'u1', username: 'owner', role: 'owner' }]
  };
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: () => JSON.parse(JSON.stringify(snapshot))
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    host: {
      getLegacyLocalState: async () => ({
        fileId: 'legacy-report', recoverySourceId: 'legacy-report', timestamp: sourceTimestamp,
        modules: [
          { id: 1, title: '本機一', columns: ['本機內容一'] },
          { id: 2, title: '本機二', columns: ['本機內容二'] },
          { id: 999, title: '本機新增', columns: ['不能遺失'] }
        ]
      }),
      applyBundle: async (bundle) => bundles.push(bundle)
    }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.loadSnapshot();
  assert.equal(client.snapshot.workspace.id, 'w1');
  assert.deepEqual(bundles.at(-1).report.modules.map((row) => [String(row.id), row.columns[0]]), [
    ['1', '本機內容一'], ['2', '本機內容二']
  ]);
  assert.equal(client.snapshot.legacyLocalRecovery.quarantinedCount, 1);
  assert.equal(client.snapshot.legacyLocalRecovery.hasAcceptedRecovery, true);
  assert.deepEqual(client.snapshot.localOnlyModules, []);

  await client.login('owner', 'owner-pass');

  assert.deepEqual(bundles.at(-1).report.modules.map((row) => [String(row.id), row.columns[0]]), [
    ['1', '本機內容一'], ['2', '本機內容二']
  ]);
  assert.equal(client.currentUser().role, 'owner');
  assert.ok(drafts.getItem('monthly_v7_draft:module:m1'));
  assert.ok(drafts.getItem('monthly_v7_draft:module:m2'));
});

test('救援待確認期間的後續既有項目編輯在 full snapshot 後仍保留且零寫入', async () => {
  const drafts = memoryStorage();
  const bundles = [];
  let liveItem = null;
  const snapshot = {
    ok: true, workspaceId: 'w1', authorityState: 'NORMALIZED_ACTIVE', authorityEpoch: 2,
    watermark: 9,
    report: { id: 'r1', legacyFileId: 'legacy-report', title: '月報', period: {}, revision: 2 },
    modules: [{
      id: 'm1', legacyItemId: '1', sortRank: 1, revision: 3,
      updatedAt: '2026-08-10T00:00:00.000Z',
      payload: { id: 1, title: '雲端一', columns: ['雲端內容一'] }
    }],
    records: [], users: [{ id: 'u1', username: 'owner', role: 'owner' }]
  };
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: () => JSON.parse(JSON.stringify(snapshot))
  });
  const app = new MonthlyV7BrowserApp({ transport });
  await app.initialize({ workspaceKey: 'workspace-test' }, {
    getLegacyLocalState: async () => ({
      fileId: 'legacy-report', recoverySourceId: 'legacy-report',
      timestamp: Date.parse('2026-08-11T00:00:00.000Z'),
      modules: [{ id: 1, title: '初始救援一', columns: ['初始救援內容一'] }]
    }),
    getLocalEntity: async (entityType, entityId) => (
      entityType === 'module' && entityId === 'm1' && liveItem
        ? JSON.parse(JSON.stringify(liveItem))
        : null
    ),
    applyBundle: async (bundle) => bundles.push(JSON.parse(JSON.stringify(bundle)))
  });
  app.client.draftStorage = drafts;
  await app.openSite('gate');
  await app.client.login('owner', 'owner-pass');

  liveItem = JSON.parse(JSON.stringify(bundles.at(-1).report.modules[0]));
  liveItem.title = '救援後最新編輯';
  liveItem.columns = ['救援後最新內容'];
  const pending = await app.persistReportData([liveItem], { confirmLegacyRecovery: false });

  assert.equal(pending.recoveryPending, true);
  assert.equal(transport.calls.some((call) => call.name === 'monthly_v7_save_module'), false);
  assert.equal(app.client.readDraft('module', 'm1').payload.title, '救援後最新編輯');
  await app.client.loadSnapshot();
  assert.equal(bundles.at(-1).report.modules[0].title, '救援後最新編輯');
  assert.equal(bundles.at(-1).report.modules[0].columns[0], '救援後最新內容');
  assert.equal(transport.calls.some((call) => call.name === 'monthly_v7_save_module'), false);
});

test('legacy 來源不符或本機時間不晚於 authority 時只隔離，不建立 draft 或改變 live 內容', async () => {
  for (const legacyLocal of [
    {
      fileId: 'legacy-report', recoverySourceId: 'other-source',
      timestamp: Date.parse('2026-08-12T00:00:00.000Z'),
      modules: [{ id: 1, title: '來源不符內容', columns: ['不可套用'] }]
    },
    {
      fileId: 'legacy-report', recoverySourceId: 'legacy-report',
      timestamp: Date.parse('2026-08-09T00:00:00.000Z'),
      modules: [{ id: 1, title: '較舊內容', columns: ['不可套用'] }]
    }
  ]) {
    const drafts = memoryStorage();
    let bundle;
    const client = new MonthlyV7Client({
      transport: fakeTransport({
        monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
        monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
        monthly_v7_get_snapshot: {
          ok: true, watermark: 1,
          report: { id: 'r1', legacyFileId: 'legacy-report', title: '雲端月報', period: {}, revision: 1 },
          modules: [{
            id: 'm1', legacyItemId: '1', sortRank: 1, revision: 4,
            updatedAt: '2026-08-10T00:00:00.000Z',
            payload: { id: 1, title: '雲端權威', columns: ['雲端內容'] }
          }],
          records: [], users: []
        }
      }),
      sessionStorage: memoryStorage(), draftStorage: drafts,
      host: {
        getLegacyLocalState: async () => legacyLocal,
        applyBundle: async (value) => { bundle = value; }
      }
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    await client.openSite('gate');
    await client.loadSnapshot();

    assert.equal(bundle.report.modules[0].title, '雲端權威');
    assert.equal(bundle.report.modules[0].columns[0], '雲端內容');
    assert.equal(client.readDraft('module', 'm1'), null);
    assert.deepEqual(client.snapshot.localOnlyModules, []);
    assert.equal(client.snapshot.legacyLocalRecovery.hasAcceptedRecovery, false);
    assert.ok(client.snapshot.legacyLocalRecovery.quarantinedCount >= 1);
  }
});

test('snapshot 只以同 actor 的有效 V7 reorder pending 恢復顯示順序', async () => {
  const drafts = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000810';
  drafts.setItem('monthly_v7_pending:reorder_modules:r1', JSON.stringify({
    operationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4,
      p_module_order: ['m2', 'm1']
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));
  let bundle;
  const client = new MonthlyV7Client({
    transport: fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
      monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
      monthly_v7_get_snapshot: {
        ok: true, watermark: 1,
        report: { id: 'r1', legacyFileId: 'legacy-report', title: '月報', revision: 3, period: {} },
        modules: [
          { id: 'm1', legacyItemId: '1', sortRank: 1, revision: 1, payload: { id: 1, title: 'A' } },
          { id: 'm2', legacyItemId: '2', sortRank: 2, revision: 1, payload: { id: 2, title: 'B' } }
        ],
        records: [], users: [{ id: 'u1', username: 'owner', role: 'owner' }]
      }
    }),
    sessionStorage: memoryStorage(), draftStorage: drafts,
    host: { applyBundle: async (value) => { bundle = value; } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  assert.deepEqual(bundle.report.modules.map((row) => row._v7Id), ['m2', 'm1']);
  assert.ok(drafts.getItem('monthly_v7_pending:reorder_modules:r1'));
});

test('連續登入時舊 attempt 的 snapshot 晚失敗不得清除後繼成功 session', async () => {
  const sessions = memoryStorage();
  let resolveSnapshotA;
  let rejectSnapshotA;
  let snapshotCalls = 0;
  const snapshotA = new Promise((resolve, reject) => {
    resolveSnapshotA = resolve;
    rejectSnapshotA = reject;
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: (params) => ({
      ok: true,
      user_session_id: params.p_username === 'a' ? 'session-a' : 'session-b',
      user: { id: params.p_username === 'a' ? 'u-a' : 'u-b', username: params.p_username, role: 'owner' }
    }),
    monthly_v7_get_snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return snapshotA;
      return {
        ok: true, watermark: 2,
        report: { id: 'r1', revision: 2 }, modules: [], records: [], users: []
      };
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: memoryStorage(), idFactory: () => 'tab-login-race'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');

  const loginA = client.login('a', 'pass');
  await new Promise((resolve) => setImmediate(resolve));
  const loginB = client.login('b', 'pass');
  const userB = await loginB;
  rejectSnapshotA(Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' }));
  await assert.rejects(loginA, (error) => error.code === 'STALE_LOGIN_ATTEMPT' || error.code === 'RPC_TIMEOUT');

  assert.equal(userB.username, 'b');
  assert.equal(client.currentUser().username, 'b');
  assert.equal(client.userSession.id, 'session-b');
  assert.equal(client.isWriteReady(), true);
  assert.equal(JSON.parse(sessions.getItem('monthly_v7_user_session')).id, 'session-b');
  assert.equal(JSON.parse(sessions.getItem('monthly_v7_user_projection')).username, 'b');
  resolveSnapshotA?.({ ok: true });
});

test('連續登入時舊 attempt 即使 snapshot 先成功也不得覆蓋後發登入', async () => {
  let resolveSnapshotA;
  let resolveSnapshotB;
  let snapshotCalls = 0;
  const snapshotA = new Promise((resolve) => { resolveSnapshotA = resolve; });
  const snapshotB = new Promise((resolve) => { resolveSnapshotB = resolve; });
  const snapshot = (revision) => ({
    ok: true, watermark: revision,
    report: { id: 'r1', revision }, modules: [], records: [], users: []
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: (params) => ({
      ok: true,
      user_session_id: params.p_username === 'a' ? 'session-a' : 'session-b',
      user: { id: params.p_username === 'a' ? 'u-a' : 'u-b', username: params.p_username, role: 'owner' }
    }),
    monthly_v7_get_snapshot: () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? snapshotA : snapshotB;
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab-login-race-2'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');

  const loginA = client.login('a', 'pass');
  await new Promise((resolve) => setImmediate(resolve));
  const loginB = client.login('b', 'pass');
  resolveSnapshotA(snapshot(1));
  await assert.rejects(loginA, (error) => error.code === 'STALE_LOGIN_ATTEMPT');
  resolveSnapshotB(snapshot(2));
  const userB = await loginB;

  assert.equal(userB.username, 'b');
  assert.equal(client.currentUser().username, 'b');
  assert.equal(client.userSession.id, 'session-b');
  assert.equal(client.currentReport().revision, 2);
  assert.equal(client.isWriteReady(), true);
});

test('claimLease 被占用時帶出持鎖者顯示名稱，不暴露 LEASE_HELD 技術碼', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u2', username: 'operator', role: 'operator' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: false,
      error: 'LEASE_HELD',
      holder_display_name: '王主管',
      expires_at: '2026-08-11T01:02:03Z'
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab-b'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('operator', 'pass');

  await assert.rejects(() => client.claimLease('module', 'm1'), (error) => {
    assert.equal(error.code, 'LEASE_HELD');
    assert.equal(error.holderDisplayName, '王主管');
    assert.equal(error.message, '此項目目前由「王主管」編輯，請稍後再試。');
    assert.equal(error.message.includes('LEASE_HELD'), false);
    return true;
  });
});

test('logoutUser 只撤銷 user session，保留 site session 與本機草稿', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true,
      user_session_id: 'user-1',
      user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true,
      watermark: 1,
      report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '草稿' } }],
      records: [], users: []
    },
    monthly_v7_logout_user: { ok: true, revoked: true }
  });
  const client = new MonthlyV7Client({ transport, sessionStorage: sessions, draftStorage: drafts });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  client.saveDraft('module', 'm1', { title: '尚未提交' }, 1);
  transport.calls.length = 0;

  await client.logoutUser();

  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_logout_user']);
  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.currentUser(), null);
  assert.equal(client.userSession, null);
  assert.equal(sessions.getItem('monthly_v7_site_session'), JSON.stringify({ id: 'site-1', expiresAt: '' }));
  assert.equal(sessions.getItem('monthly_v7_user_session'), null);
  assert.equal(sessions.getItem('monthly_v7_user_projection'), null);
  assert.equal(client.readDraft('module', 'm1').payload.title, '尚未提交');
});

test('initialize 的 site resume timeout 保留 marker 並回到手動 Gate', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'c'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  const timeout = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_exchange_site_resume: () => { throw timeout; },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-manual' }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes
  });

  const status = await client.initialize({ workspaceKey: 'workspace-test' });

  assert.equal(status.mode, 'v7');
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.siteSession, null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), marker);
  await client.openSite('gate');
  assert.equal(client.isSiteUnlocked(), true);
  assert.deepEqual(transport.calls.map((call) => call.name), [
    'ensureAnonymous', 'monthly_v7_get_status', 'monthly_v7_exchange_site_resume', 'monthly_v7_open_site'
  ]);
});

test('缺少 site resume RPC 時保留 marker 並允許既有手動進站流程', async () => {
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'd'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  const missingRpc = Object.assign(
    new Error('Could not find the function public.monthly_v7_exchange_site_resume in the schema cache'),
    { code: 'PGRST202' }
  );
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_exchange_site_resume: () => { throw missingRpc; },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-manual' }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), resumeStorage: resumes
  });

  const status = await client.initialize({ workspaceKey: 'workspace-test' });

  assert.equal(status.mode, 'v7');
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), marker);
  await client.openSite('gate');
  assert.equal(client.isSiteUnlocked(), true);
});

test('site resume 權限或未知 SQL 錯誤仍 fail closed，不得偽裝成 capability missing', async () => {
  for (const failure of [
    Object.assign(new Error('permission denied for function monthly_v7_exchange_site_resume'), { code: '42501' }),
    Object.assign(new Error('unexpected database failure'), { code: 'XX000' })
  ]) {
    const resumes = memoryStorage();
    resumes.setItem('monthly_v7_site_resume_marker', JSON.stringify({
      version: 1,
      purpose: 'site',
      token: 'e'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2
    }));
    const client = new MonthlyV7Client({
      transport: fakeTransport({
        monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
        monthly_v7_exchange_site_resume: () => { throw failure; }
      }),
      sessionStorage: memoryStorage(), draftStorage: memoryStorage(), resumeStorage: resumes
    });
    await assert.rejects(client.initialize({ workspaceKey: 'workspace-test' }), (error) => error === failure);
    assert.equal(client.isSiteUnlocked(), false);
  }
});

for (const { method, rpcName } of [
  { method: 'logout', rpcName: 'monthly_v7_logout' },
  { method: 'forgetTrustedDevice', rpcName: 'monthly_v7_forget_trusted_device' }
]) {
  test(`${method} 收到 SITE_SESSION_INVALID 時仍清本機 marker 並保留 recovery evidence`, async () => {
    const sessions = memoryStorage();
    const drafts = memoryStorage();
    const resumes = memoryStorage();
    const marker = JSON.stringify({
      version: 1,
      purpose: 'site',
      token: '4'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2
    });
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_open_site: { ok: true, site_session_id: `site-${method}-invalid` },
      [rpcName]: { ok: false, error: 'SITE_SESSION_INVALID' }
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
      idFactory: () => `tab-${method}-invalid`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    await client.openSite('gate');
    resumes.setItem('monthly_v7_site_resume_marker', marker);
    client.saveDraft('module', `m-${method}-invalid`, { title: 'session失效仍保留' }, 1);
    drafts.setItem(`monthly_v7_pending:save_module:m-${method}-invalid`, '{session-invalid-pending');

    await assert.rejects(client[method](), (error) => error?.code === 'SITE_SESSION_INVALID');

    assert.equal(client.isSiteUnlocked(), false);
    assert.equal(sessions.getItem('monthly_v7_site_session'), null);
    assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
    assert.equal(client.readDraft('module', `m-${method}-invalid`).payload.title, 'session失效仍保留');
    assert.equal(drafts.getItem(`monthly_v7_pending:save_module:m-${method}-invalid`), '{session-invalid-pending');
  });
}

test('full site logout server 回 ok false 時上拋未確認，但仍清本機 marker/session 並保留 draft', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: '7'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-logout-false' },
    monthly_v7_logout: { ok: false, error: 'LOGOUT_NOT_CONFIRMED' }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  client.saveDraft('module', 'm-logout-false', { title: '登出未確認仍保留' }, 1);

  await assert.rejects(client.logout(), /LOGOUT_NOT_CONFIRMED/);

  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(client.readDraft('module', 'm-logout-false').payload.title, '登出未確認仍保留');
});

test('full site logout 有 marker 但 server 回 trustedDeviceRevoked false 時不得宣稱已確認', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: '6'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-logout-device-false' },
    monthly_v7_logout: { ok: true, revoked: true, trustedDeviceRevoked: false }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  client.saveDraft('module', 'm-logout-device-false', { title: '裝置撤銷未確認仍保留' }, 1);
  drafts.setItem('monthly_v7_pending:save_module:m-logout-device-false', '{logout-device-false-pending');

  await assert.rejects(
    client.logout(),
    (error) => error?.code === 'TRUSTED_DEVICE_REVOCATION_NOT_CONFIRMED'
  );

  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(client.readDraft('module', 'm-logout-device-false').payload.title, '裝置撤銷未確認仍保留');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m-logout-device-false'), '{logout-device-false-pending');
});

test('forgetTrustedDevice 呼叫專用撤銷 RPC 並清 sessions/marker，但保留 draft pending', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'f'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-forget' },
    monthly_v7_forget_trusted_device: { ok: true, forgotten: true, trusted_device_id: 'device-forget' }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-forget'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  client.saveDraft('module', 'm-forget', { title: '忘記裝置仍保留' }, 1);
  drafts.setItem('monthly_v7_pending:save_module:m-forget', '{forget-pending-evidence');
  transport.calls.length = 0;

  const result = await client.forgetTrustedDevice();

  assert.equal(result.forgotten, true);
  assert.deepEqual(transport.calls, [{
    name: 'monthly_v7_forget_trusted_device',
    params: {
      p_workspace_key: 'workspace-test',
      p_site_session_id: 'site-forget',
      p_client_session_id: 'tab-forget'
    }
  }]);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(client.readDraft('module', 'm-forget').payload.title, '忘記裝置仍保留');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m-forget'), '{forget-pending-evidence');
});

test('forgetTrustedDevice server 回 ok true 但 forgotten false 時上拋未確認並清本機狀態', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: '5'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-forget-false' },
    monthly_v7_forget_trusted_device: { ok: true, forgotten: false }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-forget-false'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  client.saveDraft('module', 'm-forget-false', { title: '忘記未確認仍保留' }, 1);
  drafts.setItem('monthly_v7_pending:save_module:m-forget-false', '{forget-false-pending');

  await assert.rejects(
    client.forgetTrustedDevice(),
    (error) => error?.code === 'FORGET_TRUSTED_DEVICE_NOT_CONFIRMED'
  );

  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(client.readDraft('module', 'm-forget-false').payload.title, '忘記未確認仍保留');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m-forget-false'), '{forget-false-pending');
});

test('user resume marker 與 site marker 分離，只有 trusted site 上的已驗證 user 才可發行', async () => {
  const sessions = memoryStorage();
  const resumes = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-user-issue' },
    monthly_v7_issue_site_resume: {
      ok: true,
      trusted_device_id: 'device-user-issue',
      resume_token: 'a'.repeat(64),
      expires_at: '2099-01-01T00:00:00.000Z',
      authority_epoch: 2
    },
    monthly_v7_login_user: {
      ok: true,
      user_session_id: 'user-issue',
      user: { id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: []
    },
    monthly_v7_issue_user_resume: {
      ok: true,
      trusted_device_id: 'device-user-issue',
      resume_token: 'b'.repeat(64),
      expires_at: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: memoryStorage(), resumeStorage: resumes,
    idFactory: () => 'tab-user-issue'
  });

  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.issueSiteResume();
  await client.login('owner', 'pass');
  await client.issueUserResume();

  const siteMarker = JSON.parse(resumes.getItem('monthly_v7_site_resume_marker'));
  const userMarker = JSON.parse(resumes.getItem('monthly_v7_user_resume_marker'));
  assert.equal(siteMarker.purpose, 'site');
  assert.equal(userMarker.purpose, 'user');
  assert.equal(userMarker.token, 'b'.repeat(64));
  assert.equal(userMarker.trustedDeviceId, 'device-user-issue');
  assert.equal(userMarker.authorityEpoch, 2);
  assert.equal(JSON.stringify(userMarker).includes('owner'), false);
  assert.equal(JSON.stringify(userMarker).includes('pass'), false);
  assert.deepEqual(transport.calls.find((call) => call.name === 'monthly_v7_issue_user_resume').params, {
    p_workspace_key: 'workspace-test',
    p_site_session_id: 'site-user-issue',
    p_user_session_id: 'user-issue',
    p_client_session_id: 'tab-user-issue'
  });
});

test('malformed、expired 或 authority-mismatched user marker fail closed 且零 exchange RPC', async () => {
  const fixtures = [
    { label: 'malformed-json', raw: '{broken-user-marker', rejects: false },
    {
      label: 'expired',
      raw: JSON.stringify({
        version: 1, purpose: 'user', token: '4'.repeat(64),
        expiresAt: '2000-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-marker-check'
      }),
      rejects: false
    },
    {
      label: 'authority-mismatch',
      raw: JSON.stringify({
        version: 1, purpose: 'user', token: '5'.repeat(64),
        expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 1, trustedDeviceId: 'device-marker-check'
      }),
      rejects: true
    }
  ];
  for (const fixture of fixtures) {
    const resumes = memoryStorage();
    const drafts = memoryStorage();
    resumes.setItem('monthly_v7_user_resume_marker', fixture.raw);
    drafts.setItem('monthly_v7_draft:module:user-marker-check', JSON.stringify({
      payload: { title: 'marker 錯誤仍保留' }, baseRevision: 1
    }));
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 }
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: memoryStorage(), draftStorage: drafts, resumeStorage: resumes,
      idFactory: () => `tab-marker-${fixture.label}`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    client.siteSession = {
      id: `site-marker-${fixture.label}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      trustedDeviceId: 'device-marker-check'
    };
    client.siteSessionPendingValidation = false;

    if (fixture.rejects) await assert.rejects(client.restoreUserFromMarker(), /USER_RESUME_AUTHORITY_CHANGED/);
    else assert.equal(await client.restoreUserFromMarker(), null, fixture.label);

    assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null, fixture.label);
    assert.equal(client.readDraft('module', 'user-marker-check').payload.title, 'marker 錯誤仍保留', fixture.label);
    assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_exchange_user_resume').length, 0, fixture.label);
  }
});

test('expired user-resume replacement 不得標記成功；exchange 已消耗舊 token 後清 marker 且零 snapshot', async () => {
  const resumes = memoryStorage();
  resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
    version: 1, purpose: 'user', token: '6'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-expired-replacement'
  }));
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_exchange_user_resume: {
      ok: true,
      user_session_id: 'user-expired-replacement',
      trusted_device_id: 'device-expired-replacement',
      resume_token: '7'.repeat(64),
      expires_at: '2000-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'owner', role: 'owner', active: true, version: 1 }
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), resumeStorage: resumes,
    idFactory: () => 'tab-expired-replacement'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  client.siteSession = {
    id: 'site-expired-replacement',
    expiresAt: '2099-01-01T00:00:00.000Z',
    trustedDeviceId: 'device-expired-replacement'
  };
  client.siteSessionPendingValidation = false;

  await assert.rejects(client.restoreUserFromMarker(), /USER_RESUME_MARKER_INVALID/);

  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null);
  assert.equal(client.currentUser(), null);
  assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_get_snapshot').length, 0);
});

test('user resume 交換後仍保持未登入，直到新 user session 的 authoritative snapshot 成功', async () => {
  const sessions = memoryStorage();
  const resumes = memoryStorage();
  resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
    version: 1,
    purpose: 'user',
    token: 'c'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2,
    trustedDeviceId: 'device-user-restore'
  }));
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_exchange_user_resume: {
      ok: true,
      user_session_id: 'user-restored',
      trusted_device_id: 'device-user-restore',
      resume_token: 'd'.repeat(64),
      expires_at: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }
    },
    monthly_v7_get_snapshot: () => snapshotGate
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: memoryStorage(), resumeStorage: resumes,
    idFactory: () => 'tab-user-restore'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  client.siteSession = {
    id: 'site-restored',
    expiresAt: '2099-01-01T00:00:00.000Z',
    trustedDeviceId: 'device-user-restore'
  };
  client.siteSessionPendingValidation = false;

  const restoring = client.restoreUserFromMarker();
  while (!transport.calls.some((call) => call.name === 'monthly_v7_get_snapshot')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(client.currentUser(), null);
  assert.equal(client.userSessionPendingValidation, true);
  assert.equal(JSON.parse(resumes.getItem('monthly_v7_user_resume_marker')).token, 'd'.repeat(64));

  releaseSnapshot({
    ok: true, watermark: 2,
    report: { id: 'r1', revision: 1 }, modules: [], records: [],
    users: [{ id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }]
  });
  const restored = await restoring;

  assert.equal(restored.username, 'owner');
  assert.equal(client.currentUser().role, 'owner');
  assert.equal(client.userSessionPendingValidation, false);
  assert.equal(JSON.parse(sessions.getItem('monthly_v7_user_session')).id, 'user-restored');
  assert.equal(JSON.parse(sessions.getItem('monthly_v7_user_projection')).username, 'owner');
});

test('user resume timeout 保留可重試 marker；永久拒絕清 marker，兩者都不得投影身份', async () => {
  for (const fixture of [
    { label: 'timeout', response: () => { throw Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' }); }, keep: true },
    { label: 'invalid', response: { ok: false, error: 'USER_RESUME_INVALID' }, keep: false }
  ]) {
    const sessions = memoryStorage();
    const resumes = memoryStorage();
    const rawMarker = JSON.stringify({
      version: 1,
      purpose: 'user',
      token: 'e'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2,
      trustedDeviceId: 'device-user-failure'
    });
    resumes.setItem('monthly_v7_user_resume_marker', rawMarker);
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_exchange_user_resume: fixture.response
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: sessions, draftStorage: memoryStorage(), resumeStorage: resumes,
      idFactory: () => `tab-user-${fixture.label}`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    client.siteSession = {
      id: `site-${fixture.label}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      trustedDeviceId: 'device-user-failure'
    };
    client.siteSessionPendingValidation = false;

    await assert.rejects(client.restoreUserFromMarker(), new RegExp(fixture.label === 'timeout' ? 'RPC_TIMEOUT' : 'USER_RESUME_INVALID'));

    assert.equal(client.currentUser(), null, fixture.label);
    assert.equal(sessions.getItem('monthly_v7_user_session'), null, fixture.label);
    assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), fixture.keep ? rawMarker : null, fixture.label);
    assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_get_snapshot').length, 0, fixture.label);
  }
});

test('user resume 交換成功但 snapshot 失敗時不投影身份；user/site session invalid 保留原始語義', async () => {
  for (const fixture of [
    {
      label: 'snapshot-timeout',
      snapshot: () => { throw Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' }); },
      expectedCode: 'RPC_TIMEOUT',
      keepMarker: true
    },
    {
      label: 'snapshot-user-invalid',
      snapshot: { ok: false, error: 'USER_SESSION_INVALID' },
      expectedCode: 'USER_SESSION_INVALID',
      keepMarker: false
    },
    {
      label: 'snapshot-site-invalid',
      snapshot: { ok: false, error: 'SITE_SESSION_INVALID' },
      expectedCode: 'SITE_SESSION_INVALID',
      keepMarker: true
    }
  ]) {
    const sessions = memoryStorage();
    const resumes = memoryStorage();
    resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
      version: 1,
      purpose: 'user',
      token: '2'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2,
      trustedDeviceId: 'device-snapshot-failure'
    }));
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_exchange_user_resume: {
        ok: true,
        user_session_id: `user-${fixture.label}`,
        trusted_device_id: 'device-snapshot-failure',
        resume_token: '3'.repeat(64),
        expires_at: '2099-01-01T00:00:00.000Z',
        user: { id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }
      },
      monthly_v7_get_snapshot: fixture.snapshot
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: sessions, draftStorage: memoryStorage(), resumeStorage: resumes,
      idFactory: () => `tab-${fixture.label}`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    client.siteSession = {
      id: `site-${fixture.label}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      trustedDeviceId: 'device-snapshot-failure'
    };
    client.siteSessionPendingValidation = false;

    await assert.rejects(client.restoreUserFromMarker(), (error) => {
      assert.equal(error.code || error.message, fixture.expectedCode, fixture.label);
      return true;
    });

    assert.equal(client.currentUser(), null, fixture.label);
    assert.equal(client.userSession, null, fixture.label);
    assert.equal(sessions.getItem('monthly_v7_user_session'), null, fixture.label);
    assert.equal(sessions.getItem('monthly_v7_user_projection'), null, fixture.label);
    const marker = resumes.getItem('monthly_v7_user_resume_marker');
    if (fixture.keepMarker) assert.equal(JSON.parse(marker).token, '3'.repeat(64), fixture.label);
    else assert.equal(marker, null, fixture.label);
    assert.equal(client.hasSiteSession(), fixture.label !== 'snapshot-site-invalid', fixture.label);
  }
});

test('Browser adapter 手動登入預設清舊 user marker 且零發行，只有明確 opt-in 才建立新 marker', async () => {
  for (const rememberUser of [false, true]) {
    const sessions = memoryStorage();
    const resumes = memoryStorage();
    resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
      version: 1,
      purpose: 'user',
      token: 'f'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2,
      trustedDeviceId: 'device-old-user'
    }));
    const transport = fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_open_site: { ok: true, site_session_id: `site-opt-${rememberUser}` },
      monthly_v7_login_user: {
        ok: true,
        user_session_id: `user-opt-${rememberUser}`,
        user: { id: 'u1', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 }
      },
      monthly_v7_get_snapshot: {
        ok: true, watermark: 1, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: []
      },
      monthly_v7_issue_user_resume: {
        ok: true,
        trusted_device_id: 'device-current-user',
        resume_token: '1'.repeat(64),
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    });
    const client = new MonthlyV7Client({
      transport, sessionStorage: sessions, draftStorage: memoryStorage(), resumeStorage: resumes,
      idFactory: () => `tab-opt-${rememberUser}`
    });
    await client.initialize({ workspaceKey: 'workspace-test' });
    await client.openSite('gate');
    client.siteSession.trustedDeviceId = 'device-current-user';
    const app = new MonthlyV7BrowserApp({ transport });
    app.client = client;
    app.status = client.status;
    app.initialized = true;

    try {
      const user = await app.login('owner', 'pass', { rememberUser });

      assert.equal(user.username, 'owner', String(rememberUser));
      assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_issue_user_resume').length, rememberUser ? 1 : 0);
      const marker = resumes.getItem('monthly_v7_user_resume_marker');
      if (rememberUser) {
        assert.equal(JSON.parse(marker).token, '1'.repeat(64));
        assert.equal(app.userResumeStatus.remembered, true);
      } else {
        assert.equal(marker, null);
        assert.equal(app.userResumeStatus.requested, false);
      }
    } finally {
      client.stopHeartbeat();
      client.stopRealtime();
    }
  }
});

test('logoutUser 保留 trusted site marker，full site logout 清 marker 且保留草稿', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: []
    },
    monthly_v7_logout_user: { ok: true, revoked: true },
    monthly_v7_logout: { ok: true, revoked: true, trustedDeviceRevoked: true }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  const userMarker = JSON.stringify({
    version: 1,
    purpose: 'user',
    token: 'b'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2,
    trustedDeviceId: 'device-logout'
  });
  resumes.setItem('monthly_v7_user_resume_marker', userMarker);
  client.saveDraft('module', 'm1', { title: '登出仍保留' }, 1);

  await client.logoutUser();
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), marker);
  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null);
  assert.equal(client.isSiteUnlocked(), true);

  resumes.setItem('monthly_v7_user_resume_marker', userMarker);
  await client.logout();
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.readDraft('module', 'm1').payload.title, '登出仍保留');
});

test('本機 site cleanup 不呼叫 logout RPC、不清 trusted marker，且保留草稿 pending', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'b'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  drafts.setItem('monthly_v7_pending:save_module:m1', '{pending-evidence');
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  client.saveDraft('module', 'm1', { title: '本機清理仍保留' }, 1);
  transport.calls.length = 0;

  client.clearLocalSiteSession('startup-snapshot-unavailable');

  assert.deepEqual(transport.calls, []);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), marker);
  assert.equal(client.readDraft('module', 'm1').payload.title, '本機清理仍保留');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), '{pending-evidence');
});

test('logoutUser server 回 ok false 時上拋未確認狀態，但仍清本頁 user 且保留 site/草稿', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authorityState: 'NORMALIZED_ACTIVE', authorityEpoch: 2, minimumClientVersion: 7 },
    monthly_v7_open_site: { ok: true, siteSessionId: 'site-1', expiresAt: '2099-01-01' },
    monthly_v7_login_user: { ok: true, userSessionId: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' }, expiresAt: '2099-01-01' },
    monthly_v7_get_snapshot: { ok: true, watermark: 1, report: { id: 'r1' }, modules: [], records: [], users: [] },
    monthly_v7_logout_user: { ok: false, error: 'LOGOUT_NOT_CONFIRMED' }
  });
  const client = new MonthlyV7Client({ transport, sessionStorage: sessions, draftStorage: drafts });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('site-pass');
  await client.login('owner', 'owner-pass');
  client.saveDraft('module', 'm1', { title: '未確認登出時仍保留' }, 1);

  await assert.rejects(client.logoutUser(), /LOGOUT_NOT_CONFIRMED/);

  assert.equal(client.currentUser(), null);
  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.readDraft('module', 'm1').payload.title, '未確認登出時仍保留');
  assert.ok(sessions.getItem('monthly_v7_site_session'));
  assert.equal(sessions.getItem('monthly_v7_user_session'), null);
});

test('openSite 建立新 site session 前清除舊 user session 與身份投影', async () => {
  const sessions = memoryStorage();
  sessions.setItem('monthly_v7_site_session', JSON.stringify({ id: 'site-old', expiresAt: '' }));
  sessions.setItem('monthly_v7_user_session', JSON.stringify({ id: 'user-old', expiresAt: '' }));
  sessions.setItem('monthly_v7_user_projection', JSON.stringify({ id: 'u1', username: 'owner', role: 'owner' }));
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-new' }
  });
  const client = new MonthlyV7Client({ transport, sessionStorage: sessions, draftStorage: memoryStorage() });
  await client.initialize({ workspaceKey: 'workspace-test' });
  assert.equal(client.currentUser(), null);
  assert.equal(client.isWriteReady(), false);

  await client.openSite('new-gate-password');

  assert.equal(client.siteSession.id, 'site-new');
  assert.equal(client.currentUser(), null);
  assert.equal(client.userSession, null);
  assert.equal(sessions.getItem('monthly_v7_user_session'), null);
  assert.equal(sessions.getItem('monthly_v7_user_projection'), null);
});

test('currentUser 不接受缺少 user session 的孤立身份投影', async () => {
  const sessions = memoryStorage();
  sessions.setItem('monthly_v7_site_session', JSON.stringify({ id: 'site-1', expiresAt: '' }));
  sessions.setItem('monthly_v7_user_projection', JSON.stringify({ id: 'u1', username: 'owner', role: 'owner' }));
  const client = new MonthlyV7Client({
    transport: fakeTransport({ monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 } }),
    sessionStorage: sessions,
    draftStorage: memoryStorage()
  });

  await client.initialize({ workspaceKey: 'workspace-test' });

  assert.equal(client.currentUser(), null);
});

test('READ_SESSION_INVALID 集中清除 user session，保留 site session、草稿並通知 UI', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const sessionEvents = [];
  let snapshotRead = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true,
      user_session_id: 'user-1',
      user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: () => {
      snapshotRead += 1;
      if (snapshotRead > 1) return { ok: false, error: 'READ_SESSION_INVALID' };
      return {
        ok: true,
        watermark: 1,
        report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
        modules: [{ id: 'm1', revision: 1, payload: { title: '雲端' } }],
        records: [], users: []
      };
    }
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: sessions,
    draftStorage: drafts,
    host: { onSessionStateChanged: (event) => sessionEvents.push(event) }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  client.saveDraft('module', 'm1', { title: '未提交草稿' }, 1);

  await assert.rejects(() => client.loadSnapshot(), /READ_SESSION_INVALID/);

  assert.equal(client.currentUser(), null);
  assert.equal(client.userSession, null);
  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.siteSession.id, 'site-1');
  assert.equal(client.readDraft('module', 'm1').payload.title, '未提交草稿');
  assert.equal(sessionEvents.at(-1).reason, 'server-user-session-invalid');
  assert.equal(sessionEvents.at(-1).code, 'READ_SESSION_INVALID');
});

test('PostgREST SQLSTATE 28000 的 session invalid 不重試業務 RPC 且保留 pending 證據', async () => {
  const drafts = memoryStorage();
  let saveCalls = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true,
      user_session_id: 'user-1',
      user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true,
      watermark: 1,
      report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_save_module: () => {
      saveCalls += 1;
      const error = new Error('READ_SESSION_INVALID');
      error.code = '28000';
      error.details = '';
      throw error;
    }
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    operationIdFactory: () => 'op-1'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'test-session-invalid';

  await assert.rejects(
    () => client.executeOperation('monthly_v7_save_module', { p_user_session_id: 'user-1' }, pendingKey),
    /READ_SESSION_INVALID/
  );

  assert.equal(saveCalls, 1);
  assert.equal(JSON.parse(drafts.getItem(`monthly_v7_pending:${pendingKey}`)).operationId, 'op-1');
  assert.equal(client.currentUser(), null);
});

test('舊 session 世代晚到的 invalid 回應不得清除重新登入的新 session', async () => {
  let loginCount = 0;
  let resolveStaleRead;
  const sessionEvents = [];
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: () => {
      loginCount += 1;
      return {
        ok: true,
        user_session_id: `user-${loginCount}`,
        user: { id: `u${loginCount}`, username: 'owner', role: 'owner' }
      };
    },
    monthly_v7_get_snapshot: {
      ok: true,
      watermark: 1,
      report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_get_changes_since: () => new Promise((resolve) => { resolveStaleRead = resolve; }),
    monthly_v7_logout_user: { ok: true, revoked: true }
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: memoryStorage(),
    host: { onSessionStateChanged: (event) => sessionEvents.push(event) }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const staleRead = client.catchUp();
  await new Promise((resolve) => setImmediate(resolve));

  await client.logoutUser();
  await client.login('owner', 'pass');
  assert.equal(client.currentUser().id, 'u2');
  resolveStaleRead({ ok: false, error: 'READ_SESSION_INVALID' });
  await assert.rejects(staleRead, /READ_SESSION_INVALID/);

  assert.equal(client.userSession.id, 'user-2');
  assert.equal(client.currentUser().id, 'u2');
  assert.equal(sessionEvents.filter((event) => event.code === 'READ_SESSION_INVALID').length, 0);
});

test('舊 actor 的晚到保存成功不得清除新 actor 草稿、revision 或 lease', async () => {
  let resolveSave;
  let saveCalls = 0;
  const transport = {
    rpc(name) {
      if (name !== 'monthly_v7_save_module') throw new Error(`unexpected ${name}`);
      saveCalls += 1;
      return new Promise((resolve) => { resolveSave = resolve; });
    }
  };
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({ transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab' });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'user-session-u1' };
  client.user = { id: 'u1', username: 'u1' };
  client.snapshot = { report: { id: 'r1' }, modules: [{ id: 'm1', revision: 1, payload: { title: 'A' } }], records: [] };
  const item = { _v7Id: 'm1', _v7Revision: 1, title: 'U1 draft' };
  client.leases.set(client.leaseKey('module', 'm1'), {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-u1', fencingToken: 1,
    holderUserId: 'u1', clientSessionId: 'tab'
  });

  const saving = client.saveModule(item);
  await new Promise((resolve) => setImmediate(resolve));
  client.clearUserSession('actor-switch');
  client.userSession = { id: 'user-session-u2' };
  client.user = { id: 'u2', username: 'u2' };
  client.sessionGeneration += 1;
  client.saveDraft('module', 'm1', { title: 'U2 draft' }, 1);
  const leaseU2 = {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-u2', fencingToken: 2,
    holderUserId: 'u2', clientSessionId: 'tab'
  };
  client.leases.set(client.leaseKey('module', 'm1'), leaseU2);
  resolveSave({ ok: true, entityId: 'm1', revision: 2, watermark: 9 });

  await assert.rejects(saving, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.equal(saveCalls, 1);
  assert.equal(item._v7Revision, 1);
  assert.equal(client.readDraft('module', 'm1').payload.title, 'U2 draft');
  assert.equal(client.getLease('module', 'm1'), leaseU2);
});

test('舊 actor 的晚到 release 回應不得刪除新 actor 同項 lease', async () => {
  let resolveRelease;
  const transport = {
    rpc(name) {
      if (name !== 'monthly_v7_release_lease') throw new Error(`unexpected ${name}`);
      return new Promise((resolve) => { resolveRelease = resolve; });
    }
  };
  const client = new MonthlyV7Client({ transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab' });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'user-session-u1' };
  client.user = { id: 'u1', username: 'u1' };
  const leaseU1 = {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-u1', fencingToken: 1,
    holderUserId: 'u1', clientSessionId: 'tab'
  };
  client.leases.set(client.leaseKey('module', 'm1'), leaseU1);

  const releasing = client.releaseLease('module', 'm1');
  await new Promise((resolve) => setImmediate(resolve));
  client.clearUserSession('actor-switch');
  client.userSession = { id: 'user-session-u2' };
  client.user = { id: 'u2', username: 'u2' };
  client.sessionGeneration += 1;
  const leaseU2 = {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-u2', fencingToken: 2,
    holderUserId: 'u2', clientSessionId: 'tab'
  };
  client.leases.set(client.leaseKey('module', 'm1'), leaseU2);
  resolveRelease({ ok: true });

  await assert.rejects(releasing, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.equal(client.getLease('module', 'm1'), leaseU2);
});

test('舊 actor 的晚到 batch 失敗不得釋放新 actor 的 successor lease', async () => {
  let rejectBatch;
  let signalBatchStarted;
  const batchStarted = new Promise((resolve) => { signalBatchStarted = resolve; });
  const releaseCalls = [];
  const client = new MonthlyV7Client({
    transport: {
      async rpc(name, params) {
        if (name === 'monthly_v7_save_module_batch') {
          signalBatchStarted();
          return new Promise((_resolve, reject) => { rejectBatch = reject; });
        }
        if (name === 'monthly_v7_release_lease') {
          releaseCalls.push(params);
          return { ok: true };
        }
        throw new Error(`unexpected ${name}`);
      }
    },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'session-u1' };
  client.user = { id: 'u1' };
  client.snapshot = {
    report: { id: 'r1', revision: 1 },
    modules: [{ id: 'm1', revision: 1, payload: { title: '原始' } }], records: []
  };
  const leaseU1 = {
    entityType: 'kpi_batch', entityId: 'r1', leaseId: 'batch-u1', fencingToken: 1,
    holderUserId: 'u1', clientSessionId: 'tab'
  };
  client.leases.set(client.leaseKey('kpi_batch', 'r1'), leaseU1);
  const item = { _v7Id: 'm1', _v7Revision: 1, title: 'U1內容' };

  const saving = client.saveModuleBatch([item]);
  await batchStarted;
  client.clearUserSession('actor-switch');
  client.userSession = { id: 'session-u2' };
  client.user = { id: 'u2' };
  client.sessionGeneration += 1;
  const leaseU2 = {
    entityType: 'kpi_batch', entityId: 'r1', leaseId: 'batch-u2', fencingToken: 2,
    holderUserId: 'u2', clientSessionId: 'tab'
  };
  client.leases.set(client.leaseKey('kpi_batch', 'r1'), leaseU2);
  const stale = new Error('STALE_SESSION_RESPONSE');
  stale.code = 'STALE_SESSION_RESPONSE';
  rejectBatch(stale);

  await assert.rejects(saving, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.deepEqual(releaseCalls, []);
  assert.equal(client.getLease('kpi_batch', 'r1'), leaseU2);
});

test('舊 actor 的晚到 logout finally 不得清除新 actor session', async () => {
  let resolveLogout;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const resumes = memoryStorage();
  const client = new MonthlyV7Client({
    transport: {
      rpc(name) {
        assert.equal(name, 'monthly_v7_logout_user');
        signalStarted();
        return new Promise((resolve) => { resolveLogout = resolve; });
      }
    },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(), resumeStorage: resumes, idFactory: () => 'tab'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'session-u1' };
  client.user = { id: 'u1' };
  resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
    version: 1, purpose: 'user', token: '1'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-u1'
  }));

  const loggingOut = client.logoutUser();
  await started;
  client.clearUserSession('actor-switch');
  client.userSession = { id: 'session-u2' };
  client.user = { id: 'u2' };
  client.sessionGeneration += 1;
  const successorMarker = JSON.stringify({
    version: 1, purpose: 'user', token: '2'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-u2'
  });
  resumes.setItem('monthly_v7_user_resume_marker', successorMarker);
  resolveLogout({ ok: true, revoked: true });

  await assert.rejects(loggingOut, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.equal(client.currentUser().id, 'u2');
  assert.equal(client.userSession.id, 'session-u2');
  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), successorMarker);
});

for (const method of ['logoutUser', 'logout', 'forgetTrustedDevice']) {
  test(`adapter ${method} 等待釋放舊 lease 時不得改用新 session 登出或刪 successor`, async () => {
    const app = new MonthlyV7BrowserApp({ transport: {} });
    let generation = 1;
    let actorUserId = 'u1';
    let userSessionId = 'session-u1';
    let siteSessionId = 'site-u1';
    let releaseGate;
    let signalReleaseStarted;
    const releaseStarted = new Promise((resolve) => { signalReleaseStarted = resolve; });
    const leaseU1 = {
      entityType: 'module', entityId: 'm1', leaseId: 'lease-u1', fencingToken: 1,
      holderUserId: 'u1', clientSessionId: 'tab'
    };
    const leaseU2 = {
      entityType: 'module', entityId: 'm1', leaseId: 'lease-u2', fencingToken: 2,
      holderUserId: 'u2', clientSessionId: 'tab'
    };
    const leases = new Map([['module:m1', leaseU1]]);
    const logoutCalls = [];
    const currentContext = () => Object.freeze({
      generation, actorUserId, userSessionId, siteSessionId, clientSessionId: 'tab'
    });
    const isCurrent = (context) => context.generation === generation
      && context.actorUserId === actorUserId
      && context.userSessionId === userSessionId
      && context.siteSessionId === siteSessionId;
    app.client = {
      leases,
      captureSessionContext: currentContext,
      isSessionContextCurrent: isCurrent,
      assertSessionContext(context) {
        if (!isCurrent(context)) {
          const error = new Error('STALE_SESSION_RESPONSE');
          error.code = 'STALE_SESSION_RESPONSE';
          error.silent = true;
          throw error;
        }
      },
      async releaseCapturedLease(lease, context) {
        assert.equal(lease, leaseU1);
        assert.equal(context.actorUserId, 'u1');
        signalReleaseStarted();
        await new Promise((resolve) => { releaseGate = resolve; });
        if (isCurrent(context) && leases.get('module:m1') === lease) leases.delete('module:m1');
        return isCurrent(context);
      },
      async releaseLease(entityType, entityId) {
        assert.equal(entityType, 'module');
        assert.equal(entityId, 'm1');
        signalReleaseStarted();
        await new Promise((resolve) => { releaseGate = resolve; });
        return true;
      },
      async logoutUser() { logoutCalls.push({ method: 'logoutUser', context: currentContext() }); },
      async logout() { logoutCalls.push({ method: 'logout', context: currentContext() }); },
      async forgetTrustedDevice() { logoutCalls.push({ method: 'forgetTrustedDevice', context: currentContext() }); }
    };
    app.decorateEditorRows = () => {};

    const loggingOut = app[method]();
    await releaseStarted;
    generation = 2;
    actorUserId = 'u2';
    userSessionId = 'session-u2';
    siteSessionId = 'site-u2';
    leases.set('module:m1', leaseU2);
    releaseGate();

    await assert.rejects(loggingOut, (error) => error.code === 'STALE_SESSION_RESPONSE');
    assert.deepEqual(logoutCalls, []);
    assert.equal(leases.get('module:m1'), leaseU2);
  });
}

for (const method of ['logout', 'forgetTrustedDevice']) {
  test(`adapter ${method} 釋放 lease 時 user session 失效仍以同一 site session 執行撤銷`, async () => {
    const app = new MonthlyV7BrowserApp({ transport: {} });
    let generation = 1;
    let actorUserId = 'u1';
    let userSessionId = 'user-u1';
    let siteSessionId = 'site-u1';
    const lease = {
      entityType: 'module', entityId: 'm1', leaseId: 'lease-u1', fencingToken: 1,
      holderUserId: 'u1', clientSessionId: 'tab'
    };
    const revocations = [];
    const currentContext = () => Object.freeze({
      generation, actorUserId, userSessionId, siteSessionId, clientSessionId: 'tab'
    });
    const isCurrent = (context) => context.generation === generation
      && context.actorUserId === actorUserId
      && context.userSessionId === userSessionId
      && context.siteSessionId === siteSessionId;
    app.client = {
      leases: new Map([['module:m1', lease]]),
      captureSessionContext: currentContext,
      isSessionContextCurrent: isCurrent,
      assertSessionContext(context) {
        if (!isCurrent(context)) {
          const error = new Error('STALE_SESSION_RESPONSE');
          error.code = 'STALE_SESSION_RESPONSE';
          throw error;
        }
      },
      async releaseCapturedLease() {
        generation += 1;
        actorUserId = '';
        userSessionId = '';
        const error = new Error('USER_SESSION_INVALID');
        error.code = 'USER_SESSION_INVALID';
        throw error;
      },
      async logout() {
        revocations.push({ method: 'logout', context: currentContext() });
        siteSessionId = '';
      },
      async forgetTrustedDevice() {
        revocations.push({ method: 'forgetTrustedDevice', context: currentContext() });
        siteSessionId = '';
        return { ok: true, forgotten: true };
      },
      isSiteUnlocked: () => Boolean(siteSessionId)
    };
    app.decorateEditorRows = () => {};

    await app[method]();

    assert.equal(revocations.length, 1);
    assert.equal(revocations[0].method, method);
    assert.equal(revocations[0].context.siteSessionId, 'site-u1');
    assert.equal(revocations[0].context.userSessionId, '');
  });

  test(`adapter ${method} 釋放 lease 時 site session 失效會清 marker 且不碰 server successor`, async () => {
    const app = new MonthlyV7BrowserApp({ transport: {} });
    let generation = 1;
    let siteSessionId = 'site-u1';
    let markerPresent = true;
    let revocationCalls = 0;
    const currentContext = () => Object.freeze({
      generation, actorUserId: 'u1', userSessionId: 'user-u1', siteSessionId, clientSessionId: 'tab'
    });
    app.client = {
      leases: new Map([['module:m1', { entityType: 'module', entityId: 'm1' }]]),
      captureSessionContext: currentContext,
      isSessionContextCurrent: (context) => context.generation === generation && context.siteSessionId === siteSessionId,
      assertSessionContext() {
        const error = new Error('STALE_SESSION_RESPONSE');
        error.code = 'STALE_SESSION_RESPONSE';
        throw error;
      },
      async releaseCapturedLease() {
        generation += 1;
        siteSessionId = '';
        const error = new Error('SITE_SESSION_INVALID');
        error.code = 'SITE_SESSION_INVALID';
        throw error;
      },
      clearSiteResumeMarker() { markerPresent = false; },
      clearLocalSiteSession() { siteSessionId = ''; return true; },
      async logout() { revocationCalls += 1; },
      async forgetTrustedDevice() { revocationCalls += 1; },
      isSiteUnlocked: () => Boolean(siteSessionId)
    };
    app.decorateEditorRows = () => {};

    await assert.rejects(app[method](), (error) => error?.code === 'SITE_SESSION_INVALID');

    assert.equal(markerPresent, false);
    assert.equal(siteSessionId, '');
    assert.equal(revocationCalls, 0);
  });
}

test('舊 actor 排定的 clean release timer 不得釋放新 actor successor lease', async () => {
  const previousDocument = globalThis.document;
  const app = new MonthlyV7BrowserApp({ transport: {} });
  let generation = 1;
  let actorUserId = 'u1';
  const leaseU1 = { entityType: 'module', entityId: 'm1', leaseId: 'lease-u1', fencingToken: 1 };
  const leaseU2 = { entityType: 'module', entityId: 'm1', leaseId: 'lease-u2', fencingToken: 2 };
  let currentLease = leaseU1;
  const releases = [];
  const row = {
    dataset: { v7EntityId: 'm1' },
    contains: () => false
  };
  globalThis.document = {
    activeElement: null,
    querySelectorAll: () => [row]
  };
  app.client = {
    snapshot: { modules: [{ id: 'm1', revision: 1, payload: { title: 'same' } }] },
    getLease: () => currentLease,
    captureSessionContext: () => Object.freeze({ generation, actorUserId, userSessionId: `s-${actorUserId}`, siteSessionId: 'site', clientSessionId: 'tab' }),
    isSessionContextCurrent: (context) => context.generation === generation && context.actorUserId === actorUserId,
    modulePayload: (local) => ({ title: local.title }),
    async releaseLease() { releases.push(currentLease); return true; },
    async releaseCapturedLease(lease) { releases.push(lease); return true; }
  };
  app.host = { async getLocalEntity() { return { _v7Id: 'm1', title: 'same' }; } };
  app.decorateEditorRows = () => {};
  app.reportError = () => {};
  try {
    app.scheduleUnchangedModuleRelease(row, 0);
    actorUserId = 'u2';
    generation = 2;
    currentLease = leaseU2;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(releases, []);
  } finally {
    for (const timer of app.moduleReleaseTimers.values()) clearTimeout(timer);
    app.moduleReleaseTimers.clear();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('單項 module 舊保存失鎖不得刪除同 session 後繼 lease', async () => {
  let resolveSave;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const client = new MonthlyV7Client({
    transport: {
      rpc(name) {
        assert.equal(name, 'monthly_v7_save_module');
        signalStarted();
        return new Promise((resolve) => { resolveSave = resolve; });
      }
    },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab', operationIdFactory: () => '00000000-0000-4000-8000-000000000901'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'session-u1' };
  client.user = { id: 'u1' };
  const lease1 = { entityType: 'module', entityId: 'm1', leaseId: 'lease-1', fencingToken: 1, holderUserId: 'u1', clientSessionId: 'tab' };
  const lease2 = { entityType: 'module', entityId: 'm1', leaseId: 'lease-2', fencingToken: 2, holderUserId: 'u1', clientSessionId: 'tab' };
  client.leases.set(client.leaseKey('module', 'm1'), lease1);
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '內容' };

  const saving = client.saveModule(item);
  await started;
  client.leases.set(client.leaseKey('module', 'm1'), lease2);
  resolveSave({ ok: false, error: 'LEASE_LOST' });

  await assert.rejects(saving, (error) => error.code === 'LEASE_LOST');
  assert.equal(client.getLease('module', 'm1'), lease2);
});

test('metadata 舊保存成功不得刪除同 session 後繼 lease', async () => {
  let resolveSave;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const client = new MonthlyV7Client({
    transport: {
      rpc(name) {
        assert.equal(name, 'monthly_v7_save_report_meta');
        signalStarted();
        return new Promise((resolve) => { resolveSave = resolve; });
      }
    },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab', operationIdFactory: () => '00000000-0000-4000-8000-000000000902'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'session-u1' };
  client.user = { id: 'u1' };
  client.snapshot = { report: { id: 'r1', revision: 1, title: '舊', period: {}, settings: {} }, modules: [], records: [] };
  const lease1 = { entityType: 'report_meta', entityId: 'r1', leaseId: 'lease-1', fencingToken: 1, holderUserId: 'u1', clientSessionId: 'tab' };
  const lease2 = { entityType: 'report_meta', entityId: 'r1', leaseId: 'lease-2', fencingToken: 2, holderUserId: 'u1', clientSessionId: 'tab' };
  client.leases.set(client.leaseKey('report_meta', 'r1'), lease1);

  const saving = client.saveReportMeta({ title: '新', period: {}, settings: {} });
  await started;
  client.leases.set(client.leaseKey('report_meta', 'r1'), lease2);
  resolveSave({ ok: true, revision: 2, watermark: 2 });

  await saving;
  assert.equal(client.getLease('report_meta', 'r1'), lease2);
});

test('report metadata 對 revision、lease 與 authority failure 發出對應保存阻斷 callback', async () => {
  for (const code of ['REVISION_CONFLICT', 'LEASE_LOST', 'AUTHORITY_CHANGED', 'AUTHORITY_NOT_ACTIVE']) {
    const conflicts = [];
    const drafts = memoryStorage();
    const client = new MonthlyV7Client({
      transport: {
        async rpc(name) {
          assert.equal(name, 'monthly_v7_save_report_meta');
          return { ok: false, error: code, currentRevision: 2 };
        }
      },
      sessionStorage: memoryStorage(), draftStorage: drafts,
      idFactory: () => 'tab',
      operationIdFactory: () => '00000000-0000-4000-8000-000000000904',
      host: { onConflict(info) { conflicts.push(info); } }
    });
    client.status = { mode: 'v7' };
    client.config = { workspaceKey: 'workspace-test' };
    client.siteSession = { id: 'site-1' };
    client.userSession = { id: 'session-u1' };
    client.user = { id: 'u1' };
    client.snapshot = {
      report: { id: 'r1', revision: 1, title: '舊', date: '', period: {}, settings: {} },
      modules: [], records: []
    };
    client.leases.set(client.leaseKey('report_meta', 'r1'), {
      entityType: 'report_meta', entityId: 'r1', leaseId: 'lease-1',
      fencingToken: 1, holderUserId: 'u1', clientSessionId: 'tab'
    });

    await assert.rejects(
      () => client.saveReportMeta({ title: '本機新標題', date: '', period: {}, settings: {} }),
      (error) => error.code === code
    );
    assert.equal(conflicts.length, 1, code);
    assert.equal(conflicts[0].entityType, 'report_meta');
    assert.equal(conflicts[0].entityId, 'r1');
    assert.equal(conflicts[0].baseRevision, 1);
    assert.equal(conflicts[0].result.error, code);
    if (code === 'REVISION_CONFLICT') {
      assert.equal(conflicts[0].result.currentRevision, 2);
    }
    assert.equal(client.readDraft('report_meta', 'r1').payload.title, '本機新標題');
  }
});

test('既有 revision blocker 不得覆蓋後續非 revision conflict 的狀態', () => {
  const published = [];
  const app = new MonthlyV7BrowserApp({
    transport: fakeTransport({}),
    host: {
      onConflict(info) { published.push(`host:${info.result.error}`); },
      setStatus(text) { published.push(`status:${text}`); }
    }
  });
  app.client = { readDraft: () => null };
  app.decorateEditorRows = () => {};
  app.revisionConflictBlocks.set('module:m1', {
    state: 'REVISION_CONFLICT_BLOCKED', entityType: 'module', entityId: 'm1'
  });

  app.clientHost().onConflict({
    entityType: 'module', entityId: 'm2', result: { ok: false, error: 'LEASE_LOST' }
  });

  assert.deepEqual(published, ['host:LEASE_LOST']);
  assert.equal(app.isRevisionConflictBlocked('module', 'm1'), true);
});

test('record 舊保存衝突不得刪除同 session 後繼 lease', async () => {
  let resolveSave;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const client = new MonthlyV7Client({
    transport: {
      rpc(name) {
        assert.equal(name, 'monthly_v7_save_record');
        signalStarted();
        return new Promise((resolve) => { resolveSave = resolve; });
      }
    },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab', operationIdFactory: () => '00000000-0000-4000-8000-000000000903'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-1' };
  client.userSession = { id: 'session-u1' };
  client.user = { id: 'u1' };
  const type = 'record:inspections';
  const lease1 = { entityType: type, entityId: 'rec-1', leaseId: 'lease-1', fencingToken: 1, holderUserId: 'u1', clientSessionId: 'tab' };
  const lease2 = { entityType: type, entityId: 'rec-1', leaseId: 'lease-2', fencingToken: 2, holderUserId: 'u1', clientSessionId: 'tab' };
  client.leases.set(client.leaseKey(type, 'rec-1'), lease1);
  const record = { _v7Id: 'rec-1', _v7Revision: 1, port: 'KHH' };

  const saving = client.saveRecord('inspections', record);
  await started;
  client.leases.set(client.leaseKey(type, 'rec-1'), lease2);
  resolveSave({ ok: false, error: 'REVISION_CONFLICT' });

  await assert.rejects(saving, (error) => error.code === 'REVISION_CONFLICT');
  assert.equal(client.getLease(type, 'rec-1'), lease2);
});

test('首次 snapshot 載入也會恢復既有 module 草稿與舊 base revision', async () => {
  const drafts = memoryStorage();
  drafts.setItem('monthly_v7_draft:module:m1', JSON.stringify({
    entityType: 'module', entityId: 'm1', baseRevision: 3,
    payload: { title: '本機待救回', columns: ['本機內容'] }, savedAt: '2026-08-11T00:00:00Z'
  }));
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 9,
      report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 2 },
      modules: [{ id: 'm1', legacyItemId: '101', revision: 4, payload: { title: '雲端較新', columns: ['雲端內容'] } }],
      records: [], users: []
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab-1',
    host: {
      getLegacyLocalState: async () => ({
        fileId: 'legacy', timestamp: 1,
        modules: [{ id: 101, title: '較舊 IndexedDB 內容', columns: ['舊本機內容'] }]
      })
    }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  assert.equal(client.snapshot.modules[0].payload.title, '本機待救回');
  assert.deepEqual(client.snapshot.modules[0].payload.columns, ['本機內容']);
  assert.equal(client.snapshot.modules[0].revision, 3);
  assert.ok(client.readDraft('module', 'm1'));
});

test('protected snapshot merge 顯示本機 draft，但保留真正 server payload/revision 作比較基線', async () => {
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({
    transport: fakeTransport({}),
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    idFactory: () => 'tab'
  });
  client.snapshot = {
    report: { id: 'r1', revision: 1 },
    modules: [{ id: 'm1', revision: 2, payload: { title: '舊本機基線' } }],
    records: []
  };
  client.saveDraft('module', 'm1', { title: '衝突後保留的本機內容' }, 2);

  const merged = await client.mergeSnapshotWithProtectedLocal({
    report: { id: 'r1', revision: 1 },
    modules: [{ id: 'm1', revision: 5, payload: { title: '遠端較新內容' } }],
    records: []
  });
  const row = merged.modules[0];
  assert.deepEqual(row.payload, { title: '衝突後保留的本機內容' });
  assert.equal(row.revision, 2);
  assert.deepEqual(row._serverPayload, { title: '遠端較新內容' });
  assert.equal(row._serverRevision, 5);
  assert.equal('_serverPayload' in row.payload, false);
  assert.equal('_serverRevision' in row.payload, false);
});

test('protected report metadata merge 保留本機草稿與真正 server payload/revision', async () => {
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({
    transport: fakeTransport({}),
    sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab'
  });
  client.snapshot = {
    report: {
      id: 'r1', revision: 2, title: '舊本機基線', date: '2026-08-01',
      period: { startM: '8' }, settings: { font: 'A' }
    },
    modules: [], records: []
  };
  const local = {
    title: '衝突後保留的本機標題', date: '2026-08-02',
    period: { startM: '9' }, settings: { font: 'B' }
  };
  const remote = {
    title: '遠端較新標題', date: '2026-08-03',
    period: { startM: '10' }, settings: { font: 'C' }
  };
  client.saveDraft('report_meta', 'r1', local, 2);

  const merged = await client.mergeSnapshotWithProtectedLocal({
    report: { id: 'r1', revision: 5, ...remote }, modules: [], records: []
  });

  assert.equal(merged.report.title, local.title);
  assert.equal(merged.report.date, local.date);
  assert.deepEqual(merged.report.period, local.period);
  assert.deepEqual(merged.report.settings, local.settings);
  assert.equal(merged.report.revision, 2);
  assert.equal(merged.report._serverRevision, 5);
  assert.deepEqual(merged.report._serverPayload, remote);
});

test('saveModule 以 lease/fence/CAS 保存，失鎖保留草稿且成功後保留目前編輯 lease', async () => {
  const drafts = memoryStorage();
  let saveAttempt = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-1', fencing_token: 4,
      holder_user_id: 'u1', client_session_id: 'tab-1', expires_at: '2026-08-11T00:00:00Z'
    },
    monthly_v7_save_module: () => {
      saveAttempt += 1;
      return saveAttempt === 1 ? { ok: false, error: 'LEASE_LOST' } : { ok: true, entityId: 'm1', revision: 8, watermark: 12 };
    }
  });
  let op = 0;
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 7, title: '本機草稿', columns: ['內容'] };

  await assert.rejects(() => client.saveModule(item), (error) => error.code === 'LEASE_LOST');
  assert.ok(drafts.getItem('monthly_v7_draft:module:m1'));
  assert.equal(client.getLease('module', 'm1'), null);

  const result = await client.saveModule(item);
  assert.equal(result.revision, 8);
  assert.equal(item._v7Revision, 8);
  assert.equal(drafts.getItem('monthly_v7_draft:module:m1'), null);
  const saveCall = transport.calls.filter((call) => call.name === 'monthly_v7_save_module').at(-1);
  assert.equal(saveCall.params.p_expected_revision, 7);
  assert.equal(saveCall.params.p_fencing_token, 4);
  assert.equal(client.getLease('module', 'm1')?.leaseId, 'lease-1');
});

test('catchUp 逐項重讀變更，正在編輯或有草稿的 entity 不被遠端覆蓋', async () => {
  const drafts = memoryStorage();
  const applied = [];
  const deferred = [];
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 10, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 12, hasMore: false,
      events: [
        { sequence: 11, entityType: 'module', entityId: 'm1', revision: 2 },
        { sequence: 12, entityType: 'module', entityId: 'm2', revision: 3 }
      ]
    },
    monthly_v7_get_entity: (params) => ({
      ok: true, entityType: params.p_entity_type, entityId: params.p_entity_id,
      revision: params.p_entity_id === 'm1' ? 2 : 3,
      payload: { title: params.p_entity_id === 'm1' ? '遠端一' : '遠端二' }
    })
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1',
    host: {
      async applyEntity(entity) { applied.push(entity.entityId); },
      onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); }
    }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  drafts.setItem('monthly_v7_draft:module:m2', JSON.stringify({ payload: { title: '本機二' } }));

  const result = await client.catchUp();
  assert.deepEqual(applied, ['m1']);
  assert.deepEqual(deferred, ['m2']);
  assert.equal(result.watermark, 12);
  assert.equal(client.watermark, 12);
});

test('own-operation event 已被 catchUp 讀取但 ACK 先清 pending 時不誤報遠端版本', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  const operationId = '00000000-0000-4000-8000-000000000904';
  let resolveSaveAck;
  let signalSaveStarted;
  let resolveEntity;
  let signalEntityStarted;
  const saveStarted = new Promise((resolve) => { signalSaveStarted = resolve; });
  const entityStarted = new Promise((resolve) => { signalEntityStarted = resolve; });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '舊內容' } }], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-1', fencing_token: 4,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_module: () => {
      signalSaveStarted();
      return new Promise((resolve) => { resolveSaveAck = resolve; });
    },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 11, hasMore: false,
      events: [{ sequence: 11, entityType: 'module', entityId: 'm1', revision: 2 }]
    },
    monthly_v7_get_entity: () => {
      signalEntityStarted();
      return new Promise((resolve) => { resolveEntity = resolve; });
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => operationId,
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '本機新內容' };

  const saving = client.saveModule(item);
  await saveStarted;
  assert.ok(drafts.getItem('monthly_v7_pending:save_module:m1'));
  const catchingUp = client.catchUp();
  await entityStarted;

  resolveSaveAck({ ok: true, entityId: 'm1', revision: 2, watermark: 11 });
  await saving;
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), null);
  resolveEntity({ ok: true, entityType: 'module', entityId: 'm1', revision: 2, payload: { title: '本機新內容' } });
  await catchingUp;

  assert.deepEqual(deferred, []);
});

test('batch own-operation 的所有 production-shaped hints 在第一個 entity read 前固定保存意圖', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  const operationId = '00000000-0000-4000-8000-000000000905';
  const pendingKey = 'save_module_batch:r1';
  let entityReads = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: '舊一' } },
        { id: 'm2', revision: 1, payload: { title: '舊二' } }
      ], records: [], users: []
    },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 12, hasMore: false,
      events: [
        { sequence: 11, entityType: 'module', entityId: 'm1', revision: 2 },
        { sequence: 12, entityType: 'module', entityId: 'm2', revision: 2 }
      ]
    },
    monthly_v7_get_entity: (params) => {
      entityReads += 1;
      if (entityReads === 1) drafts.removeItem(`monthly_v7_pending:${pendingKey}`);
      return {
        ok: true, entityType: 'module', entityId: params.p_entity_id, revision: 2,
        payload: { title: params.p_entity_id === 'm1' ? '新一' : '新二' }
      };
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab-1',
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const signature = JSON.stringify({
    p_workspace_key: 'workspace-test',
    p_user_session_id: 'user-session-1',
    p_client_session_id: 'tab-1',
    p_report_id: 'r1',
    p_changes: [
      { moduleId: 'm1', expectedRevision: 1, payload: { title: '新一' } },
      { moduleId: 'm2', expectedRevision: 1, payload: { title: '新二' } }
    ],
    p_lease_id: 'batch-lease',
    p_fencing_token: 1
  });
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId, signature, createdAt: '2026-08-13T00:00:00.000Z', actorUserId: 'u1'
  }));
  client.saveDraft('module', 'm1', { title: '本機一' }, 1);
  client.saveDraft('module', 'm2', { title: '本機二' }, 1);

  await client.catchUp();

  assert.equal(entityReads, 2);
  assert.deepEqual(deferred, []);
});

test('get_changes_since 回覆晚於保存 ACK 時以 confirmed revision/payload 收斂 own hint', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  let resolveSaveAck;
  let signalSaveStarted;
  let resolveChanges;
  let signalChangesStarted;
  const saveStarted = new Promise((resolve) => { signalSaveStarted = resolve; });
  const changesStarted = new Promise((resolve) => { signalChangesStarted = resolve; });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '舊內容' } }], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-1', fencing_token: 4,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_module: () => {
      signalSaveStarted();
      return new Promise((resolve) => { resolveSaveAck = resolve; });
    },
    monthly_v7_get_changes_since: () => {
      signalChangesStarted();
      return new Promise((resolve) => { resolveChanges = resolve; });
    },
    monthly_v7_get_entity: {
      ok: true, entityType: 'module', entityId: 'm1', revision: 2, payload: { title: '本機新內容' }
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => '00000000-0000-4000-8000-000000000906',
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '本機新內容' };

  const saving = client.saveModule(item);
  await saveStarted;
  const catchingUp = client.catchUp();
  await changesStarted;
  resolveSaveAck({ ok: true, entityId: 'm1', revision: 2 });
  await saving;
  resolveChanges({
    ok: true, watermark: 11, hasMore: false,
    events: [{ sequence: 11, entityType: 'module', entityId: 'm1', revision: 2 }]
  });
  await catchingUp;

  assert.deepEqual(deferred, []);
  assert.equal(client.snapshot.modules[0].revision, 2);
  assert.deepEqual(client.snapshot.modules[0].payload, { title: '本機新內容' });
});

test('own ACK 後相同 entity 的較高遠端 revision/payload 仍保護草稿並警告', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '舊內容' } }], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-1', fencing_token: 4,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_module: { ok: true, entityId: 'm1', revision: 2 },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 12, hasMore: false,
      events: [{ sequence: 12, entityType: 'module', entityId: 'm1', revision: 3 }]
    },
    monthly_v7_get_entity: {
      ok: true, entityType: 'module', entityId: 'm1', revision: 3, payload: { title: '真正遠端內容' }
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => '00000000-0000-4000-8000-000000000907',
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '本機已確認內容' };

  await client.saveModule(item);
  await client.catchUp();

  assert.deepEqual(deferred, ['m1']);
  assert.equal(client.snapshot.modules[0].revision, 2);
  assert.deepEqual(client.snapshot.modules[0].payload, { title: '本機已確認內容' });
});

test('report_meta ACK 後的後繼草稿不把晚到 own hint 誤報為遠端版本', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  let resolveSaveAck;
  let signalSaveStarted;
  let resolveChanges;
  let signalChangesStarted;
  const saveStarted = new Promise((resolve) => { signalSaveStarted = resolve; });
  const changesStarted = new Promise((resolve) => { signalChangesStarted = resolve; });
  const confirmed = {
    title: '已確認標題 A', date: '2026-08-13', period: { startM: '8' }, settings: { font: 'A' }
  };
  const successor = { ...confirmed, title: '後繼草稿 B' };
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '舊標題', date: '2026-08-01', period: {}, settings: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_meta', entity_id: 'r1', lease_id: 'meta-lease', fencing_token: 1,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_report_meta: () => {
      signalSaveStarted();
      return new Promise((resolve) => { resolveSaveAck = resolve; });
    },
    monthly_v7_get_changes_since: () => {
      signalChangesStarted();
      return new Promise((resolve) => { resolveChanges = resolve; });
    },
    monthly_v7_get_entity: { ok: true, entityType: 'report_meta', entityId: 'r1', revision: 2, payload: confirmed }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => '00000000-0000-4000-8000-000000000908',
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  const saving = client.saveReportMeta(confirmed);
  await saveStarted;
  const catchingUp = client.catchUp();
  await changesStarted;
  resolveSaveAck({ ok: true, entityId: 'r1', revision: 2 });
  await saving;
  client.saveDraft('report_meta', 'r1', successor, 2);
  resolveChanges({
    ok: true, watermark: 11, hasMore: false,
    events: [{ sequence: 11, entityType: 'report_meta', entityId: 'r1', revision: 2 }]
  });
  await catchingUp;

  assert.deepEqual(deferred, []);
  assert.equal(client.currentReport().revision, 2);
  assert.equal(client.currentReport().title, confirmed.title);
  assert.equal(client.readDraft('report_meta', 'r1').payload.title, successor.title);
});

test('report_meta 較高遠端 revision/payload 仍保護後繼草稿並警告', async () => {
  const drafts = memoryStorage();
  const deferred = [];
  const confirmed = {
    title: '已確認標題 A', date: '2026-08-13', period: {}, settings: {}
  };
  const successor = { ...confirmed, title: '後繼草稿 B' };
  const remote = { ...confirmed, title: '真正遠端標題 C' };
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-session-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 10,
      report: { id: 'r1', legacyFileId: 'x', title: '舊標題', date: '2026-08-01', period: {}, settings: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_meta', entity_id: 'r1', lease_id: 'meta-lease', fencing_token: 1,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_report_meta: { ok: true, entityId: 'r1', revision: 2 },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 12, hasMore: false,
      events: [{ sequence: 12, entityType: 'report_meta', entityId: 'r1', revision: 3 }]
    },
    monthly_v7_get_entity: { ok: true, entityType: 'report_meta', entityId: 'r1', revision: 3, payload: remote }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => '00000000-0000-4000-8000-000000000909',
    host: { onRemoteChangeWhileEditing(entity) { deferred.push(entity.entityId); } }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  await client.saveReportMeta(confirmed);
  client.saveDraft('report_meta', 'r1', successor, 2);
  await client.catchUp();

  assert.deepEqual(deferred, ['r1']);
  assert.equal(client.currentReport().title, confirmed.title);
  assert.equal(client.readDraft('report_meta', 'r1').payload.title, successor.title);
});

test('saveModuleBatch 成功後保留原先持有的 module lease', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: 'A' } },
        { id: 'm2', revision: 1, payload: { title: 'B' } }
      ], records: [], users: []
    },
    monthly_v7_claim_lease: (params) => ({
      ok: true,
      entity_type: params.p_entity_type,
      entity_id: params.p_entity_id,
      lease_id: `lease-${params.p_entity_type}-${params.p_entity_id}`,
      fencing_token: 1,
      holder_user_id: 'u1',
      client_session_id: 'tab'
    }),
    monthly_v7_save_module_batch: {
      ok: true,
      updated: [{ entityId: 'm1', revision: 2 }, { entityId: 'm2', revision: 2 }],
      watermark: 2
    },
    monthly_v7_release_lease: { ok: true }
  });
  let op = 0;
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab',
    operationIdFactory: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  await client.claimLease('module', 'm1');
  await client.claimLease('module', 'm2');

  await client.saveModuleBatch([
    { _v7Id: 'm1', _v7Revision: 1, title: 'A2' },
    { _v7Id: 'm2', _v7Revision: 1, title: 'B2' }
  ]);

  const releases = transport.calls.filter((call) => call.name === 'monthly_v7_release_lease');
  assert.deepEqual(releases, []);
  assert.equal(client.getLease('kpi_batch', 'r1')?.leaseId, 'lease-kpi_batch-r1');
  assert.equal(client.getLease('module', 'm1')?.leaseId, 'lease-module-m1');
  assert.equal(client.getLease('module', 'm2')?.leaseId, 'lease-module-m2');
});

test('saveModuleBatch 有 pending 時先重播舊 operation，不先 claim 目前 batch lease', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: 'A' } },
        { id: 'm2', revision: 1, payload: { title: 'B' } }
      ], records: [], users: []
    },
    monthly_v7_claim_lease: { ok: false, error: 'LEASE_HELD' },
    monthly_v7_save_module_batch: {
      ok: true, updated: [{ entityId: 'm1', revision: 2 }, { entityId: 'm2', revision: 2 }], watermark: 2
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current',
    operationIdFactory: () => { throw new Error('COMMITTED replay must not create a new operation'); }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const currentBatchLease = client.normalizeLease({
    entity_type: 'kpi_batch', entity_id: 'r1', lease_id: 'batch-current', fencing_token: 9,
    holder_user_id: 'u1', client_session_id: 'tab-current'
  });
  client.leases.set(client.leaseKey('kpi_batch', 'r1'), currentBatchLease);
  const items = [
    { _v7Id: 'm1', _v7Revision: 1, title: 'A新' },
    { _v7Id: 'm2', _v7Revision: 1, title: 'B新' }
  ];
  const changes = items.map((item) => ({ moduleId: item._v7Id, expectedRevision: 1, payload: { title: item.title } }));
  drafts.setItem('monthly_v7_pending:save_module_batch:r1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000787',
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_report_id: 'r1', p_lease_id: 'lease-old', p_fencing_token: 5, p_changes: changes
    }),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;

  await client.saveModuleBatch(items);

  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_save_module_batch']);
  assert.deepEqual(items.map((item) => item._v7Revision), [2, 2]);
  assert.equal(drafts.getItem('monthly_v7_pending:save_module_batch:r1'), null);
  assert.equal(client.getLease('kpi_batch', 'r1'), currentBatchLease);
  assert.equal(transport.calls.some((call) => call.name === 'monthly_v7_release_lease'), false);
});

test('saveModuleBatch 舊 operation 回 LEASE_LOST 後才 claim 並只送一個新 operation', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000795';
  const newOperationId = '00000000-0000-4000-8000-000000000796';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: 'A' } },
        { id: 'm2', revision: 1, payload: { title: 'B' } }
      ], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'kpi_batch', entity_id: 'r1', lease_id: 'batch-current', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_module_batch: (params) => params.p_operation_id === oldOperationId
      ? { ok: false, error: 'LEASE_LOST' }
      : { ok: true, updated: [{ entityId: 'm1', revision: 2 }, { entityId: 'm2', revision: 2 }] }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const items = [
    { _v7Id: 'm1', _v7Revision: 1, title: 'A2' },
    { _v7Id: 'm2', _v7Revision: 1, title: 'B2' }
  ];
  const changes = items.map((item) => ({ moduleId: item._v7Id, expectedRevision: 1, payload: { title: item.title } }));
  drafts.setItem('monthly_v7_pending:save_module_batch:r1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_report_id: 'r1', p_lease_id: 'batch-old', p_fencing_token: 3, p_changes: changes
    }),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;

  const result = await client.saveModuleBatch(items);

  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls.map((call) => call.name), [
    'monthly_v7_save_module_batch', 'monthly_v7_claim_lease', 'monthly_v7_save_module_batch'
  ]);
  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_module_batch');
  assert.equal(saves[0].params.p_operation_id, oldOperationId);
  assert.equal(saves[1].params.p_operation_id, newOperationId);
  assert.equal(items[0]._v7Revision, 2);
  assert.equal(items[1]._v7Revision, 2);
});

test('lost acknowledgement 以同一 operation_id 自動重送', async () => {
  let attempts = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_claim_lease: { ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'l1', fencing_token: 1, holder_user_id: 'u1', client_session_id: 'tab' },
    monthly_v7_save_module: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network reply lost');
      return { ok: true, entityId: 'm1', revision: 2, watermark: 1 };
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab', operationIdFactory: () => '00000000-0000-4000-8000-000000000777'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '更新' };
  await client.saveModule(item);
  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_module');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].params.p_operation_id, saves[1].params.p_operation_id);
  assert.equal(item._v7Revision, 2);
});

test('saveModule 有 pending 時先重播舊 operation，另一人持有目前 lease 也可取回 COMMITTED', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000785';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '原始' } }], records: [], users: []
    },
    monthly_v7_claim_lease: { ok: false, error: 'LEASE_HELD', holderDisplayName: '其他使用者' },
    monthly_v7_save_module: { ok: true, entityId: 'm1', revision: 2, watermark: 1 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current',
    operationIdFactory: () => { throw new Error('COMMITTED replay must not create a new operation'); }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const payload = { title: '逾時前已提交內容' };
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 4,
    p_payload: payload
  };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'u1'
  }));
  const item = { _v7Id: 'm1', _v7Revision: 1, title: payload.title };
  transport.calls.length = 0;

  const result = await client.saveModule(item);

  assert.equal(result.revision, 2);
  assert.equal(item._v7Revision, 2);
  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_save_module']);
  assert.equal(transport.calls[0].params.p_operation_id, oldOperationId);
  assert.equal(transport.calls[0].params.p_lease_id, 'lease-old');
  assert.equal(transport.calls[0].params.p_user_session_id, 'user-1');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), null);
  assert.equal(drafts.getItem('monthly_v7_draft:module:m1'), null);
});

test('saveModule 舊 operation 回傳 COMMITTED 時保留已存在的同 actor lease', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '原始' } }], records: [], users: []
    },
    monthly_v7_save_module: { ok: true, entityId: 'm1', revision: 2, watermark: 1 },
    monthly_v7_release_lease: { ok: true }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current',
    operationIdFactory: () => { throw new Error('COMMITTED replay must not create a new operation'); }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  client.leases.set(client.leaseKey('module', 'm1'), client.normalizeLease({
    entity_type: 'module', entity_id: 'm1', lease_id: 'lease-current', fencing_token: 8,
    holder_user_id: 'u1', client_session_id: 'tab-current'
  }));
  const payload = { title: '已提交內容' };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000786',
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 4,
      p_payload: payload
    }),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;

  await client.saveModule({ _v7Id: 'm1', _v7Revision: 1, title: payload.title });

  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_save_module']);
  assert.equal(client.getLease('module', 'm1')?.leaseId, 'lease-current');
});

test('相同保存內容只在 session 更新時沿用 pending operation ID 並以目前憑證重送', async () => {
  const drafts = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000778';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-current' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-current', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_claim_lease: { ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-current', fencing_token: 9, holder_user_id: 'u1', client_session_id: 'tab-current' },
    monthly_v7_save_module: { ok: true, entityId: 'm1', revision: 2, watermark: 1 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '同一份待保存草稿', columns: ['內容'] };
  const oldParams = {
    p_workspace_key: 'workspace-test',
    p_user_session_id: 'user-old',
    p_client_session_id: 'tab-old',
    p_module_id: 'm1',
    p_expected_revision: 1,
    p_lease_id: 'lease-current',
    p_fencing_token: 9,
    p_payload: { title: '同一份待保存草稿', columns: ['內容'] }
  };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId,
    signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'u1'
  }));

  await client.saveModule(item);

  const save = transport.calls.find((call) => call.name === 'monthly_v7_save_module');
  assert.equal(save.params.p_operation_id, operationId);
  assert.equal(save.params.p_user_session_id, 'user-current');
  assert.equal(save.params.p_client_session_id, 'tab-current');
  assert.equal(save.params.p_lease_id, 'lease-current');
  assert.equal(save.params.p_fencing_token, 9);
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), null);
});

test('pending 保存的 lease 或 fencing token 更新時先重播舊簽章，確認 LEASE_LOST 後才 claim 並以新 operation 保存', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000779';
  const newOperationId = '00000000-0000-4000-8000-000000000780';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-current', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '同一份待保存草稿', columns: ['內容'] } }],
      records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-current', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_module: (params) => params.p_operation_id === oldOperationId
      ? { ok: false, error: 'LEASE_LOST' }
      : { ok: true, entityId: 'm1', revision: 2 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '同一份待保存草稿', columns: ['內容'] };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 3,
      p_payload: { title: '同一份待保存草稿', columns: ['內容'] }
    }),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;

  const result = await client.saveModule(item);

  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls.map((call) => call.name), [
    'monthly_v7_save_module', 'monthly_v7_claim_lease', 'monthly_v7_save_module'
  ]);
  const saveCalls = transport.calls.filter((call) => call.name === 'monthly_v7_save_module');
  assert.equal(saveCalls[0].params.p_operation_id, oldOperationId);
  assert.equal(saveCalls[0].params.p_lease_id, 'lease-old');
  assert.equal(saveCalls[1].params.p_operation_id, newOperationId);
  assert.equal(saveCalls[1].params.p_lease_id, 'lease-current');
  assert.equal(item._v7Revision, 2);
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), null);
});

test('pending 保存的 payload 或 revision 不同時仍 fail closed 且不得 dispatch', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true, entityId: 'm1', revision: 3 } });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  const currentParams = {
    p_workspace_key: 'workspace-test',
    p_user_session_id: 'user-current',
    p_client_session_id: 'tab-current',
    p_module_id: 'm1',
    p_expected_revision: 2,
    p_lease_id: 'lease-current',
    p_fencing_token: 9,
    p_payload: { title: '目前畫面新草稿', columns: ['新內容'] }
  };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner' };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000781',
    signature: JSON.stringify(Object.assign({}, currentParams, {
      p_user_session_id: 'user-old',
      p_client_session_id: 'tab-old',
      p_expected_revision: 1,
      p_lease_id: 'lease-old',
      p_fencing_token: 3,
      p_payload: { title: '先前待保存草稿', columns: ['舊內容'] }
    })),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'u1'
  }));

  await assert.rejects(
    () => client.executeOperation('monthly_v7_save_module', currentParams, 'save_module:m1'),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.ok(drafts.getItem('monthly_v7_pending:save_module:m1'));
});

test('pending envelope 綁定不同 actor 時拒絕 dispatch 並保留證據', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true } });
  const client = new MonthlyV7Client({ transport, sessionStorage: memoryStorage(), draftStorage: drafts });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner' };
  const params = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-1', p_fencing_token: 1,
    p_payload: { title: '草稿' }
  };
  const storageKey = 'monthly_v7_pending:save_module:m1';
  drafts.setItem(storageKey, JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000782',
    signature: JSON.stringify(params),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'actor-other'
  }));

  await assert.rejects(
    () => client.executeOperation('monthly_v7_save_module', params, 'save_module:m1'),
    (error) => error.code === 'PENDING_OPERATION_ACTOR_MISMATCH'
  );
  assert.equal(transport.calls.length, 0);
  assert.equal(JSON.parse(drafts.getItem(storageKey)).actorUserId, 'actor-other');
});

test('pending operation 收到 IDEMPOTENCY_MISMATCH 時保留 envelope 不清除', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({ monthly_v7_save_module: { ok: false, error: 'IDEMPOTENCY_MISMATCH' } });
  const client = new MonthlyV7Client({ transport, sessionStorage: memoryStorage(), draftStorage: drafts });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner' };
  const params = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-1', p_fencing_token: 1,
    p_payload: { title: '草稿' }
  };
  const storageKey = 'monthly_v7_pending:save_module:m1';
  drafts.setItem(storageKey, JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000783',
    signature: JSON.stringify(params),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'actor-current'
  }));

  const result = await client.executeOperation('monthly_v7_save_module', params, 'save_module:m1');

  assert.equal(result.error, 'IDEMPOTENCY_MISMATCH');
  assert.ok(drafts.getItem(storageKey));
});

test('首次 operation ID 碰撞收到 IDEMPOTENCY_MISMATCH 時也保留剛落盤的 actor envelope', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({ monthly_v7_save_module: { ok: false, error: 'IDEMPOTENCY_MISMATCH' } });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    operationIdFactory: () => '00000000-0000-4000-8000-000000000784'
  });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner' };
  const params = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-1', p_fencing_token: 1,
    p_payload: { title: '草稿' }
  };
  const storageKey = 'monthly_v7_pending:save_module:m1';

  const result = await client.executeOperation('monthly_v7_save_module', params, 'save_module:m1');

  assert.equal(result.error, 'IDEMPOTENCY_MISMATCH');
  const envelope = JSON.parse(drafts.getItem(storageKey));
  assert.equal(envelope.operationId, '00000000-0000-4000-8000-000000000784');
  assert.equal(envelope.actorUserId, 'actor-current');
});

test('損壞的 pending JSON 必須 fail closed 且保留原始證據', async () => {
  const drafts = memoryStorage();
  drafts.setItem('monthly_v7_pending:save_module:m1', '{broken-json');
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true, revision: 2 } });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => '00000000-0000-4000-8000-000000000790'
  });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner' };

  await assert.rejects(
    () => client.replayPendingBeforeLease('monthly_v7_save_module', 'save_module:m1', {
      p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
      p_module_id: 'm1', p_expected_revision: 1, p_payload: { title: '目前內容' }
    }),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), '{broken-json');
});

test('可解析但非法的 pending envelope 也必須 fail closed 且不覆寫', async () => {
  const params = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-current', p_fencing_token: 1,
    p_payload: { title: '目前內容' }
  };
  const invalidValues = [
    '', 'null', 'false', '0', '""',
    JSON.stringify({
      operationId: 'not-a-uuid', signature: JSON.stringify(params),
      actorUserId: 'actor-current', createdAt: '2026-08-11T00:00:00.000Z'
    }),
    JSON.stringify({
      operationId: '00000000-0000-4000-8000-000000000794', signature: JSON.stringify(params),
      actorUserId: 'actor-current', createdAt: 'not-an-iso-timestamp'
    }),
    JSON.stringify({
      operationId: '00000000-0000-4000-8000-000000000793', signature: JSON.stringify(params),
      createdAt: '2026-08-11T00:00:00.000Z', unexpected: true
    })
  ];
  for (const raw of invalidValues) {
    const drafts = memoryStorage();
    const storageKey = 'monthly_v7_pending:save_module:m1';
    drafts.setItem(storageKey, raw);
    const transport = fakeTransport({ monthly_v7_save_module: { ok: true, revision: 2 } });
    const client = new MonthlyV7Client({
      transport, sessionStorage: memoryStorage(), draftStorage: drafts,
      idFactory: () => 'tab-current', operationIdFactory: () => '00000000-0000-4000-8000-000000000794'
    });
    client.userSession = { id: 'session-current' };
    client.user = { id: 'actor-current', username: 'owner' };
    await assert.rejects(
      () => client.executeOperation('monthly_v7_save_module', params, 'save_module:m1'),
      (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
    );
    assert.equal(transport.calls.length, 0);
    assert.equal(drafts.getItem(storageKey), raw);
  }
});

test('pending fencing token 非正整數時任何 RPC 前 fail closed 且保留 pending 與草稿', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000795';
  const newOperationId = '00000000-0000-4000-8000-000000000796';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-current',
      user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1,
      report: { id: 'report-1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '內容 A' } }],
      records: [], users: []
    },
    monthly_v7_save_module: (params) => params.p_operation_id === oldOperationId
      ? { ok: false, error: 'LEASE_LOST' }
      : { ok: true, entityId: 'm1', revision: 2, watermark: 2 },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1',
      lease_id: 'lease-current', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  const item = { _v7Id: 'm1', _v7Revision: 1, title: '內容 A' };
  const pendingKey = 'save_module:m1';
  const storageKey = `monthly_v7_pending:${pendingKey}`;
  const oldParams = {
    p_workspace_key: 'workspace-test',
    p_user_session_id: 'user-old',
    p_client_session_id: 'tab-old',
    p_module_id: 'm1',
    p_expected_revision: 1,
    p_payload: { title: '內容 A' },
    p_lease_id: 'lease-old',
    p_fencing_token: -1
  };
  const rawPending = JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'u1'
  });
  client.saveDraft('module', 'm1', { title: '內容 A' }, 1);
  drafts.setItem(storageKey, rawPending);
  transport.calls.length = 0;

  await assert.rejects(
    () => client.saveModule(item),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );

  assert.equal(transport.calls.length, 0);
  assert.equal(drafts.getItem(storageKey), rawPending);
  assert.equal(client.readDraft('module', 'm1').payload.title, '內容 A');
  assert.equal(item._v7Revision, 1);
});

test('actorless legacy module pending 換 user session 後不得歸給目前 actor', async () => {
  const drafts = memoryStorage();
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-old', p_client_session_id: 'tab-old',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 1,
    p_payload: { title: '舊待保存內容' }
  };
  const storageKey = 'monthly_v7_pending:save_module:m1';
  drafts.setItem(storageKey, JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000799', signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z'
  }));
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true, revision: 2 } });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create'
  });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner', role: 'owner' };

  await assert.rejects(
    () => client.replayPendingBeforeLease('monthly_v7_save_module', 'save_module:m1', {
      p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
      p_module_id: 'm1', p_expected_revision: 1, p_payload: { title: '舊待保存內容' }
    }),
    (error) => error.code === 'PENDING_OPERATION_ACTOR_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.ok(drafts.getItem(storageKey));
});

test('actorless module pending 即使 user session 相同也不得歸給目前 actor', async () => {
  const drafts = memoryStorage();
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-same', p_client_session_id: 'tab-old',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 1,
    p_payload: { title: '舊待保存內容' }
  };
  const storageKey = 'monthly_v7_pending:save_module:m1';
  const raw = JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000798', signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z'
  });
  drafts.setItem(storageKey, raw);
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true, revision: 2 } });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create'
  });
  client.userSession = { id: 'session-same' };
  client.user = { id: 'actor-current', username: 'owner', role: 'owner' };

  await assert.rejects(
    () => client.replayPendingBeforeLease('monthly_v7_save_module', 'save_module:m1', {
      p_workspace_key: 'workspace-test', p_user_session_id: 'session-same', p_client_session_id: 'tab-current',
      p_module_id: 'm1', p_expected_revision: 1, p_payload: { title: '舊待保存內容' }
    }),
    (error) => error.code === 'PENDING_OPERATION_ACTOR_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.equal(drafts.getItem(storageKey), raw);
});

test('nested payload 的 lease/fencing 同名業務欄位不同時不得被忽略', async () => {
  const drafts = memoryStorage();
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'session-old', p_client_session_id: 'tab-old',
    p_module_id: 'm1', p_expected_revision: 1, p_lease_id: 'lease-old', p_fencing_token: 1,
    p_payload: { title: '內容', nested: { p_lease_id: 'business-old', p_fencing_token: 7 } }
  };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000791',
    signature: JSON.stringify(oldParams), createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'actor-current'
  }));
  const transport = fakeTransport({ monthly_v7_save_module: { ok: true, revision: 2 } });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => '00000000-0000-4000-8000-000000000792'
  });
  client.userSession = { id: 'session-current' };
  client.user = { id: 'actor-current', username: 'owner' };

  await assert.rejects(
    () => client.replayPendingBeforeLease('monthly_v7_save_module', 'save_module:m1', {
      p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_client_session_id: 'tab-current',
      p_module_id: 'm1', p_expected_revision: 1,
      p_payload: { title: '內容', nested: { p_lease_id: 'business-current', p_fencing_token: 8 } }
    }),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.ok(drafts.getItem('monthly_v7_pending:save_module:m1'));
});

test('record create/save/delete 使用 server UUID 與逐筆 lease/CAS', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_create_record: { ok: true, entityId: 'rec-1', revision: 1, watermark: 1 },
    monthly_v7_claim_lease: (params) => ({ ok: true, entity_type: params.p_entity_type, entity_id: params.p_entity_id, lease_id: 'lease-r', fencing_token: 3, holder_user_id: 'u1', client_session_id: 'tab' }),
    monthly_v7_save_record: { ok: true, entityId: 'rec-1', revision: 2, watermark: 2 },
    monthly_v7_delete_record: { ok: true, entityId: 'rec-1', revision: 3, deleted: true, watermark: 3 }
  });
  let op = 0;
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab',
    operationIdFactory: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const record = await client.createRecord('inspections', { vessel: 'A' });
  assert.equal(record._v7Id, 'rec-1');
  assert.equal(record._v7Revision, 1);
  record.port = 'Kaohsiung';
  await client.saveRecord('inspections', record);
  assert.equal(record._v7Revision, 2);
  await client.deleteRecord('inspections', record);
  const claims = transport.calls.filter((call) => call.name === 'monthly_v7_claim_lease');
  assert.deepEqual(claims.map((call) => call.params.p_entity_type), ['record:inspections', 'record:inspections']);
  const save = transport.calls.find((call) => call.name === 'monthly_v7_save_record');
  assert.equal(save.params.p_expected_revision, 1);
  assert.equal(save.params.p_fencing_token, 3);
});

test('create module lost-ACK 只在唯一相同 payload 时重播旧 operation 并挂回 server identity', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000805';
  const payload = { id: 999, title: '本機新增', columns: ['內容'] };
  const transport = fakeTransport({
    monthly_v7_create_module: (params) => ({
      ok: true, entityId: 'm-new', revision: 1, reportRevision: 4,
      sortRank: 3, operationId: params.p_operation_id, watermark: 11
    })
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner', role: 'owner' };
  client.snapshot = {
    report: { id: 'r1', revision: 4, _serverRevision: 4 },
    modules: [], records: [], users: []
  };
  const item = { ...payload };
  drafts.setItem('monthly_v7_pending:create_module:r1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-current',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4, p_payload: payload
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));

  const result = await client.reconcilePendingCreateModule([item]);

  assert.equal(result.ok, true);
  assert.equal(item._v7Id, 'm-new');
  assert.equal(item._v7Revision, 1);
  assert.equal(client.currentReport()._serverRevision, 4);
  assert.equal(client.snapshot.modules[0].id, 'm-new');
  assert.equal(client.snapshot.modules[0].payload.id, 999);
  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_create_module']);
  assert.equal(transport.calls[0].params.p_operation_id, oldOperationId);
  assert.equal(transport.calls[0].params.p_lease_id, 'lease-old');
  assert.equal(drafts.getItem('monthly_v7_pending:create_module:r1'), null);
});

test('create module pending 與目前 payload 不同時 fail closed 且零 RPC', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({});
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner', role: 'owner' };
  client.snapshot = { report: { id: 'r1', revision: 4, _serverRevision: 4 }, modules: [], records: [], users: [] };
  drafts.setItem('monthly_v7_pending:create_module:r1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000806',
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-current',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4,
      p_payload: { id: 999, title: '舊 intent' }
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));

  await assert.rejects(
    () => client.reconcilePendingCreateModule([{ id: 999, title: '目前不同 intent' }]),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.ok(drafts.getItem('monthly_v7_pending:create_module:r1'));
});

test('reorder pending 已 COMMITTED 時先重播同 operation，不 claim 新 lease 或重複增加 revision', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000801';
  const transport = fakeTransport({
    monthly_v7_reorder_modules: (params) => ({
      ok: true, entityType: 'report_structure', entityId: 'r1',
      reportRevision: 4, operationId: params.p_operation_id, watermark: 9
    })
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner', role: 'owner' };
  client.snapshot = {
    report: { id: 'r1', revision: 2, _serverRevision: 3 },
    modules: [{ id: 'm1' }, { id: 'm2' }], records: [], users: []
  };
  drafts.setItem('monthly_v7_pending:reorder_modules:r1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-current',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4,
      p_module_order: ['m2', 'm1']
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));

  const result = await client.reorderModules([{ _v7Id: 'm2' }, { _v7Id: 'm1' }]);

  assert.equal(result.ok, true);
  assert.equal(client.currentReport().revision, 4);
  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_reorder_modules']);
  assert.equal(transport.calls[0].params.p_operation_id, oldOperationId);
  assert.equal(transport.calls[0].params.p_lease_id, 'lease-old');
  assert.equal(drafts.getItem('monthly_v7_pending:reorder_modules:r1'), null);
});

test('reorder pending 舊 lease 明確失效後才 claim 新 lease 並建立新 operation', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000802';
  const newOperationId = '00000000-0000-4000-8000-000000000803';
  const transport = fakeTransport({
    monthly_v7_reorder_modules: (params) => params.p_operation_id === oldOperationId
      ? { ok: false, error: 'LEASE_LOST' }
      : { ok: true, reportRevision: 4, operationId: newOperationId, watermark: 10 },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_structure', entity_id: 'r1',
      lease_id: 'lease-new', fencing_token: 8, holder_user_id: 'u1', client_session_id: 'tab-current'
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner', role: 'owner' };
  client.snapshot = {
    report: { id: 'r1', revision: 2, _serverRevision: 3 },
    modules: [{ id: 'm1' }, { id: 'm2' }], records: [], users: []
  };
  drafts.setItem('monthly_v7_pending:reorder_modules:r1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-current',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4,
      p_module_order: ['m2', 'm1']
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));

  const result = await client.reorderModules([{ _v7Id: 'm2' }, { _v7Id: 'm1' }]);

  assert.equal(result.ok, true);
  assert.equal(client.currentReport().revision, 4);
  assert.deepEqual(transport.calls.map((call) => call.name), [
    'monthly_v7_reorder_modules', 'monthly_v7_claim_lease', 'monthly_v7_reorder_modules'
  ]);
  const reorderCalls = transport.calls.filter((call) => call.name === 'monthly_v7_reorder_modules');
  assert.equal(reorderCalls[0].params.p_operation_id, oldOperationId);
  assert.equal(reorderCalls[0].params.p_lease_id, 'lease-old');
  assert.equal(reorderCalls[1].params.p_operation_id, newOperationId);
  assert.equal(reorderCalls[1].params.p_lease_id, 'lease-new');
  assert.equal(drafts.getItem('monthly_v7_pending:reorder_modules:r1'), null);
});

test('reorder pending 的 module order 與目前不同時 fail closed 且零 RPC', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({});
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'user-current' };
  client.user = { id: 'u1', username: 'owner', role: 'owner' };
  client.snapshot = {
    report: { id: 'r1', revision: 2, _serverRevision: 3 },
    modules: [{ id: 'm1' }, { id: 'm2' }], records: [], users: []
  };
  drafts.setItem('monthly_v7_pending:reorder_modules:r1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000804',
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-current',
      p_report_id: 'r1', p_expected_report_revision: 3,
      p_lease_id: 'lease-old', p_fencing_token: 4,
      p_module_order: ['m1', 'm2']
    }),
    createdAt: '2026-08-12T00:00:00.000Z', actorUserId: 'u1'
  }));

  await assert.rejects(
    () => client.reorderModules([{ _v7Id: 'm2' }, { _v7Id: 'm1' }]),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  assert.equal(transport.calls.length, 0);
  assert.ok(drafts.getItem('monthly_v7_pending:reorder_modules:r1'));
});

test('report metadata、structure 與 KPI batch 使用各自短 lease並更新 server revisions', async () => {
  let claimFence = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '月報', date: '2026-08-10', period: {}, revision: 1 },
      modules: [{ id: 'm1', legacyItemId: 'a', revision: 1, payload: { title: 'A' } }], records: [], users: []
    },
    monthly_v7_claim_lease: (params) => ({ ok: true, entity_type: params.p_entity_type, entity_id: params.p_entity_id, lease_id: `lease-${++claimFence}`, fencing_token: claimFence, holder_user_id: 'u1', client_session_id: 'tab' }),
    monthly_v7_save_report_meta: { ok: true, revision: 2, watermark: 1 },
    monthly_v7_create_module: { ok: true, entityId: 'm2', revision: 1, reportRevision: 3, watermark: 2 },
    monthly_v7_reorder_modules: { ok: true, reportRevision: 4, watermark: 3 },
    monthly_v7_save_module_batch: { ok: true, updated: [{ entityId: 'm1', revision: 2 }, { entityId: 'm2', revision: 2 }], watermark: 5 },
    monthly_v7_delete_module: { ok: true, entityId: 'm2', revision: 3, reportRevision: 5, deleted: true, watermark: 6 }
  });
  let op = 0;
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab',
    operationIdFactory: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  await client.saveReportMeta({ title: '新月報', date: '2026-08-11', period: { startMonth: 7 } });
  assert.equal(client.currentReport().revision, 2);
  assert.equal(client.currentReport()._serverRevision, 2);
  const created = await client.createModule({ title: 'B', columns: [''] });
  assert.equal(created._v7Id, 'm2');
  assert.equal(client.currentReport().revision, 3);
  const first = { _v7Id: 'm1', _v7Revision: 1, title: 'A2' };
  await client.reorderModules([created, first]);
  assert.equal(client.currentReport().revision, 4);
  const reorder = transport.calls.find((call) => call.name === 'monthly_v7_reorder_modules');
  assert.deepEqual(reorder.params.p_module_order, ['m2', 'm1']);
  assert.equal(Object.hasOwn(reorder.params, 'p_order'), false);
  await client.saveModuleBatch([first, created]);
  assert.deepEqual([first._v7Revision, created._v7Revision], [2, 2]);
  await client.deleteModule(created);
  assert.equal(client.currentReport().revision, 5);
  const claimTypes = transport.calls.filter((call) => call.name === 'monthly_v7_claim_lease').map((call) => call.params.p_entity_type);
  assert.deepEqual(claimTypes, ['report_meta', 'report_structure', 'report_structure', 'kpi_batch', 'report_structure', 'module']);
  const deletion = transport.calls.find((call) => call.name === 'monthly_v7_delete_module');
  assert.equal(deletion.params.p_structure_lease_id, 'lease-5');
  assert.equal(deletion.params.p_structure_fencing_token, 5);
  assert.equal(deletion.params.p_module_lease_id, 'lease-6');
  assert.equal(deletion.params.p_module_fencing_token, 6);
  assert.equal(client.getLease('report_structure', 'r1'), null);
  assert.equal(client.getLease('module', 'm2'), null);
});

test('report_meta RPC timeout 會落本機 draft，重新載入 snapshot 後恢復標題', async () => {
  const drafts = memoryStorage();
  const snapshot = {
    ok: true, watermark: 0,
    report: { id: 'r1', legacyFileId: 'x', title: '雲端舊標題', date: '2026-08-01', period: {}, settings: {}, revision: 1 },
    modules: [], records: [], users: []
  };
  const timeout = () => {
    const error = new Error('RPC_TIMEOUT');
    error.code = 'RPC_TIMEOUT';
    throw error;
  };
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: snapshot,
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_meta', entity_id: 'r1', lease_id: 'lease-meta', fencing_token: 1,
      holder_user_id: 'u1', client_session_id: 'tab-1'
    },
    monthly_v7_save_report_meta: timeout
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-1', operationIdFactory: () => '00000000-0000-4000-8000-000000000788'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  await assert.rejects(
    () => client.saveReportMeta({ title: '本機新標題', date: '2026-08-11', period: { month: 8 }, settings: { theme: 'blue' } }),
    (error) => error.code === 'RPC_TIMEOUT'
  );

  const draft = client.readDraft('report_meta', 'r1');
  assert.equal(draft.payload.title, '本機新標題');
  assert.equal(draft.baseRevision, 1);

  const reloaded = new MonthlyV7Client({
    transport: fakeTransport({
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
      monthly_v7_open_site: { ok: true, site_session_id: 'site-2' },
      monthly_v7_login_user: { ok: true, user_session_id: 'user-2', user: { id: 'u1', username: 'owner', role: 'owner' } },
      monthly_v7_get_snapshot: snapshot
    }),
    sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab-2'
  });
  await reloaded.initialize({ workspaceKey: 'workspace-test' });
  await reloaded.openSite('gate');
  await reloaded.login('owner', 'pass');

  assert.equal(reloaded.snapshot.report.title, '本機新標題');
  assert.equal(reloaded.snapshot.report.date, '2026-08-11');
  assert.equal(reloaded.snapshot.report.revision, 1);
  assert.ok(reloaded.readDraft('report_meta', 'r1'));
});

test('report_meta 舊 operation 回 LEASE_LOST 後才 claim 並只送一個新 operation', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000797';
  const newOperationId = '00000000-0000-4000-8000-000000000798';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 0,
      report: { id: 'r1', legacyFileId: 'x', title: '舊標題', date: '2026-08-01', period: {}, settings: {}, revision: 1 },
      modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_meta', entity_id: 'r1', lease_id: 'meta-current', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_report_meta: (params) => params.p_operation_id === oldOperationId
      ? { ok: false, error: 'LEASE_LOST' }
      : { ok: true, revision: 2, watermark: 1 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const payload = { title: '新標題', date: '2026-08-11', period: {}, settings: {} };
  drafts.setItem('monthly_v7_pending:save_report_meta:r1', JSON.stringify({
    operationId: oldOperationId,
    signature: JSON.stringify({
      p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
      p_report_id: 'r1', p_expected_revision: 1, p_lease_id: 'meta-old', p_fencing_token: 3,
      p_title: '新標題', p_report_date: '2026-08-11', p_period: {}, p_settings: {}
    }),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;

  const result = await client.saveReportMeta(payload);

  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls.map((call) => call.name), [
    'monthly_v7_save_report_meta', 'monthly_v7_claim_lease', 'monthly_v7_save_report_meta'
  ]);
  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_report_meta');
  assert.equal(saves[0].params.p_operation_id, oldOperationId);
  assert.equal(saves[1].params.p_operation_id, newOperationId);
  assert.equal(client.currentReport().revision, 2);
  assert.equal(drafts.getItem('monthly_v7_draft:report_meta:r1'), null);
});

test('敏感 pending 的 operation ID 非 UUID 時保留原始證據並零 RPC', async () => {
  const drafts = memoryStorage();
  const pendingKey = 'monthly_v7_pending:update_site_password:workspace-test';
  const raw = JSON.stringify({
    operationId: 'not-a-uuid',
    createdAt: '2026-08-14T00:00:00.000Z',
    actorUserId: 'u1',
    sensitive: true,
    rpcName: 'monthly_v7_update_site_password',
    pendingKey: 'update_site_password:workspace-test',
    resultUnknown: true
  });
  drafts.setItem(pendingKey, raw);
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-sensitive-invalid' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-sensitive-invalid', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: { ok: true, requiresReauth: true }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    operationIdFactory: () => '00000000-0000-4000-8000-000000000910'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  transport.calls.length = 0;

  await assert.rejects(
    client.updateSitePassword('another-new-gate-pass'),
    (error) => error?.code === 'PENDING_OPERATION_UNRESOLVED'
  );

  assert.equal(drafts.getItem(pendingKey), raw);
  assert.equal(transport.calls.some((call) => call.name === 'monthly_v7_update_site_password'), false);
  assert.equal(client.isSiteUnlocked(), true);
  assert.equal(client.currentUser()?.id, 'u1');
});

test('敏感 pending 的 createdAt 非 canonical ISO 時保留原始證據並零 RPC', async () => {
  const drafts = memoryStorage();
  const pendingKey = 'monthly_v7_pending:update_site_password:workspace-test';
  const raw = JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000991',
    createdAt: '2026-08-14',
    actorUserId: 'u1',
    sensitive: true,
    rpcName: 'monthly_v7_update_site_password',
    pendingKey: 'update_site_password:workspace-test',
    resultUnknown: true
  });
  drafts.setItem(pendingKey, raw);
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-sensitive-time' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-sensitive-time', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: { ok: true, operationId: '00000000-0000-4000-8000-000000000991' }
  });
  const client = new MonthlyV7Client({
    transport,
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    idFactory: () => 'tab-sensitive-time'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate-pass');
  await client.login('owner', 'owner-pass');

  await assert.rejects(
    () => client.updateSitePassword('rotated-site-secret'),
    (error) => error && error.code === 'PENDING_OPERATION_UNRESOLVED'
  );

  assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_update_site_password').length, 0);
  assert.equal(drafts.getItem(pendingKey), raw);
});

test('createUser timeout 的 pending evidence 不得持久化帳號密碼', async () => {
  const drafts = memoryStorage();
  const timeout = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  const operationId = '00000000-0000-4000-8000-000000000906';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-create-sensitive' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-create-sensitive', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_create_user: () => { throw timeout; }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-create-sensitive', operationIdFactory: () => operationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  await assert.rejects(
    client.createUser({ username: 'admin-secret', displayName: 'Admin', role: 'admin', password: 'never-store-this-pass' }),
    (error) => error === timeout
  );

  const raw = drafts.getItem('monthly_v7_pending:create_user:admin-secret');
  assert.ok(raw);
  const pending = JSON.parse(raw);
  assert.equal(pending.operationId, operationId);
  assert.equal(pending.sensitive, true);
  assert.equal(pending.resultUnknown, true);
  assert.equal(pending.rpcName, 'monthly_v7_create_user');
  assert.equal(raw.includes('never-store-this-pass'), false);
  assert.equal(raw.includes('p_password'), false);
});

test('updateUser 密碼重設 timeout 的 pending evidence 不得持久化帳號密碼', async () => {
  const drafts = memoryStorage();
  const timeout = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  const operationId = '00000000-0000-4000-8000-000000000911';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-update-sensitive' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-update-sensitive', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_user: () => { throw timeout; }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-update-sensitive', operationIdFactory: () => operationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  await assert.rejects(
    client.updateUser('u2', {
      username: 'operator', displayName: 'Operator', role: 'operator', password: 'reset-secret-pass'
    }),
    (error) => error === timeout
  );

  const raw = drafts.getItem('monthly_v7_pending:update_user:u2');
  assert.ok(raw);
  const pending = JSON.parse(raw);
  assert.equal(pending.operationId, operationId);
  assert.equal(pending.sensitive, true);
  assert.equal(pending.resultUnknown, true);
  assert.equal(pending.rpcName, 'monthly_v7_update_user');
  assert.equal(raw.includes('reset-secret-pass'), false);
  assert.equal(raw.includes('p_new_password'), false);
});

test('site password rotation 未知結果在重新登入後沿用原 operation ID 對帳', async () => {
  const drafts = memoryStorage();
  const sessions = memoryStorage();
  const resumes = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000907';
  const timeout = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  const firstTransport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-first' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-first', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: () => { throw timeout; }
  });
  const first = new MonthlyV7Client({
    transport: firstTransport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-sensitive-first', operationIdFactory: () => operationId
  });
  await first.initialize({ workspaceKey: 'workspace-test' });
  await first.openSite('gate');
  await first.login('owner', 'pass');
  await assert.rejects(first.updateSitePassword('same-new-gate-pass'), (error) => error === timeout);

  const secondTransport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-second' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-second', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: { ok: true, requiresReauth: true, generation: 2 }
  });
  const second = new MonthlyV7Client({
    transport: secondTransport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-sensitive-second',
    operationIdFactory: () => { throw new Error('NEW_OPERATION_ID_FORBIDDEN'); }
  });
  await second.initialize({ workspaceKey: 'workspace-test' });
  await second.openSite('gate');
  await second.login('owner', 'pass');

  const result = await second.updateSitePassword('same-new-gate-pass');

  assert.equal(result.ok, true);
  const calls = secondTransport.calls.filter((call) => call.name === 'monthly_v7_update_site_password');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.p_operation_id, operationId);
  assert.equal(second.lastOperationReceipt().saveOrigin, 'pending-replay');
  assert.equal(drafts.getItem('monthly_v7_pending:update_site_password:workspace-test'), null);
});

test('site password rotation timeout 時本機 fail closed 並保留 pending/draft 證據', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: '8'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const operationId = '00000000-0000-4000-8000-000000000908';
  const timeout = new Error('RPC_TIMEOUT');
  timeout.code = 'RPC_TIMEOUT';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-rotate-timeout' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-rotate-timeout', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: () => { throw timeout; }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-rotate-timeout', operationIdFactory: () => operationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
    version: 1, purpose: 'user', token: '7'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-rotate-timeout'
  }));
  client.saveDraft('module', 'm-rotate-timeout', { title: 'rotation timeout 仍保留' }, 1);

  await assert.rejects(client.updateSitePassword('new-gate-pass'), (error) => error === timeout);

  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(sessions.getItem('monthly_v7_user_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null);
  assert.equal(client.readDraft('module', 'm-rotate-timeout').payload.title, 'rotation timeout 仍保留');
  const pending = JSON.parse(drafts.getItem('monthly_v7_pending:update_site_password:workspace-test'));
  assert.equal(pending.operationId, operationId);
  assert.equal(pending.resultUnknown, true);
  assert.equal(pending.sensitive, true);
  assert.equal(pending.rpcName, 'monthly_v7_update_site_password');
  assert.equal(pending.actorUserId, 'u1');
  assert.equal(JSON.stringify(pending).includes('new-gate-pass'), false);
  assert.equal(JSON.stringify(pending).includes('p_new_password'), false);
  assert.equal(client.lastOperationReceipt().state, 'RESULT_UNKNOWN_PENDING_RECONCILIATION');
});

test('敏感 operation 第一個確定錯誤後第二次 timeout 仍保留原 operation envelope', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000912';
  const firstError = Object.assign(new Error('TEMPORARY_FAILURE'), { code: 'TEMPORARY_FAILURE' });
  const timeout = Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' });
  let attempts = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-sensitive-mixed-retry' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-sensitive-mixed-retry', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: () => {
      attempts += 1;
      throw attempts === 1 ? firstError : timeout;
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-sensitive-mixed-retry', operationIdFactory: () => operationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  await assert.rejects(client.updateSitePassword('mixed-retry-secret'), (error) => error === timeout);

  const calls = transport.calls.filter((call) => call.name === 'monthly_v7_update_site_password');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.params.p_operation_id), [operationId, operationId]);
  const rawPending = drafts.getItem('monthly_v7_pending:update_site_password:workspace-test');
  assert.notEqual(rawPending, null);
  const pending = JSON.parse(rawPending);
  assert.equal(pending.operationId, operationId);
  assert.equal(pending.resultUnknown, true);
  assert.equal(rawPending.includes('mixed-retry-secret'), false);
  assert.equal(rawPending.includes('p_new_password'), false);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
});

test('site password rotation 成功後清 trusted marker 與 sessions，但保留 draft pending', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const resumes = memoryStorage();
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: '9'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-rotate' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-rotate', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_update_site_password: { ok: true, requiresReauth: true, generation: 2 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, resumeStorage: resumes,
    idFactory: () => 'tab-rotate',
    operationIdFactory: () => '00000000-0000-4000-8000-000000000909'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  resumes.setItem('monthly_v7_site_resume_marker', marker);
  resumes.setItem('monthly_v7_user_resume_marker', JSON.stringify({
    version: 1, purpose: 'user', token: '6'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', authorityEpoch: 2, trustedDeviceId: 'device-rotate-success'
  }));
  client.saveDraft('module', 'm-rotate', { title: '換密碼仍保留' }, 1);
  drafts.setItem('monthly_v7_pending:save_module:m-rotate', '{rotate-pending-evidence');

  const result = await client.updateSitePassword('new-gate-pass');

  assert.equal(result.requiresReauth, true);
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
  assert.equal(sessions.getItem('monthly_v7_site_session'), null);
  assert.equal(sessions.getItem('monthly_v7_user_session'), null);
  assert.equal(resumes.getItem('monthly_v7_site_resume_marker'), null);
  assert.equal(resumes.getItem('monthly_v7_user_resume_marker'), null);
  assert.equal(client.readDraft('module', 'm-rotate').payload.title, '換密碼仍保留');
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m-rotate'), '{rotate-pending-evidence');
});

test('user 管理、正式 snapshot 與 site password rotation 走 server RPC 並撤銷本頁 sessions', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_create_user: { ok: true, user: { id: 'u2', username: 'admin', role: 'admin' }, watermark: 1 },
    monthly_v7_update_user: { ok: true, user: { id: 'u2', username: 'admin2', role: 'admin' }, watermark: 2 },
    monthly_v7_delete_user: { ok: true, entityId: 'u2', deleted: true, watermark: 3 },
    monthly_v7_create_report_snapshot: { ok: true, snapshotId: 's1', contentSha256: 'abc', snapshot: { report: { title: '月報' } } },
    monthly_v7_update_site_password: { ok: true, requiresReauth: true, generation: 2, watermark: 4 }
  });
  let op = 0;
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: memoryStorage(), idFactory: () => 'tab',
    operationIdFactory: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const created = await client.createUser({ username: 'admin', displayName: 'Admin', role: 'admin', password: 'admin-pass' });
  await client.updateUser(created.id, { username: 'admin2', displayName: 'Admin 2', role: 'admin' });
  await client.deleteUser(created.id);
  const formal = await client.createReportSnapshot('pdf');
  assert.equal(formal.snapshotId, 's1');
  const snapshotCall = transport.calls.find((call) => call.name === 'monthly_v7_create_report_snapshot');
  assert.equal(snapshotCall.params.p_snapshot_kind, 'pdf');
  assert.equal('p_kind' in snapshotCall.params, false);
  await client.updateSitePassword('new-gate-pass');
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
});

test('舊 snapshot pending envelope 在重新登入換 session 後沿用 operation ID 並改送目前 session 與 p_snapshot_kind', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const snapshotOperationId = '00000000-0000-4000-8000-000000000888';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_create_report_snapshot: (params) => {
      if (Object.prototype.hasOwnProperty.call(params, 'p_kind')) {
        const error = new Error('Could not find the function monthly_v7_create_report_snapshot(p_kind)');
        error.code = 'PGRST202';
        throw error;
      }
      return { ok: true, snapshotId: 's-migrated', contentSha256: 'abc', snapshot: { report: { title: '月報' } } };
    }
  });
  const first = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts, idFactory: () => 'tab',
    operationIdFactory: () => snapshotOperationId
  });
  await first.initialize({ workspaceKey: 'workspace-test' });
  await first.openSite('gate');
  await first.login('owner', 'pass');
  const oldParams = {
    p_workspace_key: 'workspace-test',
    p_site_session_id: 'site-1',
    p_user_session_id: 'user-1',
    p_report_id: 'r1',
    p_kind: 'pdf'
  };
  await assert.rejects(
    () => first.executeOperation('monthly_v7_create_report_snapshot', oldParams, 'create_snapshot:r1:pdf'),
    (error) => error.code === 'PGRST202'
  );
  const pendingKey = 'monthly_v7_pending:create_snapshot:r1:pdf';
  const oldPending = JSON.parse(drafts.getItem(pendingKey));
  assert.equal(oldPending.operationId, snapshotOperationId);
  assert.equal(JSON.parse(oldPending.signature).p_kind, 'pdf');

  sessions.setItem('monthly_v7_site_session', JSON.stringify({ id: 'site-2' }));
  sessions.setItem('monthly_v7_user_session', JSON.stringify({ id: 'user-2' }));

  const reloaded = new MonthlyV7Client({
    transport, sessionStorage: sessions, draftStorage: drafts,
    idFactory: () => 'unused-tab', operationIdFactory: () => 'must-not-create-new-operation-id'
  });
  await reloaded.initialize({ workspaceKey: 'workspace-test' });
  await reloaded.loadSnapshot();
  const result = await reloaded.createReportSnapshot('pdf');

  assert.equal(result.snapshotId, 's-migrated');
  const snapshotCalls = transport.calls.filter((call) => call.name === 'monthly_v7_create_report_snapshot');
  assert.equal(snapshotCalls.length, 3);
  assert.equal(snapshotCalls.filter((call) => 'p_kind' in call.params).length, 2);
  const corrected = snapshotCalls.at(-1).params;
  assert.equal(corrected.p_snapshot_kind, 'pdf');
  assert.equal('p_kind' in corrected, false);
  assert.equal(corrected.p_site_session_id, 'site-2');
  assert.equal(corrected.p_user_session_id, 'user-2');
  assert.equal(corrected.p_operation_id, snapshotOperationId);
  assert.equal(drafts.getItem(pendingKey), null);
});

test('非精確舊 snapshot pending envelope 仍 fail closed 且不 dispatch', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: { ok: true, watermark: 0, report: { id: 'r1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 }, modules: [], records: [], users: [] },
    monthly_v7_create_report_snapshot: { ok: true, snapshotId: 'must-not-dispatch' }
  });
  const client = new MonthlyV7Client({ transport, sessionStorage: sessions, draftStorage: drafts, idFactory: () => 'tab' });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'monthly_v7_pending:create_snapshot:r1:pdf';
  const baseSignature = {
    p_workspace_key: 'workspace-test', p_site_session_id: 'site-1',
    p_user_session_id: 'user-1', p_report_id: 'r1', p_kind: 'pdf'
  };
  const residues = [
    {
      operationId: '00000000-0000-4000-8000-000000000991',
      signature: JSON.stringify({ ...baseSignature, p_report_id: 'different-report' }),
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000992',
      signature: JSON.stringify({ ...baseSignature, unexpected: true }),
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000994',
      signature: JSON.stringify(Object.fromEntries(Object.entries(baseSignature).filter(([key]) => key !== 'p_site_session_id'))),
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000995',
      signature: JSON.stringify(Object.fromEntries(Object.entries(baseSignature).filter(([key]) => key !== 'p_user_session_id'))),
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000996',
      signature: JSON.stringify({ ...baseSignature, p_client_session_id: 'legacy-tab' }),
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000997',
      signature: JSON.stringify({ ...baseSignature, p_client_session_id: 'legacy-tab' }),
      createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
    },
    {
      operationId: '00000000-0000-4000-8000-000000000993',
      signature: JSON.stringify(baseSignature),
      createdAt: '2026-08-11T00:00:00.000Z',
      unexpected: true
    }
  ];
  for (const pending of residues) {
    const residue = JSON.stringify(pending);
    drafts.setItem(pendingKey, residue);
    await assert.rejects(() => client.createReportSnapshot('pdf'), (error) => error.code === 'PENDING_OPERATION_UNRESOLVED');
    assert.equal(transport.calls.filter((call) => call.name === 'monthly_v7_create_report_snapshot').length, 0);
    assert.equal(drafts.getItem(pendingKey), residue);
  }
});

test('V7 JSON 匯入掛回 legacy identity 並排除 users/site secrets', () => {
  const app = new MonthlyV7BrowserApp({ transport: fakeTransport({}) });
  app.client = {
    isActive: () => true,
    snapshot: {
      modules: [{ id: 'm1', legacyItemId: '101', revision: 4, payload: { id: 101 } }],
      records: [{ id: 'r1', recordType: 'inspections', revision: 3, payload: { id: 201 } }]
    }
  };
  const imported = app.prepareImportedBundle({
    report: { modules: [{ id: 101, title: '匯入' }] },
    records: { inspections: [{ id: 201, vessel: 'A' }] },
    users: [{ username: 'fake', passwordHash: 'must-not-apply' }],
    siteAccess: { passwordHash: 'must-not-apply' }
  });
  assert.equal(imported.report.modules[0]._v7Id, 'm1');
  assert.equal(imported.report.modules[0]._v7Revision, 4);
  assert.equal(imported.records.inspections[0]._v7Id, 'r1');
  assert.equal(imported.records.inspections[0]._v7Revision, 3);
  assert.equal('users' in imported, false);
  assert.equal('siteAccess' in imported, false);
});

test('full snapshot catch-up 逐項合併並保留 lease/draft 本機內容', async () => {
  let snapshotReads = 0;
  let appliedBundle = null;
  const remoteConflicts = [];
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: { ok: true, user_session_id: 'user-1', user: { id: 'u1', username: 'owner', role: 'owner' } },
    monthly_v7_get_snapshot: () => {
      snapshotReads += 1;
      if (snapshotReads === 1) return {
        ok: true, watermark: 1, workspace: { id: 'w1' },
        report: { id: 'report-1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 1 },
        modules: [
          { id: 'm1', legacyItemId: '101', sortRank: 1, revision: 1, payload: { id: 101, title: '初始一' } },
          { id: 'm2', legacyItemId: '102', sortRank: 2, revision: 1, payload: { id: 102, title: '初始二' } }
        ], records: [], users: []
      };
      return {
        ok: true, watermark: 2, workspace: { id: 'w1' },
        report: { id: 'report-1', legacyFileId: 'legacy', title: '月報', period: {}, revision: 2 },
        modules: [
          { id: 'm1', legacyItemId: '101', sortRank: 1, revision: 2, payload: { id: 101, title: '遠端一' } },
          { id: 'm2', legacyItemId: '102', sortRank: 2, revision: 2, payload: { id: 102, title: '遠端二' } },
          { id: 'm3', legacyItemId: '103', sortRank: 3, revision: 1, payload: { id: 103, title: '遠端新增' } }
        ], records: [], users: []
      };
    },
    monthly_v7_get_changes_since: {
      ok: true, watermark: 2, hasMore: false,
      events: [{ sequence: 2, entityType: 'report_structure', entityId: 'report-1' }]
    }
  });
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab',
    host: {
      applyBundle: async (bundle) => { appliedBundle = bundle; },
      getLocalEntity: async () => ({ id: 101, title: '本機草稿', _v7Id: 'm1', _v7Revision: 1 }),
      onRemoteChangeWhileEditing: (entity) => remoteConflicts.push(entity)
    }
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  client.saveDraft('module', 'm1', { id: 101, title: '本機草稿' }, 1);
  await client.catchUp();
  const modules = appliedBundle.report.modules;
  assert.equal(modules.find((item) => item._v7Id === 'm1').title, '本機草稿');
  assert.equal(modules.find((item) => item._v7Id === 'm1')._v7Revision, 1);
  assert.equal(modules.find((item) => item._v7Id === 'm2').title, '遠端二');
  assert.equal(modules.find((item) => item._v7Id === 'm3').title, '遠端新增');
  assert.equal(remoteConflicts.length, 1);
});

test('adapter 排隊中的舊身份保存不得在切換後以新身份送出', async () => {
  const app = new MonthlyV7BrowserApp({ transport: {} });
  let actor = { id: 'u1' };
  let generation = 1;
  let releaseQueue;
  const queueGate = new Promise((resolve) => { releaseQueue = resolve; });
  const saves = [];
  app.status = { mode: 'v7' };
  app.persistChain = queueGate;
  app.reportError = () => {};
  app.decorateEditorRows = () => {};
  app.scheduleInactiveCleanModuleReleases = () => {};
  app.client = {
    snapshot: {
      report: { id: 'report-1', revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '原始內容' } }]
    },
    isActive: () => true,
    currentUser: () => actor,
    currentReport: () => ({ id: 'report-1', revision: 1 }),
    captureSessionContext: () => ({ generation, actorUserId: actor && actor.id }),
    assertSessionContext(context) {
      if (!actor || context.generation !== generation || context.actorUserId !== actor.id) {
        const error = new Error('STALE_SESSION_RESPONSE');
        error.code = 'STALE_SESSION_RESPONSE';
        error.silent = true;
        throw error;
      }
    },
    isSessionContextCurrent: (context) => !!actor
      && context.generation === generation && context.actorUserId === actor.id,
    modulePayload(item) { return { title: item.title }; },
    pendingOperationTargets: () => new Set(),
    hasPendingOperation: () => false,
    readDraft: () => null,
    clearDraft: () => {},
    async saveModule(item) { saves.push({ actor: actor.id, title: item.title }); },
    async reorderModules() {}
  };
  const queued = app.persistReportData([{ _v7Id: 'm1', _v7Revision: 1, title: 'U1_QUEUED_CONTENT' }]);

  actor = { id: 'u2' };
  generation = 2;
  releaseQueue();

  await assert.rejects(queued, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.deepEqual(saves, []);
});

test('adapter 舊身份晚到 finally 不得讀取新 DOM 或改寫新身份 superseding draft', async () => {
  const app = new MonthlyV7BrowserApp({ transport: {} });
  let actor = { id: 'u1' };
  let generation = 1;
  let rejectSave;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let draftEnvelope = {
    entityType: 'module', entityId: 'm1', baseRevision: 9,
    payload: { title: 'U2 NEW DOM' },
    supersedesOperation: { rpcName: 'monthly_v7_save_module', pendingKey: 'save_module:m1', signature: 'u2-marker' }
  };
  const originalEnvelope = JSON.stringify(draftEnvelope);
  let domReads = 0;
  app.host = {
    async getLocalEntity() {
      domReads += 1;
      return { _v7Id: 'm1', _v7Revision: 9, title: 'U2 NEW DOM' };
    }
  };
  app.client = {
    snapshot: { modules: [{ id: 'm1', revision: 1, payload: { title: '原始' } }] },
    captureSessionContext: () => Object.freeze({ generation, actorUserId: actor.id, userSessionId: `s-${actor.id}`, siteSessionId: 'site', clientSessionId: 'tab' }),
    isSessionContextCurrent: (context) => context.generation === generation && context.actorUserId === actor.id,
    assertSessionContext(context) {
      if (!this.isSessionContextCurrent(context)) {
        const error = new Error('STALE_SESSION_RESPONSE');
        error.code = 'STALE_SESSION_RESPONSE';
        error.silent = true;
        throw error;
      }
    },
    modulePayload(item) { return { title: item.title }; },
    async saveModule() {
      signalStarted();
      await new Promise((_resolve, reject) => { rejectSave = reject; });
    },
    saveSupersedingDraft(entityType, entityId, payload, baseRevision, rpcName, pendingKey) {
      draftEnvelope = { entityType, entityId, payload, baseRevision, rpcName, pendingKey };
    },
    saveDraft(entityType, entityId, payload, baseRevision) {
      draftEnvelope = { entityType, entityId, payload, baseRevision };
    }
  };
  const item = { _v7Id: 'm1', _v7Revision: 1, title: 'U1 SUBMITTED' };

  const saving = app.saveChangedModules([item]);
  await started;
  actor = { id: 'u2' };
  generation = 2;
  const stale = new Error('STALE_SESSION_RESPONSE');
  stale.code = 'STALE_SESSION_RESPONSE';
  stale.silent = true;
  rejectSave(stale);

  await assert.rejects(saving, (error) => error.code === 'STALE_SESSION_RESPONSE');
  assert.equal(domReads, 0);
  assert.equal(JSON.stringify(draftEnvelope), originalEnvelope);
});

test('module 保存等待期間的新輸入不得被誤標為已確認 baseline，且必須重建草稿', async () => {
  let releaseSave;
  let sentPayload;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const app = new MonthlyV7BrowserApp({ transport: {} });
  const savedDrafts = [];
  app.client = {
    snapshot: { modules: [{ id: 'm1', revision: 1, payload: { title: '原始內容' } }] },
    modulePayload(item) {
      const payload = JSON.parse(JSON.stringify(item));
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    },
    async saveModule(item) {
      sentPayload = this.modulePayload(item);
      signalStarted();
      await new Promise((resolve) => { releaseSave = resolve; });
      item._v7Revision = 2;
      return { ok: true, entityId: 'm1', revision: 2 };
    },
    saveDraft(entityType, entityId, payload, baseRevision) {
      savedDrafts.push({ entityType, entityId, payload: JSON.parse(JSON.stringify(payload)), baseRevision });
    }
  };
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '送出內容 A' };

  const saving = app.saveChangedModules([item]);
  await started;
  item.title = '等待期間的新內容 B';
  releaseSave();
  await saving;

  assert.equal(sentPayload.title, '送出內容 A');
  assert.equal(app.client.snapshot.modules[0].payload.title, '送出內容 A');
  assert.deepEqual(savedDrafts, [{
    entityType: 'module', entityId: 'm1', payload: { title: '等待期間的新內容 B' }, baseRevision: 2
  }]);
});

test('module timeout 後保留等待期間最新內容並標記為舊 pending 的後繼草稿', async () => {
  let rejectSave;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const app = new MonthlyV7BrowserApp({ transport: {} });
  const supersedingDrafts = [];
  app.client = {
    snapshot: { modules: [{ id: 'm1', revision: 1, payload: { title: '原始內容' } }] },
    modulePayload(item) {
      const payload = JSON.parse(JSON.stringify(item));
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    },
    async saveModule() {
      signalStarted();
      await new Promise((_resolve, reject) => { rejectSave = reject; });
    },
    saveSupersedingDraft(entityType, entityId, payload, baseRevision, rpcName, pendingKey) {
      supersedingDrafts.push({
        entityType, entityId, payload: JSON.parse(JSON.stringify(payload)), baseRevision, rpcName, pendingKey
      });
    }
  };
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '送出內容 A' };

  const saving = app.saveChangedModules([item]);
  await started;
  item.title = 'timeout 前的新內容 B';
  const timeout = new Error('RPC_TIMEOUT');
  timeout.code = 'RPC_TIMEOUT';
  rejectSave(timeout);
  await assert.rejects(() => saving, (error) => error.code === 'RPC_TIMEOUT');

  assert.deepEqual(supersedingDrafts, [{
    entityType: 'module', entityId: 'm1', payload: { title: 'timeout 前的新內容 B' }, baseRevision: 1,
    rpcName: 'monthly_v7_save_module', pendingKey: 'save_module:m1'
  }]);
  assert.equal(app.client.snapshot.modules[0].payload.title, '原始內容');
});

test('report metadata timeout 後保留等待期間最新內容並標記為舊 pending 的後繼草稿', async () => {
  let rejectSave;
  let signalStarted;
  let liveMeta = { title: '送出標題 A', date: '2026-08-11', period: {}, settings: {} };
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const supersedingDrafts = [];
  const app = new MonthlyV7BrowserApp({
    transport: {},
    host: { getLocalEntity: async () => Object.assign({}, liveMeta, { _v7Revision: 4 }) }
  });
  app.reportError = () => {};
  const report = { id: 'report-1', revision: 4, title: '原始標題', date: '2026-08-11', period: {}, settings: {} };
  app.client = {
    isActive: () => true,
    currentUser: () => ({ id: 'u1' }),
    currentReport: () => report,
    readDraft: () => null,
    async saveReportMeta() {
      signalStarted();
      await new Promise((_resolve, reject) => { rejectSave = reject; });
    },
    saveSupersedingDraft(entityType, entityId, payload, baseRevision, rpcName, pendingKey) {
      supersedingDrafts.push({
        entityType, entityId, payload: JSON.parse(JSON.stringify(payload)), baseRevision, rpcName, pendingKey
      });
    }
  };

  const saving = app.persistReportMeta(liveMeta);
  await started;
  liveMeta = { title: 'timeout 前的新標題 B', date: '2026-08-11', period: {}, settings: {} };
  const timeout = new Error('RPC_TIMEOUT');
  timeout.code = 'RPC_TIMEOUT';
  rejectSave(timeout);
  await assert.rejects(() => saving, (error) => error.code === 'RPC_TIMEOUT');

  assert.deepEqual(supersedingDrafts, [{
    entityType: 'report_meta', entityId: 'report-1',
    payload: { title: 'timeout 前的新標題 B', date: '2026-08-11', period: {}, settings: {} },
    baseRevision: 4, rpcName: 'monthly_v7_save_report_meta', pendingKey: 'save_report_meta:report-1'
  }]);
});

test('有明確 superseding marker 時先以原 operation 對帳 A，再以新 operation 保存 B', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000881';
  const newOperationId = '00000000-0000-4000-8000-000000000882';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-current',
      user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1,
      report: { id: 'report-1', legacyFileId: 'x', title: '月報', period: {}, revision: 1 },
      modules: [{ id: 'm1', legacyItemId: '101', revision: 1, payload: { title: '原始內容' } }],
      records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'module', entity_id: 'm1', lease_id: 'lease-new', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_module: (params) => params.p_operation_id === oldOperationId
      ? { ok: true, entityId: 'm1', revision: 2, watermark: 2 }
      : { ok: true, entityId: 'm1', revision: 3, watermark: 3 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'save_module:m1';
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
    p_module_id: 'm1', p_expected_revision: 1,
    p_lease_id: 'lease-old', p_fencing_token: 3,
    p_payload: { title: '送出內容 A' }
  };
  const signature = JSON.stringify(oldParams);
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId: oldOperationId, signature,
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  client.saveSupersedingDraft(
    'module', 'm1', { title: '等待期間的新內容 B' }, 1,
    'monthly_v7_save_module', pendingKey
  );
  const markedDraft = client.readDraft('module', 'm1');
  assert.deepEqual(markedDraft.supersedesOperation, {
    rpcName: 'monthly_v7_save_module', pendingKey,
    operationId: oldOperationId, signature
  });
  const migratedParams = Object.assign({}, oldParams, {
    p_user_session_id: 'user-current', p_client_session_id: 'tab-current'
  });
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId: oldOperationId, signature: JSON.stringify(migratedParams),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  transport.calls.length = 0;
  const item = { _v7Id: 'm1', _v7Revision: 1, title: '等待期間的新內容 B' };

  await client.saveModule(item);

  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_module');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].params.p_operation_id, oldOperationId);
  assert.equal(saves[0].params.p_payload.title, '送出內容 A');
  assert.equal(saves[0].params.p_expected_revision, 1);
  assert.equal(saves[1].params.p_operation_id, newOperationId);
  assert.equal(saves[1].params.p_payload.title, '等待期間的新內容 B');
  assert.equal(saves[1].params.p_expected_revision, 2);
  assert.equal(item._v7Revision, 3);
  assert.equal(drafts.getItem(`monthly_v7_pending:${pendingKey}`), null);
  assert.equal(client.readDraft('module', 'm1'), null);
});

test('pending ownership 只把目前身份或損壞 envelope 視為本次待對帳', () => {
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({
    transport: fakeTransport({}),
    sessionStorage: memoryStorage(),
    draftStorage: drafts,
    idFactory: () => 'tab-current'
  });
  client.user = { id: 'u-current', username: 'owner' };
  client.userSession = { id: 'session-current' };
  const signature = JSON.stringify({ p_report_id: 'report-1' });
  drafts.setItem('monthly_v7_pending:save_report_meta:report-1', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000901',
    signature,
    createdAt: '2026-08-12T00:00:00.000Z',
    actorUserId: 'u-current'
  }));
  drafts.setItem('monthly_v7_pending:save_module:m-foreign', JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000902',
    signature,
    createdAt: '2026-08-12T00:00:00.000Z',
    actorUserId: 'u-foreign'
  }));
  drafts.setItem('monthly_v7_pending:save_module:m-invalid', '{broken');

  assert.equal(client.hasCurrentActorPendingOperation('save_report_meta:report-1'), true);
  assert.equal(client.hasCurrentActorPendingOperation('save_module:m-foreign'), false);
  assert.equal(client.hasCurrentActorPendingOperation('save_module:m-invalid'), true);
  assert.equal(client.hasCurrentActorPendingOperation('save_module:missing'), false);
});

test('部分 module 的 batch pending 只把原 batch 涵蓋項目列為待重試', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-current', user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1,
      report: { id: 'report-1', legacyFileId: 'x', title: '月報', period: {}, revision: 4 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: '原始一' } },
        { id: 'm2', revision: 1, payload: { title: '原始二' } },
        { id: 'm3', revision: 1, payload: { title: '原始三' } }
      ], records: [], users: []
    }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab-current'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'save_module_batch:report-1';
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
    p_report_id: 'report-1',
    p_changes: [
      { moduleId: 'm1', expectedRevision: 1, payload: { title: '送出一 A' } },
      { moduleId: 'm2', expectedRevision: 1, payload: { title: '送出二 A' } }
    ],
    p_lease_id: 'lease-old', p_fencing_token: 3
  };
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId: '00000000-0000-4000-8000-000000000887',
    signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));

  assert.deepEqual(
    Array.from(client.pendingOperationTargets('monthly_v7_save_module_batch', pendingKey)).sort(),
    ['m1', 'm2']
  );
  assert.equal(client.pendingOperationTargets('monthly_v7_save_module_batch', pendingKey).has('m3'), false);
});

test('adapter 遇到部分 batch pending 時不把未變更 module 納入重試', async () => {
  const app = new MonthlyV7BrowserApp({ transport: {} });
  const baseline = [
    { id: 'm1', revision: 1, payload: { title: '原始一' } },
    { id: 'm2', revision: 1, payload: { title: '原始二' } },
    { id: 'm3', revision: 1, payload: { title: '原始三' } }
  ];
  let submittedIds = [];
  app.status = { mode: 'v7' };
  app.client = {
    snapshot: { report: { id: 'report-1', revision: 1 }, modules: baseline },
    isActive: () => true,
    currentUser: () => ({ id: 'u1' }),
    currentReport: () => ({ id: 'report-1', revision: 1 }),
    modulePayload(item) { return { title: item.title }; },
    pendingOperationTargets: () => new Set(['m1', 'm2']),
    hasPendingOperation: () => false,
    readDraft: () => null,
    clearDraft: () => {},
    async saveModuleBatch(items) { submittedIds = items.map((item) => item._v7Id); },
    async saveModule() { throw new Error('single save should not be used'); }
  };
  const live = baseline.map((row) => ({ _v7Id: row.id, _v7Revision: row.revision, title: row.payload.title }));

  await app.persistReportData(live);

  assert.deepEqual(submittedIds, ['m1', 'm2']);
});

test('batch superseding drafts 先整批對帳 A，再以新 operation 整批保存 B', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000883';
  const newOperationId = '00000000-0000-4000-8000-000000000884';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-current', user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 1,
      report: { id: 'report-1', legacyFileId: 'x', title: '月報', period: {}, revision: 4 },
      modules: [
        { id: 'm1', revision: 1, payload: { title: '原始一' } },
        { id: 'm2', revision: 1, payload: { title: '原始二' } }
      ], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'kpi_batch', entity_id: 'report-1', lease_id: 'lease-new', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_module_batch: (params) => params.p_operation_id === oldOperationId
      ? { ok: true, updated: [{ entityId: 'm1', revision: 2 }, { entityId: 'm2', revision: 2 }], watermark: 2 }
      : { ok: true, updated: [{ entityId: 'm1', revision: 3 }, { entityId: 'm2', revision: 3 }], watermark: 3 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'save_module_batch:report-1';
  const oldChanges = [
    { moduleId: 'm1', expectedRevision: 1, payload: { title: '送出一 A' } },
    { moduleId: 'm2', expectedRevision: 1, payload: { title: '送出二 A' } }
  ];
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
    p_report_id: 'report-1', p_changes: oldChanges,
    p_lease_id: 'lease-old', p_fencing_token: 3
  };
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId: oldOperationId, signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  client.saveSupersedingDraft('module', 'm1', { title: '新內容一 B' }, 1, 'monthly_v7_save_module_batch', pendingKey);
  client.saveSupersedingDraft('module', 'm2', { title: '新內容二 B' }, 1, 'monthly_v7_save_module_batch', pendingKey);
  transport.calls.length = 0;
  const items = [
    { _v7Id: 'm1', _v7Revision: 1, title: '新內容一 B' },
    { _v7Id: 'm2', _v7Revision: 1, title: '新內容二 B' }
  ];

  await client.saveModuleBatch(items);

  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_module_batch');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].params.p_operation_id, oldOperationId);
  assert.deepEqual(saves[0].params.p_changes.map((row) => row.payload.title), ['送出一 A', '送出二 A']);
  assert.equal(saves[1].params.p_operation_id, newOperationId);
  assert.deepEqual(saves[1].params.p_changes.map((row) => row.payload.title), ['新內容一 B', '新內容二 B']);
  assert.deepEqual(saves[1].params.p_changes.map((row) => row.expectedRevision), [2, 2]);
  assert.deepEqual(items.map((item) => item._v7Revision), [3, 3]);
  assert.equal(client.readDraft('module', 'm1'), null);
  assert.equal(client.readDraft('module', 'm2'), null);
});

test('report metadata superseding draft 先對帳 A，再以新 operation 保存 B', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000885';
  const newOperationId = '00000000-0000-4000-8000-000000000886';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-1' },
    monthly_v7_login_user: {
      ok: true, user_session_id: 'user-current', user: { id: 'u1', username: 'owner', role: 'owner' }
    },
    monthly_v7_get_snapshot: {
      ok: true, watermark: 4,
      report: {
        id: 'report-1', legacyFileId: 'x', title: '原始標題', date: '2026-08-11',
        period: {}, settings: {}, revision: 4
      }, modules: [], records: [], users: []
    },
    monthly_v7_claim_lease: {
      ok: true, entity_type: 'report_meta', entity_id: 'report-1', lease_id: 'lease-new', fencing_token: 9,
      holder_user_id: 'u1', client_session_id: 'tab-current'
    },
    monthly_v7_save_report_meta: (params) => params.p_operation_id === oldOperationId
      ? { ok: true, revision: 5, watermark: 5 }
      : { ok: true, revision: 6, watermark: 6 }
  });
  const client = new MonthlyV7Client({
    transport, sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => newOperationId
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');
  const pendingKey = 'save_report_meta:report-1';
  const oldParams = {
    p_workspace_key: 'workspace-test', p_user_session_id: 'user-old', p_client_session_id: 'tab-old',
    p_report_id: 'report-1', p_expected_revision: 4,
    p_title: '送出標題 A', p_report_date: '2026-08-11', p_period: {}, p_settings: {},
    p_lease_id: 'lease-old', p_fencing_token: 3
  };
  drafts.setItem(`monthly_v7_pending:${pendingKey}`, JSON.stringify({
    operationId: oldOperationId, signature: JSON.stringify(oldParams),
    createdAt: '2026-08-11T00:00:00.000Z', actorUserId: 'u1'
  }));
  const latestMeta = { title: '新標題 B', date: '2026-08-11', period: {}, settings: {} };
  client.saveSupersedingDraft(
    'report_meta', 'report-1', latestMeta, 4,
    'monthly_v7_save_report_meta', pendingKey
  );
  transport.calls.length = 0;

  await client.saveReportMeta(latestMeta);

  const saves = transport.calls.filter((call) => call.name === 'monthly_v7_save_report_meta');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].params.p_operation_id, oldOperationId);
  assert.equal(saves[0].params.p_title, '送出標題 A');
  assert.equal(saves[0].params.p_expected_revision, 4);
  assert.equal(saves[1].params.p_operation_id, newOperationId);
  assert.equal(saves[1].params.p_title, '新標題 B');
  assert.equal(saves[1].params.p_expected_revision, 5);
  assert.equal(client.currentReport().revision, 6);
  assert.equal(client.currentReport().title, '新標題 B');
  assert.equal(client.readDraft('report_meta', 'report-1'), null);
});

test('無法辨識的 pending 一旦被發現就停止背景重送並維持人工處理狀態', async () => {
  const statuses = [];
  let saveCalls = 0;
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.status = { mode: 'v7' };
  app.setHost({
    setStatus(text, kind) { statuses.push({ text, kind }); }
  });
  const baseline = { id: 'm1', revision: 1, payload: { title: '雲端原始內容' } };
  app.client = {
    snapshot: {
      report: { id: 'report-1', revision: 1 },
      modules: [baseline], records: []
    },
    isActive: () => true,
    isWriteReady: () => true,
    sessionErrorCode: () => '',
    currentUser: () => ({ id: 'u-current' }),
    currentReport: () => ({ id: 'report-1', revision: 1 }),
    modulePayload(item) { return { title: item.title }; },
    pendingOperationTargets: () => new Set(),
    hasPendingOperation: (key) => key === 'save_module:m1',
    readDraft: () => ({
      entityType: 'module', entityId: 'm1', baseRevision: 1,
      payload: { title: '待保存本機內容' }
    }),
    clearDraft: () => {},
    async saveModule() {
      saveCalls += 1;
      const error = new Error('PENDING_OPERATION_UNRESOLVED');
      error.code = 'PENDING_OPERATION_UNRESOLVED';
      throw error;
    }
  };
  const live = [{ _v7Id: 'm1', _v7Revision: 1, title: '待保存本機內容' }];

  await assert.rejects(
    app.persistReportData(live, { saveOrigin: 'autosave' }),
    (error) => error.code === 'PENDING_OPERATION_UNRESOLVED'
  );
  const blocked = await app.persistReportData(live, { saveOrigin: 'autosave' });

  assert.equal(saveCalls, 1);
  assert.equal(blocked.recoveryBlocked, true);
  assert.equal(blocked.state, 'PENDING_OPERATION_BLOCKED');
  assert.equal(statuses.at(-1).kind, 'error');
  assert.match(statuses.at(-1).text, /待對帳操作/);
  assert.match(statuses.at(-1).text, /本機草稿.*保留/);
  assert.match(statuses.at(-1).text, /停止.*自動保存/);
});

test('autosave timeout receipt 標示結果未知且不觸發人工 pending blocker', async () => {
  const drafts = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000921';
  const client = new MonthlyV7Client({
    transport: {
      async rpc() {
        const error = new Error('RPC_TIMEOUT');
        error.code = 'RPC_TIMEOUT';
        error.rpcName = 'monthly_v7_save_module';
        error.elapsedMs = 2500;
        throw error;
      }
    },
    sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current', operationIdFactory: () => operationId
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'session-current' };
  client.user = { id: 'u-current' };

  await assert.rejects(
    client.executeOperation(
      'monthly_v7_save_module',
      { p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_payload: { title: 'A' } },
      'save_module:m1',
      { saveOrigin: 'autosave' }
    ),
    (error) => error.code === 'RPC_TIMEOUT'
  );

  assert.deepEqual(client.lastOperationReceipt(), {
    state: 'RESULT_UNKNOWN_PENDING_RECONCILIATION',
    rpcName: 'monthly_v7_save_module',
    pendingKey: 'save_module:m1',
    operationId,
    requestedOrigin: 'autosave',
    saveOrigin: 'autosave',
    attempt: 2,
    errorCode: 'RPC_TIMEOUT',
    startedAt: client.lastOperationReceipt().startedAt,
    updatedAt: client.lastOperationReceipt().updatedAt
  });
  assert.ok(Date.parse(client.lastOperationReceipt().startedAt));
  assert.ok(Date.parse(client.lastOperationReceipt().updatedAt));
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1') !== null, true);

  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.status = { mode: 'v7' };
  app.client = client;
  assert.equal(app.isPendingRecoveryBlocked(), false);
  assert.equal(app.markPendingRecoveryBlock(Object.assign(new Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' })), false);
});

test('既有 pending 以同 operation 對帳成功時 receipt 標示 pending-replay', async () => {
  const drafts = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000922';
  const params = {
    p_workspace_key: 'workspace-test',
    p_user_session_id: 'session-old',
    p_payload: { title: 'A' }
  };
  drafts.setItem('monthly_v7_pending:save_module:m1', JSON.stringify({
    operationId,
    signature: JSON.stringify(params),
    createdAt: '2026-08-13T00:00:00.000Z',
    actorUserId: 'u-current'
  }));
  const calls = [];
  const client = new MonthlyV7Client({
    transport: {
      async rpc(name, request) {
        calls.push({ name, request });
        return { ok: true, operationId, revision: 2, watermark: 3 };
      }
    },
    sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current',
    operationIdFactory: () => { throw new Error('replay must not create a new operation'); }
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'session-old' };
  client.user = { id: 'u-current' };

  const result = await client.executeOperation(
    'monthly_v7_save_module', params, 'save_module:m1', { saveOrigin: 'login-restore' }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.p_operation_id, operationId);
  assert.equal(drafts.getItem('monthly_v7_pending:save_module:m1'), null);
  assert.deepEqual(client.lastOperationReceipt(), {
    state: 'CLOUD_CONFIRMED',
    rpcName: 'monthly_v7_save_module',
    pendingKey: 'save_module:m1',
    operationId,
    requestedOrigin: 'login-restore',
    saveOrigin: 'pending-replay',
    attempt: 1,
    errorCode: '',
    startedAt: client.lastOperationReceipt().startedAt,
    updatedAt: client.lastOperationReceipt().updatedAt
  });
});

test('operation receipt 將 conflict、lease、authority 與 session invalid 分類成明確狀態', async () => {
  const authorityEvents = [];
  const directAuthorityClient = new MonthlyV7Client({
    transport: { async rpc() { return { ok: false, error: 'AUTHORITY_NOT_ACTIVE', authorityState: 'LEGACY_ACTIVE' }; } },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab-authority',
    operationIdFactory: () => '00000000-0000-4000-8000-000000000928',
    host: { onAuthorityFailure(info) { authorityEvents.push(info); } }
  });
  directAuthorityClient.status = { mode: 'v7' };
  directAuthorityClient.config = { workspaceKey: 'workspace-test' };
  directAuthorityClient.siteSession = { id: 'site-current' };
  directAuthorityClient.userSession = { id: 'session-current' };
  directAuthorityClient.user = { id: 'u-current' };
  await directAuthorityClient.executeOperation(
    'monthly_v7_delete_user',
    { p_workspace_key: 'workspace-test', p_user_session_id: 'session-current' },
    'delete_user:authority',
    { saveOrigin: 'manual' }
  );
  assert.deepEqual(authorityEvents, [{
    code: 'AUTHORITY_NOT_ACTIVE',
    rpcName: 'monthly_v7_delete_user',
    authorityState: 'LEGACY_ACTIVE'
  }]);

  const responseCases = [
    ['REVISION_CONFLICT', 'REVISION_CONFLICT_BLOCKED'],
    ['LEASE_LOST', 'LEASE_LOST_BLOCKED'],
    ['AUTHORITY_CHANGED', 'AUTHORITY_CHANGED_BLOCKED'],
    ['AUTHORITY_NOT_ACTIVE', 'AUTHORITY_CHANGED_BLOCKED']
  ];
  for (const [code, state] of responseCases) {
    const client = new MonthlyV7Client({
      transport: { async rpc() { return { ok: false, error: code }; } },
      sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
      idFactory: () => 'tab-current',
      operationIdFactory: () => `00000000-0000-4000-8000-${code.length.toString().padStart(12, '0')}`
    });
    client.status = { mode: 'v7' };
    client.config = { workspaceKey: 'workspace-test' };
    client.siteSession = { id: 'site-current' };
    client.userSession = { id: 'session-current' };
    client.user = { id: 'u-current' };

    const result = await client.executeOperation(
      'monthly_v7_save_module',
      { p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_payload: { title: code } },
      `save_module:${code}`,
      { saveOrigin: 'autosave' }
    );

    assert.equal(result.error, code);
    assert.equal(client.lastOperationReceipt().state, state);
    assert.equal(client.lastOperationReceipt().errorCode, code);
    assert.equal(client.lastOperationReceipt().saveOrigin, 'autosave');
  }

  const drafts = memoryStorage();
  const sessionClient = new MonthlyV7Client({
    transport: {
      async rpc() {
        const error = new Error('USER_SESSION_INVALID');
        error.code = 'USER_SESSION_INVALID';
        throw error;
      }
    },
    sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-current',
    operationIdFactory: () => '00000000-0000-4000-8000-000000000923'
  });
  sessionClient.status = { mode: 'v7' };
  sessionClient.config = { workspaceKey: 'workspace-test' };
  sessionClient.siteSession = { id: 'site-current' };
  sessionClient.userSession = { id: 'session-current' };
  sessionClient.user = { id: 'u-current' };

  await assert.rejects(
    sessionClient.executeOperation(
      'monthly_v7_save_module',
      { p_workspace_key: 'workspace-test', p_user_session_id: 'session-current', p_payload: { title: 'session' } },
      'save_module:session-invalid',
      { saveOrigin: 'manual' }
    ),
    (error) => sessionClient.sessionErrorCode(error) === 'USER_SESSION_INVALID'
  );
  assert.equal(sessionClient.lastOperationReceipt().state, 'SESSION_INVALID_LOCAL_ONLY');
  assert.equal(sessionClient.lastOperationReceipt().errorCode, 'USER_SESSION_INVALID');
  assert.equal(sessionClient.currentUser(), null);
  assert.equal(sessionClient.siteSession.id, 'site-current');
  assert.ok(drafts.getItem('monthly_v7_pending:save_module:session-invalid'));
});

test('SQLSTATE 55000 的 AUTHORITY_CHANGED exception 一次即全頁阻斷且不得重試', async () => {
  let calls = 0;
  const events = [];
  const drafts = memoryStorage();
  const client = new MonthlyV7Client({
    transport: {
      async rpc() {
        calls += 1;
        const error = new Error('AUTHORITY_CHANGED');
        error.code = '55000';
        error.details = 'AUTHORITY_CHANGED';
        throw error;
      }
    },
    sessionStorage: memoryStorage(), draftStorage: drafts,
    idFactory: () => 'tab-authority-exception',
    operationIdFactory: () => '00000000-0000-4000-8000-000000000929',
    host: { onAuthorityFailure(info) { events.push(info); } }
  });
  client.status = { mode: 'v7' };
  client.config = { workspaceKey: 'workspace-test' };
  client.siteSession = { id: 'site-current' };
  client.userSession = { id: 'session-current' };
  client.user = { id: 'u-current' };

  await assert.rejects(
    client.executeOperation(
      'monthly_v7_save_module',
      { p_workspace_key: 'workspace-test', p_user_session_id: 'session-current' },
      'save_module:authority-exception',
      { saveOrigin: 'autosave' }
    ),
    (error) => error.code === '55000' && error.message === 'AUTHORITY_CHANGED'
  );

  assert.equal(calls, 1);
  assert.equal(client.lastOperationReceipt().state, 'AUTHORITY_CHANGED_BLOCKED');
  assert.equal(client.lastOperationReceipt().errorCode, 'AUTHORITY_CHANGED');
  assert.deepEqual(events, [{
    code: 'AUTHORITY_CHANGED',
    rpcName: 'monthly_v7_save_module',
    authorityState: ''
  }]);
  assert.ok(drafts.getItem('monthly_v7_pending:save_module:authority-exception'));
  assert.doesNotMatch(JSON.stringify(events), /workspace-test|site-current|session-current/);
});

test('active save 的 lease 或 authority failure 進 blocked 後背景保存不再 dispatch', async () => {
  for (const [code, expectedState] of [
    ['LEASE_LOST', 'LEASE_LOST_BLOCKED'],
    ['AUTHORITY_CHANGED', 'AUTHORITY_CHANGED_BLOCKED'],
    ['AUTHORITY_NOT_ACTIVE', 'AUTHORITY_CHANGED_BLOCKED']
  ]) {
    const statuses = [];
    let saveCalls = 0;
    const app = new MonthlyV7BrowserApp({ transport: {} });
    app.status = { mode: 'v7' };
    app.setHost({ setStatus(text, kind) { statuses.push({ text, kind }); } });
    const baseline = { id: 'm1', revision: 1, payload: { title: '雲端原始內容' } };
    app.client = {
      snapshot: { report: { id: 'report-1', revision: 1 }, modules: [baseline], records: [] },
      isActive: () => true,
      isWriteReady: () => true,
      sessionErrorCode: () => '',
      currentUser: () => ({ id: 'u-current' }),
      currentReport: () => ({ id: 'report-1', revision: 1 }),
      modulePayload(item) { return { title: item.title }; },
      pendingOperationTargets: () => new Set(),
      hasPendingOperation: () => false,
      readDraft: () => ({
        entityType: 'module', entityId: 'm1', baseRevision: 1,
        payload: { title: '待保存本機內容' }
      }),
      clearDraft: () => {},
      getLease: () => null,
      async saveModule() { saveCalls += 1; return { ok: true }; }
    };
    app.clientHost().onConflict({
      entityType: 'module', entityId: 'm1',
      draft: { title: '待保存本機內容' },
      result: { ok: false, error: code }
    });

    const result = await app.persistReportData(
      [{ _v7Id: 'm1', _v7Revision: 1, title: '待保存本機內容' }],
      { saveOrigin: 'autosave' }
    );

    assert.equal(saveCalls, 0);
    assert.equal(result.localOnly, true);
    assert.equal(result.state, expectedState);
    assert.equal(app.isWriteFailureBlocked('module', 'm1'), true);
    assert.equal(statuses.at(-1).kind, 'error');
    assert.match(statuses.at(-1).text, code === 'LEASE_LOST' ? /編輯權.*失效/ : /authority.*變更/i);
  }
});

test('queue 內 AUTHORITY_NOT_ACTIVE 即使沒有 conflict callback 也建立全頁 blocker並阻止後續 dispatch', async () => {
  const statuses = [];
  let saveCalls = 0;
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.status = { mode: 'v7' };
  app.setHost({ setStatus(text, kind) { statuses.push({ text, kind }); } });
  app.client = {
    snapshot: {
      report: { id: 'report-1', revision: 1 },
      modules: [{ id: 'm1', revision: 1, payload: { title: '雲端原始內容' } }],
      records: []
    },
    isActive: () => true,
    isWriteReady: () => true,
    sessionErrorCode: () => '',
    currentUser: () => ({ id: 'u-current' }),
    currentReport: () => ({ id: 'report-1', revision: 1 }),
    modulePayload(item) { return { title: item.title }; },
    pendingOperationTargets: () => new Set(),
    hasPendingOperation: () => false,
    readDraft: () => ({
      entityType: 'module', entityId: 'm1', baseRevision: 1,
      payload: { title: '待保存本機內容' }
    }),
    clearDraft: () => {},
    getLease: () => null,
    async saveModule() { saveCalls += 1; return { ok: true }; }
  };
  const authorityError = Object.assign(new Error('AUTHORITY_NOT_ACTIVE'), {
    code: 'AUTHORITY_NOT_ACTIVE',
    result: { ok: false, error: 'AUTHORITY_NOT_ACTIVE' }
  });

  await assert.rejects(
    app.enqueue(async () => { throw authorityError; }, 'claim-module-lease', { saveOrigin: 'autosave' }),
    (error) => error.code === 'AUTHORITY_NOT_ACTIVE'
  );
  const result = await app.persistReportData(
    [{ _v7Id: 'm1', _v7Revision: 1, title: '待保存本機內容' }],
    { saveOrigin: 'autosave' }
  );

  assert.equal(saveCalls, 0);
  assert.equal(result.localOnly, true);
  assert.equal(result.state, 'AUTHORITY_CHANGED_BLOCKED');
  assert.equal(result.code, 'AUTHORITY_NOT_ACTIVE');
  assert.equal(app.isWriteFailureBlocked('module', 'm1'), true);
  assert.equal(statuses.at(-1).kind, 'error');
  assert.match(statuses.at(-1).text, /authority.*變更/i);
});

test('heartbeat lease lost 進唯讀 blocker，使用者重新取得 lease 後才解除', async () => {
  const statuses = [];
  const leases = new Map();
  let claimCalls = 0;
  const app = new MonthlyV7BrowserApp({ transport: {} });
  app.status = { mode: 'v7' };
  app.setHost({ setStatus(text, kind) { statuses.push({ text, kind }); } });
  app.client = {
    isActive: () => true,
    currentUser: () => ({ id: 'u-current' }),
    getLease(type, id) { return leases.get(`${type}:${id}`) || null; },
    async claimLease(type, id) {
      claimCalls += 1;
      const lease = { entityType: type, entityId: id, leaseId: 'lease-new', fencingToken: 2 };
      leases.set(`${type}:${id}`, lease);
      return lease;
    }
  };
  app.decorateEditorRows = () => {};
  app.decorateLease = () => {};

  app.clientHost().onLeaseLost({
    entityType: 'module', entityId: 'm1',
    lease: { leaseId: 'lease-old', fencingToken: 1 },
    result: { ok: false, error: 'LEASE_LOST' }
  });

  assert.equal(app.isWriteFailureBlocked('module', 'm1'), true);
  assert.equal(statuses.at(-1).kind, 'error');
  assert.match(statuses.at(-1).text, /編輯權.*失效/);

  await app.claimModule('m1');

  assert.equal(claimCalls, 1);
  assert.equal(app.isWriteFailureBlocked('module', 'm1'), false);
  assert.equal(app.client.getLease('module', 'm1').leaseId, 'lease-new');
});

test('operation receipt history 只保留最近 32 筆且回傳 clone', () => {
  const client = new MonthlyV7Client({
    transport: { async rpc() { return { ok: true }; } },
    sessionStorage: memoryStorage(), draftStorage: memoryStorage(),
    idFactory: () => 'tab-current'
  });
  for (let index = 1; index <= 33; index += 1) {
    client.setOperationReceipt({
      state: 'CLOUD_CONFIRMED',
      operationId: `operation-${index}`,
      rpcName: 'monthly_v7_save_module',
      pendingKey: `save_module:m${index}`
    });
  }

  const history = client.operationReceipts();
  assert.equal(history.length, 32);
  assert.equal(history[0].operationId, 'operation-2');
  assert.equal(history.at(-1).operationId, 'operation-33');
  history[0].state = 'MUTATED_BY_CALLER';
  history.push({ operationId: 'caller-only' });
  assert.equal(client.operationReceipts().length, 32);
  assert.equal(client.operationReceipts()[0].state, 'CLOUD_CONFIRMED');
});
