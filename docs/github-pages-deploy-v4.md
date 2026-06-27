# V4 GitHub Pages + Supabase 部署說明

## 1. 本地文件

正式主文件：

```text
月度安全會議報告-v4.html
```

建議 GitHub repo 結構：

```text
/
├─ index.html                    # 可由 月度安全會議報告-v4.html 複製改名
├─ 月度安全會議報告-v4.html
├─ lib/data.js
└─ docs/
   ├─ supabase-schema-v4.sql
   └─ github-pages-deploy-v4.md
```

如果要 GitHub Pages 預設打開系統，可以把 `月度安全會議報告-v4.html` 複製一份命名為 `index.html`。

## 2. Supabase 設定

1. 到 https://supabase.com 建立免費 project。
2. 打開 SQL Editor。
3. 複製 `docs/supabase-schema-v4.sql` 全文並執行。
4. 到 Project Settings → API，取得：
   - Project URL
   - anon public key
5. 打開系統的「雲端同步 V4」。
6. 填入 Project URL、anon public key。
7. 點「生成 Key」建立 Workspace Key，請妥善保存。
8. 點「保存設定」。
9. 點「測試連線」。
10. 點「上傳本機到雲端」。

## 3. GitHub Pages 部署

1. 建立 GitHub repo。
2. 把本文件夾內容放進 repo。
3. 如需首頁直接打開，將 `月度安全會議報告-v4.html` 複製為 `index.html`。
4. 到 GitHub repo → Settings → Pages。
5. Source 選 `Deploy from a branch`。
6. Branch 選 `main` / root。
7. 保存後等待 Pages URL 生成。

## 4. 安全提醒

目前 V4 是簡易 Workspace Key 模式：

- Workspace Key 類似密碼，請勿公開。
- anon key 是 Supabase 前端公開 key，不等於 service role key。
- 不要把 service role key 放進 HTML。
- 如果月報包含敏感人員資料或公司內部資料，建議後續升級：
  - Supabase Auth 登入
  - 每個使用者 / 團隊獨立 RLS
  - 操作紀錄 audit logs
  - 附件轉 Supabase Storage 私有 bucket

## 5. 備份建議

即使啟用雲端，也建議定期使用：

- 雲端同步 V4 → 匯出完整雲端包 JSON
- PDF 輸出中心 → 輸出正式 PDF
- 歷史 / 備份 → 匯出 data.js 或 Excel
