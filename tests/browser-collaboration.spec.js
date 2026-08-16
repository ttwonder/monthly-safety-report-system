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
  const displayName = username === 'owner' ? 'Owner A' : (username === 'admin' ? 'Admin C' : 'Operator B');
  await expect(page.locator('#v5TopStatus')).toContainText(displayName);
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

test('數據管理 Admin 無進站密碼權限且只能修改自己的登入密碼', async ({ page, request }) => {
  await enterAndLogin(page, 'admin', 'admin-pass');
  await page.locator('[data-v1-tab="cloud"]').click();
  await expect(page.locator('#v1-pane-cloud')).toHaveClass(/active/);
  await expect(page.locator('#v1-pane-cloud')).toContainText('只有 Owner 可以修改進站密碼');
  await expect(page.locator('#site-access-new-password')).toHaveCount(0);
  await expect(page.locator('#site-access-confirm-password')).toHaveCount(0);

  await expect(page.locator('#v7-storage-stats')).toContainText('Supabase 資料庫總用量');
  await expect(page.locator('#v7-storage-stats')).toContainText('本系統資料表用量');
  const adminRow = page.locator('tr[data-username="admin"]');
  await expect(adminRow.locator('[data-v5-reset-password="1"]')).toHaveCount(1);
  await expect(adminRow.getByRole('button', { name: '修改自己的登入密碼' })).toHaveCount(1);
  await expect(page.locator('tr[data-username="owner"] [data-v5-reset-password="1"]')).toHaveCount(0);
  await expect(page.locator('tr[data-username="operator"] [data-v5-reset-password="1"]')).toHaveCount(0);

  const denied = await page.evaluate(async () => {
    try {
      await window.MonthlyV7App.updateSitePassword('admin-denied-gate-pass');
      return 'UNEXPECTED_SUCCESS';
    } catch (error) {
      return String(error?.code || error?.message || error);
    }
  });
  expect(denied).toContain('FORBIDDEN');
  expect(await page.evaluate(() => window.MonthlyV7App.currentUser()?.username || '')).toBe('admin');

  await adminRow.locator('[data-v5-reset-password="1"]').fill('admin-new-pass');
  const successDialog = page.waitForEvent('dialog');
  await adminRow.getByRole('button', { name: '修改自己的登入密碼' }).click();
  const dialog = await successDialog;
  expect(dialog.message()).toContain('請使用新密碼重新登入');
  await dialog.accept();
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const oldLogin = await page.evaluate(async () => {
    try {
      await window.MonthlyV7App.login('admin', 'admin-pass');
      return 'UNEXPECTED_SUCCESS';
    } catch (error) {
      return String(error?.code || error?.message || error);
    }
  });
  expect(oldLogin).toContain('INVALID_CREDENTIALS');
  await page.evaluate(async () => {
    await window.MonthlyV7App.login('admin', 'admin-new-pass');
    renderV5SessionBar();
  });
  await expect(page.locator('#v5TopStatus')).toContainText('Admin C');
  const fake = await (await request.get('/__fake_state')).json();
  expect(fake.rpcCounts.monthly_v7_update_site_password).toBe(1);
  expect(fake.rpcCounts.monthly_v7_update_user).toBe(1);
});

test('數據管理 Owner 可重設所有登入密碼並顯示總量、月報雲端量與本機量', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.locator('[data-v1-tab="cloud"]').click();
  await expect(page.locator('#site-access-new-password')).toBeVisible();
  await expect(page.locator('#site-access-confirm-password')).toBeVisible();
  await expect(page.locator('#v7-storage-stats')).toContainText('Supabase 資料庫總用量');
  await expect(page.locator('#v7-storage-stats')).toContainText('GitHub Pages');
  await expect(page.locator('#v7-storage-stats')).toContainText('月報內容與快照邏輯量');
  await expect(page.locator('#v7-storage-stats')).not.toContainText('—');
  await expect(page.locator('#v1-pane-cloud [data-v5-reset-password="1"]')).toHaveCount(3);

  await page.locator('[data-v1-tab="history"]').click();
  await expect(page.locator('#v1-history-list')).toContainText('本機 JSON');
  await expect(page.locator('#v1-history-list')).toContainText('Supabase 內容與快照邏輯量');

  await page.locator('[data-v1-tab="cloud"]').click();
  const operatorRow = page.locator('tr[data-username="operator"]');
  await operatorRow.locator('[data-v5-reset-password="1"]').fill('operator-new-pass');
  await operatorRow.getByRole('button', { name: '重設', exact: true }).click();
  await expect(operatorRow.locator('[data-v5-reset-password="1"]')).toHaveValue('');
  expect(await page.evaluate(() => window.MonthlyV7App.currentUser()?.username || '')).toBe('owner');

  await page.evaluate(async () => {
    await window.MonthlyV7App.logoutUser();
    renderV5SessionBar();
  });
  const oldLogin = await page.evaluate(async () => {
    try {
      await window.MonthlyV7App.login('operator', 'operator-pass');
      return 'UNEXPECTED_SUCCESS';
    } catch (error) {
      return String(error?.code || error?.message || error);
    }
  });
  expect(oldLogin).toContain('INVALID_CREDENTIALS');
  await page.evaluate(async () => {
    await window.MonthlyV7App.login('operator', 'operator-new-pass');
    renderV5SessionBar();
  });
  await expect(page.locator('#v5TopStatus')).toContainText('Operator B');
});

for (const mixedAsset of [
  { name: 'config', url: '**/supabase-config.js*', declaration: "config: 'stale-build'" },
  { name: 'core', url: '**/monthly-collaboration-core.js*', declaration: "core: 'stale-build'" },
  { name: 'client', url: '**/monthly-collaboration-client.js*', declaration: "client: 'stale-build'" },
  { name: 'V7', url: '**/monthly-collaboration-v7.js*', declaration: "v7: 'stale-build'" }
]) {
  test(`混合 ${mixedAsset.name} 資源必須在第一個 RPC 前鎖住並顯示 MIXED_ASSET_BLOCKED`, async ({ page, request }) => {
    await page.route(mixedAsset.url, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body: `${body}\nwindow.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, window.MONTHLY_REPORT_ASSET_BUILDS, { ${mixedAsset.declaration} });`
      });
    });

    await page.goto('/', { waitUntil: 'load' });

    const state = await (await request.get('/__fake_state')).json();
    expect(state.rpcCounts.monthly_v7_get_status || 0).toBe(0);
    await expect(page.locator('body')).toHaveClass(/site-access-locked/);
    await expect(page.locator('#site-access-error')).toContainText('MIXED_ASSET_BLOCKED');
  });
}

test('舊 HTML 載入新 V7 時必須由 adapter 在第一個 RPC 前反向封鎖', async ({ page, request }) => {
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: body
        .replace("window.MONTHLY_REPORT_PAGE_BUILD = '7.2.0';", "window.MONTHLY_REPORT_PAGE_BUILD = 'stale-page';")
        .replace('v7AssertStartupBuild();', 'window.__pageBuildAssertBypassed = true;')
    });
  });

  await page.goto('/', { waitUntil: 'load' });

  expect(await page.evaluate(() => window.__pageBuildAssertBypassed === true)).toBe(true);
  expect(await page.evaluate(() => window.MonthlyV7App?.client || null)).toBeNull();
  const state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_get_status || 0).toBe(0);
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  await expect(page.locator('#site-access-error')).toContainText('MIXED_ASSET_BLOCKED');
});

async function openMixedBuildWithOneFreshReload(page) {
  let coreRequests = 0;
  const coreUrls = [];
  await page.route('**/monthly-collaboration-core.js*', async (route) => {
    coreRequests += 1;
    coreUrls.push(route.request().url());
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: coreRequests === 1
        ? `${body}\nwindow.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, window.MONTHLY_REPORT_ASSET_BUILDS, { core: 'stale-build' });`
        : body
    });
  });
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#site-access-error')).toContainText('MIXED_ASSET_BLOCKED');
  return { count: () => coreRequests, urls: coreUrls };
}

test('clean 混版可一鍵安全重載且保留 storage 並使用唯一 cache-busting URL', async ({ page, request }) => {
  const coreTrace = await openMixedBuildWithOneFreshReload(page);
  await page.evaluate(() => localStorage.setItem('monthly_safe_reload_sentinel', 'keep-clean'));

  await Promise.all([
    page.waitForURL((url) => url.searchParams.get('monthly-build') === '7.2.0'
      && Boolean(url.searchParams.get('monthly-reload'))),
    page.locator('#site-safe-reload').click()
  ]);

  expect(coreTrace.count()).toBeGreaterThanOrEqual(2);
  const reloadNonce = new URL(page.url()).searchParams.get('monthly-reload');
  expect(reloadNonce).toBeTruthy();
  expect(new URL(coreTrace.urls.at(-1)).searchParams.get('reload')).toBe(reloadNonce);
  expect(await page.evaluate(() => localStorage.getItem('monthly_safe_reload_sentinel'))).toBe('keep-clean');
  await expect.poll(async () => {
    const state = await (await request.get('/__fake_state')).json();
    return Number(state.rpcCounts.monthly_v7_get_status || 0);
  }).toBe(1);
});

test('有 durable draft 或 conflict 時安全重載必須先確認證據，第二次才導航且不刪除草稿', async ({ page, request }) => {
  await openMixedBuildWithOneFreshReload(page);
  const draftKey = 'monthly_v7_draft:module:safe-reload-draft';
  const durableDraft = JSON.stringify({
    entityType: 'module', entityId: 'safe-reload-draft', baseRevision: 4,
    payload: { title: '安全重載必須保留的草稿' }, savedAt: '2026-08-13T12:00:00.000Z'
  });
  await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
    window.MonthlyV7App.revisionConflictBlocks.set('module:safe-reload-draft', {
      state: 'REVISION_CONFLICT_BLOCKED', entityType: 'module', entityId: 'safe-reload-draft'
    });
  }, { key: draftKey, value: durableDraft });
  const originalUrl = page.url();

  await page.locator('#site-safe-reload').click();

  expect(page.url()).toBe(originalUrl);
  await expect(page.locator('#site-safe-reload-status')).toContainText('再次');
  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(durableDraft);
  let state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_save_module || 0).toBe(0);

  await Promise.all([
    page.waitForURL((url) => Boolean(url.searchParams.get('monthly-reload'))),
    page.locator('#site-safe-reload').click()
  ]);

  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(durableDraft);
  state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_save_module || 0).toBe(0);
});

test('unknown pending 安全重載不得建立新保存且原 operation evidence 必須原封不動', async ({ page, request }) => {
  await openMixedBuildWithOneFreshReload(page);
  const pendingKey = 'monthly_v7_pending:save_module:safe-reload-pending';
  const pending = JSON.stringify({
    operationId: 'safe-reload-operation-1', signature: '{}',
    createdAt: '2026-08-13T12:00:00.000Z', actorUserId: 'owner-id'
  });
  await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
    window.MonthlyV7App.client = {
      lastOperationReceipt: () => ({
        state: 'RESULT_UNKNOWN_PENDING_RECONCILIATION', operationId: 'safe-reload-operation-1',
        rpcName: 'monthly_v7_save_module', requestedOrigin: 'autosave', saveOrigin: 'autosave'
      })
    };
  }, { key: pendingKey, value: pending });
  const originalUrl = page.url();

  await page.locator('#site-safe-reload').click();

  expect(page.url()).toBe(originalUrl);
  await expect(page.locator('#site-safe-reload-status')).toContainText(/待對帳|operation/);
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBe(pending);
  let state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_save_module || 0).toBe(0);

  await Promise.all([
    page.waitForURL((url) => Boolean(url.searchParams.get('monthly-reload'))),
    page.locator('#site-safe-reload').click()
  ]);

  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBe(pending);
  state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.monthly_v7_save_module || 0).toBe(0);
});

test('in-flight 保存期間安全重載必須停止，不得人為製造 lost-ACK', async ({ page }) => {
  await openMixedBuildWithOneFreshReload(page);
  const draftKey = 'monthly_v7_draft:module:in-flight-module';
  const durableDraft = JSON.stringify({
    entityType: 'module', entityId: 'in-flight-module', baseRevision: 2,
    payload: { title: '保存仍在途的草稿' }, savedAt: '2026-08-13T12:00:00.000Z'
  });
  const result = await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
    V7_CLOUD_SAVE_PROMISE = new Promise(() => {});
    V4_CLOUD_SAVING = true;
    return {
      firstAttempt: v7SafeReloadFromGate(),
      secondAttempt: v7SafeReloadFromGate(),
      draft: localStorage.getItem(key),
      status: document.getElementById('site-safe-reload-status')?.textContent || ''
    };
  }, { key: draftKey, value: durableDraft });

  expect(result).toMatchObject({
    firstAttempt: false,
    secondAttempt: false,
    draft: durableDraft
  });
  expect(result.status).toContain('保存仍在進行');
  expect(new URL(page.url()).searchParams.get('monthly-reload')).toBeNull();
});

test('conflict 安全重載不得以其他 entity 的 draft 冒充 durable 證據', async ({ page }) => {
  await openMixedBuildWithOneFreshReload(page);
  const unrelatedKey = 'monthly_v7_draft:module:unrelated-module';
  const unrelatedDraft = JSON.stringify({
    entityType: 'module', entityId: 'unrelated-module', baseRevision: 1,
    payload: { title: '不相關草稿' }, savedAt: '2026-08-13T12:00:00.000Z'
  });
  const result = await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
    window.MonthlyV7App.revisionConflictBlocks.set('module:missing-draft-module', {
      state: 'REVISION_CONFLICT_BLOCKED',
      entityType: 'module',
      entityId: 'missing-draft-module'
    });
    const evidence = v7SafeReloadEvidence();
    return {
      durableEvidenceConfirmed: evidence.durableEvidenceConfirmed,
      firstAttempt: v7SafeReloadFromGate(),
      secondAttempt: v7SafeReloadFromGate(),
      unrelatedDraft: localStorage.getItem(key),
      status: document.getElementById('site-safe-reload-status')?.textContent || ''
    };
  }, { key: unrelatedKey, value: unrelatedDraft });

  expect(result).toMatchObject({
    durableEvidenceConfirmed: false,
    firstAttempt: false,
    secondAttempt: false,
    unrelatedDraft
  });
  expect(result.status).toContain('durable');
  expect(new URL(page.url()).searchParams.get('monthly-reload')).toBeNull();
});

test('unknown result 安全重載只接受相同 operation ID 的 pending 證據', async ({ page }) => {
  await openMixedBuildWithOneFreshReload(page);
  const unrelatedPendingKey = 'monthly_v7_pending:save_module:unrelated-operation';
  const unrelatedPending = JSON.stringify({
    operationId: 'operation-b', signature: '{}',
    createdAt: '2026-08-13T12:00:00.000Z', actorUserId: 'owner-id'
  });
  const result = await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
    window.MonthlyV7App.client = {
      lastOperationReceipt: () => ({
        state: 'RESULT_UNKNOWN_PENDING_RECONCILIATION',
        operationId: 'operation-a',
        rpcName: 'monthly_v7_save_module',
        requestedOrigin: 'autosave',
        saveOrigin: 'autosave'
      })
    };
    const evidence = v7SafeReloadEvidence();
    return {
      durableEvidenceConfirmed: evidence.durableEvidenceConfirmed,
      firstAttempt: v7SafeReloadFromGate(),
      secondAttempt: v7SafeReloadFromGate(),
      unrelatedPending: localStorage.getItem(key),
      status: document.getElementById('site-safe-reload-status')?.textContent || ''
    };
  }, { key: unrelatedPendingKey, value: unrelatedPending });

  expect(result).toMatchObject({
    durableEvidenceConfirmed: false,
    firstAttempt: false,
    secondAttempt: false,
    unrelatedPending
  });
  expect(result.status).toContain('durable');
  expect(new URL(page.url()).searchParams.get('monthly-reload')).toBeNull();
});

test('診斷收據包含 build、authority、workspace hash、last RPC 與 save origin 且不洩漏秘密', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.MonthlyV7App.client.setOperationReceipt({
      state: 'RESULT_UNKNOWN_PENDING_RECONCILIATION',
      rpcName: 'monthly_v7_save_module',
      operationId: 'diagnostic-operation-1',
      requestedOrigin: 'manual',
      saveOrigin: 'manual',
      errorCode: 'RPC_TIMEOUT',
      updatedAt: '2026-08-13T12:00:00.000Z'
    });
  });

  const receipt = await page.evaluate(() => window.MonthlyV7App.diagnosticReceipt());
  expect(receipt).toMatchObject({
    state: 'NORMALIZED_READY',
    builds: {
      page: '7.2.0', config: '7.2.0', core: '7.2.0', client: '7.2.0', v7: '7.2.0'
    },
    authority: { state: 'NORMALIZED_ACTIVE', epoch: 2 },
    lastRpc: 'monthly_v7_get_snapshot',
    save: {
      origin: 'manual', operationId: 'diagnostic-operation-1',
      state: 'RESULT_UNKNOWN_PENDING_RECONCILIATION'
    }
  });
  expect(receipt.workspaceHashPrefix).toMatch(/^[a-f0-9]{12}$/);
  const serialized = JSON.stringify(receipt);
  expect(serialized).not.toContain('browser-workspace');
  expect(serialized).not.toContain('fake-anon-key');
  expect(serialized).not.toContain('http://127.0.0.1:4187');
  expect(serialized).not.toContain('site_session');
  expect(serialized).not.toContain('user_session');
});

test('configured workspace 的未知 authority 必須鎖住啟動且不得呼叫 legacy cloud read', async ({ page, request }) => {
  await request.post('/__fake_status?kind=unknown');
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'monthly_report_site_access_unlocked_hash',
      '38adfff5529d37b7699dadcc02aba2877a44fb6f6b788b3bfae859be6ebbc432'
    );
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => {
        capturedOnload = handler;
        window.__authorityCapturedOnload = handler;
      }
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__authorityCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__authorityCapturedOnload = null;
    await boot.call(window);
    window.alert = () => {};
    window.confirm = () => true;
    await window.v4AutoSyncLatestFromCloud({ silent: true });
    await window.v4CheckCloudRevision({ silent: true });
    await window.v4DownloadFromCloud();
    await window.v4TestCloudConnection();
    await window.v4UploadToCloud({ silent: true });
  });

  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  await expect(page.locator('#site-access-error')).toContainText('雲端安全驗證無法初始化');
  expect(await page.evaluate(() => window.MonthlyV7App?.status?.mode || '')).toBe('error');
  await expect(page.locator('#v5TopStatus')).not.toContainText(/尚未建立 owner|雲端未找到 Owner/);
  const state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.get_monthly_report_cloud_data || 0).toBe(0);
  expect(state.rpcCounts.upsert_monthly_report_cloud_data || 0).toBe(0);
});

