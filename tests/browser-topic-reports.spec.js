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

async function expectEditorRevision(editor, revision) {
  await expect.poll(
    () => editor.evaluate(() => window.TopicReportEditor.getState().revision),
    { timeout: 20000 }
  ).toBe(revision);
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

  await expect.poll(() => editor.title()).toMatch(/^SR-\d{8}-\d{3}/);
  await expect(editor.locator('.topic-module')).toHaveCount(1);
  await editor.locator('#topicAddModule').click();
  await expect(editor.locator('.topic-module')).toHaveCount(2);
  await editor.locator('.topic-editable').first().click();
  await editor.locator('[data-insert="kpi"]').click();
  await expect(editor.locator('.topic-kpi-card')).toHaveCount(1);
  await editor.locator('#topicReportTitle').fill('繫泊作業安全專題（修訂）');
  await editor.locator('.topic-editable').first().pressSequentially(' 已完成風險盤點');
  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
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
  await expectEditorRevision(editor, 2);
  const state = await (await request.get('/__fake_state')).json();
  const module = state.topicReports[0].content.modules[0];
  expect(module.colLayout).toBe('1:1');
  expect(module.columns.join('')).toMatch(/\/storage\/v1\/object\/public\/report-assets\/topic\/[^/]+\/images\/[^"']+\.png/);
  expect(module.columns.join('')).not.toContain('data:image/png;base64');
  expect(module.attachments[0].name).toBe('anonymous.txt');
  expect(module.attachments[0].bucket).toBe('report-assets');
  expect(module.attachments[0].path).toMatch(/^topic\/[^/]+\/attachments\/[0-9a-f-]+\.txt$/);
  expect(module.attachments[0].url).toContain('/storage/v1/object/public/report-assets/topic/');
  expect(module.attachments[0].dataUrl).toBeUndefined();
  expect(state.storageObjects).toHaveLength(2);
  expect(state.storageObjects.map((object) => object.path).sort()).toEqual([
    expect.stringMatching(/^topic\/[^/]+\/attachments\/[0-9a-f-]+\.txt$/),
    expect.stringMatching(/^topic\/[^/]+\/images\/[0-9a-f-]+\.png$/)
  ]);

  const attachmentDownloadPromise = editor.waitForEvent('download');
  await editor.locator('[data-attachment-action="download"]').click();
  const attachmentDownload = await attachmentDownloadPromise;
  expect(attachmentDownload.suggestedFilename()).toBe('anonymous.txt');

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

test('Owner刪除lost ACK後遇revision漂移會先對帳原operation再用新revision完成', async ({ browser, request }) => {
  const ownerContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const ownerMonthly = await ownerContext.newPage();
  const operatorMonthly = await operatorContext.newPage();
  try {
    await enterAndLogin(ownerMonthly, 'owner', 'owner-pass');
    await enterAndLogin(operatorMonthly, 'operator', 'operator-pass');
    const ownerList = await openTopicList(ownerMonthly);
    const editor = await createTopic(ownerList, '刪除對帳專題');
    const reportId = new URL(editor.url()).searchParams.get('report');
    await completeEditing(editor);
    await ownerList.locator('#topicRefreshReports').click();

    const deleteRequests = [];
    await ownerList.route('**/__fake_rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.name === 'monthly_v7_topic_delete_report') {
        deleteRequests.push(JSON.parse(JSON.stringify(body.params)));
      }
      await route.continue();
    });
    await request.post('/__fake_hang_rpc?name=monthly_v7_topic_delete_report&count=1');
    ownerList.once('dialog', (dialog) => dialog.accept());
    await ownerList.locator(`[data-delete-report="${reportId}"]`).click();
    await expect(ownerList.locator('#topicListStatus')).toContainText('逾時', { timeout: 10000 });
    expect(await ownerList.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:delete:')).length)).toBe(1);

    const operatorList = await openTopicList(operatorMonthly);
    const popupPromise = operatorList.waitForEvent('popup');
    await operatorList.locator(`[data-open-report="${reportId}"]`).click();
    const operatorEditor = await popupPromise;
    await expect(operatorEditor.locator('#topicModeBadge')).toHaveText('可編輯', { timeout: 20000 });
    await operatorEditor.locator('#topicReportTitle').fill('刪除對帳專題（遠端修訂）');
    await completeEditing(operatorEditor);

    await ownerList.locator('#topicRefreshReports').click();
    await expect(ownerList.locator('#topicReportsBody')).toContainText('刪除對帳專題（遠端修訂）');
    const beforeRetry = await (await request.get('/__fake_state')).json();
    const currentRevision = beforeRetry.topicReports.find((report) => report.id === reportId).revision;

    ownerList.once('dialog', (dialog) => dialog.accept());
    await ownerList.locator(`[data-delete-report="${reportId}"]`).click();
    await expect(ownerList.locator('#topicListStatus')).toContainText('已由其他窗口更新');
    expect(await ownerList.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('topic:v1:pending:delete:')).length)).toBe(0);
    expect(deleteRequests).toHaveLength(2);
    expect(deleteRequests[1].p_operation_id).toBe(deleteRequests[0].p_operation_id);
    expect(deleteRequests[1].p_expected_revision).toBe(deleteRequests[0].p_expected_revision);
    expect(deleteRequests[1].p_expected_revision).toBeLessThan(currentRevision);

    ownerList.once('dialog', (dialog) => dialog.accept());
    await ownerList.locator(`[data-delete-report="${reportId}"]`).click();
    await expect(ownerList.locator('#topicReportsBody tr')).toHaveCount(0, { timeout: 20000 });
    expect(deleteRequests).toHaveLength(3);
    expect(deleteRequests[2].p_operation_id).not.toBe(deleteRequests[0].p_operation_id);
    expect(deleteRequests[2].p_expected_revision).toBe(currentRevision);
    const after = await (await request.get('/__fake_state')).json();
    expect(after.topicReports.find((report) => report.id === reportId).deletedAt).toBeTruthy();
    expect(after.rpcCounts.monthly_v7_topic_delete_report).toBe(2);
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

test('專題項次標頭、操作列與空白內容區保持緊湊', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '緊湊編輯區專題');
  await editor.setViewportSize({ width: 1440, height: 1000 });

  const geometry = await editor.locator('.topic-module').first().evaluate((module) => {
    const rect = (selector) => module.querySelector(selector).getBoundingClientRect();
    const topbar = rect('.topic-module-topbar');
    const actions = rect('.topic-module-actions');
    const order = rect('[data-module-pdf-order]');
    const editable = rect('.topic-editable');
    const title = rect('.topic-module-title');
    const index = rect('.topic-module-heading small');
    return {
      topbarHeight: topbar.height,
      actionsHeight: actions.height,
      orderWidth: order.width,
      editableHeight: editable.height,
      titleCenterY: title.top + title.height / 2,
      indexCenterY: index.top + index.height / 2
    };
  });

  expect(geometry.orderWidth).toBeLessThanOrEqual(88);
  expect(geometry.actionsHeight).toBeLessThanOrEqual(58);
  expect(geometry.topbarHeight).toBeLessThanOrEqual(64);
  expect(geometry.editableHeight).toBeLessThanOrEqual(120);
  expect(Math.abs(geometry.titleCenterY - geometry.indexCenterY)).toBeLessThanOrEqual(4);
});

test('桌面工具列退出按鈕、名稱日期與編輯權資訊維持單行', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '桌面單行工具與狀態專題');
  await editor.setViewportSize({ width: 1700, height: 1000 });

  const geometry = await editor.evaluate(() => {
    document.querySelector('#topicLeaseNotice').textContent = '編輯權有效至 2026/08/17 02:00 · fencing 3';
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const reportRow = document.querySelector('#topicDiscardExit').closest('.topic-toolbar-row');
    const meta = document.querySelector('.topic-editor-meta');
    const metaRect = meta.getBoundingClientRect();
    const title = rect('#topicReportTitle');
    const date = rect('#topicReportDate');
    const stateNode = document.querySelector('.topic-editor-state');
    const state = stateNode.getBoundingClientRect();
    const lease = rect('#topicLeaseNotice');
    const discard = rect('#topicDiscardExit');
    const complete = rect('#topicComplete');
    return {
      reportRowText: reportRow.textContent.replace(/\s+/g, ' ').trim(),
      discardCenterY: discard.top + discard.height / 2,
      completeCenterY: complete.top + complete.height / 2,
      metaContainsState: meta.contains(stateNode),
      titleTop: title.top,
      titleBottom: title.bottom,
      dateTop: date.top,
      dateBottom: date.bottom,
      stateTop: state.top,
      stateBottom: state.bottom,
      stateClientWidth: stateNode.clientWidth,
      stateScrollWidth: stateNode.scrollWidth,
      leaseRight: lease.right,
      metaRight: metaRect.right
    };
  });

  expect(geometry.reportRowText).not.toContain('版型：單欄／雙欄');
  expect(Math.abs(geometry.discardCenterY - geometry.completeCenterY)).toBeLessThanOrEqual(3);
  expect(geometry.metaContainsState).toBe(true);
  expect(Math.abs(geometry.titleTop - geometry.dateTop)).toBeLessThanOrEqual(2);
  expect(geometry.stateTop).toBeLessThan(geometry.titleBottom);
  expect(geometry.stateBottom).toBeGreaterThan(geometry.titleTop);
  expect(geometry.stateScrollWidth).toBeLessThanOrEqual(geometry.stateClientWidth + 1);
  expect(geometry.leaseRight).toBeLessThanOrEqual(geometry.metaRight + 1);
  await testInfo.attach('topic-toolbar-meta-single-row.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });

  await editor.setViewportSize({ width: 390, height: 900 });
  const mobile = await editor.evaluate(() => {
    const state = document.querySelector('.topic-editor-state').getBoundingClientRect();
    const lease = document.querySelector('#topicLeaseNotice');
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      stateRight: state.right,
      leaseClientWidth: lease.clientWidth,
      leaseScrollWidth: lease.scrollWidth
    };
  });
  expect(mobile.documentScrollWidth).toBeLessThanOrEqual(mobile.viewportWidth + 1);
  expect(mobile.stateRight).toBeLessThanOrEqual(mobile.viewportWidth + 1);
  expect(mobile.leaseScrollWidth).toBeLessThanOrEqual(mobile.leaseClientWidth + 1);
});

