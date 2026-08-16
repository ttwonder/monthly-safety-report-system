'use strict';

const { test, expect } = require('@playwright/test');

async function enterAndLogin(page, username, password) {
  await page.addInitScript(() => {
    const guardKey = '__topic_monthly_boot_intercepted';
    if (sessionStorage.getItem(guardKey)) return;
    sessionStorage.setItem(guardKey, '1');
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => { capturedOnload = handler; window.__topicCapturedMonthlyOnload = handler; }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__topicCapturedMonthlyOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__topicCapturedMonthlyOnload = null;
    await boot.call(window);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.client?.siteSession?.id))).toBe(true);
  let loginState = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.evaluate(({ loginUsername, loginPassword }) => {
      window.__topicLoginState = { status: 'pending', error: '' };
      window.__topicLogin = window.MonthlyV7App.login(loginUsername, loginPassword)
        .then(() => { window.__topicLoginState = { status: 'done', error: '' }; })
        .catch((error) => {
          window.__topicLoginState = {
            status: 'error',
            error: String(error?.code || error?.message || error || '')
          };
        });
    }, { loginUsername: username, loginPassword: password });
    await expect.poll(() => page.evaluate(() => window.__topicLoginState?.status || 'missing'), { timeout: 30000 })
      .toMatch(/^(done|error)$/);
    loginState = await page.evaluate(() => window.__topicLoginState);
    if (loginState.status === 'done') break;
    if (!/STALE_LOGIN_ATTEMPT/.test(loginState.error) || attempt === 1) throw new Error(loginState.error);
  }
  expect(loginState).toEqual({ status: 'done', error: '' });
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App?.client?.currentUser?.()?.username || '')).toBe(username);
}

async function openTopicList(monthlyPage) {
  await expect(monthlyPage.locator('#topicReportsEntry')).toBeVisible();
  const popupPromise = monthlyPage.waitForEvent('popup');
  await monthlyPage.locator('#topicReportsEntry').click();
  const list = await popupPromise;
  await list.waitForURL(/topic-reports\.html/);
  await expect(list.locator('#topicReportsPage')).toBeVisible({ timeout: 20000 });
  await expect(list.locator('#topicListStatus')).toContainText('已同步', { timeout: 20000 });
  return list;
}

async function createTopic(list, title) {
  await list.locator('#topicAddReport').click();
  await list.locator('#topicCreateTitle').fill(title);
  await list.locator('#topicCreateDate').fill('2026-08-16');
  const popupPromise = list.waitForEvent('popup');
  await list.locator('#topicCreateConfirm').click();
  const editor = await popupPromise;
  await editor.waitForURL(/topic-report-editor\.html\?report=/, { timeout: 20000 });
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('#topicModeBadge')).toHaveText('可編輯');
  return editor;
}

async function completeEditing(editor) {
  editor.once('dialog', (dialog) => dialog.accept());
  await editor.locator('#topicComplete').click();
  await expect(editor.locator('#topicModeBadge')).toHaveText('唯讀', { timeout: 20000 });
  await expect(editor.locator('#topicLeaseNotice')).toContainText('已釋放');
}

async function selectEditorContents(locator) {
  await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test.beforeEach(async ({ request }) => {
  await request.post('/__fake_reset');
});

test('月報紅框入口交接身份但不載入或刷新任何月報authority資料', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const before = await (await request.get('/__fake_state')).json();
  const list = await openTopicList(page);
  await expect(list.locator('#topicCurrentUser')).toContainText('Owner A');
  expect(await list.evaluate(() => Boolean(window.opener))).toBe(true);
  expect(await list.evaluate(() => Array.from(document.scripts).map((script) => script.src).some((src) => /monthly-collaboration-(?:core|client|v7)/.test(src)))).toBe(false);
  const after = await (await request.get('/__fake_state')).json();
  expect(after.report).toEqual(before.report);
  expect(after.modules).toEqual(before.modules);
  expect(after.sequence).toBe(before.sequence);
  expect(after.rpcCounts.monthly_v7_get_snapshot || 0).toBe(before.rpcCounts.monthly_v7_get_snapshot || 0);
  expect(after.rpcCounts.monthly_v7_topic_list_reports || 0).toBeGreaterThan(0);
});

