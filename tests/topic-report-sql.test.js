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

async function createDatabase() {
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
    app: 'monthly-safety-report-system', version: 6, fileId: 'legacy-report',
    report: {
      title: '受保護月報', date: '2026-08-16',
      period: { startM: '8', startD: '1', endM: '8', endD: '31' },
      modules: [{ id: 1, title: '月報項目', columns: ['月報內容'], selectedForPdf: true, attachments: [] }]
    },
    records: { inspections: [], deficiencies: [], detentions: [], actions: [], trainings: [] },
    users: [
      { username: 'owner', displayName: 'Owner A', role: 'owner', passwordHash: sha256('owner-pass') },
      { username: 'operator', displayName: 'Operator B', role: 'operator', passwordHash: sha256('operator-pass') }
    ],
    siteAccess: { passwordHash: sha256('site-pass'), updatedAt: '2026-08-16T00:00:00Z' }
  };
  await db.query(
    `insert into public.monthly_report_cloud_data(workspace_key,payload,revision,updated_by)
     values($1,$2::jsonb,146,'Owner A')`,
    ['workspace-test', JSON.stringify(payload)]
  );
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7.sql'), 'utf8'));
  await db.exec(`update public.monthly_v7_workspaces set authority_state='NORMALIZED_ACTIVE',minimum_client_version=7`);
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-topic-reports.sql'), 'utf8'));
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-topic-reports-v2.sql'), 'utf8'));
  await db.exec(await readFile(join(ROOT, 'docs', 'supabase-schema-v7-data-management-storage.sql'), 'utf8'));
  return db;
}

async function setAuthUid(db, uid) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [uid]);
}

function result(query) {
  return query.rows[0].result;
}

async function taipeiSystemNumber(db, sequence) {
  const row = (await db.query(`
    select to_char(clock_timestamp() at time zone 'Asia/Taipei', 'YYYYMMDD') business_date
  `)).rows[0];
  return `SR-${row.business_date}-${String(sequence).padStart(3, '0')}`;
}

async function openAndLogin(db, uid, username, password, clientSessionId) {
  await setAuthUid(db, uid);
  const site = result(await db.query(
    `select public.monthly_v7_open_site($1,$2,$3) result`,
    ['workspace-test', 'site-pass', clientSessionId]
  ));
  const login = result(await db.query(
    `select public.monthly_v7_login_user($1,$2,$3,$4,$5) result`,
    ['workspace-test', site.site_session_id, username, password, clientSessionId]
  ));
  return { uid, clientSessionId, site, login };
}

function blankContent(title = '未命名專題報告') {
  return {
    schemaVersion: 1,
    domain: 'topic',
    title,
    reportDate: '2026-08-16',
    period: { start: '2026-08-16', end: '2026-08-16' },
    settings: { globalFontEn: 'Arial', globalFontZh: 'Noto Sans TC', pdfScale: 95 },
    modules: [{
      id: randomUUID(), icon: 'fas fa-file-lines', iconColor: '#4f46e5', title: '專題內容',
      colLayout: '1', colCount: 1, columns: ['內容'], attachments: [], selectedForPdf: true, pdfOrder: 1
    }]
  };
}

async function createTopic(db, session, editorWindowId, operationId, title, content = blankContent(title)) {
  await setAuthUid(db, session.uid);
  return result(await db.query(
    `select public.monthly_v7_topic_create_report($1,$2,$3,$4,$5,$6,$7,$8::jsonb) result`,
    ['workspace-test', session.login.user_session_id, session.clientSessionId, operationId,
      editorWindowId, title, '2026-08-16', JSON.stringify(content)]
  ));
}

async function acquire(db, session, reportId, editorWindowId) {
  await setAuthUid(db, session.uid);
  return result(await db.query(
    `select public.monthly_v7_topic_acquire_report_lease($1,$2,$3,$4,$5,$6) result`,
    ['workspace-test', session.login.user_session_id, session.clientSessionId, reportId, editorWindowId, 90]
  ));
}

async function release(db, session, reportId, editorWindowId, lease) {
  await setAuthUid(db, session.uid);
  return result(await db.query(
    `select public.monthly_v7_topic_release_report_lease($1,$2,$3,$4,$5,$6,$7) result`,
    ['workspace-test', session.login.user_session_id, session.clientSessionId, reportId,
      editorWindowId, lease.leaseId, lease.fencingToken]
  ));
}

async function save(db, session, reportId, editorWindowId, lease, expectedRevision, title, operationId = randomUUID()) {
  await setAuthUid(db, session.uid);
  const content = blankContent(title);
  return result(await db.query(
    `select public.monthly_v7_topic_save_report($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) result`,
    ['workspace-test', session.login.user_session_id, session.clientSessionId, operationId,
      reportId, editorWindowId, lease.leaseId, lease.fencingToken, expectedRevision,
      title, '2026-08-16', 'draft', JSON.stringify(content)]
  ));
}