test('已驗證 authority 不得沿用到未重新驗證的新雲端配置或 unload lock', async ({ page, request }) => {
  await request.post('/__fake_status?kind=legacy');
  await page.addInitScript(() => {
    const owner = { username: 'owner', displayName: 'Legacy Owner', role: 'owner' };
    localStorage.setItem('monthly_report_v5_users', JSON.stringify([{ ...owner, passwordHash: 'test-only' }]));
    sessionStorage.setItem('monthly_report_v5_session', JSON.stringify(owner));
    sessionStorage.setItem(
      'monthly_report_site_access_unlocked_hash',
      '38adfff5529d37b7699dadcc02aba2877a44fb6f6b788b3bfae859be6ebbc432'
    );
  });
  await page.goto('/', { waitUntil: 'load' });
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App?.status?.mode || '')).toBe('legacy');
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  const sourceIdentity = await page.evaluate(() => v4CloudConfigIdentity(v4GetCloudConfig()));
  expect(await page.evaluate(() => localStorage.getItem('monthly_report_legacy_local_authority_scope'))).toBe(sourceIdentity);
  expect(await page.evaluate(() => sessionStorage.getItem('monthly_report_legacy_session_authority_scope'))).toBe(sourceIdentity);
  expect(await page.evaluate(() => v5CurrentUser()?.displayName || '')).toBe('Legacy Owner');
  await page.evaluate(() => switchV1Tab('cloud'));
  await expect(page.locator('#v4-workspace-key')).toBeVisible();
  const before = await (await request.get('/__fake_state')).json();

  const result = await page.evaluate(async () => {
    const originalConfig = v4GetCloudConfig();
    const incompleteMode = v4CloudAuthorityMode({ ...originalConfig, workspaceKey: '' });
    originalConfig.autoSyncOnOpen = false;
    localStorage.setItem(V4_CLOUD_CONFIG_KEY, JSON.stringify(originalConfig));
    const workspace = document.getElementById('v4-workspace-key');
    if (!workspace) throw new Error('WORKSPACE_CONFIG_INPUT_NOT_FOUND');
    workspace.value = 'changed-without-authority-check';
    window.alert = () => {};
    window.confirm = () => true;
    v4SaveCloudConfigFromForm();
    V6_ACTIVE_LOCK_SECTION = 'editor';
    await v4AutoSyncLatestFromCloud({ silent: true });
    await v4CheckCloudRevision({ silent: true });
    await v4DownloadFromCloud();
    await v4TestCloudConnection();
    await v4UploadToCloud({ silent: true });
    await v6ClaimCurrentSectionLock({ silent: true });
    await v6ReleaseCurrentLock();
    V6_ACTIVE_LOCK_SECTION = 'editor';
    window.dispatchEvent(new Event('beforeunload'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      incompleteMode,
      mode: v4CloudAuthorityMode(),
      currentUser: v5CurrentUser(),
      locked: document.body.classList.contains('site-access-locked')
    };
  });

  expect(result).toEqual({ incompleteMode: 'blocked', mode: 'blocked', currentUser: null, locked: true });
  const after = await (await request.get('/__fake_state')).json();
  for (const name of [
    'get_monthly_report_cloud_data',
    'upsert_monthly_report_cloud_data',
    'claim_monthly_report_edit_lock',
    'release_monthly_report_edit_lock'
  ]) {
    expect(after.rpcCounts[name] || 0, name).toBe(before.rpcCounts[name] || 0);
  }

  const rawLegacyState = await page.evaluate(() => ({
    unlock: sessionStorage.getItem('monthly_report_site_access_unlocked_hash'),
    session: sessionStorage.getItem('monthly_report_v5_session'),
    users: localStorage.getItem('monthly_report_v5_users')
  }));
  expect(rawLegacyState.unlock).toBeTruthy();
  expect(rawLegacyState.session).toContain('Legacy Owner');
  expect(rawLegacyState.users).toContain('Legacy Owner');

  await page.reload({ waitUntil: 'load' });
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App?.status?.mode || '')).toBe('legacy');
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  const reloaded = await page.evaluate(() => ({
    mode: v4CloudAuthorityMode(),
    currentUser: v5CurrentUser(),
    canManage: v5CanManageData(),
    rawUnlock: sessionStorage.getItem('monthly_report_site_access_unlocked_hash'),
    rawSession: sessionStorage.getItem('monthly_report_v5_session'),
    rawUsers: localStorage.getItem('monthly_report_v5_users')
  }));
  expect(reloaded).toEqual({
    mode: 'blocked',
    currentUser: null,
    canManage: false,
    rawUnlock: rawLegacyState.unlock,
    rawSession: rawLegacyState.session,
    rawUsers: rawLegacyState.users
  });
  expect(await page.evaluate(() => localStorage.getItem('monthly_report_legacy_local_authority_scope'))).toBe(sourceIdentity);
  expect(await page.evaluate(() => sessionStorage.getItem('monthly_report_legacy_session_authority_scope'))).toBe(sourceIdentity);
  await expect(page.locator('#v5TopStatus')).not.toContainText(/尚未建立 owner|雲端未找到 Owner/);
  const afterReload = await (await request.get('/__fake_state')).json();
  for (const name of [
    'get_monthly_report_cloud_data',
    'upsert_monthly_report_cloud_data',
    'claim_monthly_report_edit_lock',
    'release_monthly_report_edit_lock'
  ]) {
    expect(afterReload.rpcCounts[name] || 0, `${name} after reload`).toBe(after.rpcCounts[name] || 0);
  }
});

test('從未保存雲端 identity 時仍維持純本機 unconfigured 模式', async ({ page }) => {
  await page.route('**/supabase-config.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: 'window.MONTHLY_REPORT_SUPABASE_CONFIG={};'
    });
  });
  await page.goto('/', { waitUntil: 'load' });
  expect(await page.evaluate(() => localStorage.getItem(V4_CLOUD_CONFIG_KEY))).toBeNull();
  expect(await page.evaluate(() => v4CloudAuthorityMode())).toBe('unconfigured');
});

test('明確清空部署注入的 legacy 雲端 identity 後不得復活舊設定或呼叫 legacy RPC', async ({ page, request }) => {
  await request.post('/__fake_status?kind=legacy');
  await page.addInitScript(() => {
    const owner = { username: 'owner', displayName: 'Legacy Owner', role: 'owner' };
    localStorage.setItem('monthly_report_v5_users', JSON.stringify([{ ...owner, passwordHash: 'test-only' }]));
    sessionStorage.setItem('monthly_report_v5_session', JSON.stringify(owner));
    sessionStorage.setItem(
      'monthly_report_site_access_unlocked_hash',
      '38adfff5529d37b7699dadcc02aba2877a44fb6f6b788b3bfae859be6ebbc432'
    );
  });
  await page.goto('/', { waitUntil: 'load' });
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App?.status?.mode || '')).toBe('legacy');
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  await page.evaluate(() => {
    const config = v4GetCloudConfig();
    config.autoSyncOnOpen = false;
    localStorage.setItem(V4_CLOUD_CONFIG_KEY, JSON.stringify(config));
    switchV1Tab('cloud');
  });
  await expect(page.locator('#v4-workspace-key')).toBeVisible();
  const before = await (await request.get('/__fake_state')).json();

  const cleared = await page.evaluate(async () => {
    const workspace = document.getElementById('v4-workspace-key');
    if (!workspace) throw new Error('WORKSPACE_CONFIG_INPUT_NOT_FOUND');
    workspace.value = '';
    window.alert = () => {};
    window.confirm = () => true;
    v4SaveCloudConfigFromForm();
    await v4AutoSyncLatestFromCloud({ silent: true });
    await v4CheckCloudRevision({ silent: true });
    await v4DownloadFromCloud();
    await v4TestCloudConnection();
    await v4UploadToCloud({ silent: true });
    return {
      savedWorkspace: JSON.parse(localStorage.getItem(V4_CLOUD_CONFIG_KEY) || '{}').workspaceKey,
      currentWorkspace: v4GetCloudConfig().workspaceKey,
      mode: v4CloudAuthorityMode(),
      currentUser: v5CurrentUser(),
      locked: document.body.classList.contains('site-access-locked')
    };
  });
  expect(cleared).toEqual({
    savedWorkspace: '',
    currentWorkspace: '',
    mode: 'blocked',
    currentUser: null,
    locked: true
  });
  const afterClear = await (await request.get('/__fake_state')).json();
  expect(afterClear.rpcCounts.get_monthly_report_cloud_data || 0).toBe(before.rpcCounts.get_monthly_report_cloud_data || 0);
  expect(afterClear.rpcCounts.upsert_monthly_report_cloud_data || 0).toBe(before.rpcCounts.upsert_monthly_report_cloud_data || 0);

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  const reloaded = await page.evaluate(() => ({
    savedWorkspace: JSON.parse(localStorage.getItem(V4_CLOUD_CONFIG_KEY) || '{}').workspaceKey,
    currentWorkspace: v4GetCloudConfig().workspaceKey,
    mode: v4CloudAuthorityMode(),
    currentUser: v5CurrentUser()
  }));
  expect(reloaded).toEqual({
    savedWorkspace: '',
    currentWorkspace: '',
    mode: 'blocked',
    currentUser: null
  });
  const afterReload = await (await request.get('/__fake_state')).json();
  expect(afterReload.rpcCounts.get_monthly_report_cloud_data || 0).toBe(afterClear.rpcCounts.get_monthly_report_cloud_data || 0);
  expect(afterReload.rpcCounts.upsert_monthly_report_cloud_data || 0).toBe(afterClear.rpcCounts.upsert_monthly_report_cloud_data || 0);
});

test('發行 site marker 時 authority changed 必須鎖回 Gate 並停止 boot，不可降級成未記住裝置', async ({ page, request }) => {
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_issue_site_resume') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'AUTHORITY_CHANGED', authority_state: 'MIGRATION_REQUIRED' })
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');

  await page.getByRole('button', { name: '進入系統' }).click();

  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  await expect(page.locator('#site-access-error')).toContainText('雲端權威狀態已變更');
  const local = await page.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    user: sessionStorage.getItem('monthly_v7_user_session')
  }));
  expect(local.marker).toBeNull();
  expect(local.site).toBeNull();
  expect(local.user).toBeNull();
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_get_snapshot || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
});

test('發行 site marker 收到 SITE_SESSION_INVALID 必須上拋並清本頁 session，不可當作 optional warning', async ({ page, request }) => {
  let issueRequests = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_issue_site_resume') return route.continue();
    issueRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'SITE_SESSION_INVALID' })
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(
    () => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized)),
    { timeout: 30000 }
  ).toBe(true);
  await page.evaluate(() => {
    localStorage.setItem('monthly_v7_draft:module:issue-session-invalid', JSON.stringify({
      payload: { title: '發行失效仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:issue-session-invalid', '{issue-session-invalid-pending');
  });

  const outcome = await page.evaluate(async () => {
    try {
      await window.MonthlyV7App.openSite('gate-pass', { rememberDevice: true });
      return { resolved: true, code: '' };
    } catch (error) {
      return { resolved: false, code: String(error?.code || error?.message || '') };
    }
  });

  expect(outcome).toEqual({ resolved: false, code: 'SITE_SESSION_INVALID' });
  const local = await page.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    user: sessionStorage.getItem('monthly_v7_user_session'),
    draft: localStorage.getItem('monthly_v7_draft:module:issue-session-invalid'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:issue-session-invalid'),
    unlocked: window.MonthlyV7App.isSiteUnlocked()
  }));
  expect(local.marker).toBeNull();
  expect(local.site).toBeNull();
  expect(local.user).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('發行失效仍保留');
  expect(local.pending).toBe('{issue-session-invalid-pending');
  expect(local.unlocked).toBe(false);
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_open_site || 0)).toBe(1);
  expect(issueRequests).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_issue_site_resume || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_get_snapshot || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
});

test('一般 site marker 發行失敗可繼續進站，但必須顯示可見警告且不得假裝已記住', async ({ page, request }) => {
  let issueRequests = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_issue_site_resume') return route.continue();
    issueRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'SITE_RESUME_ISSUE_FAILED' })
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(
    () => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized)),
    { timeout: 30000 }
  ).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');

  await page.getByRole('button', { name: '進入系統' }).click();

  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  await expect(page.locator('#saveToast')).toHaveClass(/toast-show/);
  await expect(page.locator('#saveToastMsg')).toContainText('無法記住此裝置');
  const local = await page.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    user: sessionStorage.getItem('monthly_v7_user_session')
  }));
  expect(local.marker).toBeNull();
  expect(local.site).not.toBeNull();
  expect(local.user).toBeNull();
  expect(issueRequests).toBe(1);
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_get_snapshot || 0)).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
});

test('未勾選記住此裝置時不發行 durable site marker 或呼叫 resume RPC', async ({ page, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(page.locator('#site-remember-device')).not.toBeChecked();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'))).toBeNull();
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_issue_site_resume || 0)).toBe(0);
});

test('記住此裝置會跨 browser context 輪替 site marker，snapshot 驗證前 Gate 保持鎖定且不登入 user', async ({ page, browser }) => {
  test.setTimeout(90000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  const remember = page.locator('#site-remember-device');
  await expect(remember).toBeVisible();
  await expect(remember).not.toBeChecked();
  await remember.check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const first = await page.evaluate(() => ({
    raw: localStorage.getItem('monthly_v7_site_resume_marker'),
    user: window.MonthlyV7App.currentUser(),
    siteSession: window.MonthlyV7App.client.siteSession?.id || ''
  }));
  expect(first.raw).toBeTruthy();
  const firstMarker = JSON.parse(first.raw);
  expect(firstMarker).toMatchObject({
    version: 1,
    purpose: 'site',
    authorityEpoch: 2
  });
  expect(firstMarker).not.toHaveProperty('workspaceKey');
  expect(firstMarker.token).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(firstMarker)).not.toContain('gate-pass');
  expect(JSON.stringify(firstMarker)).not.toContain('password');
  expect(first.user).toBeNull();
  expect(first.siteSession).not.toBe('');

  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  const resumedContext = await browser.newContext({
    storageState: { cookies: [], origins: origin ? [origin] : [] }
  });
  const resumed = await resumedContext.newPage();
  let releaseSnapshot;
  let signalSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  await resumed.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_get_snapshot') {
      signalSnapshotStarted();
      await snapshotGate;
    }
    await route.continue();
  });
  await resumed.goto('/', { waitUntil: 'domcontentloaded' });
  await snapshotStarted;
  await expect(resumed.locator('#siteAccessGate')).toBeVisible();
  await expect(resumed.locator('body')).toHaveClass(/site-access-locked/);
  expect(await resumed.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  expect(await resumed.evaluate(() => Boolean(window.MonthlyV7App.client.siteSession?.id))).toBe(true);
  expect(await resumed.evaluate(() => window.MonthlyV7App.client.isSiteSessionPendingValidation())).toBe(true);

  releaseSnapshot();
  await expect(resumed.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => resumed.evaluate(() => window.MonthlyV7App.client.isSiteUnlocked())).toBe(true);
  expect(await resumed.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  const rotated = await resumed.evaluate(() => JSON.parse(localStorage.getItem('monthly_v7_site_resume_marker') || 'null'));
  expect(rotated.token).toMatch(/^[a-f0-9]{64}$/);
  expect(rotated.token).not.toBe(firstMarker.token);
  expect(await resumed.evaluate(() => sessionStorage.getItem('monthly_v7_user_session'))).toBeNull();
  await resumedContext.close();
});

test('帳號保持登入與記住用戶名分離且預設不勾，未 opt-in 時零 user-resume RPC', async ({ page, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  await expect(page.locator('#v5-remember-username')).toBeVisible();
  await expect(page.locator('#v5-remember-user')).toBeVisible();
  await expect(page.locator('#v5-remember-user')).not.toBeChecked();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');

  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).toBeNull();
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_issue_user_resume || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_exchange_user_resume || 0)).toBe(0);
});

test('缺少 user-resume issue migration 時仍完成手動登入，但警告未保持登入且不建 marker', async ({ page }) => {
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_issue_user_resume') return route.continue();
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'PGRST202',
        message: 'Could not find the function public.monthly_v7_issue_user_resume'
      })
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await page.locator('#v5-remember-user').check();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();

  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await expect(page.locator('#v5TopStatus')).toContainText('帳號已登入，但無法在此裝置保持登入');
  expect(await page.evaluate(() => window.MonthlyV7App.currentUser()?.username || '')).toBe('owner');
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).toBeNull();
});

test('明確 opt-in 後跨 context 輪替 user marker，第二次 authoritative snapshot 成功前不投影 Owner', async ({ page, browser, request }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('#v5-remember-user')).toBeVisible();
  await page.locator('#v5-remember-user').check();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');

  const firstMarker = await page.evaluate(() => JSON.parse(localStorage.getItem('monthly_v7_user_resume_marker') || 'null'));
  expect(firstMarker).toMatchObject({
    version: 1,
    purpose: 'user',
    authorityEpoch: 2
  });
  expect(firstMarker.token).toMatch(/^[a-f0-9]{64}$/);
  expect(firstMarker.trustedDeviceId).toBeTruthy();
  expect(JSON.stringify(firstMarker)).not.toContain('owner');
  expect(JSON.stringify(firstMarker)).not.toContain('owner-pass');
  expect(JSON.stringify(firstMarker)).not.toContain('password');

  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  expect(origin).toBeTruthy();
  const resumedContext = await browser.newContext({ storageState: { cookies: [], origins: [origin] } });
  const resumed = await resumedContext.newPage();
  let snapshotCount = 0;
  let signalUserSnapshot;
  let releaseUserSnapshot;
  const userSnapshotStarted = new Promise((resolve) => { signalUserSnapshot = resolve; });
  const userSnapshotGate = new Promise((resolve) => { releaseUserSnapshot = resolve; });
  await resumed.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_get_snapshot') {
      snapshotCount += 1;
      if (snapshotCount === 2) {
        signalUserSnapshot();
        await userSnapshotGate;
      }
    }
    await route.continue();
  });
  await resumed.goto('/', { waitUntil: 'domcontentloaded' });
  await userSnapshotStarted;

  await expect(resumed.locator('#siteAccessGate')).toBeHidden();
  expect(await resumed.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
  expect(await resumed.evaluate(() => sessionStorage.getItem('monthly_v7_user_session'))).toBeNull();
  await expect(resumed.locator('#v5TopStatus')).not.toContainText('Owner A');

  releaseUserSnapshot();
  await expect.poll(() => resumed.evaluate(() => window.MonthlyV7App.currentUser()?.username || ''), {
    timeout: 30000
  }).toBe('owner');
  await expect(resumed.locator('#v5TopStatus')).toContainText('Owner A');
  const rotated = await resumed.evaluate(() => JSON.parse(localStorage.getItem('monthly_v7_user_resume_marker') || 'null'));
  expect(rotated.token).toMatch(/^[a-f0-9]{64}$/);
  expect(rotated.token).not.toBe(firstMarker.token);
  expect(rotated.trustedDeviceId).toBe(firstMarker.trustedDeviceId);

  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_issue_user_resume || 0)).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_exchange_user_resume || 0)).toBe(1);
  expect(state.activeUserResumeCount).toBe(1);
  expect(state.activeSiteResumeCount).toBe(1);

  await resumed.getByRole('button', { name: '登出', exact: true }).click();
  await expect(resumed.locator('#siteAccessGate')).toBeHidden();
  await expect(resumed.locator('#v5-login-username')).toBeVisible();
  expect(await resumed.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).toBeNull();
  expect(await resumed.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'))).not.toBeNull();
  const loggedOutState = await (await request.get('/__fake_state')).json();
  expect(loggedOutState.activeUserResumeCount).toBe(0);
  expect(loggedOutState.activeSiteResumeCount).toBe(1);
  await resumedContext.close();
});

