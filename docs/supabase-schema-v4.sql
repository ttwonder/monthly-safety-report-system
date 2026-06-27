-- 月度安全會議報告系統 V4 Supabase schema
-- 用途：讓靜態 HTML / GitHub Pages 版本通過 Supabase RPC 同步完整月報與記錄資料。
-- 安全說明：這是簡易 Workspace Key 模式。Workspace Key 必須保密；若要保存敏感資料，後續應升級 Supabase Auth + 使用者級 RLS。

create table if not exists public.monthly_report_cloud_data (
  workspace_key text primary key,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

-- 不直接開放表讀寫；透過 RPC 以 workspace_key 存取，避免前端列表掃描整張表。
alter table public.monthly_report_cloud_data enable row level security;
revoke all on public.monthly_report_cloud_data from anon, authenticated;

create or replace function public.get_monthly_report_cloud_data(p_workspace_key text)
returns table(payload jsonb, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select m.payload, m.updated_at
  from public.monthly_report_cloud_data m
  where m.workspace_key = p_workspace_key
  limit 1;
$$;

create or replace function public.upsert_monthly_report_cloud_data(p_workspace_key text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  out_updated_at timestamptz;
begin
  insert into public.monthly_report_cloud_data(workspace_key, payload)
  values (p_workspace_key, p_payload)
  on conflict (workspace_key)
  do update set payload = excluded.payload, updated_at = now()
  returning updated_at into out_updated_at;

  return jsonb_build_object('workspace_key', p_workspace_key, 'updated_at', out_updated_at);
end;
$$;

grant execute on function public.get_monthly_report_cloud_data(text) to anon, authenticated;
grant execute on function public.upsert_monthly_report_cloud_data(text, jsonb) to anon, authenticated;

-- 可選：查看目前有幾個 workspace；不要在前端使用。
-- select count(*) from public.monthly_report_cloud_data;
