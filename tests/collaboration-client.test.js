'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonthlyV7Client } = require('../monthly-collaboration-client.js');
const { MonthlyV7BrowserApp } = require('../monthly-collaboration-v7.js');

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
  assert.deepEqual(claimTypes, ['report_meta', 'report_structure', 'report_structure', 'kpi_batch', 'module']);
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
  await client.updateSitePassword('new-gate-pass');
  assert.equal(client.isSiteUnlocked(), false);
  assert.equal(client.currentUser(), null);
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
