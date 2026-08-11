# 月度安全會議報告系統

GitHub Pages 首頁：`index.html`
保留既有下載連結的同版文件：`月度安全會議報告-v4.html`

兩份 HTML 必須保持完全一致。文件名保留 `v4` 是為了不破壞既有連結，實際功能版本為 **V7**。

## V7 主要能力

- 保留原有月報編輯、模塊庫、PDF、歷史、資料記錄、KPI/趨勢及數據管理 UI。
- report metadata、每個 module、五類 records 均為獨立 Supabase authority row。
- 同一 entity 同時只授予一個 editor session lease；不同 entity 可由不同使用者並行保存。
- server-side claim / renew / release / takeover、TTL、client session、lease ID、fencing token。
- 每個 entity 獨立 revision/CAS；workspace watermark 不作全域內容 CAS。
- `operation_id` ledger 處理 lost acknowledgement，重送不重複增版或寫 audit。
- Realtime event 只帶 entity ID/revision/sequence；client 收到後逐項重讀並以 watermark 補抓。
- 有本機草稿或 lease 的項目不會被遠端內容自動覆蓋。
- record/module 刪除先在雲端 transaction 成功，再從畫面隱藏。
- KPI 多 module 更新採單一 transaction，全成或全不成。
- 正式 PDF 先建立資料庫一致、不可變 snapshot。
- 進站密碼與內部帳號 hash 只留在 private server tables；瀏覽器只收到安全 user projection。
- 進站 site session 與內部 user session 分離；「登出」只撤銷目前 user session 並保留網站已解鎖，`READ_SESSION_INVALID`／`USER_SESSION_INVALID` 會立即清除身份投影、停止重試並完整保留本機草稿。
- legacy SHA-256 在首次成功登入後自動升級 bcrypt。

## 主要檔案

- `index.html`、`月度安全會議報告-v4.html`：正式 UI。
- `monthly-collaboration-core.js`：穩定 entity key、lease/watermark/snapshot projection 純函式。
- `monthly-collaboration-client.js`：session、lease、CAS、operation retry、draft、catch-up client。
- `monthly-collaboration-v7.js`：Supabase transport、Realtime、DOM guard、逐項 diff adapter。
- `vendor/supabase-2.112.2.js`：固定版本 Supabase browser SDK，不依賴未鎖定 CDN。
- `docs/supabase-schema-v7.sql`：additive schema、migration、RPC、RLS、Realtime policy。
- `docs/supabase-schema-v7-activate.sql`：正式 authority activation transaction。
- `docs/v7-deployment-and-cutover.md`：必讀的兩階段部署、驗收與異常處理手冊。
- `docs/supabase-schema-v6.sql`：legacy V6 schema，僅供升級來源與歷史參考。

## 部署順序

1. 備份現有完整 JSON，盤點其他裝置的 IndexedDB 歷史／草稿。
2. 確認 legacy 使用者恰好一位 Owner。
3. 在 Supabase Dashboard 啟用 Anonymous Sign-Ins。
4. 執行 `docs/supabase-schema-v7.sql`；確認 authority 仍為 `LEGACY_ACTIVE` 且 migration hashes/counts 正確。
5. Push 本 repository commit，等待既有 GitHub Pages workflow 完成。
6. 短暫停止現場修改，執行 `docs/supabase-schema-v7-activate.sql`。
7. 所有人重新整理並重新登入，完成雙瀏覽器 smoke tests。

詳情見 [`docs/v7-deployment-and-cutover.md`](docs/v7-deployment-and-cutover.md)。

> V7 接受第一筆 normalized 寫入後，不可重新啟用 V6 整包 writer；異常須 forward-fix，否則會遺失切換後逐項資料。

## 日常使用

1. 輸入網站進入密碼。
2. 使用內部 Owner / 管理員 / 使用者帳號登入。
3. 點擊 module 或 record 取得該項目編輯權。
4. 不同項目可由多人同時編輯；同項目被占用時保持唯讀。
5. 一般修改會逐項提交；「保存修改」可 flush 未完成草稿。RPC 無回應時會在明確時限後失敗並保留 module 與 report metadata 草稿，不會永久停在「正在保存」；timeout error 會標出實際 RPC 與耗時。重新載入 snapshot 時會恢復草稿。再次保存會先對帳 pending，再嘗試 claim 目前 lease：若舊 operation 已是 terminal result，直接取回結果並釋放本頁任何新 lease；只有伺服器明確回覆 `LEASE_LOST` 後，才以目前 lease 與新 operation ID 提交同一份草稿。新 pending envelope 會綁定 actor；不同 actor 或 `IDEMPOTENCY_MISMATCH` 都保留 pending 證據並 fail closed。
6. 若顯示 `REVISION_CONFLICT`，目前內容會先保留成本機草稿，不會直接覆蓋雲端。再次按「保存修改」會明確詢問：確定後才以目前畫面內容取得最新 revision 並重試一次；取消則雲端不變且草稿繼續保留。
7. 「同步最新」透過 change sequence 補抓並逐項重讀，不覆蓋有草稿的項目。
8. PDF 輸出會先確認 module 與 report metadata 都已成功提交且沒有待處理草稿，才建立正式 immutable snapshot；前置保存失敗時禁止輸出舊雲端內容，timeout 會標出 `save_data`／`create_snapshot`／`prepare_print` 階段、RPC 與耗時。重新登入後，同一 workspace／report／snapshot kind 的既有 pending 快照會沿用 operation ID，由後端 actor 與 idempotency 驗證後接續；回傳 snapshot 的 report revision、watermark 與各 module revision 必須涵蓋剛保存後的最低狀態，否則改用新 operation 建立快照。分頁按 A4 landscape 的 192mm 實際內容高度與第一頁表頭後剩餘空間量測：首項若會被整卡換頁而留下純表頭首頁，改為從第一頁自然跨頁；後續單頁可容納的項目保持整卡，超過單頁的長項目自然分頁。
9. IndexedDB 歷史仍是裝置本機資料；它不會被宣稱為已完整遷移到 Supabase。

## 權限

- **Owner**：管理所有帳號與 Owner 轉移、Supabase 設定、非 Owner 刪除、月報 module 刪除、進站密碼、同步與保存。
- **管理員**：管理非 Owner 帳號、進站密碼、同步與保存；不能建立／修改／刪除 Owner、看不到 Supabase 設定、不能刪除月報 module。
- **使用者（operator）**：編輯 module/record、同步與保存；不能進入數據管理或刪除月報 module。

最終權限由 server RPC transaction 驗證，前端按鈕隱藏不是安全邊界。

## 本機驗證

```bash
npm install
npm test
npm run test:browser
```

- `npm test`：core/client/HTML 契約與 PGlite PostgreSQL runtime tests。
- `npm run test:browser`：隔離 fake Supabase，驗證雙瀏覽器同項排他／不同項並行、full-snapshot 草稿保護、保存逾時後重試與新瀏覽器雲端讀回，以及 immutable PDF 的前置保存與列印來源。
- 正式 Supabase 尚須依切換手冊執行 readback 與 smoke tests；本機通過不能冒充正式環境已部署。
