'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const ROOT = join(__dirname, '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function createLegacyDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create schema auth;
    create or replace function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v6.sql'), 'utf8'));
  const payload = {
    app: 'monthly-safety-report-system',
    version: 6,
    fileId: 'legacy-report',
    report: {
      title: '月度安全會議報告',
      date: '2026-08-10',
      period: { startM: '8', startD: '1', endM: '8', endD: '31' },
      modules: [
        { id: 1, title: '項目一', columns: ['A'], selectedForPdf: true, attachments: [] },
        { id: 2, title: '項目二', columns: ['B'], selectedForPdf: false, attachments: [] }
      ]
    },
    records: {
      inspections: [{ id: 101, vessel: 'TEST', date: '2026-08-01' }],
      deficiencies: [], detentions: [], actions: [], trainings: []
    },
    users: [
      { username: 'owner', displayName: 'Owner', role: 'owner', passwordHash: sha256('owner-pass') },
      { username: 'operator', displayName: 'Operator', role: 'operator', passwordHash: sha256('operator-pass') }
    ],
    siteAccess: { passwordHash: sha256('site-pass'), updatedAt: '2026-08-10T00:00:00Z' }
  };
  await db.query(
    `insert into public.monthly_report_cloud_data(workspace_key, payload, revision, updated_by)
     values ($1, $2::jsonb, 7, 'Owner')`,
    ['workspace-test', JSON.stringify(payload)]
  );
  return db;
}

async function applyV7(db) {
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7.sql'), 'utf8'));
}

async function setAuthUid(db, uid) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
}

function rpcResult(queryResult) {
  return queryResult.rows[0].result;
}

async function openAndLogin(db, uid, username, password, clientSessionId) {
  await setAuthUid(db, uid);
  const site = rpcResult(await db.query(
    'select public.monthly_v7_open_site($1,$2,$3) as result',
    ['workspace-test', 'site-pass', clientSessionId]
  ));
  const login = rpcResult(await db.query(
    'select public.monthly_v7_login_user($1,$2,$3,$4,$5) as result',
    ['workspace-test', site.site_session_id, username, password, clientSessionId]
  ));
  return { uid, site, login, clientSessionId };
}

test('V7 additive migration 將 V6 cloud bundle 拆成逐項 authority 並保留唯一 Owner', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    const modules = await db.query('select count(*)::int as count from public.monthly_v7_report_items');
    const records = await db.query('select count(*)::int as count from public.monthly_v7_record_items');
    const users = await db.query('select role, count(*)::int as count from public.monthly_v7_users group by role order by role');
    const receipt = (await db.query(`select report_sha256,module_sha256,record_sha256,user_sha256,site_sha256 from public.monthly_v7_migration_receipts`)).rows[0];
    assert.equal(modules.rows[0].count, 2);
    assert.equal(records.rows[0].count, 1);
    assert.deepEqual(users.rows, [{ role: 'operator', count: 1 }, { role: 'owner', count: 1 }]);
    Object.values(receipt).forEach((hash) => assert.match(hash, /^[a-f0-9]{64}$/));
  } finally {
    await db.close();
  }
});

test('V7 delete-module repair 可重跑且只保留雙 lease signature/ACL', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    const repair = await readFile(join(ROOT, 'docs', 'supabase-schema-v7-delete-module-repair.sql'), 'utf8');
    await db.exec(repair);
    await db.exec(repair);
    const contracts = (await db.query(`
      select
        to_regprocedure('public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint)') is null as old_removed,
        to_regprocedure('public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)') is not null as dual_installed,
        not has_function_privilege('anon', 'public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)', 'EXECUTE') as anon_blocked,
        has_function_privilege('authenticated', 'public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)', 'EXECUTE') as authenticated_allowed
    `)).rows[0];
    assert.deepEqual(contracts, { old_removed: true, dual_installed: true, anon_blocked: true, authenticated_allowed: true });
  } finally {
    await db.close();
  }
});

