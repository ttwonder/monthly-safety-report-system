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

test('claimLease 被占用時帶出持鎖者顯示名稱，不暴露 LEASE_HELD 技術碼', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

test('logoutUser server 回 ok false 時上拋未確認狀態，但仍清本頁 user 且保留 site/草稿', async () => {
  const sessions = memoryStorage();
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authorityState: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
    monthly_v7_open_site: { ok: true, site_session_id: 'site-new' }
  });
  const client = new MonthlyV7Client({ transport, sessionStorage: sessions, draftStorage: memoryStorage() });
  await client.initialize({ workspaceKey: 'workspace-test' });
  assert.equal(client.currentUser().username, 'owner');

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
    transport: fakeTransport({ monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' } }),
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    transport, sessionStorage: memoryStorage(), draftStorage: drafts, idFactory: () => 'tab-1'
  });
  await client.initialize({ workspaceKey: 'workspace-test' });
  await client.openSite('gate');
  await client.login('owner', 'pass');

  assert.equal(client.snapshot.modules[0].payload.title, '本機待救回');
  assert.deepEqual(client.snapshot.modules[0].payload.columns, ['本機內容']);
  assert.equal(client.snapshot.modules[0].revision, 3);
  assert.ok(client.readDraft('module', 'm1'));
});

test('saveModule 以 lease/fence/CAS 保存，失鎖保留草稿且成功後才清除', async () => {
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

test('saveModuleBatch 成功後逐筆釋放原先持有的 module lease', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
  assert.deepEqual(releases.map((call) => `${call.params.p_entity_type}:${call.params.p_entity_id}`).sort(), ['module:m1', 'module:m2']);
  assert.equal(client.getLease('module', 'm1'), null);
  assert.equal(client.getLease('module', 'm2'), null);
});

test('saveModuleBatch 有 pending 時先重播舊 operation，不先 claim 目前 batch lease', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
});

test('saveModuleBatch 舊 operation 回 LEASE_LOST 後才 claim 並只送一個新 operation', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000795';
  const newOperationId = '00000000-0000-4000-8000-000000000796';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

test('saveModule 舊 operation 回傳 COMMITTED 時釋放已存在的目前 lease', async () => {
  const drafts = memoryStorage();
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

  assert.deepEqual(transport.calls.map((call) => call.name), ['monthly_v7_save_module', 'monthly_v7_release_lease']);
  assert.equal(transport.calls[1].params.p_lease_id, 'lease-current');
  assert.equal(client.getLease('module', 'm1'), null);
});

test('相同保存內容只在 session 更新時沿用 pending operation ID 並以目前憑證重送', async () => {
  const drafts = memoryStorage();
  const operationId = '00000000-0000-4000-8000-000000000778';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

test('report metadata、structure 與 KPI batch 使用各自短 lease 並更新 server revisions', async () => {
  let claimFence = 0;
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
  const created = await client.createModule({ title: 'B', columns: [''] });
  assert.equal(created._v7Id, 'm2');
  assert.equal(client.currentReport().revision, 3);
  const first = { _v7Id: 'm1', _v7Revision: 1, title: 'A2' };
  await client.reorderModules([created, first]);
  assert.equal(client.currentReport().revision, 4);
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
      monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

test('user 管理、正式 snapshot 與 site password rotation 走 server RPC 並撤銷本頁 sessions', async () => {
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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

test('batch superseding drafts 先整批對帳 A，再以新 operation 整批保存 B', async () => {
  const drafts = memoryStorage();
  const oldOperationId = '00000000-0000-4000-8000-000000000883';
  const newOperationId = '00000000-0000-4000-8000-000000000884';
  const transport = fakeTransport({
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
    monthly_v7_get_status: { ok: true, authority_state: 'NORMALIZED_ACTIVE' },
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