test('專題migration只新增topic authority並封鎖直接表存取', async () => {
  const db = await createDatabase();
  try {
    const contracts = (await db.query(`
      select
        to_regclass('public.monthly_v7_topic_reports') is not null as reports,
        to_regclass('public.monthly_v7_topic_report_leases') is not null as leases,
        to_regclass('public.monthly_v7_topic_operations') is not null as operations,
        to_regclass('public.monthly_v7_topic_report_snapshots') is not null as snapshots,
        to_regprocedure('public.monthly_v7_topic_create_report(text,uuid,text,uuid,uuid,text,date,jsonb)') is not null as create_rpc,
        to_regprocedure('public.monthly_v7_topic_save_report(text,uuid,text,uuid,uuid,uuid,uuid,bigint,bigint,text,date,text,jsonb)') is not null as save_rpc,
        to_regprocedure('public.monthly_v7_topic_delete_report(text,uuid,text,uuid,uuid,bigint)') is not null as delete_rpc,
        not has_table_privilege('authenticated','public.monthly_v7_topic_reports','SELECT') as direct_select_blocked,
        not has_table_privilege('authenticated','public.monthly_v7_topic_reports','INSERT') as direct_insert_blocked,
        not has_function_privilege('anon','public.monthly_v7_topic_list_reports(text,uuid,text)','EXECUTE') as anon_rpc_blocked,
        has_function_privilege('authenticated','public.monthly_v7_topic_list_reports(text,uuid,text)','EXECUTE') as authenticated_rpc_allowed
    `)).rows[0];
    assert.deepEqual(contracts, {
      reports: true, leases: true, operations: true, snapshots: true,
      create_rpc: true, save_rpc: true, delete_rpc: true, direct_select_blocked: true,
      direct_insert_blocked: true, anon_rpc_blocked: true, authenticated_rpc_allowed: true
    });
  } finally {
    await db.close();
  }
});

