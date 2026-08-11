# 月度安全會議報告 V7 部署與切換手冊

本次升級把原本單列 `payload JSONB` 整包寫入，改為逐 module、逐 record 的 normalized authority。

> [!IMPORTANT]
> 本手冊不要求在聊天或 GitHub 提交任何密碼、anon key、Workspace Key 或其他憑證。所有 SQL 請在 Supabase Dashboard 的 SQL Editor 執行。

## 切換後的正確模型

- 每張月報 module 卡片一列、一把短期 lease。
- 五類資料記錄每筆一列、一把短期 lease。
- metadata、structure、KPI batch 使用獨立短交易 lease。
- 保存同時驗證 user session、client session、lease ID、fencing token 與 expected revision。
- `operation_id` 去重，網路回覆遺失時可以安全重送。
- Realtime event 不帶 payload，只通知 entity ID/revision；client 再逐項重讀。
- PDF 使用資料庫短 barrier 建立不可變 snapshot。
- 舊 bundle 保留為 read-only migration evidence，切換後不能再寫。

## 切換前檢查

1. 確認目前 V6 正式雲端資料可正常同步。
2. 在現有數據管理頁匯出完整 JSON 備份。
3. 重要裝置若有 IndexedDB 歷史或未保存草稿，另外匯出並列清單。
   - Supabase 無法自動發現其他裝置的 IndexedDB。
   - 本機草稿不是正式雲端事實，不會自動覆蓋 V7 authority。
4. 確認 legacy 使用者資料中恰好一位 Owner；不可為零位或多位。
5. 在 Supabase Dashboard 啟用 **Authentication → Providers → Anonymous Sign-Ins**。
6. 確認 GitHub Desktop 指向這一個 repository，不建立第二份 clone。

## 第一步：執行 additive migration

在 Supabase SQL Editor 完整執行：

```text
docs/supabase-schema-v7.sql
```

這一步會：

- 建立 V7 tables、RPC、RLS、Realtime hint policy。
- 所有使用 pgcrypto 的函式固定以 `pg_catalog, extensions, public` 搜尋，符合 Supabase 將 `digest/crypt/gen_salt` 安裝在 `extensions` schema 的配置。
- 保存 legacy bundle 的不可變 snapshot。
- 拆分 report/modules/records/users/site password hash。
- 對 report、modules、records、users、site hash 各自計算 SHA-256 projection hash。
- 驗證筆數、內容、順序、唯一 Owner；任一不符即整筆 transaction 失敗。
- 重新包裝 V6 get/upsert，加上 server-side authority gate。
- **仍保持 `LEGACY_ACTIVE`，不會立即停用現場 V6 writer。**

執行後可用以下唯讀查詢確認；結果不含密碼 hash：

```sql
select
  legacy_workspace_key,
  authority_state,
  authority_epoch,
  minimum_client_version
from public.monthly_v7_workspaces;

select
  source_revision,
  report_count,
  module_count,
  record_count,
  user_count,
  owner_count,
  report_sha256,
  module_sha256,
  record_sha256,
  user_sha256,
  site_sha256,
  completed_at
from public.monthly_v7_migration_receipts
order by completed_at desc;
```

預期：

- `authority_state = LEGACY_ACTIVE`
- `owner_count = 1`
- 五個 projection hash 均為 64 位十六進位值
- counts 與現有資料一致

如果 SQL 顯示 `MIGRATION_*_MISMATCH`、`LEGACY_OWNER_COUNT_MUST_BE_ONE` 或任何錯誤：**停止，不要執行 activation，也不要清資料。**

## 第二步：Push GitHub Pages 版本

1. 使用 GitHub Desktop Push 本次 commit。
2. 等待既有 Pages workflow 完成。
3. 確認網址仍為原 GitHub Pages 網址。
4. 重新開啟頁面，確認 scripts 能載入。

在 activation 前，頁面讀到 `LEGACY_ACTIVE` 時仍使用 V6 相容流程；不要把此階段誤稱為 V7 已切換完成。

## 第三步：短暫維護與 authority activation

1. 通知所有使用者暫停修改並關閉舊分頁。
2. 在 Supabase SQL Editor 完整執行：

```text
docs/supabase-schema-v7-activate.sql
```

此 transaction 會：

1. 鎖定 workspace authority row。
2. 等待已開始的 V6 save 完成。
3. 切到 `DRAINING/FROZEN`，新 V6 writer 立即在伺服器端被擋。
4. 從最新 legacy bundle 再跑一次 migration 與完整 hash 對帳。
5. 清除 pre-activation site/user sessions 與 leases。
6. 原子切到 `NORMALIZED_ACTIVE`、增加 authority epoch、最低 client version 設為 7。
7. 撤銷 V6 get/upsert 對 anon/authenticated 的 execute 權限。

- `NORMALIZED_ACTIVE` 後從 `PUBLIC`、`anon`、`authenticated` 全部撤銷 V6 get/upsert 的 execute；只撤銷具名角色不足，因 PostgreSQL 函式預設仍可能透過 `PUBLIC` 繼承 execute。
- 成功後所有人重新整理，重新輸入進站密碼與內部帳號密碼。

## 最低正式驗收

使用兩個不同瀏覽器或無痕 context：

1. A 取得 module 1 編輯權；B 同項目不能編輯。
2. B 同時取得 module 2；A/B 保存後兩項都保留。
3. 同類 record X/Y 可以並行。
4. 同一 record 競爭只有一方 claim 成功。
5. A 失聯、lease 過期，B 接管後，A 舊 fencing token 保存失敗。
6. 保存 RPC 成功但回覆遺失時，同 operation ID 重送只增加一次 revision/audit。
7. Realtime 只刷新變動項，不覆蓋有本機草稿的項目。
8. 刪除 record/module 必須雲端成功後才從畫面消失。
9. KPI 多 module 更新全成或全不成。
10. Owner/Admin/Operator 與 site password rotation 權限正確。
11. 點「登出」只撤銷 user session，網站保持已解鎖；重新登入成功。server 主動回 `READ_SESSION_INVALID`／`USER_SESSION_INVALID` 時身份列立即收斂為未登入，本機草稿仍存在且不重送舊 RPC。
12. PDF、Excel、JSON、CSV、附件、手機/桌面版面無回歸；12 模塊正式 PDF 第一頁不得只剩表頭，長項自然跨頁且順序不變。

## 異常與回復原則

- activation 前：可以修 migration 或資料後重跑 additive SQL；正式 authority 尚未切換。
- activation 後：**不可重新啟用舊整包 writer。** 舊 bundle 不含切換後逐項寫入，回退會遺失資料。
- activation 後遇到問題採 forward-fix / `NORMALIZED_MAINTENANCE`，先保留 normalized rows、audit、operation ledger、snapshot 與本機草稿。
- 不要因畫面異常就刷新、清 localStorage、清 IndexedDB 或刪資料；先保存草稿與錯誤資訊。

## 本機驗證命令

```bash
npm install
npm test
npm run test:browser
```

- `npm test`：core/client/HTML 契約及 PGlite 真 SQL runtime 測試。
- `npm run test:browser`：隔離 fake Supabase 的雙瀏覽器同項排他／不同項並行、full-snapshot 草稿保護及 immutable PDF 來源驗收。
- PGlite 與 fake backend 不等於正式 Supabase；正式環境仍須依上方 smoke tests 驗收。
