# GitHub Pages + Supabase 部署說明

## 1. 本地文件

正式首頁：

```text
index.html
```

主文件：

```text
月度安全會議報告-v4.html
```

> 文件名保留 v4 以免破壞既有連結；目前實際功能版本為 V5。

建議 GitHub repo 結構：

```text
/
├─ index.html
├─ 月度安全會議報告-v4.html
├─ docs/
│  ├─ supabase-schema-v4.sql
│  └─ github-pages-deploy-v4.md
└─ archive/
```

## 2. Supabase 設定

1. 到 https://supabase.com 建立免費 project。
2. 打開 SQL Editor。
3. 複製 `docs/supabase-schema-v4.sql` 全文並執行。
4. 到 Project Settings → API，取得：
   - Project URL
   - anon public key
5. 若要所有使用者打開網址即自動同步，請在 repo 內的 `supabase-config.js` 填入：
   - Project URL
   - anon public key
   - 共用 Workspace Key
6. 打開系統後會自動同步雲端資料。
7. 第一次多人協作前，在「數據管理」建立第一個 owner。
8. 建立 owner 後系統會自動保存；也可點「保存修改 / 上傳雲端」手動確認。

## 3. GitHub Pages 部署

本 repo 已包含 `.github/workflows/pages.yml`，建議使用 GitHub Actions 部署：

1. 用 GitHub Desktop 將本文件夾推送到 GitHub。
2. 到 GitHub repo → Settings → Pages。
3. Source 選 `GitHub Actions`。
4. 到 Actions 等待 `Deploy static site to GitHub Pages` 成功。
5. 打開 Pages URL。

## 4. 多人協作使用方式

- A 使用者修改前：先點「同步最新」。
- 修改後：登入狀態下點「保存修改」。
- B 使用者打開後：先點「同步最新」。

目前是共享資料包同步，不是 Google Docs 式即時多人共同編輯；若兩人同時修改，最後保存的人會覆蓋雲端版本。

## 5. 權限

- owner：管理用戶、查看/修改 Supabase 設定、進入數據管理、刪除月報項次、同步/保存。
- admin：進入數據管理、建立/更新一般用戶、同步/保存；看不到也不能修改 Supabase 設定。
- operator：同步最新、保存修改、日常填寫；不能進入數據管理，不能刪除月報項次，也看不到 Supabase 設定。

## 6. 備份建議

即使啟用雲端，也建議定期使用：

- 數據管理 → 匯出完整 JSON 備份
- PDF 輸出中心 → 輸出正式 PDF
- 歷史 / 備份 → 建立副本或匯出 Excel

## 7. 安全提醒

V5 使用應用內帳號密碼，不需要 Supabase email confirmation。密碼以 SHA-256 hash 存在雲端資料包內；Workspace Key 仍需保密。不要把 Supabase service_role key 放進 HTML。