for (const fixture of [
  {
    label: '永久失效',
    kind: 'invalid',
    expectedText: '帳號保持登入已失效',
    markerKept: false
  },
  {
    label: '交換逾時',
    kind: 'timeout',
    expectedText: '帳號自動登入暫時失敗',
    markerKept: true
  },
  {
    label: 'migration 缺失',
    kind: 'missing',
    expectedText: '帳號保持登入尚未啟用',
    markerKept: true
  }
]) {
  test(`user resume ${fixture.label}時保持 site 解鎖與手動登入，並依失敗類型處理 marker`, async ({ page, browser, request }) => {
    test.setTimeout(90000);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
    await page.locator('#site-remember-device').check();
    await page.locator('#site-access-password').fill('gate-pass');
    await page.getByRole('button', { name: '進入系統' }).click();
    await expect(page.locator('#siteAccessGate')).toBeHidden();
    await page.locator('#v5-remember-user').check();
    await page.locator('#v5-login-username').fill('owner');
    await page.locator('#v5-login-password').fill('owner-pass');
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await expect(page.locator('#v5TopStatus')).toContainText('Owner A');

    const storageState = await page.context().storageState();
    const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
    expect(origin).toBeTruthy();
    const resumedContext = await browser.newContext({ storageState: { cookies: [], origins: [origin] } });
    await resumedContext.addInitScript(() => {
      localStorage.setItem('monthly_v7_draft:module:user-resume-failure', JSON.stringify({
        payload: { title: 'user resume 失敗仍保留' }, baseRevision: 1
      }));
    });
    await resumedContext.route('**/__fake_rpc', async (route) => {
      const payload = route.request().postDataJSON();
      if (payload?.name !== 'monthly_v7_exchange_user_resume') return route.continue();
      if (fixture.kind === 'invalid') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'USER_RESUME_INVALID' })
        });
      }
      if (fixture.kind === 'timeout') {
        return route.fulfill({
          status: 504,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'RPC_TIMEOUT', message: 'RPC_TIMEOUT', details: '', hint: '' })
        });
      }
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST202',
          message: 'Could not find the function public.monthly_v7_exchange_user_resume'
        })
      });
    });
    const resumed = await resumedContext.newPage();
    await resumed.goto('/', { waitUntil: 'domcontentloaded' });

    await Promise.all([
      expect(resumed.locator('#siteAccessGate')).toBeHidden({ timeout: 30000 }),
      expect(resumed.locator('#v5TopStatus')).toContainText(fixture.expectedText, { timeout: 30000 })
    ]);
    await expect(resumed.locator('#v5-login-username')).toBeVisible();
    expect(await resumed.evaluate(() => window.MonthlyV7App.currentUser())).toBeNull();
    const local = await resumed.evaluate(() => ({
      marker: localStorage.getItem('monthly_v7_user_resume_marker'),
      siteMarker: localStorage.getItem('monthly_v7_site_resume_marker'),
      draft: localStorage.getItem('monthly_v7_draft:module:user-resume-failure'),
      userSession: sessionStorage.getItem('monthly_v7_user_session'),
      userProjection: sessionStorage.getItem('monthly_v7_user_projection')
    }));
    expect(Boolean(local.marker)).toBe(fixture.markerKept);
    expect(local.siteMarker).not.toBeNull();
    expect(JSON.parse(local.draft).payload.title).toBe('user resume 失敗仍保留');
    expect(local.userSession).toBeNull();
    expect(local.userProjection).toBeNull();
    await resumedContext.close();
  });
}

test('authority epoch 改變時在 exchange 前清除 site marker、保留證據並維持 Gate', async ({ page, browser, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  expect(origin).toBeTruthy();
  const resumedContext = await browser.newContext({ storageState: { cookies: [], origins: [origin] } });
  await resumedContext.addInitScript(() => {
    localStorage.setItem('monthly_v7_user_resume_marker', JSON.stringify({
      version: 1,
      purpose: 'user',
      token: '9'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorityEpoch: 2,
      trustedDeviceId: 'authority-epoch-old-device'
    }));
    localStorage.setItem('monthly_v7_draft:module:authority-epoch', JSON.stringify({
      payload: { title: 'authority 改變仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:authority-epoch', '{authority-epoch-pending-evidence');
  });
  await resumedContext.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_get_status') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        authority_state: 'NORMALIZED_ACTIVE',
        authority_epoch: 3,
        minimum_client_version: 7
      })
    });
  });
  const resumed = await resumedContext.newPage();
  await resumed.goto('/');

  await expect.poll(() => resumed.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(resumed.locator('#siteAccessGate')).toBeVisible();
  await expect(resumed.locator('#site-access-error')).toContainText('雲端權威版本已變更');
  const local = await resumed.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    userMarker: localStorage.getItem('monthly_v7_user_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    draft: localStorage.getItem('monthly_v7_draft:module:authority-epoch'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:authority-epoch')
  }));
  expect(local.marker).toBeNull();
  expect(local.userMarker).toBeNull();
  expect(local.site).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('authority 改變仍保留');
  expect(local.pending).toBe('{authority-epoch-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_exchange_site_resume || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
  await resumedContext.close();
});

test('缺少 site resume migration 時保留 marker 並允許手動密碼進站，不偽造自動恢復', async ({ page, request }) => {
  const marker = JSON.stringify({
    version: 1,
    purpose: 'site',
    token: 'e'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorityEpoch: 2
  });
  await page.addInitScript((value) => {
    localStorage.setItem('monthly_v7_site_resume_marker', value);
    localStorage.setItem('monthly_v7_draft:module:migration-missing', JSON.stringify({
      payload: { title: 'migration missing 仍保留' }, baseRevision: 1
    }));
  }, marker);
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_exchange_site_resume') return route.continue();
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'PGRST202',
        message: 'Could not find the function public.monthly_v7_exchange_site_resume'
      })
    });
  });

  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect(page.locator('#site-access-error')).toContainText('可信裝置恢復尚未啟用');
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'))).toBe(marker);
  expect(await page.evaluate(() => sessionStorage.getItem('monthly_v7_site_session'))).toBeNull();

  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('monthly_v7_draft:module:migration-missing'))).payload.title)
    .toBe('migration missing 仍保留');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_open_site || 0)).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
});