test('建立、完整編輯工具、保存與完成只改topic資料且ACK後才釋放', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const monthlyBefore = await (await request.get('/__fake_state')).json();
  const list = await openTopicList(page);
  const editor = await createTopic(list, '繫泊作業安全專題');

  await expect(editor.locator('#topicSystemNumber')).toHaveText(/^SR-\d{8}-\d{3}$/);
  await expect(editor.locator('.topic-module')).toHaveCount(1);
  await editor.locator('#topicAddModule').click();
  await expect(editor.locator('.topic-module')).toHaveCount(2);
  await editor.locator('.topic-editable').first().click();
  await editor.locator('[data-insert="kpi"]').click();
  await expect(editor.locator('.topic-kpi-card')).toHaveCount(1);
  await editor.locator('#topicReportTitle').fill('繫泊作業安全專題（修訂）');
  await editor.locator('.topic-editable').first().pressSequentially(' 已完成風險盤點');
  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicRevision')).toHaveText('2', { timeout: 20000 });
  await expect(editor.locator('#topicLeaseNotice')).toContainText('已保存');

  const savedState = await (await request.get('/__fake_state')).json();
  expect(savedState.report).toEqual(monthlyBefore.report);
  expect(savedState.modules).toEqual(monthlyBefore.modules);
  expect(savedState.sequence).toBe(monthlyBefore.sequence);
  expect(savedState.topicReports).toHaveLength(1);
  expect(savedState.topicReports[0].title).toBe('繫泊作業安全專題（修訂）');
  expect(savedState.topicReports[0].revision).toBe(2);
  expect(savedState.topicReports[0].content.modules).toHaveLength(2);

  await completeEditing(editor);
  const completed = await (await request.get('/__fake_state')).json();
  expect(completed.topicReports[0].status).toBe('final');
  expect(completed.topicReports[0].revision).toBe(3);
  expect(completed.topicLeases[0].released).toBe(true);

  await list.locator('#topicRefreshReports').click();
  const listRow = list.locator('#topicReportsBody tr').filter({ hasText: '繫泊作業安全專題（修訂）' });
  await expect(listRow.locator('.topic-size-cell')).toHaveText(/^(?:\d+(?:\.\d+)?\s(?:B|KiB|MiB|GiB|TiB))$/);
  await list.locator('[data-topic-sort="logicalBytes"]').click();
  await expect(list.locator('[data-topic-sort-header="logicalBytes"]')).toHaveAttribute('aria-sort', 'ascending');
});

test('create lost ACK後同一對話框重試沿用operation與window ID且只建立一份', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  await request.post('/__fake_hang_rpc?name=monthly_v7_topic_create_report&count=1&mode=after_commit');

  await list.locator('#topicAddReport').click();
  await list.locator('#topicCreateTitle').fill('lost ACK 專題');
  const firstPopupPromise = list.waitForEvent('popup');
  await list.locator('#topicCreateConfirm').click();
  const firstPopup = await firstPopupPromise;
  await expect(list.locator('#topicListStatus')).toContainText('雲端回應逾時', { timeout: 10000 });
  await expect.poll(() => firstPopup.isClosed()).toBe(true);

  const committedUnknown = await (await request.get('/__fake_state')).json();
  expect(committedUnknown.topicReports).toHaveLength(1);
  expect(committedUnknown.topicOperations).toHaveLength(1);
  const pendingBeforeRetry = await list.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:create:')));
  expect(pendingBeforeRetry).toHaveLength(1);

  await list.reload();
  await expect(list.locator('#topicReportsPage')).toBeVisible({ timeout: 20000 });
  await list.locator('#topicAddReport').click();
  await expect(list.locator('#topicCreateTitle')).toHaveValue('lost ACK 專題');
  await expect(list.locator('#topicCreateTitle')).toHaveAttribute('readonly', '');

  const retryPopupPromise = list.waitForEvent('popup');
  await list.locator('#topicCreateConfirm').click();
  const editor = await retryPopupPromise;
  await editor.waitForURL(/topic-report-editor\.html\?report=/, { timeout: 20000 });
  await expect(editor.locator('#topicModeBadge')).toHaveText('可編輯', { timeout: 20000 });

  const recovered = await (await request.get('/__fake_state')).json();
  expect(recovered.topicReports).toHaveLength(1);
  expect(recovered.topicOperations).toHaveLength(1);
  const pendingAfterRetry = await list.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:create:')));
  expect(pendingAfterRetry).toEqual([]);
});

