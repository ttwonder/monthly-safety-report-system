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

async function applyTrustedDeviceResume(db) {
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-trusted-device-resume.sql'), 'utf8'));
}

async function applyDataManagement(db) {
  await applyV7(db);
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-delete-module-repair.sql'), 'utf8'));
  await applyTrustedDeviceResume(db);
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-topic-reports.sql'), 'utf8'));
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-topic-reports-v2.sql'), 'utf8'));
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-data-management-storage.sql'), 'utf8'));
}

async function activateNormalizedAuthority(db) {
  await db.exec(`
    update public.monthly_v7_workspaces
    set authority_state='NORMALIZED_ACTIVE',minimum_client_version=7
  `);
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

test('V7 user-only logout 撤銷 user session 但保留 site session 可重新登入', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const session = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-user-logout');
    const acl = (await db.query(`
      select
        not has_function_privilege('anon', 'public.monthly_v7_logout_user(text,uuid,uuid)', 'EXECUTE') as anon_blocked,
        has_function_privilege('authenticated', 'public.monthly_v7_logout_user(text,uuid,uuid)', 'EXECUTE') as authenticated_allowed
    `)).rows[0];
    assert.deepEqual(acl, { anon_blocked: true, authenticated_allowed: true });

    const result = rpcResult(await db.query(
      'select public.monthly_v7_logout_user($1,$2,$3) as result',
      ['workspace-test', session.site.site_session_id, session.login.user_session_id]
    ));
    assert.equal(result.ok, true);
    assert.equal(result.revoked, true);

    await assert.rejects(
      () => db.query(
        'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
        ['workspace-test', session.site.site_session_id, session.login.user_session_id]
      ),
      /USER_SESSION_INVALID/
    );
    const siteOnly = rpcResult(await db.query(
      'select public.monthly_v7_get_snapshot($1,$2,$3::uuid) as result',
      ['workspace-test', session.site.site_session_id, null]
    ));
    assert.equal(siteOnly.ok, true);
    const relogin = rpcResult(await db.query(
      'select public.monthly_v7_login_user($1,$2,$3,$4,$5) as result',
      ['workspace-test', session.site.site_session_id, 'owner', 'owner-pass', 'tab-user-logout']
    ));
    assert.equal(relogin.ok, true);
    assert.notEqual(relogin.user_session_id, session.login.user_session_id);
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
    const retainedLease = (await db.query(`
      select lease_id, fencing_token, expires_at > now() as active,
        extract(epoch from (expires_at - now()))::int as remaining_seconds
      from public.monthly_v7_entity_leases
      where entity_type = 'module' and entity_id = $1
    `, [itemA.id])).rows[0];
    assert.equal(retainedLease.lease_id, leaseA.lease_id);
    assert.equal(retainedLease.fencing_token, leaseA.fencing_token);
    assert.equal(retainedLease.active, true);
    assert.ok(retainedLease.remaining_seconds >= 80, `remaining_seconds=${retainedLease.remaining_seconds}`);

    await db.query(`
      update public.monthly_v7_entity_leases
      set expires_at = now() + interval '5 seconds'
      where entity_type = 'module' and entity_id = $1
    `, [itemA.id]);
    const replayA = rpcResult(await db.query(
      'select public.monthly_v7_save_module($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, opA, itemA.id, itemA.revision, leaseA.lease_id, leaseA.fencing_token, JSON.stringify({ ...itemA.payload, title: 'A 已更新' })]
    ));
    assert.deepEqual(replayA, saveA);
    const replayRetainedLease = (await db.query(`
      select lease_id, fencing_token,
        extract(epoch from (expires_at - now()))::int as remaining_seconds
      from public.monthly_v7_entity_leases
      where entity_type = 'module' and entity_id = $1
    `, [itemA.id])).rows[0];
    assert.equal(replayRetainedLease.lease_id, leaseA.lease_id);
    assert.equal(replayRetainedLease.fencing_token, leaseA.fencing_token);
    assert.ok(replayRetainedLease.remaining_seconds >= 80,
      `COMMITTED replay remaining_seconds=${replayRetainedLease.remaining_seconds}`);

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

test('V7 batch 不得繞過其他使用者仍有效的 module lease', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-batch-leaf-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-batch-leaf-b');
    const item = (await db.query(`select id, revision, payload from public.monthly_v7_report_items order by sort_rank limit 1`)).rows[0];
    const report = (await db.query(`select id from public.monthly_v7_reports where deleted_at is null limit 1`)).rows[0];

    await setAuthUid(db, a.uid);
    const moduleLeaseA = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'module', item.id, 90]
    ));
    assert.equal(moduleLeaseA.ok, true);

    await setAuthUid(db, b.uid);
    const batchLeaseB = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'kpi_batch', report.id, 90]
    ));
    assert.equal(batchLeaseB.ok, true);
    const eventsBefore = (await db.query(`select count(*)::int as count from public.monthly_v7_entity_events`)).rows[0].count;
    const batch = rpcResult(await db.query(
      'select public.monthly_v7_save_module_batch($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, randomUUID(), report.id,
        batchLeaseB.lease_id, batchLeaseB.fencing_token, JSON.stringify([{
          moduleId: item.id,
          expectedRevision: item.revision,
          payload: { ...item.payload, title: 'B 不得覆寫 A 正在編輯的項目' }
        }])]
    ));

    assert.equal(batch.ok, false);
    assert.equal(batch.error, 'LEASE_HELD');
    assert.equal(batch.entityId, item.id);
    const after = (await db.query(`select revision, payload from public.monthly_v7_report_items where id=$1`, [item.id])).rows[0];
    assert.equal(after.revision, item.revision);
    assert.deepEqual(after.payload, item.payload);
    const eventsAfter = (await db.query(`select count(*)::int as count from public.monthly_v7_entity_events`)).rows[0].count;
    assert.equal(eventsAfter, eventsBefore);
    const retained = (await db.query(`
      select lease_id, holder_user_session_id, expires_at > now() as active
      from public.monthly_v7_entity_leases
      where entity_type='module' and entity_id=$1
    `, [item.id])).rows[0];
    assert.equal(retained.lease_id, moduleLeaseA.lease_id);
    assert.equal(retained.holder_user_session_id, a.login.user_session_id);
    assert.equal(retained.active, true);

    const releasedBatchB = rpcResult(await db.query(
      'select public.monthly_v7_release_lease($1,$2,$3,$4,$5,$6,$7) as result',
      ['workspace-test', b.login.user_session_id, b.clientSessionId, 'kpi_batch', report.id,
        batchLeaseB.lease_id, batchLeaseB.fencing_token]
    ));
    assert.equal(releasedBatchB.ok, true);

    await setAuthUid(db, a.uid);
    const batchLeaseA = rpcResult(await db.query(
      'select public.monthly_v7_claim_lease($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, 'kpi_batch', report.id, 90]
    ));
    assert.equal(batchLeaseA.ok, true);
    await db.query(`
      update public.monthly_v7_entity_leases
      set expires_at = now() + interval '5 seconds'
      where (entity_type='module' and entity_id=$1)
         or (entity_type='kpi_batch' and entity_id=$2)
    `, [item.id, report.id]);
    const ownBatchOperationId = randomUUID();
    const ownBatchChanges = [{
      moduleId: item.id,
      expectedRevision: item.revision,
      payload: { ...item.payload, title: 'A 自己的背景 batch 可保存' }
    }];
    const ownBatch = rpcResult(await db.query(
      'select public.monthly_v7_save_module_batch($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, ownBatchOperationId, report.id,
        batchLeaseA.lease_id, batchLeaseA.fencing_token, JSON.stringify(ownBatchChanges)]
    ));
    assert.equal(ownBatch.ok, true);
    assert.equal(ownBatch.updated[0].revision, item.revision + 1);
    const ownRetained = (await db.query(`
      select entity_type, lease_id, holder_user_session_id, expires_at > now() as active,
        extract(epoch from (expires_at - now()))::int as remaining_seconds
      from public.monthly_v7_entity_leases
      where (entity_type='module' and entity_id=$1)
         or (entity_type='kpi_batch' and entity_id=$2)
      order by entity_type
    `, [item.id, report.id])).rows;
    const retainedBatch = ownRetained.find((row) => row.entity_type === 'kpi_batch');
    const retainedLeaf = ownRetained.find((row) => row.entity_type === 'module');
    assert.equal(retainedBatch.lease_id, batchLeaseA.lease_id);
    assert.equal(retainedBatch.holder_user_session_id, a.login.user_session_id);
    assert.equal(retainedBatch.active, true);
    assert.ok(retainedBatch.remaining_seconds >= 80,
      `batch remaining_seconds=${retainedBatch.remaining_seconds}`);
    assert.equal(retainedLeaf.lease_id, moduleLeaseA.lease_id);
    assert.equal(retainedLeaf.holder_user_session_id, a.login.user_session_id);
    assert.equal(retainedLeaf.active, true);
    assert.ok(retainedLeaf.remaining_seconds >= 80,
      `leaf remaining_seconds=${retainedLeaf.remaining_seconds}`);

    await db.query(`
      update public.monthly_v7_entity_leases
      set expires_at = now() + interval '5 seconds'
      where (entity_type='module' and entity_id=$1)
         or (entity_type='kpi_batch' and entity_id=$2)
    `, [item.id, report.id]);
    const ownBatchReplay = rpcResult(await db.query(
      'select public.monthly_v7_save_module_batch($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', a.login.user_session_id, a.clientSessionId, ownBatchOperationId, report.id,
        batchLeaseA.lease_id, batchLeaseA.fencing_token, JSON.stringify(ownBatchChanges)]
    ));
    assert.deepEqual(ownBatchReplay, ownBatch);
    const replayRetained = (await db.query(`
      select entity_type, extract(epoch from (expires_at - now()))::int as remaining_seconds
      from public.monthly_v7_entity_leases
      where (entity_type='module' and entity_id=$1)
         or (entity_type='kpi_batch' and entity_id=$2)
      order by entity_type
    `, [item.id, report.id])).rows;
    assert.equal(replayRetained.length, 2);
    replayRetained.forEach((row) => assert.ok(row.remaining_seconds >= 80,
      `${row.entity_type} COMMITTED replay remaining_seconds=${row.remaining_seconds}`));
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
    assert.equal(Object.prototype.hasOwnProperty.call(saved, 'watermark'), false);
    const changes = rpcResult(await db.query(
      'select public.monthly_v7_get_changes_since($1,$2,$3,$4,$5) as result',
      ['workspace-test', a.site.site_session_id, a.login.user_session_id, 0, 100]
    ));
    assert.equal(changes.ok, true);
    assert.ok(changes.watermark > 0);
    assert.equal(changes.events.some((event) => event.entityId === item.id), true);
    assert.equal(changes.events.some((event) => (
      Object.prototype.hasOwnProperty.call(event, 'operationId')
      || Object.prototype.hasOwnProperty.call(event, 'actorUserId')
    )), false);
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