test('數值框貼合相鄰文字大小並保留可選取的前後雙空格', async ({ page, request }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '數值框尺寸專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.evaluate((node) => {
    const reference = document.createElement('span');
    reference.className = 'topic-reference-text';
    reference.textContent = '督導';
    node.replaceChildren(reference, document.createTextNode(' '));
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.focus();
  });
  await editor.locator('[data-insert="highlight"]').click();
  await editor.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(editor.locator('#topicObjectToolbar [data-topic-object-width][aria-pressed="true"]')).toHaveCount(0);
  const geometry = await editor.locator('.topic-highlight').evaluate((highlight) => {
    const reference = highlight.closest('.topic-editable').querySelector('.topic-reference-text');
    const highlightStyle = getComputedStyle(highlight);
    const referenceStyle = getComputedStyle(reference);
    const highlightRect = highlight.getBoundingClientRect();
    const referenceRect = reference.getBoundingClientRect();
    return {
      text: highlight.textContent,
      inlineWidth: highlight.style.width,
      whiteSpace: highlightStyle.whiteSpace,
      fontSize: Number.parseFloat(highlightStyle.fontSize),
      referenceFontSize: Number.parseFloat(referenceStyle.fontSize),
      height: highlightRect.height,
      referenceHeight: referenceRect.height,
      width: highlightRect.width,
      display: highlightStyle.display,
      verticalAlign: highlightStyle.verticalAlign,
      backgroundColor: highlightStyle.backgroundColor,
      color: highlightStyle.color,
      borderWidth: highlightStyle.borderTopWidth,
      borderRadius: highlightStyle.borderTopLeftRadius,
      paddingLeft: highlightStyle.paddingLeft,
      paddingRight: highlightStyle.paddingRight,
      fontWeight: highlightStyle.fontWeight,
      marginLeft: highlightStyle.marginLeft,
      boxShadow: highlightStyle.boxShadow,
      printColorAdjust: highlightStyle.printColorAdjust || highlightStyle.webkitPrintColorAdjust,
      bottomDelta: Math.abs(highlightRect.bottom - referenceRect.bottom)
    };
  });
  expect(geometry.text).toBe('  重要數值 100  ');
  expect(geometry.inlineWidth).toBe('');
  expect(geometry.whiteSpace).toBe('pre-wrap');
  expect(geometry.fontSize).toBe(geometry.referenceFontSize);
  expect(geometry.height).toBeLessThanOrEqual(geometry.referenceHeight * 1.25);
  expect(geometry.width).toBeLessThan(240);
  expect(geometry).toEqual(expect.objectContaining({
    display: 'inline',
    verticalAlign: 'baseline',
    backgroundColor: 'rgb(253, 242, 248)',
    color: 'rgb(190, 24, 93)',
    borderWidth: '1px',
    borderRadius: '4px',
    paddingLeft: '4px',
    paddingRight: '4px',
    fontWeight: '700',
    marginLeft: '0px',
    printColorAdjust: 'exact'
  }));
  expect(geometry.boxShadow).not.toBe('none');
  expect(geometry.bottomDelta).toBeLessThanOrEqual(3);
  await testInfo.attach('topic-editor-highlight-compact.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });

  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
  const state = await (await request.get('/__fake_state')).json();
  const savedHtml = state.topicReports[0].content.modules[0].columns[0];
  expect(savedHtml).toContain('>  重要數值 100  </span>');
  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  expect(await editor.locator('.topic-highlight').evaluate((node) => node.textContent)).toBe('  重要數值 100  ');
});

