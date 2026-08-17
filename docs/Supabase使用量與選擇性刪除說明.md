# Supabase 使用量、Storage 與選擇性刪除說明

> 適用範圍：月度安全會議報告系統 V7 normalized authority、專題報告，以及公開 `report-assets` Bucket。
> 本文件說明目前 repo 實際程式與 SQL 的行為，不記錄某一次正式環境的瞬時用量。正式數值應在「數據管理 → Supabase 空間使用」按「刷新空間」取得。

---

## 1. 一頁摘要

### Supabase 在本系統負責什麼

| 類別 | 儲存位置 | 內容 |
|---|---|---|
| 月報正式資料 | Supabase PostgreSQL | 月報主資料、逐項內容、一般記錄、Revision、快照、使用者、Session、Lease、Operation、Change Event |
| 專題正式資料 | Supabase PostgreSQL | 專題報告 JSONB、Revision、狀態、快照、Lease、Operation |
| 未來新增圖片／附件 | Supabase Storage | 月報與專題的新圖片、新附件，存於公開 `report-assets` Bucket |
| 舊圖片／附件 | Supabase PostgreSQL JSONB | 既有 Base64／`data:` 內容繼續保留，不自動搬移 |
| 網站程式 | GitHub Pages | HTML、JavaScript、CSS；不占 Supabase Storage |
| 本機歷史月報 | 瀏覽器 IndexedDB | 只存在目前瀏覽器，不計入 Supabase 用量 |

### 現行刪除原則

1. **月報 PDF 快照**：Owner 可選一份保留，只刪除同一月報的其他 `pdf` 快照。
2. **專題報告**：Owner 可軟刪除；清單會隱藏，但資料列與快照仍可能占 PostgreSQL 物理空間。
3. **月報項目／一般記錄**：採 Revision、Lease、CAS 控制的軟刪除。
4. **圖片／附件**：畫面移除時只刪除報告內的引用，**第一版不刪 Storage object**。
5. **Storage object**：目前沒有 UI、RPC 或 DELETE policy 可做選擇性刪除。

---

## 2. 整體架構與權威邊界

### 2.1 PostgreSQL 是正式資料權威

V7 啟用後，月報與專題的正式資料以 Supabase PostgreSQL 為準。主要資料群如下：

- `monthly_v7_workspaces`：Workspace 與 authority 狀態。
- `monthly_v7_reports`：月報主資料。
- `monthly_v7_report_items`：月報逐項內容。
- `monthly_v7_record_items`：檢查、缺失、滯留、行動、訓練等一般記錄。
- `monthly_v7_report_snapshots`：月報不可變快照。
- `monthly_v7_topic_reports`：專題報告主資料與 JSONB 內容。
- `monthly_v7_topic_report_snapshots`：專題正式快照。
- `monthly_v7_users`、site/user sessions：應用程式身份與登入 Session。
- Lease、Operation、Entity Event、Change Event：多人協作、CAS、冪等重送及追蹤所需資料。

瀏覽器不直接把資料表當作一般 CRUD API。正式操作透過 `SECURITY DEFINER` RPC，並在伺服器核對 Workspace、應用程式 user session、角色、Revision、Lease、fencing token 與 operation ID。

### 2.2 Supabase Auth 與應用程式身份是兩層

- Supabase Auth anonymous session 提供 Storage／RPC transport 所需的 `authenticated` JWT。
- Owner、Admin、Operator 是本系統自己的 `monthly_v7_users` 身份。
- 涉及正式資料的 RPC 仍會核對本系統 user session；只有拿到 Supabase anonymous JWT 不等於取得 Owner 權限。
- `report-assets` 的 Storage INSERT policy 本身只檢查 `authenticated`、Bucket 與 canonical path，不直接解析 Owner／Admin／Operator。正常 UI 仍要求已登入且可寫入的應用程式狀態後才上傳。

---

## 3. `report-assets` Storage 設定

### 3.1 Bucket

- Bucket ID：`report-assets`
- 類型：Public
- 讀取：持有 public URL 即可讀取。
- 上傳：Supabase `authenticated` role。
- `file_size_limit`：`null`，沿用 Supabase Project／方案限制。
- `allowed_mime_types`：`null`，Bucket 不額外限制 MIME；前端仍可有自己的限制。