test('V7 密碼權限矩陣：只有 Owner 改進站密碼，Admin 只改自己登入密碼，Owner 可改所有登入密碼', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyDataManagement(db);
    await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE', minimum_client_version=7`);
    const owner = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-owner');
    const ownerId = owner.login.user.id;
    const adminCreated = rpcResult(await db.query(
      'select public.monthly_v7_create_user($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), 'admin1', '管理員一', 'admin', 'admin-pass']
    ));
    assert.equal(adminCreated.ok, true);

    const admin = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'admin1', 'admin-pass', 'tab-admin');
    const forbiddenOwnerEdit = rpcResult(await db.query(
      'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), ownerId, 'owner', 'Owner 被竄改', 'owner', null]
    ));
    assert.equal(forbiddenOwnerEdit.ok, false);
    assert.equal(forbiddenOwnerEdit.error, 'FORBIDDEN');
    const operatorCreated = rpcResult(await db.query(
      'select public.monthly_v7_create_user($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), 'operator2', '操作員二', 'operator', 'operator2-pass']
    ));
    assert.equal(operatorCreated.ok, true);

    const forbiddenOtherPassword = rpcResult(await db.query(
      'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), operatorCreated.user.id, 'operator2', '操作員二', 'operator', 'admin-must-not-reset']
    ));
    assert.equal(forbiddenOtherPassword.ok, false);
    assert.equal(forbiddenOtherPassword.error, 'FORBIDDEN');

    const forbiddenSitePassword = rpcResult(await db.query(
      'select public.monthly_v7_update_site_password($1,$2,$3,$4,$5) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), 'admin-must-not-change-site']
    ));
    assert.equal(forbiddenSitePassword.ok, false);
    assert.equal(forbiddenSitePassword.error, 'FORBIDDEN');

    const adminSelfChanged = rpcResult(await db.query(
      'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', admin.login.user_session_id, admin.clientSessionId, randomUUID(), adminCreated.user.id, 'admin1', '管理員一', 'admin', 'admin-self-pass']
    ));
    assert.equal(adminSelfChanged.ok, true);
    await assert.rejects(
      db.query(
        'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
        ['workspace-test', admin.site.site_session_id, admin.login.user_session_id]
      ),
      /READ_SESSION_INVALID|USER_SESSION_INVALID/
    );
    const adminRelogin = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'admin1', 'admin-self-pass', 'tab-admin-new');
    assert.equal(adminRelogin.login.ok, true);

    await setAuthUid(db, owner.uid);
    const ownerResetOperator = rpcResult(await db.query(
      'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), operatorCreated.user.id, 'operator2', '操作員二', 'operator', 'owner-reset-pass']
    ));
    assert.equal(ownerResetOperator.ok, true);

    const siteChanged = rpcResult(await db.query(
      'select public.monthly_v7_update_site_password($1,$2,$3,$4,$5) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), 'new-site-pass']
    ));
    assert.equal(siteChanged.ok, true);
    assert.equal(siteChanged.requiresReauth, true);
    await assert.rejects(
      db.query(
        'select public.monthly_v7_get_snapshot($1,$2,$3) as result',
        ['workspace-test', owner.site.site_session_id, owner.login.user_session_id]
      ),
      /SITE_SESSION_INVALID|READ_SESSION_INVALID/
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

test('V7 空間統計區分資料庫物理量、月報／專題邏輯量並限制數據管理角色', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyDataManagement(db);
    await activateNormalizedAuthority(db);
    const owner = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-storage-owner');
    const readStats = async (session = owner) => rpcResult(await db.query(
      'select public.monthly_v7_get_storage_stats($1,$2,$3) as result',
      ['workspace-test', session.login.user_session_id, session.clientSessionId]
    ));

    const before = await readStats();
    assert.equal(before.ok, true);
    assert.equal(before.staticSiteHost, 'github-pages');
    assert.equal(before.staticSiteInSupabase, false);
    assert.ok(Number(before.databaseTotalBytes) > 0);
    assert.ok(Number(before.appDatabasePhysicalBytes) > 0);
    assert.ok(Number(before.databaseTotalBytes) >= Number(before.appDatabasePhysicalBytes));
    assert.equal(Number(before.storageObjectBytes), 0);
    assert.equal(Number(before.storageObjectCount), 0);
    assert.equal(before.monthlyReports.length, 1);
    assert.ok(Number(before.monthlyReports[0].contentBytes) > 0);
    assert.equal(Number(before.monthlyReports[0].snapshotBytes), 0);

    const monthlyReportId = before.monthlyReports[0].id;
    const monthlySnapshot = rpcResult(await db.query(
      'select public.monthly_v7_create_report_snapshot($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', owner.site.site_session_id, owner.login.user_session_id, randomUUID(), monthlyReportId, 'history']
    ));
    assert.equal(monthlySnapshot.ok, true);
    const afterMonthlySnapshot = await readStats();
    assert.ok(Number(afterMonthlySnapshot.monthlyReports[0].snapshotBytes) > 0);
    assert.ok(Number(afterMonthlySnapshot.monthlyReports[0].logicalBytes) > Number(before.monthlyReports[0].logicalBytes));

    const topicContent = {
      domain: 'topic',
      modules: [{ id: 'topic-storage-1', title: '空間測試', layout: '1', columns: ['專題內容'], attachments: [] }]
    };
    const topicCreated = rpcResult(await db.query(
      'select public.monthly_v7_topic_create_report($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), randomUUID(), '空間統計專題', '2026-08-16', JSON.stringify(topicContent)]
    ));
    assert.equal(topicCreated.ok, true);
    const topicBeforeSnapshot = rpcResult(await db.query(
      'select public.monthly_v7_topic_list_reports($1,$2,$3) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId]
    ));
    assert.equal(topicBeforeSnapshot.ok, true);
    assert.ok(Number(topicBeforeSnapshot.reports[0].logicalBytes) > 0);
    assert.equal(Number(topicBeforeSnapshot.reports[0].snapshotBytes), 0);

    const topicSnapshot = rpcResult(await db.query(
      'select public.monthly_v7_topic_create_snapshot($1,$2,$3,$4,$5,$6) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), topicCreated.report.id, topicCreated.report.revision]
    ));
    assert.equal(topicSnapshot.ok, true);
    const topicAfterSnapshot = rpcResult(await db.query(
      'select public.monthly_v7_topic_list_reports($1,$2,$3) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId]
    ));
    assert.ok(Number(topicAfterSnapshot.reports[0].snapshotBytes) > 0);
    assert.ok(Number(topicAfterSnapshot.reports[0].logicalBytes) > Number(topicBeforeSnapshot.reports[0].logicalBytes));

    const adminCreated = rpcResult(await db.query(
      'select public.monthly_v7_create_user($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), 'storage-admin', '空間管理員', 'admin', 'storage-admin-pass']
    ));
    assert.equal(adminCreated.ok, true);
    const admin = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'storage-admin', 'storage-admin-pass', 'tab-storage-admin');
    assert.equal((await readStats(admin)).ok, true);

    const operator = await openAndLogin(db, '33333333-3333-4333-8333-333333333333', 'operator', 'operator-pass', 'tab-storage-operator');
    const forbidden = await readStats(operator);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, 'FORBIDDEN');

    const acl = (await db.query(`
      select
        not has_function_privilege('anon', 'public.monthly_v7_get_storage_stats(text,uuid,text)', 'EXECUTE') as anon_blocked,
        has_function_privilege('authenticated', 'public.monthly_v7_get_storage_stats(text,uuid,text)', 'EXECUTE') as authenticated_allowed
    `)).rows[0];
    assert.equal(acl.anon_blocked, true);
    assert.equal(acl.authenticated_allowed, true);
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