test('新增報告原子產生唯一系統編號且lost ACK重送不建立副本', async () => {
  const db = await createDatabase();
  try {
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const opA = randomUUID();
    const contentA = blankContent('甲專題');
    const createA = await createTopic(db, a, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', opA, '甲專題', contentA);
    const replayA = await createTopic(db, a, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', opA, '甲專題', contentA);
    const createB = await createTopic(db, b, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', randomUUID(), '乙專題');
    const expectedA = await taipeiSystemNumber(db, 1);
    const expectedB = await taipeiSystemNumber(db, 2);

    assert.equal(createA.ok, true);
    assert.equal(createA.report.systemNumber, expectedA);
    assert.equal(replayA.report.id, createA.report.id);
    assert.equal(replayA.report.systemNumber, createA.report.systemNumber);
    assert.equal(createB.report.systemNumber, expectedB);

    await setAuthUid(db, a.uid);
    const listed = result(await db.query(
      `select public.monthly_v7_topic_list_reports($1,$2,$3) result`,
      ['workspace-test', a.login.user_session_id, a.clientSessionId]
    ));
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.reports.map((row) => row.systemNumber), [expectedB, expectedA]);
    assert.equal(listed.reports.every((row) => Number(row.logicalBytes) > 0), true);
    assert.equal(listed.reports.every((row) => Number(row.snapshotBytes) === 0), true);
    assert.equal((await db.query(`select count(*)::int count from public.monthly_v7_topic_reports`)).rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test('不同專題可並行，同一專題排他且同帳號第二窗口仍為唯讀', async () => {
  const db = await createDatabase();
  try {
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const aWindow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const bWindow = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    const reportA = await createTopic(db, a, aWindow, randomUUID(), 'A報告');
    const reportB = await createTopic(db, b, bWindow, randomUUID(), 'B報告');

    const deniedB = await acquire(db, b, reportA.report.id, bWindow);
    assert.equal(deniedB.ok, false);
    assert.equal(deniedB.error, 'LEASE_HELD');
    assert.equal(deniedB.holderDisplayName, 'Owner A');

    const deniedSecondWindow = await acquire(db, a, reportA.report.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9');
    assert.equal(deniedSecondWindow.ok, false);
    assert.equal(deniedSecondWindow.error, 'LEASE_HELD');

    const ownB = await acquire(db, b, reportB.report.id, bWindow);
    assert.equal(ownB.ok, true);
    assert.equal(ownB.reportId, reportB.report.id);
  } finally {
    await db.close();
  }
});

test('完成釋放後他人可取得新fencing token且舊窗口不能覆蓋', async () => {
  const db = await createDatabase();
  try {
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const b = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-b');
    const aWindow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const bWindow = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    const created = await createTopic(db, a, aWindow, randomUUID(), '初始專題');
    const originalLease = created.lease;

    const saveA = await save(db, a, created.report.id, aWindow, originalLease, 1, 'A完成內容');
    assert.equal(saveA.ok, true);
    assert.equal(saveA.report.revision, 2);

    const released = await release(db, a, created.report.id, aWindow, originalLease);
    assert.equal(released.ok, true);
    assert.equal(released.released, true);

    const leaseB = await acquire(db, b, created.report.id, bWindow);
    assert.equal(leaseB.ok, true);
    assert.ok(leaseB.fencingToken > originalLease.fencingToken);

    const staleA = await save(db, a, created.report.id, aWindow, originalLease, 2, 'A舊窗口覆蓋');
    assert.equal(staleA.ok, false);
    assert.equal(staleA.error, 'LEASE_LOST');

    const saveB = await save(db, b, created.report.id, bWindow, leaseB, 2, 'B接手修改');
    assert.equal(saveB.ok, true);
    assert.equal(saveB.report.revision, 3);
    assert.equal(saveB.report.title, 'B接手修改');
  } finally {
    await db.close();
  }
});

test('專題建立保存與快照不改月報revision、payload、snapshot或change events', async () => {
  const db = await createDatabase();
  try {
    const before = (await db.query(`
      select
        (select revision from public.monthly_v7_reports order by id limit 1) report_revision,
        (select md5(payload::text) from public.monthly_v7_report_items order by id limit 1) module_hash,
        (select count(*)::int from public.monthly_v7_report_snapshots) snapshot_count,
        (select count(*)::int from public.monthly_v7_change_events) event_count
    `)).rows[0];
    const a = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-a');
    const windowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const created = await createTopic(db, a, windowId, randomUUID(), '隔離專題');
    const saved = await save(db, a, created.report.id, windowId, created.lease, 1, '隔離專題已保存');
    assert.equal(saved.ok, true);

    await setAuthUid(db, a.uid);
    const snapshot = result(await db.query(
      `select public.monthly_v7_topic_create_snapshot($1,$2,$3,$4,$5,$6) result`,
      ['workspace-test', a.login.user_session_id, a.clientSessionId, randomUUID(), created.report.id, 2]
    ));
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.snapshot.report.systemNumber, await taipeiSystemNumber(db, 1));

    const after = (await db.query(`
      select
        (select revision from public.monthly_v7_reports order by id limit 1) report_revision,
        (select md5(payload::text) from public.monthly_v7_report_items order by id limit 1) module_hash,
        (select count(*)::int from public.monthly_v7_report_snapshots) snapshot_count,
        (select count(*)::int from public.monthly_v7_change_events) event_count
    `)).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await db.query(`select count(*)::int count from public.monthly_v7_topic_report_snapshots`)).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('只有Owner可軟刪除未被編輯的專題，重送冪等且清單與讀取立即隱藏', async () => {
  const db = await createDatabase();
  try {
    const owner = await openAndLogin(db, '11111111-1111-4111-8111-111111111111', 'owner', 'owner-pass', 'tab-owner-delete');
    const operator = await openAndLogin(db, '22222222-2222-4222-8222-222222222222', 'operator', 'operator-pass', 'tab-operator-delete');
    const ownerWindow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const created = await createTopic(db, owner, ownerWindow, randomUUID(), '待刪專題');
    await release(db, owner, created.report.id, ownerWindow, created.lease);

    const operatorOp = randomUUID();
    await setAuthUid(db, operator.uid);
    const denied = result(await db.query(
      `select public.monthly_v7_topic_delete_report($1,$2,$3,$4,$5,$6) result`,
      ['workspace-test', operator.login.user_session_id, operator.clientSessionId,
        operatorOp, created.report.id, 1]
    ));
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'OWNER_REQUIRED');

    const operationId = randomUUID();
    await setAuthUid(db, owner.uid);
    const first = result(await db.query(
      `select public.monthly_v7_topic_delete_report($1,$2,$3,$4,$5,$6) result`,
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId,
        operationId, created.report.id, 1]
    ));
    const replay = result(await db.query(
      `select public.monthly_v7_topic_delete_report($1,$2,$3,$4,$5,$6) result`,
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId,
        operationId, created.report.id, 1]
    ));
    assert.equal(first.ok, true);
    assert.equal(first.deleted, true);
    assert.deepEqual(replay, first);

    const persisted = (await db.query(
      `select deleted_at is not null deleted, revision, updated_by_user_id from public.monthly_v7_topic_reports where id=$1`,
      [created.report.id]
    )).rows[0];
    assert.equal(persisted.deleted, true);
    assert.equal(Number(persisted.revision), 2);
    assert.equal(persisted.updated_by_user_id, owner.login.user.id);

    const listed = result(await db.query(
      `select public.monthly_v7_topic_list_reports($1,$2,$3) result`,
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId]
    ));
    assert.equal(listed.reports.some((entry) => entry.id === created.report.id), false);
    const loaded = result(await db.query(
      `select public.monthly_v7_topic_get_report($1,$2,$3,$4) result`,
      ['workspace-test', owner.login.user_session_id, owner.clientSessionId, created.report.id]
    ));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'ENTITY_NOT_FOUND');
  } finally {
    await db.close();
  }
});