SQL：`docs/supabase-storage-report-assets.sql`

### 3.2 Canonical object path

```text
monthly/<report-id>/images/<uuid>.<ext>
monthly/<report-id>/attachments/<uuid>.<ext>
topic/<report-id>/images/<uuid>.<ext>
topic/<report-id>/attachments/<uuid>.<ext>
```

規則：

- domain 只允許 `monthly` 或 `topic`。
- kind 只允許 `images` 或 `attachments`。
- report segment 僅允許安全字元。
- object 檔名使用 UUID，不使用原始檔名，避免碰撞及在 URL 暴露檔名。
- 上傳固定 `upsert:false`，不覆寫既有 object。
- `cacheControl` 為 31,536,000 秒（一年）；因 object path 不可變，可安全長期快取。

### 3.3 新舊格式並存

#### 舊格式

```json
{
  "name": "old.pdf",
  "data": "data:application/pdf;base64,..."
}
```

或圖片直接在 HTML 中使用 `data:image/...;base64,...`。

#### 新格式

```json
{
  "name": "new.pdf",
  "type": "application/pdf",
  "size": 12345,
  "bucket": "report-assets",
  "path": "monthly/<report-id>/attachments/<uuid>.pdf",
  "url": "https://<project>.supabase.co/storage/v1/object/public/report-assets/..."
}
```

行為：

1. 新檔案先上傳二進位到 Storage。
2. 等 Storage ACK 且 public URL 驗證成功後，才把 reference 放進報告內容。
3. 上傳失敗或逾時時，不插入引用，也不回退成新 Base64。
4. 舊 Base64 與新 public URL 都能顯示、保存、重開、建立 snapshot 及輸出 PDF。
5. 新 public URL 是線上引用；只匯出 JSON 並不等於把新附件二進位一起離線備份。

### 3.4 前端檔案限制

- 專題圖片：單檔最多 5 MiB，限制 PNG／JPEG／WebP／GIF。
- 專題附件：單檔最多 6 MiB，單一專題附件合計最多 16 MiB，並限制允許的附件類型。
- 月報目前主要依 Storage／Project 的上傳限制；Bucket 本身沒有另設 MIME 或檔案大小白名單。

### 3.5 第一版為什麼不刪 object

同一個 public URL 可能同時被下列內容引用：

- 目前月報／專題內容。
- 舊 Revision 的正式 snapshot。
- PDF 快照或歷史快照。
- 本機草稿或 JSON 備份。

若畫面移除附件時立刻刪除 object，舊快照會變成破圖或無法下載。因此目前設計是：

- 編輯器刪除圖片／附件：只刪報告引用。
- 刪月報項目或軟刪專題：不刪 object。
- SQL 不建立 Storage UPDATE／DELETE policy。
- 前端 Storage helper 不提供 `remove()`。

代價是可能產生 orphan object。未來若要清理，必須先建立跨目前內容、所有 snapshot 與必要備份的 reference scanner，再以 retention／garbage-collection 流程刪除。

---

## 4. 使用量如何調取

### 4.1 入口與權限

畫面入口：

```text
登入 Owner／Admin → 數據管理 → Supabase 空間使用 → 刷新空間
```

核心 RPC：

```text
monthly_v7_get_storage_stats
```

參數：

- `p_workspace_key`
- `p_user_session_id`
- `p_client_session_id`

伺服器行為：

- 核對 Workspace 與有效應用程式 user session。
- 只有 Owner／Admin 可取得核心空間總覽；其他角色回 `FORBIDDEN`。
- RPC 只授權 Supabase `authenticated` 執行，真正角色仍由 RPC 內部判斷。

### 4.2 畫面同時讀取三個來源

按「刷新空間」時，前端並行取得：

1. `monthly_v7_get_storage_stats`：資料庫總量、App 表物理量、Storage 合計、逐月報邏輯量。
2. `monthly_v7_topic_list_reports`：逐專題邏輯量與狀態。
3. IndexedDB 本機歷史：只計算目前瀏覽器保存的月報 JSON bytes。

