'use strict';

const { test, expect } = require('@playwright/test');

async function enterAndLogin(page, username, password, expectedModuleCount = 2) {
  await page.addInitScript(() => {
    const guardKey = '__monthly_pw_first_boot_intercepted';
    if (sessionStorage.getItem(guardKey)) return;
    sessionStorage.setItem(guardKey, '1');
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => {
        capturedOnload = handler;
        window.__monthlyPwCapturedOnload = handler;
      }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__monthlyPwCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__monthlyPwCapturedOnload = null;
    await boot.call(window);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized)), {
    message: 'V7 app should finish one deterministic production window.onload initialization'
  }).toBe(true);
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.MonthlyV7App
    && window.MonthlyV7App.client
    && window.MonthlyV7App.client.siteSession
    && window.MonthlyV7App.client.siteSession.id
  )), { message: 'V7 authoritative site session should be ready before user login' }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const snapshotModules = window.MonthlyV7App?.client?.snapshot?.modules || [];
    const snapshotIds = snapshotModules.map((item) => String(item?.id || ''));
    const modelIds = Array.isArray(reportData)
      ? reportData.map((item) => String(item?._v7Id || ''))
      : [];
    const domIds = Array.from(document.querySelectorAll('#tableBody tr[data-v7-entity-id]'))
      .map((row) => String(row.dataset.v7EntityId || ''));
    return snapshotIds.length > 0
      && JSON.stringify(modelIds) === JSON.stringify(snapshotIds)
      && JSON.stringify(domIds) === JSON.stringify(snapshotIds);
  }), {
    timeout: 30000,
    message: 'site-entry boot should finish applying the authoritative snapshot before user login'
  }).toBe(true);
  await page.evaluate(({ loginUsername, loginPassword }) => {
    window.__monthlyPwLoginState = { status: 'pending', error: '' };
    window.__monthlyPwLoginPromise = window.MonthlyV7App.login(loginUsername, loginPassword)
      .then(() => {
        renderV5SessionBar();
        window.__monthlyPwLoginState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__monthlyPwLoginState = { status: 'error', error: String(error?.message || error) };
      });
  }, { loginUsername: username, loginPassword: password });
  await expect.poll(() => page.evaluate(() => window.__monthlyPwLoginState?.status), { timeout: 30000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__monthlyPwLoginState)).toEqual({ status: 'done', error: '' });
  await expect(page.locator('#v5TopStatus')).toContainText(username === 'owner' ? 'Owner A' : 'Operator B');
  await expect(page.locator('#tableBody tr')).toHaveCount(expectedModuleCount);
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function syncLatestExpectingSessionInvalid(page) {
  await page.evaluate(() => {
    window.__monthlySyncInvalidState = { status: 'pending', error: '' };
    window.__monthlySyncInvalidPromise = window.MonthlyV7App.syncLatest()
      .then(() => {
        window.__monthlySyncInvalidState = { status: 'resolved', error: '' };
      })
      .catch((error) => {
        window.__monthlySyncInvalidState = {
          status: 'rejected',
          error: String(error?.code || error?.message || error || '')
        };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__monthlySyncInvalidState?.status || 'missing'), { timeout: 15000 })
    .toMatch(/^(resolved|rejected)$/);
  const state = await page.evaluate(() => window.__monthlySyncInvalidState);
  expect(state.status).toBe('rejected');
  expect(state.error).toMatch(/(?:READ|USER)_SESSION_INVALID/);
}

async function installPdfColorFixture(page) {
  await page.evaluate(() => {
    const rows = [
      { label: '06月', inspectionCount: 10, deficiencyTotal: 4, detentionTotal: 1, actionCompletionRate: 65 },
      { label: '07月', inspectionCount: 14, deficiencyTotal: 6, detentionTotal: 2, actionCompletionRate: 78 },
      { label: '08月', inspectionCount: 18, deficiencyTotal: 5, detentionTotal: 1, actionCompletionRate: 92 }
    ];
    const current = rows.at(-1);
    const components = `
      <table class="custom-data-table data-card-table" style="border:2px solid #f97316;border-collapse:collapse;background:#fff7ed;width:30%;">
        <thead><tr><th colspan="2" style="color:#f97316;border-bottom:2px solid #f97316;">橙色資料卡</th></tr></thead>
        <tbody><tr><td>檢查次數</td><td>18</td></tr></tbody>
      </table>
      <div class="kpi-card-container" style="border:2px solid #cbd5e1;padding:12px;background:#fff;">
        <div>KPI 色帶</div>
        <div class="kpi-bar-wrapper" style="position:relative;height:12px;">
          <div class="kpi-bar-container" style="position:absolute;width:100%;height:100%;background:linear-gradient(to right,#22c55e 0%,#eab308 50%,#ef4444 100%);"></div>
        </div>
      </div>
      <div class="zone-card-container" style="border:2px solid #cbd5e1;padding:12px;background:#fff;">
        <div>三色區間</div>
        <div class="zone-bar" style="height:10px;background:linear-gradient(to right,#22c55e 0%,#22c55e 30%,#eab308 30%,#eab308 70%,#ef4444 70%,#ef4444 100%);"></div>
      </div>
      <div class="trend-chart-container" style="border:2px solid #cbd5e1;padding:8px;background:#fff;">
        <div class="chart-layout-wrapper" style="display:flex;gap:8px;width:100%;">
          <div class="no-print chart-table-area" style="flex:0 0 auto;max-width:35%;">
            <table class="chart-data-table"><thead><tr><th>週期</th><th>安全</th><th>品質</th></tr></thead>
              <tbody><tr><td>06月</td><td>10</td><td>6</td></tr><tr><td>07月</td><td>14</td><td>9</td></tr><tr><td>08月</td><td>18</td><td>12</td></tr></tbody>
            </table>
          </div>
          <div class="chart-canvas-area" style="flex:1 1 auto;height:180px;min-width:0;position:relative;"><canvas class="trend-canvas"></canvas></div>
        </div>
      </div>`;
    reportData[0].title = 'PDF 版面與色彩回歸';
    reportData[0].columns = [v3ReportKpiHtml(current, rows) + v3MultiLineSvg(rows) + components];
    reportData[0].colLayout = '1';
    reportData[0].selectedForPdf = true;
    reportData.slice(1).forEach((item) => { item.selectedForPdf = false; });
    renderTable();
    v1EnsureModuleFields();
  });
}

async function installTrendPdfGeometryFixture(page) {
  await page.evaluate(() => {
    const values = [
      ['01', '4.1', '5.0', '12.5', '0.5'],
      ['02', '4.4', '3.0', '0', '1'],
      ['03', '2.7', '5.0', '8.8', '1.8'],
      ['04', '3.0', '3.0', '0', '1.3'],
      ['05', '4.0', '3.0', '10', '0.4'],
      ['06', '3.7', '0', '8.5', '2.1'],
      ['07', '4.8', '4.0', '8.0', '0'],
      ['08', '0', '0', '0', '0'],
      ['09', '0', '0', '0', '0'],
      ['10', '0', '0', '0', '0'],
      ['11', '0', '0', '0', '0'],
      ['12', '0', '0', '0', '0']
    ];
    const cellStyle = 'border:1px solid #cbd5e1;padding:3px 5px;text-align:center;white-space:nowrap;font-size:13px;min-width:36px;';
    const header = ['週期', 'SIRE', 'CDI', 'RS', 'PSC']
      .map((label) => `<th style="${cellStyle}background:#f1f5f9;font-weight:bold;">${label}</th>`).join('');
    const body = values.map((row) => `<tr>${row.map((value, index) => `<td class="${index ? 'chart-val' : ''}" style="${cellStyle}">${value}</td>`).join('')}</tr>`).join('');
    const trend = (suffix) => `
      <div class="trend-chart-container" data-trend-chart="1" style="border:2px solid #cbd5e1;padding:8px;border-radius:6px;background:#fff;width:100%;box-sizing:border-box;overflow:hidden;">
        <div class="chart-title" style="font-size:14px;font-weight:bold;">多維度趨勢比較圖 ${suffix}</div>
        <div class="chart-layout-wrapper" style="display:flex;flex-direction:row;flex-wrap:nowrap;gap:8px;align-items:stretch;width:100%;">
          <div class="no-print chart-table-area chart-table-wrapper" style="flex:0 0 auto;max-width:35%;overflow-x:auto;background:#f8fafc;border:1px dashed #cbd5e1;padding:1px;">
            <table class="chart-data-table" style="width:max-content;border-collapse:collapse;font-size:13px;background:#fff;line-height:1.3;margin:0;"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>
          </div>
          <div class="chart-canvas-area" data-chart-height="200" style="flex:1 1 auto;height:200px;min-width:0;position:relative;"><canvas class="trend-canvas"></canvas></div>
        </div>
      </div>`;
    reportData[0].title = '趨勢圖 PDF 幾何回歸';
    reportData[0].columns = [trend('A'), trend('B')];
    reportData[0].colLayout = '1:1';
    reportData[0].selectedForPdf = true;
    reportData.slice(1).forEach((item) => { item.selectedForPdf = false; });
    renderTable();
    v1EnsureModuleFields();
    window.renderAllCharts();
  });
}

async function installTypographyFixture(page) {
  await page.evaluate(() => {
    const rows = [
      { label: '06月', inspectionCount: 10, deficiencyTotal: 4, detentionTotal: 1, pscAvg: 0.4, highRiskCount: 1, repeatedCount: 1, actionCompletionRate: 65, safetyWalkCount: 2 },
      { label: '07月', inspectionCount: 14, deficiencyTotal: 6, detentionTotal: 2, pscAvg: 0.43, highRiskCount: 2, repeatedCount: 1, actionCompletionRate: 78, safetyWalkCount: 3 },
      { label: '08月', inspectionCount: 18, deficiencyTotal: 5, detentionTotal: 1, pscAvg: 0.28, highRiskCount: 1, repeatedCount: 0, actionCompletionRate: 92, safetyWalkCount: 4 }
    ];
    const legacySizedComponents = `
      ${parseHighlights(BlockTemplates.blue('綜合評估', '本月船隊表現【穩定】，所有內文與數值應清楚可讀。'))}
      <table class="custom-data-table data-card-table" style="border:2px solid #3b82f6;border-collapse:collapse;background:#fff;width:30%;">
        <thead><tr><th colspan="2" style="font-size:14px;">指標名稱</th></tr></thead>
        <tbody><tr><td style="font-size:13px;">檢查次數</td><td style="font-size:15px;">18</td></tr></tbody>
      </table>
      <div class="kpi-card-container" style="border:2px solid #cbd5e1;padding:12px 14px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div class="fixture-card-title" style="font-size:14px;font-weight:bold;">Deficiency Index</div>
          <div><span class="kpi-label-current" style="font-size:10px;">現值</span> <span class="kpi-val current-val" style="font-size:14px;font-weight:bold;">1.52</span></div>
        </div>
        <div class="kpi-bar-wrapper" style="position:relative;height:12px;margin:6px;"><div class="kpi-bar-container" style="position:absolute;width:100%;height:100%;background:linear-gradient(to right,#22c55e,#ef4444);"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;"><span class="kpi-min">0</span><span class="kpi-max">5</span></div>
      </div>
      <div class="progress-card-container" style="border:2px solid #cbd5e1;padding:12px 14px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div class="fixture-card-title" style="font-size:14px;font-weight:bold;">完成率</div>
          <div><span class="progress-label" style="font-size:10px;">完成度</span> <span class="kpi-val progress-val" style="font-size:14px;font-weight:bold;">92</span><span style="font-size:12px;">%</span></div>
        </div>
      </div>
      <div class="zone-card-container" style="border:2px solid #cbd5e1;padding:12px 14px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div class="fixture-card-title" style="font-size:14px;font-weight:bold;">風險區間</div>
          <div><span class="zone-label-current" style="font-size:10px;">現值</span> <span class="zone-val current-val" style="font-size:14px;font-weight:bold;">2.64</span></div>
        </div>
        <div style="position:relative;height:14px;font-size:10px;"><span class="zone-limit-mid">2.45</span></div>
        <div class="zone-bar" style="height:10px;background:linear-gradient(to right,#22c55e,#eab308,#ef4444);"></div>
        <div style="position:relative;height:14px;font-size:10px;"><span class="zone-min">0</span><span class="zone-limit1">1.45</span><span class="zone-max">5</span></div>
      </div>
      <div class="trend-chart-container" style="border:2px solid #cbd5e1;padding:8px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div class="chart-title" style="font-size:14px;font-weight:bold;">趨勢圖</div>
          <div class="no-print"><span style="font-size:10px;">指標控制</span></div>
        </div>
        <div class="chart-layout-wrapper" style="display:flex;gap:8px;width:100%;">
          <div class="no-print chart-table-area" style="flex:0 0 auto;max-width:35%;overflow-x:auto;">
            <table class="chart-data-table" style="font-size:6px;"><thead><tr><th style="font-size:6px;">週期</th><th style="font-size:6px;">安全</th><th style="font-size:6px;">品質</th></tr></thead>
              <tbody><tr><td style="font-size:6px;">06月</td><td class="chart-val" style="font-size:6px;">10</td><td class="chart-val" style="font-size:6px;">6</td></tr><tr><td style="font-size:6px;">07月</td><td class="chart-val" style="font-size:6px;">14</td><td class="chart-val" style="font-size:6px;">9</td></tr><tr><td style="font-size:6px;">08月</td><td class="chart-val" style="font-size:6px;">18</td><td class="chart-val" style="font-size:6px;">12</td></tr></tbody>
            </table>
          </div>
          <div class="chart-canvas-area" style="flex:1 1 auto;height:220px;min-width:0;position:relative;"><canvas class="trend-canvas"></canvas></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">${v3KpiCard('檢查總數', 18, '較上月增加 4 次', '#2563eb', [10, 14, 18])}</div>
      ${v3MultiLineSvg(rows)}
      ${v3TrendTable(rows)}
    `;
    reportData[0].title = '項目字級回歸';
    reportData[0].columns = [legacySizedComponents];
    reportData[0].colLayout = '1';
    renderTable();
    v1EnsureModuleFields();
    window.renderAllCharts();
  });
}

test.beforeEach(async ({ request }) => {
  await request.post('/__fake_reset');
});

test('雲端 module title 保留安全格式但不得建立或執行持久型 XSS 節點', async ({ page, request }) => {
  await page.addInitScript(() => { window.__v7TitleXssExecuted = 0; });
  await request.post('/__fake_malicious_module_title');
  await enterAndLogin(page, 'owner', 'owner-pass');

  const title = page.locator('#tableBody .module-title-editor').first();
  await expect(title.locator('b')).toHaveText('安全粗體');
  await expect(title.locator('b')).not.toHaveAttribute('data-safe-title');
  await expect(title.locator('img,script,iframe,object,embed,svg,math')).toHaveCount(0);
  expect(await title.evaluate((element) => Array.from(element.querySelectorAll('*')).some((node) =>
    Array.from(node.attributes).some((attribute) => /^on/i.test(attribute.name))
  ))).toBe(false);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__v7TitleXssExecuted)).toBe(0);
});