test('trusted-device resume migration 可重跑、預設私有且不改變舊登入流程', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    const before = await openAndLogin(
      db,
      '11111111-1111-4111-8111-111111111111',
      'owner',
      'owner-pass',
      'tab-before-resume-migration'
    );
    assert.equal(before.site.ok, true);
    assert.equal(before.login.ok, true);

    await applyTrustedDeviceResume(db);
    await applyTrustedDeviceResume(db);

    const contracts = (await db.query(`
      select
        to_regclass('public.monthly_v7_trusted_devices') is not null as device_table,
        to_regclass('public.monthly_v7_resume_tokens') is not null as token_table,
        exists(
          select 1 from information_schema.columns
          where table_schema='public' and table_name='monthly_v7_site_sessions'
            and column_name='trusted_device_id' and is_nullable='YES'
        ) as site_session_link,
        (select relrowsecurity from pg_class where oid='public.monthly_v7_trusted_devices'::regclass) as device_rls,
        (select relrowsecurity from pg_class where oid='public.monthly_v7_resume_tokens'::regclass) as token_rls,
        not has_table_privilege('anon','public.monthly_v7_trusted_devices','SELECT') as anon_device_blocked,
        not has_table_privilege('authenticated','public.monthly_v7_trusted_devices','SELECT') as authenticated_device_blocked,
        not has_table_privilege('anon','public.monthly_v7_resume_tokens','SELECT') as anon_token_blocked,
        not has_table_privilege('authenticated','public.monthly_v7_resume_tokens','SELECT') as authenticated_token_blocked
    `)).rows[0];
    assert.deepEqual(contracts, {
      device_table: true,
      token_table: true,
      site_session_link: true,
      device_rls: true,
      token_rls: true,
      anon_device_blocked: true,
      authenticated_device_blocked: true,
      anon_token_blocked: true,
      authenticated_token_blocked: true
    });

    const empty = (await db.query(`
      select
        (select count(*)::int from public.monthly_v7_trusted_devices) as devices,
        (select count(*)::int from public.monthly_v7_resume_tokens) as tokens
    `)).rows[0];
    assert.deepEqual(empty, { devices: 0, tokens: 0 });

    const after = await openAndLogin(
      db,
      '22222222-2222-4222-8222-222222222222',
      'operator',
      'operator-pass',
      'tab-after-resume-migration'
    );
    assert.equal(after.site.ok, true);
    assert.equal(after.login.ok, true);
  } finally {
    await db.close();
  }
});

test('trusted-device migration 不使基础 V7 schema 重放后的旧 open_site 失效', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await applyV7(db);
    await setAuthUid(db, '11111111-1111-4111-8111-111111111111');
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-base-replay']
    ));
    assert.equal(site.ok, true);
  } finally {
    await db.close();
  }
});