test('site marker exchange timeout 時保留原 marker 與恢復證據並回到手動 Gate', async ({ page, browser, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const firstMarker = await page.evaluate(() => JSON.parse(localStorage.getItem('monthly_v7_site_resume_marker') || 'null'));
  expect(firstMarker?.token).toMatch(/^[a-f0-9]{64}$/);
  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  expect(origin).toBeTruthy();

  const resumedContext = await browser.newContext({ storageState: { cookies: [], origins: [origin] } });
  await resumedContext.addInitScript(() => {
    window.MONTHLY_V7_RPC_TIMEOUT_MS = 75;
    localStorage.setItem('monthly_v7_draft:module:exchange-timeout', JSON.stringify({
      payload: { title: 'exchange timeout 仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:exchange-timeout', '{exchange-timeout-pending-evidence');
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_exchange_site_resume&count=1');
  const resumed = await resumedContext.newPage();
  await resumed.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => resumed.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(resumed.locator('#siteAccessGate')).toBeVisible();
  await expect(resumed.locator('#site-access-error')).toContainText('自動進站暫時失敗');
  const local = await resumed.evaluate(() => ({
    marker: JSON.parse(localStorage.getItem('monthly_v7_site_resume_marker') || 'null'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    draft: localStorage.getItem('monthly_v7_draft:module:exchange-timeout'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:exchange-timeout')
  }));
  expect(local.marker?.token).toBe(firstMarker.token);
  expect(local.site).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('exchange timeout 仍保留');
  expect(local.pending).toBe('{exchange-timeout-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
  expect(state.activeTrustedDeviceCount).toBe(1);
  expect(state.activeSiteResumeCount).toBe(1);
  await resumedContext.close();
});

test('server 明確拒絕已消耗的 site marker 時清 marker、保留證據並顯示精確原因', async ({ page, browser, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  expect(origin).toBeTruthy();
  const staleOrigin = JSON.parse(JSON.stringify(origin));

  const consumerContext = await browser.newContext({ storageState: { cookies: [], origins: [origin] } });
  const consumer = await consumerContext.newPage();
  await consumer.goto('/');
  await expect(consumer.locator('#siteAccessGate')).toBeHidden();
  await consumerContext.close();

  const rejectedContext = await browser.newContext({ storageState: { cookies: [], origins: [staleOrigin] } });
  await rejectedContext.addInitScript(() => {
    localStorage.setItem('monthly_v7_draft:module:server-reject', JSON.stringify({
      payload: { title: 'server 拒絕仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:server-reject', '{server-reject-pending-evidence');
  });
  const rejected = await rejectedContext.newPage();
  await rejected.goto('/');
  await expect.poll(() => rejected.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(rejected.locator('#siteAccessGate')).toBeVisible();
  await expect(rejected.locator('#site-access-error')).toContainText('此裝置的進站恢復已失效');
  const local = await rejected.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    draft: localStorage.getItem('monthly_v7_draft:module:server-reject'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:server-reject')
  }));
  expect(local.marker).toBeNull();
  expect(local.site).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('server 拒絕仍保留');
  expect(local.pending).toBe('{server-reject-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_exchange_site_resume || 0)).toBe(2);
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
  await rejectedContext.close();
});

test('退出網站會撤銷 trusted device 並回到 Gate，但保留 draft 與 pending', async ({ page, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect(page.locator('#v5-login-username')).toBeVisible();
  await page.locator('#v5-remember-user').check();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await page.evaluate(() => {
    localStorage.setItem('monthly_v7_draft:module:exit-site', JSON.stringify({
      payload: { title: '退出網站仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:exit-site', '{exit-site-pending-evidence');
  });
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'))).not.toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).not.toBeNull();

  await page.getByRole('button', { name: '退出網站', exact: true }).click();

  await expect(page.locator('#siteAccessGate')).toBeVisible();
  const local = await page.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    userMarker: localStorage.getItem('monthly_v7_user_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    user: sessionStorage.getItem('monthly_v7_user_session'),
    projection: sessionStorage.getItem('monthly_v7_user_projection'),
    draft: localStorage.getItem('monthly_v7_draft:module:exit-site'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:exit-site')
  }));
  expect(local.marker).toBeNull();
  expect(local.userMarker).toBeNull();
  expect(local.site).toBeNull();
  expect(local.user).toBeNull();
  expect(local.projection).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('退出網站仍保留');
  expect(local.pending).toBe('{exit-site-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(1);
  expect(state.activeSiteResumeCount).toBe(0);
  expect(state.activeUserResumeCount).toBe(0);
  expect(state.activeTrustedDeviceCount).toBe(0);
});

test('忘記此裝置走專用 RPC，不混用 full logout，並保留恢復證據', async ({ page, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await page.locator('#v5-remember-user').check();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await page.evaluate(() => {
    localStorage.setItem('monthly_v7_draft:module:forget-device', JSON.stringify({
      payload: { title: '忘記裝置仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:forget-device', '{forget-device-pending-evidence');
    renderV5SessionBar();
  });
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'))).not.toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).not.toBeNull();

  await page.getByRole('button', { name: '忘記此裝置', exact: true }).click();

  await expect(page.locator('#siteAccessGate')).toBeVisible();
  const local = await page.evaluate(() => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    userMarker: localStorage.getItem('monthly_v7_user_resume_marker'),
    site: sessionStorage.getItem('monthly_v7_site_session'),
    user: sessionStorage.getItem('monthly_v7_user_session'),
    projection: sessionStorage.getItem('monthly_v7_user_projection'),
    draft: localStorage.getItem('monthly_v7_draft:module:forget-device'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:forget-device')
  }));
  expect(local.marker).toBeNull();
  expect(local.userMarker).toBeNull();
  expect(local.site).toBeNull();
  expect(local.user).toBeNull();
  expect(local.projection).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('忘記裝置仍保留');
  expect(local.pending).toBe('{forget-device-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_forget_trusted_device || 0)).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(0);
  expect(state.activeTrustedDeviceCount).toBe(0);
  expect(state.activeSiteResumeCount).toBe(0);
  expect(state.activeUserResumeCount).toBe(0);
});

test('進站密碼 rotation 撤銷舊 trusted device、回到 Gate 並保留 recovery evidence', async ({ page, browser, request }) => {
  test.setTimeout(150000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await page.locator('#v5-remember-user').check();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await page.evaluate(() => {
    localStorage.setItem('monthly_v7_draft:module:rotate-site-password', JSON.stringify({
      payload: { title: '密碼 rotation 仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:rotate-site-password', '{rotate-site-password-pending-evidence');
    switchV1Tab('cloud');
  });
  await expect(page.locator('#site-access-new-password')).toBeVisible();
  const staleState = await page.context().storageState();
  const staleOrigin = staleState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  expect(staleOrigin).toBeTruthy();
  const oldMarker = await page.evaluate(() => localStorage.getItem('monthly_v7_site_resume_marker'));
  const oldUserMarker = await page.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'));
  expect(oldMarker).not.toBeNull();
  expect(oldUserMarker).not.toBeNull();

  const beforeShortPassword = await (await request.get('/__fake_state')).json();
  let shortPasswordMessage = '';
  page.once('dialog', async (dialog) => {
    shortPasswordMessage = dialog.message();
    await dialog.accept();
  });
  await page.locator('#site-access-new-password').fill('short77');
  await page.locator('#site-access-confirm-password').fill('short77');
  await page.getByRole('button', { name: /更新網站進入密碼/ }).click();
  await expect.poll(() => shortPasswordMessage).toContain('至少 8 個字元');
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  const afterShortPassword = await (await request.get('/__fake_state')).json();
  expect(Number(afterShortPassword.rpcCounts.monthly_v7_update_site_password || 0))
    .toBe(Number(beforeShortPassword.rpcCounts.monthly_v7_update_site_password || 0));

  let successMessage = '';
  page.once('dialog', async (dialog) => {
    successMessage = dialog.message();
    await dialog.accept();
  });
  await page.locator('#site-access-new-password').fill('rotated-gate-pass');
  await page.locator('#site-access-confirm-password').fill('rotated-gate-pass');
  await page.getByRole('button', { name: /更新網站進入密碼/ }).click();

  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect.poll(() => successMessage).toContain('網站進入密碼已更新');
  const local = await page.evaluate((secret) => {
    const entries = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        entries.push([key, storage.getItem(key)]);
      }
    }
    const serialized = JSON.stringify(entries);
    return {
      marker: localStorage.getItem('monthly_v7_site_resume_marker'),
      userMarker: localStorage.getItem('monthly_v7_user_resume_marker'),
      site: sessionStorage.getItem('monthly_v7_site_session'),
      user: sessionStorage.getItem('monthly_v7_user_session'),
      projection: sessionStorage.getItem('monthly_v7_user_projection'),
      draft: localStorage.getItem('monthly_v7_draft:module:rotate-site-password'),
      pending: localStorage.getItem('monthly_v7_pending:save_module:rotate-site-password'),
      sensitivePending: localStorage.getItem('monthly_v7_pending:update_site_password:workspace-test'),
      containsSecret: serialized.includes(secret) || serialized.includes('p_new_password')
    };
  }, 'rotated-gate-pass');
  expect(local.marker).toBeNull();
  expect(local.userMarker).toBeNull();
  expect(local.site).toBeNull();
  expect(local.user).toBeNull();
  expect(local.projection).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('密碼 rotation 仍保留');
  expect(local.pending).toBe('{rotate-site-password-pending-evidence');
  expect(local.sensitivePending).toBeNull();
  expect(local.containsSecret).toBe(false);

  const staleContext = await browser.newContext({ storageState: { cookies: [], origins: [staleOrigin] } });
  const stalePage = await staleContext.newPage();
  await stalePage.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => stalePage.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(stalePage.locator('#siteAccessGate')).toBeVisible();
  await expect(stalePage.locator('#site-access-error')).toContainText('此裝置的進站恢復已失效');
  expect(await stalePage.evaluate(() => localStorage.getItem('monthly_v7_user_resume_marker'))).toBeNull();
  await staleContext.close();

  await page.locator('#site-remember-device').uncheck();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await page.locator('#site-access-password').fill('rotated-gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_update_site_password || 0)).toBe(1);
  expect(state.activeTrustedDeviceCount).toBe(0);
  expect(state.activeSiteResumeCount).toBe(0);
  expect(state.activeUserResumeCount).toBe(0);
  expect(JSON.stringify(state)).not.toContain('rotated-gate-pass');
});

test('site resume 後 snapshot timeout 保留輪替 marker 與恢復證據且不撤銷 trusted device', async ({ page, browser, request }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-remember-device').check();
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();

  const firstMarker = await page.evaluate(() => JSON.parse(localStorage.getItem('monthly_v7_site_resume_marker') || 'null'));
  expect(firstMarker?.token).toMatch(/^[a-f0-9]{64}$/);
  const storageState = await page.context().storageState();
  const origin = storageState.origins.find((entry) => entry.origin === new URL(page.url()).origin);
  const resumedContext = await browser.newContext({
    storageState: { cookies: [], origins: origin ? [origin] : [] }
  });
  await resumedContext.addInitScript(() => {
    window.MONTHLY_V7_RPC_TIMEOUT_MS = 75;
    localStorage.setItem('monthly_v7_draft:module:timeout-draft', JSON.stringify({
      payload: { title: 'timeout 仍保留' }, baseRevision: 1
    }));
    localStorage.setItem('monthly_v7_pending:save_module:timeout-draft', '{timeout-pending-evidence');
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_get_snapshot&count=1');
  const resumed = await resumedContext.newPage();
  await resumed.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(resumed.locator('#siteAccessGate')).toBeVisible({ timeout: 5000 });
  await expect(resumed.locator('body')).toHaveClass(/site-access-locked/);
  await expect(resumed.locator('#site-access-error')).toContainText('雲端帳號資料讀取失敗');
  const local = await resumed.evaluate(() => ({
    marker: JSON.parse(localStorage.getItem('monthly_v7_site_resume_marker') || 'null'),
    siteSession: sessionStorage.getItem('monthly_v7_site_session'),
    draft: localStorage.getItem('monthly_v7_draft:module:timeout-draft'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:timeout-draft')
  }));
  expect(local.marker?.token).toMatch(/^[a-f0-9]{64}$/);
  expect(local.marker.token).not.toBe(firstMarker.token);
  expect(local.siteSession).toBeNull();
  expect(JSON.parse(local.draft).payload.title).toBe('timeout 仍保留');
  expect(local.pending).toBe('{timeout-pending-evidence');
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_exchange_site_resume || 0)).toBe(1);
  expect(Number(state.rpcCounts.monthly_v7_logout || 0)).toBe(0);
  expect(state.trustedDeviceCount).toBe(1);
  expect(state.activeSiteResumeCount).toBe(1);
  await resumedContext.close();
});

test('損壞或過期 site marker 只清除 marker，草稿與 pending 原封不動且零 resume/save RPC', async ({ page, request }) => {
  const draftKey = 'monthly_v7_draft:module:marker-draft';
  const pendingKey = 'monthly_v7_pending:save_module:marker-draft';
  const draft = JSON.stringify({ payload: { title: 'marker 失效仍保留' }, baseRevision: 1 });
  const pending = '{marker-pending-evidence';
  await page.addInitScript(({ draftKey, pendingKey, draft, pending }) => {
    localStorage.setItem('monthly_v7_site_resume_marker', '{broken-marker');
    localStorage.setItem(draftKey, draft);
    localStorage.setItem(pendingKey, pending);
  }, { draftKey, pendingKey, draft, pending });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  expect(await page.evaluate(({ draftKey, pendingKey }) => ({
    marker: localStorage.getItem('monthly_v7_site_resume_marker'),
    draft: localStorage.getItem(draftKey),
    pending: localStorage.getItem(pendingKey)
  }), { draftKey, pendingKey })).toEqual({ marker: null, draft, pending });
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_exchange_site_resume || 0)).toBe(0);
  expect(Number(state.rpcCounts.monthly_v7_save_module || 0)).toBe(0);
});

test('恢復的 V7 site session 必須等權威 snapshot 驗證後才解除 Gate，失效時保留草稿', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const guardKey = '__restored_site_session_first_boot_intercepted';
    if (sessionStorage.getItem(guardKey)) return;
    sessionStorage.setItem(guardKey, '1');
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => {
        capturedOnload = handler;
        window.__restoredSiteCapturedOnload = handler;
      }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__restoredSiteCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__restoredSiteCapturedOnload = null;
    await boot.call(window);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect.poll(() => page.evaluate(() => Array.isArray(window.MonthlyV7App?.client?.snapshot?.users))).toBe(true);
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  const originalSiteSession = await page.evaluate(() => sessionStorage.getItem('monthly_v7_site_session'));
  expect(originalSiteSession).toBeTruthy();

  let snapshotMode = 'delayed-success';
  let signalSnapshotStarted;
  let releaseSnapshot;
  let signalInvalidSnapshotStarted;
  let releaseInvalidSnapshot;
  const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const invalidSnapshotStarted = new Promise((resolve) => { signalInvalidSnapshotStarted = resolve; });
  const invalidSnapshotGate = new Promise((resolve) => { releaseInvalidSnapshot = resolve; });
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_get_snapshot') return route.continue();
    if (snapshotMode === 'delayed-success') {
      snapshotMode = 'pass';
      signalSnapshotStarted();
      await snapshotGate;
      await route.continue();
      return;
    }
    if (snapshotMode === 'delayed-invalid') {
      snapshotMode = 'done';
      signalInvalidSnapshotStarted();
      await invalidSnapshotGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'SITE_SESSION_INVALID' })
      });
      return;
    }
    await route.continue();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await snapshotStarted;
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  expect(await page.evaluate(() => window.MonthlyV7App?.currentUser?.())).toBeNull();
  releaseSnapshot();
  await expect.poll(() => page.evaluate(() => Array.isArray(window.MonthlyV7App?.client?.snapshot?.users))).toBe(true);
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('monthly_v7_site_session'))).toBe(originalSiteSession);

  const durableDraft = JSON.stringify({ payload: { id: 101, title: 'reload 保留草稿' }, baseRevision: 1 });
  await page.evaluate((value) => {
    localStorage.setItem('monthly_v7_draft:module:m1', value);
    const config = v4GetCloudConfig();
    localStorage.setItem(V4_CLOUD_CONFIG_KEY, JSON.stringify({ ...config, autoSyncOnOpen: false }));
  }, durableDraft);
  snapshotMode = 'delayed-invalid';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await invalidSnapshotStarted;
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  releaseInvalidSnapshot();
  await expect(page.locator('#siteAccessGate')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  await expect(page.locator('#site-access-error')).toContainText('雲端帳號資料讀取失敗');
  expect(await page.evaluate(() => sessionStorage.getItem('monthly_v7_site_session'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('monthly_v7_draft:module:m1'))).toBe(durableDraft);
});

test('權威帳號名冊等待與失敗期間禁止登入同步，logout 失敗仍回 Gate 並可重試', async ({ page, request }) => {
  let signalSnapshotStarted;
  let releaseSnapshot;
  const snapshotStarted = new Promise((resolve) => { signalSnapshotStarted = resolve; });
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  let interceptSnapshot = true;
  let interceptLogout = true;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_get_snapshot' && interceptSnapshot) {
      interceptSnapshot = false;
      signalSnapshotStarted();
      await snapshotGate;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SNAPSHOT_TEST_UNAVAILABLE', message: 'SNAPSHOT_TEST_UNAVAILABLE' })
      });
      return;
    }
    if (payload?.name === 'monthly_v7_logout' && interceptLogout) {
      interceptLogout = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'LOGOUT_TEST_UNAVAILABLE', message: 'LOGOUT_TEST_UNAVAILABLE' })
      });
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => {
        capturedOnload = handler;
        window.__rosterCapturedOnload = handler;
      }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__rosterCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__rosterCapturedOnload = null;
    await boot.call(window);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);

  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await snapshotStarted;
  await expect.poll(() => page.evaluate(() => {
    const root = document.getElementById('v5TopStatus');
    const controls = Array.from(root?.querySelectorAll('#v5-login-username, #v5-login-password, button') || []);
    return {
      text: String(root?.textContent || ''),
      controls: controls.map((element) => ({ text: String(element.textContent || '').trim(), disabled: element.disabled }))
    };
  }), { timeout: 5000 }).toMatchObject({
    text: expect.stringContaining('正在讀取雲端帳號'),
    controls: [
      { disabled: true },
      { disabled: true },
      { text: '登入', disabled: true },
      { text: expect.stringContaining('同步最新'), disabled: true },
      { text: '忘記此裝置', disabled: false },
      { text: '退出網站', disabled: false }
    ]
  });
  expect(await page.locator('#v5TopStatus').textContent()).not.toMatch(/尚未建立 owner|雲端未找到 Owner/);
  releaseSnapshot();

  await expect(page.locator('#siteAccessGate')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('body')).toHaveClass(/site-access-locked/);
  await expect(page.locator('#site-access-error')).toContainText('雲端帳號資料讀取失敗');
  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('body')).not.toHaveClass(/site-access-locked/);
  await expect(page.locator('#v5TopStatus')).toContainText('未登入');
  await expect(page.locator('#v5-login-username')).toBeEnabled();
  await expect(page.locator('#v5-login-password')).toBeEnabled();
  await expect(page.locator('#v5TopStatus')).not.toContainText(/尚未建立 owner|雲端未找到 Owner/);
  const state = await (await request.get('/__fake_state')).json();
  expect(state.rpcCounts.get_monthly_report_cloud_data || 0).toBe(0);
});

test('未登入純進站同步不得誤標月報編輯為本機草稿或要求登入提交', async ({ page, request }) => {
  await page.addInitScript(() => {
    let capturedOnload = null;
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => capturedOnload,
      set: (handler) => {
        capturedOnload = handler;
        window.__entryCapturedOnload = handler;
      }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const boot = window.__entryCapturedOnload;
    if (typeof boot !== 'function') throw new Error('PRODUCTION_ONLOAD_NOT_CAPTURED');
    window.onload = null;
    window.__entryCapturedOnload = null;
    await boot.call(window);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.MonthlyV7App?.initialized))).toBe(true);
  await page.evaluate(() => {
    window.__entryStatusHistory = [];
    window.__entrySaveHistory = [];
    window.__entryManualSaveHistory = [];
    window.__entryAutoSaveHistory = [];
    const originalStatus = window.v4SetCloudRuntimeStatus;
    window.v4SetCloudRuntimeStatus = (...args) => {
      window.__entryStatusHistory.push({
        text: String(args[0] || ''),
        kind: String(args[1] || ''),
        stack: String(new Error('ENTRY_STATUS').stack || '')
      });
      return originalStatus(...args);
    };
    const originalSave = window.saveToDB;
    window.saveToDB = async (...args) => {
      window.__entrySaveHistory.push({
        options: args[2] || {},
        applying: Boolean(window.V4_CLOUD_APPLYING),
        stack: String(new Error('ENTRY_SAVE').stack || '')
      });
      return originalSave(...args);
    };
    const originalManualSave = window.manualSave;
    window.manualSave = (...args) => {
      window.__entryManualSaveHistory.push({
        args,
        stack: String(new Error('ENTRY_MANUAL_SAVE').stack || '')
      });
      return originalManualSave(...args);
    };
    const originalTriggerAutoSave = window.triggerAutoSave;
    window.triggerAutoSave = (...args) => {
      window.__entryAutoSaveHistory.push({
        element: args[0]?.id || args[0]?.className || args[0]?.tagName || '',
        stack: String(new Error('ENTRY_AUTO_SAVE').stack || '')
      });
      return originalTriggerAutoSave(...args);
    };
  });

  await page.locator('#site-access-password').fill('gate-pass');
  await page.getByRole('button', { name: '進入系統' }).click();
  await expect(page.locator('#siteAccessGate')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const snapshotIds = (window.MonthlyV7App?.client?.snapshot?.modules || []).map((item) => String(item?.id || ''));
    const modelIds = Array.isArray(reportData) ? reportData.map((item) => String(item?._v7Id || '')) : [];
    const domIds = Array.from(document.querySelectorAll('#tableBody tr[data-v7-entity-id]'))
      .map((row) => String(row.dataset.v7EntityId || ''));
    return snapshotIds.length > 0
      && JSON.stringify(modelIds) === JSON.stringify(snapshotIds)
      && JSON.stringify(domIds) === JSON.stringify(snapshotIds);
  }), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__entryStatusHistory
    .some((entry) => /雲端資料已(?:載入|同步)/.test(entry.text))), { timeout: 10000 }).toBe(true);
  await page.waitForTimeout(1000);

  // 登入表單也不是月報內容；輸入帳密不得觸發月報 autosave。
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.waitForTimeout(1000);

  const browserState = await page.evaluate(() => ({
    currentUser: window.MonthlyV7App?.currentUser?.() || null,
    status: document.getElementById('v4-cloud-runtime-status')?.textContent || '',
    statusHistory: window.__entryStatusHistory,
    saveHistory: window.__entrySaveHistory,
    manualSaveHistory: window.__entryManualSaveHistory,
    autoSaveHistory: window.__entryAutoSaveHistory,
    draftKeys: Object.keys(localStorage).filter((key) => key.startsWith('monthly_v7_draft:')),
    pendingKeys: Object.keys(localStorage).filter((key) => key.startsWith('monthly_v7_pending:')),
    dirtyGeneration: window.V7_CLOUD_DIRTY_GENERATION,
    savedGeneration: window.V7_CLOUD_SAVED_GENERATION
  }));
  const fakeState = await (await request.get('/__fake_state')).json();

  expect(browserState.currentUser).toBeNull();
  expect(
    browserState.statusHistory.map((entry) => entry.text).join('\n'),
    JSON.stringify({
      statusHistory: browserState.statusHistory,
      saveHistory: browserState.saveHistory,
      manualSaveHistory: browserState.manualSaveHistory,
      autoSaveHistory: browserState.autoSaveHistory
    }, null, 2)
  ).not.toMatch(/月報編輯已保存為本機草稿|請登入後提交/);
  expect(browserState.status).not.toMatch(/月報編輯已保存為本機草稿|請登入後提交/);
  expect(browserState.draftKeys).toEqual([]);
  expect(browserState.pendingKeys).toEqual([]);
  expect(browserState.dirtyGeneration).toBe(browserState.savedGeneration);
  expect(fakeState.operations).toEqual([]);
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

test('成功登入只記住用戶名，登出後預填且永不保存密碼或權限資料', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.getByRole('button', { name: '登出', exact: true }).click();

  const remember = page.locator('#v5-remember-username');
  await expect(remember).toBeChecked();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');

  const stored = await page.evaluate(() => ({
    username: localStorage.getItem('monthly_report_remembered_username'),
    preference: localStorage.getItem('monthly_report_remember_username_enabled'),
    convenienceEntries: Object.keys(localStorage)
      .filter((key) => key.startsWith('monthly_report_remember'))
      .map((key) => [key, localStorage.getItem(key)])
  }));
  expect(stored.username).toBe('owner');
  expect(stored.preference).toBe('1');
  const serialized = JSON.stringify(stored.convenienceEntries);
  expect(serialized).not.toContain('owner-pass');
  expect(serialized).not.toContain('Owner A');
  expect(serialized).not.toContain('owner-id');
  expect(serialized).not.toMatch(/password|hash|role|session/i);

  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.locator('#v5-login-username')).toHaveValue('owner');
  await expect(page.locator('#v5-login-password')).toHaveValue('');

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#v5-login-username')).toHaveValue('owner');
  await expect(page.locator('#v5-login-password')).toHaveValue('');
});

test('失敗登入不改寫已記住用戶名，取消後成功登入也不保存且密碼保持空白', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('monthly_report_remembered_username'))).toBe('owner');

  await page.locator('#v5-login-username').fill('operator');
  await page.locator('#v5-login-password').fill('wrong-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem('monthly_report_remembered_username'))).toBe('owner');
  await expect(page.locator('#v5-login-password')).toHaveValue('');

  await page.locator('#v5-remember-username').uncheck();
  expect(await page.evaluate(() => ({
    preference: localStorage.getItem('monthly_report_remember_username_enabled'),
    username: localStorage.getItem('monthly_report_remembered_username')
  }))).toEqual({ preference: '0', username: null });
  await page.locator('#v5-login-username').fill('operator');
  await page.locator('#v5-login-password').fill('operator-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('#v5TopStatus')).toContainText('Operator B');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.locator('#v5-login-username')).toHaveValue('');
  await expect(page.locator('#v5-login-password')).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('monthly_report_remembered_username'))).toBeNull();

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#v5-login-username')).toHaveValue('');
  await expect(page.locator('#v5-login-password')).toHaveValue('');
  const storageText = await page.evaluate(() => JSON.stringify(Object.fromEntries(
    Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])
  )));
  expect(storageText).not.toContain('wrong-password');
  expect(storageText).not.toContain('operator-pass');
});

test('用戶名便利 storage 寫入失敗不得把已成功的雲端登入誤報為失敗', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await page.evaluate(() => {
    localStorage.removeItem('monthly_report_remembered_username');
    localStorage.removeItem('monthly_report_remember_username_enabled');
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (String(key).startsWith('monthly_report_remember')) {
        throw new DOMException('remember storage unavailable', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });

  await page.locator('#v5-login-username').fill('owner');
  await page.locator('#v5-login-password').fill('owner-pass');
  await page.getByRole('button', { name: '登入', exact: true }).click();

  await expect(page.locator('#v5TopStatus')).toContainText('Owner A');
  expect(await page.evaluate(() => ({
    currentUser: window.MonthlyV7App.currentUser()?.username || '',
    writeReady: window.MonthlyV7App.isWriteReady(),
    remembered: localStorage.getItem('monthly_report_remembered_username')
  }))).toEqual({ currentUser: 'owner', writeReady: true, remembered: null });
  expect(dialogs).toEqual([]);
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

test('半寬與所有插入元件的50%寬度控制統一為45%', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enterAndLogin(page, 'owner', 'owner-pass');

  const contract = await page.evaluate(() => {
    const selector = document.getElementById('insertLayoutSelector');
    const widths = (id) => Array.from(document.querySelectorAll(`#${id} button`))
      .map((button) => button.textContent.trim())
      .filter((label) => /^\d+%$/.test(label));
    const legacy = `
      <div class="content-block" style="width:48%;"><span class="kpi-marker" style="left:50%;">A</span></div>
      <span class="highlight-val" style="width:50%;">B</span>
      <img class="content-inline-img" style="width:48%;">
      <table class="custom-data-table" style="width:50%;"><tbody><tr><td>C</td></tr></tbody></table>
      <div class="kpi-card-container" style="width:50%;">D</div>
      <div class="progress-card-container" style="width:48%;">E</div>
      <div class="zone-card-container" style="width:50%;">F</div>
      <div class="trend-chart-container" style="width:48%;">G</div>
      <div class="unrelated-width" style="width:50%;">KEEP</div>`;
    const normalized = normalizeData([{ title: '舊半寬', columns: [legacy], colLayout: '1' }])[0].columns[0];
    const host = document.createElement('div');
    host.innerHTML = normalized;
    const insertedSelector = '.content-block, .highlight-val, .content-inline-img, .custom-data-table, .kpi-card-container, .progress-card-container, .zone-card-container, .trend-chart-container';
    return {
      options: Array.from(selector.options).map((option) => `${option.value}:${option.textContent.trim()}`),
      halfLayoutWidth: getInsertLayout('inline-45', { inlineWidth: '48%' }).width,
      toolbarWidths: {
        block: widths('blockFloatToolbar'),
        highlight: widths('highlightFloatToolbar'),
        image: widths('imgFloatToolbar'),
        table: widths('tableFloatToolbar')
      },
      normalizedWidths: Array.from(host.querySelectorAll(insertedSelector)).map((element) => element.style.width),
      unrelatedWidth: host.querySelector('.unrelated-width').style.width,
      kpiMarkerLeft: host.querySelector('.kpi-marker').style.left
    };
  });

  expect(contract.options).toContain('inline-45:半寬 45%');
  expect(contract.options.some((option) => /48%|inline-48/.test(option))).toBe(false);
  expect(contract.halfLayoutWidth).toBe('45%');
  for (const labels of Object.values(contract.toolbarWidths)) {
    expect(labels).toContain('45%');
    expect(labels).not.toContain('50%');
  }
  expect(contract.normalizedWidths).toEqual(Array(8).fill('45%'));
  expect(contract.unrelatedWidth).toBe('50%');
  expect(contract.kpiMarkerLeft).toBe('50%');

  await page.evaluate(() => {
    const fixture = document.createElement('div');
    fixture.id = 'half-width-control-fixture';
    fixture.style.cssText = 'position:fixed;left:20px;bottom:20px;width:1000px;z-index:40;background:#fff;padding:4px;';
    fixture.innerHTML = `
      <div id="fixture-block" class="content-block">區塊</div>
      <span id="fixture-highlight" class="highlight-val">數值</span>
      <img id="fixture-image" class="content-inline-img" alt="插圖" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <table id="fixture-table" class="custom-data-table"><tbody><tr><td>表格</td></tr></tbody></table>`;
    document.body.appendChild(fixture);
  });

  const cases = [
    ['#fixture-block', '#blockFloatToolbar'],
    ['#fixture-highlight', '#highlightFloatToolbar'],
    ['#fixture-image', '#imgFloatToolbar'],
    ['#fixture-table td', '#tableFloatToolbar']
  ];
  for (const [target, toolbar] of cases) {
    await page.locator(target).click();
    await expect(page.locator(toolbar)).toBeVisible();
    await page.locator(toolbar).getByRole('button', { name: '45%', exact: true }).click();
    const element = target.includes('table') ? page.locator('#fixture-table') : page.locator(target);
    await expect.poll(() => element.evaluate((node) => ({
      width: node.style.width,
      layout: node.dataset.layout,
      half: node.classList.contains('layout-half')
    }))).toEqual({ width: '45%', layout: 'inline', half: true });
  }

  const pairGeometry = await page.evaluate(() => {
    const fixture = document.getElementById('half-width-control-fixture');
    const first = document.getElementById('fixture-block');
    const second = document.getElementById('fixture-table');
    fixture.replaceChildren(first, second);
    const fixtureRect = fixture.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    return { fixtureRight: fixtureRect.right, secondRight: secondRect.right };
  });
  expect(pairGeometry.secondRight).toBeLessThanOrEqual(pairGeometry.fixtureRight + 1);
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
    const chartTableCell = root.querySelector('.chart-data-table td');
    const chartTableCellStyle = getComputedStyle(chartTableCell);
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
      chartTablePaddingTop: parseFloat(chartTableCellStyle.paddingTop),
      chartTablePaddingBottom: parseFloat(chartTableCellStyle.paddingBottom),
      chartTableRowHeight: chartTableCell.parentElement.getBoundingClientRect().height,
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
  expect(typography.chartTableCell).toBe(12);
  expect(typography.chartTablePaddingTop).toBe(1);
  expect(typography.chartTablePaddingBottom).toBe(1);
  expect(typography.chartTableRowHeight).toBeLessThanOrEqual(18);
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

test('螢幕趨勢表格外框貼合內容高度，不被右側 canvas 拉長', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installTrendPdfGeometryFixture(page);

  const geometry = await page.evaluate(async () => {
    const chart = document.querySelector('#tableBody .trend-chart-container');
    const table = chart.querySelector('.chart-data-table');
    Array.from(table.tBodies[0].rows).slice(0, 4).forEach((row) => row.remove());
    window.renderAllCharts();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const areaRect = chart.querySelector('.chart-table-area').getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const canvasRect = chart.querySelector('.chart-canvas-area').getBoundingClientRect();
    return {
      rowCount: table.tBodies[0].rows.length,
      areaHeight: areaRect.height,
      tableHeight: tableRect.height,
      trailingSpace: areaRect.height - tableRect.height,
      canvasHeight: canvasRect.height,
      areaBottom: areaRect.bottom,
      canvasBottom: canvasRect.bottom
    };
  });

  expect(geometry.rowCount).toBe(8);
  expect(geometry.canvasHeight).toBe(200);
  expect(geometry.tableHeight).toBeLessThan(geometry.canvasHeight - 20);
  expect(geometry.trailingSpace).toBeLessThanOrEqual(4.5);
  expect(geometry.areaBottom).toBeLessThan(geometry.canvasBottom - 20);
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
  expect(await page.evaluate(() => window.MonthlyV7App.client.lastOperationReceipt())).toMatchObject({
    state: 'CLOUD_CONFIRMED',
    rpcName: 'monthly_v7_save_report_meta',
    requestedOrigin: 'autosave',
    saveOrigin: 'autosave'
  });

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

test('主標題 blur 自動保存不會搶回下方內容焦點', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const row = page.locator('#tableBody tr').first();
  const mainTitle = page.locator('#mainTitle');
  const lowerEditor = row.locator('[data-col-index="0"]');

  // 先取得第一個項目的編輯權，重現截圖中已在編輯下方內容的狀態。
  await lowerEditor.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(lowerEditor).toHaveAttribute('contenteditable', 'true');

  await mainTitle.click();
  await expect(mainTitle).toBeFocused();
  await lowerEditor.click();
  await expect(lowerEditor).toBeFocused();

  // blur 自動保存包含 50ms 本機草稿排程與下一個 frame 的畫面恢復。
  await page.waitForTimeout(300);
  await expect(lowerEditor).toBeFocused();
  await expect(mainTitle).not.toBeFocused();
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
  expect(await page.evaluate(() => window.MonthlyV7App.client.lastOperationReceipt())).toMatchObject({
    state: 'CLOUD_CONFIRMED',
    requestedOrigin: 'manual',
    saveOrigin: 'manual'
  });

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
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveAttribute('contenteditable', 'true');
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

test('revision conflict 停止背景重送，重載後仍等待使用者確認才以目前內容重試', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 750;
  });
  const errors = [];
  let saveCalls = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module' || payload?.name === 'monthly_v7_save_module_batch') {
      saveCalls += 1;
    }
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await request.post('/__fake_remote_module_change');

  const moduleId = '22222222-2222-4222-8222-222222222221';
  let row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  let title = row.locator('td').nth(1).locator('.editable-div');
  await title.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await title.fill('本機待救回內容');
  await page.locator('#mainTitle').click();

  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('雲端有較新版本');
  await expect.poll(() => saveCalls).toBe(1);
  await page.waitForTimeout(1900);
  expect(saveCalls).toBe(1);
  const firstBlockedState = await page.evaluate(() => ({
    blocked: window.MonthlyV7App?.isRevisionConflictBlocked?.() === true,
    dirty: v7HasUnsyncedCloudChanges(),
    hasTimer: Boolean(V4_AUTO_SAVE_TIMER),
    hasPromise: Boolean(V7_CLOUD_SAVE_PROMISE),
    status: document.getElementById('v4-cloud-runtime-status')?.textContent || ''
  }));
  expect(firstBlockedState).toEqual({
    blocked: true,
    dirty: true,
    hasTimer: false,
    hasPromise: false,
    status: expect.stringMatching(/雲端有較新版本.*本機草稿已保留.*等待你選擇/)
  });
  let state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(2);
  expect(state.modules[0].payload.title).toBe('遠端較新內容');
  const savedDraft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`monthly_v7_draft:module:${id}`) || 'null'), moduleId);
  expect(savedDraft.payload.title.replace(/<br>$/i, '')).toBe('本機待救回內容');

  const saveCallsBeforeReload = saveCalls;
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
  await page.waitForTimeout(1900);
  expect(saveCalls).toBe(saveCallsBeforeReload);
  expect(await page.evaluate(() => ({
    blocked: window.MonthlyV7App?.isRevisionConflictBlocked?.() === true,
    states: Array.from(window.MonthlyV7App?.revisionConflictBlocks?.values?.() || [])
      .map((entry) => entry.state)
  }))).toEqual({ blocked: true, states: ['REVISION_CONFLICT_BLOCKED'] });
  await expect.poll(() => page.locator('#v4-cloud-runtime-status').textContent()).toMatch(/雲端有較新版本.*本機草稿已保留.*等待你選擇/);

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
  await page.waitForTimeout(1900);
  expect(saveCalls).toBe(saveCallsBeforeReload);
  expect(await page.evaluate(() => window.MonthlyV7App?.isRevisionConflictBlocked?.())).toBe(true);

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
  expect(saveCalls).toBe(saveCallsBeforeReload + 1);
  expect(await page.evaluate((id) => localStorage.getItem(`monthly_v7_draft:module:${id}`), moduleId)).toBeNull();
  await expect(page.locator('#v4-cloud-runtime-status')).toHaveText(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  expect(errors).toEqual([]);
});

test('report metadata conflict 停止背景重送，重載與取消後只在明確確認時提交', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 750;
  });
  const errors = [];
  let metaSaveCalls = 0;
  let metaReadCalls = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_report_meta') metaSaveCalls += 1;
    if (payload?.name === 'monthly_v7_get_entity'
      && payload?.params?.p_entity_type === 'report_meta') metaReadCalls += 1;
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await request.post('/__fake_remote_report_meta_change');

  const title = page.locator('#mainTitle');
  await title.click();
  await title.fill('本機待救回月報標題');
  await page.locator('#reportDate').click();

  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('雲端有較新版本');
  await expect.poll(() => metaSaveCalls).toBe(1);
  await page.waitForTimeout(1900);
  expect(metaSaveCalls).toBe(1);
  expect(await page.evaluate(() => ({
    blocked: window.MonthlyV7App?.isRevisionConflictBlocked?.('report_meta', window.MonthlyV7App?.client?.currentReport?.()?.id) === true,
    dirty: v7HasUnsyncedCloudChanges(),
    hasTimer: Boolean(V4_AUTO_SAVE_TIMER),
    draft: window.MonthlyV7App?.client?.readDraft?.(
      'report_meta', window.MonthlyV7App?.client?.currentReport?.()?.id
    )
  }))).toMatchObject({
    blocked: true,
    dirty: true,
    hasTimer: false,
    draft: { baseRevision: 1, payload: { title: '本機待救回月報標題' } }
  });
  let state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.report).toMatchObject({ revision: 2, title: '遠端較新月報標題' });
  const blockedReceipt = await page.evaluate(() => saveToDB(reportData, Date.now(), {
    markCloudDirty: false
  }));
  expect(blockedReceipt).toMatchObject({ localSaved: true, cloudSaved: false });
  expect(metaSaveCalls).toBe(1);

  const savesBeforeReload = metaSaveCalls;
  await page.reload();
  await expect(page.locator('#mainTitle')).toHaveText('本機待救回月報標題');
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App?.initialized === true
    && window.MonthlyV7App?.client?.currentReport?.()?._serverRevision === 2)).toBe(true);
  await page.waitForTimeout(1900);
  expect(metaSaveCalls).toBe(savesBeforeReload);
  expect(await page.evaluate(() => window.MonthlyV7App?.isRevisionConflictBlocked?.(
    'report_meta', window.MonthlyV7App?.client?.currentReport?.()?.id
  ))).toBe(true);
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText(/雲端有較新版本.*本機草稿已保留.*等待你選擇/);

  const readsBeforeResolution = metaReadCalls;
  let cancellationPrompt = '';
  page.once('dialog', async (dialog) => {
    cancellationPrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('已取消覆蓋');
  expect(metaReadCalls).toBe(readsBeforeResolution + 1);
  expect(metaSaveCalls).toBe(savesBeforeReload);
  state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.report).toMatchObject({ revision: 2, title: '遠端較新月報標題' });
  expect(await page.evaluate(() => window.MonthlyV7App?.isRevisionConflictBlocked?.(
    'report_meta', window.MonthlyV7App?.client?.currentReport?.()?.id
  ))).toBe(true);

  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(async () => request.get('/__fake_state').then((response) => response.json())
    .then((next) => next.report.revision)).toBe(3);
  state = await request.get('/__fake_state').then((response) => response.json());
  expect(state.report.title).toBe('本機待救回月報標題');
  expect(metaReadCalls).toBe(readsBeforeResolution + 2);
  expect(metaSaveCalls).toBe(savesBeforeReload + 1);
  expect(cancellationPrompt).toContain('目前畫面內容');
  expect(cancellationPrompt).toContain('取消');
  expect(confirmation).toBe(cancellationPrompt);
  expect(await page.evaluate(() => ({
    blocked: window.MonthlyV7App?.isRevisionConflictBlocked?.(),
    draft: window.MonthlyV7App?.client?.readDraft?.(
      'report_meta', window.MonthlyV7App?.client?.currentReport?.()?.id
    )
  }))).toEqual({ blocked: false, draft: null });
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

test('report metadata 未確認前不得提前顯示整份雲端成功，結果未知時維持 dirty 重試', async ({ page, request }) => {
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
  expect(result.finalStatus).toContain('保存結果尚未確認');
  expect(result.finalStatus).toContain('本機草稿');
  expect(result.finalStatus).not.toContain('保存失敗');
  expect(result.dirty).toBe(true);
  expect(result.actorPending).toBe(true);
  expect(result.draft).toContain('metadata 尚未確認的月報標題');
  expect(result.pending).toBeTruthy();
  expect(dialogs.some((message) => message.includes('RPC_TIMEOUT') && message.includes('結果尚未確認'))).toBe(true);
  expect(dialogs.some((message) => message.includes('保存失敗'))).toBe(false);
});

test('保存 RPC 無回應會結束等待並保留草稿，重試後可由新瀏覽器讀回雲端內容', async ({ page, request, browser }) => {
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

  await page.evaluate(() => {
    window.__timeoutSaveState = { status: 'pending', result: null, error: '' };
    window.__timeoutSavePromise = v5SaveChangesToCloud()
      .then((result) => {
        window.__timeoutSaveState = { status: 'done', result, error: '' };
      })
      .catch((error) => {
        window.__timeoutSaveState = {
          status: 'error', result: null, error: String(error?.message || error)
        };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__timeoutSaveState?.status), {
    timeout: 15000
  }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__timeoutSaveState)).toEqual({
    status: 'done', result: false, error: ''
  });
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
  const pendingOperationId = JSON.parse(localResidue.pending).operationId;

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
  const replayReceipt = await page.evaluate((operationId) => (
    window.MonthlyV7App.client.operationReceipts()
      .find((receipt) => receipt.operationId === operationId)
  ), pendingOperationId);
  expect(replayReceipt).toMatchObject({
    state: 'LEASE_LOST_BLOCKED',
    rpcName: 'monthly_v7_save_module',
    operationId: pendingOperationId,
    requestedOrigin: 'login-restore',
    saveOrigin: 'pending-replay',
    errorCode: 'LEASE_LOST'
  });
  const successorReceipt = await page.evaluate((oldOperationId) => (
    window.MonthlyV7App.client.operationReceipts().find((receipt) => (
      receipt.rpcName === 'monthly_v7_save_module'
      && receipt.operationId !== oldOperationId
      && receipt.requestedOrigin === 'login-restore'
      && receipt.state === 'CLOUD_CONFIRMED'
    ))
  ), pendingOperationId);
  expect(successorReceipt).toMatchObject({
    state: 'CLOUD_CONFIRMED',
    rpcName: 'monthly_v7_save_module',
    requestedOrigin: 'login-restore',
    saveOrigin: 'login-restore',
    errorCode: ''
  });
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

test('損壞 pending 進人工隔離後停止背景 autosave 且不刪除證據', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const pendingKey = 'monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221';
  const before = await (await request.get('/__fake_state')).json();
  const beforeSaveCount = Number(before.rpcCounts.monthly_v7_save_module || 0);

  await page.evaluate((key) => {
    localStorage.setItem(key, '{malformed-pending-evidence');
    reportData[0].title = '損壞 pending 下仍需保留的本機草稿';
    window.__malformedPendingSaveState = { status: 'pending', result: null, error: '' };
    window.__malformedPendingSavePromise = v4UploadToCloud({
      silent: true,
      reason: '每分鐘自動保存',
      flushLatest: false,
      saveOrigin: 'autosave'
    }).then((result) => {
      window.__malformedPendingSaveState = { status: 'done', result, error: '' };
    }).catch((error) => {
      window.__malformedPendingSaveState = {
        status: 'error', result: null, error: String(error?.code || error?.message || error)
      };
    });
  }, pendingKey);

  await expect.poll(() => page.evaluate(() => window.__malformedPendingSaveState?.status), {
    timeout: 15000
  }).toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__malformedPendingSaveState)).toEqual({
    status: 'done', result: false, error: ''
  });
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('待對帳操作');
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('人工');
  await expect(page.locator('#v4-cloud-runtime-status')).not.toContainText('保存失敗');
  expect(await page.evaluate(() => ({
    blocked: window.MonthlyV7App.isPendingRecoveryBlocked(),
    timer: Boolean(V4_AUTO_SAVE_TIMER),
    pending: localStorage.getItem('monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221')
  }))).toEqual({
    blocked: true,
    timer: false,
    pending: '{malformed-pending-evidence'
  });

  await page.waitForTimeout(1200);
  const after = await (await request.get('/__fake_state')).json();
  expect(Number(after.rpcCounts.monthly_v7_save_module || 0)).toBe(beforeSaveCount);
  expect(await page.evaluate(() => Boolean(V4_AUTO_SAVE_TIMER))).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBe('{malformed-pending-evidence');
});

test('active save 失去 lease 後保留唯讀草稿並停止背景重送', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const before = await (await request.get('/__fake_state')).json();
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      saveCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'LEASE_LOST' })
      });
      return;
    }
    await route.continue();
  });

  const row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  const editor = row.locator('.module-title-editor');
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('失去 lease 後必須保留的草稿');

  await expect.poll(() => saveCalls, { timeout: 15000 }).toBe(1);
  await expect.poll(() => page.evaluate((id) => window.MonthlyV7App.isWriteFailureBlocked('module', id), moduleId))
    .toBe(true);
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('編輯權已失效');
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('唯讀');
  expect(await page.evaluate(() => window.MonthlyV7App.client.lastOperationReceipt())).toMatchObject({
    state: 'LEASE_LOST_BLOCKED',
    rpcName: 'monthly_v7_save_module',
    requestedOrigin: 'autosave',
    saveOrigin: 'autosave',
    errorCode: 'LEASE_LOST'
  });
  expect(await page.evaluate((id) => ({
    timer: Boolean(V4_AUTO_SAVE_TIMER),
    draft: localStorage.getItem(`monthly_v7_draft:module:${id}`)
  }), moduleId)).toEqual({
    timer: false,
    draft: expect.stringContaining('失去 lease 後必須保留的草稿')
  });

  await page.waitForTimeout(1200);
  expect(saveCalls).toBe(1);
  expect(await page.evaluate(() => Boolean(V4_AUTO_SAVE_TIMER))).toBe(false);
  const after = await (await request.get('/__fake_state')).json();
  expect(after.modules[0].revision).toBe(before.modules[0].revision);
  expect(after.modules[0].payload.title).toBe(before.modules[0].payload.title);
});