test('登出帳號保留 site session 並立即移除 Owner 身份，不退回進站 gate', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');

  await page.getByRole('button', { name: '登出', exact: true }).click();

  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('#v5-login-username')).toBeVisible();
  await expect(page.locator('#v5TopStatus')).toContainText('帳號已登出；網站仍已解鎖。');
  await expect(page.locator('#v5TopStatus')).toContainText('未登入');
  await expect(page.locator('#v5TopStatus')).not.toContainText('尚未建立 owner');
  await expect(page.locator('#v5TopStatus')).not.toContainText('伺服器撤銷未確認');
  await expect(page.locator('#v5TopStatus')).not.toContainText('Owner A');
  const state = await page.evaluate(() => ({
    siteSessionId: window.MonthlyV7App?.client?.siteSession?.id || '',
    userSession: window.MonthlyV7App?.client?.userSession || null,
    currentUser: window.MonthlyV7App?.currentUser?.() || null,
    storedSiteSession: sessionStorage.getItem('monthly_v7_site_session'),
    storedUserSession: sessionStorage.getItem('monthly_v7_user_session'),
    storedUserProjection: sessionStorage.getItem('monthly_v7_user_projection')
  }));
  expect(state.siteSessionId).not.toBe('');
  expect(state.userSession).toBeNull();
  expect(state.currentUser).toBeNull();
  expect(state.storedSiteSession).not.toBeNull();
  expect(state.storedUserSession).toBeNull();
  expect(state.storedUserProjection).toBeNull();
});

test('登入帳密通過但 snapshot 連續逾時時回到未登入，禁止背景保存且不誤報密碼錯誤', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await page.evaluate(() => { window.MonthlyV7App.transport.requestTimeoutMs = 35; });
  await request.post('/__fake_hang_rpc?name=monthly_v7_get_snapshot&count=2');

  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();

  await expect.poll(() => dialogs.length, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(page.locator('#v5TopStatus')).toContainText('帳號驗證已通過，但雲端資料載入失敗');
  await expect(page.locator('#v5TopStatus')).toContainText('本機草稿已保留');
  await expect(page.locator('#v5TopStatus')).toContainText('未登入');
  expect(dialogs.some((message) => message.includes('用戶名或密碼不正確'))).toBe(false);
  expect(await page.evaluate(() => ({
    currentUser: window.MonthlyV7App.currentUser(),
    writeReady: window.MonthlyV7App.isWriteReady(),
    userSession: window.MonthlyV7App.client.userSession,
    storedUserSession: sessionStorage.getItem('monthly_v7_user_session'),
    autoSaveScheduled: V4_AUTO_SAVE_TIMER !== null,
    saveInFlight: V7_CLOUD_SAVE_PROMISE !== null
  }))).toEqual({
    currentUser: null,
    writeReady: false,
    userSession: null,
    storedUserSession: null,
    autoSaveScheduled: false,
    saveInFlight: false
  });
});