test('site resume 發行只回傳 raw token 一次、伺服器只存 verifier 且再次發行撤銷舊 token', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    await setAuthUid(db, uid);
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-site-issue']
    ));

    const first = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, 'tab-site-issue']
    ));
    assert.equal(first.ok, true);
    assert.match(first.resume_token, /^[a-f0-9]{64}$/);
    assert.match(String(first.trusted_device_id), /^[a-f0-9-]{36}$/);
    assert.equal(Object.hasOwn(first, 'user_session_id'), false);

    const firstRows = await db.query(`
      select d.id as device_id,d.auth_uid,d.authority_epoch,d.site_policy_generation,
        s.trusted_device_id,t.token_hash,t.purpose,t.consumed_at,t.revoked_at
      from public.monthly_v7_trusted_devices d
      join public.monthly_v7_site_sessions s on s.trusted_device_id=d.id
      join public.monthly_v7_resume_tokens t on t.trusted_device_id=d.id
      where s.id=$1
    `, [site.site_session_id]);
    assert.equal(firstRows.rows.length, 1);
    const firstRow = firstRows.rows[0];
    assert.equal(firstRow.device_id, first.trusted_device_id);
    assert.equal(firstRow.trusted_device_id, first.trusted_device_id);
    assert.equal(firstRow.auth_uid, uid);
    assert.equal(firstRow.purpose, 'site');
    assert.equal(firstRow.token_hash, sha256(first.resume_token));
    assert.notEqual(firstRow.token_hash, first.resume_token);
    assert.equal(firstRow.consumed_at, null);
    assert.equal(firstRow.revoked_at, null);

    const second = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, 'tab-site-issue']
    ));
    assert.equal(second.ok, true);
    assert.equal(second.trusted_device_id, first.trusted_device_id);
    assert.notEqual(second.resume_token, first.resume_token);

    const tokenState = (await db.query(`
      select count(*)::int as total,
        count(*) filter(where consumed_at is null and revoked_at is null and expires_at>now())::int as active,
        bool_or(token_hash=$1) as has_first_hash,
        bool_or(token_hash=$2) as has_second_hash
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$3 and purpose='site'
    `, [sha256(first.resume_token), sha256(second.resume_token), first.trusted_device_id])).rows[0];
    assert.deepEqual(tokenState, { total: 2, active: 1, has_first_hash: true, has_second_hash: true });

    const rawColumns = await db.query(`
      select column_name from information_schema.columns
      where table_schema='public' and table_name='monthly_v7_resume_tokens'
        and column_name in ('token','raw_token','resume_token')
    `);
    assert.equal(rawColumns.rows.length, 0);

    const acl = (await db.query(`
      select
        not has_function_privilege('anon','public.monthly_v7_issue_site_resume(text,uuid,text)','EXECUTE') as anon_blocked,
        has_function_privilege('authenticated','public.monthly_v7_issue_site_resume(text,uuid,text)','EXECUTE') as authenticated_allowed
    `)).rows[0];
    assert.deepEqual(acl, { anon_blocked: true, authenticated_allowed: true });
  } finally {
    await db.close();
  }
});

test('site resume token 單次交換為新 session 並原子輪替，replay 不建立 session', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    await setAuthUid(db, uid);
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-site-source']
    ));
    const issued = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, 'tab-site-source']
    ));

    const restored = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', issued.resume_token, 'tab-site-restored']
    ));
    assert.equal(restored.ok, true);
    assert.notEqual(restored.site_session_id, site.site_session_id);
    assert.equal(restored.trusted_device_id, issued.trusted_device_id);
    assert.match(restored.resume_token, /^[a-f0-9]{64}$/);
    assert.notEqual(restored.resume_token, issued.resume_token);
    assert.equal(Object.hasOwn(restored, 'user_session_id'), false);
    assert.equal(Object.hasOwn(restored, 'user'), false);

    const sessions = await db.query(`
      select id,client_session_id,trusted_device_id,expires_at
      from public.monthly_v7_site_sessions
      where trusted_device_id=$1
      order by created_at,id
    `, [issued.trusted_device_id]);
    assert.equal(sessions.rows.length, 2);
    const restoredSession = sessions.rows.find((row) => row.id === restored.site_session_id);
    assert.equal(restoredSession.client_session_id, 'tab-site-restored');
    assert.equal(restoredSession.trusted_device_id, issued.trusted_device_id);
    const device = (await db.query(
      'select expires_at from public.monthly_v7_trusted_devices where id=$1',
      [issued.trusted_device_id]
    )).rows[0];
    assert.ok(new Date(restoredSession.expires_at) <= new Date(device.expires_at));
    assert.equal((await db.query('select count(*)::int as count from public.monthly_v7_user_sessions')).rows[0].count, 0);

    const rotated = await db.query(`
      select token_hash,consumed_at,replaced_by_token_id
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$1 and purpose='site'
      order by issued_at,id
    `, [issued.trusted_device_id]);
    assert.equal(rotated.rows.length, 2);
    assert.equal(rotated.rows[0].token_hash, sha256(issued.resume_token));
    assert.notEqual(rotated.rows[0].consumed_at, null);
    assert.notEqual(rotated.rows[0].replaced_by_token_id, null);
    assert.equal(rotated.rows[1].token_hash, sha256(restored.resume_token));
    assert.equal(rotated.rows[1].consumed_at, null);

    const beforeReplay = (await db.query('select count(*)::int as count from public.monthly_v7_site_sessions')).rows[0].count;
    const replay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', issued.resume_token, 'tab-site-replay']
    ));
    assert.deepEqual(replay, { ok: false, error: 'SITE_RESUME_INVALID' });
    const afterReplay = (await db.query('select count(*)::int as count from public.monthly_v7_site_sessions')).rows[0].count;
    assert.equal(afterReplay, beforeReplay);
  } finally {
    await db.close();
  }
});

