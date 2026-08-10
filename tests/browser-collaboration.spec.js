'use strict';

const { test, expect } = require('@playwright/test');

async function enterAndLogin(page, username, password) {
  await page.goto('/');
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.MonthlyV7App
    && window.MonthlyV7App.client
    && window.MonthlyV7App.client.siteSession
    && window.MonthlyV7App.client.siteSession.id
  )), { message: 'V7 authoritative site session should be ready before user login' }).toBe(true);
  await page.locator('#v5-login-username').fill(username);
  await page.locator('#v5-login-password').fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText(username === 'owner' ? 'Owner A' : 'Operator B');
  await expect(page.locator('#tableBody tr')).toHaveCount(2);
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

test.beforeEach(async ({ request }) => {
  await request.post('/__fake_reset');
});

test('月報項目改為兩層卡片且不改寫既有 module payload', async ({ page, request }) => {
  await page.setViewportSize({ width: 1240, height: 1000 });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const before = await (await request.get('/__fake_state')).json();
  const row = page.locator('#tableBody tr').first();

  await expect(row).toHaveClass(/module-card-row/);
  await expect(row.locator('.module-index-label')).toHaveText('項次：');
  await expect(row.locator('.module-title-label')).toHaveText('報告條目：');
  await expect(row.locator('.module-actions-label')).toHaveText('操作：');
  await expect(row.locator('.module-content-cell [data-col-index="0"]')).toHaveText('A 內容');
  await expect(page.locator('#reportTable thead')).toBeHidden();

  const geometry = await row.evaluate((element) => {
    const rect = (selector) => {
      const box = element.querySelector(selector).getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
    };
    const rowBox = element.getBoundingClientRect();
    return {
      row: { left: rowBox.left, right: rowBox.right, top: rowBox.top, bottom: rowBox.bottom, width: rowBox.width },
      index: rect('.module-index-cell'),
      title: rect('.module-title-cell'),
      actions: rect('.module-actions-cell'),
      content: rect('.module-content-cell'),
      editable: rect('.module-content-cell [data-col-index="0"]')
    };
  });
  expect(geometry.content.top).toBeGreaterThanOrEqual(Math.max(geometry.index.bottom, geometry.title.bottom, geometry.actions.bottom) - 1);
  expect(geometry.content.width).toBeGreaterThanOrEqual(geometry.row.width - 2);
  expect(geometry.content.top - geometry.row.top).toBeLessThanOrEqual(110);
  const labelTops = await row.locator('.module-field-label').evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().top));
  expect(Math.max(...labelTops) - Math.min(...labelTops)).toBeLessThanOrEqual(12);
  expect(geometry.editable.width).toBeGreaterThan(geometry.content.width * 0.9);
  expect(geometry.title.width).toBeGreaterThan(geometry.index.width);

  await page.emulateMedia({ media: 'print' });
  const printGeometry = await row.evaluate((element) => {
    const box = (selector) => element.querySelector(selector).getBoundingClientRect();
    const rowBox = element.getBoundingClientRect();
    const contentBox = box('.module-content-cell');
    const indexBox = box('.module-index-cell');
    const titleBox = box('.module-title-cell');
    return {
      rowWidth: rowBox.width,
      contentWidth: contentBox.width,
      contentTop: contentBox.top,
      metaBottom: Math.max(indexBox.bottom, titleBox.bottom),
      actionsDisplay: getComputedStyle(element.querySelector('.module-actions-cell')).display,
      headerDisplay: getComputedStyle(document.querySelector('#reportTable thead')).display
    };
  });
  expect(printGeometry.actionsDisplay).toBe('none');
  expect(printGeometry.headerDisplay).toBe('none');
  expect(printGeometry.contentWidth).toBeGreaterThanOrEqual(printGeometry.rowWidth - 2);
  expect(printGeometry.contentTop).toBeGreaterThanOrEqual(printGeometry.metaBottom - 1);
  await page.emulateMedia({ media: 'screen' });

  const after = await (await request.get('/__fake_state')).json();
  expect(after.modules.map((module) => module.payload)).toEqual(before.modules.map((module) => module.payload));
});

test('Owner 可確認刪除不需要的項目，normalized authority 保留其餘 module', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const before = await (await request.get('/__fake_state')).json();
  const retained = structuredClone(before.modules[1]);
  const dialogs = [];
  let confirmDelete = false;
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    if (confirmDelete) await dialog.accept();
    else await dialog.dismiss();
  });

  const firstRow = page.locator('#tableBody tr').first();
  const deleteButton = firstRow.getByRole('button', { name: '刪除項目 1' });
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  await expect(page.locator('#tableBody tr')).toHaveCount(2);
  const afterCancel = await (await request.get('/__fake_state')).json();
  expect(afterCancel.modules).toEqual(before.modules);
  expect(afterCancel.deletedModules).toEqual([]);

  confirmDelete = true;
  await deleteButton.click();

  await expect(page.locator('#tableBody tr')).toHaveCount(1);
  await expect(page.locator('#tableBody tr').first()).toContainText('B 原始項目');
  expect(dialogs).toHaveLength(2);
  expect(dialogs.every((message) => message.includes('確定要刪除'))).toBe(true);
  const after = await (await request.get('/__fake_state')).json();
  expect(after.modules).toHaveLength(1);
  expect(after.modules[0].id).toBe(retained.id);
  expect(after.modules[0].payload).toEqual(retained.payload);
  expect(after.deletedModules).toContain(before.modules[0].id);
});