Topic 或 IndexedDB 單一來源失敗時，其他成功區塊仍會保留並顯示；不會因一區失敗把全部結果清空。前端也會：

- 依目前 actor 快取結果。
- 切換身份時清除上一個 actor 的空間狀態。
- 用 request ID 阻止晚到的舊請求覆蓋新身份結果。
- 手動按「刷新空間」時強制重新讀取。
- 刷新失敗但已有舊資料時，保留舊結果並顯示最近錯誤。

### 4.3 四種不同的用量

| UI 指標 | SQL／來源 | 真正意義 | 不應如何解讀 |
|---|---|---|---|
| Supabase 資料庫總用量 | `pg_database_size(current_database())` | 整個 PostgreSQL database 的物理大小 | 不是只有本 App，也不等於可立即釋放量 |
| 本系統資料表用量 | `sum(pg_total_relation_size(...))` | `monthly_v7_*` 與 legacy cloud table 的 heap、index、TOAST 等物理量 | 不要再與 database total 相加；它是 database total 的子集合 |
| Supabase Storage 檔案 | `storage.objects` 的 object count 與 `metadata.size` 合計 | 整個 Supabase Project 所有 Bucket 的 object 合計 | 目前不是只算 `report-assets`，也不能按報告拆分 |
| 單一報告邏輯量 | `pg_column_size(row)` 加總 | 可歸屬到該月報／專題目前內容與 snapshot 的邏輯 bytes | 不是共享 PostgreSQL 磁碟頁面的實體分攤 |

UI 使用二進位單位：

- 1 KiB = 1,024 bytes
- 1 MiB = 1,048,576 bytes
- 1 GiB = 1,073,741,824 bytes

### 4.4 月報邏輯量

每一份未刪除的月報回傳：

```text
contentBytes
  = pg_column_size(月報主列)
  + sum(pg_column_size(月報項目列))

snapshotBytes
  = sum(pg_column_size(該月報所有 snapshot 列))

logicalBytes
  = contentBytes + snapshotBytes
```

另外回傳每一筆 `snapshot_kind='pdf'` 的：

- snapshot ID
- report Revision
- content SHA-256
- 建立時間
- 建立者
- 該 snapshot 邏輯 bytes

帳號、Session、Lease、Operation、Event、共用一般記錄不會分攤到某一份月報；它們只會反映在「本系統資料表用量」。

### 4.5 專題邏輯量

目前 SQL 以：

```text
logicalBytes
  = pg_column_size(專題 report row)
  + sum(pg_column_size(專題 snapshot row))

snapshotBytes
  = sum(pg_column_size(專題 snapshot row))
```

並回傳專題系統編號、名稱、日期、Revision、狀態、模塊數量、更新者與目前是否有人持有編輯 Lease。

#### 現行 repo 限制：`contentBytes`

`index.html` 的專題統計表有「目前內容」欄，測試 fake 也提供 `contentBytes`；但目前 `docs/supabase-schema-v7-data-management-storage.sql` 中的 `monthly_v7_topic_list_reports` 只明確回傳 `logicalBytes` 與 `snapshotBytes`，沒有獨立的 `contentBytes` 欄位。

因此只按目前 repo SQL 部署的環境，專題「目前內容」可能顯示 `—`；總邏輯量與 snapshot bytes 仍可用。數學上可由 `logicalBytes - snapshotBytes` 推得，但現行 UI 沒有做這個 fallback。本文件只記錄現況，不把預期值冒充已部署功能。

### 4.6 本機歷史月報

本機列的 `localBytes` 使用：

```javascript
new TextEncoder().encode(JSON.stringify(row)).byteLength
```

它只代表目前瀏覽器 IndexedDB 中該 JSON 的 UTF-8 bytes：

- 不計入 Supabase。
- 未連結 V7 的本機列不會出現在其他裝置。
- 清除網站資料、IndexedDB 或換瀏覽器後可能消失。
- 畫面會標示「已連結上方 V7 雲端月報」或「僅此瀏覽器」。

### 4.7 為什麼刪除後數字可能不立刻下降