test('首次 normalized 僅恢復可信較新的既有項目，本機獨有項隔離且 lost-ACK 重載後不重建', async ({ page, request }) => {
  test.setTimeout(150000);
  await request.post('/__fake_reverse_module_order');
  await page.addInitScript(() => {
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => null,
      set: (handler) => {
        capturedOnload = handler;
        window.__legacyCapturedOnload = handler;
      }
    });
    localStorage.setItem('safety_report_file_id', 'browser-report');
    const request = indexedDB.open('SafetyMeetingDB', 1);
    window.__legacySeed = new Promise((resolve, reject) => {
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('reportStore')) db.createObjectStore('reportStore', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction(['reportStore'], 'readwrite');
        tx.objectStore('reportStore').put({
          id: 'browser-report',
          data: [
            { id: 101, title: '本機原項次 A', columns: ['本機編輯 A'], colLayout: '1' },
            { id: 102, title: '本機原項次 B', columns: ['本機編輯 B'], colLayout: '1' },
            { id: 999, title: '本機新增 C', columns: ['本機新增內容 C'], colLayout: '1' }
          ],
          title: '本機切換前月報', date: '2026-08-09',
          period: { startM: '8', startD: '1', endM: '8', endD: '31' },
          timestamp: Date.parse('2026-08-11T00:00:00.000Z')
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    await window.__legacySeed;
    const boot = window.__legacyCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__legacyCapturedOnload = null;
    await boot.call(window);
  });
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  await expect.poll(() => page.evaluate(() => reportData.map((row) => [String(row.id), row.columns?.[0]])), { timeout: 30000 })
    .toEqual([['101', '本機編輯 A'], ['102', '本機編輯 B']]);
  await expect(page.locator('#v5TopStatus')).toContainText('恢復切換前原項次');
  await expect(page.locator('#v5TopStatus')).toContainText('已隔離');
  await expect(page.locator('#v5TopStatus')).toContainText('禁止背景');

  const before = await (await request.get('/__fake_state')).json();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await page.evaluate(() => {
    V7_CLOUD_DIRTY_GENERATION += 1;
    v7ScheduleCloudAutoSave(10);
  });
  await page.waitForTimeout(150);
  const after = await (await request.get('/__fake_state')).json();
  expect(after.modules).toEqual(before.modules);
  expect(await page.evaluate(async () => ({
    recovery: await loadFromDB(v7LegacyRecoveryId(window.MonthlyV7App.client.snapshot)),
    autoSaveScheduled: V4_AUTO_SAVE_TIMER !== null,
    order: reportData.map((row) => String(row.id))
  }))).toMatchObject({
    recovery: { v7Recovery: true, recoverySourceId: 'browser-report' },
    autoSaveScheduled: false,
    order: ['101', '102']
  });

  await page.evaluate(() => { window.MonthlyV7App.transport.requestTimeoutMs = 35; });
  await request.post('/__fake_hang_rpc?name=monthly_v7_reorder_modules&count=always');
  await page.locator('#v5TopStatus button[onclick="v5SaveChangesToCloud()"] >> visible=true').click();
  await expect(page.locator('#v5TopStatus')).toContainText('RPC_TIMEOUT', { timeout: 30000 });
  const partiallyCommitted = await (await request.get('/__fake_state')).json();
  expect(partiallyCommitted.modules.map((row) => [String(row.payload.id), row.payload.columns?.[0]])).toEqual([
    ['102', '本機編輯 B'],
    ['101', '本機編輯 A']
  ]);
  expect(partiallyCommitted.modules.filter((row) => String(row.payload.id) === '999')).toHaveLength(0);
  expect(await page.evaluate(async () => ({
    recovery: await loadFromDB(v7LegacyRecoveryId(window.MonthlyV7App.client.currentReport()?.id)),
    recoveryFlag: window.MonthlyV7App.client.snapshot?.legacyLocalRecovery || null
  }))).toMatchObject({ recovery: { v7Recovery: true }, recoveryFlag: { orderChanged: true } });

  await request.post('/__fake_hang_rpc?name=monthly_v7_reorder_modules&count=0');
  const reopened = page;
  const reloadCapturedProductionBoot = async () => {
    await reopened.reload({ waitUntil: 'domcontentloaded' });
    await reopened.evaluate(async () => {
      const boot = window.__legacyCapturedOnload;
      if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED_AFTER_RELOAD');
      window.onload = null;
      window.__legacyCapturedOnload = null;
      await boot.call(window);
    });
  };
  await reloadCapturedProductionBoot();
  if (await reopened.locator('#siteAccessGate').isVisible()) {
    await reopened.locator('#site-access-password').fill('gate-pass');
    await reopened.getByRole('button', { name: '進入系統' }).click();
  }
  await expect(reopened.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => reopened.evaluate(() => reportData.map((row) => [
    String(row.id), row.columns?.[0], Boolean(row._v7Id)
  ])), { timeout: 30000 }).toEqual([
    ['101', '本機編輯 A', true],
    ['102', '本機編輯 B', true]
  ]);
  const beforeRetry = await (await request.get('/__fake_state')).json();
  expect(beforeRetry.modules).toHaveLength(2);

  if (!(await reopened.locator('#v5TopStatus').innerText()).includes('Owner A')) {
    await reopened.locator('#v5-login-username').fill('owner');
    await reopened.locator('#v5-login-password').fill('owner-pass');
    await reopened.getByRole('button', { name: '登入', exact: true }).click();
  }
  await expect(reopened.locator('#v5TopStatus')).toContainText('Owner A');
  await reopened.locator('#v5TopStatus button[onclick="v5SaveChangesToCloud()"] >> visible=true').click();
  await expect(reopened.locator('#v5TopStatus')).toContainText('已隔離', { timeout: 30000 });
  await expect(reopened.locator('#v5TopStatus')).toContainText('不會上傳或重建');
  const committed = await (await request.get('/__fake_state')).json();
  expect(committed.modules.map((row) => [String(row.payload.id), row.payload.columns?.[0]])).toEqual([
    ['101', '本機編輯 A'],
    ['102', '本機編輯 B']
  ]);
  expect(committed.modules.filter((row) => String(row.payload.id) === '999')).toHaveLength(0);
  const retainedRecovery = await reopened.evaluate(async () => ({
    recovery: await loadFromDB(v7LegacyRecoveryId(window.MonthlyV7App.client.currentReport()?.id)),
    recoveryFlag: window.MonthlyV7App.client.snapshot?.legacyLocalRecovery || null,
    order: reportData.map((row) => String(row.id))
  }));
  expect(retainedRecovery).toMatchObject({
    recovery: { v7Recovery: true, recoverySourceId: 'browser-report' },
    recoveryFlag: { hasAcceptedRecovery: false },
    order: ['101', '102']
  });
  expect(retainedRecovery.recoveryFlag.quarantinedCount).toBeGreaterThanOrEqual(1);

  await reloadCapturedProductionBoot();
  await expect(reopened.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => reopened.evaluate(() => reportData.map((row) => [String(row.id), row.columns?.[0]])), { timeout: 30000 })
    .toEqual([
      ['101', '本機編輯 A'],
      ['102', '本機編輯 B']
    ]);
  const reloadedRecovery = await reopened.evaluate(async () => ({
    recovery: await loadFromDB(v7LegacyRecoveryId(window.MonthlyV7App.client.currentReport()?.id)),
    recoveryFlag: window.MonthlyV7App.client.snapshot?.legacyLocalRecovery || null
  }));
  expect(reloadedRecovery).toMatchObject({
    recovery: { v7Recovery: true, recoverySourceId: 'browser-report' },
    recoveryFlag: { hasAcceptedRecovery: false }
  });
  expect(reloadedRecovery.recoveryFlag.quarantinedCount).toBeGreaterThanOrEqual(1);
});

test('較舊 legacy 快取即使人工按保存也不覆蓋雲端或重建已不存在項目', async ({ page, request }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => null,
      set: (handler) => {
        capturedOnload = handler;
        window.__legacyCapturedOnload = handler;
      }
    });
    localStorage.setItem('safety_report_file_id', 'browser-report');
    const request = indexedDB.open('SafetyMeetingDB', 1);
    window.__legacySeed = new Promise((resolve, reject) => {
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('reportStore')) db.createObjectStore('reportStore', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction(['reportStore'], 'readwrite');
        tx.objectStore('reportStore').put({
          id: 'browser-report',
          data: [
            { id: 101, title: '過時 A', columns: ['不可覆蓋 A'], colLayout: '1' },
            { id: 102, title: '過時 B', columns: ['不可覆蓋 B'], colLayout: '1' },
            { id: 999, title: '已刪除舊項目', columns: ['不可重建'], colLayout: '1' }
          ],
          title: '過時月報標題', date: '2026-08-01', period: {},
          timestamp: Date.parse('2026-08-09T00:00:00.000Z')
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    await window.__legacySeed;
    const boot = window.__legacyCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__legacyCapturedOnload = null;
    await boot.call(window);
  });
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => page.evaluate(() => reportData.map((row) => [String(row.id), row.columns?.[0]])))
    .toEqual([['101', 'A 內容'], ['102', 'B 內容']]);
  await expect(page.locator('#v5TopStatus')).toContainText('已隔離');
  expect(await page.evaluate(() => ({
    accepted: window.MonthlyV7App.client.snapshot.legacyLocalRecovery.hasAcceptedRecovery,
    draftCount: reportData.filter((row) => window.MonthlyV7App.client.readDraft('module', row._v7Id)).length
  }))).toEqual({ accepted: false, draftCount: 0 });

  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  const before = await (await request.get('/__fake_state')).json();
  await page.locator('#v5TopStatus button[onclick="v5SaveChangesToCloud()"] >> visible=true').click();
  await expect(page.locator('#v5TopStatus')).toContainText('不會上傳或重建', { timeout: 30000 });
  const after = await (await request.get('/__fake_state')).json();

  expect(after.modules).toEqual(before.modules);
  expect({
    title: after.report.title,
    date: after.report.date,
    period: after.report.period
  }).toEqual({
    title: before.report.title,
    date: before.report.date,
    period: before.report.period
  });
  expect(after.report.title).not.toBe('過時月報標題');
  expect(after.report.date).not.toBe('2026-08-01');
  expect(after.modules.filter((row) => String(row.payload.id) === '999')).toHaveLength(0);
  expect(await page.evaluate(async () => ({
    recovery: await loadFromDB(v7LegacyRecoveryId(window.MonthlyV7App.client.currentReport()?.id)),
    live: reportData.map((row) => [String(row.id), row.columns?.[0]])
  }))).toMatchObject({
    recovery: { v7Recovery: true, recoverySourceId: 'browser-report' },
    live: [['101', 'A 內容'], ['102', 'B 內容']]
  });
});

test('READ_SESSION_INVALID 立即收斂為未登入、保留 site 與本機草稿', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const draftKey = await page.evaluate(() => {
    const client = window.MonthlyV7App.client;
    const module = client.snapshot.modules[0];
    reportData[0].title = '失效前本機草稿';
    const title = document.querySelector('#tableBody .module-title-editor');
    if (title) title.textContent = reportData[0].title;
    client.saveDraft('module', module.id, { ...module.payload, title: reportData[0].title }, module.revision);
    return module.id;
  });
  await request.post('/__fake_invalidate_user_sessions');

  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.currentUser()), { timeout: 15000 }).toBeNull();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('#v5-login-username')).toBeVisible();
  await expect(page.locator('#v5TopStatus')).not.toContainText('Owner A');
  await expect(page.locator('#v5TopStatus')).toContainText('登入已失效；本機草稿已保留，請重新登入');
  const state = await page.evaluate((moduleId) => ({
    siteSessionId: window.MonthlyV7App.client.siteSession?.id || '',
    draftTitle: window.MonthlyV7App.client.readDraft('module', moduleId)?.payload?.title || '',
    invalidMessageCount: (document.getElementById('v5TopStatus')?.innerText.match(/登入已失效/g) || []).length
  }), draftKey);
  expect(state.siteSessionId).not.toBe('');
  expect(state.draftTitle).toBe('失效前本機草稿');
  expect(state.invalidMessageCount).toBe(1);
});

test('session invalid 不重建編輯 DOM，保留尚未完成防抖的焦點內容與草稿', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const editor = page.locator('#tableBody .module-title-editor').first();
  await editor.evaluate((node) => {
    node.focus();
    node.textContent = '失效瞬間尚未完成防抖的標題';
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '題' }));
  });

  await request.post('/__fake_invalidate_user_sessions');
  await syncLatestExpectingSessionInvalid(page);

  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  await expect(page.locator('#tableBody .module-title-editor').first()).toHaveText('失效瞬間尚未完成防抖的標題');
  await expect.poll(() => page.evaluate(() => {
    const id = window.MonthlyV7App.client.snapshot.modules[0].id;
    return window.MonthlyV7App.client.readDraft('module', id)?.payload?.title || '';
  }), { timeout: 5000 }).toBe('失效瞬間尚未完成防抖的標題');
});

test('session invalid 合併可見新內容時保留 module 與 report meta 的 superseding marker/base revision', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const expected = await page.evaluate(() => {
    const client = window.MonthlyV7App.client;
    const module = client.snapshot.modules[0];
    const staleModule = client.snapshot.modules[1];
    const report = client.currentReport();
    const moduleMarker = {
      rpcName: 'monthly_v7_save_module',
      pendingKey: `save_module:${module.id}`,
      operationId: '00000000-0000-4000-8000-000000000991',
      signature: '{"fixture":"module-a"}'
    };
    const staleModuleMarker = {
      rpcName: 'monthly_v7_save_module',
      pendingKey: `save_module:${staleModule.id}`,
      operationId: '00000000-0000-4000-8000-000000000993',
      signature: '{"fixture":"module-stale"}'
    };
    const reportMarker = {
      rpcName: 'monthly_v7_save_report_meta',
      pendingKey: `save_report_meta:${report.id}`,
      operationId: '00000000-0000-4000-8000-000000000992',
      signature: '{"fixture":"report-a"}'
    };
    client.saveDraft(
      'module', module.id,
      { ...module.payload, title: '既有 module 後繼草稿 B' },
      7,
      { supersedesOperation: moduleMarker }
    );
    client.saveDraft(
      'module', staleModule.id,
      { ...staleModule.payload, title: '較新的 existing draft D' },
      8,
      { supersedesOperation: staleModuleMarker }
    );
    client.saveDraft(
      'report_meta', report.id,
      {
        title: '既有 report meta 後繼草稿 B',
        date: report.date || '', period: report.period || {}, settings: report.settings || {}
      },
      9,
      { supersedesOperation: reportMarker }
    );
    const titles = document.querySelectorAll('#tableBody .module-title-editor');
    const title = titles[0];
    title.textContent = '防抖前 module 新內容 C';
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'C' }));
    titles[1].textContent = '未觸發 input 的舊 DOM B';
    const mainTitle = document.getElementById('mainTitle');
    mainTitle.textContent = '防抖前 report meta 新內容 C';
    mainTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'C' }));
    clearTimeout(window._globalInputSaveTimer);
    window._globalInputSaveTimer = null;
    return {
      moduleId: module.id, staleModuleId: staleModule.id, reportId: report.id,
      moduleMarker, staleModuleMarker, reportMarker
    };
  });

  await request.post('/__fake_invalidate_user_sessions');
  await syncLatestExpectingSessionInvalid(page);
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();

  const drafts = await page.evaluate(({ moduleId, staleModuleId, reportId }) => {
    const client = window.MonthlyV7App.client;
    return {
      module: client.readDraft('module', moduleId),
      staleModule: client.readDraft('module', staleModuleId),
      reportMeta: client.readDraft('report_meta', reportId)
    };
  }, expected);
  expect(drafts.module.payload.title).toBe('防抖前 module 新內容 C');
  expect(drafts.module.baseRevision).toBe(7);
  expect(drafts.module.supersedesOperation).toEqual(expected.moduleMarker);
  expect(drafts.staleModule.payload.title).toBe('較新的 existing draft D');
  expect(drafts.staleModule.baseRevision).toBe(8);
  expect(drafts.staleModule.supersedesOperation).toEqual(expected.staleModuleMarker);
  expect(drafts.reportMeta.payload.title).toBe('防抖前 report meta 新內容 C');
  expect(drafts.reportMeta.baseRevision).toBe(9);
  expect(drafts.reportMeta.supersedesOperation).toEqual(expected.reportMarker);
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