test('忘記可信裝置會撤銷其 tokens 與 sessions，且不影響其他裝置', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    await setAuthUid(db, uid);

    const siteA = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-forget-a']
    ));
    const userA = rpcResult(await db.query(
      'select public.monthly_v7_login_user($1,$2,$3,$4,$5) as result',
      ['workspace-test', siteA.site_session_id, 'owner', 'owner-pass', 'tab-forget-a']
    ));
    const markerA = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', siteA.site_session_id, 'tab-forget-a']
    ));

    const siteB = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-forget-b']
    ));
    const markerB = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', siteB.site_session_id, 'tab-forget-b']
    ));
    assert.notEqual(markerA.trusted_device_id, markerB.trusted_device_id);

    const forgotten = rpcResult(await db.query(
      'select public.monthly_v7_forget_trusted_device($1,$2,$3) as result',
      ['workspace-test', siteA.site_session_id, 'tab-forget-a']
    ));
    assert.deepEqual(forgotten, {
      ok: true,
      forgotten: true,
      trusted_device_id: markerA.trusted_device_id
    });

    const stateA = (await db.query(`
      select d.revoked_at is not null as revoked,
        (select count(*)::int from public.monthly_v7_resume_tokens t
          where t.trusted_device_id=d.id and t.revoked_at is null) as live_tokens,
        (select count(*)::int from public.monthly_v7_site_sessions s
          where s.trusted_device_id=d.id) as live_site_sessions,
        (select count(*)::int from public.monthly_v7_user_sessions u
          where u.id=$2) as live_user_sessions
      from public.monthly_v7_trusted_devices d where d.id=$1
    `, [markerA.trusted_device_id, userA.user_session_id])).rows[0];
    assert.deepEqual(stateA, {
      revoked: true,
      live_tokens: 0,
      live_site_sessions: 0,
      live_user_sessions: 0
    });

    const replayA = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', markerA.resume_token, 'tab-forget-a-replay']
    ));
    assert.deepEqual(replayA, { ok: false, error: 'SITE_RESUME_INVALID' });
    await assert.rejects(
      () => db.query(
        'select public.monthly_v7_get_snapshot($1,$2,$3::uuid) as result',
        ['workspace-test', siteA.site_session_id, null]
      ),
      /SITE_SESSION_INVALID/
    );

    const restoredB = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', markerB.resume_token, 'tab-forget-b-restored']
    ));
    assert.equal(restoredB.ok, true);
  } finally {
    await db.close();
  }
});

test('user resume marker 與 site marker 分離並綁定 user version、role 與 trusted device', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const session = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-user-issue');
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', session.site.site_session_id, session.clientSessionId]
    ));

    const first = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', session.site.site_session_id, session.login.user_session_id, session.clientSessionId]
    ));
    assert.equal(first.ok, true);
    assert.equal(first.trusted_device_id, siteMarker.trusted_device_id);
    assert.match(first.resume_token, /^[a-f0-9]{64}$/);
    assert.equal(first.user.id, session.login.user.id);
    assert.equal(first.user.version, session.login.user.version);
    assert.equal(first.user.role, 'owner');

    const stored = (await db.query(`
      select t.purpose,t.user_id,t.user_version,t.user_role,t.token_hash
      from public.monthly_v7_resume_tokens t
      where t.trusted_device_id=$1
      order by t.purpose
    `, [siteMarker.trusted_device_id])).rows;
    assert.equal(stored.length, 2);
    const siteToken = stored.find((row) => row.purpose === 'site');
    const userToken = stored.find((row) => row.purpose === 'user');
    assert.equal(siteToken.user_id, null);
    assert.equal(userToken.user_id, session.login.user.id);
    assert.equal(userToken.user_version, session.login.user.version);
    assert.equal(userToken.user_role, 'owner');
    assert.equal(userToken.token_hash, sha256(first.resume_token));
    assert.notEqual(userToken.token_hash, first.resume_token);

    const second = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', session.site.site_session_id, session.login.user_session_id, session.clientSessionId]
    ));
    assert.notEqual(second.resume_token, first.resume_token);
    const counts = (await db.query(`
      select
        count(*) filter(where purpose='site' and consumed_at is null and revoked_at is null)::int as active_site,
        count(*) filter(where purpose='user' and consumed_at is null and revoked_at is null)::int as active_user,
        count(*) filter(where purpose='user')::int as total_user
      from public.monthly_v7_resume_tokens where trusted_device_id=$1
    `, [siteMarker.trusted_device_id])).rows[0];
    assert.deepEqual(counts, { active_site: 1, active_user: 1, total_user: 2 });

    const untrusted = await openAndLogin(
      db,
      '22222222-2222-4222-8222-222222222222',
      'operator',
      'operator-pass',
      'tab-user-no-device'
    );
    const denied = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', untrusted.site.site_session_id, untrusted.login.user_session_id, untrusted.clientSessionId]
    ));
    assert.deepEqual(denied, { ok: false, error: 'TRUSTED_DEVICE_REQUIRED' });
  } finally {
    await db.close();
  }
});

test('user resume token 只在已恢復 site session 下交換並輪替為 fresh user session', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const source = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-user-source');
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', source.site.site_session_id, source.clientSessionId]
    ));
    const userMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', source.site.site_session_id, source.login.user_session_id, source.clientSessionId]
    ));

    const restoredSite = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', siteMarker.resume_token, 'tab-user-restored']
    ));
    const restoredUser = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', restoredSite.site_session_id, userMarker.resume_token, 'tab-user-restored']
    ));
    assert.equal(restoredUser.ok, true);
    assert.notEqual(restoredUser.user_session_id, source.login.user_session_id);
    assert.match(restoredUser.resume_token, /^[a-f0-9]{64}$/);
    assert.notEqual(restoredUser.resume_token, userMarker.resume_token);
    assert.deepEqual(restoredUser.user, source.login.user);
    assert.equal(JSON.stringify(restoredUser).includes('password'), false);
    assert.equal(JSON.stringify(restoredUser).includes('hash'), false);

    const sessionRow = (await db.query(`
      select us.site_session_id,us.client_session_id,us.user_version,
        ss.trusted_device_id
      from public.monthly_v7_user_sessions us
      join public.monthly_v7_site_sessions ss on ss.id=us.site_session_id
      where us.id=$1
    `, [restoredUser.user_session_id])).rows[0];
    assert.equal(sessionRow.site_session_id, restoredSite.site_session_id);
    assert.equal(sessionRow.client_session_id, 'tab-user-restored');
    assert.equal(sessionRow.user_version, source.login.user.version);
    assert.equal(sessionRow.trusted_device_id, siteMarker.trusted_device_id);

    const replayCountBefore = (await db.query('select count(*)::int as count from public.monthly_v7_user_sessions')).rows[0].count;
    const replay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', restoredSite.site_session_id, userMarker.resume_token, 'tab-user-restored']
    ));
    assert.deepEqual(replay, { ok: false, error: 'USER_RESUME_INVALID' });
    const replayCountAfter = (await db.query('select count(*)::int as count from public.monthly_v7_user_sessions')).rows[0].count;
    assert.equal(replayCountAfter, replayCountBefore);

    const rotatedRows = await db.query(`
      select token_hash,consumed_at,replaced_by_token_id
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$1 and purpose='user'
      order by issued_at,id
    `, [siteMarker.trusted_device_id]);
    assert.equal(rotatedRows.rows.length, 2);
    assert.notEqual(rotatedRows.rows[0].consumed_at, null);
    assert.notEqual(rotatedRows.rows[0].replaced_by_token_id, null);
    assert.equal(rotatedRows.rows[1].token_hash, sha256(restoredUser.resume_token));
  } finally {
    await db.close();
  }
});