test('save lost ACK後reload仍可重播同一operation並清除pending與draft', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '保存lost ACK專題');
  await editor.locator('.topic-editable').first().fill('保存後回應遺失內容');
  await request.post('/__fake_hang_rpc?name=monthly_v7_topic_save_report&count=1&mode=after_commit');
  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicLeaseNotice')).toContainText('保存結果尚未確認', { timeout: 10000 });

  const unknown = await (await request.get('/__fake_state')).json();
  expect(unknown.topicReports[0].revision).toBe(2);
  expect(unknown.topicOperations).toHaveLength(2);
  expect(await editor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:save:')).length)).toBe(1);
  expect(await editor.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:')).length)).toBe(1);

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('#topicLeaseNotice')).toContainText('上一筆保存未確認');
  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicLeaseNotice')).toContainText('已保存至雲端 R2', { timeout: 20000 });

  const recovered = await (await request.get('/__fake_state')).json();
  expect(recovered.topicReports[0].revision).toBe(2);
  expect(recovered.topicOperations).toHaveLength(2);
  expect(await editor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:save:')).length)).toBe(0);
  expect(await editor.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:')).length)).toBe(0);
});

test('完成編輯保存ACK後release ACK遺失可reload確認且不誤取得新fence', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '完成釋放lost ACK專題');
  await editor.locator('.topic-editable').first().fill('完成內容已保存');
  await request.post('/__fake_hang_rpc?name=monthly_v7_topic_release_report_lease&count=1&mode=after_commit');
  editor.once('dialog', (dialog) => dialog.accept());
  await editor.locator('#topicComplete').click();
  await expect(editor.locator('#topicLeaseNotice')).toContainText('內容已保存至 R2；釋放結果未確認', { timeout: 10000 });
  await expect(editor.locator('#topicModeBadge')).toHaveText('唯讀');

  const unknown = await (await request.get('/__fake_state')).json();
  expect(unknown.topicReports[0].revision).toBe(2);
  expect(unknown.topicReports[0].status).toBe('final');
  expect(unknown.topicLeases[0].released).toBe(true);
  expect(await editor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:release-check:')).length)).toBe(1);

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('#topicModeBadge')).toHaveText('唯讀');
  await expect(editor.locator('#topicLeaseNotice')).toContainText('編輯權已釋放');
  const recovered = await (await request.get('/__fake_state')).json();
  expect(recovered.topicLeases[0].fencingToken).toBe(1);
  expect(recovered.topicLeases[0].released).toBe(true);
  expect(await editor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:release-check:')).length)).toBe(0);
});

test('快速保存ACK後不允許舊800ms timer重建已清除的本機草稿', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '快速保存草稿測試');
  const editable = editor.locator('.topic-editable').first();
  await editable.fill('快速輸入後立即保存');
  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicLeaseNotice')).toContainText('已保存至雲端', { timeout: 20000 });
  await editor.waitForTimeout(1100);
  const draftKeys = await editor.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:')));
  expect(draftKeys).toEqual([]);
});

test('create已成功但清單讀回斷線時不關閉編輯器或錯誤釋放lease', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  await request.post('/__fake_fail_rpc?name=monthly_v7_topic_list_reports&count=1');

  const editor = await createTopic(list, '讀回斷線專題');
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('#topicModeBadge')).toHaveText('可編輯');
  expect(editor.isClosed()).toBe(false);

  const state = await (await request.get('/__fake_state')).json();
  expect(state.topicReports).toHaveLength(1);
  expect(state.topicLeases).toHaveLength(1);
  expect(state.topicLeases[0].released).toBe(false);
  await expect(list.locator('#topicListStatus')).toContainText('FORCED_RPC_FAILURE');
  await expect(list.locator('#topicListStatus')).toHaveAttribute('data-tone', 'danger');
});