test('100% 縮放時工具列換行、文字可讀且無水平破版', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await expect(page.locator('.toolbar-advanced-group')).toBeVisible();
  await expect(page.locator('.toolbar-block-group')).toContainText('插入區塊:');

  const measure = () => page.evaluate(() => {
    const px = (selector, property) => parseFloat(getComputedStyle(document.querySelector(selector))[property]);
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const toolbar = document.querySelector('#richEditorToolbar');
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      toolbarClientWidth: toolbar.clientWidth,
      toolbarScrollWidth: toolbar.scrollWidth,
      toolbar: box('#richEditorToolbar'),
      advanced: box('.toolbar-advanced-group'),
      blocks: box('.toolbar-block-group'),
      status: box('#v5TopStatus'),
      toolbarButtonFont: px('#richEditorToolbar .toolbar-btn', 'fontSize'),
      toolbarButtonHeight: box('#richEditorToolbar .toolbar-btn').height,
      tabFont: px('.v1-tab-btn', 'fontSize'),
      statusFont: px('#v5TopStatus', 'fontSize'),
      contentFont: px('.module-content-cell .editable-div', 'fontSize'),
      stackMinWidth: px('.editor-toolbar-stack', 'minWidth')
    };
  });

  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    const geometry = await measure();
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.toolbarScrollWidth).toBeLessThanOrEqual(geometry.toolbarClientWidth + 1);
    expect(geometry.status.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.blocks.top).toBeGreaterThan(geometry.advanced.top + 8);
    expect(geometry.toolbarButtonFont).toBeGreaterThanOrEqual(14);
    expect(geometry.toolbarButtonHeight).toBeGreaterThanOrEqual(32);
    expect(geometry.tabFont).toBeGreaterThanOrEqual(14);
    expect(geometry.statusFont).toBeGreaterThanOrEqual(13);
    expect(geometry.contentFont).toBeGreaterThanOrEqual(16);
    expect(geometry.stackMinWidth).toBe(0);
    expect(geometry.toolbar.height).toBeLessThan(520);
  }
});

test('長月報捲動時頁首與工具列保持可見，不會只剩固定漸層遮罩', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    const content = document.querySelector('.module-content-cell');
    content.style.minHeight = '5000px';
    refreshEditorStickyOffsets();
    window.scrollTo(0, 2200);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);

  const geometry = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      tabs: box('#v1TabsBar'),
      toolbar: box('#richEditorToolbar'),
      shield: box('#v1StickyShield')
    };
  });

  expect(geometry.tabs.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(geometry.tabs.bottom - 1);
  expect(geometry.toolbar.top).toBeLessThanOrEqual(geometry.tabs.bottom + 1);
  expect(geometry.toolbar.bottom).toBeGreaterThanOrEqual(geometry.shield.bottom - 12);
});

test('進站與登入後最左上角使用同一份 FPMC Logo 且不造成水平破版', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  const gateLogo = page.locator('#siteAccessBrandLogo');
  await expect(gateLogo).toBeVisible();
  await expect(gateLogo).toHaveAttribute('alt', '台塑海運 FPMC Logo');
  await expect(gateLogo).toHaveAttribute('src', './assets/fpmc-logo.png');
  const gateLogoGeometry = await gateLogo.evaluate((image) => {
    const rect = image.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    };
  });
  expect(gateLogoGeometry.left).toBeLessThanOrEqual(32);
  expect(gateLogoGeometry.top).toBeLessThanOrEqual(32);
  expect(gateLogoGeometry.naturalWidth).toBe(241);
  expect(gateLogoGeometry.naturalHeight).toBe(197);
  expect(gateLogoGeometry.width / gateLogoGeometry.height).toBeCloseTo(241 / 197, 2);

  await enterAndLogin(page, 'owner', 'owner-pass');
  const mainLogo = page.locator('#v1BrandLogo');
  await expect(mainLogo).toBeVisible();
  await expect(mainLogo).toHaveAttribute('alt', '台塑海運 FPMC Logo');
  await expect(mainLogo).toHaveAttribute('src', './assets/fpmc-logo.png');

  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await settleLayout(page);
    const geometry = await page.evaluate(() => {
      const image = document.querySelector('#v1BrandLogo');
      const tabs = document.querySelector('#v1TabsBar');
      const firstTab = tabs.querySelector('.v1-tab-btn');
      const imageBox = image.getBoundingClientRect();
      const tabsBox = tabs.getBoundingClientRect();
      const firstTabBox = firstTab.getBoundingClientRect();
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        image: { left: imageBox.left, right: imageBox.right, width: imageBox.width, height: imageBox.height },
        tabs: { left: tabsBox.left, right: tabsBox.right },
        firstTab: { left: firstTabBox.left }
      };
    });
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.image.left).toBeLessThanOrEqual(geometry.tabs.left + 12);
    expect(geometry.image.right).toBeLessThanOrEqual(geometry.firstTab.left + 1);
    expect(geometry.image.width / geometry.image.height).toBeCloseTo(241 / 197, 2);
    expect(geometry.tabs.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  }
});

