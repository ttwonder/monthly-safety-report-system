'use strict';

const { test, expect } = require('@playwright/test');

async function enterAndLogin(page, username, password) {
  await page.goto('/');
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  await page.locator('#v5-login-username').fill(username);
  await page.locator('#v5-login-password').fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText(username === 'owner' ? 'Owner A' : 'Operator B');
  await expect(page.locator('#tableBody tr')).toHaveCount(2);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__fake_reset');
});

test('兩個瀏覽器同項排他、不同 module 並行保存且不互相覆蓋', async ({ browser, request }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  pageA.on('pageerror', (error) => errors.push(`A:${error.message}`));
  pageB.on('pageerror', (error) => errors.push(`B:${error.message}`));

  await enterAndLogin(pageA, 'owner', 'owner-pass');
  await enterAndLogin(pageB, 'operator', 'operator-pass');

  const rowA1 = pageA.locator('#tableBody tr').nth(0);
  const titleA1 = rowA1.locator('td').nth(1).locator('.editable-div');
  await titleA1.click();
  await expect(rowA1.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(titleA1).toHaveAttribute('contenteditable', 'true');

  const rowB1 = pageB.locator('#tableBody tr').nth(0);
  const titleB1 = rowB1.locator('td').nth(1).locator('.editable-div');
  await titleB1.click();
  await expect(titleB1).toHaveAttribute('contenteditable', 'false');
  await expect(pageB.locator('#v4-cloud-runtime-status')).toContainText('此項目目前由「Owner A」編輯，請稍後再試。');
  await expect(pageB.locator('#v4-cloud-runtime-status')).not.toContainText('LEASE_HELD');

  const rowB2 = pageB.locator('#tableBody tr').nth(1);
  const titleB2 = rowB2.locator('td').nth(1).locator('.editable-div');
  await titleB2.click();
  await expect(rowB2.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(titleB2).toHaveAttribute('contenteditable', 'true');

  await titleA1.click();
  await titleA1.fill('A 已由 Owner 保存');
  await pageA.locator('#mainTitle').click();
  await expect.poll(async () => (await request.get('/__fake_state')).json().then((state) => state.modules[0].payload.title.replace(/<br>$/i, ''))).toBe('A 已由 Owner 保存');

  await titleB2.click();
  await titleB2.fill('B 已由 Operator 保存');
  await pageB.locator('#mainTitle').click();
  await expect.poll(async () => (await request.get('/__fake_state')).json().then((state) => state.modules[1].payload.title.replace(/<br>$/i, ''))).toBe('B 已由 Operator 保存');

  const state = await (await request.get('/__fake_state')).json();
  expect(state.modules.map((module) => module.payload.title.replace(/<br>$/i, ''))).toEqual(['A 已由 Owner 保存', 'B 已由 Operator 保存']);
  expect(state.modules.map((module) => module.revision)).toEqual([2, 2]);
  expect(errors).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('未修改 module 離開後立即釋放，另一瀏覽器不必等待 TTL', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  pageA.on('pageerror', (error) => errors.push(`A:${error.message}`));
  pageB.on('pageerror', (error) => errors.push(`B:${error.message}`));

  await enterAndLogin(pageA, 'owner', 'owner-pass');
  await enterAndLogin(pageB, 'operator', 'operator-pass');

  const rowA = pageA.locator('#tableBody tr').first();
  const titleA = rowA.locator('td').nth(1).locator('.editable-div');
  await titleA.click();
  await expect(rowA.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');

  await pageA.locator('#v5TopStatus').click();
  await expect(rowA.locator('.v7-item-lock-badge')).toHaveText('點一下取得編輯權');

  const rowB = pageB.locator('#tableBody tr').first();
  const titleB = rowB.locator('td').nth(1).locator('.editable-div');
  await titleB.click();
  await expect(rowB.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(titleB).toHaveAttribute('contenteditable', 'true');
  expect(errors).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('未提交的 module 變更離開後仍保留 lease，不提前放鎖', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');

  const row = page.locator('#tableBody tr').first();
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await title.evaluate((element) => element.removeAttribute('onblur'));
  await title.fill('尚未提交的本機內容');
  await page.locator('#v5TopStatus').click();
  await page.waitForTimeout(700);

  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveText('尚未提交的本機內容');
  expect(errors).toEqual([]);
});

test('full snapshot catch-up 不覆蓋尚未 blur 的本機 module', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');
  const row = page.locator('#tableBody tr').first();
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await title.fill('尚未 blur 的本機文字');
  await request.post('/__fake_structure_change');
  await page.evaluate(() => window.MonthlyV7App.client.catchUp());
  await expect(page.locator('#tableBody tr')).toHaveCount(3);
  await expect(page.locator('#tableBody tr').first().locator('td').nth(1).locator('.editable-div')).toHaveText('尚未 blur 的本機文字');
  await expect(page.locator('#tableBody')).toContainText('遠端新增模塊');
  expect(errors).toEqual([]);
});

test('V7 PDF 列印區直接使用 immutable snapshot，而非 live editor', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');
  await expect(page.locator('#tableBody')).toContainText('A 原始項目');
  await page.evaluate(() => {
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
    printV1SelectedPdf();
  });
  await expect(page.locator('body')).toHaveAttribute('data-print-source', 'snapshot');
  await expect(page.locator('#pdfPrintArea')).toContainText('正式快照模塊');
  await expect.poll(() => page.evaluate(() => window.__v7PrintCalled)).toBe(true);
  expect(errors).toEqual([]);
});