test('完整內容模塊、圖片附件、雙欄、Excel與正式snapshot PDF都可實際操作', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '完整工具驗證專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.click();

  for (const type of ['highlight', 'indicator-blue', 'indicator-orange', 'kpi', 'progress', 'zone', 'trend']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }
  await expect(editor.locator('.topic-highlight')).toHaveCount(1);
  await expect(editor.locator('.topic-indicator-card')).toHaveCount(2);
  await expect(editor.locator('.topic-kpi-card')).toHaveCount(1);
  await expect(editor.locator('.topic-progress-card')).toHaveCount(1);
  await expect(editor.locator('.topic-zone-card')).toHaveCount(1);
  await expect(editor.locator('.topic-trend-card')).toHaveCount(1);

  let promptCount = 0;
  const promptHandler = async (dialog) => {
    promptCount += 1;
    await dialog.accept('2');
  };
  editor.on('dialog', promptHandler);
  await editor.locator('[data-insert="table"]').click();
  await expect.poll(() => promptCount).toBe(2);
  editor.off('dialog', promptHandler);
  await expect(editor.locator('.topic-data-table:not(.topic-indicator-card):not(.topic-chart-data)')).toHaveCount(1);

  await editor.locator('[data-module-layout]').first().selectOption('1:1');
  await expect(editor.locator('.topic-module').first().locator('.topic-editable')).toHaveCount(2);
  await editor.locator('#topicImageFile').setInputFiles({
    name: 'anonymous.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg==', 'base64')
  });
  await expect(editor.locator('img.topic-inline-image')).toHaveCount(1);

  await editor.locator('[data-module-action="attachment"]').first().click();
  await editor.locator('#topicAttachmentFile').setInputFiles({
    name: 'anonymous.txt', mimeType: 'text/plain', buffer: Buffer.from('anonymous fixture', 'utf8')
  });
  await expect(editor.locator('.topic-attachment')).toContainText('anonymous.txt');

  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicRevision')).toHaveText('2', { timeout: 20000 });
  const state = await (await request.get('/__fake_state')).json();
  const module = state.topicReports[0].content.modules[0];
  expect(module.colLayout).toBe('1:1');
  expect(module.columns.join('')).toContain('data:image/png;base64');
  expect(module.attachments[0].name).toBe('anonymous.txt');
  expect(module.attachments[0].dataUrl).toMatch(/^data:text\/plain;base64,/);

  const downloadPromise = editor.waitForEvent('download');
  await editor.locator('#topicExcelExport').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^SR-\d{8}-\d{3}_完整工具驗證專題\.xlsx$/);
  const exportedPath = await download.path();
  expect(exportedPath).toBeTruthy();
  await editor.locator('#topicExcelFile').setInputFiles(exportedPath);
  await expect(editor.locator('#topicToast')).toContainText('已匯入 1 個項次');
  await expect(editor.locator('.topic-module')).toHaveCount(1);
  await expect(editor.locator('.topic-attachment')).toContainText('anonymous.txt');

  await editor.evaluate(() => {
    window.__topicPrintObserved = null;
    window.print = () => {
      window.__topicPrintObserved = {
        title: document.title,
        bodyClass: document.body.className,
        modules: document.querySelectorAll('#topicPrintModules .topic-print-module').length
      };
    };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicPrintObserved)).not.toBeNull();
  const printed = await editor.evaluate(() => window.__topicPrintObserved);
  expect(printed.title).toMatch(/^專題報告_SR-\d{8}-\d{3}_完整工具驗證專題_/);
  expect(printed.bodyClass).toContain('topic-printing-report');
  expect(printed.modules).toBeGreaterThan(0);
  await expect.poll(async () => (await (await request.get('/__fake_state')).json()).topicSnapshots.length).toBe(1);

  await list.evaluate(() => {
    window.__topicHistoryPrintObserved = null;
    window.print = () => {
      window.__topicHistoryPrintObserved = {
        title: document.title,
        bodyClass: document.body.className,
        rows: document.querySelectorAll('#topicHistoryPrintBody tr').length,
        fullModules: document.querySelectorAll('#topicHistoryPrintArea .topic-module').length
      };
    };
  });
  await list.locator('#topicPrintHistory').click();
  await expect.poll(() => list.evaluate(() => window.__topicHistoryPrintObserved)).not.toBeNull();
  const historyPrinted = await list.evaluate(() => window.__topicHistoryPrintObserved);
  expect(historyPrinted.title).toMatch(/^專題報告歷史清單_\d{4}-\d{2}-\d{2}$/);
  expect(historyPrinted.bodyClass).toContain('topic-printing-history');
  expect(historyPrinted.rows).toBeGreaterThanOrEqual(1);
  expect(historyPrinted.fullModules).toBe(0);
  const afterHistory = await (await request.get('/__fake_state')).json();
  expect(afterHistory.topicSnapshots).toHaveLength(1);
  expect(afterHistory.snapshots).toHaveLength(0);
});