test('編輯工具列可獨立收合與固定，四種組合皆可逆且 sticky shield 跟隨重算', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enterAndLogin(page, 'owner', 'owner-pass');

  const toolbar = page.locator('#richEditorToolbar');
  const controls = page.locator('#toolbarPreferenceControls');
  const pin = page.locator('#toolbarPinToggle');
  const collapse = page.locator('#toolbarCollapseToggle');
  const content = page.locator('#editorToolbarContent');

  await expect(controls).toBeVisible();
  await expect(content).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).toHaveAttribute('aria-label', '固定顯示工具列');
  await expect(pin).toContainText('固定顯示');
  await expect(pin).toContainText('已固定');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(collapse).toContainText('收合');
  const expandedHeight = await toolbar.evaluate((element) => element.getBoundingClientRect().height);
  expect(await toolbar.evaluate((element) => getComputedStyle(element).position)).toBe('sticky');

  // 收合＋固定：完整內容隱藏，但最小控制列仍可操作並跟隨捲動。
  await collapse.click();
  await settleLayout(page);
  await expect(content).toBeHidden();
  await expect(controls).toBeVisible();
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await expect(collapse).toContainText('展開');
  await expect(toolbar).toHaveAttribute('data-toolbar-collapsed', 'true');
  const collapsedHeight = await toolbar.evaluate((element) => element.getBoundingClientRect().height);
  expect(collapsedHeight).toBeLessThan(expandedHeight - 60);

  await page.evaluate(() => {
    document.querySelector('.module-content-cell').style.minHeight = '5000px';
    refreshEditorStickyOffsets();
    window.scrollTo(0, 2200);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await settleLayout(page);
  let geometry = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return { tabs: box('#v1TabsBar'), toolbar: box('#richEditorToolbar'), shield: box('#v1StickyShield') };
  });
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(geometry.tabs.bottom - 1);
  expect(geometry.toolbar.top).toBeLessThanOrEqual(geometry.tabs.bottom + 1);
  expect(geometry.shield.bottom).toBeGreaterThanOrEqual(geometry.toolbar.bottom + 7);

  // 展開＋取消固定：工具列恢復內容後，隨文件正常捲走；tabs 仍保持可見。
  await collapse.click();
  await settleLayout(page);
  await expect(content).toBeVisible();
  await pin.click();
  await settleLayout(page);
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(pin).toContainText('固定顯示');
  await expect(pin).toHaveAttribute('aria-label', '固定顯示工具列');
  await expect(pin).toContainText('未固定');
  await expect(toolbar).toHaveAttribute('data-toolbar-pinned', 'false');
  expect(await toolbar.evaluate((element) => getComputedStyle(element).position)).not.toBe('sticky');
  geometry = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return { tabs: box('#v1TabsBar'), toolbar: box('#richEditorToolbar'), shield: box('#v1StickyShield') };
  });
  expect(geometry.toolbar.bottom).toBeLessThan(0);
  expect(geometry.tabs.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.shield.bottom).toBeLessThanOrEqual(geometry.tabs.bottom + 9);

  // 收合＋取消固定，再重新固定；兩個狀態互不覆蓋。
  await page.evaluate(() => window.scrollTo(0, 0));
  await settleLayout(page);
  await collapse.click();
  await settleLayout(page);
  await expect(content).toBeHidden();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(toolbar).toHaveAttribute('data-toolbar-collapsed', 'true');
  await pin.click();
  await settleLayout(page);
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).toHaveAttribute('aria-label', '固定顯示工具列');
  await expect(pin).toContainText('已固定');
  await expect(content).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 2200));
  await settleLayout(page);
  await expect(controls).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await expect(controls).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await settleLayout(page);
  const responsive = await page.evaluate(() => {
    const controlsBox = document.querySelector('#toolbarPreferenceControls').getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      controlsRight: controlsBox.right
    };
  });
  expect(responsive.documentScrollWidth).toBeLessThanOrEqual(responsive.viewportWidth + 1);
  expect(responsive.controlsRight).toBeLessThanOrEqual(responsive.viewportWidth + 1);
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