test('插入表格可拖曳欄界並在保存重開後保留欄寬', async ({ page, request }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '可調欄寬表格專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.click();

  const answers = ['3', '4'];
  const promptHandler = async (dialog) => dialog.accept(answers.shift());
  editor.on('dialog', promptHandler);
  await editor.locator('[data-insert="table"]').click();
  await expect.poll(() => answers.length).toBe(0);
  editor.off('dialog', promptHandler);

  const table = editor.locator('table.topic-resizable-table');
  await expect(table).toHaveCount(1);
  await expect(table.locator('colgroup col')).toHaveCount(4);
  await expect(table.locator('[data-topic-table-resize-handle]')).toHaveCount(3);
  const initial = await table.locator('colgroup col').evaluateAll((cols) => cols.map((col) => Number.parseFloat(col.style.width)));
  expect(initial).toEqual([25, 25, 25, 25]);

  const handle = table.locator('[data-topic-table-resize-handle="0"]');
  const box = await handle.boundingBox();
  await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await editor.mouse.down();
  await editor.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 6 });
  await editor.mouse.up();

  const resized = await table.locator('colgroup col').evaluateAll((cols) => cols.map((col) => Number.parseFloat(col.style.width)));
  expect(resized[0]).toBeGreaterThan(29);
  expect(resized[1]).toBeLessThan(21);
  expect(resized[0] + resized[1]).toBeCloseTo(50, 2);
  await testInfo.attach('topic-editor-resizable-table.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });

  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
  const state = await (await request.get('/__fake_state')).json();
  const savedHtml = state.topicReports[0].content.modules[0].columns[0];
  expect(savedHtml).toMatch(/<colgroup>/);
  expect(savedHtml).toContain('topic-resizable-table');
  expect(savedHtml).not.toContain('data-topic-table-resize-handle');

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  const reopened = editor.locator('table.topic-resizable-table');
  await expect(reopened.locator('[data-topic-table-resize-handle]')).toHaveCount(3);
  const reopenedWidths = await reopened.locator('colgroup col').evaluateAll((cols) => cols.map((col) => Number.parseFloat(col.style.width)));
  expect(reopenedWidths[0]).toBeCloseTo(resized[0], 2);
  expect(reopenedWidths[1]).toBeCloseTo(resized[1], 2);
});

test('指標卡採月報T型版面並可增減橫向列與直向欄且保存重開與PDF保留', async ({ page, request }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '指標卡矩陣專題');
  await editor.setViewportSize({ width: 1500, height: 1000 });
  const editable = editor.locator('.topic-editable').first();
  const legacy = await editor.evaluate(() => {
    const html = window.TopicReportEditor.sanitizeStoredHtml('<table class="topic-inline-block topic-indicator-card topic-data-table" data-topic-block="indicator" style="width:30%;--card-color:#f97316"><thead><tr><th class="topic-indicator-title" colspan="2">舊卡</th></tr></thead><tbody><tr><td>名稱</td><td>1</td></tr></tbody></table>');
    const documentNode = new DOMParser().parseFromString(html, 'text/html');
    const table = documentNode.querySelector('.topic-indicator-card');
    return { columns: table.querySelectorAll('colgroup col').length, colspan: table.tHead.rows[0].cells[0].colSpan };
  });
  expect(legacy).toEqual({ columns: 2, colspan: 2 });
  await editable.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.locator('[data-insert="indicator-orange"]').click();
  await editor.locator('[data-insert="indicator-orange"]').click();
  await editor.locator('[data-insert="indicator-blue"]').click();
  await editor.locator('[data-insert="indicator-blue"]').click();
  const cards = editor.locator('.topic-indicator-card');
  await expect(cards).toHaveCount(4);
  const matrix = await editable.evaluate((host) => {
    const rects = Array.from(host.querySelectorAll('.topic-indicator-card')).map((node) => node.getBoundingClientRect());
    const hostWidth = host.getBoundingClientRect().width;
    return {
      firstThreeSameTop: rects.slice(0, 3).every((rect) => Math.abs(rect.top - rects[0].top) <= 1),
      fourthWrapped: rects[3].top > rects[0].top + 20,
      widthRatios: rects.map((rect) => rect.width / hostWidth)
    };
  });
  expect(matrix.firstThreeSameTop).toBe(true);
  expect(matrix.fourthWrapped).toBe(true);
  expect(matrix.widthRatios.every((ratio) => ratio >= 0.28 && ratio <= 0.31)).toBe(true);
  const card = cards.first();
  await card.locator('tbody tr').first().locator('td').first().click();
  await expect(editor.locator('#topicIndicatorControls')).toBeVisible();
  await expect(card.locator('colgroup col')).toHaveCount(2);
  await editor.locator('[data-topic-object-width="70"]').click();

  const initial = await card.evaluate((table) => {
    const rect = table.getBoundingClientRect();
    const editor = table.closest('.topic-editable');
    const editorRect = editor.getBoundingClientRect();
    const row = table.tBodies[0].rows[0];
    const lastCell = row.cells[row.cells.length - 1].getBoundingClientRect();
    const title = table.tHead.rows[0].cells[0].getBoundingClientRect();
    const widths = Array.from(table.querySelectorAll('colgroup col')).map((column) => Number.parseFloat(column.style.width));
    return {
      ratio: rect.width / editorRect.width,
      lastCellRightDelta: Math.abs(rect.right - lastCell.right),
      titleRightDelta: Math.abs(rect.right - title.right),
      widths
    };
  });
  expect(initial.ratio).toBeGreaterThan(0.67);
  expect(initial.ratio).toBeLessThan(0.72);
  expect(initial.lastCellRightDelta).toBeLessThanOrEqual(2);
  expect(initial.titleRightDelta).toBeLessThanOrEqual(2);
  expect(initial.widths[0]).toBeCloseTo(66.66, 1);
  expect(initial.widths[1]).toBeCloseTo(33.34, 1);

  await editor.locator('[data-topic-indicator-action="row-after"]').click();
  await expect(card.locator('tbody tr')).toHaveCount(4);
  await card.locator('tbody tr').last().locator('td').first().click();
  await editor.locator('[data-topic-indicator-action="row-remove"]').click();
  await expect(card.locator('tbody tr')).toHaveCount(3);
  await card.locator('tbody tr').last().locator('td').first().click();
  await editor.locator('[data-topic-indicator-action="row-after"]').click();
  await expect(card.locator('tbody tr')).toHaveCount(4);

  await card.locator('tbody tr').first().locator('td').last().click();
  await editor.locator('[data-topic-indicator-action="column-after"]').click();
  await expect(card.locator('tbody tr').first().locator('td')).toHaveCount(3);
  await expect(card.locator('thead th')).toHaveAttribute('colspan', '3');
  await expect(card.locator('colgroup col')).toHaveCount(3);
  await card.locator('tbody tr').first().locator('td').last().click();
  await editor.locator('[data-topic-indicator-action="column-remove"]').click();
  await expect(card.locator('tbody tr').first().locator('td')).toHaveCount(2);
  await card.locator('tbody tr').first().locator('td').last().click();
  await editor.locator('[data-topic-indicator-action="column-after"]').click();
  await expect(card.locator('tbody tr').first().locator('td')).toHaveCount(3);
  await card.locator('tbody tr').last().locator('td').last().fill('新增值');

  await editor.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await card.locator('tbody tr').first().locator('td').first().click();
  const narrowToolbar = await editor.locator('#topicObjectToolbar').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: innerWidth };
  });
  expect(narrowToolbar.left).toBeGreaterThanOrEqual(0);
  expect(narrowToolbar.right).toBeLessThanOrEqual(narrowToolbar.viewportWidth);
  await editor.setViewportSize({ width: 1500, height: 1000 });
  await card.locator('tbody tr').first().locator('td').first().click();

  await testInfo.attach('topic-indicator-matrix-editor.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
  const saved = await (await request.get('/__fake_state')).json();
  const savedHtml = saved.topicReports[0].content.modules[0].columns[0];
  expect(savedHtml).toContain('<colgroup>');
  expect(savedHtml).toContain('colspan="3"');
  expect(savedHtml).toContain('新增值');

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  await expect(editor.locator('.topic-indicator-card')).toHaveCount(4);
  const reopened = editor.locator('.topic-indicator-card').first();
  await expect(reopened.locator('tbody tr')).toHaveCount(4);
  await expect(reopened.locator('tbody tr').first().locator('td')).toHaveCount(3);
  await expect(reopened.locator('colgroup col')).toHaveCount(3);

  await editor.evaluate(() => {
    window.__topicIndicatorPrintObserved = null;
    window.print = () => {
      const card = document.querySelector('#topicPrintArea .topic-indicator-card');
      window.__topicIndicatorPrintObserved = {
        rows: card.tBodies[0].rows.length,
        columns: card.tBodies[0].rows[0].cells.length,
        colspan: card.tHead.rows[0].cells[0].colSpan,
        value: card.tBodies[0].rows[3].cells[2].textContent
      };
    };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicIndicatorPrintObserved)).toEqual({
    rows: 4, columns: 3, colspan: 3, value: '新增值'
  });
});