test('雲端或Excel HTML載入前以allowlist清洗，不執行事件屬性、script或遠端追蹤圖片', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'HTML安全專題');
  const result = await editor.evaluate(() => {
    window.__topicXss = 0;
    const safe = window.TopicReportEditor.sanitizeStoredHtml(
      '<b class="topic-highlight" onclick="window.__topicXss=1">保留文字</b>' +
      '<script>window.__topicXss=2<\/script>' +
      '<img src="https://tracker.invalid/pixel" onerror="window.__topicXss=3">' +
      '<a href="javascript:window.__topicXss=4">危險連結</a>'
    );
    const box = document.createElement('div');
    // 測試刻意將 sanitizeStoredHtml 的已清洗結果重新解析，驗證不含可執行節點／屬性；原始不可信字串從未直接插入DOM。
    box.innerHTML = safe;
    document.body.appendChild(box);
    return {
      safe,
      scriptCount: box.querySelectorAll('script').length,
      eventCount: box.querySelectorAll('[onclick],[onerror]').length,
      remoteImageCount: box.querySelectorAll('img[src]').length,
      dangerousHrefCount: box.querySelectorAll('a[href^="javascript:"]').length,
      xss: window.__topicXss,
      text: box.textContent
    };
  });
  expect(result.scriptCount).toBe(0);
  expect(result.eventCount).toBe(0);
  expect(result.remoteImageCount).toBe(0);
  expect(result.dangerousHrefCount).toBe(0);
  expect(result.xss).toBe(0);
  expect(result.text).toContain('保留文字');
});