test('項目內容統一放大，部件標題維持原尺寸且圖表數值可讀', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installTypographyFixture(page);
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('#tableBody canvas.trend-canvas');
    return Boolean(canvas && canvas.width > 10 && canvas.height > 10 && Chart.getChart(canvas));
  })).toBe(true);
  await settleLayout(page);

  const typography = await page.evaluate(() => {
    const root = document.querySelector('#tableBody .module-content-cell');
    const px = (selector) => parseFloat(getComputedStyle(root.querySelector(selector)).fontSize);
    const canvas = root.querySelector('canvas.trend-canvas');
    const chart = Chart.getChart(canvas);
    const pointLabelPlugin = chart.config.plugins.find((plugin) => plugin.id === 'customDataLabels');
    const pointLabelMatch = String(pointLabelPlugin.afterDatasetsDraw).match(/bold\s+(\d+)px/);
    const svgFonts = Array.from(root.querySelectorAll('svg[aria-label="KPI 趨勢圖"] text'))
      .map((node) => parseFloat(getComputedStyle(node).fontSize));
    return {
      blockTitle: px('.block-title'),
      blockBody: px('.block-body'),
      highlightedValue: px('.highlight-val'),
      dataCardTitle: px('.data-card-table th'),
      dataCardLabel: px('.data-card-table tbody td:first-child'),
      dataCardValue: px('.data-card-table tbody td:nth-child(2)'),
      cardTitle: px('.fixture-card-title'),
      kpiLabel: px('.kpi-label-current'),
      kpiValue: px('.kpi-val.current-val'),
      kpiLimit: px('.kpi-min'),
      progressLabel: px('.progress-label'),
      progressValue: px('.progress-val'),
      progressUnit: px('.progress-val + span'),
      zoneLabel: px('.zone-label-current'),
      zoneValue: px('.zone-val.current-val'),
      zoneLimit: px('.zone-limit-mid'),
      zoneLimitRowHeight: root.querySelector('.zone-limit-mid').parentElement.getBoundingClientRect().height,
      chartTitle: px('.chart-title'),
      chartControl: px('.trend-chart-container > div:first-child .no-print span'),
      chartTableCell: px('.chart-data-table td'),
      reportKpiValue: px('.report-kpi-value'),
      reportKpiNote: px('.report-kpi-note'),
      reportTableHeader: px('.report-detail-table th'),
      reportTableValue: px('.report-detail-table td'),
      svgFonts,
      chartLegend: chart.config.options.plugins.legend.labels.font.size,
      chartXTick: chart.config.options.scales.x.ticks.font.size,
      chartYTick: chart.config.options.scales.y.ticks.font.size,
      chartTopPadding: chart.config.options.layout.padding.top,
      chartPointLabel: Number(pointLabelMatch?.[1] || 0)
    };
  });

  expect(typography.blockTitle).toBe(14);
  expect(typography.cardTitle).toBe(14);
  expect(typography.chartTitle).toBe(14);
  expect(typography.dataCardTitle).toBe(14);
  expect(typography.blockBody).toBeGreaterThanOrEqual(16);
  expect(typography.highlightedValue).toBeGreaterThanOrEqual(16);
  expect(typography.dataCardLabel).toBeGreaterThanOrEqual(16);
  expect(typography.dataCardValue).toBeGreaterThanOrEqual(17);
  expect(typography.kpiLabel).toBeGreaterThanOrEqual(14);
  expect(typography.kpiValue).toBeGreaterThanOrEqual(17);
  expect(typography.kpiLimit).toBeGreaterThanOrEqual(13);
  expect(typography.progressLabel).toBeGreaterThanOrEqual(14);
  expect(typography.progressValue).toBeGreaterThanOrEqual(17);
  expect(typography.progressUnit).toBeGreaterThanOrEqual(14);
  expect(typography.zoneLabel).toBeGreaterThanOrEqual(14);
  expect(typography.zoneValue).toBeGreaterThanOrEqual(17);
  expect(typography.zoneLimit).toBeGreaterThanOrEqual(13);
  expect(typography.zoneLimitRowHeight).toBeGreaterThanOrEqual(18);
  expect(typography.chartControl).toBeGreaterThanOrEqual(12);
  expect(typography.chartTableCell).toBeGreaterThanOrEqual(13);
  expect(typography.reportKpiValue).toBeGreaterThanOrEqual(32);
  expect(typography.reportKpiNote).toBeGreaterThanOrEqual(14);
  expect(typography.reportTableHeader).toBeGreaterThanOrEqual(14);
  expect(typography.reportTableValue).toBeGreaterThanOrEqual(16);
  expect(Math.min(...typography.svgFonts)).toBeGreaterThanOrEqual(13);
  expect(typography.chartLegend).toBeGreaterThanOrEqual(13);
  expect(typography.chartXTick).toBeGreaterThanOrEqual(13);
  expect(typography.chartYTick).toBeGreaterThanOrEqual(13);
  expect(typography.chartTopPadding).toBeGreaterThanOrEqual(20);
  expect(typography.chartPointLabel).toBeGreaterThanOrEqual(12);

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await settleLayout(page);
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      chartTableClientWidth: document.querySelector('.chart-table-area').clientWidth,
      chartTableScrollWidth: document.querySelector('.chart-table-area').scrollWidth
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(overflow.chartTableScrollWidth).toBeGreaterThanOrEqual(overflow.chartTableClientWidth);
  }

  await page.emulateMedia({ media: 'print' });
  const printTypography = await page.evaluate(() => {
    const root = document.querySelector('#tableBody .module-content-cell');
    const px = (selector) => parseFloat(getComputedStyle(root.querySelector(selector)).fontSize);
    return { blockTitle: px('.block-title'), blockBody: px('.block-body'), dataCardValue: px('.data-card-table tbody td:nth-child(2)') };
  });
  expect(printTypography.blockTitle).toBe(14);
  expect(printTypography.blockBody).toBeGreaterThanOrEqual(16);
  expect(printTypography.dataCardValue).toBeGreaterThanOrEqual(17);
  await page.emulateMedia({ media: 'screen' });
  expect(errors).toEqual([]);
});

test('長月報捲動時頁首與工具列保持可見，不會只剩固定漸層遮罩', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const geometry = await page.evaluate(async () => {
    const content = document.querySelector('.module-content-cell');
    content.style.minHeight = '5000px';
    refreshEditorStickyOffsets();
    window.scrollTo(0, 2200);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      scrollY: window.scrollY,
      tabs: box('#v1TabsBar'),
      toolbar: box('#richEditorToolbar'),
      shield: box('#v1StickyShield')
    };
  });

  expect(geometry.scrollY).toBeGreaterThan(2000);
  expect(geometry.tabs.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(geometry.tabs.bottom - 1);
  expect(geometry.toolbar.top).toBeLessThanOrEqual(geometry.tabs.bottom + 1);
  expect(geometry.toolbar.bottom).toBeGreaterThanOrEqual(geometry.shield.bottom - 12);
});

test('進站與登入後最左上角使用同一份 FPMC Logo 且不造成水平破版', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

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

  let geometry = await page.evaluate(async () => {
    document.querySelector('.module-content-cell').style.minHeight = '5000px';
    refreshEditorStickyOffsets();
    window.scrollTo(0, 2200);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return { scrollY: window.scrollY, tabs: box('#v1TabsBar'), toolbar: box('#richEditorToolbar'), shield: box('#v1StickyShield') };
  });
  expect(geometry.scrollY).toBeGreaterThan(2000);
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
  geometry = await page.evaluate(async () => {
    window.scrollTo(0, 2200);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return { scrollY: window.scrollY, tabs: box('#v1TabsBar'), toolbar: box('#richEditorToolbar'), shield: box('#v1StickyShield') };
  });
  expect(geometry.scrollY).toBeGreaterThan(2000);
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
  await pageA.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(async () => (await request.get('/__fake_state')).json().then((state) => state.modules[0].payload.title.replace(/<br>$/i, ''))).toBe('A 已由 Owner 保存');

  await titleB2.click();
  await titleB2.fill('B 已由 Operator 保存');
  await pageB.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(async () => (await request.get('/__fake_state')).json().then((state) => state.modules[1].payload.title.replace(/<br>$/i, ''))).toBe('B 已由 Operator 保存');

  const state = await (await request.get('/__fake_state')).json();
  expect(state.modules.map((module) => module.payload.title.replace(/<br>$/i, ''))).toEqual(['A 已由 Owner 保存', 'B 已由 Operator 保存']);
  expect(state.modules.map((module) => module.revision)).toEqual([2, 2]);
  expect(errors).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('格子停頓只保存本機草稿，週期上雲後仍保持編輯並顯示成功時間', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 2500;
  });
  await enterAndLogin(page, 'owner', 'owner-pass');

  const moduleId = '22222222-2222-4222-8222-222222222221';
  const row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('分鐘級背景保存內容');
  const expectedCaretOffset = '分鐘級背景保存內容'.length;
  const initialCaretOffset = await title.evaluate((element) => {
    element.focus({ preventScroll: true });
    const textNode = element.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return -1;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const activeRange = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!activeRange) return -1;
    const prefix = activeRange.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(activeRange.startContainer, activeRange.startOffset);
    return prefix.toString().length;
  });
  expect(initialCaretOffset).toBe(expectedCaretOffset);

  await expect.poll(() => page.evaluate((id) => {
    const raw = localStorage.getItem(`monthly_v7_draft:module:${id}`);
    if (!raw) return '';
    try { return String(JSON.parse(raw)?.payload?.title || '').replace(/<br>$/i, ''); }
    catch { return ''; }
  }, moduleId)).toBe('分鐘級背景保存內容');
  let state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(1);
  expect(state.modules[0].payload.title).toBe('A 原始項目');
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');

  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json())
    .then((current) => current.modules[0].payload.title.replace(/<br>$/i, '')), { timeout: 10000 })
    .toBe('分鐘級背景保存內容');
  await expect.poll(() => page.evaluate(() => !V7_CLOUD_SAVE_PROMISE
    && !V4_CLOUD_SAVING
    && !v7HasUnsyncedCloudChanges())).toBe(true);
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  const caret = await title.evaluate((element) => {
    const selection = window.getSelection();
    const activeRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    let offset = -1;
    if (activeRange) {
      const prefix = activeRange.cloneRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(activeRange.startContainer, activeRange.startOffset);
      offset = prefix.toString().length;
    }
    return {
      active: document.activeElement === element,
      offset,
      textLength: element.textContent.length
    };
  });
  expect(caret).toEqual({ active: true, offset: expectedCaretOffset, textLength: expectedCaretOffset });
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  await expect(page.locator('#v4-cloud-runtime-status')).not.toContainText('watermark');

  await page.keyboard.type('，仍可繼續輸入');
  await expect.poll(() => page.evaluate((id) => {
    const raw = localStorage.getItem(`monthly_v7_draft:module:${id}`);
    if (!raw) return '';
    try { return String(JSON.parse(raw)?.payload?.title || '').replace(/<br>$/i, ''); }
    catch { return ''; }
  }, moduleId)).toBe('分鐘級背景保存內容，仍可繼續輸入');
  state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].payload.title.replace(/<br>$/i, '')).toBe('分鐘級背景保存內容');
  await expect(title).toHaveText('分鐘級背景保存內容，仍可繼續輸入');
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
});

test('手動保存保留目前格子的焦點、caret 與 module lease', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const row = page.locator('#tableBody tr').first();
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('手動保存仍可繼續輸入');
  await title.evaluate((element) => {
    const text = element.firstChild;
    const range = document.createRange();
    range.setStart(text, 4);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.waitForTimeout(1100);

  await page.getByRole('button', { name: '保存修改' }).first().click();
  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json())
    .then((state) => state.modules[0].payload.title.replace(/<br>$/i, ''))).toBe('手動保存仍可繼續輸入');
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  const focusState = await title.evaluate((element) => {
    const selection = window.getSelection();
    return {
      active: document.activeElement === element,
      offset: selection && selection.rangeCount ? selection.getRangeAt(0).startOffset : -1
    };
  });
  expect(focusState).toEqual({ active: true, offset: 4 });
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);

  await title.evaluate((element) => {
    const text = element.firstChild;
    const range = document.createRange();
    range.setStart(text, 6);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator('button[onclick="manualSave()"]:visible').first().click();
  await expect.poll(() => title.evaluate((element) => document.activeElement === element)).toBe(true);
  expect(await title.evaluate(() => window.getSelection()?.getRangeAt(0)?.startOffset)).toBe(6);
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
});

