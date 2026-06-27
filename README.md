# 月度安全會議報告系統

## 主要使用文件

請打開：

`月度安全會議報告-v4.html`

這是目前最新版本，包含：

- V1：模塊化月報、勾選式 PDF、歷史 / 備份
- V2：資料記錄庫、檢查 / 缺失 / PSC 滯留 / 行動項 / Safety Walk 記錄
- V3：KPI 自動化、近 3 / 6 / 12 月趨勢、月報模塊更新
- V4：Supabase 雲端同步準備、完整 JSON 雲端包、GitHub Pages 部署文件

## 文件夾說明

- `index.html`：GitHub Pages 預設首頁，內容等同 V4
- `月度安全會議報告-v4.html`：最新主文件
- `月度安全會議報告-v3.html`：上一版備份
- `lib/data.js`：共享資料檔佔位文件；從系統匯出的 data.js 可覆蓋這個文件
- `docs/整體計劃-roadmap.md`：整體計劃與版本進度
- `docs/supabase-schema-v4.sql`：Supabase V4 資料表與 RPC
- `docs/github-pages-deploy-v4.md`：GitHub Pages + Supabase 部署說明
- `docs/requirements-status-v4.md`：需求達成檢查表
- `archive/`：原始 demo、V1、V2 備份

## 使用方式

1. 用瀏覽器打開 `月度安全會議報告-v4.html`。
2. 日常填寫資料：進入「資料記錄」。
3. 查看自動統計：進入「KPI / 趨勢 V3」。
4. 需要寫入月報：點擊「用 KPI / 趨勢更新月報」。
5. 需要輸出 PDF：進入「PDF 輸出中心」，勾選模塊後輸出。
6. 需要雲端同步：先按 `docs/supabase-schema-v4.sql` 建 Supabase，再進入「雲端同步 V4」。

## 注意

目前 V4 雲端是簡易 Workspace Key 模式。Workspace Key 類似密碼，請勿公開。若要保存敏感資料，後續應升級 Supabase Auth + 嚴格 RLS。