test('同身份重開聚焦原窗口；他人唯讀且完成釋放後才取得較新fencing token', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const ownerMonthly = await ownerContext.newPage();
  const operatorMonthly = await operatorContext.newPage();
  try {
    await enterAndLogin(ownerMonthly, 'owner', 'owner-pass');
    await enterAndLogin(operatorMonthly, 'operator', 'operator-pass');
    const ownerList = await openTopicList(ownerMonthly);
    const operatorList = await openTopicList(operatorMonthly);
    const first = await createTopic(ownerList, '排他編輯測試');
    const reportId = new URL(first.url()).searchParams.get('report');

    const ownerPageCount = ownerContext.pages().length;
    const firstStateBeforeFocus = await first.evaluate(() => window.TopicReportEditor.getState());
    await ownerList.evaluate((id) => window.TopicReportsPage.openReport(id), reportId);
    await first.waitForTimeout(300);
    expect(ownerContext.pages()).toHaveLength(ownerPageCount);
    await expect(first.locator('#topicModeBadge')).toHaveText('可編輯');
    const firstStateAfterFocus = await first.evaluate(() => window.TopicReportEditor.getState());
    expect(firstStateAfterFocus.editorWindowId).toBe(firstStateBeforeFocus.editorWindowId);
    expect(firstStateAfterFocus.fencingToken).toBe(firstStateBeforeFocus.fencingToken);

    const manualSecondPromise = first.waitForEvent('popup');
    await first.evaluate(() => window.open(window.location.href, '_blank'));
    const manualSecond = await manualSecondPromise;
    await expect(manualSecond.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
    await expect(manualSecond.locator('#topicModeBadge')).toHaveText('唯讀');
    const manualState = await manualSecond.evaluate(() => window.TopicReportEditor.getState());
    expect(manualState.editorWindowId).not.toBe(firstStateBeforeFocus.editorWindowId);
    await manualSecond.close();

    const secondPromise = operatorList.waitForEvent('popup');
    await operatorList.evaluate((id) => window.TopicReportsPage.openReport(id), reportId);
    const second = await secondPromise;
    await second.waitForURL(/topic-report-editor\.html/);
    await expect(second.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
    await expect(second.locator('#topicModeBadge')).toHaveText('唯讀');
    await expect(second.locator('#topicLeaseNotice')).toContainText('編輯中');

    await completeEditing(first);
    await second.locator('#topicAcquireEdit').click();
    await expect(second.locator('#topicModeBadge')).toHaveText('可編輯', { timeout: 20000 });
    const secondState = await second.evaluate(() => window.TopicReportEditor.getState());
    expect(secondState.fencingToken).toBeGreaterThan(firstStateBeforeFocus.fencingToken);
  } finally {
    await ownerContext.close();
    await operatorContext.close();
  }
});

test('Owner編輯T1時Operator可編輯T2，但Operator開T1只能讀取', async ({ browser, request }) => {
  const ownerContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const ownerMonthly = await ownerContext.newPage();
  const operatorMonthly = await operatorContext.newPage();
  try {
    await enterAndLogin(ownerMonthly, 'owner', 'owner-pass');
    await enterAndLogin(operatorMonthly, 'operator', 'operator-pass');
    const ownerList = await openTopicList(ownerMonthly);
    const operatorList = await openTopicList(operatorMonthly);
    const t1 = await createTopic(ownerList, 'T1 Owner專題');
    const t2 = await createTopic(operatorList, 'T2 Operator專題');
    await expect(t1.locator('#topicModeBadge')).toHaveText('可編輯');
    await expect(t2.locator('#topicModeBadge')).toHaveText('可編輯');

    const t1Id = new URL(t1.url()).searchParams.get('report');
    const operatorT1Promise = operatorList.waitForEvent('popup');
    await operatorList.evaluate((id) => window.TopicReportsPage.openReport(id), t1Id);
    const operatorT1 = await operatorT1Promise;
    await expect(operatorT1.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
    await expect(operatorT1.locator('#topicModeBadge')).toHaveText('唯讀');
    await operatorT1.evaluate(() => {
      window.__readonlyPrintObserved = false;
      window.print = () => { window.__readonlyPrintObserved = true; };
    });
    await operatorT1.locator('#topicPrint').click();
    await expect.poll(() => operatorT1.evaluate(() => window.__readonlyPrintObserved)).toBe(true);

    const state = await (await request.get('/__fake_state')).json();
    expect(state.topicReports).toHaveLength(2);
    expect(state.topicReports.find((report) => report.id === t1Id).revision).toBe(1);
    expect(state.topicSnapshots).toHaveLength(1);
    expect(state.topicLeases.filter((lease) => !lease.released)).toHaveLength(2);
  } finally {
    await ownerContext.close();
    await operatorContext.close();
  }
});

test('清單隱藏內部欄位、名稱最寬、表頭雙向排序、Owner刪除且直接返回月報', async ({ browser, request }) => {
  const ownerContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const ownerMonthly = await ownerContext.newPage();
  const operatorMonthly = await operatorContext.newPage();
  try {
    await enterAndLogin(ownerMonthly, 'owner', 'owner-pass');
    const list = await openTopicList(ownerMonthly);
    const zulu = await createTopic(list, 'Zulu 船舶安全專題');
    await completeEditing(zulu);
    const alpha = await createTopic(list, 'Alpha 繫泊專題');
    await completeEditing(alpha);
    await list.locator('#topicRefreshReports').click();
    await expect(list.locator('#topicReportsBody tr')).toHaveCount(2);

    const headers = await list.locator('#topicReportsTable thead th').allTextContents();
    expect(headers.map((text) => text.replace(/[↕▲▼↑↓]/g, '').trim())).toEqual(['專題名稱', '報告日期', '狀態', '資料大小', '最後更新', '操作']);
    expect(headers.join('')).not.toMatch(/系統編號|模塊|Revision/i);
    const widths = await list.locator('#topicReportsTable thead th').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(widths[0]).toBeGreaterThan(Math.max(...widths.slice(1)));

    await list.locator('[data-topic-sort="title"]').click();
    await expect(list.locator('[data-topic-sort-header="title"]')).toHaveAttribute('aria-sort', 'ascending');
    await expect(list.locator('#topicReportsBody .topic-title-cell').first()).toHaveText('Alpha 繫泊專題');
    await list.locator('[data-topic-sort="title"]').click();
    await expect(list.locator('[data-topic-sort-header="title"]')).toHaveAttribute('aria-sort', 'descending');
    await expect(list.locator('#topicReportsBody .topic-title-cell').first()).toHaveText('Zulu 船舶安全專題');
    await expect(list.locator('[data-delete-report]')).toHaveCount(2);

    await enterAndLogin(operatorMonthly, 'operator', 'operator-pass');
    const operatorList = await openTopicList(operatorMonthly);
    await expect(operatorList.locator('#topicReportsBody tr')).toHaveCount(2);
    await expect(operatorList.locator('[data-delete-report]')).toHaveCount(0);

    list.once('dialog', (dialog) => dialog.accept());
    await list.locator('[data-delete-report]').first().click();
    await expect(list.locator('#topicReportsBody tr')).toHaveCount(1, { timeout: 20000 });
    const state = await (await request.get('/__fake_state')).json();
    expect(state.topicReports.filter((report) => report.deletedAt)).toHaveLength(1);
    expect(state.rpcCounts.monthly_v7_topic_delete_report).toBe(1);

    const closePromise = list.waitForEvent('close');
    await list.locator('#topicBackMonthly').click();
    await closePromise;
    await expect(ownerMonthly.locator('#siteAccessGate')).toBeHidden();
    await expect.poll(() => ownerMonthly.evaluate(() => window.MonthlyV7App?.client?.currentUser?.()?.username || '')).toBe('owner');
  } finally {
    await ownerContext.close();
    await operatorContext.close();
  }
});

test('不保存並退出在release結果不明前先同步保留最新本機草稿', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '立即放棄草稿專題');
  await editor.locator('.topic-editable').first().fill('未滿800ms也必須保留的最新內容');
  await request.post('/__fake_hang_rpc?name=monthly_v7_topic_release_report_lease&count=1');

  editor.once('dialog', (dialog) => dialog.accept());
  await editor.locator('#topicDiscardExit').click();
  await expect(editor.locator('#topicModeBadge')).toHaveText('唯讀');

  const local = await editor.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:'));
    const releaseKeys = Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:release-check:'));
    return { keys, releaseKeys, values: keys.map((key) => localStorage.getItem(key) || '') };
  });
  expect(local.releaseKeys).toHaveLength(1);
  expect(local.keys).toHaveLength(1);
  expect(local.values[0]).toContain('未滿800ms也必須保留的最新內容');
  const state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_topic_save_report || 0).toBe(0);
  expect(state.topicLeases[0].released).toBe(false);
});

