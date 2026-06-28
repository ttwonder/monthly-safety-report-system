# 需求達成檢查表（V4）

## 結論

目前核心需求已達成：

- 月報模板已拆成多標籤頁；
- 20 個原始條目已模塊化；
- 可勾選需要的模塊；
- 可按勾選內容輸出 PDF；
- 已有本地資料記錄庫；
- 已有 KPI / 趨勢自動化；
- 已有 Supabase 雲端同步準備；
- 已整理為 GitHub Pages repo 形態。

但以下兩點需要實際外部配置後才算完整上線：

1. Supabase 需要你建立 project、執行 `docs/supabase-schema-v4.sql`、填入 URL 和 anon key 後，才能實際雲端同步。
2. GitHub Pages 需要推送到你的 GitHub repo，並在 Settings → Pages 設為 GitHub Actions 後，才會真正部署到網上。

## 原始需求逐項核對

| 需求 | 狀態 | 說明 |
|---|---:|---|
| 全面讀 demo，分辨功能與 bug | 已完成 | 已讀原 HTML，做過 node 語法檢查與瀏覽器 console 檢查。 |
| 拆分到不同標籤頁 | 已完成 | 月報編輯、模塊庫、PDF 輸出、歷史/備份、資料記錄、KPI/趨勢、雲端同步。 |
| 保留 demo 功能和格式 | 基本完成 | 富文本、數值框、表格、指標卡、KPI 卡、進度卡、三色卡、趨勢圖、圖標、分欄、附件、Excel/data.js 大部分保留。 |
| 勾選需要哪些模塊 | 已完成 | 模塊庫與 PDF 輸出中心都有 checkbox。 |
| 靈活輸出 PDF 作為月報內容 | 已完成 | PDF 輸出中心只輸出勾選模塊，包含封面、目錄、模塊內容。 |
| 儲存記錄數據信息 | 已完成（本地） | IndexedDB 記錄庫：檢查、缺失/觀察、PSC 滯留、行動項、Safety Walk/訓練/演練。 |
| 自動統計 KPI / 趨勢 | 已完成第一版 | KPI/趨勢 V3 可按近 3/6/12 月自動統計並寫回月報。 |
| 雲端共享 / 多人同步 | 框架完成，待配置 | V4 已有 Supabase RPC 同步框架和 SQL，但需實際 Supabase URL/key 測試。 |
| GitHub Pages 網上部署 | repo 已準備，待推送 | 已有 index.html、.nojekyll、GitHub Actions workflow；需連接/推送到 GitHub repo。 |

## 仍需注意的限制

- 目前沒有實際 Supabase 憑證，因此雲端連線未實測。
- 目前是簡易 Workspace Key 模式，適合先用；敏感資料建議後續升級 Supabase Auth + 嚴格 RLS。
- 附件仍主要依原 demo 方式處理；大量附件或敏感附件後續應遷移到 Supabase Storage。
- Tailwind / Chart / SheetJS / FontAwesome 仍使用 CDN，離線或內網封鎖時可能影響功能。
- 已在 V4 將富文本核心由舊式 `document.execCommand` 調整為 Selection/Range API：加粗、顏色、字號、列表、清除格式與各類 HTML 模塊插入不再依賴 execCommand。
- 已在 V5 移除正式首頁與主文件中的舊版 data.js/lib 操作提示與可見入口，改用「數據管理 → 完整 JSON 備份 / Supabase 同步」。
- 已在 V5 修復趨勢圖插入與定位：不再使用失效選區定位、不再用 `last-of-type` 猜測最新圖表、插入後會以實際回傳節點作為滾動錨點。
- 已在 V5 加入應用內多人協作權限：owner/admin/operator；數據管理僅 owner/admin 可進入；只有 owner 可刪除「月報編輯」項次；所有已登入用戶可同步最新與保存修改。