- 邏輯量：刪除 snapshot row 後通常會立即下降。
- PostgreSQL 物理量：MVCC、dead tuples、index／TOAST page 與可重用空間可能仍保留，因此 `pg_database_size` 或 `pg_total_relation_size` 不一定立即縮小。
- Supabase Dashboard：可能另外計入備份、WAL 或平台保留空間；這些不在目前 RPC 的可讀範圍。
- 軟刪除：資料列仍存在，只是 `deleted_at` 不為空，物理 bytes 仍在。
- Storage 引用刪除：object 本身保留，所以 Storage bytes 不下降。

---

## 5. 選擇性刪除功能

### 5.1 月報 PDF 快照：只保留所選版本

入口：

```text
數據管理 → 月報內容與快照邏輯量 → PDF 快照管理
```

UI 行為：

1. 只在該月報有至少 2 份 PDF 快照時顯示操作。
2. 下拉選擇要保留的 snapshot。
3. 按「只保留選擇版本」。
4. 確認視窗列出月報、刪除份數及保留版本。
5. 成功後強制刷新空間統計。

RPC：

```text
monthly_v7_prune_report_pdf_snapshots
```

只允許 Owner。刪除範圍：

```sql
snapshot_kind = 'pdf'
and report_id = 指定月報
and snapshot_id <> 指定保留ID
```

不會刪除：

- 月報主資料或項目。
- `published`／`manual`／`history` 等非 PDF snapshot。
- 一般記錄、使用者或協作資料。
- 專題資料。
- Supabase Storage object。

#### 防誤刪／併發邏輯

- Client 傳送預覽時看到的完整 PDF snapshot ID 集合。
- Server 在 transaction 中重新讀取目前集合；不完全一致即回 `SNAPSHOT_SET_CHANGED`，整次不刪除。
- 保留 ID 必須真的屬於該月報的 PDF snapshot，否則 `KEEP_SNAPSHOT_INVALID`。
- 先鎖指定 report row，再短暫鎖 snapshot table，避免清理期間新 PDF snapshot 被誤納入刪除。
- operation ID、actor、Workspace 與 request hash 綁定；相同 operation 可冪等重播，參數不同則 `IDEMPOTENCY_MISMATCH`。
- timeout／lost ACK 時保留 pending envelope；下一次先對帳原 operation，而不是直接建立另一筆刪除。
- 回傳 `deletedCount`、`deletedBytes` 與 `remainingPdfSnapshotCount=1`。

### 5.2 專題報告刪除

RPC：

```text
monthly_v7_topic_delete_report
```

規則：

- 只有 Owner 可刪除。
- 使用預期 Revision 做 CAS；Revision 已變動則 `REVISION_CONFLICT`。
- 有有效編輯 Lease 時拒絕刪除並回 `LEASE_HELD` 與持有人。
- 操作採 operation ID／request hash 冪等保護。
- 成功時設定 `deleted_at`、Revision 加一，並結束相關 Lease。
- 清單與空間逐專題列表只查 `deleted_at is null`，所以刪除後立即隱藏。

這是**軟刪除**：

- 專題 report row 不會被實體 DELETE。
- 專題 snapshots 不會因軟刪除自動清除。
- 它會從逐專題邏輯量清單消失，但仍可能占「本系統資料表用量」。
- Storage object 不會刪除。

### 5.3 月報項目與一般記錄

月報項目與一般記錄的刪除屬正常業務操作，不是空間清理工具：

- 月報項目刪除需要 report structure lease、module lease、對應 fencing token 與 Revision。
- 一般記錄刪除需要該筆 entity lease、fencing token 與預期 Revision。
- 成功後設定 `deleted_at` 並增加 Revision，保留事件／operation 證據。
- 這些也是軟刪除，不能保證 PostgreSQL 物理量下降。

### 5.4 圖片與附件移除

月報與專題目前一致：

```text
畫面刪除 → 移除 HTML／JSON 中的 public URL 或附件 reference
           → 保存新的 report Revision
           → 不呼叫 Storage DELETE
```

所以：

- 報告畫面不再顯示該附件。
- 舊 snapshot 仍可使用原 URL。
- Storage object count／bytes 不下降。
- 若上傳成功但報告未保存，object 也可能成為 orphan。

### 5.5 目前沒有的刪除能力