test('V7 site/user session 驗證後只回傳安全 snapshot，並升級 legacy SHA-256', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await setAuthUid(db, '11111111-1111-4111-8111-111111111111');
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-a']
    ));
    assert.equal(site.ok, true);
    const login = rpcResult(await db.query(
      'select public.monthly_v7_login_user($1,$2,$3,$4,$5) as result',
      ['workspace-test', site.site_session_id, 'owner', 'owner-pass', 'tab-a']
    ));
    assert.equal(login.ok, true);
    assert.equal(login.user.role, 'owner');
    const snapshot = rpcResult(await db.query(
      'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, login.user_session_id]
    ));
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.modules.length, 2);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.users.length, 2);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(sha256('owner-pass')), false);
    assert.equal(serialized.includes(sha256('site-pass')), false);
    assert.equal(serialized.includes('password_hash'), false);
    const schemes = await db.query(`
      select 'site' as kind, password_scheme from public.monthly_v7_site_access
      union all
      select 'user' as kind, password_scheme from public.monthly_v7_users where username = 'owner'
      order by kind
    `);
    assert.deepEqual(schemes.rows, [
      { kind: 'site', password_scheme: 'bcrypt' },
      { kind: 'user', password_scheme: 'bcrypt' }
    ]);
    const logout = rpcResult(await db.query(
      'select public.monthly_v7_logout($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, login.user_session_id]
    ));
    assert.equal(logout.ok, true);
    await assert.rejects(
      () => db.query('select public.monthly_v7_get_snapshot($1,$2,$3) as result', ['workspace-test', site.site_session_id, login.user_session_id]),
      /SITE_SESSION_INVALID/
    );
  } finally {
    await db.close();
  }
});

test('V7 module lease 支援不同項目並行、同項排他、冪等重送與 fencing 接管', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const itemRows = await db.query(`select id, revision, payload from public.monthly_v7_report_items order by sort_rank`);
    const [itemA, itemB] = itemRows.rows;

    await setAuthUid(db, a.uid);
    const leaseA = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', itemA.id, 90]
    ));
    assert.equal(leaseA.ok, true);

    await setAuthUid(db, b.uid);
    const deniedB = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', itemA.id, 90]
    ));
    assert.equal(deniedB.ok, false);
    assert.equal(deniedB.error, 'LEASE_HELD');
    const leaseB = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', itemB.id, 90]
    ));
    assert.equal(leaseB.ok, true);

    await setAuthUid(db, a.uid);
    const opA = randomUUID();
    const saveA = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, opA, itemA.id, itemA.revision, leaseA.lease_id, leaseA.fencing_token, JSON.stringify({ ...itemA.payload, title: 'A 已更新' })]
    ));
    assert.equal(saveA.ok, true);
    assert.equal(saveA.revision, itemA.revision + 1);
    const replayA = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, opA, itemA.id, itemA.revision, leaseA.lease_id, leaseA.fencing_token, JSON.stringify({ ...itemA.payload, title: 'A 已更新' })]
    ));
    assert.deepEqual(replayA, saveA);

    await setAuthUid(db, b.uid);
    const saveB = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), itemB.id, itemB.revision, leaseB.lease_id, leaseB.fencing_token, JSON.stringify({ ...itemB.payload, title: 'B 已更新' })]
    ));
    assert.equal(saveB.ok, true);

    await db.query(`update public.monthly_v7_entity_leases set expires_at = now() - interval '1 second' where entity_id = $1`, [itemA.id]);
    const takeover = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', itemA.id, 90]
    ));
    assert.equal(takeover.ok, true);
    assert.ok(takeover.fencing_token > leaseA.fencing_token);

    await setAuthUid(db, a.uid);
    const stale = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), itemA.id, saveA.revision, leaseA.lease_id, leaseA.fencing_token, JSON.stringify({ ...itemA.payload, title: '舊分頁不可寫入' })]
    ));
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'LEASE_LOST');
    const finalRows = await db.query(`select id, revision, payload->>'title' as title from public.monthly_v7_report_items order by sort_rank`);
    assert.deepEqual(finalRows.rows, [
      { id: itemA.id, revision: itemA.revision + 1, title: 'A 已更新' },
      { id: itemB.id, revision: itemB.revision + 1, title: 'B 已更新' }
    ]);
    const operations = await db.query(`select count(*)::int as count from public.monthly_v7_operations where status='COMMITTED'`);
    assert.equal(operations.rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test('V7 records 逐筆新增、鎖定、CAS 更新與持久軟刪除互不覆寫', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const existing = (await db.query(`select id, revision, payload from public.monthly_v7_record_items where record_type='inspections'`)).rows[0];

    await setAuthUid(db, b.uid);
    const created = rpcResult(await db.query(
      'select public.monthly_v7_create_record($1,$2,$3,$4,$5,$6::jsonb) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), 'actions', JSON.stringify({ vessel: 'B-SHIP', action: '追蹤' })]
    ));
    assert.equal(created.ok, true);
    assert.equal(created.revision, 1);

    await setAuthUid(db, a.uid);
    const leaseA = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'record:inspections', existing.id, 90]
    ));
    const savedA = rpcResult(await db.query(
      'select public.monthly_v7_save_record($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), existing.id, existing.revision, leaseA.lease_id, leaseA.fencing_token, JSON.stringify({ ...existing.payload, vessel: 'A-SHIP' })]
    ));
    assert.equal(savedA.ok, true);

    await setAuthUid(db, b.uid);
    const leaseB = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'record:actions', created.entityId, 90]
    ));
    const savedB = rpcResult(await db.query(
      'select public.monthly_v7_save_record($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), created.entityId, 1, leaseB.lease_id, leaseB.fencing_token, JSON.stringify({ vessel: 'B-SHIP', action: '已完成' })]
    ));
    assert.equal(savedB.ok, true);

    await setAuthUid(db, a.uid);
    const deleteLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'record:inspections', existing.id, 90]
    ));
    const deleted = rpcResult(await db.query(
      'select public.monthly_v7_delete_record($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), existing.id, savedA.revision, deleteLease.lease_id, deleteLease.fencing_token]
    ));
    assert.equal(deleted.ok, true);
    const persisted = await db.query(`select deleted_at is not null as deleted from public.monthly_v7_record_items where id=$1`, [existing.id]);
    assert.equal(persisted.rows[0].deleted, true);
    const survivor = await db.query(`select revision, payload->>'action' as action from public.monthly_v7_record_items where id=$1`, [created.entityId]);
    assert.deepEqual(survivor.rows[0], { revision: 2, action: '已完成' });

    const snapshot = rpcResult(await db.query(
      'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id]
    ));
    assert.equal(snapshot.records.some((row) => row.id === existing.id), false);
    assert.equal(snapshot.records.some((row) => row.id === created.entityId), true);
  } finally {
    await db.close();
  }
});

