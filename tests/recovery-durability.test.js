'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MonthlyV7Client } = require('../monthly-collaboration-client.js');

function setup(flush) {
  const entries = new Map();
  const calls = [];
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
    flush
  };
  const client = new MonthlyV7Client({
    transport: { rpc: async (name, params) => { calls.push({ name, params }); return { ok: true, revision: 2 }; } },
    draftStorage: storage,
    idFactory: () => '00000000-0000-4000-8000-000000000001'
  });
  client.user = { id: 'fixture-user', role: 'owner' };
  client.userSession = { id: 'fixture-session' };
  return { client, storage, calls };
}

const rpc = 'monthly_v7_save_module';
const key = 'monthly_v7_pending:save_module:m1';

test('pending transaction must complete before RPC; actor change during the wait fences dispatch', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client, storage, calls } = setup(() => gate);
  const saving = client.executeOperation(rpc, { p_payload: { title: 'draft' } }, 'save_module:m1');
  assert.ok(storage.getItem(key));
  assert.equal(calls.length, 0);
  client.sessionGeneration += 1;
  release();
  await assert.rejects(saving, error => error.code === 'STALE_SESSION_RESPONSE');
  assert.equal(calls.length, 0);
  assert.ok(storage.getItem(key));
});

test('pending storage failure stops retries and does not leave the operation receipt SAVING', async () => {
  const error = Object.assign(new Error('disk unavailable'), { code: 'LOCAL_DRAFT_STORAGE_FAILED' });
  const { client, storage, calls } = setup(async () => { throw error; });
  await assert.rejects(client.executeOperation(rpc, { p_payload: { title: 'draft' } }, 'save_module:m1'), error);
  assert.equal(calls.length, 0);
  assert.ok(storage.getItem(key));
  assert.equal(client.lastOperationReceipt().state, 'LOCAL_DIRTY');
  assert.equal(client.lastOperationReceipt().errorCode, 'LOCAL_DRAFT_STORAGE_FAILED');
});

test('ACK cleanup failure retains the original operation identity for explicit same-operation replay', async () => {
  let flushCount = 0;
  const error = Object.assign(new Error('cleanup disk failure'), { code: 'LOCAL_DRAFT_STORAGE_FAILED' });
  const { client, storage, calls } = setup(async () => {
    flushCount += 1;
    if (flushCount === 2) throw error;
  });
  const params = { p_payload: { title: 'draft' } };
  await assert.rejects(client.executeOperation(rpc, params, 'save_module:m1'), error);
  assert.equal(calls.length, 1);
  const pending = JSON.parse(storage.getItem(key));
  assert.equal(pending.operationId, calls[0].params.p_operation_id);
  const result = await client.executeOperation(rpc, params, 'save_module:m1');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.p_operation_id, pending.operationId);
  assert.equal(storage.getItem(key), null);
});