- 沒有按單一月報／專題列出 Storage objects 的功能。
- 沒有 Storage object 選擇性刪除 UI。
- 沒有自動 orphan garbage collector。
- 沒有因軟刪專題就硬刪其 snapshot 或 Storage object。
- 沒有在空間統計頁硬刪整份月報正式資料的功能。

不要直接在 Supabase Dashboard 手動刪 `storage.objects` 或業務資料列，否則可能破壞舊 snapshot、Revision、Lease、operation replay 與正式 PDF 可重現性。

---

## 6. 權限矩陣

| 功能 | Owner | Admin | Operator |
|---|---:|---:|---:|
| 進入數據管理 UI | 是 | 是 | 否 |
| 讀核心空間統計 RPC | 是 | 是 | 否（Server 回 `FORBIDDEN`） |
| 查看月報／專題／本機分區 | 是 | 是 | UI 不提供 |
| 清理月報 PDF snapshots | 是 | 否 | 否 |
| 軟刪專題報告 | 是 | 否 | 否 |
| 上傳一般報告圖片／附件 | 依正常編輯權 | 依正常編輯權 | 依正常編輯權 |
| 直接刪 Storage object | 無 | 無 | 無 |

> 注意：Public Bucket 的讀取不需要應用程式登入；持有 public URL 即可讀取。這是目前選用 Public Bucket 的既定行為。

---

## 7. 錯誤與狀態處理

### 空間統計

- `WORKSPACE_NOT_FOUND`：Workspace 不存在。
- `USER_SESSION_INVALID`／相關 session 錯誤：清除應用程式身份並要求重新登入。
- `FORBIDDEN`：角色無權讀核心統計。
- Topic／IndexedDB 子來源失敗：只顯示該分區錯誤，保留其他區塊。

### PDF 快照清理

- `OWNER_REQUIRED`：不是 Owner。
- `AUTHORITY_NOT_ACTIVE`：V7 normalized authority 未啟用。
- `ENTITY_NOT_FOUND`：月報不存在或已刪除。
- `SNAPSHOT_SET_CHANGED`：使用者預覽後 snapshot 集合已變動；UI 刷新後要求重選。
- `KEEP_SNAPSHOT_INVALID`：保留 ID 不在目前 PDF snapshots 中。
- `IDEMPOTENCY_MISMATCH`：同 operation ID 對應到不同請求。
- `RPC_TIMEOUT`／網路錯誤：結果未確認，保留 pending 供原 operation 對帳。

### Storage 上傳

- Storage client 未就緒：不插入檔案引用。
- 上傳失敗／逾時：不回退 Base64。
- public URL 驗證失敗：不把 URL 寫入報告。
- 上傳已完成但後續保存失敗：object 保留，報告引用仍以正常草稿／保存流程處理。

---

## 8. 操作手冊

### 查看最新使用量

1. 使用 Owner 或 Admin 登入。
2. 進入「數據管理」。
3. 找到「Supabase 空間使用」。
4. 按「刷新空間」。
5. 分別閱讀：
   - 資料庫總用量。
   - 本系統資料表用量。
   - Storage object bytes／count。
   - 月報逐項邏輯量。
   - 專題逐項邏輯量。
   - 本機 IndexedDB 月報。
6. 不要把上述數字相加成一個總量，因為它們的範圍有包含關係或位於不同儲存系統。

### 選擇性清理月報 PDF snapshots

1. 使用 Owner 登入。
2. 先按「刷新空間」。
3. 在指定月報的 PDF 快照管理選擇要保留的版本。
4. 按「只保留選擇版本」。
5. 核對月報名稱、日期、Revision、建立時間與刪除份數。
6. 確認後等待完成，不要重複點擊或刷新。
7. 成功後核對：
   - 該月報剩 1 份 PDF snapshot。
   - 月報正常內容沒有改變。
   - 非 PDF snapshots 沒有改變。
   - 顯示的邏輯量下降。
8. 不以 database physical bytes 是否立即下降作為成功判定。

### 移除圖片／附件

1. 在月報或專題編輯器移除圖片／附件。
2. 保存並等待雲端 ACK。
3. 這只移除報告引用；不要期待 Storage object bytes 下降。

---

## 9. 正式環境 SQL／檔案對照