test('背景保存期間的新輸入只合併成一個後繼保存，不平行堆疊 RPC', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  let releaseFirstSave;
  const firstSaveGate = new Promise((resolve) => { releaseFirstSave = resolve; });
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      saveCalls += 1;
      if (saveCalls === 1) await firstSaveGate;
    }
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');

  const row = page.locator('#tableBody tr').first();
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await title.fill('第一輪送出內容');
  await expect.poll(() => saveCalls, { timeout: 10000 }).toBe(1);

  await title.fill('保存等待期間的最新內容');
  await page.waitForTimeout(1600);
  expect(saveCalls).toBe(1);
  expect(await page.evaluate(() => v7HasUnsyncedCloudChanges())).toBe(true);
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');

  releaseFirstSave();
  await expect.poll(() => saveCalls).toBe(2);
  await expect.poll(() => page.evaluate(() => !v7HasUnsyncedCloudChanges()
    && !V4_CLOUD_SAVING
    && !V4_AUTO_SAVE_TIMER
    && !V7_CLOUD_SAVE_PROMISE)).toBe(true);
  const coordinatorState = await page.evaluate(() => ({
    dirty: v7HasUnsyncedCloudChanges(),
    saving: V4_CLOUD_SAVING,
    hasTimer: Boolean(V4_AUTO_SAVE_TIMER),
    hasPromise: Boolean(V7_CLOUD_SAVE_PROMISE),
    dirtyGeneration: V7_CLOUD_DIRTY_GENERATION,
    savedGeneration: V7_CLOUD_SAVED_GENERATION,
    status: document.getElementById('v4-cloud-runtime-status')?.textContent || ''
  }));
  expect({
    saveCalls,
    dirty: coordinatorState.dirty,
    saving: coordinatorState.saving,
    hasTimer: coordinatorState.hasTimer,
    hasPromise: coordinatorState.hasPromise,
    status: coordinatorState.status
  }).toEqual({
    saveCalls: 2,
    dirty: false,
    saving: false,
    hasTimer: false,
    hasPromise: false,
    status: expect.stringMatching(/雲端已保存｜\d{2}:\d{2}:\d{2}/)
  });
  expect(coordinatorState.dirtyGeneration).toBeGreaterThanOrEqual(2);
  expect(coordinatorState.savedGeneration).toBe(coordinatorState.dirtyGeneration);
  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json())
    .then((state) => state.modules[0].payload.title.replace(/<br>$/i, '')), { timeout: 15000 })
    .toBe('保存等待期間的最新內容');
  expect(saveCalls).toBe(2);
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
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
  let interceptedSaveCount = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      interceptedSaveCount += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEST_SAVE_UNAVAILABLE', message: 'deterministic unsaved draft' })
      });
      return;
    }
    await route.continue();
  });

  const row = page.locator('#tableBody tr').first();
  const title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await title.evaluate((element) => element.removeAttribute('onblur'));
  await title.fill('尚未提交的本機內容');
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(() => interceptedSaveCount).toBeGreaterThan(0);

  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveText('尚未提交的本機內容');
  const state = await page.request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(1);
  expect(state.modules[0].payload.title).toBe('A 原始項目');
  expect(errors).toEqual([]);
});

test('revision conflict 保留本機草稿，重載後由使用者確認才以目前內容重試', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 1500;
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');
  await request.post('/__fake_remote_module_change');

  const moduleId = '22222222-2222-4222-8222-222222222221';
  let row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  let title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await title.fill('本機待救回內容');
  await page.locator('#mainTitle').click();

  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('REVISION_CONFLICT');
  let state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(2);
  expect(state.modules[0].payload.title).toBe('遠端較新內容');
  const savedDraft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`monthly_v7_draft:module:${id}`) || 'null'), moduleId);
  expect(savedDraft.payload.title.replace(/<br>$/i, '')).toBe('本機待救回內容');

  await page.reload();
  row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  title = row.locator('td').nth(1).locator('.editable-div');
  await expect(title).toHaveText('本機待救回內容');
  await expect.poll(() => page.evaluate((id) => {
    const app = window.MonthlyV7App;
    const snapshotIds = (app?.client?.snapshot?.modules || []).map((entry) => String(entry?.id || ''));
    const modelIds = Array.isArray(reportData)
      ? reportData.map((entry) => String(entry?._v7Id || ''))
      : [];
    return app?.initialized === true
      && snapshotIds.includes(String(id))
      && JSON.stringify(modelIds) === JSON.stringify(snapshotIds);
  }, moduleId), {
    timeout: 30000,
    message: 'reload should finish applying the authoritative snapshot before protected-baseline assertions'
  }).toBe(true);
  const protectedBaseline = await page.evaluate((id) => {
    const snapshotRow = window.MonthlyV7App.client.snapshot.modules.find((row) => row.id === id);
    const baselineRow = window.MonthlyV7App.baselineModuleMap().get(id);
    const live = reportData.find((item) => item._v7Id === id);
    return {
      hasDraft: window.MonthlyV7App.hasModuleDraft(id),
      liveTitle: window.MonthlyV7App.client.modulePayload(live).title,
      protectedServerTitle: snapshotRow?._serverPayload?.title || null,
      baselineTitle: baselineRow?.payload?.title || null,
      baselineRevision: baselineRow?.revision ?? null
    };
  }, moduleId);
  expect(protectedBaseline).toEqual({
    hasDraft: true,
    liveTitle: '本機待救回內容',
    protectedServerTitle: '遠端較新內容',
    baselineTitle: '遠端較新內容',
    baselineRevision: 2
  });
  const redundantDraftComparison = await page.evaluate(() => {
    const item = reportData[1];
    const baseline = window.MonthlyV7App.baselineModuleMap().get(item._v7Id);
    const draft = window.MonthlyV7App.client.readDraft('module', item._v7Id);
    return {
      live: window.MonthlyV7App.client.modulePayload(item),
      draft: draft?.payload || null,
      baseline: baseline?.payload || null
    };
  });
  expect(redundantDraftComparison.live).toEqual(redundantDraftComparison.baseline);
  expect(redundantDraftComparison.draft).toBeNull();
  await expect.poll(() => page.locator('#v4-cloud-runtime-status').textContent()).toMatch(/已恢復 1 個未提交本機草稿|項目保存衝突：REVISION_CONFLICT/);

  let cancellationPrompt = '';
  page.once('dialog', async (dialog) => {
    cancellationPrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('已取消覆蓋');
  state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(2);
  expect(state.modules[0].payload.title).toBe('遠端較新內容');
  expect(await page.evaluate((id) => localStorage.getItem(`monthly_v7_draft:module:${id}`), moduleId)).not.toBeNull();

  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json()).then((next) => next.modules[0].revision)).toBe(3);
  state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].payload.title.replace(/<br>$/i, '')).toBe('本機待救回內容');
  expect(cancellationPrompt).toContain('目前畫面內容');
  expect(cancellationPrompt).toContain('取消');
  expect(confirmation).toBe(cancellationPrompt);
  expect(await page.evaluate((id) => localStorage.getItem(`monthly_v7_draft:module:${id}`), moduleId)).toBeNull();
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
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
  await page.evaluate(() => {
    window.__fullSnapshotCatchUpState = { status: 'pending', error: '' };
    window.__fullSnapshotCatchUpPromise = window.MonthlyV7App.client.catchUp()
      .then(() => { window.__fullSnapshotCatchUpState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__fullSnapshotCatchUpState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__fullSnapshotCatchUpState?.status)).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__fullSnapshotCatchUpState)).toEqual({ status: 'done', error: '' });
  await expect(page.locator('#tableBody tr')).toHaveCount(3);
  await expect(page.locator('#tableBody tr').first().locator('td').nth(1).locator('.editable-div')).toHaveText('尚未 blur 的本機文字');
  await expect(page.locator('#tableBody')).toContainText('遠端新增模塊');
  expect(errors).toEqual([]);
});

test('report metadata 未確認前不得提前顯示整份雲端成功，失敗後維持 dirty 重試', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(async () => {
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    document.getElementById('mainTitle').textContent = 'metadata 尚未確認的月報標題';
    await manualSave(false, { deferCloud: true });
    const status = document.getElementById('v4-cloud-runtime-status');
    window.__metaSaveStatusHistory = [String(status?.textContent || '')];
    window.__metaSaveStatusObserver = new MutationObserver(() => {
      window.__metaSaveStatusHistory.push(String(status?.textContent || ''));
    });
    window.__metaSaveStatusObserver.observe(status, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class']
    });
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_report_meta&count=always');

  const saved = await page.evaluate(() => v5SaveChangesToCloud());

  expect(saved).toBe(false);
  const result = await page.evaluate(() => {
    window.__metaSaveStatusObserver?.disconnect();
    const reportId = window.MonthlyV7App.client.currentReport().id;
    return {
      history: window.__metaSaveStatusHistory,
      finalStatus: document.getElementById('v4-cloud-runtime-status')?.textContent || '',
      dirty: v7HasUnsyncedCloudChanges(),
      actorPending: window.MonthlyV7App.client.hasCurrentActorPendingOperation(`save_report_meta:${reportId}`),
      draft: localStorage.getItem(`monthly_v7_draft:report_meta:${reportId}`),
      pending: localStorage.getItem(`monthly_v7_pending:save_report_meta:${reportId}`)
    };
  });
  expect(result.history.some((value) => /(?:雲端已保存|月報資訊已保存)｜\d{2}:\d{2}:\d{2}/.test(value))).toBe(false);
  expect(result.finalStatus).toContain('RPC_TIMEOUT');
  expect(result.dirty).toBe(true);
  expect(result.actorPending).toBe(true);
  expect(result.draft).toContain('metadata 尚未確認的月報標題');
  expect(result.pending).toBeTruthy();
  expect(dialogs.some((message) => message.includes('RPC_TIMEOUT'))).toBe(true);
});

test('保存 RPC 無回應會結束為失敗並保留草稿，重試後可由新瀏覽器讀回雲端內容', async ({ page, request, browser }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => { window.MonthlyV7App.transport.requestTimeoutMs = 35; });
  const before = await (await request.get('/__fake_state')).json();
  await page.evaluate(() => {
    reportData[0].title = '逾時後仍待保存的內容';
    renderTable();
    v1EnsureModuleFields();
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=always');

  await page.evaluate(() => v5SaveChangesToCloud());
  await expect.poll(() => page.locator('#v5TopStatus').innerText()).toContain('RPC_TIMEOUT');
  await expect(page.locator('#v4-cloud-runtime-status')).not.toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  expect(dialogs.some((message) => message.includes('RPC_TIMEOUT'))).toBe(true);
  const afterTimeout = await (await request.get('/__fake_state')).json();
  expect(afterTimeout.modules[0].payload.title).toBe(before.modules[0].payload.title);
  const localResidue = await page.evaluate(() => ({
    draft: localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221')
  }));
  expect(localResidue.draft).toContain('逾時後仍待保存的內容');
  expect(localResidue.pending).toBeTruthy();

  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=0');
  await request.post('/__fake_drop_first_module_lease');
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.MonthlyV7App?.client?.userSession?.id
    && window.MonthlyV7App.client.currentReport()?.id
  ))).toBe(true);
  await expect(page.locator('#tableBody')).toContainText('逾時後仍待保存的內容');
  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json())
    .then((state) => state.modules[0].payload.title), { timeout: 15000 })
    .toBe('逾時後仍待保存的內容');
  await expect(page.locator('#v5TopStatus')).toContainText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  const afterRetry = await (await request.get('/__fake_state')).json();
  expect(afterRetry.modules[0].payload.title).toBe('逾時後仍待保存的內容');
  const cleared = await page.evaluate(() => ({
    draft: localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221'),
    moduleDraftKeys: Object.keys(localStorage).filter((key) => key.startsWith('monthly_v7_draft:module:'))
  }));
  expect(cleared).toEqual({ draft: null, pending: null, moduleDraftKeys: [] });

  const independentContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4187' });
  const independentPage = await independentContext.newPage();
  await enterAndLogin(independentPage, 'owner', 'owner-pass');
  await expect(independentPage.locator('#tableBody')).toContainText('逾時後仍待保存的內容');
  await independentContext.close();
});

