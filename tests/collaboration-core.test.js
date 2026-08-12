'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../monthly-collaboration-core.js');

test('entityKey 使用穩定 entity type 與 ID，拒絕空白身分', () => {
  assert.equal(core.entityKey('module', '8d1098bc-7e0e-4d10-8dd7-01cbbd298621'), 'module:8d1098bc-7e0e-4d10-8dd7-01cbbd298621');
  assert.equal(core.entityKey('record:inspection', 'record-1'), 'record:inspection:record-1');
  assert.throws(() => core.entityKey('module', ''), /entity id/i);
  assert.throws(() => core.entityKey('', 'item-1'), /entity type/i);
});

test('orderedTargets 依 entity key 固定排序並移除重複目標', () => {
  const result = core.orderedTargets([
    { entityType: 'module', entityId: 'b' },
    { entityType: 'record:inspection', entityId: 'z' },
    { entityType: 'module', entityId: 'a' },
    { entityType: 'module', entityId: 'b' }
  ]);
  assert.deepEqual(result.map((entry) => entry.key), [
    'module:a',
    'module:b',
    'record:inspection:z'
  ]);
});

test('leaseCanWrite 只接受未過期且 holder、session、lease、fence 全相同的租約', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const lease = {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-1',
    holderUserId: 'u1', clientSessionId: 'tab-a', fencingToken: 7,
    expiresAt: '2026-08-10T12:01:30Z'
  };
  const expected = {
    entityType: 'module', entityId: 'm1', leaseId: 'lease-1',
    holderUserId: 'u1', clientSessionId: 'tab-a', fencingToken: 7
  };
  assert.equal(core.leaseCanWrite(lease, expected, now), true);
  assert.equal(core.leaseCanWrite(lease, { ...expected, fencingToken: 6 }, now), false);
  assert.equal(core.leaseCanWrite(lease, { ...expected, clientSessionId: 'tab-b' }, now), false);
  assert.equal(core.leaseCanWrite(lease, expected, Date.parse('2026-08-10T12:01:30Z')), false);
});

test('legacyBundleFromSnapshot 保留逐項身分並排除瀏覽器不應讀取的密碼雜湊', () => {
  const bundle = core.legacyBundleFromSnapshot({
    watermark: 12,
    report: { id: 'r1', legacyFileId: 'legacy-report', title: '月報', date: '2026-08-10', period: { startM: '8', startD: '1', endM: '8', endD: '31' }, revision: 3 },
    modules: [{ id: 'm1', legacyItemId: 9, revision: 4, sortRank: 1, payload: { title: '項目', columns: ['內容'], selectedForPdf: true } }],
    records: [{ id: 'x1', recordType: 'inspections', revision: 2, payload: { vessel: 'A', date: '2026-08-01' } }],
    users: [{ id: 'u1', username: 'owner', displayName: 'Owner', role: 'owner', passwordHash: 'DO_NOT_LEAK' }],
    siteAccess: { passwordHash: 'DO_NOT_LEAK' }
  });
  assert.equal(bundle.version, 7);
  assert.equal(bundle.fileId, 'legacy-report');
  assert.equal(bundle.report.modules[0]._v7Id, 'm1');
  assert.equal(bundle.report.modules[0]._v7Revision, 4);
  assert.equal(bundle.records.inspections[0]._v7Id, 'x1');
  assert.equal(bundle.users[0].username, 'owner');
  assert.equal('passwordHash' in bundle.users[0], false);
  assert.equal('siteAccess' in bundle, false);
  assert.equal(JSON.stringify(bundle).includes('DO_NOT_LEAK'), false);
});

test('首次 normalized 載入按 legacy ID 對回本機內容與原項次，不以陣列位置搬動內容', () => {
  const reconciled = core.reconcileLegacyLocalModules([
    { id: 'v7-b', legacyItemId: '2', sortRank: 1, revision: 4, updatedAt: '2026-08-10T00:00:00Z', payload: { id: 2, title: '雲端二', columns: ['雲端二'] } },
    { id: 'v7-a', legacyItemId: '1', sortRank: 2, revision: 7, updatedAt: '2026-08-10T00:00:00Z', payload: { id: 1, title: '雲端一', columns: ['雲端一'] } }
  ], [
    { id: 1, title: '本機一', columns: ['使用者編輯一'] },
    { id: 2, title: '本機二', columns: ['使用者編輯二'] }
  ], { localTimestamp: Date.parse('2026-08-11T00:00:00Z') });

  assert.deepEqual(reconciled.serverRows.map((row) => row.id), ['v7-b', 'v7-a']);
  assert.deepEqual(reconciled.serverRows.map((row) => row._displaySortRank), [2, 1]);
  assert.equal(reconciled.orderChanged, true);
  assert.deepEqual(reconciled.recovered.map((row) => ({
    entityId: row.entityId,
    legacyItemId: row.legacyItemId,
    baseRevision: row.baseRevision,
    content: row.payload.columns[0]
  })), [
    { entityId: 'v7-a', legacyItemId: '1', baseRevision: 7, content: '使用者編輯一' },
    { entityId: 'v7-b', legacyItemId: '2', baseRevision: 4, content: '使用者編輯二' }
  ]);
  const bundle = core.legacyBundleFromSnapshot({
    report: { id: 'r1', legacyFileId: 'legacy', revision: 1 },
    modules: reconciled.serverRows.map((row) => {
      const recovery = reconciled.recovered.find((entry) => entry.entityId === row.id);
      return recovery ? { ...row, payload: recovery.payload } : row;
    }),
    localOnlyModules: reconciled.localOnlyModules,
    records: [], users: []
  });
  assert.deepEqual(bundle.report.modules.map((row) => [String(row.id), row.columns[0]]), [
    ['1', '使用者編輯一'],
    ['2', '使用者編輯二']
  ]);
});

