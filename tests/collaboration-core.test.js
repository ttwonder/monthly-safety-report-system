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