test('不保存並退出不呼叫save、ACK後清草稿並立即釋放鎖', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '不保存退出專題');
  await editor.locator('#topicReportTitle').fill('不應上雲的新標題');
  await editor.locator('.topic-editable').first().fill('不應上雲的本機修改');
  await editor.waitForTimeout(1000);
  expect(await editor.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:')).length)).toBe(1);

  editor.once('dialog', (dialog) => dialog.accept());
  const closePromise = editor.waitForEvent('close');
  await editor.locator('#topicDiscardExit').click();
  await closePromise;

  const state = await (await request.get('/__fake_state')).json();
  expect(state.topicReports[0].title).toBe('不保存退出專題');
  expect(state.topicReports[0].revision).toBe(1);
  expect(state.topicReports[0].content.modules[0].columns[0]).not.toContain('不應上雲');
  expect(state.rpcCounts.monthly_v7_topic_save_report || 0).toBe(0);
  expect(state.topicLeases[0].released).toBe(true);
  expect(await list.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('topic:v1:draft:')).length)).toBe(0);
  await list.evaluate(() => window.TopicReportsPage.refresh());
  await expect(list.locator('#topicReportsBody .topic-pill')).toHaveText('草稿');
  await expect(list.locator('#topicReportsBody [data-delete-report]')).toBeEnabled();
});