for (const authorityCode of ['AUTHORITY_CHANGED', 'AUTHORITY_NOT_ACTIVE']) {
test(`${authorityCode} 後全頁停止寫入、不降級 legacy 並保留草稿`, async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      saveCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: authorityCode })
      });
      return;
    }
    await route.continue();
  });

  const editor = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('authority 變更時保留的草稿');

  await expect.poll(() => saveCalls, { timeout: 15000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.MonthlyV7App.isWriteFailureBlocked())).toBe(true);
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('authority 已變更');
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('不會降級舊版');
  expect(await page.evaluate(() => window.MonthlyV7App.client.lastOperationReceipt())).toMatchObject({
    state: 'AUTHORITY_CHANGED_BLOCKED',
    requestedOrigin: 'autosave',
    saveOrigin: 'autosave',
    errorCode: authorityCode
  });
  const second = await page.evaluate(() => v4UploadToCloud({
    silent: true,
    saveOrigin: 'autosave'
  }));
  expect(second).toBe(false);
  await page.waitForTimeout(1200);
  expect(saveCalls).toBe(1);
  expect(await page.evaluate(() => ({
    mode: window.MonthlyV7App.status.mode,
    timer: Boolean(V4_AUTO_SAVE_TIMER),
    draft: localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221')
  }))).toEqual({
    mode: 'v7',
    timer: false,
    draft: expect.stringContaining('authority 變更時保留的草稿')
  });
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.upsert_monthly_report_cloud_data || 0)).toBe(0);
  expect(Number(state.rpcCounts.get_monthly_report_cloud_data || 0)).toBe(0);
});
}

test('保存已提交但回覆遺失時，刷新後重播舊 operation 不重複增加 revision', async ({ page, request, browser }) => {
  const dialogs = [];
  let signalSaveCommitted;
  let releaseSaveAck;
  const saveCommitted = new Promise((resolve) => { signalSaveCommitted = resolve; });
  const saveAckGate = new Promise((resolve) => { releaseSaveAck = resolve; });
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      const response = await route.fetch();
      signalSaveCommitted();
      await saveAckGate;
      try { await route.fulfill({ response }); } catch {}
      return;
    }
    await route.continue();
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.MonthlyV7App.transport.requestTimeoutMs = 500;
    reportData[0].title = '已提交但回覆遺失的內容';
    renderTable();
    v1EnsureModuleFields();
  });
  await page.evaluate(() => {
    window.__lostAckSavePromise = v5SaveChangesToCloud();
  });
  await saveCommitted;
  await expect.poll(() => page.locator('#v5TopStatus').innerText()).toContain('RPC_TIMEOUT');
  releaseSaveAck();
  await page.evaluate(() => window.__lostAckSavePromise);
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

test('列印目前內容依勾選與 PDF 順序輸出，不帶版本提示，且不受雲端逾時或 pending 阻擋', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await expect(page.getByRole('button', { name: '列印目前內容' })).toBeVisible();
  await page.evaluate(() => {
    reportData[0].pdfOrder = 2;
    reportData[1].selectedForPdf = false;
    reportData.push({
      id: 103,
      icon: 'fas fa-edit',
      iconColor: '#64748b',
      title: 'C 選中項目',
      colLayout: '1',
      colCount: 1,
      columns: ['C 內容'],
      attachments: [],
      selectedForPdf: true,
      pdfOrder: 1
    });
    renderTable();
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    window.__currentDraftPrintCalls = 0;
    window.__currentDraftOriginalTitle = document.title;
    const exportDate = new Date();
    window.__currentDraftExpectedPrintTitle = `公司月度安全會議報告_${String(exportDate.getFullYear()).padStart(4, '0')}-${String(exportDate.getMonth() + 1).padStart(2, '0')}-${String(exportDate.getDate()).padStart(2, '0')}`;
    window.__currentDraftObservedPrintTitle = '';
    window.__currentDraftCloudWrites = [];
    window.print = () => {
      window.__currentDraftPrintCalls += 1;
      window.__currentDraftObservedPrintTitle = document.title;
    };
    const transport = window.MonthlyV7App.transport;
    const originalRpc = transport.rpc.bind(transport);
    transport.rpc = async (name, params) => {
      if (/^monthly_v7_(?:save|create_report_snapshot|delete|reorder)/.test(name)) {
        window.__currentDraftCloudWrites.push(name);
      }
      return originalRpc(name, params);
    };
  });
  const editor = page.locator('#tableBody .module-title-editor').first();
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('只在目前畫面的草稿標題');
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_module&count=always');
  const before = await (await request.get('/__fake_state')).json();

  await page.getByRole('button', { name: '列印目前內容' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__currentDraftPrintCalls)) + dialogs.length, {
    timeout: 15000
  }).toBeGreaterThan(0);

  expect(await page.evaluate(() => window.__currentDraftPrintCalls)).toBe(1);
  expect(await page.evaluate(() => window.__currentDraftObservedPrintTitle))
    .toBe(await page.evaluate(() => window.__currentDraftExpectedPrintTitle));
  expect(dialogs).toEqual([]);
  await expect(page.locator('body')).toHaveAttribute('data-print-source', 'current-draft');
  await expect(page.locator('#pdfPrintArea .module-card-row')).toHaveCount(2);
  expect(await page.locator('#pdfPrintArea .module-title-editor').allTextContents()).toEqual([
    'C 選中項目',
    '只在目前畫面的草稿標題'
  ]);
  await expect(page.locator('#pdfPrintArea')).not.toContainText('B 原始項目');
  await expect(page.locator('#pdfPrintArea')).not.toContainText('本機草稿');
  await expect(page.locator('#pdfPrintArea')).not.toContainText('非正式版');
  await expect(page.locator('#pdfPrintArea')).not.toContainText('草稿版');
  await expect(page.locator('#pdfPrintArea')).not.toContainText('不是正式版本');
  expect(await page.evaluate(() => window.__currentDraftCloudWrites)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem(
    'monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'
  ))).toContain('只在目前畫面的草稿標題');

  const after = await (await request.get('/__fake_state')).json();
  expect(after.modules[0].payload.title).toBe(before.modules[0].payload.title);
  expect(after.modules[0].revision).toBe(before.modules[0].revision);
  expect(after.operations).toEqual(before.operations);
  expect(after.snapshots).toEqual(before.snapshots);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  expect(await page.evaluate(() => document.title)).toBe(await page.evaluate(() => window.__currentDraftOriginalTitle));
});