test('圖片可左中右對齊並在保存重開與PDF保留右對齊', async ({ page, request }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '圖片對齊專題');
  await editor.setViewportSize({ width: 1400, height: 1000 });
  const editable = editor.locator('.topic-editable').first();
  await editable.click();
  await editor.locator('#topicImageFile').setInputFiles({
    name: 'alignment.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg==', 'base64')
  });
  const image = editor.locator('img.topic-inline-image');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute('src', /\/storage\/v1\/object\/public\/report-assets\/topic\/[^/]+\/images\/[0-9a-f-]+\.png$/);
  await expect(image).toHaveAttribute('data-topic-asset-bucket', 'report-assets');
  await expect(image).toHaveAttribute('data-topic-asset-path', /^topic\/[^/]+\/images\/[0-9a-f-]+\.png$/);
  await image.click();
  await expect(editor.locator('#topicImageControls')).toBeVisible();
  await expect(image).toHaveAttribute('data-topic-align', 'center');

  const geometry = () => image.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const editor = node.closest('.topic-editable');
    const editorRect = editor.getBoundingClientRect();
    const style = getComputedStyle(editor);
    const left = editorRect.left + Number.parseFloat(style.paddingLeft);
    const right = editorRect.right - Number.parseFloat(style.paddingRight);
    return {
      leftDelta: Math.abs(rect.left - left),
      rightDelta: Math.abs(right - rect.right),
      centerDelta: Math.abs((rect.left + rect.right) / 2 - (left + right) / 2)
    };
  });

  await editor.locator('[data-topic-image-align="left"]').click();
  await expect(image).toHaveAttribute('data-topic-align', 'left');
  expect((await geometry()).leftDelta).toBeLessThanOrEqual(2);
  await editor.locator('[data-topic-image-align="center"]').click();
  expect((await geometry()).centerDelta).toBeLessThanOrEqual(2);
  await editor.locator('[data-topic-image-align="right"]').click();
  await expect(image).toHaveAttribute('data-topic-align', 'right');
  expect((await geometry()).rightDelta).toBeLessThanOrEqual(2);

  await testInfo.attach('topic-image-right-aligned.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
  const saved = await (await request.get('/__fake_state')).json();
  expect(saved.topicReports[0].content.modules[0].columns[0]).toContain('data-topic-align="right"');
  expect(saved.topicReports[0].content.modules[0].columns[0]).toContain('/storage/v1/object/public/report-assets/topic/');
  expect(saved.storageObjects).toHaveLength(1);

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  const reopened = editor.locator('img.topic-inline-image');
  await expect(reopened).toHaveAttribute('data-topic-align', 'right');
  await reopened.click();
  await expect(editor.locator('[data-topic-image-align="right"]')).toHaveAttribute('aria-pressed', 'true');

  await editor.evaluate(() => {
    window.__topicImagePrintObserved = null;
    window.print = () => {
      const image = document.querySelector('#topicPrintArea img.topic-inline-image');
      const column = image.closest('.topic-print-column');
      const imageRect = image.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      window.__topicImagePrintObserved = {
        align: image.dataset.topicAlign,
        src: image.src,
        rightDelta: Math.abs(columnRect.right - imageRect.right)
      };
    };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicImagePrintObserved)).not.toBeNull();
  const printGeometry = await editor.evaluate(() => window.__topicImagePrintObserved);
  expect(printGeometry.align).toBe('right');
  expect(printGeometry.src).toContain('/storage/v1/object/public/report-assets/topic/');
  expect(printGeometry.rightDelta).toBeLessThanOrEqual(2);
});

test('專題Storage上傳失敗不回退Base64且狀態列結束上傳中', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'Storage失敗專題');
  await request.post('/__fake_fail_storage?count=1');
  await editor.locator('.topic-editable').first().click();
  await editor.locator('#topicImageFile').setInputFiles({
    name: 'must-not-fallback.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg==', 'base64')
  });

  await expect(editor.locator('#topicLeaseNotice')).toContainText('Storage 上傳失敗');
  await expect(editor.locator('#topicLeaseNotice')).not.toContainText('正在上傳');
  await expect(editor.locator('img.topic-inline-image')).toHaveCount(0);
  await expect(editor.locator('#topicSave')).toBeEnabled();
  const state = await (await request.get('/__fake_state')).json();
  expect(state.storageObjects).toHaveLength(0);
});

test('專題PDF縮放與直橫方向會套用到列印區且不修改報告Revision', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'PDF縮放專題');
  const scale = editor.locator('#topicPdfScale');
  const orientation = editor.locator('#topicPdfOrientation');
  await expect(scale).toHaveValue('100');
  await expect(orientation).toHaveValue('portrait');
  await scale.selectOption('80');
  await orientation.selectOption('landscape');

  await editor.evaluate(() => {
    window.__topicScalePrintObserved = null;
    window.print = () => {
      const area = document.querySelector('#topicPrintArea');
      window.__topicScalePrintObserved = {
        selected: document.querySelector('#topicPdfScale').value,
        selectedOrientation: document.querySelector('#topicPdfOrientation').value,
        dataScale: area.dataset.pdfScale,
        dataOrientation: area.dataset.pdfOrientation,
        zoom: area.style.getPropertyValue('--topic-pdf-scale'),
        width: area.style.getPropertyValue('--topic-pdf-width'),
        pageRule: document.querySelector('#topicPrintPageStyle')?.textContent || ''
      };
    };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicScalePrintObserved)).not.toBeNull();
  expect(await editor.evaluate(() => window.__topicScalePrintObserved)).toEqual({
    selected: '80', selectedOrientation: 'landscape', dataScale: '80', dataOrientation: 'landscape',
    zoom: '0.8', width: '125%', pageRule: '@page { size: A4 landscape; margin: 10mm; }'
  });
  expect(await editor.evaluate(() => localStorage.getItem('topic:v1:pdf-orientation'))).toBe('landscape');
  const state = await (await request.get('/__fake_state')).json();
  expect(state.topicReports[0].revision).toBe(1);
  expect(state.topicSnapshots).toHaveLength(1);
});