test('編輯區塊在標題操作下方，色塊、字級、自動編號及物件百分比與刪除可保存', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '基礎工具與物件控制專題');
  const geometry = await editor.locator('.topic-module').first().evaluate((module) => {
    const topbar = module.querySelector('.topic-module-topbar').getBoundingClientRect();
    const content = module.querySelector('.topic-module-content').getBoundingClientRect();
    const actions = module.querySelector('.topic-module-actions').getBoundingClientRect();
    return { topbarBottom: topbar.bottom, contentTop: content.top, actionsBottom: actions.bottom };
  });
  expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.topbarBottom - 1);
  expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.actionsBottom - 1);

  const editable = editor.locator('.topic-editable').first();
  await editable.fill('第一個自動編號項目');
  await selectEditorContents(editable);
  await editor.locator('[data-text-color="#dc2626"]').click();
  await selectEditorContents(editable);
  await editor.locator('#topicFontSize').selectOption('24');
  await selectEditorContents(editable);
  await editor.locator('[data-command="insertOrderedList"]').click();
  await expect(editable.locator('ol')).toHaveCount(1);
  expect(await editable.innerHTML()).toMatch(/color:\s*(?:rgb\(220,\s*38,\s*38\)|#dc2626)/i);
  expect(await editable.innerHTML()).toMatch(/font-size:\s*24px/i);

  await editable.click();
  await editable.press('End');
  await editor.locator('[data-insert="highlight"]').click();
  await expect(editor.locator('#topicObjectToolbar')).toBeVisible();
  await editor.locator('[data-topic-object-width="45"]').click();
  expect(await editor.locator('.topic-highlight').evaluate((node) => node.style.width)).toBe('45%');
  editor.once('dialog', (dialog) => dialog.accept());
  await editor.locator('[data-topic-object-delete]').click();
  await expect(editor.locator('.topic-highlight')).toHaveCount(0);

  await editable.click(); await editable.press('End');
  await editor.locator('[data-insert="kpi"]').click();
  await editor.locator('[data-topic-object-width="70"]').click();
  const kpi = editor.locator('.topic-kpi-card');
  expect(await kpi.evaluate((node) => node.style.width)).toBe('70%');
  await kpi.locator('[data-topic-kpi-toggle]').click();
  await expect(kpi).toHaveAttribute('data-topic-show-avg', 'false');
  await kpi.evaluate((node) => {
    node.querySelector('.topic-metric-current').textContent = '25';
    node.querySelector('.topic-metric-target').textContent = '75';
    node.querySelector('.topic-metric-avg').textContent = '50';
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await expect.poll(() => kpi.locator('.topic-kpi-current-marker').evaluate((node) => node.style.left)).toBe('25%');
  await expect.poll(() => kpi.locator('.topic-kpi-target-marker').evaluate((node) => node.style.left)).toBe('75%');

  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicRevision')).toHaveText('2', { timeout: 20000 });
  const saved = await (await request.get('/__fake_state')).json();
  const html = saved.topicReports[0].content.modules[0].columns[0];
  expect(html).toMatch(/<ol>/);
  expect(html).toMatch(/font-size:24px/);
  expect(html).toMatch(/color:/);
  expect(html).toMatch(/topic-kpi-card/);
  expect(html).toMatch(/width:70%/);
  expect(html).toMatch(/data-topic-show-avg="false"/);

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('.topic-kpi-card')).toHaveCount(1);
  expect(await editor.locator('.topic-kpi-card').evaluate((node) => node.style.width)).toBe('70%');
  await expect(editor.locator('.topic-editable').first().locator('ol')).toHaveCount(1);
});

test('趨勢圖固定高度不延伸，可增減指標與週期並保存重開', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '趨勢圖穩定性專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.click();
  await editor.locator('[data-insert="trend"]').click();
  const trend = editor.locator('.topic-trend-card');
  await expect(trend).toHaveCount(1);
  await expect(editor.locator('#topicTrendControls')).toBeVisible();
  await editor.waitForTimeout(500);

  const firstHeights = await trend.evaluate(async (card) => {
    const samples = [];
    for (let index = 0; index < 7; index += 1) {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 110));
      const area = card.querySelector('.topic-chart-canvas-area');
      const canvas = card.querySelector('.topic-chart-canvas');
      samples.push({ area: area.getBoundingClientRect().height, canvas: canvas.getBoundingClientRect().height, card: card.getBoundingClientRect().height });
    }
    return samples;
  });
  expect(Math.max(...firstHeights.map((sample) => sample.area)) - Math.min(...firstHeights.map((sample) => sample.area))).toBeLessThanOrEqual(1);
  expect(firstHeights.every((sample) => sample.area >= 219 && sample.area <= 221 && sample.canvas <= 221 && sample.card < 600)).toBe(true);

  await editor.locator('[data-topic-trend-action="series-add"]').click();
  await editor.locator('[data-topic-trend-action="period-add"]').click();
  await expect(trend.locator('thead th')).toHaveCount(4);
  await expect(trend.locator('tbody tr')).toHaveCount(4);
  await trend.locator('thead th').last().fill('事故率');
  await trend.locator('tbody tr').last().locator('td').first().fill('Q4');
  await editor.locator('#topicTrendHeight').selectOption('280');
  await editor.locator('[data-topic-object-width="70"]').click();
  await expect(trend.locator('.topic-chart-canvas-area')).toHaveCSS('height', '280px');
  expect(await trend.evaluate((node) => node.style.width)).toBe('70%');

  await editor.locator('#topicSave').click();
  await expect(editor.locator('#topicRevision')).toHaveText('2', { timeout: 20000 });
  const state = await (await request.get('/__fake_state')).json();
  const html = state.topicReports[0].content.modules[0].columns[0];
  expect(html).toContain('事故率');
  expect(html).toContain('data-topic-chart-height="280"');
  expect(html).toContain('width:70%');

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  const reopened = editor.locator('.topic-trend-card');
  await expect(reopened.locator('thead th')).toHaveCount(4);
  await expect(reopened.locator('tbody tr')).toHaveCount(4);
  await expect(reopened).toContainText('事故率');
  await expect(reopened.locator('.topic-chart-canvas-area')).toHaveCSS('height', '280px');
  const reopenedHeights = await reopened.evaluate(async (card) => {
    const values = [];
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 110));
      values.push(card.querySelector('.topic-chart-canvas-area').getBoundingClientRect().height);
    }
    return values;
  });
  expect(Math.max(...reopenedHeights) - Math.min(...reopenedHeights)).toBeLessThanOrEqual(1);
  expect(reopenedHeights.every((height) => height >= 279 && height <= 281)).toBe(true);
});