test('列印目前內容沒有勾選模塊時提示並停止，不輸出空白文件', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    reportData.forEach((item) => { item.selectedForPdf = false; });
    renderTable();
    window.__emptySelectionPrintCalls = 0;
    window.__emptySelectionPrintState = { status: 'pending', error: '' };
    window.print = () => { window.__emptySelectionPrintCalls += 1; };
    window.__emptySelectionPrintPromise = printCurrentEditorReport()
      .then(() => { window.__emptySelectionPrintState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__emptySelectionPrintState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__emptySelectionPrintState?.status), { timeout: 15000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__emptySelectionPrintState)).toEqual({ status: 'done', error: '' });
  expect(await page.evaluate(() => window.__emptySelectionPrintCalls)).toBe(0);
  await expect(page.locator('#saveToast')).toContainText('請先勾選至少一個模塊');
  await expect(page.locator('#pdfPrintArea')).toBeEmpty();
});

test('保存 ACK 先清 pending、晚到的 production-shaped Realtime hint 仍不誤報遠端新版本', async ({ page, request }) => {
  const dialogs = [];
  let signalSaveCommitted;
  let releaseSaveAck;
  let signalChangesStarted;
  let releaseChanges;
  const saveCommitted = new Promise((resolve) => { signalSaveCommitted = resolve; });
  const saveAckGate = new Promise((resolve) => { releaseSaveAck = resolve; });
  const changesStarted = new Promise((resolve) => { signalChangesStarted = resolve; });
  const changesGate = new Promise((resolve) => { releaseChanges = resolve; });

  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module') {
      const response = await route.fetch();
      signalSaveCommitted();
      await saveAckGate;
      await route.fulfill({ response });
      return;
    }
    if (payload?.name === 'monthly_v7_get_changes_since') {
      const response = await route.fetch();
      signalChangesStarted();
      await changesGate;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    reportData[0].title = '自己的 Realtime 保存內容';
    renderTable();
    v1EnsureModuleFields();
    const status = document.getElementById('v4-cloud-runtime-status');
    window.__ownRealtimeStatusHistory = [String(status?.textContent || '')];
    window.__ownRealtimeStatusObserver = new MutationObserver(() => {
      window.__ownRealtimeStatusHistory.push(String(status?.textContent || ''));
    });
    window.__ownRealtimeStatusObserver.observe(status, { childList: true, subtree: true, characterData: true });
    window.__ownRealtimeSaveState = { status: 'pending', result: null };
    window.__ownRealtimeCatchUpState = { status: 'pending', error: '' };
    window.__ownRealtimeSavePromise = v5SaveChangesToCloud()
      .then((result) => { window.__ownRealtimeSaveState = { status: 'done', result }; })
      .catch((error) => {
        window.__ownRealtimeSaveState = { status: 'error', result: String(error?.message || error) };
      });
  });
  await saveCommitted;
  await expect.poll(async () => (await request.get('/__fake_state')).json().then((state) => state.modules[0].revision), {
    timeout: 5000
  }).toBe(2);

  await page.evaluate(() => {
    window.__ownRealtimeCatchUpPromise = window.MonthlyV7App.client.catchUp()
      .then(() => { window.__ownRealtimeCatchUpState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__ownRealtimeCatchUpState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await changesStarted;
  releaseSaveAck();
  await expect.poll(() => page.evaluate(() => window.__ownRealtimeSaveState.status), { timeout: 10000 }).toBe('done');
  expect(await page.evaluate(() => window.__ownRealtimeSaveState.result)).toBe(true);
  expect(await page.evaluate(() => window.MonthlyV7App.client.hasCurrentActorPendingOperation(
    'save_module:22222222-2222-4222-8222-222222222221'
  ))).toBe(false);

  releaseChanges();
  await expect.poll(() => page.evaluate(() => window.__ownRealtimeCatchUpState.status), { timeout: 10000 }).toBe('done');
  const statusResult = await page.evaluate(() => {
    window.__ownRealtimeStatusObserver?.disconnect();
    return {
      history: window.__ownRealtimeStatusHistory,
      finalStatus: document.getElementById('v4-cloud-runtime-status')?.textContent || ''
    };
  });
  expect(statusResult.history.some((value) => value.includes('正在編輯的項目有遠端新版本'))).toBe(false);
  expect(statusResult.finalStatus).toMatch(/雲端已保存｜\d{2}:\d{2}:\d{2}/);
  expect(dialogs).toEqual([]);
  const state = await (await request.get('/__fake_state')).json();
  expect(state.modules[0].revision).toBe(2);
  expect(state.modules[0].payload.title).toBe('自己的 Realtime 保存內容');
});

test('背景保存已在途時正式 PDF 只接續同一保存，不產生 REVISION_CONFLICT 或 LEASE_LOST', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 500;
  });
  const dialogs = [];
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
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const row = page.locator('#tableBody tr').first();
  const editor = row.locator('.module-title-editor');
  await editor.click();
  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('背景保存與正式 PDF 共用的內容');
  await expect.poll(() => saveCalls, { timeout: 10000 }).toBe(1);

  await page.evaluate(() => {
    window.__inFlightFormalPrintCalls = 0;
    window.print = () => { window.__inFlightFormalPrintCalls += 1; };
    window.__inFlightFormalState = { status: 'pending', error: '' };
    window.__inFlightFormalPromise = printV1SelectedPdf()
      .then(() => { window.__inFlightFormalState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__inFlightFormalState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await page.waitForTimeout(200);
  expect(saveCalls).toBe(1);
  releaseFirstSave();

  await expect.poll(() => page.evaluate(() => window.__inFlightFormalState.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  await expect.poll(async () => (await page.evaluate(() => window.__inFlightFormalPrintCalls)) + dialogs.length, {
    timeout: 30000
  }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__inFlightFormalPrintCalls)).toBe(1);
  expect(dialogs.some((message) => /REVISION_CONFLICT|LEASE_LOST|PENDING_DRAFTS_UNRESOLVED/.test(message))).toBe(false);
  expect(dialogs).toEqual([]);
  const state = await (await request.get('/__fake_state')).json();
  expect(state.modules[0].payload.title.replace(/<br>$/i, '')).toBe('背景保存與正式 PDF 共用的內容');
  expect(state.modules[0].revision).toBe(2);
  expect(state.snapshots).toHaveLength(1);
  expect(saveCalls).toBe(1);
  expect(await page.evaluate(() => window.MonthlyV7App.client.lastOperationReceipt())).toMatchObject({
    state: 'CLOUD_CONFIRMED',
    rpcName: 'monthly_v7_create_report_snapshot',
    requestedOrigin: 'formal-pdf',
    saveOrigin: 'formal-pdf'
  });
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

  await page.evaluate(() => printV1SelectedPdf());
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

  await page.evaluate(() => printV1SelectedPdf());
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

  await page.evaluate(() => printV1SelectedPdf());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__pdfLatePrintCalls)).toBe(0);
  expect(dialogs.some((message) => message.includes('PDF_CONTENT_CHANGED_AFTER_SAVE'))).toBe(true);
});

test('正式 PDF 鎖期間保留 module lease，列印解鎖後才釋放乾淨 lease', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const editor = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('正式 PDF 鎖期間保留 lease');
  await page.evaluate(() => {
    window.__formalLeasePrintCalls = 0;
    window.__formalLeaseSnapshotWaiting = false;
    window.__formalLeaseState = { status: 'pending', error: '' };
    window.print = () => { window.__formalLeasePrintCalls += 1; };
    let releaseSnapshot;
    const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
    window.__formalLeaseReleaseSnapshot = releaseSnapshot;
    const app = window.MonthlyV7App;
    const originalSnapshot = app.createReportSnapshot.bind(app);
    app.createReportSnapshot = async (kind) => {
      window.__formalLeaseSnapshotWaiting = true;
      await snapshotGate;
      return originalSnapshot(kind);
    };
    window.__formalLeasePromise = printV1SelectedPdf()
      .then(() => { window.__formalLeaseState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__formalLeaseState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__formalLeaseSnapshotWaiting), { timeout: 30000 }).toBe(true);
  await page.waitForTimeout(800);

  expect(await page.evaluate((id) => Boolean(window.MonthlyV7App.client.getLease('module', id)), moduleId)).toBe(true);
  const held = await (await request.get('/__fake_state')).json();
  const heldLease = held.leases.find((lease) => lease.key === `module:${moduleId}`);
  expect(heldLease).toBeTruthy();
  expect(heldLease.expiresAt).toBeGreaterThan(Date.now());
  await expect(page.locator('body')).toHaveAttribute('data-v7-formal-print-lock', 'true');

  await page.evaluate(() => window.__formalLeaseReleaseSnapshot());
  await expect.poll(() => page.evaluate(() => window.__formalLeasePrintCalls), { timeout: 30000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__formalLeaseState.status), { timeout: 30000 }).toBe('done');
  expect(dialogs).toEqual([]);
  await expect(page.locator('body')).not.toHaveAttribute('data-v7-formal-print-lock');
  await expect.poll(() => page.evaluate((id) => Boolean(window.MonthlyV7App.client.getLease('module', id)), moduleId), {
    timeout: 5000
  }).toBe(false);
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
    window.__formalLockPromise = printV1SelectedPdf()
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

test('趨勢圖即時 canvas 屬性不會在正式 PDF 保存後重建 PENDING_DRAFTS_UNRESOLVED', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installPdfColorFixture(page);
  await page.evaluate(() => window.renderAllCharts());
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('#tableBody canvas.trend-canvas');
    return Boolean(canvas && canvas.getAttribute('data-chart-id') && canvas.hasAttribute('width') && canvas.hasAttribute('style'));
  })).toBe(true);
  await page.evaluate(() => {
    window.__chartFormalPdfPrintCalls = 0;
    window.print = () => { window.__chartFormalPdfPrintCalls += 1; };
    window.__chartFormalPdfState = { status: 'pending', error: '' };
    window.__chartFormalPdfPromise = printV1SelectedPdf()
      .then(() => { window.__chartFormalPdfState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__chartFormalPdfState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__chartFormalPdfState.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  await expect.poll(async () => (await page.evaluate(() => window.__chartFormalPdfPrintCalls)) + dialogs.length, {
    timeout: 30000
  }).toBeGreaterThan(0);

  expect(await page.evaluate(() => window.__chartFormalPdfPrintCalls)).toBe(1);
  expect(dialogs.some((message) => message.includes('PENDING_DRAFTS_UNRESOLVED'))).toBe(false);
  expect(dialogs).toEqual([]);
  const residue = await page.evaluate(() => ({
    draft: localStorage.getItem('monthly_v7_draft:module:22222222-2222-4222-8222-222222222221'),
    pending: localStorage.getItem('monthly_v7_pending:save_module:22222222-2222-4222-8222-222222222221')
  }));
  expect(residue).toEqual({ draft: null, pending: null });
  const server = await (await request.get('/__fake_state')).json();
  expect(server.snapshots).toHaveLength(1);
  expect(server.snapshots[0].modules[0].payload.columns[0]).not.toContain('data-chart-id');
});

test('新建項目後正式 PDF 以 payload 可見 id 比對，不誤判 STALE_SNAPSHOT_AFTER_SAVE', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    window.__createdModulePdfPrintCalls = 0;
    window.print = () => { window.__createdModulePdfPrintCalls += 1; };
  });

  await page.getByRole('button', { name: '+ 新增會議項目' }).click();
  await expect(page.locator('#tableBody tr')).toHaveCount(3);
  await expect.poll(async () => {
    const state = await (await request.get('/__fake_state')).json();
    return state.modules.length;
  }).toBe(3);
  const before = await (await request.get('/__fake_state')).json();
  const created = before.modules.at(-1);
  expect(created.legacyItemId).toMatch(/^v7:/);
  expect(String(created.payload.id)).not.toBe(created.legacyItemId);

  await page.evaluate(() => {
    window.__createdModulePdfState = { status: 'pending', error: '' };
    window.__createdModulePdfPromise = printV1SelectedPdf()
      .then(() => { window.__createdModulePdfState = { status: 'done', error: '' }; })
      .catch((error) => {
        window.__createdModulePdfState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__createdModulePdfState.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  await expect.poll(async () => (await page.evaluate(() => window.__createdModulePdfPrintCalls)) + dialogs.length, {
    timeout: 30000
  }).toBeGreaterThan(0);

  expect(await page.evaluate(() => window.__createdModulePdfPrintCalls)).toBe(1);
  expect(dialogs.some((message) => message.includes('STALE_SNAPSHOT_AFTER_SAVE'))).toBe(false);
  expect(dialogs).toEqual([]);
  const after = await (await request.get('/__fake_state')).json();
  expect(after.snapshots).toHaveLength(1);
  expect(after.snapshots[0].modules.at(-1).payload.id).toBe(created.payload.id);
});

test('正式 PDF snapshot RPC timeout 標示 create_snapshot 階段與確切 RPC', async ({ page }) => {
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
        const error = new Error('RPC_TIMEOUT');
        error.code = 'RPC_TIMEOUT';
        error.operation = name;
        error.rpcName = name;
        error.elapsedMs = 37;
        throw error;
      }
      return originalRpc(name, params);
    };
    window.__v7PrintCalled = false;
    window.print = () => { window.__v7PrintCalled = true; };
  });

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

test('PDF輸出提供85至100比例，預設95並套用緊湊分頁', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    switchV1Tab('pdf');
    renderV1PdfCenter();
  });

  const scale = page.locator('#v1-pdf-print-scale');
  const compact = page.locator('#v1-pdf-compact-pagination');
  await expect(scale).toHaveValue('95');
  expect(await scale.locator('option').evaluateAll((options) => options.map((option) => option.value)))
    .toEqual(['85', '90', '95', '100']);
  await expect(compact).toBeChecked();

  await scale.selectOption('85');
  await expect(compact).toBeChecked();
  expect(await page.evaluate(() => v1GetPdfPrintSettings())).toEqual({ scalePercent: 85, compact: true });

  await page.evaluate(() => {
    window.__pdfScalePrepareState = { status: 'pending', error: '' };
    window.__pdfScalePreparePromise = prepareV1PdfPrintArea().then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      window.__pdfScalePrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__pdfScalePrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__pdfScalePrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__pdfScalePrepareState)).toEqual({ status: 'done', error: '' });

  const applied = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    const clone = area.querySelector('.v1-selected-editor-print-clone');
    return {
      scale: area.dataset.pdfPrintScale,
      compact: area.dataset.pdfCompactPagination,
      zoom: parseFloat(getComputedStyle(clone).zoom),
      areaWidth: area.getBoundingClientRect().width,
      cloneWidth: clone.getBoundingClientRect().width
    };
  });
  expect(applied.scale).toBe('85');
  expect(applied.compact).toBe('true');
  expect(applied.zoom).toBeCloseTo(0.85, 2);
  expect(Math.abs((applied.cloneWidth * applied.zoom) - (applied.areaWidth * applied.zoom))).toBeLessThanOrEqual(2);
});

test('PDF匯出名稱使用公司月度安全會議報告與匯出當日日期，列印後恢復頁面標題', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const state = await page.evaluate(() => {
    const originalTitle = document.title;
    const originalPrint = window.print;
    let observedTitle = '';
    window.print = () => { observedTitle = document.title; };
    const exportTitle = v1PrintWithExportTitle(new Date(2026, 7, 16, 23, 30, 0));
    const titleBeforeAfterPrint = document.title;
    window.dispatchEvent(new Event('afterprint'));
    const restoredTitle = document.title;
    window.print = originalPrint;
    return { originalTitle, exportTitle, observedTitle, titleBeforeAfterPrint, restoredTitle };
  });

  expect(state.exportTitle).toBe('公司月度安全會議報告_2026-08-16');
  expect(state.observedTitle).toBe(state.exportTitle);
  expect(state.titleBeforeAfterPrint).toBe(state.exportTitle);
  expect(state.restoredTitle).toBe(state.originalTitle);
});

test('PDF準備等待大型內嵌圖片完成解碼後才量測分頁', async ({ page }) => {
  await page.route('**/__slow_pdf_fixture.svg', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#0f766e"/><text x="80" y="160" font-size="92" fill="white">SLOW PDF IMAGE</text></svg>'
    });
  });
  await enterAndLogin(page, 'owner', 'owner-pass');

  const state = await page.evaluate(async () => {
    const item = JSON.parse(JSON.stringify(reportData[0]));
    item.id = 7101;
    item._v7Id = 'pdf-slow-image-fixture';
    item.title = '大型內嵌圖片等待解碼';
    item.columns = ['<img src="/__slow_pdf_fixture.svg" class="content-inline-img layout-inline layout-half" data-layout="inline" style="width:45%;margin:0 6px 6px 0;display:inline-block;vertical-align:top;box-sizing:border-box">'];
    item.colLayout = '1';
    item.selectedForPdf = true;
    item.pdfOrder = 1;
    reportData = [item];
    renderTable();
    v1EnsureModuleFields();
    const ok = await prepareV1PdfPrintArea({ selectAll: true });
    const image = document.querySelector('#pdfPrintArea img.content-inline-img');
    return {
      ok,
      complete: Boolean(image?.complete),
      naturalWidth: Number(image?.naturalWidth || 0),
      naturalHeight: Number(image?.naturalHeight || 0)
    };
  });

  expect(state).toEqual({ ok: true, complete: true, naturalWidth: 1600, naturalHeight: 900 });
});