test('專題PDF保留編輯頁雙欄內物件比例與同行分組', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'PDF所見即所得排布專題');
  await editor.setViewportSize({ width: 1700, height: 1100 });
  await editor.locator('[data-module-layout]').first().selectOption('1:1');
  const left = editor.locator('.topic-editable').first();
  await left.fill('督導 ');
  await left.click();
  await left.press('End');
  for (const type of ['indicator-orange', 'indicator-orange', 'indicator-blue', 'progress', 'zone', 'trend']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }
  await expect(left.locator('.topic-indicator-card')).toHaveCount(3);

  const measure = (scopeSelector) => editor.evaluate((selector) => {
    const scope = document.querySelector(selector);
    const column = scope.closest('.topic-editable,.topic-print-column');
    const columnRect = column.getBoundingClientRect();
    const nodes = Array.from(scope.querySelectorAll(
      '.topic-indicator-card,.topic-progress-card,.topic-zone-card,.topic-trend-card'
    ));
    const rows = [];
    const items = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      let row = rows.findIndex((top) => Math.abs(top - rect.top) <= 4);
      if (row < 0) { rows.push(rect.top); row = rows.length - 1; }
      return {
        type: node.dataset.topicBlock,
        inlineWidth: node.style.width,
        ratio: rect.width / columnRect.width,
        row
      };
    });
    return { columnWidth: columnRect.width, items };
  }, scopeSelector);

  const screen = await measure('.topic-editable');
  expect(screen.items.map((item) => item.inlineWidth)).toEqual(['30%', '30%', '30%', '30%', '30%', '45%']);
  expect(screen.items.slice(0, 3).map((item) => item.row)).toEqual([0, 0, 0]);
  await testInfo.attach('topic-wysiwyg-screen.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });

  await editor.evaluate(() => {
    window.__topicWysiwygPrintObserved = false;
    window.print = () => { window.__topicWysiwygPrintObserved = true; };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicWysiwygPrintObserved)).toBe(true);
  const structure = await editor.evaluate(() => ({
    layout: document.querySelector('#topicPrintArea .topic-print-columns').dataset.layout,
    columnCount: document.querySelectorAll('#topicPrintArea .topic-print-column').length
  }));
  expect(structure).toEqual({ layout: '1', columnCount: 1 });
  await editor.setViewportSize({ width: 718, height: 1100 });
  await editor.emulateMedia({ media: 'print' });
  await editor.evaluate(() => document.body.classList.add('topic-printing-report'));
  const printed = await measure('.topic-print-column');

  expect(printed.items.map((item) => item.inlineWidth)).toEqual(screen.items.map((item) => item.inlineWidth));
  expect(printed.items.map((item) => item.row)).toEqual(screen.items.map((item) => item.row));
  printed.items.forEach((item, index) => {
    expect(Math.abs(item.ratio - screen.items[index].ratio)).toBeLessThanOrEqual(0.06);
  });
  await testInfo.attach('topic-wysiwyg-print.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  const pdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5000);
  await testInfo.attach('topic-wysiwyg-portrait.pdf', { body: pdf, contentType: 'application/pdf' });
});

test('專題PDF等待snapshot期間內容變更會fail closed且不混用新圖表與舊資料表', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'PDF snapshot intent 專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.click();
  await editor.locator('[data-insert="trend"]').click();
  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);

  let releaseSnapshot;
  let signalSnapshotStarted;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
  let held = false;
  await editor.route('**/__fake_rpc', async (route) => {
    const body = route.request().postDataJSON();
    if (!held && body?.name === 'monthly_v7_topic_create_snapshot') {
      held = true;
      signalSnapshotStarted();
      await snapshotGate;
    }
    await route.continue();
  });
  await editor.evaluate(() => {
    window.__topicIntentPrintCount = 0;
    window.print = () => { window.__topicIntentPrintCount += 1; };
  });

  await editor.locator('#topicPrint').click();
  await snapshotStarted;
  const liveValue = editor.locator('.topic-trend-card tbody tr').first().locator('td').first();
  await expect(liveValue).toHaveAttribute('contenteditable', 'false');
  await liveValue.evaluate((cell) => {
    cell.contentEditable = 'true';
    cell.textContent = '999';
    cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '999' }));
  });
  releaseSnapshot();

  await expect(editor.locator('#topicLeaseNotice')).toContainText('列印等待期間內容已變更', { timeout: 10000 });
  expect(await editor.evaluate(() => window.__topicIntentPrintCount)).toBe(0);
  await expect(liveValue).toHaveText('999');
  const state = await (await request.get('/__fake_state')).json();
  expect(state.topicReports[0].revision).toBe(2);
  expect(state.topicSnapshots).toHaveLength(1);
});

test('專題PDF等待snapshot期間取得編輯並恢復草稿也會以整體內容世代fail closed', async ({ browser, request }) => {
  const context = await browser.newContext();
  const monthly = await context.newPage();
  let releaseSnapshot = () => {};
  try {
    await enterAndLogin(monthly, 'owner', 'owner-pass');
    const list = await openTopicList(monthly);
    const first = await createTopic(list, 'PDF restore draft intent 專題');
    const reportId = new URL(first.url()).searchParams.get('report');
    const secondPromise = first.waitForEvent('popup');
    await first.evaluate(() => window.open(window.location.href, '_blank'));
    const second = await secondPromise;
    await expect(second.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
    await expect(second.locator('#topicModeBadge')).toHaveText('唯讀');

    const cloud = await (await request.get('/__fake_state')).json();
    const report = cloud.topicReports.find((item) => item.id === reportId);
    await second.evaluate(({ id, revision, content }) => {
      const identity = window.TopicReportEditor.getIdentity();
      const editorState = window.TopicReportEditor.getState();
      const draftContent = structuredClone(content);
      draftContent.modules[0].columns[0] = '<p>等待列印時恢復的整體草稿</p>';
      const key = `topic:v1:draft:${id}:${identity.user.id}:${editorState.editorWindowId}`;
      localStorage.setItem(key, JSON.stringify({
        version: 1, domain: 'topic', reportId: id, actorUserId: identity.user.id,
        editorWindowId: editorState.editorWindowId, baseRevision: revision,
        content: draftContent, savedLocallyAt: new Date().toISOString()
      }));
    }, { id: reportId, revision: report.revision, content: report.content });

    let signalSnapshotStarted;
    const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
    const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
    let held = false;
    await second.route('**/__fake_rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (!held && body?.name === 'monthly_v7_topic_create_snapshot') {
        held = true;
        signalSnapshotStarted();
        await snapshotGate;
      }
      await route.continue();
    });
    await second.evaluate(() => {
      window.__topicRestorePrintCount = 0;
      window.print = () => { window.__topicRestorePrintCount += 1; };
    });

    await second.locator('#topicPrint').click();
    await snapshotStarted;
    await expect(second.locator('#topicAcquireEdit')).toBeDisabled();
    first.once('dialog', (dialog) => dialog.accept());
    const firstClosed = first.waitForEvent('close');
    await first.locator('#topicDiscardExit').click();
    await firstClosed;

    second.on('dialog', (dialog) => dialog.accept());
    await second.evaluate(() => {
      const acquire = document.querySelector('#topicAcquireEdit');
      acquire.hidden = false;
      acquire.disabled = false;
      acquire.click();
    });
    await expect(second.locator('#topicModeBadge')).toHaveText('可編輯', { timeout: 20000 });
    await expect(second.locator('.topic-editable').first()).toContainText('等待列印時恢復的整體草稿');
    releaseSnapshot();

    await expect(second.locator('#topicLeaseNotice')).toContainText('列印等待期間內容已變更', { timeout: 10000 });
    expect(await second.evaluate(() => window.__topicRestorePrintCount)).toBe(0);
  } finally {
    releaseSnapshot();
    await context.close();
  }
});

