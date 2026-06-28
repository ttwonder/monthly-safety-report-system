# 月度安全會議報告系統

## 主要使用文件

線上部署使用：

`index.html`

本地直接打開也可使用：

`月度安全會議報告-v4.html`

目前實際功能版本為 V5，包含：

- V1：模塊化月報、勾選式 PDF、歷史 / 備份
- V2：資料記錄庫、檢查 / 缺失 / PSC 滯留 / 行動項 / Safety Walk 記錄
- V3：KPI 自動化、近 3 / 6 / 12 月趨勢、月報模塊更新
- V4：Supabase 雲端同步、完整 JSON 雲端包、GitHub Pages 部署
- V5：多人協作登入、owner/admin/operator 權限、數據管理、穩定趨勢圖插入定位

## 文件夾說明

- `index.html`：GitHub Pages 預設首頁，內容等同最新主文件
- `月度安全會議報告-v4.html`：最新主文件；文件名保留 v4 以免破壞既有連結，實際標題為 V5
- `docs/整體計劃-roadmap.md`：整體計劃與版本進度
- `docs/supabase-schema-v4.sql`：Supabase 資料表與 RPC
- `docs/github-pages-deploy-v4.md`：GitHub Pages + Supabase 部署說明
- `docs/requirements-status-v4.md`：需求達成檢查表
- `archive/`：原始 demo、V1、V2 備份，不作日常使用

## 使用方式

1. 打開 GitHub Pages 網址或本地 `index.html`。
2. 第一次使用：進入「數據管理」建立第一個 owner。
3. 日常填寫資料：進入「資料記錄」或「月報編輯」。
4. 查看自動統計：進入「KPI / 趨勢 V3」。
5. 需要寫入月報：點擊「用 KPI / 趨勢更新月報」。
6. 需要輸出 PDF：進入「PDF 輸出中心」，勾選模塊後輸出。
7. 多人協作：登入後使用頂部「同步最新」和「保存修改」。
8. 管理帳號 / Supabase 設定 / JSON 備份：進入「數據管理」。

## 權限規則

- owner：可進入數據管理、管理用戶、刪除「月報編輯」中的項次項目、同步/保存雲端資料。
- admin：可進入數據管理、建立或更新一般用戶、同步/保存雲端資料；不能刪除月報項次。
- operator：可編輯資料、同步最新、保存修改；不能進入數據管理，不能刪除月報項次。

## 注意

V5 使用應用內帳號密碼，不使用 Supabase email confirmation。密碼以 SHA-256 hash 存在雲端資料包內；Workspace Key 仍類似密碼，請勿公開。