test('本機獨有項目只進隔離候選，不注入 live bundle 或通用保存意圖', () => {
  const reconciled = core.reconcileLegacyLocalModules([
    { id: 'v7-a', legacyItemId: '1', sortRank: 1, revision: 2, updatedAt: '2026-08-10T00:00:00Z', payload: { id: 1, title: '既有' } }
  ], [
    { id: 1, title: '既有' },
    { id: 999, title: '本機新增', columns: ['不能遺失'] }
  ], { localTimestamp: Date.parse('2026-08-11T00:00:00Z') });
  assert.equal(reconciled.localOnlyModules.length, 0);
  assert.equal(reconciled.quarantinedModules.length, 1);
  assert.equal(reconciled.quarantinedModules[0].payload.title, '本機新增');
  assert.equal(reconciled.quarantinedModules[0].reason, 'LOCAL_ONLY_AMBIGUOUS');
  const bundle = core.legacyBundleFromSnapshot({
    report: { id: 'r1', legacyFileId: 'legacy', revision: 1 },
    modules: reconciled.serverRows,
    localOnlyModules: reconciled.localOnlyModules,
    records: [], users: []
  });
  assert.deepEqual(bundle.report.modules.map((row) => String(row.id)), ['1']);
});

test('較舊、相等或缺少時間證據的 legacy 差異一律隔離且保留 server 內容與順序', () => {
  for (const localTimestamp of [
    Date.parse('2026-08-09T00:00:00Z'),
    Date.parse('2026-08-10T00:00:00Z'),
    0
  ]) {
    const reconciled = core.reconcileLegacyLocalModules([
      { id: 'v7-b', legacyItemId: '2', sortRank: 1, revision: 4, updatedAt: '2026-08-10T00:00:00Z', payload: { id: 2, title: '雲端二', columns: ['雲端二'] } },
      { id: 'v7-a', legacyItemId: '1', sortRank: 2, revision: 7, updatedAt: '2026-08-10T00:00:00Z', payload: { id: 1, title: '雲端一', columns: ['雲端一'] } }
    ], [
      { id: 1, title: '舊本機一', columns: ['不可覆蓋一'] },
      { id: 2, title: '舊本機二', columns: ['不可覆蓋二'] }
    ], { localTimestamp });

    assert.equal(reconciled.recovered.length, 0);
    assert.equal(reconciled.localOnlyModules.length, 0);
    assert.equal(reconciled.quarantinedModules.length, 2);
    assert.equal(reconciled.orderChanged, false);
    assert.deepEqual(reconciled.serverRows.map((row) => [row.id, row._displaySortRank, row.payload.columns[0]]), [
      ['v7-b', 1, '雲端二'], ['v7-a', 2, '雲端一']
    ]);
  }
});

test('新建 module 已提交但後續流程失敗時，以唯一 payload.id 對回原本 legacy 項目避免重複建立', () => {
  const reconciled = core.reconcileLegacyLocalModules([
    {
      id: 'server-created-uuid', legacyItemId: 'v7:server-created-uuid', sortRank: 1, revision: 1,
      payload: { id: 999, title: '本機新增', columns: ['已成功建立'] }
    }
  ], [
    { id: 999, title: '本機新增', columns: ['已成功建立'] }
  ], { localTimestamp: Date.parse('2026-08-11T00:00:00Z') });

  assert.equal(reconciled.localOnlyModules.length, 0);
  assert.equal(reconciled.serverRows[0]._displaySortRank, 1);
  assert.equal(reconciled.recovered.length, 0);
  const bundle = core.legacyBundleFromSnapshot({
    report: { id: 'r1', legacyFileId: 'legacy', revision: 2 },
    modules: reconciled.serverRows,
    records: [], users: []
  });
  assert.equal(String(bundle.report.modules[0].id), '999');
  assert.equal(bundle.report.modules[0]._v7Id, 'server-created-uuid');
});

test('payload.id fallback 有歧義時 fail closed，保留本機項目而不任意掛到 server module', () => {
  const reconciled = core.reconcileLegacyLocalModules([
    { id: 'server-a', legacyItemId: 'v7:server-a', sortRank: 1, revision: 1, payload: { id: 999, title: 'A' } },
    { id: 'server-b', legacyItemId: 'v7:server-b', sortRank: 2, revision: 1, payload: { id: 999, title: 'B' } }
  ], [
    { id: 999, title: '本機項目' }
  ], { localTimestamp: Date.parse('2026-08-11T00:00:00Z') });

  assert.equal(reconciled.localOnlyModules.length, 0);
  assert.equal(reconciled.quarantinedModules.length, 1);
  assert.equal(reconciled.quarantinedModules[0].payload.title, '本機項目');
  assert.equal(reconciled.recovered.length, 0);
});

test('reduceChangeEvents 依 sequence 去重排序並前進 watermark', () => {
  const result = core.reduceChangeEvents(10, [
    { sequence: 12, entityType: 'module', entityId: 'm2' },
    { sequence: 9, entityType: 'module', entityId: 'old' },
    { sequence: 11, entityType: 'module', entityId: 'm1' },
    { sequence: 12, entityType: 'module', entityId: 'm2-duplicate' }
  ]);
  assert.equal(result.watermark, 12);
  assert.deepEqual(result.events.map((event) => event.sequence), [11, 12]);
  assert.deepEqual(result.entityKeys, ['module:m1', 'module:m2']);
});