test('專題PDF等待snapshot clone內所有圖片decode完成且拒絕重入列印', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'PDF clone decode 專題');
  const editable = editor.locator('.topic-editable').first();
  await editable.click();
  await editor.locator('[data-insert="trend"]').click();
  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);

  await editor.evaluate(() => {
    const originalDecode = HTMLImageElement.prototype.decode;
    window.__topicDecodeStarted = 0;
    window.__topicDecodeResolvers = [];
    window.__topicDecodePrintCount = 0;
    HTMLImageElement.prototype.decode = function patchedDecode() {
      if (this.closest('#topicPrintArea')) {
        window.__topicDecodeStarted += 1;
        return new Promise((resolve) => { window.__topicDecodeResolvers.push(resolve); });
      }
      return originalDecode ? originalDecode.call(this) : Promise.resolve();
    };
    window.__releaseTopicImageDecode = () => {
      window.__topicDecodeResolvers.splice(0).forEach((resolve) => resolve());
    };
    window.print = () => { window.__topicDecodePrintCount += 1; };
  });

  const before = await (await request.get('/__fake_state')).json();
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicDecodeStarted)).toBeGreaterThan(0);
  expect(await editor.evaluate(() => window.__topicDecodePrintCount)).toBe(0);
  await expect(editor.locator('#topicPrint')).toBeDisabled();
  await editor.evaluate(() => document.querySelector('#topicPrint').click());
  await editor.waitForTimeout(350);
  const during = await (await request.get('/__fake_state')).json();
  expect(during.topicSnapshots.length - before.topicSnapshots.length).toBe(1);
  expect(await editor.evaluate(() => window.__topicDecodeStarted)).toBe(1);
  await editor.evaluate(() => window.__releaseTopicImageDecode());
  await expect.poll(() => editor.evaluate(() => window.__topicDecodePrintCount)).toBe(1);
});