test('保存已提交但回覆遺失時，刷新後重播舊 operation 不重複增加 revision', async ({ page, request, browser }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    reportData[0].title = '已提交但回覆遺失的內容';
    renderTable();
    v1EnsureModuleFields();
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=always&mode=after_commit');

  await page.evaluate(() => v5SaveChangesToCloud());
  await expect.poll(() => page.locator('#v5TopStatus').innerText()).toContain('RPC_TIMEOUT');
  expect(dialogs.some((message) => message.includes('RPC_TIMEOUT'))).toBe(true);
  const committed = await (await request.get('/__fake_state')).json();
  expect(committed.modules[0].revision).toBe(2);
  expect(committed.modules[0].payload.title).toBe('已提交但回覆遺失的內容');
  expect(committed.operations.filter((operation) => operation.result?.entityId === committed.modules[0].id)).toHaveLength(1);
  const pendingBeforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem(
    'monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221'
  )));
  expect(pendingBeforeReload.actorUserId).toBe('33333333-3333-4333-8333-333333333331');
  const draftBeforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem(
    'monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'
  )));
  expect(draftBeforeReload.payload).toEqual(JSON.parse(pendingBeforeReload.signature).p_payload);
  expect(draftBeforeReload.supersedesOperation).toBeUndefined();
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=0&mode=after_commit');

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.MonthlyV7App?.client?.userSession?.id
    && window.MonthlyV7App.client.currentReport()?.id
  ))).toBe(true);
  await expect(page.locator('#tableBody')).toContainText('已提交但回覆遺失的內容');
  const beforeManualRetry = await (await request.get('/__fake_state')).json();
  expect(beforeManualRetry.modules[0].revision).toBe(2);
  expect(beforeManualRetry.operations.filter(
    (operation) => operation.result?.entityId === beforeManualRetry.modules[0].id
  )).toHaveLength(1);
  const clientRecoveryState = await page.evaluate(() => ({
    itemRevision: reportData[0]._v7Revision,
    snapshotRevision: window.MonthlyV7App.client.snapshot.modules[0].revision,
    pending: JSON.parse(localStorage.getItem(
      'monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221'
    )),
    draft: JSON.parse(localStorage.getItem(
      'monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'
    ))
  }));
  expect(clientRecoveryState.itemRevision).toBe(1);
  expect(clientRecoveryState.snapshotRevision).toBe(1);
  expect(clientRecoveryState.draft.supersedesOperation).toBeUndefined();
  await page.evaluate(() => v5SaveChangesToCloud());

  const reconciled = await (await request.get('/__fake_state')).json();
  const reconciledModuleOperations = reconciled.operations.filter(
    (operation) => operation.result?.entityId === reconciled.modules[0].id
  );
  expect(reconciledModuleOperations).toHaveLength(1);
  expect(reconciled.modules[0].revision).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem(
    'monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221'
  ))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem(
    'monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'
  ))).toBeNull();

  const independentContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4187' });
  const independentPage = await independentContext.newPage();
  await enterAndLogin(independentPage, 'owner', 'owner-pass');
  await expect(independentPage.locator('#tableBody')).toContainText('已提交但回覆遺失的內容');
  await independentContext.close();
});

test('PDF 保存等待期間又輸入的新內容會在建立快照前再次上雲端', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const app = window.MonthlyV7App;
    const originalFlush = app.flush.bind(app);
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    window.__pdfRaceRelease = releaseGate;
    window.__pdfRaceWaiting = false;
    window.__pdfRaceResult = { status: 'pending', error: '' };
    let first = true;
    app.flush = async (meta) => {
      if (first) {
        first = false;
        window.__pdfRaceWaiting = true;
        await gate;
      }
      return originalFlush(meta);
    };
    reportData[0].title = 'PDF 先送出的內容 A';
    renderTable();
    window.__pdfRacePromise = v7ConfirmCloudBeforeFormalSnapshot()
      .then((floor) => { window.__pdfRaceResult = { status: 'done', error: '', floor }; })
      .catch((error) => { window.__pdfRaceResult = { status: 'error', error: String(error?.message || error) }; });
  });
  await expect.poll(() => page.evaluate(() => window.__pdfRaceWaiting)).toBe(true);

  await page.evaluate(() => {
    reportData[0].title = 'PDF 等待期間的新內容 B';
    renderTable();
    window.__pdfRaceRelease();
  });
  await expect.poll(() => page.evaluate(() => window.__pdfRaceResult.status), { timeout: 30000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__pdfRaceResult.status)).toBe('done');

  const state = await (await request.get('/__fake_state')).json();
  expect(state.modules[0].payload.title).toBe('PDF 等待期間的新內容 B');
});

test('cloudSaved false 時不得建立 PDF snapshot 或列印', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.__cloudFalsePrintCalls = 0;
    window.__cloudFalseSnapshotCalls = 0;
    window.print = () => { window.__cloudFalsePrintCalls += 1; };
    const app = window.MonthlyV7App;
    const originalSnapshot = app.createReportSnapshot.bind(app);
    app.createReportSnapshot = async (kind) => {
      window.__cloudFalseSnapshotCalls += 1;
      return originalSnapshot(kind);
    };
    app.persistReportData = async () => ({ mode: 'v7', localOnly: true });
  });

  await page.evaluate(() => printCurrentEditorReport());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => ({
    prints: window.__cloudFalsePrintCalls,
    snapshots: window.__cloudFalseSnapshotCalls,
    locked: document.body.dataset.v7FormalPrintLock || '',
    overlay: Boolean(document.getElementById('v7FormalPrintLockOverlay'))
  }))).toEqual({ prints: 0, snapshots: 0, locked: '', overlay: false });
  expect(dialogs.some((message) => message.includes('CLOUD_SAVE_NOT_CONFIRMED'))).toBe(true);
});

test('保存後 snapshot 前遠端內容變更時不得列印不同 intent', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.__remoteDriftPrintCalls = 0;
    window.print = () => { window.__remoteDriftPrintCalls += 1; };
    const app = window.MonthlyV7App;
    const originalSnapshot = app.createReportSnapshot.bind(app);
    let changed = false;
    app.createReportSnapshot = async (kind) => {
      if (!changed) {
        changed = true;
        await fetch('/__fake_remote_module_change', { method: 'POST' });
      }
      return originalSnapshot(kind);
    };
  });

  await page.evaluate(() => printCurrentEditorReport());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__remoteDriftPrintCalls)).toBe(0);
  expect(dialogs.some((message) => message.includes('STALE_SNAPSHOT_AFTER_SAVE'))).toBe(true);
});

test('PDF snapshot 建立後內容再變更時不得列印舊 snapshot', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.__pdfLatePrintCalls = 0;
    window.print = () => { window.__pdfLatePrintCalls += 1; };
    const app = window.MonthlyV7App;
    const originalSnapshot = app.createReportSnapshot.bind(app);
    app.createReportSnapshot = async (kind) => {
      const formal = await originalSnapshot(kind);
      reportData[0].title = 'snapshot 後的新內容';
      renderTable();
      return formal;
    };
  });

  await page.evaluate(() => printCurrentEditorReport());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__pdfLatePrintCalls)).toBe(0);
  expect(dialogs.some((message) => message.includes('PDF_CONTENT_CHANGED_AFTER_SAVE'))).toBe(true);
});

test('正式 PDF 先同步焦點中內容，snapshot 等待期間鎖住本機輸入並於列印後解鎖', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const editor = page.locator('#tableBody .module-title-editor').first();
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('尚未失焦但必須列印的新標題');
  await page.evaluate(() => {
    const activeEditor = document.activeElement;
    if (!activeEditor?.classList?.contains('module-title-editor')) {
      throw new Error('MODULE_TITLE_EDITOR_NOT_FOCUSED');
    }
    window.__formalLockTargetIndex = Number(activeEditor.closest('tr[data-index]')?.dataset.index);

    window.__formalLockWaiting = false;
    window.__formalLockPrintCalls = 0;
    window.__formalLockResult = { status: 'pending', error: '' };
    window.print = () => { window.__formalLockPrintCalls += 1; };
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    window.__formalLockRelease = releaseGate;
    const app = window.MonthlyV7App;
    const originalFlush = app.flush.bind(app);
    let first = true;
    app.flush = async (meta) => {
      if (first) {
        first = false;
        window.__formalLockWaiting = true;
        await gate;
      }
      return originalFlush(meta);
    };
    window.__formalLockPromise = printCurrentEditorReport()
      .then(() => { window.__formalLockResult = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__formalLockResult = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__formalLockWaiting)).toBe(true);

  expect(await page.evaluate(() => reportData[window.__formalLockTargetIndex].title))
    .toBe('尚未失焦但必須列印的新標題');
  expect(await page.evaluate(() => document.body.dataset.v7FormalPrintLock)).toBe('true');

  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('#v7FormalPrintLockOverlay')).toBeAttached();
  expect(await editor.innerText()).toBe('尚未失焦但必須列印的新標題');

  await page.evaluate(() => window.__formalLockRelease());
  await expect.poll(() => page.evaluate(() => window.__formalLockPrintCalls), { timeout: 30000 }).toBe(1);
  expect(await page.evaluate(() => document.body.dataset.v7FormalPrintLock || '')).toBe('');
  expect(await page.evaluate(() => window.__formalLockResult)).toEqual({ status: 'done', error: '' });
  expect(dialogs).toEqual([]);
});

test('PDF 前置保存未獲雲端確認時不得建立正式快照或列印舊內容', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    window.__v7PrintCalls = 0;
    window.print = () => { window.__v7PrintCalls += 1; };
    reportData[0].title = '尚未獲雲端確認的 PDF 內容';
    renderTable();
    v1EnsureModuleFields();
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=always');

  await page.evaluate(() => {
    window.__v7PdfAttemptState = { status: 'pending', error: '' };
    window.__v7PdfAttemptPromise = printV1SelectedPdf()
      .then(() => { window.__v7PdfAttemptState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__v7PdfAttemptState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__v7PdfAttemptState.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__v7PdfAttemptState)).toEqual({ status: 'done', error: '' });
  await expect.poll(async () => (await page.evaluate(() => window.__v7PrintCalls > 0)) || dialogs.length > 0).toBe(true);

  expect(await page.evaluate(() => window.__v7PrintCalls)).toBe(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-print-source', 'snapshot');
  const timeoutDialog = dialogs.find((message) => message.includes('RPC_TIMEOUT')) || '';
  expect(timeoutDialog).toContain('階段：保存資料（save_data）');
  expect(timeoutDialog).toContain('RPC：monthly_v7_save_module');
  expect(timeoutDialog).toMatch(/等待：\d+ ms/);
  expect(timeoutDialog).toContain('本機草稿已保留，尚未列印');
  await expect(page.locator('#v5TopStatus')).toContainText('保存資料（save_data）');
  await expect(page.locator('body')).not.toHaveAttribute('data-v7-formal-print-lock');
  await expect(page.locator('#v7FormalPrintLockOverlay')).toHaveCount(0);
  const server = await (await request.get('/__fake_state')).json();
  expect(server.modules[0].payload.title).toBe('A 原始項目');
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'))).toContain('尚未獲雲端確認的 PDF 內容');

  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=0');
  dialogs.length = 0;
  await page.evaluate(() => {
    window.__v7PdfAttemptState = { status: 'pending', error: '' };
    window.__v7PdfAttemptPromise = printV1SelectedPdf()
      .then(() => { window.__v7PdfAttemptState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__v7PdfAttemptState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__v7PdfAttemptState.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__v7PdfAttemptState)).toEqual({ status: 'done', error: '' });
  await expect.poll(() => page.evaluate(() => window.__v7PrintCalls), { timeout: 30000 }).toBe(1);
  expect(dialogs).toEqual([]);
  const recovered = await (await request.get('/__fake_state')).json();
  expect(recovered.modules[0].payload.title).toBe('尚未獲雲端確認的 PDF 內容');
  expect(recovered.snapshots).toHaveLength(1);
  expect(recovered.snapshots[0].modules[0].payload.title).toBe('尚未獲雲端確認的 PDF 內容');
  expect(await page.evaluate(() => ({
    draft: localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221')
  }))).toEqual({ draft: null, pending: null });
});

test('正式 PDF snapshot RPC timeout 標示 create_snapshot 階段與確切 RPC', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_create_report_snapshot&count=always');

  await page.evaluate(() => printV1SelectedPdf());
  await expect.poll(() => dialogs.length, { timeout: 15000 }).toBeGreaterThan(0);

  const message = dialogs.find((value) => value.includes('RPC_TIMEOUT')) || '';
  expect(message).toContain('階段：建立不可變快照（create_snapshot）');
  expect(message).toContain('RPC：monthly_v7_create_report_snapshot');
  expect(message).toMatch(/等待：\d+ ms/);
  expect(await page.evaluate(() => window.__v7PrintCalled)).toBe(false);
  await expect(page.locator('#v7FormalPrintLockOverlay')).toHaveCount(0);
  const snapshotPendingKey = 'monthly_v7_pending:create_snapshot:11111111-1111-4111-8111-111111111111:pdf';
  expect(await page.evaluate((key) => localStorage.getItem(key), snapshotPendingKey)).not.toBeNull();

  await page.evaluate(() => v5SaveChangesToCloud());

  await expect(page.locator('#v4-cloud-runtime-status')).not.toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('正式 PDF 快照結果尚未確認');
  expect(await page.evaluate((key) => localStorage.getItem(key), snapshotPendingKey)).not.toBeNull();
});

test('正式 PDF 的 PostgREST SQLSTATE 28000 session invalid 顯示重新登入而非裸碼', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const transport = window.MonthlyV7App.transport;
    const originalRpc = transport.rpc.bind(transport);
    transport.rpc = async (name, params) => {
      if (name === 'monthly_v7_create_report_snapshot') {
        const error = new Error('READ_SESSION_INVALID');
        error.code = '28000';
        error.details = 'provider detail';
        throw error;
      }
      return originalRpc(name, params);
    };
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
  });

  await page.evaluate(() => {
    window.__sqlstatePdfState = { status: 'pending', error: '' };
    window.__sqlstatePdfPromise = printV1SelectedPdf()
      .then(() => {
        window.__sqlstatePdfState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__sqlstatePdfState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__sqlstatePdfState?.status), { timeout: 15000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__sqlstatePdfState)).toEqual({ status: 'done', error: '' });
  await expect.poll(() => dialogs.length, { timeout: 15000 }).toBeGreaterThan(0);

  const message = dialogs.at(-1) || '';
  expect(message).toContain('登入已失效');
  expect(message).toContain('本機草稿已保留');
  expect(message).toContain('請重新登入');
  expect(message).not.toContain('失敗：28000；');
  expect(await page.evaluate(() => window.__v7PrintCalled)).toBe(false);
  expect(await page.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  expect(await page.evaluate(() => Boolean(window.MonthlyV7App.client.siteSession?.id))).toBe(true);
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('body')).not.toHaveAttribute('data-v7-formal-print-lock');
  await expect(page.locator('#v7FormalPrintLockOverlay')).toHaveCount(0);
});

test('V7 session 失效後 PDF 不得降級走 legacy 本機列印', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
  });
  await request.post('/__fake_invalidate_user_sessions');
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.currentUser()), { timeout: 15000 }).toBeNull();

  await page.evaluate(() => printV1SelectedPdf());
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(await page.evaluate(() => window.__v7PrintCalled)).toBe(false);
  expect(dialogs.some((message) => message.includes('登入已失效') && message.includes('本機草稿已保留'))).toBe(true);
  await expect(page.locator('body')).not.toHaveClass(/pdf-print-mode/);
  await expect(page.locator('#v7FormalPrintLockOverlay')).toHaveCount(0);
});