test('user logout 同交易撤銷 user resume，但保留 trusted site resume 與 site session', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const source = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-user-logout-resume');
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', source.site.site_session_id, source.clientSessionId]
    ));
    const userMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', source.site.site_session_id, source.login.user_session_id, source.clientSessionId]
    ));

    const logout = rpcResult(await db.query(
      'select public.monthly_v7_logout_user($1,$2,$3) as result',
      ['workspace-test', source.site.site_session_id, source.login.user_session_id]
    ));
    assert.equal(logout.ok, true);
    assert.equal(logout.revoked, true);

    const tokenState = (await db.query(`
      select
        count(*) filter(where purpose='site' and consumed_at is null and revoked_at is null)::int as active_site,
        count(*) filter(where purpose='user' and consumed_at is null and revoked_at is null)::int as active_user
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$1
    `, [siteMarker.trusted_device_id])).rows[0];
    assert.deepEqual(tokenState, { active_site: 1, active_user: 0 });

    const siteOnly = rpcResult(await db.query(
      'select public.monthly_v7_get_snapshot($1,$2,$3::uuid) as result',
      ['workspace-test', source.site.site_session_id, null]
    ));
    assert.equal(siteOnly.ok, true);

    const restoredSite = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', siteMarker.resume_token, 'tab-user-logout-restored']
    ));
    assert.equal(restoredSite.ok, true);
    const restoredUser = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', restoredSite.site_session_id, userMarker.resume_token, 'tab-user-logout-restored']
    ));
    assert.deepEqual(restoredUser, { ok: false, error: 'USER_RESUME_INVALID' });
  } finally {
    await db.close();
  }
});

test('full site logout 同交易撤銷整個 trusted device、所有 markers 與衍生 sessions', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const source = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-site-logout-source');
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', source.site.site_session_id, source.clientSessionId]
    ));
    const userMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', source.site.site_session_id, source.login.user_session_id, source.clientSessionId]
    ));
    const sibling = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', siteMarker.resume_token, 'tab-site-logout-sibling']
    ));
    const activeSiteToken = sibling.resume_token;

    const logout = rpcResult(await db.query(
      'select public.monthly_v7_logout($1,$2,$3) as result',
      ['workspace-test', source.site.site_session_id, source.login.user_session_id]
    ));
    assert.equal(logout.ok, true);
    assert.equal(logout.revoked, true);

    const device = (await db.query(`
      select revoked_at,revoked_reason from public.monthly_v7_trusted_devices where id=$1
    `, [siteMarker.trusted_device_id])).rows[0];
    assert.notEqual(device.revoked_at, null);
    assert.equal(device.revoked_reason, 'site_logout');
    const tokenCounts = (await db.query(`
      select count(*) filter(where consumed_at is null and revoked_at is null)::int as active,
        count(*) filter(where revoked_at is not null)::int as revoked
      from public.monthly_v7_resume_tokens where trusted_device_id=$1
    `, [siteMarker.trusted_device_id])).rows[0];
    assert.equal(tokenCounts.active, 0);
    assert.equal(tokenCounts.revoked >= 1, true);
    const sessions = (await db.query(`
      select count(*)::int as count from public.monthly_v7_site_sessions where trusted_device_id=$1
    `, [siteMarker.trusted_device_id])).rows[0].count;
    assert.equal(sessions, 0);

    const siteReplay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', activeSiteToken, 'tab-site-logout-replay']
    ));
    assert.deepEqual(siteReplay, { ok: false, error: 'SITE_RESUME_INVALID' });
    const userReplay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', sibling.site_session_id, userMarker.resume_token, 'tab-site-logout-sibling']
    ));
    assert.deepEqual(userReplay, { ok: false, error: 'USER_RESUME_INVALID' });
  } finally {
    await db.close();
  }
});

test('site resume 對 auth、expiry、policy、authority epoch/state 變化一律 fail closed', async () => {
  const cases = [
    {
      name: 'auth_uid mismatch',
      mutate: async (db) => setAuthUid(db, '22222222-2222-4222-8222-222222222222')
    },
    {
      name: 'token expired',
      mutate: async (db, marker) => db.query(
        `update public.monthly_v7_resume_tokens
         set issued_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
         where token_hash=$1`,
        [sha256(marker.resume_token)]
      )
    },
    {
      name: 'device expired',
      mutate: async (db, marker) => db.query(
        `update public.monthly_v7_trusted_devices
         set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
         where id=$1`,
        [marker.trusted_device_id]
      )
    },
    {
      name: 'site policy generation changed',
      mutate: async (db) => db.exec(`update public.monthly_v7_site_access set generation=generation+1`)
    },
    {
      name: 'authority epoch changed',
      mutate: async (db) => db.exec(`update public.monthly_v7_workspaces set authority_epoch=authority_epoch+1`)
    },
    {
      name: 'authority state not active',
      mutate: async (db) => db.exec(`update public.monthly_v7_workspaces set authority_state='LEGACY_ACTIVE'`)
    }
  ];

  for (const scenario of cases) {
    const db = await createLegacyDatabase();
    try {
      await applyV7(db);
      await applyTrustedDeviceResume(db);
      await activateNormalizedAuthority(db);
      const uid = '11111111-1111-4111-8111-111111111111';
      const source = await openAndLogin(db, uid, 'owner', 'owner-pass', `tab-${scenario.name}`);
      const marker = rpcResult(await db.query(
        'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
        ['workspace-test', source.site.site_session_id, source.clientSessionId]
      ));
      const before = (await db.query('select count(*)::int as count from public.monthly_v7_site_sessions')).rows[0].count;
      await scenario.mutate(db, marker);
      if (scenario.name === 'authority epoch changed') {
        const devicesBefore = (await db.query(
          'select count(*)::int as count from public.monthly_v7_trusted_devices'
        )).rows[0].count;
        await assert.rejects(
          db.query(
            'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
            ['workspace-test', source.site.site_session_id, source.clientSessionId]
          ),
          /SITE_SESSION_INVALID/
        );
        const devicesAfter = (await db.query(
          'select count(*)::int as count from public.monthly_v7_trusted_devices'
        )).rows[0].count;
        assert.equal(devicesAfter, devicesBefore, 'epoch change must not mint a replacement device');
      }
      if (scenario.name === 'authority state not active') {
        const siteIssue = rpcResult(await db.query(
          'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
          ['workspace-test', source.site.site_session_id, source.clientSessionId]
        ));
        const userIssue = rpcResult(await db.query(
          'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
          ['workspace-test', source.site.site_session_id, source.login.user_session_id, source.clientSessionId]
        ));
        assert.deepEqual(siteIssue, { ok: false, error: 'AUTHORITY_NOT_ACTIVE' });
        assert.deepEqual(userIssue, { ok: false, error: 'AUTHORITY_NOT_ACTIVE' });
      }
      const result = rpcResult(await db.query(
        'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
        ['workspace-test', marker.resume_token, `restored-${scenario.name}`]
      ));
      assert.deepEqual(result, { ok: false, error: 'SITE_RESUME_INVALID' }, scenario.name);
      const after = (await db.query('select count(*)::int as count from public.monthly_v7_site_sessions')).rows[0].count;
      assert.equal(after, before, `${scenario.name} must not create a session`);
    } finally {
      await db.close();
    }
  }
});