test('PDF並排內嵌截圖由正常flow row承載並整列避開頁尾', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const originals = reportData.map((item) => JSON.parse(JSON.stringify(item)));
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 1600;
    const context = canvas.getContext('2d');
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, 3000, 1600);
    for (let y = 80; y < 1520; y += 120) {
      context.fillStyle = y % 240 === 80 ? '#e0f2fe' : '#ede9fe';
      context.fillRect(80, y, 2840, 82);
    }
    const imageSrc = canvas.toDataURL('image/png');
    const first = originals[0];
    first.id = 7201;
    first._v7Id = 'pdf-inline-image-flow-fixture';
    first.title = '含並排寬幅截圖的頁尾模塊';
    first.columns = [`<div class="content-block blue-block" style="height:180px"><div class="block-title">前段內容</div><div class="block-body">此段先佔用模塊高度，模擬真實月報在截圖前還有說明與表格。</div></div><div class="block-spacer"><br></div><div class="content-block purple-block layout-inline layout-half" data-layout="inline" style="width:45%;height:245px;margin:0 6px 6px 0;display:inline-block;vertical-align:top;box-sizing:border-box"><div class="block-title">重點內容</div><div class="block-body">此卡片與右側截圖必須由同一個正常列印flow row承載。</div></div>&nbsp;<img src="${imageSrc}" class="content-inline-img layout-inline layout-half" data-layout="inline" style="width:45%;margin:0 6px 6px 0;display:inline-block;vertical-align:top;box-sizing:border-box">`];
    first.colLayout = '1';
    first.selectedForPdf = true;
    first.pdfOrder = 1;
    const second = originals[1] || JSON.parse(JSON.stringify(first));
    second.id = 7202;
    second._v7Id = 'pdf-module-after-inline-image';
    second.title = '圖片後方不得被覆蓋的下一模塊';
    second.columns = ['<div class="content-block blue-block" style="height:90px">NEXT MODULE MUST REMAIN CLEAR</div>'];
    second.colLayout = '1';
    second.selectedForPdf = true;
    second.pdfOrder = 2;
    reportData = [first, second];
    document.querySelector('.report-header-section').style.height = '520px';
    renderTable();
    v1EnsureModuleFields();
    v1SavePdfPrintSettings({ scalePercent: 95, compact: true });
  });

  await page.evaluate(() => {
    window.__inlineImagePdfPrepareState = { status: 'pending', error: '' };
    window.__inlineImagePdfPreparePromise = prepareV1PdfPrintArea({ selectAll: true }).then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__inlineImagePdfPrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__inlineImagePdfPrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__inlineImagePdfPrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__inlineImagePdfPrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const layout = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const area = document.getElementById('pdfPrintArea');
    const rows = Array.from(area.querySelectorAll('.module-card-row'));
    const first = rows[0];
    const next = rows[1];
    const image = first.querySelector('img.content-inline-img');
    const flow = image?.closest('.pdf-inline-layout-row');
    const box = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null;
    };
    return {
      hasFlowRow: Boolean(flow),
      flowChildren: flow ? flow.querySelectorAll(':scope > .layout-inline, :scope > [data-layout="inline"]').length : 0,
      flowDisplay: flow ? getComputedStyle(flow).display : '',
      flowBreakInside: flow ? getComputedStyle(flow).breakInside : '',
      imagePosition: image ? getComputedStyle(image).position : '',
      imageFloat: image ? getComputedStyle(image).float : '',
      flow: box(flow),
      image: box(image),
      first: box(first),
      next: box(next),
      rowTag: first?.tagName || '',
      nativeTableRows: area.querySelectorAll('tr.module-card-row').length,
      keepTogether: first.classList.contains('pdf-keep-together'),
      compactSplit: first.classList.contains('pdf-compact-split'),
      breakInside: getComputedStyle(first).breakInside
    };
  });

  const pdfPath = testInfo.outputPath('inline-image-flow-no-overlap.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('inline-image-flow-no-overlap.pdf', { body: pdf, contentType: 'application/pdf' });

  expect(layout.hasFlowRow).toBe(true);
  expect(layout.flowChildren).toBe(2);
  expect(layout.flowDisplay).toBe('flex');
  expect(layout.flowBreakInside).toBe('avoid');
  expect(layout.imagePosition).toBe('static');
  expect(layout.imageFloat).toBe('none');
  expect(layout.flow.height).toBeGreaterThanOrEqual(layout.image.height - 1);
  expect(layout.rowTag).toBe('SECTION');
  expect(layout.nativeTableRows).toBe(0);
  expect(layout.keepTogether).toBe(true);
  expect(layout.compactSplit).toBe(false);
  expect(layout.breakInside).toBe('avoid');
  expect(layout.first.bottom).toBeLessThanOrEqual(layout.next.top + 1);
});

test('PDF雙欄block圖片模塊改用中立容器避免tr grid分頁重疊', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const items = reportData.map((item) => JSON.parse(JSON.stringify(item)));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1687" height="560"><rect width="1687" height="560" fill="#0f172a"/><rect x="60" y="80" width="1560" height="120" fill="#bae6fd"/></svg>';
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const first = items[0];
    first.title = '雙欄block圖片頁尾模塊';
    first.columns = [
      `<div class="content-block red-block" style="height:130px">前段說明</div><div class="block-spacer"><br></div><img src="${src}" class="content-inline-img layout-block" data-layout="block" style="width:100%;margin:0 0 6px;display:block;vertical-align:top;box-sizing:border-box">`,
      '<div class="content-block purple-block" style="height:180px">右欄內容</div>'
    ];
    first.colLayout = '1:1';
    first.selectedForPdf = true;
    first.pdfOrder = 1;
    const second = items[1];
    second.title = 'BLOCK IMAGE後方模塊';
    second.columns = ['<div style="height:80px">NEXT MODULE</div>'];
    second.colLayout = '1';
    second.selectedForPdf = true;
    second.pdfOrder = 2;
    reportData = [first, second];
    document.querySelector('.report-header-section').style.height = '500px';
    renderTable();
    v1EnsureModuleFields();
    v1SavePdfPrintSettings({ scalePercent: 95, compact: true });
  });
  await page.evaluate(() => {
    window.__blockImagePdfState = { status: 'pending', error: '' };
    prepareV1PdfPrintArea({ selectAll: true }).then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__blockImagePdfState = { status: 'done', error: '' };
    }).catch((error) => { window.__blockImagePdfState = { status: 'error', error: String(error?.message || error) }; });
  });
  await expect.poll(() => page.evaluate(() => window.__blockImagePdfState?.status), { timeout: 30000 }).toBe('done');
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const state = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    const row = area.querySelector('.module-card-row');
    return {
      pageHeight: Number(area.dataset.pdfPageContentHeight || 0),
      remaining: Number(area.dataset.pdfFirstPageRemaining || 0),
      height: Number(row.dataset.pdfModuleHeight || 0),
      rowTag: row?.tagName || '',
      nativeTableRows: area.querySelectorAll('tr.module-card-row').length,
      blockImage: Boolean(row.querySelector('img.content-inline-img.layout-block:not(.pdf-inline-layout-row img)')),
      keepTogether: row.classList.contains('pdf-keep-together'),
      compactSplit: row.classList.contains('pdf-compact-split'),
      breakInside: getComputedStyle(row).breakInside
    };
  });
  const pdfPath = testInfo.outputPath('compact-block-image-no-overlap.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('compact-block-image-no-overlap.pdf', { body: pdf, contentType: 'application/pdf' });
  expect(state.height).toBeGreaterThan(state.remaining);
  expect(state.height).toBeLessThanOrEqual(state.pageHeight);
  expect(state.blockImage).toBe(true);
  expect(state.rowTag).toBe('SECTION');
  expect(state.nativeTableRows).toBe(0);
  expect(state.keepTogether).toBe(true);
  expect(state.compactSplit).toBe(false);
  expect(state.breakInside).toBe('avoid');
});

test('接近頁尾的趨勢圖模塊整體移頁，canvas留在卡片內且不壓到下一模塊', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await installTrendPdfGeometryFixture(page);
  await page.evaluate(() => {
    const header = document.querySelector('.report-header-section');
    header.style.height = '520px';
    reportData[1].title = 'NEXT-MODULE-AFTER-TREND';
    reportData[1].columns = ['<div style="height:80px">NEXT-MODULE-CONTENT</div>'];
    reportData[1].selectedForPdf = true;
    reportData[1].pdfOrder = 2;
    renderTable();
    v1EnsureModuleFields();
  });

  await page.evaluate(() => {
    window.__nearPageTrendPrepareState = { status: 'pending', error: '' };
    window.__nearPageTrendPreparePromise = prepareV1PdfPrintArea().then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__nearPageTrendPrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__nearPageTrendPrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__nearPageTrendPrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__nearPageTrendPrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const geometry = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const area = document.getElementById('pdfPrintArea');
    const rows = Array.from(area.querySelectorAll('.module-card-row'));
    const trendRow = rows[0];
    const nextRow = rows[1];
    const areaRect = area.getBoundingClientRect();
    const trendRowRect = trendRow.getBoundingClientRect();
    const nextRowRect = nextRow.getBoundingClientRect();
    const charts = Array.from(trendRow.querySelectorAll('.trend-chart-container')).map((chart) => {
      const card = chart.getBoundingClientRect();
      const canvasArea = chart.querySelector('.chart-canvas-area').getBoundingClientRect();
      return {
        cardBottom: card.bottom,
        canvasBottom: canvasArea.bottom,
        cardRight: card.right,
        canvasRight: canvasArea.right
      };
    });
    return {
      pageContentHeight: Number(area.dataset.pdfPageContentHeight || 0),
      firstPageRemaining: Number(area.dataset.pdfFirstPageRemaining || 0),
      moduleHeight: Number(trendRow.dataset.pdfModuleHeight || 0),
      keepTogether: trendRow.classList.contains('pdf-keep-together'),
      hasTrend: trendRow.classList.contains('pdf-has-trend-chart'),
      pageRight: areaRect.right,
      rowRight: trendRowRect.right,
      rowBottom: trendRowRect.bottom,
      nextTop: nextRowRect.top,
      charts
    };
  });

  expect(geometry.moduleHeight).toBeGreaterThan(geometry.firstPageRemaining);
  expect(geometry.moduleHeight).toBeLessThanOrEqual(geometry.pageContentHeight);
  expect(geometry.hasTrend).toBe(true);
  expect(geometry.keepTogether).toBe(true);
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.pageRight + 1);
  for (const chart of geometry.charts) {
    expect(chart.canvasBottom).toBeLessThanOrEqual(chart.cardBottom + 1);
    expect(chart.canvasRight).toBeLessThanOrEqual(chart.cardRight + 1);
    expect(chart.cardRight).toBeLessThanOrEqual(geometry.pageRight + 1);
  }
  expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.nextTop + 1);

  const pdfPath = testInfo.outputPath('near-page-trend-no-overlap.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('near-page-trend-no-overlap.pdf', { body: pdf, contentType: 'application/pdf' });
});

test('95%緊湊分頁只拆安全的非趨勢模塊，減少整塊跳頁空白', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const originals = reportData.map((item) => JSON.parse(JSON.stringify(item)));
    reportData = Array.from({ length: 4 }, (_, index) => {
      const item = JSON.parse(JSON.stringify(originals[index % originals.length]));
      item.id = 2100 + index;
      item._v7Id = `compact-fixture-${index + 1}`;
      item.title = `緊湊分頁模塊-${index + 1}`;
      item.columns = [`<div class="content-block compact-page-segment" style="height:125px">緊湊內容 ${index + 1}-A</div><div class="content-block compact-page-segment" style="height:125px">緊湊內容 ${index + 1}-B</div>`];
      item.colLayout = '1';
      item.selectedForPdf = true;
      item.pdfOrder = index + 1;
      return item;
    });
    document.querySelector('.report-header-section').style.height = '120px';
    renderTable();
    v1EnsureModuleFields();
  });

  await page.evaluate(() => {
    window.__compactPaginationPrepareState = { status: 'pending', error: '' };
    window.__compactPaginationPreparePromise = prepareV1PdfPrintArea().then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__compactPaginationPrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__compactPaginationPrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__compactPaginationPrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__compactPaginationPrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const compactState = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    return {
      scale: area.dataset.pdfPrintScale,
      compact: area.dataset.pdfCompactPagination,
      unused: Number(area.dataset.pdfEstimatedUnusedHeight || 0),
      rows: Array.from(area.querySelectorAll('.module-card-row')).map((row) => ({
        trend: row.classList.contains('pdf-has-trend-chart'),
        keepTogether: row.classList.contains('pdf-keep-together'),
        compactSplit: row.classList.contains('pdf-compact-split'),
        breakInside: getComputedStyle(row).breakInside
      }))
    };
  });
  const compactPdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });

  const standardUnused = await page.evaluate(async () => {
    document.body.classList.add('pdf-render-prep', 'pdf-print-mode');
    const area = document.getElementById('pdfPrintArea');
    area.dataset.pdfCompactPagination = 'false';
    classifyV1PdfModulePageBreaks(area);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Number(area.dataset.pdfEstimatedUnusedHeight || 0);
  });
  const standardPdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const countPages = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  const compactPages = countPages(compactPdf);
  const standardPages = countPages(standardPdf);

  expect(compactState.scale).toBe('95');
  expect(compactState.compact).toBe('true');
  expect(compactState.rows.every((row) => row.trend === false)).toBe(true);
  expect(compactState.rows.some((row) => row.compactSplit && !row.keepTogether && row.breakInside === 'auto')).toBe(true);
  expect(compactState.unused).toBeLessThan(standardUnused);
  expect(compactPages).toBeLessThanOrEqual(standardPages);
});

test('PDF 卡片保留螢幕主要視覺比例，只移除編輯控制並配合紙張寬度', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const screen = await page.locator('#tableBody .module-card-row').first().evaluate((row) => {
    const px = (node, property) => parseFloat(getComputedStyle(node)[property]);
    const indexCell = row.querySelector('.module-index-cell');
    const titleCell = row.querySelector('.module-title-cell');
    const contentCell = row.querySelector('.module-content-cell');
    return {
      indexWidth: indexCell.getBoundingClientRect().width,
      indexFont: px(row.querySelector('.module-index-input'), 'fontSize'),
      titleFont: px(row.querySelector('.module-title-editor'), 'fontSize'),
      titlePaddingLeft: px(titleCell, 'paddingLeft'),
      contentPaddingLeft: px(contentCell, 'paddingLeft'),
      borderRadius: getComputedStyle(row).borderRadius,
      borderColor: getComputedStyle(row).borderColor
    };
  });

  await page.evaluate(() => {
    window.__screenParityPrepareState = { status: 'pending', error: '' };
    window.__screenParityPreparePromise = prepareV1PdfPrintArea()
      .then((ok) => {
        if (!ok) throw new Error('PRINT_AREA_NOT_READY');
        document.body.classList.add('pdf-print-mode');
        window.__screenParityPrepareState = { status: 'done', error: '' };
      })
      .catch((error) => {
        window.__screenParityPrepareState = { status: 'error', error: String(error?.message || error) };
      });
  });
  await expect.poll(() => page.evaluate(() => window.__screenParityPrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__screenParityPrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const printed = await page.locator('#pdfPrintArea .module-card-row').first().evaluate((row) => {
    const px = (node, property) => parseFloat(getComputedStyle(node)[property]);
    const indexCell = row.querySelector('.module-index-cell');
    const titleCell = row.querySelector('.module-title-cell');
    const contentCell = row.querySelector('.module-content-cell');
    return {
      indexWidth: indexCell.getBoundingClientRect().width,
      indexFont: px(row.querySelector('.print-only'), 'fontSize'),
      titleFont: px(row.querySelector('.module-title-editor'), 'fontSize'),
      titlePaddingLeft: px(titleCell, 'paddingLeft'),
      contentPaddingLeft: px(contentCell, 'paddingLeft'),
      borderRadius: getComputedStyle(row).borderRadius,
      borderColor: getComputedStyle(row).borderColor,
      actionCount: row.querySelectorAll('.module-actions-cell').length,
      scale: Number(row.closest('#pdfPrintArea')?.dataset?.pdfPrintScale || 100) / 100
    };
  });

  expect(printed.actionCount).toBe(0);
  expect(printed.borderRadius).toBe(screen.borderRadius);
  expect(printed.borderColor).toBe(screen.borderColor);
  expect(Math.abs((printed.indexWidth / printed.scale) - screen.indexWidth)).toBeLessThanOrEqual(1);
  expect(printed.indexFont).toBeGreaterThanOrEqual(screen.indexFont);
  expect(printed.titleFont).toBeGreaterThanOrEqual(screen.titleFont);
  expect(Math.abs(printed.titlePaddingLeft - screen.titlePaddingLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(printed.contentPaddingLeft - screen.contentPaddingLeft)).toBeLessThanOrEqual(1);
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

  const modules = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    const scale = Number(area?.dataset?.pdfPrintScale || 100) / 100;
    return Array.from(area.querySelectorAll('.module-card-row')).map((row) => ({
      keepTogether: row.classList.contains('pdf-keep-together'),
      measuredHeight: Number(row.dataset.pdfModuleHeight || 0),
      actualPrintHeight: Math.ceil(Math.max(row.getBoundingClientRect().height || 0, (row.scrollHeight || 0) * scale)),
      breakInside: getComputedStyle(row).breakInside
    }));
  });

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

test('超過單頁的長表格可自然跨頁，表頭重複且資料列不被拆開', async ({ page }, testInfo) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(() => {
    const rows = Array.from({ length: 72 }, (_, index) => `
      <tr>
        <td style="border:1px solid #cbd5e1;padding:5px 7px;">ROW-${String(index + 1).padStart(3, '0')} 自然分頁資料-${String(index + 1).padStart(2, '0')}</td>
        <td style="border:1px solid #cbd5e1;padding:5px 7px;">第 ${index + 1} 列完整內容，不可在列內切開</td>
      </tr>`).join('');
    reportData[0].title = '長表格自然跨頁驗證';
    reportData[0].columns = [`
      <table class="custom-data-table" data-resizable-table="1" style="width:100%;border-collapse:collapse;table-layout:fixed;">
        <tbody>
          <tr>
            <th style="border:1px solid #64748b;padding:6px 7px;background:#e2e8f0;">TABLE-HEADER-ITEM 跨頁表頭-項次</th>
            <th style="border:1px solid #64748b;padding:6px 7px;background:#e2e8f0;">TABLE-HEADER-DESC 跨頁表頭-說明</th>
          </tr>
          ${rows}
        </tbody>
      </table>`];
    reportData[0].colLayout = '1';
    reportData[0].selectedForPdf = true;
    reportData.slice(1).forEach((item) => { item.selectedForPdf = false; });
    renderTable();
  });
  await page.evaluate(() => {
    window.__longTablePrepareState = { status: 'pending', error: '' };
    window.__longTablePreparePromise = prepareV1PdfPrintArea().then((ok) => {
      if (!ok) throw new Error('PRINT_AREA_NOT_READY');
      document.body.classList.add('pdf-print-mode');
      window.__longTablePrepareState = { status: 'done', error: '' };
    }).catch((error) => {
      window.__longTablePrepareState = { status: 'error', error: String(error?.message || error) };
    });
  });
  await expect.poll(() => page.evaluate(() => window.__longTablePrepareState?.status), { timeout: 30000 })
    .toMatch(/^(done|error)$/);
  expect(await page.evaluate(() => window.__longTablePrepareState)).toEqual({ status: 'done', error: '' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const layout = await page.evaluate(() => {
    const area = document.getElementById('pdfPrintArea');
    const module = area.querySelector('.module-card-row');
    const table = module.querySelector('.custom-data-table');
    const contentCell = module.querySelector('.module-content-cell');
    const bodyRows = Array.from(table.tBodies[0].rows);
    const liveTable = document.querySelector('#tableBody .custom-data-table');
    return {
      pageContentHeight: Number(area.dataset.pdfPageContentHeight || 0),
      moduleHeight: Number(module.dataset.pdfModuleHeight || 0),
      splittableModule: module.classList.contains('pdf-splittable-module'),
      moduleBreakInside: getComputedStyle(module).breakInside,
      moduleBorderBottomStyle: getComputedStyle(module).borderBottomStyle,
      contentPaddingTop: getComputedStyle(contentCell).paddingTop,
      tableHeight: Math.ceil(table.getBoundingClientRect().height),
      tableBreakInside: getComputedStyle(table).breakInside,
      printHasThead: Boolean(table.tHead),
      liveHasThead: Boolean(liveTable?.tHead),
      headerDisplay: table.tHead ? getComputedStyle(table.tHead).display : 'missing',
      headerText: table.tHead?.textContent || '',
      bodyRowCount: bodyRows.length,
      bodyRowBreaks: Array.from(new Set(bodyRows.map((row) => getComputedStyle(row).breakInside)))
    };
  });

  expect(layout.tableHeight).toBeGreaterThan(layout.pageContentHeight);
  expect(layout.moduleHeight).toBeGreaterThan(layout.pageContentHeight);
  expect(layout.splittableModule).toBe(true);
  expect(layout.moduleBreakInside).toBe('auto');
  expect(layout.moduleBorderBottomStyle).toBe('none');
  expect(layout.contentPaddingTop).toBe('0px');
  expect(layout.tableBreakInside).toBe('auto');
  expect(layout.printHasThead).toBe(true);
  expect(layout.liveHasThead).toBe(false);
  expect(layout.headerDisplay).toBe('table-header-group');
  expect(layout.headerText).toContain('TABLE-HEADER-ITEM');
  expect(layout.bodyRowCount).toBe(72);
  expect(layout.bodyRowBreaks).toEqual(['avoid']);

  const pdfPath = testInfo.outputPath('long-table-natural-pagination.pdf');
  const pdf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  await testInfo.attach('long-table-natural-pagination.pdf', { body: pdf, contentType: 'application/pdf' });
  const pageObjects = pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || [];
  expect(pageObjects.length).toBeGreaterThan(2);
  expect(pageObjects.length).toBeLessThan(12);
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

test('同步最新三選一可明確捨棄普通草稿並直接套用雲端', async ({ page, request }) => {
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module'
      || payload?.name === 'monthly_v7_save_module_batch'
      || payload?.name === 'monthly_v7_save_report_meta') saveCalls += 1;
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  const title = row.locator('.module-title-editor');

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('準備捨棄的本機草稿');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ key }) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).payload?.title : '';
  }, { key: draftKey })).toBe('準備捨棄的本機草稿');
  await request.post('/__fake_remote_module_change');
  const saveCallsBeforeSync = saveCalls;

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  const modal = page.locator('#v7-sync-choice-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('保留草稿同步');
  await expect(modal).toContainText('捨棄草稿用雲端');
  await expect(modal).toContainText('取消');
  await expect(modal).toContainText('1 個普通本機草稿');

  await page.locator('#v7-sync-discard').click();
  await expect(modal).toBeHidden();
  await expect(title).toHaveText('遠端較新內容');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBeNull();
  expect(saveCalls).toBe(saveCallsBeforeSync);
  const state = await (await request.get('/__fake_state')).json();
  expect(Number(state.rpcCounts.monthly_v7_get_snapshot || 0)).toBeGreaterThan(0);
  expect(state.modules[0].payload.title).toBe('遠端較新內容');
});