建議依既有 migration 順序維護；不要只挑後段 destructive RPC 單獨執行。

| 檔案 | 作用 |
|---|---|
| `docs/supabase-schema-v7.sql` | V7 normalized 月報、記錄、身份、Session、Lease、Operation、Snapshot 基礎 |
| `docs/supabase-schema-v7-delete-module-repair.sql` | 月報項目刪除 lease／ACL 修正 |
| `docs/supabase-schema-v7-trusted-device-resume.sql` | 可信裝置與 user/site resume |
| `docs/supabase-schema-v7-topic-reports.sql` | 專題報告、Lease、Operation、Snapshot |
| `docs/supabase-schema-v7-topic-reports-v2.sql` | 專題 Owner 軟刪除 |
| `docs/supabase-schema-v7-data-management-storage.sql` | 密碼權限矩陣、空間統計、月報 PDF snapshot 選擇性清理 |
| `docs/supabase-storage-report-assets.sql` | Public `report-assets` Bucket 與 INSERT-only policy |
| `docs/supabase-schema-v7-activate.sql` | 正式切換 authority；應依既有 cutover 流程執行 |
| `report-assets-storage.js` | immutable path、上傳、public URL 驗證與下載 URL |
| `monthly-collaboration-client.js` | 使用量 RPC、Topic 清單及 snapshot prune client 邏輯 |
| `index.html` | 數據管理 UI、三來源並行刷新與確認流程 |

---

## 10. 驗證清單

### Storage

- [ ] `report-assets` 是 Public Bucket。
- [ ] authenticated 可 INSERT canonical path。
- [ ] 沒有 UPDATE／DELETE policy。
- [ ] 新月報圖片、新月報附件、新專題圖片、新專題附件都保存 public URL。
- [ ] 舊 Base64 仍能顯示、下載與列印。
- [ ] 移除引用後 object 仍存在。

### 使用量

- [ ] Owner／Admin 可刷新核心統計。
- [ ] Operator 無法進入數據管理。
- [ ] database total ≥ app relation physical bytes。
- [ ] Storage count／bytes 與 `storage.objects` metadata 一致。
- [ ] 月報 content／snapshot／logical bytes 公式一致。
- [ ] Topic 或 IndexedDB 讀取失敗不會清掉其他分區。
- [ ] 本機月報明確標示不計入 Supabase。

### 選擇性刪除

- [ ] 只有 Owner 看得到並可執行 PDF snapshot prune。
- [ ] 只能保留目前集合中的一筆 PDF snapshot。
- [ ] snapshot 集合變動時 fail closed 並要求重選。
- [ ] `published`／`manual`／`history` 與目前月報內容不受影響。
- [ ] timeout 後重播同一 operation，不重複刪除。
- [ ] 專題刪除是軟刪除，且 active lease／revision drift 會阻擋。
- [ ] 任何報告刪除或附件移除都不會自動刪 Storage object。

---

## 11. 現行限制與未來擴充

1. Storage 指標是整個 Project 所有 Bucket 的合計，不是 `report-assets` 專用值。
2. Storage object 尚不能按月報、專題或單一 report ID 分攤。
3. 沒有 Storage orphan GC 或 reference scanner。
4. 專題軟刪除後仍可能占 PostgreSQL 物理空間。
5. PostgreSQL 物理大小不等於可立即回收大小。
6. 新 Storage references 需要連線才能讀取；JSON 備份不是完整離線資產包。
7. 專題 `contentBytes` 在目前 repo SQL 與 UI 欄位之間存在前述差異。
8. 本文件不代表已對正式 Supabase Project 做即時 readback；正式狀態仍須由 UI 刷新結果或受控 SQL readback 確認。

未來若要增加 Storage 選擇性清理，最低安全條件應包括：

- 以 bucket/path 建立 object inventory。
- 掃描目前月報／專題、所有 snapshot 與保留中的備份引用。
- 只把零引用 object 列為候選。
- 顯示 object size、上傳時間、report/domain、引用數與預估釋放量。
- Owner 明確勾選並二次確認。
- 使用 operation ID、expected object set 與 lost-ACK replay。
- 先做 dry run，再執行 DELETE。
- 刪除後重新讀取 Storage 與資料庫 references 驗證。