test('user resume 對 password/version、role、active 與 token expiry 變化失效，但 site resume 保留', async () => {
  const cases = [
    {
      name: 'password and version changed',
      mutate: async (db, owner, target) => rpcResult(await db.query(
        'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
        ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(),
          target.id, target.username, target.displayName, target.role, 'operator-new-pass']
      ))
    },
    {
      name: 'role changed',
      mutate: async (db, owner, target) => rpcResult(await db.query(
        'select public.monthly_v7_update_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
        ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(),
          target.id, target.username, target.displayName, 'admin', null]
      ))
    },
    {
      name: 'user inactive',
      mutate: async (db, owner, target) => rpcResult(await db.query(
        'select public.monthly_v7_delete_user($1,$2,$3,$4,$5) as result',
        ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), target.id]
      ))
    },
    {
      name: 'user token expired',
      mutate: async (db, _owner, _target, marker) => {
        await db.query(
          `update public.monthly_v7_resume_tokens
           set issued_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
           where token_hash=$1`,
          [sha256(marker.resume_token)]
        );
        return { ok: true };
      }
    }
  ];

  for (const scenario of cases) {
    const db = await createLegacyDatabase();
    try {
      await applyV7(db);
      await applyTrustedDeviceResume(db);
      await activateNormalizedAuthority(db);
      const operatorUid = '33333333-3333-4333-8333-333333333333';
      const operator = await openAndLogin(db, operatorUid, 'operator', 'operator-pass', `operator-${scenario.name}`);
      const siteMarker = rpcResult(await db.query(
        'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
        ['workspace-test', operator.site.site_session_id, operator.clientSessionId]
      ));
      const userMarker = rpcResult(await db.query(
        'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
        ['workspace-test', operator.site.site_session_id, operator.login.user_session_id, operator.clientSessionId]
      ));

      const owner = await openAndLogin(
        db,
        '11111111-1111-4111-8111-111111111111',
        'owner',
        'owner-pass',
        `owner-${scenario.name}`
      );
      const changed = await scenario.mutate(db, owner, operator.login.user, userMarker);
      assert.equal(changed.ok, true, `${scenario.name} mutation`);

      await setAuthUid(db, operatorUid);
      const restoredSite = rpcResult(await db.query(
        'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
        ['workspace-test', siteMarker.resume_token, `restored-${scenario.name}`]
      ));
      assert.equal(restoredSite.ok, true, `${scenario.name} must preserve site resume`);
      const before = (await db.query('select count(*)::int as count from public.monthly_v7_user_sessions')).rows[0].count;
      const restoredUser = rpcResult(await db.query(
        'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
        ['workspace-test', restoredSite.site_session_id, userMarker.resume_token, `restored-${scenario.name}`]
      ));
      assert.deepEqual(restoredUser, { ok: false, error: 'USER_RESUME_INVALID' }, scenario.name);
      const after = (await db.query('select count(*)::int as count from public.monthly_v7_user_sessions')).rows[0].count;
      assert.equal(after, before, `${scenario.name} must not create a user session`);
    } finally {
      await db.close();
    }
  }
});


test('site password rotation 實體撤銷 trusted devices 與所有 resume markers', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const owner = await openAndLogin(
      db,
      '11111111-1111-4111-8111-111111111111',
      'owner',
      'owner-pass',
      'tab-site-password-rotation'
    );
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', owner.site.site_session_id, owner.clientSessionId]
    ));
    const userMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', owner.site.site_session_id, owner.login.user_session_id, owner.clientSessionId]
    ));

    const changed = rpcResult(await db.query(
      'select public.monthly_v7_update_site_password($1,$2,$3,$4,$5) as result',
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, randomUUID(), 'rotated-site-password']
    ));
    assert.equal(changed.ok, true);
    assert.equal(changed.requiresReauth, true);

    const device = (await db.query(`
      select revoked_at,revoked_reason
      from public.monthly_v7_trusted_devices
      where id=$1
    `, [siteMarker.trusted_device_id])).rows[0];
    assert.notEqual(device.revoked_at, null);
    assert.equal(device.revoked_reason, 'site_policy_changed');

    const tokens = (await db.query(`
      select purpose,revoked_at
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$1
      order by purpose
    `, [siteMarker.trusted_device_id])).rows;
    assert.equal(tokens.length, 2);
    assert.equal(tokens.every((token) => token.revoked_at !== null), true);

    const siteReplay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', siteMarker.resume_token, 'tab-site-password-replay']
    ));
    assert.deepEqual(siteReplay, { ok: false, error: 'SITE_RESUME_INVALID' });
    const userReplay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', owner.site.site_session_id, userMarker.resume_token, owner.clientSessionId]
    ));
    assert.deepEqual(userReplay, { ok: false, error: 'USER_RESUME_INVALID' });
  } finally {
    await db.close();
  }
});

test('trusted-device RPC ACL 逐一禁止 anon 且只允许 authenticated 執行', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    const signatures = [
      'public.monthly_v7_issue_site_resume(text,uuid,text)',
      'public.monthly_v7_exchange_site_resume(text,text,text)',
      'public.monthly_v7_forget_trusted_device(text,uuid,text)',
      'public.monthly_v7_issue_user_resume(text,uuid,uuid,text)',
      'public.monthly_v7_exchange_user_resume(text,uuid,text,text)',
      'public.monthly_v7_logout_user(text,uuid,uuid)',
      'public.monthly_v7_logout(text,uuid,uuid)',
      'public.monthly_v7_update_site_password(text,uuid,text,uuid,text)'
    ];
    for (const signature of signatures) {
      const acl = (await db.query(`
        select
          has_function_privilege('anon',$1,'EXECUTE') as anon_allowed,
          has_function_privilege('authenticated',$1,'EXECUTE') as authenticated_allowed
      `, [signature])).rows[0];
      assert.deepEqual(acl, { anon_allowed: false, authenticated_allowed: true }, signature);
    }
    for (const signature of [
      'public.monthly_v7_bind_site_session_authority_epoch()',
      'public.monthly_v7_lock_resume_mutex(uuid)'
    ]) {
      const acl = (await db.query(`
        select
          has_function_privilege('anon',$1,'EXECUTE') as anon_allowed,
          has_function_privilege('authenticated',$1,'EXECUTE') as authenticated_allowed
      `, [signature])).rows[0];
      assert.deepEqual(acl, { anon_allowed: false, authenticated_allowed: false }, signature);
    }
    for (const table of [
      'monthly_v7_trusted_devices',
      'monthly_v7_resume_tokens',
      'monthly_v7_resume_mutexes'
    ]) {
      const acl = (await db.query(`
        select
          has_table_privilege('anon','public.'||$1,'SELECT') as anon_allowed,
          has_table_privilege('authenticated','public.'||$1,'SELECT') as authenticated_allowed
      `, [table])).rows[0];
      assert.deepEqual(acl, { anon_allowed: false, authenticated_allowed: false }, table);
    }
  } finally {
    await db.close();
  }
});


