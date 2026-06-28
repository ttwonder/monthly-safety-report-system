-- 月度安全會議報告系統 V6 Supabase schema
-- 用途：多人協作安全版，增加 revision 樂觀鎖、保存歷史、區塊軟鎖。
-- 執行方式：Supabase SQL Editor 直接執行全文。可重複執行。
-- 安全說明：仍使用 Workspace Key 共享模式；只可在前端放 anon public key，不可放 service_role key。

create table if not exists public.monthly_report_cloud_data (
  workspace_key text primary key,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.monthly_report_cloud_data
  add column if not exists revision bigint not null default 1,
  add column if not exists updated_by text;

create table if not exists public.monthly_report_revisions (
  id bigserial primary key,
  workspace_key text not null,
  revision bigint not null,
  payload jsonb not null,
  saved_by text,
  saved_at timestamptz not null default now()
);

create index if not exists idx_monthly_report_revisions_workspace_revision
  on public.monthly_report_revisions(workspace_key, revision desc);

create table if not exists public.monthly_report_editing_locks (
  workspace_key text not null,
  section_key text not null,
  locked_by text not null,
  locked_by_name text,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (workspace_key, section_key)
);

create index if not exists idx_monthly_report_editing_locks_expires
  on public.monthly_report_editing_locks(expires_at);

create or replace function public.set_monthly_report_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_monthly_report_cloud_data_updated_at on public.monthly_report_cloud_data;
create trigger trg_monthly_report_cloud_data_updated_at
before update on public.monthly_report_cloud_data
for each row execute function public.set_monthly_report_updated_at();

alter table public.monthly_report_cloud_data enable row level security;
alter table public.monthly_report_revisions enable row level security;
alter table public.monthly_report_editing_locks enable row level security;

revoke all on public.monthly_report_cloud_data from anon, authenticated;
revoke all on public.monthly_report_revisions from anon, authenticated;
revoke all on public.monthly_report_editing_locks from anon, authenticated;

-- 讀取目前雲端包，同時回傳 revision，用於保存前衝突檢查。
-- 舊 V4 函數回傳欄位較少，需先 drop 才能改 return type。
drop function if exists public.get_monthly_report_cloud_data(text);

create or replace function public.get_monthly_report_cloud_data(p_workspace_key text)
returns table(payload jsonb, updated_at timestamptz, revision bigint, updated_by text)
language sql
security definer
set search_path = public
as $$
  select m.payload, m.updated_at, m.revision, m.updated_by
  from public.monthly_report_cloud_data m
  where m.workspace_key = p_workspace_key
  limit 1;
$$;

-- V6 保存：必須帶 p_expected_revision；若雲端 revision 已變，返回 conflict，不覆蓋。
-- 移除舊 V4 兩參數 upsert，避免舊前端繼續 last-write-wins 覆蓋。
drop function if exists public.upsert_monthly_report_cloud_data(text, jsonb);

create or replace function public.upsert_monthly_report_cloud_data(
  p_workspace_key text,
  p_payload jsonb,
  p_expected_revision bigint default null,
  p_saved_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.monthly_report_cloud_data%rowtype;
  next_revision bigint;
begin
  select * into current_row
  from public.monthly_report_cloud_data
  where workspace_key = p_workspace_key
  for update;

  if not found then
    insert into public.monthly_report_cloud_data(workspace_key, payload, revision, updated_by)
    values (p_workspace_key, p_payload, 1, p_saved_by)
    returning * into current_row;

    insert into public.monthly_report_revisions(workspace_key, revision, payload, saved_by, saved_at)
    values (p_workspace_key, current_row.revision, p_payload, p_saved_by, current_row.updated_at);

    return jsonb_build_object(
      'ok', true,
      'conflict', false,
      'workspace_key', p_workspace_key,
      'revision', current_row.revision,
      'updated_at', current_row.updated_at,
      'updated_by', current_row.updated_by
    );
  end if;

  if p_expected_revision is null or current_row.revision <> p_expected_revision then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'message', '雲端資料已被其他人更新，請先同步最新後再保存。',
      'latest_revision', current_row.revision,
      'latest_updated_at', current_row.updated_at,
      'latest_updated_by', current_row.updated_by
    );
  end if;

  next_revision := current_row.revision + 1;

  update public.monthly_report_cloud_data
  set payload = p_payload,
      revision = next_revision,
      updated_by = p_saved_by,
      updated_at = now()
  where workspace_key = p_workspace_key
  returning * into current_row;

  insert into public.monthly_report_revisions(workspace_key, revision, payload, saved_by, saved_at)
  values (p_workspace_key, current_row.revision, p_payload, p_saved_by, current_row.updated_at);

  return jsonb_build_object(
    'ok', true,
    'conflict', false,
    'workspace_key', p_workspace_key,
    'revision', current_row.revision,
    'updated_at', current_row.updated_at,
    'updated_by', current_row.updated_by
  );
end;
$$;

-- 申請/續期區塊軟鎖。鎖過期或同一使用者可取得；其他人持有時返回 ok=false。
create or replace function public.claim_monthly_report_edit_lock(
  p_workspace_key text,
  p_section_key text,
  p_locked_by text,
  p_locked_by_name text default null,
  p_ttl_seconds int default 75
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_lock public.monthly_report_editing_locks%rowtype;
  new_expires_at timestamptz := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 75), 15));