test('保留草稿同步會讀取雲端新基線但不覆蓋或上傳本機草稿', async ({ page, request }) => {
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module'
      || payload?.name === 'monthly_v7_save_module_batch'
      || payload?.name === 'monthly_v7_save_report_meta') saveCalls += 1;
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  const title = row.locator('.module-title-editor');

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('必須保留的本機草稿');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ key }) => Boolean(localStorage.getItem(key)), { key: draftKey })).toBe(true);
  await request.post('/__fake_remote_module_change');
  const saveCallsBeforeSync = saveCalls;

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await page.locator('#v7-sync-keep').click();
  await expect(page.locator('#v7-sync-choice-modal')).toBeHidden();
  await expect(title).toHaveText('必須保留的本機草稿');
  const local = await page.evaluate(({ id, key }) => {
    const rowData = window.MonthlyV7App.client.snapshot.modules.find(item => item.id === id);
    const draft = JSON.parse(localStorage.getItem(key));
    return {
      draftTitle: draft.payload.title,
      localTitle: rowData.payload.title,
      serverTitle: rowData._serverPayload?.title || '',
      serverRevision: Number(rowData._serverRevision || 0),
      conflictBlocked: window.MonthlyV7App.isRevisionConflictBlocked('module', id)
    };
  }, { id: moduleId, key: draftKey });
  expect(local).toEqual({
    draftTitle: '必須保留的本機草稿',
    localTitle: '必須保留的本機草稿',
    serverTitle: '遠端較新內容',
    serverRevision: 2,
    conflictBlocked: true
  });
  expect(saveCalls).toBe(saveCallsBeforeSync);
});

test('同步選擇會計入尚未落地的可見草稿且取消完全不改資料', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const row = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"]`);
  const title = row.locator('.module-title-editor');
  const rpcBefore = (await (await request.get('/__fake_state')).json()).rpcCounts;
  const snapshotBefore = await page.evaluate(() => JSON.stringify(window.MonthlyV7App.client.snapshot));

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('尚未落地也必須提示的可見草稿');
  await page.evaluate(() => {
    clearTimeout(window._globalInputSaveTimer);
    window._globalInputSaveTimer = null;
  });
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBeNull();

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  const modal = page.locator('#v7-sync-choice-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('1 個普通本機草稿');
  await page.locator('#v7-sync-cancel').click();

  await expect(modal).toBeHidden();
  await expect(title).toHaveText('尚未落地也必須提示的可見草稿');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBeNull();
  expect(await page.evaluate(() => JSON.stringify(window.MonthlyV7App.client.snapshot))).toBe(snapshotBefore);
  const rpcAfter = (await (await request.get('/__fake_state')).json()).rpcCounts;
  expect(Number(rpcAfter.monthly_v7_get_snapshot || 0)).toBe(Number(rpcBefore.monthly_v7_get_snapshot || 0));
  expect(Number(rpcAfter.monthly_v7_get_changes_since || 0)).toBe(Number(rpcBefore.monthly_v7_get_changes_since || 0));
  expect(Number(rpcAfter.monthly_v7_save_module || 0)).toBe(Number(rpcBefore.monthly_v7_save_module || 0));
});

test('同步最新遇到未知結果pending會禁止捨棄並原封保留對帳證據', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await page.evaluate(async () => {
    window.MonthlyV7App.transport.requestTimeoutMs = 35;
    document.getElementById('mainTitle').textContent = 'pending期間必須保留的月報標題';
    await manualSave(false, { deferCloud: true });
  });
  await request.post('/__fake_hang_rpc?name=monthly_v7_save_report_meta&count=always');
  expect(await page.evaluate(() => v5SaveChangesToCloud())).toBe(false);

  const before = await page.evaluate(() => {
    const reportId = window.MonthlyV7App.client.currentReport().id;
    const draftKey = `monthly_v7_draft:report_meta:${reportId}`;
    const pendingKey = `monthly_v7_pending:save_report_meta:${reportId}`;
    return {
      reportId,
      draftKey,
      pendingKey,
      draft: localStorage.getItem(draftKey),
      pending: localStorage.getItem(pendingKey)
    };
  });
  expect(before.draft).toBeTruthy();
  expect(before.pending).toBeTruthy();
  const rpcBefore = (await (await request.get('/__fake_state')).json()).rpcCounts;

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-modal')).toBeVisible();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('有pending待對帳');
  await expect(page.locator('#v7-sync-choice-warning')).toContainText('必須先完成對帳');
  await expect(page.locator('#v7-sync-discard')).toBeDisabled();
  expect(await page.evaluate(() => v7ChooseSyncLatest('discard'))).toBe(false);

  const after = await page.evaluate(({ draftKey, pendingKey }) => ({
    draft: localStorage.getItem(draftKey),
    pending: localStorage.getItem(pendingKey)
  }), before);
  expect(after).toEqual({ draft: before.draft, pending: before.pending });
  const rpcAfter = (await (await request.get('/__fake_state')).json()).rpcCounts;
  expect(Number(rpcAfter.monthly_v7_get_snapshot || 0)).toBe(Number(rpcBefore.monthly_v7_get_snapshot || 0));
  expect(Number(rpcAfter.monthly_v7_get_changes_since || 0)).toBe(Number(rpcBefore.monthly_v7_get_changes_since || 0));
  expect(Number(rpcAfter.monthly_v7_save_report_meta || 0)).toBe(Number(rpcBefore.monthly_v7_save_report_meta || 0));
  await page.locator('#v7-sync-cancel').click();
  expect(dialogs.some(message => message.includes('RPC_TIMEOUT'))).toBe(true);
});

test('revision conflict會在明確選擇捨棄後以雲端版本完成對帳', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.MONTHLY_V7_AUTO_SAVE_INTERVAL_MS = 750;
  });
  let saveCalls = 0;
  await page.route('**/__fake_rpc', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.name === 'monthly_v7_save_module'
      || payload?.name === 'monthly_v7_save_module_batch') saveCalls += 1;
    await route.continue();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  await request.post('/__fake_remote_module_change');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const title = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('確定不要的衝突草稿');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ id }) => (
    window.MonthlyV7App.isRevisionConflictBlocked('module', id)
  ), { id: moduleId }), { timeout: 15000 }).toBe(true);
  const draftBefore = await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey });
  expect(draftBefore).toContain('確定不要的衝突草稿');
  const saveCallsBeforeSync = saveCalls;

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('1 個revision conflict');
  await expect(page.locator('#v7-sync-discard')).toBeEnabled();
  await page.locator('#v7-sync-discard').click();

  await expect(page.locator('#v7-sync-choice-modal')).toBeHidden();
  await expect(title).toHaveText('遠端較新內容');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBeNull();
  expect(await page.evaluate(({ id }) => window.MonthlyV7App.isRevisionConflictBlocked('module', id), { id: moduleId })).toBe(false);
  expect(saveCalls).toBe(saveCallsBeforeSync);
});

test('同步捨棄會攔截目前workspace中尚無entity可對應的create pending', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const seeded = await page.evaluate(() => {
    const client = window.MonthlyV7App.client;
    const pendingKey = 'create_record:brand-new-type';
    const storageKey = `monthly_v7_pending:${pendingKey}`;
    const pending = {
      actorUserId: client.currentUser().id,
      createdAt: new Date().toISOString(),
      operationId: crypto.randomUUID(),
      signature: JSON.stringify({
        p_workspace_key: client.config.workspaceKey,
        p_user_session_id: client.userSession.id,
        p_client_session_id: client.clientSessionId,
        p_record_type: 'brand-new-type',
        p_payload: { title: '尚未有entity的新記錄' }
      })
    };
    localStorage.setItem(storageKey, JSON.stringify(pending));
    return { storageKey, raw: localStorage.getItem(storageKey) };
  });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('有pending待對帳');
  await expect(page.locator('#v7-sync-discard')).toBeDisabled();
  expect(await page.evaluate(({ storageKey }) => localStorage.getItem(storageKey), seeded)).toBe(seeded.raw);
  await page.locator('#v7-sync-cancel').click();
});

test('格式異常的目前entity draft envelope必須阻擋捨棄且保留raw證據', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const seeded = await page.evaluate(({ id }) => {
    const storageKey = `monthly_v7_draft:module:${id}`;
    const malformed = {
      entityType: 'module',
      entityId: id,
      payload: { id: 'item-a', title: '格式異常但不可刪除', columns: ['A'], operationColumnCount: 1 }
    };
    localStorage.setItem(storageKey, JSON.stringify(malformed));
    return { storageKey, raw: localStorage.getItem(storageKey) };
  }, { id: moduleId });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('1 個格式異常草稿');
  await expect(page.locator('#v7-sync-choice-warning')).toContainText('格式異常的草稿證據');
  await expect(page.locator('#v7-sync-discard')).toBeDisabled();
  expect(await page.evaluate(({ storageKey }) => localStorage.getItem(storageKey), seeded)).toBe(seeded.raw);
  await page.locator('#v7-sync-cancel').click();
});

test('非字串workspace key的pending envelope必須fail closed且保留raw證據', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const seeded = await page.evaluate(() => {
    const client = window.MonthlyV7App.client;
    const storageKey = 'monthly_v7_pending:create_record:malformed-workspace';
    const pending = {
      actorUserId: client.currentUser().id,
      createdAt: new Date().toISOString(),
      operationId: crypto.randomUUID(),
      signature: JSON.stringify({
        p_workspace_key: { value: 'other-workspace' },
        p_user_session_id: client.userSession.id,
        p_client_session_id: client.clientSessionId,
        p_record_type: 'malformed-workspace',
        p_payload: { title: '不可忽略的格式異常pending' }
      })
    };
    localStorage.setItem(storageKey, JSON.stringify(pending));
    return { storageKey, raw: localStorage.getItem(storageKey) };
  });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('有pending待對帳');
  await expect(page.locator('#v7-sync-choice-warning')).toContainText('必須先完成對帳');
  await expect(page.locator('#v7-sync-discard')).toBeDisabled();
  expect(await page.evaluate(({ storageKey }) => localStorage.getItem(storageKey), seeded)).toBe(seeded.raw);
  await page.locator('#v7-sync-cancel').click();
});

test('捨棄同步在雲端快照讀取失敗時保留原畫面與draft', async ({ page, request }) => {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222221';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const title = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('雲端失敗時不可先刪的草稿');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ key }) => Boolean(localStorage.getItem(key)), { key: draftKey })).toBe(true);
  const draftBefore = await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey });
  await page.evaluate(() => { window.MonthlyV7App.transport.requestTimeoutMs = 35; });
  await request.post('/__fake_hang_rpc?name=monthly_v7_get_snapshot&count=always');

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await page.locator('#v7-sync-discard').click();
  await expect(page.locator('#v7-sync-choice-modal')).toBeVisible();
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('捨棄草稿同步失敗');
  await expect(title).toHaveText('雲端失敗時不可先刪的草稿');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBe(draftBefore);
  expect(dialogs.some(message => message.includes('目前不能捨棄草稿') && message.includes('RPC_TIMEOUT'))).toBe(true);
  await request.post('/__fake_hang_rpc?name=monthly_v7_get_snapshot&count=0');
  await page.locator('#v7-sync-cancel').click();
});

test('雲端快照讀取途中出現pending時不得清除draft並須恢復本機畫面', async ({ page, request }) => {
  page.on('dialog', dialog => dialog.dismiss());
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222222';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const title = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('讀取途中必須保留的本機草稿');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ key }) => Boolean(localStorage.getItem(key)), { key: draftKey })).toBe(true);
  await request.post('/__fake_remote_module_change');

  let markSnapshotRequested;
  let resumeSnapshot;
  let snapshotRequestCount = 0;
  const snapshotRequested = new Promise(resolve => { markSnapshotRequested = resolve; });
  const snapshotGate = new Promise(resolve => { resumeSnapshot = resolve; });
  await page.route('**/__fake_rpc', async route => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_get_snapshot') return route.continue();
    snapshotRequestCount += 1;
    markSnapshotRequested();
    await snapshotGate;
    await route.continue();
  });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await page.locator('#v7-sync-discard').click();
  await snapshotRequested;

  const evidence = await page.evaluate(({ id, key }) => {
    const client = window.MonthlyV7App.client;
    const pendingStorageKey = `monthly_v7_pending:save_module:${id}`;
    const operationId = crypto.randomUUID();
    const pending = {
      actorUserId: client.currentUser().id,
      createdAt: new Date().toISOString(),
      operationId,
      signature: JSON.stringify({
        p_workspace_key: client.config.workspaceKey,
        p_user_session_id: client.userSession.id,
        p_client_session_id: client.clientSessionId,
        p_module_id: id,
        p_expected_revision: 1,
        p_lease_id: crypto.randomUUID(),
        p_fencing_token: 1,
        p_payload: { id: 'item-a', title: '待確認保存內容', columns: ['A 內容'], operationColumnCount: 1 }
      })
    };
    localStorage.setItem(pendingStorageKey, JSON.stringify(pending));
    return {
      draftStorageKey: key,
      draftRaw: localStorage.getItem(key),
      pendingStorageKey,
      pendingRaw: localStorage.getItem(pendingStorageKey)
    };
  }, { id: moduleId, key: draftKey });
  resumeSnapshot();

  await expect(page.locator('#v4-cloud-runtime-status')).toContainText(/已捨棄普通本機草稿|捨棄草稿同步失敗/);
  await expect(page.locator('#v7-sync-choice-modal')).toBeVisible();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('有pending待對帳');
  await expect(title).toHaveText('讀取途中必須保留的本機草稿');
  const after = await page.evaluate(({ draftStorageKey, pendingStorageKey }) => ({
    draftRaw: localStorage.getItem(draftStorageKey),
    pendingRaw: localStorage.getItem(pendingStorageKey)
  }), evidence);
  expect(after.draftRaw).toBe(evidence.draftRaw);
  expect(after.pendingRaw).toBe(evidence.pendingRaw);
  expect(snapshotRequestCount).toBe(1);
  await page.locator('#v7-sync-cancel').click();
});

test('雲端快照讀取途中草稿被更新時不得清除未確認的後繼內容', async ({ page }) => {
  page.on('dialog', dialog => dialog.dismiss());
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222222';
  const draftKey = `monthly_v7_draft:module:${moduleId}`;
  const title = page.locator(`#tableBody tr[data-v7-entity-id="${moduleId}"] .module-title-editor`);

  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('原本確認捨棄的草稿A');
  await page.locator('#mainTitle').click();
  await expect.poll(() => page.evaluate(({ key }) => Boolean(localStorage.getItem(key)), { key: draftKey })).toBe(true);

  let markSnapshotRequested;
  let resumeSnapshot;
  let snapshotRequestCount = 0;
  const snapshotRequested = new Promise(resolve => { markSnapshotRequested = resolve; });
  const snapshotGate = new Promise(resolve => { resumeSnapshot = resolve; });
  await page.route('**/__fake_rpc', async route => {
    const payload = route.request().postDataJSON();
    if (payload?.name !== 'monthly_v7_get_snapshot') return route.continue();
    snapshotRequestCount += 1;
    markSnapshotRequested();
    await snapshotGate;
    await route.continue();
  });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await page.locator('#v7-sync-discard').click();
  await snapshotRequested;
  const successorRaw = await page.evaluate(({ id, key }) => {
    const client = window.MonthlyV7App.client;
    client.saveDraft('module', id, {
      id: 'item-b',
      title: '其他分頁建立的後繼草稿B',
      columns: ['B 後繼內容'],
      operationColumnCount: 1
    }, 1);
    return localStorage.getItem(key);
  }, { id: moduleId, key: draftKey });
  resumeSnapshot();

  await expect(page.locator('#v4-cloud-runtime-status')).toContainText(/已捨棄普通本機草稿|捨棄草稿同步失敗/);
  await expect(page.locator('#v7-sync-choice-modal')).toBeVisible();
  await expect(page.locator('#v7-sync-choice-warning')).toContainText('同步期間本機草稿已更新');
  await expect(title).toHaveText('其他分頁建立的後繼草稿B');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBe(successorRaw);
  expect(snapshotRequestCount).toBe(1);
  await page.locator('#v7-sync-cancel').click();
});

test('捨棄草稿同步也會以雲端版本取代目前月報資訊草稿', async ({ page, request }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const reportId = await page.evaluate(() => window.MonthlyV7App.client.currentReport().id);
  const draftKey = `monthly_v7_draft:report_meta:${reportId}`;
  const title = page.locator('#mainTitle');
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('準備捨棄的本機月報標題');
  await page.locator('#reportDate').click();
  await expect.poll(() => page.evaluate(({ key }) => Boolean(localStorage.getItem(key)), { key: draftKey })).toBe(true);
  await request.post('/__fake_remote_report_meta_change');

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).toContainText('1 個普通本機草稿');
  await page.locator('#v7-sync-discard').click();

  await expect(page.locator('#v7-sync-choice-modal')).toBeHidden();
  await expect(title).toHaveText('遠端較新月報標題');
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), { key: draftKey })).toBeNull();
});

test('其他workspace同entity ID的合法pending不阻擋目前同步且不會被刪除', async ({ page }) => {
  await enterAndLogin(page, 'owner', 'owner-pass');
  const moduleId = '22222222-2222-4222-8222-222222222222';
  const seeded = await page.evaluate(({ id }) => {
    const client = window.MonthlyV7App.client;
    const storageKey = `monthly_v7_pending:save_module:${id}`;
    const pending = {
      actorUserId: client.currentUser().id,
      createdAt: new Date().toISOString(),
      operationId: crypto.randomUUID(),
      signature: JSON.stringify({
        p_workspace_key: 'other-workspace',
        p_user_session_id: client.userSession.id,
        p_client_session_id: client.clientSessionId,
        p_module_id: id,
        p_expected_revision: 1,
        p_lease_id: crypto.randomUUID(),
        p_fencing_token: 1,
        p_payload: { id: 'item-a', title: '其他workspace證據', columns: ['X'], operationColumnCount: 1 }
      })
    };
    localStorage.setItem(storageKey, JSON.stringify(pending));
    return { storageKey, raw: localStorage.getItem(storageKey) };
  }, { id: moduleId });

  await page.locator('.v5-session-bar button').filter({ hasText: '同步最新' }).click();
  await expect(page.locator('#v7-sync-choice-summary')).not.toContainText('有pending待對帳');
  await expect(page.locator('#v7-sync-discard')).toBeEnabled();
  await page.locator('#v7-sync-cancel').click();
  expect(await page.evaluate(({ storageKey }) => localStorage.getItem(storageKey), seeded)).toBe(seeded.raw);
});