test('同一 trusted device 切換帳號時只保留一個 active user marker', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    const owner = await openAndLogin(db, uid, 'owner', 'owner-pass', 'tab-user-switch');
    const siteMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', owner.site.site_session_id, owner.clientSessionId]
    ));
    const ownerMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', owner.site.site_session_id, owner.login.user_session_id, owner.clientSessionId]
    ));

    const operatorLogin = rpcResult(await db.query(
      'select public.monthly_v7_login_user($1,$2,$3,$4,$5) as result',
      ['workspace-test', owner.site.site_session_id, 'operator', 'operator-pass', owner.clientSessionId]
    ));
    const operatorMarker = rpcResult(await db.query(
      'select public.monthly_v7_issue_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', owner.site.site_session_id, operatorLogin.user_session_id, owner.clientSessionId]
    ));
    assert.equal(operatorMarker.ok, true);

    const active = (await db.query(`
      select user_id
      from public.monthly_v7_resume_tokens
      where trusted_device_id=$1 and purpose='user'
        and consumed_at is null and revoked_at is null
    `, [siteMarker.trusted_device_id])).rows;
    assert.equal(active.length, 1);
    assert.equal(active[0].user_id, operatorLogin.user.id);

    const restoredSite = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', siteMarker.resume_token, 'tab-user-switch-restored']
    ));
    const ownerReplay = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', restoredSite.site_session_id, ownerMarker.resume_token, 'tab-user-switch-restored']
    ));
    assert.deepEqual(ownerReplay, { ok: false, error: 'USER_RESUME_INVALID' });
    const operatorRestored = rpcResult(await db.query(
      'select public.monthly_v7_exchange_user_resume($1,$2,$3,$4) as result',
      ['workspace-test', restoredSite.site_session_id, operatorMarker.resume_token, 'tab-user-switch-restored']
    ));
    assert.equal(operatorRestored.ok, true);
    assert.equal(operatorRestored.user.id, operatorLogin.user.id);
  } finally {
    await db.close();
  }
});


test('未关联 device 的旧 site session 在 authority epoch 变化后不得首次铸造 marker', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    await setAuthUid(db, uid);
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-pre-epoch']
    ));
    const before = (await db.query('select count(*)::int as count from public.monthly_v7_trusted_devices')).rows[0].count;
    await db.exec(`update public.monthly_v7_workspaces set authority_epoch=authority_epoch+1`);
    await assert.rejects(
      db.query(
        'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
        ['workspace-test', site.site_session_id, 'tab-pre-epoch']
      ),
      /SITE_SESSION_INVALID/
    );
    const after = (await db.query('select count(*)::int as count from public.monthly_v7_trusted_devices')).rows[0].count;
    assert.equal(after, before);
  } finally {
    await db.close();
  }
});


test('trusted device 12 小時為絕對上限，重發與交換都不得滑動延長', async () => {
  const db = await createLegacyDatabase();
  try {
    await applyV7(db);
    await applyTrustedDeviceResume(db);
    await activateNormalizedAuthority(db);
    const uid = '11111111-1111-4111-8111-111111111111';
    await setAuthUid(db, uid);
    const site = rpcResult(await db.query(
      'select public.monthly_v7_open_site($1,$2,$3) as result',
      ['workspace-test', 'site-pass', 'tab-absolute-expiry']
    ));
    const first = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, 'tab-absolute-expiry']
    ));
    const initial = (await db.query(`
      select created_at,expires_at,
        extract(epoch from (expires_at-created_at))::int as lifetime_seconds
      from public.monthly_v7_trusted_devices where id=$1
    `, [first.trusted_device_id])).rows[0];
    assert.ok(initial.lifetime_seconds > 0);
    assert.ok(initial.lifetime_seconds <= 12 * 60 * 60);

    const shortened = (await db.query(`
      update public.monthly_v7_trusted_devices
      set expires_at=now()+interval '1 hour'
      where id=$1
      returning expires_at
    `, [first.trusted_device_id])).rows[0].expires_at;

    const second = rpcResult(await db.query(
      'select public.monthly_v7_issue_site_resume($1,$2,$3) as result',
      ['workspace-test', site.site_session_id, 'tab-absolute-expiry']
    ));
    assert.equal(new Date(second.expires_at).getTime(), new Date(shortened).getTime());
    const afterIssue = (await db.query(
      'select expires_at from public.monthly_v7_trusted_devices where id=$1',
      [first.trusted_device_id]
    )).rows[0].expires_at;
    assert.equal(new Date(afterIssue).getTime(), new Date(shortened).getTime());

    const restored = rpcResult(await db.query(
      'select public.monthly_v7_exchange_site_resume($1,$2,$3) as result',
      ['workspace-test', second.resume_token, 'tab-absolute-expiry-restored']
    ));
    assert.equal(restored.ok, true);
    assert.ok(new Date(restored.expires_at).getTime() <= new Date(shortened).getTime());
    const afterExchange = (await db.query(`
      select d.expires_at as device_expires_at,
        s.expires_at as session_expires_at,
        t.expires_at as token_expires_at
      from public.monthly_v7_trusted_devices d
      join public.monthly_v7_site_sessions s on s.trusted_device_id=d.id and s.id=$2
      join public.monthly_v7_resume_tokens t on t.trusted_device_id=d.id
        and t.purpose='site' and t.consumed_at is null and t.revoked_at is null
      where d.id=$1
    `, [first.trusted_device_id, restored.site_session_id])).rows[0];
    assert.equal(new Date(afterExchange.device_expires_at).getTime(), new Date(shortened).getTime());
    assert.ok(new Date(afterExchange.session_expires_at) <= new Date(shortened));
    assert.ok(new Date(afterExchange.token_expires_at) <= new Date(shortened));
  } finally {
    await db.close();
  }
});


test('trusted-device SQL 统一 lock order，避免 issue/exchange/logout/password rotation 死锁环', async () => {
  const sql = (await readFile(
    join(ROOT, 'docs', 'supabase-schema-v7-trusted-device-resume.sql'),
    'utf8'
  )).replace(/\r\n/g, '\n');
  function body(name) {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    assert.notEqual(start, -1, name);
    const end = sql.indexOf('\n$$;', start);
    assert.notEqual(end, -1, name);
    return sql.slice(start, end);
  }
  const mutexBody = body('monthly_v7_lock_resume_mutex');
  assert.match(mutexBody, /insert into public\.monthly_v7_resume_mutexes/);
  assert.match(mutexBody, /from public\.monthly_v7_resume_mutexes[\s\S]+for update;/);

  for (const name of [
    'monthly_v7_issue_site_resume',
    'monthly_v7_exchange_site_resume',
    'monthly_v7_forget_trusted_device',
    'monthly_v7_issue_user_resume',
    'monthly_v7_exchange_user_resume',
    'monthly_v7_logout_user',
    'monthly_v7_logout',
    'monthly_v7_update_site_password'
  ]) {
    const source = body(name);
    assert.doesNotMatch(source, /where legacy_workspace_key=p_workspace_key\s+for update;/);
    const mutexLock = source.indexOf('perform public.monthly_v7_lock_resume_mutex(workspace_row.id);');
    assert.notEqual(mutexLock, -1, `${name}: resume mutex`);
    const workspaceRefresh = source.indexOf('where id=workspace_row.id\n  for update;', mutexLock + 1);
    assert.notEqual(workspaceRefresh, -1, `${name}: refresh and lock workspace after mutex`);
    assert.ok(mutexLock < workspaceRefresh, `${name}: mutex before workspace refresh`);
    const nextLock = source.indexOf('for update;', workspaceRefresh + 1);
    assert.ok(nextLock === -1 || workspaceRefresh < nextLock, `${name}: workspace refresh must precede other locks`);
  }
});