test('重新登入後舊 PDF pending operation 可安全接續且不再出現 PENDING_OPERATION_UNRESOLVED', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const pendingKey = 'monthly_v7_pending:create_snapshot:11111111-1111-4111-8111-111111111111:pdf';
  await page.evaluate((key) => {
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
    localStorage.setItem(key, JSON.stringify({
      operationId: '00000000-0000-4000-8000-000000000889',
      signature: JSON.stringify({
        p_workspace_key: 'browser-workspace',
        p_site_session_id: 'expired-site-session',
        p_user_session_id: 'expired-user-session',
        p_report_id: '11111111-1111-4111-8111-111111111111',
        p_kind: 'pdf'
      }),
      createdAt: '2026-08-11T00:00:00.000Z'
    }));
    printV1SelectedPdf();
  }, pendingKey);

  await expect.poll(async () => (await page.evaluate(() => window.__v7PrintCalled)) || dialogs.length > 0).toBe(true);
  expect(await page.evaluate(() => window.__v7PrintCalled)).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-print-source', 'snapshot');
  expect(dialogs.some((message) => message.includes('PENDING_OPERATION_UNRESOLVED'))).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
});

test('PDF 舊 snapshot 已提交但回覆遺失時，不得回放舊內容覆蓋剛保存的 module revision', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => { window.MonthlyV7App.transport.requestTimeoutMs = 35; });
  await request.post('/__fake_hang_rpc?name=monthly_v7_create_report_snapshot&count=2&mode=after_commit');

  const lostAck = await page.evaluate(async () => {
    try {
      await window.MonthlyV7App.createReportSnapshot('pdf');
      return { rejected: false, code: '' };
    } catch (error) {
      return {
        rejected: true,
        code: error.code || error.message,
        pending: localStorage.getItem('monthly_v7_pending:create_snapshot:11111111-1111-4111-8111-111111111111:pdf')
      };
    }
  });
  expect(lostAck.rejected).toBe(true);
  expect(lostAck.code).toBe('RPC_TIMEOUT');
  expect(JSON.parse(lostAck.pending).actorUserId).toBe('33333333-3333-4333-8333-333333333331');
  const beforeEdit = await (await request.get('/__fake_state')).json();
  expect(beforeEdit.snapshots).toHaveLength(1);
  expect(beforeEdit.snapshots[0].modules[0].revision).toBe(1);

  await page.evaluate(() => {
    window.MonthlyV7App.transport.requestTimeoutMs = 1000;
    reportData[0].title = 'PDF 必須使用剛保存的新內容';
    renderTable();
    v1EnsureModuleFields();
  });
  await page.evaluate(() => v5SaveChangesToCloud());
  const afterSave = await (await request.get('/__fake_state')).json();
  expect(afterSave.modules[0].revision).toBe(2);
  expect(afterSave.modules[0].payload.title).toBe('PDF 必須使用剛保存的新內容');

  await page.evaluate(() => {
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
    printV1SelectedPdf();
  });
  await expect.poll(async () => (await page.evaluate(() => window.__v7PrintCalled)) || dialogs.length > 0).toBe(true);

  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => window.__v7PrintCalled)).toBe(true);
  await expect(page.locator('#pdfPrintArea')).toContainText('PDF 必須使用剛保存的新內容');
  const afterPrint = await (await request.get('/__fake_state')).json();
  expect(afterPrint.snapshots).toHaveLength(2);
  expect(afterPrint.snapshots[1].modules[0].revision).toBe(2);
  expect(afterPrint.snapshots[1].modules[0].payload.title).toBe('PDF 必須使用剛保存的新內容');
  await expect(page.locator('body')).toHaveAttribute('data-v7-snapshot-id', afterPrint.snapshots[1].snapshotId);
});

test('V7 PDF 列印區直接使用 immutable snapshot，而非 live editor', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');
  await expect(page.locator('#tableBody')).toContainText('A 原始項目');
  await page.evaluate(() => {
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
    window.__immutableSnapshotState = { status: 'pending', error: '' };
    window.__immutableSnapshotPromise = window.MonthlyV7App.createReportSnapshot('pdf')
      .then(async (formal) => {
        reportData[0].title = '只存在 live editor 的未保存標題';
        renderTable();
        const ok = await prepareV7FormalSnapshotPrintArea(formal, { selectAll: false });
        if (!ok) throw new Error('PRINT_AREA_NOT_READY');
        document.body.classList.add('pdf-print-mode');
        window.print();
        window.__immutableSnapshotState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__immutableSnapshotState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__immutableSnapshotState?.status)).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__immutableSnapshotState)).toEqual({ status: 'done', error: '' });
  await expect(page.locator('body')).toHaveAttribute('data-print-source', 'snapshot');
  await expect(page.locator('#pdfPrintArea')).toContainText('A 原始項目');
  await expect(page.locator('#pdfPrintArea')).not.toContainText('只存在 live editor 的未保存標題');
  await expect.poll(() => page.evaluate(() => window.__v7PrintCalled)).toBe(true);
  const layout = await page.locator('#pdfPrintArea .module-card-row').first().evaluate((row) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    return {
      display: getComputedStyle(row).display,
      row: box(row),
      index: box(row.querySelector('.module-index-cell')),
      title: box(row.querySelector('.module-title-cell')),
      content: box(row.querySelector('.module-content-cell')),
      actions: row.querySelectorAll('.module-actions-cell').length
    };
  });
  expect(layout.display).toBe('grid');
  expect(layout.actions).toBe(0);
  expect(layout.content.top).toBeGreaterThanOrEqual(Math.max(layout.index.bottom, layout.title.bottom) - 1);
  expect(Math.abs(layout.content.left - layout.row.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.content.width - layout.row.width)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('PDF print media 保留部件與圖表色彩且小型圖表不跨頁切斷', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installPdfColorFixture(page);
  await page.evaluate(() => {
    window.__pdfColorPrepareState = { status: 'pending', message: '' };
    window.__pdfColorPreparePromise = Promise.resolve()
      .then(() => prepareV1PdfPrintArea())
      .then(() => {
        document.body.classList.add('pdf-print-mode');
        window.__pdfColorPrepareState = { status: 'done', message: '' };
      })
      .catch((error) => {
        window.__pdfColorPrepareState = { status: 'error', message: String(error?.message || error || '') };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__pdfColorPrepareState?.status || 'missing'), { timeout: 15000 })
    .not.toBe('pending');
  expect(await page.evaluate(() => window.__pdfColorPrepareState)).toEqual({ status: 'done', message: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.renderAllCharts();
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('#pdfPrintArea canvas.trend-canvas');
    return Boolean(canvas && canvas.width > 10 && canvas.height > 10 && Chart.getChart(canvas));
  })).toBe(true);

  const printState = await page.evaluate(() => {
    const root = document.querySelector('#pdfPrintArea');
    const row = root.querySelector('.module-card-row');
    const content = row.querySelector('.module-content-cell');
    const bar = root.querySelector('.kpi-bar-container');
    const zone = root.querySelector('.zone-bar');
    const dataCardTitle = root.querySelector('.data-card-table th');
    const svgStrokes = Array.from(root.querySelectorAll('svg[aria-label="KPI 趨勢圖"] polyline')).map((line) => getComputedStyle(line).stroke);
    const canvas = root.querySelector('canvas.trend-canvas');
    const chart = Chart.getChart(canvas);
    const atomicBreaks = ['.data-card-table', '.kpi-card-container', '.zone-card-container', '.trend-chart-container']
      .map((selector) => getComputedStyle(root.querySelector(selector)).breakInside);
    return {
      rowDisplay: getComputedStyle(row).display,
      contentGridColumn: getComputedStyle(content).gridColumn,
      reportHeaderDisplay: getComputedStyle(root.querySelector('table[data-cloned-id="reportTable"] > thead')).display,
      printColorAdjust: getComputedStyle(bar).webkitPrintColorAdjust || getComputedStyle(bar).printColorAdjust,
      kpiGradient: getComputedStyle(bar).backgroundImage,
      zoneGradient: getComputedStyle(zone).backgroundImage,
      dataCardTitleColor: getComputedStyle(dataCardTitle).color,
      dataCardBorderColor: getComputedStyle(dataCardTitle).borderBottomColor,
      svgStrokes,
      canvasDatasetColors: chart.data.datasets.map((dataset) => dataset.borderColor),
      atomicBreaks
    };
  });
  expect(printState.rowDisplay).toBe('grid');
  expect(printState.contentGridColumn).toBe('1 / -1');
  expect(printState.reportHeaderDisplay).toBe('none');
  expect(printState.printColorAdjust).toBe('exact');
  expect(printState.kpiGradient).toContain('rgb(34, 197, 94)');
  expect(printState.kpiGradient).toContain('rgb(234, 179, 8)');
  expect(printState.kpiGradient).toContain('rgb(239, 68, 68)');
  expect(printState.zoneGradient).toContain('rgb(34, 197, 94)');
  expect(printState.zoneGradient).toContain('rgb(239, 68, 68)');
  expect(printState.dataCardTitleColor).toBe('rgb(249, 115, 22)');
  expect(printState.dataCardBorderColor).toBe('rgb(249, 115, 22)');
  expect(printState.svgStrokes).toEqual([
    'rgb(37, 99, 235)', 'rgb(249, 115, 22)', 'rgb(220, 38, 38)', 'rgb(22, 163, 74)'
  ]);
  expect(printState.canvasDatasetColors).toEqual(['#4f46e5', '#10b981']);
  expect(printState.atomicBreaks).toEqual(['avoid', 'avoid', 'avoid', 'avoid']);
  expect(errors).toEqual([]);
});

test('PDF 半欄趨勢圖完整顯示五欄表格且 canvas 不被拉伸', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installTrendPdfGeometryFixture(page);
  await page.evaluate(() => {
    window.__trendGeometryPrepareState = { status: 'pending', error: '' };
    window.__trendGeometryPreparePromise = prepareV1PdfPrintArea()
      .then((ok) => {
        if (!ok) throw new Error('PRINT_AREA_NOT_READY');
        document.body.classList.add('pdf-print-mode');
        window.__trendGeometryPrepareState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__trendGeometryPrepareState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__trendGeometryPrepareState?.status), { timeout: 30000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__trendGeometryPrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.renderAllCharts();
  });
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('#pdfPrintArea canvas.trend-canvas'))
    .every((canvas) => canvas.width > 10 && canvas.height > 10 && Boolean(Chart.getChart(canvas))))).toBe(true);

  const charts = await page.evaluate(() => Array.from(document.querySelectorAll('#pdfPrintArea .trend-chart-container')).map((container) => {
    const tableArea = container.querySelector('.chart-table-area');
    const table = container.querySelector('.chart-data-table');
    const wrapper = container.querySelector('.chart-layout-wrapper');
    const canvasArea = container.querySelector('.chart-canvas-area');
    const canvas = container.querySelector('canvas.trend-canvas');
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const tableAreaRect = rect(tableArea);
    const tableRect = rect(table);
    const canvasRect = rect(canvas);
    return {
      headers: Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent.trim()),
      tableClientWidth: tableArea.clientWidth,
      tableScrollWidth: tableArea.scrollWidth,
      tableRight: tableRect.right,
      tableAreaRight: tableAreaRect.right,
      wrapperClientWidth: wrapper.clientWidth,
      wrapperScrollWidth: wrapper.scrollWidth,
      containerClientWidth: container.clientWidth,
      containerScrollWidth: container.scrollWidth,
      canvasWidth: canvasRect.width,
      canvasHeight: canvasRect.height,
      cssAspectRatio: canvasRect.width / canvasRect.height,
      backingAspectRatio: canvas.width / canvas.height,
      canvasAreaWidth: canvasArea.getBoundingClientRect().width
    };
  }));

  expect(charts).toHaveLength(2);
  for (const chart of charts) {
    expect(chart.headers).toEqual(['週期', 'SIRE', 'CDI', 'RS', 'PSC']);
    expect(chart.tableScrollWidth).toBeLessThanOrEqual(chart.tableClientWidth + 1);
    expect(chart.tableRight).toBeLessThanOrEqual(chart.tableAreaRight + 1);
    expect(chart.wrapperScrollWidth).toBeLessThanOrEqual(chart.wrapperClientWidth + 1);
    expect(chart.containerScrollWidth).toBeLessThanOrEqual(chart.containerClientWidth + 1);
    expect(chart.canvasAreaWidth).toBeGreaterThan(220);
    expect(chart.canvasWidth).toBeGreaterThan(220);
    expect(chart.canvasHeight).toBeGreaterThan(180);
    expect(Math.abs(chart.cssAspectRatio - chart.backingAspectRatio)).toBeLessThan(0.03);
  }

  const pdfPath = testInfo.outputPath('trend-chart-table-complete.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('trend-chart-table-complete.pdf', { body: pdf, contentType: 'application/pdf' });
});