test('雙欄專題PDF維持欄內物件百分比、原色並產生可讀A4橫向檔', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, 'PDF資訊卡版面專題');
  await editor.locator('[data-module-layout]').first().selectOption('1:1');
  await expect(editor.locator('.topic-editable')).toHaveCount(2);
  const leftColumn = editor.locator('.topic-editable').nth(0);
  const rightColumn = editor.locator('.topic-editable').nth(1);

  await leftColumn.fill('督導 ');
  await leftColumn.click();
  await leftColumn.press('End');
  for (const type of ['highlight', 'indicator-blue']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }
  const answers = ['3', '4'];
  const promptHandler = async (dialog) => dialog.accept(answers.shift());
  editor.on('dialog', promptHandler);
  await editor.locator('[data-insert="table"]').click();
  await expect.poll(() => answers.length).toBe(0);
  editor.off('dialog', promptHandler);

  await rightColumn.fill('右欄 ');
  await rightColumn.click();
  await rightColumn.press('End');
  for (const type of ['kpi', 'progress', 'zone', 'trend']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }
  await expect(editor.locator('.topic-kpi-card')).toHaveCount(1);
  await editor.locator('#topicPdfScale').selectOption('100');
  await editor.locator('#topicPdfOrientation').selectOption('landscape');
  await editor.evaluate(() => {
    window.__topicLayoutPrintObserved = false;
    window.print = () => { window.__topicLayoutPrintObserved = true; };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicLayoutPrintObserved)).toBe(true);

  await editor.setViewportSize({ width: 1047, height: 1000 });
  await editor.emulateMedia({ media: 'print' });
  const geometry = await editor.evaluate(() => {
    document.body.classList.add('topic-printing-report');
    const area = document.querySelector('#topicPrintArea');
    const printColumns = Array.from(area.querySelectorAll('.topic-print-column'));
    const cards = Array.from(area.querySelectorAll('.topic-indicator-card,.topic-kpi-card,.topic-progress-card,.topic-zone-card'));
    const labels = [
      ...area.querySelectorAll('.topic-kpi-card .topic-card-values > span:not(.topic-kpi-avg-toggle)'),
      ...area.querySelectorAll('.topic-progress-card .topic-card-head > span'),
      ...area.querySelectorAll('.topic-zone-card .topic-card-head > span')
    ];
    return {
      layout: area.querySelector('.topic-print-columns').dataset.layout,
      columnWidths: printColumns.map((column) => column.getBoundingClientRect().width),
      cards: cards.map((card) => ({
        inlineWidth: card.style.width,
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
        clientWidth: card.clientWidth,
        scrollWidth: card.scrollWidth,
        columnWidth: card.closest('.topic-print-column').getBoundingClientRect().width
      })),
      highlight: (() => {
        const highlight = area.querySelector('.topic-highlight');
        return {
          text: highlight.textContent,
          inlineWidth: highlight.style.width,
          width: highlight.getBoundingClientRect().width,
          whiteSpace: getComputedStyle(highlight).whiteSpace
        };
      })(),
      tableRatio: (() => {
        const table = area.querySelector('table.topic-resizable-table');
        return table.getBoundingClientRect().width / table.closest('.topic-print-column').getBoundingClientRect().width;
      })(),
      labels: labels.map((label) => {
        const style = getComputedStyle(label);
        return {
          whiteSpace: style.whiteSpace,
          height: label.getBoundingClientRect().height,
          fontSize: Number.parseFloat(style.fontSize)
        };
      }),
      toggleDisplay: getComputedStyle(area.querySelector('.topic-kpi-avg-toggle')).display,
      trendImage: (() => {
        const image = area.querySelector('.topic-trend-card img.topic-inline-image');
        if (!image || !image.naturalWidth || !image.naturalHeight) return null;
        const probe = document.createElement('canvas');
        probe.width = image.naturalWidth;
        probe.height = image.naturalHeight;
        const context = probe.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const [r, g, b, a] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
          if (a > 24 && (r < 245 || g < 245 || b < 245)) inkPixels += 1;
        }
        return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, srcLength: image.src.length, inkPixels };
      })(),
      printColors: (() => {
        const selector = '.topic-highlight,.topic-indicator-card,.topic-kpi-card,.topic-progress-card,.topic-zone-card,.topic-trend-card,.topic-kpi-track,.topic-progress-fill,.topic-zone-track';
        const nodes = [area, ...area.querySelectorAll(selector)];
        return {
          exact: nodes.map((node) => getComputedStyle(node).printColorAdjust || getComputedStyle(node).webkitPrintColorAdjust),
          highlightBackground: getComputedStyle(area.querySelector('.topic-highlight')).backgroundColor,
          kpiGradient: getComputedStyle(area.querySelector('.topic-kpi-track')).backgroundImage,
          progressBackground: getComputedStyle(area.querySelector('.topic-progress-fill')).backgroundColor,
          zoneGradient: getComputedStyle(area.querySelector('.topic-zone-track')).backgroundImage
        };
      })()
    };
  });
  expect(geometry.layout).toBe('1:1');
  expect(geometry.columnWidths).toHaveLength(2);
  expect(geometry.cards).toHaveLength(4);
  expect(geometry.cards.every((card) => card.inlineWidth === '30%')).toBe(true);
  expect(geometry.cards.every((card) => card.width >= 130 && card.scrollWidth <= card.clientWidth + 1)).toBe(true);
  expect(geometry.cards.every((card) => card.width / card.columnWidth >= 0.28 && card.width / card.columnWidth <= 0.36)).toBe(true);
  expect(geometry.highlight).toEqual(expect.objectContaining({
    text: '  重要數值 100  ', inlineWidth: '', whiteSpace: 'pre-wrap'
  }));
  expect(geometry.highlight.width).toBeLessThan(150);
  expect(geometry.tableRatio).toBeGreaterThan(0.97);
  expect(geometry.labels.length).toBeGreaterThanOrEqual(5);
  expect(
    geometry.labels.every((label) => label.whiteSpace === 'nowrap' && label.height <= label.fontSize * 2.1),
    JSON.stringify(geometry, null, 2)
  ).toBe(true);
  expect(geometry.toggleDisplay).toBe('none');
  expect(geometry.trendImage).toEqual(expect.objectContaining({
    naturalWidth: expect.any(Number), naturalHeight: expect.any(Number), srcLength: expect.any(Number), inkPixels: expect.any(Number)
  }));
  expect(geometry.trendImage.naturalWidth).toBeGreaterThan(150);
  expect(geometry.trendImage.naturalHeight).toBeGreaterThan(150);
  expect(geometry.trendImage.srcLength).toBeGreaterThan(3000);
  expect(geometry.trendImage.inkPixels).toBeGreaterThan(1200);
  expect(geometry.printColors.exact.every((value) => value === 'exact')).toBe(true);
  expect(geometry.printColors.highlightBackground).toBe('rgb(253, 242, 248)');
  expect(geometry.printColors.kpiGradient).not.toBe('none');
  expect(geometry.printColors.progressBackground).toBe('rgb(34, 197, 94)');
  expect(geometry.printColors.zoneGradient).not.toBe('none');

  await testInfo.attach('topic-layout-dual-column-100-percent.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  const pdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5000);
  const mediaBox = (buffer) => {
    const match = buffer.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  };
  expect(mediaBox(pdf)).toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
  expect(mediaBox(pdf).width).toBeGreaterThan(mediaBox(pdf).height);
  await testInfo.attach('topic-layout-dual-column-color-landscape.pdf', { body: pdf, contentType: 'application/pdf' });

  await editor.evaluate(() => document.body.classList.remove('topic-printing-report'));
  await editor.emulateMedia({ media: 'screen' });
  await editor.locator('#topicPdfOrientation').selectOption('portrait');
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.locator('#topicPrintArea').getAttribute('data-pdf-orientation')).toBe('portrait');
  await editor.emulateMedia({ media: 'print' });
  await editor.evaluate(() => document.body.classList.add('topic-printing-report'));
  const portraitPdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(portraitPdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(mediaBox(portraitPdf).height).toBeGreaterThan(mediaBox(portraitPdf).width);
  await testInfo.attach('topic-layout-dual-column-color-portrait.pdf', { body: portraitPdf, contentType: 'application/pdf' });
});

