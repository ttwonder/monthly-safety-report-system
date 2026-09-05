const { test, expect } = require('@playwright/test');

// Real Chromium IndexedDB/localStorage, isolated from the report's boot and RPCs.
test.beforeEach(async ({ page }) => {
  await page.goto('/__fake_state');
  await page.addScriptTag({ url: '/monthly-collaboration-core.js' });
  await page.addScriptTag({ url: '/monthly-collaboration-client.js' });
});

test('recovery storage migrates legacy bytes atomically and keeps unrelated settings', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const keys = {
      'monthly_v7_draft:module:legacy': '{"payload":{"title":"舊稿"},"baseRevision":4}',
      'monthly_v7_pending:save_module_batch:legacy': '{"operationId":"00000000-0000-4000-8000-000000000001","signature":"原始操作"}',
      'monthly_v7_claim_denied_draft:module:legacy': '{"denied":true}'
    };
    Object.entries(keys).forEach(([key, value]) => localStorage.setItem(key, value));
    localStorage.setItem('unrelated-setting', 'keep');
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    const first = await new Store(indexedDB, localStorage, { name: 'quota-migrate' }).initialize();
    const firstOk = Object.entries(keys).every(([key, value]) => first.getItem(key) === value && localStorage.getItem(key) === null);
    first.db.close(); first.channel?.close();
    const second = await new Store(indexedDB, localStorage, { name: 'quota-migrate' }).initialize();
    const reopenedOk = Object.entries(keys).every(([key, value]) => second.getItem(key) === value);
    return { firstOk, reopenedOk, unrelated: localStorage.getItem('unrelated-setting') };
  })).toEqual({ firstOk: true, reopenedOk: true, unrelated: 'keep' });
});

test('recovery storage does not remove legacy data when import aborts after request success', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const key = 'monthly_v7_draft:module:abort-import';
    localStorage.setItem(key, '唯一舊稿');
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const req = original.apply(this, args);
      if (this.transaction.db.name === 'quota-import-abort') req.addEventListener('success', () => this.transaction.abort());
      return req;
    };
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    let code;
    try { await new Store(indexedDB, localStorage, { name: 'quota-import-abort' }).initialize(); }
    catch (error) { code = error.code; }
    finally { IDBObjectStore.prototype.put = original; }
    const retained = localStorage.getItem(key);
    const retry = await new Store(indexedDB, localStorage, { name: 'quota-import-abort' }).initialize();
    return { code, retained, recovered: retry.getItem(key) };
  })).toEqual({ code: 'LOCAL_DRAFT_STORAGE_FAILED', retained: '唯一舊稿', recovered: '唯一舊稿' });
});

test('recovery storage restores a single draft larger than native localStorage quota', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    const key = 'monthly_v7_draft:module:large';
    const value = '大'.repeat(6500000);
    let nativeQuota = false;
    try { localStorage.setItem(key, value); } catch (error) { nativeQuota = error.name === 'QuotaExceededError'; }
    const first = await new Store(indexedDB, localStorage, { name: 'quota-large' }).initialize();
    first.setItem(key, value);
    await first.flush();
    first.db.close(); first.channel?.close();
    const second = await new Store(indexedDB, localStorage, { name: 'quota-large' }).initialize();
    return { nativeQuota, exact: second.getItem(key) === value, pending: second.hasUnflushed() };
  })).toEqual({ nativeQuota: true, exact: true, pending: false });
});

test('recovery storage keeps failed updates in memory and old durable bytes until retry commits', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    const store = await new Store(indexedDB, localStorage, { name: 'quota-abort-write' }).initialize();
    const key = 'monthly_v7_pending:save_module:test';
    store.setItem(key, 'old'); await store.flush();
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const req = original.apply(this, args);
      if (this.transaction.db.name === 'quota-abort-write') req.addEventListener('success', () => this.transaction.abort());
      return req;
    };
    let code;
    try { store.setItem(key, 'new'); await store.flush(); } catch (error) { code = error.code; }
    finally { IDBObjectStore.prototype.put = original; }
    const failedDirty = store.hasUnflushed();
    const reader = await new Store(indexedDB, localStorage, { name: 'quota-abort-write' }).initialize();
    const before = reader.getItem(key);
    await store.flush(); await reader.refresh();
    return { code, failedDirty, memory: store.getItem(key), before, after: reader.getItem(key) };
  })).toEqual({ code: 'LOCAL_DRAFT_STORAGE_FAILED', failedDirty: true, memory: 'new', before: 'old', after: 'new' });
});

test('recovery storage preserves newer input queued while an earlier transaction is committing', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    const store = await new Store(indexedDB, localStorage, { name: 'quota-trailing' }).initialize();
    const key = 'monthly_v7_draft:module:trailing';
    store.setItem(key, 'A');
    const saving = store.flush();
    store.setItem(key, 'B');
    await saving;
    const reader = await new Store(indexedDB, localStorage, { name: 'quota-trailing' }).initialize();
    return { memory: store.getItem(key), durable: reader.getItem(key), pending: store.hasUnflushed() };
  })).toEqual({ memory: 'B', durable: 'B', pending: false });
});

test('recovery storage allows disjoint tab writes but never overwrites a conflicting pending operation', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const Store = MonthlyCollaborationClient.DurableDraftStorage;
    const a = await new Store(indexedDB, localStorage, { name: 'quota-tabs' }).initialize();
    const b = await new Store(indexedDB, localStorage, { name: 'quota-tabs' }).initialize();
    a.schedule = b.schedule = () => {};
    a.setItem('monthly_v7_draft:module:A', 'A');
    b.setItem('monthly_v7_draft:module:B', 'B');
    await Promise.all([a.flush(), b.flush()]);
    await Promise.all([a.refresh(), b.refresh()]);
    const key = 'monthly_v7_pending:save_module:same';
    a.setItem(key, 'operation-A'); b.setItem(key, 'operation-B');
    const outcomes = await Promise.allSettled([a.flush(), b.flush()]);
    const reader = await new Store(indexedDB, localStorage, { name: 'quota-tabs' }).initialize();
    return {
      disjoint: reader.getItem('monthly_v7_draft:module:A') === 'A' && reader.getItem('monthly_v7_draft:module:B') === 'B',
      committed: outcomes.filter(r => r.status === 'fulfilled').length,
      blocked: outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'LOCAL_DRAFT_STORAGE_FAILED').length,
      bothInMemory: a.getItem(key) === 'operation-A' && b.getItem(key) === 'operation-B'
    };
  })).toEqual({ disjoint: true, committed: 1, blocked: 1, bothInMemory: true });
});