test('12 模塊 PDF 首頁不因首項 keep-together 只剩表頭，順序與長短分頁規則固定', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const originals = reportData.map((item) => JSON.parse(JSON.stringify(item)));
    reportData = Array.from({ length: 12 }, (_, index) => {
      const item = JSON.parse(JSON.stringify(originals[index % originals.length]));
      item.id = 1000 + index;
      item._v7Id = `fixture-module-${String(index + 1).padStart(2, '0')}`;
      item.title = `十二模塊順序-${String(index + 1).padStart(2, '0')}`;
      item.selectedForPdf = true;
      item.pdfOrder = index + 1;
      if (index === 0) {
        item.columns = [Array.from({ length: 28 }, (_, line) => `<p style="margin:0;line-height:22px">${line === 0 ? '首項必須從第一頁開始，不可留下純表頭首頁' : `首項跨頁內容 ${String(line + 1).padStart(2, '0')}`}</p>`).join('')];
      } else if (index === 4) {
        item.columns = [Array.from({ length: 90 }, (_, line) => `<p>第五項長內容 ${line + 1}</p>`).join('')];
      } else {
        const height = index % 3 === 0 ? 250 : 120;
        item.columns = [`<div style="height:${height}px">模塊 ${index + 1} 內容</div>`];
      }
      return item;
    });
    window.__twelveModuleFormal = {
      snapshotId: 'fixture-twelve-modules',
      snapshot: {
        watermark: 12,
        report: {
          id: 'fixture-report',
          legacyFileId: 'fixture-report',
          title: '十二模塊正式 PDF 驗證',
          date: '2026-08-11',
          period: { startM: '8', startD: '1', endM: '8', endD: '31' },
          revision: 12
        },
        modules: reportData.map((item, index) => ({
          id: item._v7Id,
          legacyItemId: item.id,
          revision: index + 1,
          payload: JSON.parse(JSON.stringify(item))
        })),
        records: []
      }
    };
    renderTable();
  });

  await page.evaluate(() => {
    window.__twelveModulePrepareState = { status: 'pending', error: '' };
    window.__twelveModulePreparePromise = prepareV7FormalSnapshotPrintArea(window.__twelveModuleFormal, { selectAll: true })
      .then((ok) => {
        if (!ok) throw new Error('PRINT_AREA_NOT_READY');
        document.body.classList.add('pdf-print-mode');
        window.__twelveModulePrepareState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__twelveModulePrepareState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__twelveModulePrepareState?.status), { timeout: 30000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__twelveModulePrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const layout = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    const rows = Array.from(area.querySelectorAll('.module-card-row'));
    const pageContentHeight = (210 - 6 - 12) * 96 / 25.4;
    const firstTop = rows[0].getBoundingClientRect().top - area.getBoundingClientRect().top;
    const firstPageRemaining = pageContentHeight - (firstTop % pageContentHeight);
    return {
      pageContentHeight,
      firstPageRemaining,
      titles: rows.map((row) => row.querySelector('.module-title-editor')?.textContent?.trim() || ''),
      rows: rows.map((row) => ({
        height: Number(row.dataset.pdfModuleHeight || 0),
        keepTogether: row.classList.contains('pdf-keep-together'),
        breakInside: getComputedStyle(row).breakInside
      }))
    };
  });

  expect(layout.titles).toEqual(Array.from({ length: 12 }, (_, index) => `十二模塊順序-${String(index + 1).padStart(2, '0')}`));
  expect(layout.rows).toHaveLength(12);
  expect(layout.rows[0].height).toBeLessThanOrEqual(layout.pageContentHeight);
  expect(layout.rows[0].height).toBeGreaterThan(layout.firstPageRemaining);
  expect(layout.rows[0].keepTogether).toBe(false);
  expect(layout.rows[0].breakInside).toBe('auto');
  expect(layout.rows[4].height).toBeGreaterThan(layout.pageContentHeight);
  expect(layout.rows[4].keepTogether).toBe(false);
  expect(layout.rows[4].breakInside).toBe('auto');
  expect(layout.rows.slice(1).some((row) => row.height < layout.pageContentHeight && row.keepTogether)).toBe(true);

  const pdfPath = testInfo.outputPath('twelve-module-layout.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('twelve-module-layout.pdf', { body: pdf, contentType: 'application/pdf' });
  const pageObjects = pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || [];
  expect(pageObjects.length).toBeGreaterThan(2);
  expect(pageObjects.length).toBeLessThan(20);
});

test('PDF 只對單頁可容納的臨界項目啟用 keep-together，長項目維持可分頁', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    reportData[0].selectedForPdf = true;
    reportData[0].columns = [Array.from({ length: 90 }, (_, index) => `<p>長項目段落 ${index + 1}</p>`).join('')];
    reportData[1].selectedForPdf = true;
    reportData[1].columns = ['<div style="height:560px">臨界單頁項目內容</div>'];
    renderTable();
  });
  await page.evaluate(() => {
    window.__pdfModulePrepareState = { status: 'pending', error: '' };
    window.__pdfModulePreparePromise = prepareV1PdfPrintArea().then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__pdfModulePrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__pdfModulePrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__pdfModulePrepareState?.status), { timeout: 30000 }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__pdfModulePrepareState)).toEqual({ status: 'done', error: '' });
  const prepWidth = await page.locator('#pdfPrintArea').evaluate((area) => area.getBoundingClientRect().width);
  expect(prepWidth).toBeGreaterThan(1070);
  expect(prepWidth).toBeLessThan(1090);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const modules = await page.evaluate(() => Array.from(
    document.querySelectorAll('#pdfPrintArea .module-card-row')
  ).map((row) => ({
    keepTogether: row.classList.contains('pdf-keep-together'),
    measuredHeight: Number(row.dataset.pdfModuleHeight || 0),
    actualPrintHeight: Math.ceil(Math.max(row.getBoundingClientRect().height || 0, row.scrollHeight || 0)),
    breakInside: getComputedStyle(row).breakInside
  })));

  expect(modules).toHaveLength(2);
  expect(modules[0].measuredHeight).toBe(modules[0].actualPrintHeight);
  expect(modules[0].measuredHeight).toBeGreaterThan(720);
  expect(modules[0].keepTogether).toBe(false);
  expect(modules[0].breakInside).toBe('auto');
  expect(modules[1].measuredHeight).toBe(modules[1].actualPrintHeight);
  expect(modules[1].measuredHeight).toBeGreaterThan(600);
  expect(modules[1].measuredHeight).toBeLessThanOrEqual(720);
  expect(modules[1].keepTogether).toBe(true);
  expect(modules[1].breakInside).toBe('avoid');
});

test('舊 p_kind 的 PostgREST 失敗 pending 在 reload 後改送正確 snapshot RPC', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const failed = await page.evaluate(async () => {
    const client = window.MonthlyV7App.client;
    const report = client.currentReport();
    const pendingKey = `create_snapshot:${report.id}:pdf`;
    const storageKey = `monthly_v7_pending:${pendingKey}`;
    try {
      await client.executeOperation('monthly_v7_create_report_snapshot', {
        p_workspace_key: client.config.workspaceKey,
        p_site_session_id: client.siteSession.id,
        p_user_session_id: client.userSession.id,
        p_report_id: report.id,
        p_kind: 'pdf'
      }, pendingKey);
      return { rejected: false, pending: localStorage.getItem(storageKey), storageKey };
    } catch (error) {
      return { rejected: true, code: error.code, pending: localStorage.getItem(storageKey), storageKey };
    }
  });
  expect(failed.rejected).toBe(true);
  expect(failed.code).toBe('PGRST202');
  expect(JSON.parse(JSON.parse(failed.pending).signature).p_kind).toBe('pdf');

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.MonthlyV7App?.client?.userSession?.id
    && window.MonthlyV7App.client.currentReport()?.id
  ))).toBe(true);
  const recovered = await page.evaluate(async (storageKey) => {
    const result = await window.MonthlyV7App.client.createReportSnapshot('pdf');
    return { snapshotId: result.snapshotId, pending: localStorage.getItem(storageKey) };
  }, failed.storageKey);
  expect(recovered.snapshotId).toBeTruthy();
  expect(recovered.pending).toBeNull();
});