test('V7 change sequence 可補抓漏訊息，事件不帶 payload 並支援逐項重讀', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const item = (await db.query(`select id,revision,payload from public.monthly_v7_report_items order by sort_rank limit 1`)).rows[0];
    const lease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', item.id, 90]
    ));
    const saved = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), item.id, item.revision, lease.lease_id, lease.fencing_token, JSON.stringify({ ...item.payload, title: 'sequence-test' })]
    ));
    assert.equal(saved.ok, true);
    const changes = rpcResult(await db.query(
      'select public.monthly_v7_get_changes_since($1,$2,$3,$4,$5) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, 0, 100]
    ));
    assert.equal(changes.ok, true);
    assert.ok(changes.watermark > 0);
    assert.equal(changes.events.some((event) => event.entityId === item.id), true);
    assert.equal(JSON.stringify(changes).includes('sequence-test'), false);
    const entity = rpcResult(await db.query(
      'select public.monthly_v7_get_entity($1,$2,$3,$4,$5) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, 'module', item.id]
    ));
    assert.equal(entity.ok, true);
    assert.equal(entity.payload.title, 'sequence-test');
    assert.equal(entity.revision, item.revision + 1);
    const noChanges = rpcResult(await db.query(
      'select public.monthly_v7_get_changes_since($1,$2,$3,$4,$5) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, changes.watermark, 100]
    ));
    assert.deepEqual(noChanges.events, []);
    const snapshot = rpcResult(await db.query(
      'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id]
    ));
    assert.equal(snapshot.watermark, changes.watermark);
  } finally {
    await db.close();
  }
});

