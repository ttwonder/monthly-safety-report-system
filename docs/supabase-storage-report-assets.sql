-- 月度安全會議報告系統：公開 report-assets Storage Bucket
-- 執行方式：由 Owner 在 Supabase SQL Editor 手動執行一次。
-- 設計：公開讀取、authenticated（含 Supabase anonymous auth）只可新增；不提供覆寫或刪除 policy。

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'report-assets',
  'report-assets',
  true,
  null,
  null
)
on conflict (id) do update
set name = excluded.name,
    public = true,
    file_size_limit = null,
    allowed_mime_types = null;

-- 僅允許本 App 的 canonical immutable path：
-- monthly|topic / report-id / images|attachments / UUID.ext
-- 不建立 UPDATE／DELETE policy；前端也固定 upsert:false。
drop policy if exists "report_assets_authenticated_insert" on storage.objects;
create policy "report_assets_authenticated_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'report-assets'
  and (storage.foldername(name))[1] in ('monthly', 'topic')
  and (storage.foldername(name))[2] ~ '^[a-z0-9_-]{1,96}$'
  and (storage.foldername(name))[3] in ('images', 'attachments')
  and array_length(storage.foldername(name), 1) = 3
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,10}$'
);