begin
  delete from public.monthly_report_editing_locks where expires_at < now();

  select * into current_lock
  from public.monthly_report_editing_locks
  where workspace_key = p_workspace_key and section_key = p_section_key
  for update;

  if found and current_lock.locked_by <> p_locked_by and current_lock.expires_at >= now() then
    return jsonb_build_object(
      'ok', false,
      'section_key', p_section_key,
      'locked_by', current_lock.locked_by,
      'locked_by_name', current_lock.locked_by_name,
      'expires_at', current_lock.expires_at
    );
  end if;

  insert into public.monthly_report_editing_locks(workspace_key, section_key, locked_by, locked_by_name, locked_at, expires_at)
  values (p_workspace_key, p_section_key, p_locked_by, p_locked_by_name, now(), new_expires_at)
  on conflict (workspace_key, section_key)
  do update set locked_by = excluded.locked_by,
                locked_by_name = excluded.locked_by_name,
                locked_at = now(),
                expires_at = excluded.expires_at;

  return jsonb_build_object(
    'ok', true,
    'section_key', p_section_key,
    'locked_by', p_locked_by,
    'locked_by_name', p_locked_by_name,
    'expires_at', new_expires_at
  );
end;
$$;

create or replace function public.release_monthly_report_edit_lock(
  p_workspace_key text,
  p_section_key text,
  p_locked_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.monthly_report_editing_locks
  where workspace_key = p_workspace_key
    and section_key = p_section_key
    and locked_by = p_locked_by;

  return jsonb_build_object('ok', true, 'section_key', p_section_key);
end;
$$;

create or replace function public.get_monthly_report_edit_locks(p_workspace_key text)
returns table(section_key text, locked_by text, locked_by_name text, locked_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.monthly_report_editing_locks where expires_at < now();
  return query
  select l.section_key, l.locked_by, l.locked_by_name, l.locked_at, l.expires_at
  from public.monthly_report_editing_locks l
  where l.workspace_key = p_workspace_key and l.expires_at >= now();
end;
$$;

grant execute on function public.get_monthly_report_cloud_data(text) to anon, authenticated;
grant execute on function public.upsert_monthly_report_cloud_data(text, jsonb, bigint, text) to anon, authenticated;
grant execute on function public.claim_monthly_report_edit_lock(text, text, text, text, int) to anon, authenticated;
grant execute on function public.release_monthly_report_edit_lock(text, text, text) to anon, authenticated;
grant execute on function public.get_monthly_report_edit_locks(text) to anon, authenticated;