test('V7 activate 先最終遷移再切 authority，切換後伺服器阻斷所有 V6 舊分頁讀寫', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    const legacy = (await db.query(`select payload,revision from public.monthly_report_cloud_data where workspace_key='workspace-test'`)).rows[0];
    const newerPayload = { ...legacy.payload, report: { ...legacy.payload.report, title: '切換前最後版本' } };
    const legacySave = rpcResult(await db.query(
      'select public.upsert_monthly_report_cloud_data($1,$2::jsonb,$3,$4) as result',
      ['workspace-test', JSON.stringify(newerPayload), legacy.revision, 'Owner']
    ));
    assert.equal(legacySave.ok, true);
    assert.equal(legacySave.revision, legacy.revision + 1);

    const activate = await readFile(join(ROOT, 'docs', 'supabase-schema-v7-activate.sql'), 'utf8');
    await db.exec(activate);
    const status = rpcResult(await db.query(`select public.monthly_v7_get_status('workspace-test') as result`));
    assert.equal(status.authority_state, 'NORMALIZED_ACTIVE');
    assert.equal(status.minimum_client_version, 7);
    const legacyAcl = (await db.query(`
      select
        has_function_privilege('anon', 'public.get_monthly_report_cloud_data(text)', 'EXECUTE') as anon_read,
        has_function_privilege('anon', 'public.upsert_monthly_report_cloud_data(text,jsonb,bigint,text)', 'EXECUTE') as anon_write,
        has_function_privilege('authenticated', 'public.get_monthly_report_cloud_data(text)', 'EXECUTE') as authenticated_read,
        has_function_privilege('authenticated', 'public.upsert_monthly_report_cloud_data(text,jsonb,bigint,text)', 'EXECUTE') as authenticated_write
    `)).rows[0];
    assert.deepEqual(legacyAcl, {
      anon_read: false,
      anon_write: false,
      authenticated_read: false,
      authenticated_write: false
    });
    const report = (await db.query(`select title from public.monthly_v7_reports`)).rows[0];
    assert.equal(report.title, '切換前最後版本');

    await assert.rejects(
      db.query(
        'select public.upsert_monthly_report_cloud_data($1,$2::jsonb,$3,$4) as result',
        ['workspace-test', JSON.stringify({ ...newerPayload, report: { ...newerPayload.report, title: '舊分頁覆寫' } }), legacySave.revision, 'Owner']
      ),
      /AUTHORITY_CHANGED/
    );
    await assert.rejects(
      db.query(`select public.get_monthly_report_cloud_data('workspace-test') as result`),
      /AUTHORITY_CHANGED/
    );
    const unchanged = (await db.query(`select title from public.monthly_v7_reports`)).rows[0];
    assert.equal(unchanged.title, '切換前最後版本');
  } finally {
    await db.close();
  }
});

test('V7 report metadata、structure 與 KPI batch 使用短 lease 且批次全成或全不成', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const report = (await db.query(`select * from public.monthly_v7_reports`)).rows[0];

    const metaLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'report_meta', report.id, 90]
    ));
    const meta = rpcResult(await db.query(
      'select public.monthly_v7_save_report_meta($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), report.id, report.revision, metaLease.lease_id, metaLease.fencing_token, '新標題', '2026-08-31', JSON.stringify({ startM: '8', startD: '1', endM: '8', endD: '31' }), JSON.stringify({ fontFamily: 'Noto Sans TC' })]
    ));
    assert.equal(meta.ok, true);

    const structureLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'report_structure', report.id, 90]
    ));
    const created = rpcResult(await db.query(
      'select public.monthly_v7_create_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), report.id, meta.revision, structureLease.lease_id, structureLease.fencing_token, JSON.stringify({ title: '新增項目', columns: ['內容'], selectedForPdf: true })]
    ));
    assert.equal(created.ok, true);

    const rows = (await db.query(`select id,revision,payload from public.monthly_v7_report_items where deleted_at is null order by sort_rank`)).rows;
    const batchLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'kpi_batch', report.id, 90]
    ));
    const changes = rows.map((row, index) => ({ moduleId: row.id, expectedRevision: row.revision, payload: { ...row.payload, kpiValue: index + 1 } }));
    const batch = rpcResult(await db.query(
      'select public.monthly_v7_save_module_batch($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), report.id, batchLease.lease_id, batchLease.fencing_token, JSON.stringify(changes)]
    ));
    assert.equal(batch.ok, true);
    assert.equal(batch.updated.length, rows.length);

    const staleLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'kpi_batch', report.id, 90]
    ));
    const beforeFailedBatch = (await db.query(`select id,revision,payload from public.monthly_v7_report_items where deleted_at is null order by id`)).rows;
    const staleChanges = beforeFailedBatch.map((row, index) => ({
      moduleId: row.id,
      expectedRevision: index === 0 ? row.revision - 1 : row.revision,
      payload: { ...row.payload, kpiValue: 999 }
    }));
    const rejected = rpcResult(await db.query(
      'select public.monthly_v7_save_module_batch($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), report.id, staleLease.lease_id, staleLease.fencing_token, JSON.stringify(staleChanges)]
    ));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'REVISION_CONFLICT');
    const afterFailedBatch = (await db.query(`select id,revision,payload from public.monthly_v7_report_items where deleted_at is null order by id`)).rows;
    assert.deepEqual(afterFailedBatch, beforeFailedBatch);
  } finally {
    await db.close();
  }
});