test('專題PDF直式100%不讓窄欄表格覆蓋相鄰元件且項次可從第一頁開始分頁', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const list = await openTopicList(page);
  const editor = await createTopic(list, '直式100%真實排布專題');
  await editor.locator('[data-module-layout]').first().selectOption('1:1');
  const left = editor.locator('.topic-editable').nth(0);
  const right = editor.locator('.topic-editable').nth(1);

  await left.fill('左欄內容 ');
  await left.click();
  await left.press('End');
  const answers = ['3', '3'];
  const promptHandler = async (dialog) => dialog.accept(answers.shift());
  editor.on('dialog', promptHandler);
  await editor.locator('[data-insert="table"]').click();
  await expect.poll(() => answers.length).toBe(0);
  editor.off('dialog', promptHandler);
  await left.evaluate((node) => {
    const marker = document.createTextNode(' ');
    node.appendChild(marker);
    node.focus();
    const range = document.createRange();
    range.setStart(marker, marker.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  for (const type of ['highlight', 'indicator-orange', 'kpi']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }

  await right.fill('右欄內容 ');
  await right.click();
  await right.press('End');
  for (const type of ['indicator-orange', 'kpi', 'progress', 'zone', 'trend']) {
    await editor.locator(`[data-insert="${type}"]`).click();
  }
  await editor.locator('#topicTrendHeight').selectOption('500');
  await editor.locator('#topicPdfScale').selectOption('100');
  await editor.locator('#topicPdfOrientation').selectOption('portrait');
  await editor.evaluate(() => {
    window.__topicPortraitPrintObserved = false;
    window.print = () => { window.__topicPortraitPrintObserved = true; };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicPortraitPrintObserved)).toBe(true);

  await editor.setViewportSize({ width: 718, height: 1100 });
  await editor.emulateMedia({ media: 'print' });
  const geometry = await editor.evaluate(() => {
    document.body.classList.add('topic-printing-report');
    const area = document.querySelector('#topicPrintArea');
    const blockSelector = [
      ':scope > .topic-resizable-table',
      ':scope > .topic-highlight',
      ':scope > .topic-indicator-card',
      ':scope > .topic-kpi-card',
      ':scope > .topic-progress-card',
      ':scope > .topic-zone-card',
      ':scope > .topic-trend-card'
    ].join(',');
    const columns = Array.from(area.querySelectorAll('.topic-print-column'));
    const overflow = [];
    const overlaps = [];
    columns.forEach((column, columnIndex) => {
      const columnRect = column.getBoundingClientRect();
      const blocks = Array.from(column.querySelectorAll(blockSelector));
      blocks.forEach((block, blockIndex) => {
        const rect = block.getBoundingClientRect();
        if (rect.left < columnRect.left - 1 || rect.right > columnRect.right + 1
          || block.scrollWidth > block.clientWidth + 1) {
          overflow.push({
            columnIndex, blockIndex, type: block.dataset.topicBlock || block.tagName,
            left: rect.left, right: rect.right, columnLeft: columnRect.left, columnRight: columnRect.right,
            clientWidth: block.clientWidth, scrollWidth: block.scrollWidth
          });
        }
      });
      for (let first = 0; first < blocks.length; first += 1) {
        const a = blocks[first].getBoundingClientRect();
        for (let second = first + 1; second < blocks.length; second += 1) {
          const b = blocks[second].getBoundingClientRect();
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapWidth > 1 && overlapHeight > 1) {
            overlaps.push({
              columnIndex, first, second,
              firstType: blocks[first].dataset.topicBlock || blocks[first].tagName,
              secondType: blocks[second].dataset.topicBlock || blocks[second].tagName,
              overlapWidth, overlapHeight
            });
          }
        }
      }
    });
    return {
      overflow,
      overlaps,
      moduleBreakInside: getComputedStyle(area.querySelector('.topic-print-module')).breakInside,
      indicatorCellMinWidths: Array.from(area.querySelectorAll('.topic-indicator-card td'))
        .map((cell) => getComputedStyle(cell).minWidth)
    };
  });
  expect(geometry.overflow, JSON.stringify(geometry, null, 2)).toEqual([]);
  expect(geometry.overlaps, JSON.stringify(geometry, null, 2)).toEqual([]);
  expect(geometry.moduleBreakInside).not.toBe('avoid');
  expect(geometry.indicatorCellMinWidths.every((value) => value === '0px')).toBe(true);

  await testInfo.attach('topic-user-shaped-portrait-100.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  const portraitPdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(portraitPdf.subarray(0, 5).toString()).toBe('%PDF-');
  await testInfo.attach('topic-user-shaped-portrait-100.pdf', { body: portraitPdf, contentType: 'application/pdf' });

  await editor.emulateMedia({ media: 'screen' });
  await editor.evaluate(() => document.body.classList.remove('topic-printing-report'));
  await editor.setViewportSize({ width: 1047, height: 900 });
  await editor.locator('#topicPdfOrientation').selectOption('landscape');
  await editor.evaluate(() => {
    window.__topicLandscapePrintObserved = false;
    window.print = () => { window.__topicLandscapePrintObserved = true; };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicLandscapePrintObserved)).toBe(true);
  await editor.emulateMedia({ media: 'print' });
  await editor.evaluate(() => document.body.classList.add('topic-printing-report'));
  await testInfo.attach('topic-user-shaped-landscape-100.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });
  const landscapePdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(landscapePdf.subarray(0, 5).toString()).toBe('%PDF-');
  await testInfo.attach('topic-user-shaped-landscape-100.pdf', { body: landscapePdf, contentType: 'application/pdf' });

  await editor.emulateMedia({ media: 'screen' });
  await editor.evaluate(() => document.body.classList.remove('topic-printing-report'));
  await editor.locator('#topicPdfScale').selectOption('90');
  await editor.evaluate(() => {
    window.__topicLandscape90PrintObserved = false;
    window.print = () => { window.__topicLandscape90PrintObserved = true; };
  });
  await editor.locator('#topicPrint').click();
  await expect.poll(() => editor.evaluate(() => window.__topicLandscape90PrintObserved)).toBe(true);
  await editor.emulateMedia({ media: 'print' });
  await editor.evaluate(() => document.body.classList.add('topic-printing-report'));
  const landscape90Pdf = await editor.pdf({ printBackground: false, preferCSSPageSize: true });
  expect(landscape90Pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await testInfo.attach('topic-user-shaped-landscape-90.pdf', { body: landscape90Pdf, contentType: 'application/pdf' });
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
  await expectEditorRevision(editor, 2);
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

test('趨勢圖固定高度且完整顯示緊湊數值表，可增減指標與週期並保存重開', async ({ page, request }, testInfo) => {
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
  await editor.locator('[data-topic-trend-action="series-add"]').click();
  await editor.locator('[data-topic-trend-action="series-add"]').click();
  await editor.locator('[data-topic-trend-action="period-add"]').click();
  await expect(trend.locator('thead th')).toHaveCount(6);
  await expect(trend.locator('tbody tr')).toHaveCount(4);
  await trend.locator('thead th').last().fill('事故率');
  await trend.locator('tbody tr').last().locator('td').first().fill('Q4');
  await editor.locator('#topicTrendHeight').selectOption('280');
  await editor.locator('[data-topic-object-width="70"]').click();
  await expect(trend.locator('.topic-chart-canvas-area')).toHaveCSS('height', '280px');
  expect(await trend.evaluate((node) => node.style.width)).toBe('70%');
  const tableGeometry = await trend.evaluate((card) => {
    const wrapper = card.querySelector('.topic-chart-table-area');
    const table = card.querySelector('.topic-chart-data');
    const cells = Array.from(table.querySelectorAll('th,td'));
    const wrapperRect = wrapper.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      wrapperClientWidth: wrapper.clientWidth,
      wrapperScrollWidth: wrapper.scrollWidth,
      overflowX: getComputedStyle(wrapper).overflowX,
      tableLeft: tableRect.left,
      tableRight: tableRect.right,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      maxFontSize: Math.max(...cells.map((cell) => Number.parseFloat(getComputedStyle(cell).fontSize))),
      maxCellHeight: Math.max(...cells.map((cell) => cell.getBoundingClientRect().height)),
      maxPaddingY: Math.max(...cells.map((cell) => Number.parseFloat(getComputedStyle(cell).paddingTop) + Number.parseFloat(getComputedStyle(cell).paddingBottom)))
    };
  });
  expect(tableGeometry.wrapperScrollWidth).toBeLessThanOrEqual(tableGeometry.wrapperClientWidth + 1);
  expect(tableGeometry.overflowX).toBe('visible');
  expect(tableGeometry.tableLeft).toBeGreaterThanOrEqual(tableGeometry.cardLeft - 1);
  expect(tableGeometry.tableRight).toBeLessThanOrEqual(tableGeometry.cardRight + 1);
  expect(tableGeometry.maxFontSize).toBeLessThanOrEqual(11);
  expect(tableGeometry.maxCellHeight).toBeLessThanOrEqual(22);
  expect(tableGeometry.maxPaddingY).toBeLessThanOrEqual(4);
  await testInfo.attach('topic-trend-table-five-series-complete.png', {
    body: await editor.screenshot({ fullPage: true }), contentType: 'image/png'
  });

  await editor.locator('#topicSave').click();
  await expectEditorRevision(editor, 2);
  const state = await (await request.get('/__fake_state')).json();
  const html = state.topicReports[0].content.modules[0].columns[0];
  expect(html).toContain('事故率');
  expect(html).toContain('data-topic-chart-height="280"');
  expect(html).toContain('width:70%');

  await editor.reload();
  await expect(editor.locator('#topicEditorPage')).toBeVisible({ timeout: 20000 });
  const reopened = editor.locator('.topic-trend-card');
  await expect(reopened.locator('thead th')).toHaveCount(6);
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
