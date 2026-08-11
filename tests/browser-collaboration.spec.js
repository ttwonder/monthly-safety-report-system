'use strict';

const { test, expect } = require('@playwright/test');

async function enterAndLogin(page, username, password) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    if (!window.MonthlyV7App?.initialized && typeof window.onload === 'function') {
      const boot = window.onload;
      window.onload = null;
      await boot.call(window);
    }
  });
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
  await page.locator('#v5TopStatus').click();
  await expect.poll(() => interceptedSaveCount).toBeGreaterThan(0);

  await expect(row.locator('.v7-item-lock-badge')).toHaveText('你正在編輯');
  await expect(title).toHaveText('尚未提交的本機內容');
  const state = await page.request.get('/__fake_state').then((response) => response.json());
  expect(state.modules[0].revision).toBe(1);
  expect(state.modules[0].payload.title).toBe('A 原始項目');
  expect(errors).toEqual([]);
});

test('revision conflict 保留本機草稿，重載後由使用者確認才以目前內容重試', async ({ page, request }) => {
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
  await expect(page.locator('#v4-cloud-runtime-status')).toContainText('逐項雲端保存完成');
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
  await page.evaluate(async () => {
    await prepareV1PdfPrintArea();
    document.body.classList.add('pdf-print-mode');
  });
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