test('V7 使用者與進站密碼由伺服器權限管理，Admin 不可碰 Owner 且密碼更新撤銷舊 sessions', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const owner = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-owner');
    const ownerId = owner.login.user.id;
    const adminCreated = rpcResult(await db.query(
      'select public.monthly_v7_create_user($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), 'admin1', '管理員一', 'admin', 'admin-pass']
    ));
    assert.equal(adminCreated.ok, true);

    const admin = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'admin1', 'admin-pass', 'tab-admin');
    const forbidden = rpcResult(await db.query(
      'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), ownerId, 'owner', 'Owner 被竄改', 'owner', null]
    ));
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, 'FORBIDDEN');
    const operatorCreated = rpcResult(await db.query(
      'select public.monthly_v7_create_user($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), 'operator2', '操作員二', 'operator', 'operator2-pass']
    ));
    assert.equal(operatorCreated.ok, true);

    const siteChanged = rpcResult(await db.query(
      'select public.monthly_v7_update_site_password($1,$2,$3,$4,$5) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), 'new-site-pass']
    ));
    assert.equal(siteChanged.ok, true);
    assert.equal(siteChanged.requiresReauth, true);
    await assert.rejects(
      db.query(
        'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
        ['workspace-test', owner.site.site_session_id, owner.login.user_session_id]
      ),
      /SITE_SESSION_INVALID/
    );
    await setAuthUid(db, '33333333-3333-4333-8333-333333333333');
    await assert.rejects(
      db.query('select public.monthly_v7_open_site($1,$2,$3) as result', ['workspace-test', 'site-pass', 'tab-old-pass']),
      /INVALID_CREDENTIALS/
    );
    const newSite = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'new-site-pass', 'tab-new-pass']
    ));
    assert.equal(newSite.ok, true);
    const users = await db.query(`select username,display_name,role,active from public.monthly_v7_users order by username`);
    assert.equal(users.rows.find((user) => user.username === 'owner').display_name, 'Owner');
    assert.equal(users.rows.find((user) => user.username === 'operator2').role, 'operator');
  } finally {
    await db.close();
  }
});

test('V7 正式 PDF/history snapshot 在短 barrier 內建立且後續 live 寫入不改變舊內容', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const report = (await db.query(`select id from public.monthly_v7_reports`)).rows[0];
    const before = rpcResult(await db.query(
      'select public.monthly_v7_create_report_snapshot($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, randomUUID(), report.id, 'pdf']
    ));
    assert.equal(before.ok, true);
    assert.equal(before.snapshot.modules[0].payload.title, '項目一');
    assert.equal(JSON.stringify(before.snapshot).includes('password'), false);

    const item = (await db.query(`select id,revision,payload from public.monthly_v7_report_items order by sort_rank limit 1`)).rows[0];
    const lease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', item.id, 90]
    ));
    const saved = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), item.id, item.revision, lease.lease_id, lease.fencing_token, JSON.stringify({ ...item.payload, title: 'snapshot 後修改' })]
    ));
    assert.equal(saved.ok, true);
    const stored = rpcResult(await db.query(
      'select public.monthly_v7_get_report_snapshot($1,$2,$3,$4) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, before.snapshotId]
    ));
    assert.equal(stored.snapshot.modules[0].payload.title, '項目一');
    assert.equal(stored.contentSha256, before.contentSha256);
    const live = (await db.query(`select payload->>'title' as title from public.monthly_v7_report_items where id=$1`, [item.id])).rows[0];
    assert.equal(live.title, 'snapshot 後修改');
  } finally {
    await db.close();
  }
});

test('V7 lease renew/release、module reorder/delete 都由伺服器 transaction 控制', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const report = (await db.query(`select id,revision from public.monthly_v7_reports`)).rows[0];
    const modules = (await db.query(`select id,revision from public.monthly_v7_report_items where deleted_at is null order by sort_rank`)).rows;

    await setAuthUid(db, a.uid);
    const leaseA = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', modules[0].id, 60]
    ));
    const renewed = rpcResult(await db.query(
      'select public.monthly_v7_renew_lease($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', modules[0].id, leaseA.lease_id, leaseA.fencing_token, 120]
    ));
    assert.equal(renewed.lease_id, leaseA.lease_id);
    assert.equal(renewed.fencing_token, leaseA.fencing_token);
    const released = rpcResult(await db.query(
      'select public.monthly_v7_release_lease($1,$2,$3,$4,$5,$6,$7) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', modules[0].id, leaseA.lease_id, leaseA.fencing_token]
    ));
    assert.equal(released.ok, true);

    await setAuthUid(db, b.uid);
    const leaseB = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', modules[0].id, 90]
    ));
    assert.ok(leaseB.fencing_token > leaseA.fencing_token);
    await db.query(
      'select public.monthly_v7_release_lease($1,$2,$3,$4,$5,$6,$7)',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', modules[0].id, leaseB.lease_id, leaseB.fencing_token]
    );

    const structureLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'report_structure', report.id, 90]
    ));
    const reordered = rpcResult(await db.query(
      'select public.monthly_v7_reorder_modules($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), report.id, report.revision, structureLease.lease_id, structureLease.fencing_token, JSON.stringify(modules.map((row) => row.id).reverse())]
    ));
    assert.equal(reordered.ok, true);
    const order = (await db.query(`select id from public.monthly_v7_report_items where deleted_at is null order by sort_rank`)).rows.map((row) => row.id);
    assert.deepEqual(order, modules.map((row) => row.id).reverse());

    const deleteTarget = (await db.query(`select id,revision from public.monthly_v7_report_items where deleted_at is null order by sort_rank limit 1`)).rows[0];
    const deleteLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'module', deleteTarget.id, 90]
    ));
    const missingStructure = rpcResult(await db.query(
      'select public.monthly_v7_delete_module($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), deleteTarget.id, deleteTarget.revision, reordered.reportRevision, randomUUID(), 999, deleteLease.lease_id, deleteLease.fencing_token]
    ));
    assert.equal(missingStructure.ok, false);
    assert.equal(missingStructure.error, 'LEASE_LOST');
    const deleteStructureLease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'report_structure', report.id, 90]
    ));
    const deleteOperationId = randomUUID();
    const deleteArgs = ['workspace-test', b.login.user_session_id, b.clientSessionId, deleteOperationId, deleteTarget.id, deleteTarget.revision, reordered.reportRevision, deleteStructureLease.lease_id, deleteStructureLease.fencing_token, deleteLease.lease_id, deleteLease.fencing_token];
    const deleted = rpcResult(await db.query(
      'select public.monthly_v7_delete_module($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',
      deleteArgs
    ));
    assert.equal(deleted.ok, true);
    const replayed = rpcResult(await db.query(
      'select public.monthly_v7_delete_module($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',
      deleteArgs
    ));
    assert.deepEqual(replayed, deleted);
    const persisted = await db.query(`select deleted_at is not null as deleted from public.monthly_v7_report_items where id=$1`, [deleteTarget.id]);
    assert.equal(persisted.rows[0].deleted, true);
  } finally {
    await db.close();
  }
});

test('V7 authenticated 只能讀有有效 site session 的 change hints，不能直接讀業務 authority 表', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const owner = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'owner-tab');
    const module = (await db.query(`select id, revision from public.monthly_v7_report_items order by sort_rank limit 1`)).rows[0];
    const lease = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', owner.login.user_session_id, 'owner-tab', 'module', module.id, 90]
    ));
    rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', owner.login.user_session_id, 'owner-tab', randomUUID(), module.id, module.revision, lease.lease_id, lease.fencing_token, { title: 'RLS hint' }]
    ));

    await setAuthUid(db, '11111111-1111-4111-8111-111111111111');
    await db.exec(`set role authenticated`);
    const hints = await db.query(`select entity_type, entity_id, sequence from public.monthly_v7_change_events`);
    assert.equal(hints.rows.length, 1);
    await assert.rejects(() => db.query(`select * from public.monthly_v7_report_items`), /permission denied|row-level security/i);
    await db.exec(`reset role`);
  } finally {
    try { await db.exec(`reset role`); } catch {}
    await db.close();
  }
});
