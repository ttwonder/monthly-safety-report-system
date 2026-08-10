-- 月度安全會議報告系統 V7：逐項多人協作（第一階段：additive schema + 可重複 migration）
--
-- 重要：本檔只新增 V7 資源、建立 V6 writer 的 authority gate，並從目前 cloud bundle 建立逐項副本。
-- 執行本檔後 authority 仍為 LEGACY_ACTIVE，現有 V6 頁面可繼續使用。
-- 真正切換須在新前端已推送後，另執行 docs/supabase-schema-v7-activate.sql。
-- 可重複執行；不得把 service_role key 放進瀏覽器或 repository。

create extension if not exists pgcrypto;

create table if not exists public.monthly_v7_workspaces (
  id uuid primary key default gen_random_uuid(),
  legacy_workspace_key text not null unique,
  authority_state text not null default 'LEGACY_ACTIVE'
    check (authority_state in ('LEGACY_ACTIVE','DRAINING','FROZEN','NORMALIZED_MAINTENANCE','NORMALIZED_ACTIVE','ROLLBACK_FROZEN')),
  authority_epoch bigint not null default 1 check (authority_epoch > 0),
  minimum_client_version int not null default 6,
  site_policy_generation bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monthly_v7_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  legacy_file_id text not null,
  title text not null default '月度安全會議報告',
  report_date date,
  period jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft','frozen','published','archived')),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(workspace_id, legacy_file_id)
);

create table if not exists public.monthly_v7_report_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.monthly_v7_reports(id) on delete cascade,
  legacy_item_id text not null,
  sort_rank numeric(24,8) not null,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(report_id, legacy_item_id)
);

create index if not exists idx_monthly_v7_report_items_active_order
  on public.monthly_v7_report_items(report_id, sort_rank, id)
  where deleted_at is null;

create table if not exists public.monthly_v7_record_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  record_type text not null check (record_type in ('inspections','deficiencies','detentions','actions','trainings')),
  legacy_id text not null,
  record_date date,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(workspace_id, record_type, legacy_id)
);

create index if not exists idx_monthly_v7_record_items_active
  on public.monthly_v7_record_items(workspace_id, record_type, record_date desc, id)
  where deleted_at is null;

create table if not exists public.monthly_v7_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  username text not null,
  display_name text not null,
  role text not null check (role in ('owner','admin','operator')),
  password_scheme text not null default 'legacy_sha256' check (password_scheme in ('legacy_sha256','bcrypt')),
  password_hash text not null,
  active boolean not null default true,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, username)
);

create unique index if not exists uq_monthly_v7_one_owner
  on public.monthly_v7_users(workspace_id)
  where role = 'owner' and active;

alter table public.monthly_v7_reports
  drop constraint if exists monthly_v7_reports_updated_by_user_id_fkey;
alter table public.monthly_v7_reports
  add constraint monthly_v7_reports_updated_by_user_id_fkey
  foreign key (updated_by_user_id) references public.monthly_v7_users(id) on delete set null;

alter table public.monthly_v7_report_items
  drop constraint if exists monthly_v7_report_items_updated_by_user_id_fkey;
alter table public.monthly_v7_report_items
  add constraint monthly_v7_report_items_updated_by_user_id_fkey
  foreign key (updated_by_user_id) references public.monthly_v7_users(id) on delete set null;

alter table public.monthly_v7_record_items
  drop constraint if exists monthly_v7_record_items_updated_by_user_id_fkey;
alter table public.monthly_v7_record_items
  add constraint monthly_v7_record_items_updated_by_user_id_fkey
  foreign key (updated_by_user_id) references public.monthly_v7_users(id) on delete set null;

create table if not exists public.monthly_v7_site_access (
  workspace_id uuid primary key references public.monthly_v7_workspaces(id) on delete cascade,
  password_scheme text not null default 'legacy_sha256' check (password_scheme in ('legacy_sha256','bcrypt')),
  password_hash text not null,
  generation bigint not null default 1 check (generation > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.monthly_v7_legacy_snapshots (
  id bigserial primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  source_revision bigint not null,
  source_updated_at timestamptz,
  payload jsonb not null,
  payload_sha256 text not null,
  captured_at timestamptz not null default now(),
  unique(workspace_id, source_revision, payload_sha256)
);

create table if not exists public.monthly_v7_migration_receipts (
  id bigserial primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  source_revision bigint not null,
  payload_sha256 text not null,
  report_sha256 text,
  module_sha256 text,
  record_sha256 text,
  user_sha256 text,
  site_sha256 text,
  report_count int not null,
  module_count int not null,
  record_count int not null,
  user_count int not null,
  owner_count int not null,
  completed_at timestamptz not null default now(),
  unique(workspace_id, source_revision, payload_sha256)
);

alter table public.monthly_v7_migration_receipts add column if not exists report_sha256 text;
alter table public.monthly_v7_migration_receipts add column if not exists module_sha256 text;
alter table public.monthly_v7_migration_receipts add column if not exists record_sha256 text;
alter table public.monthly_v7_migration_receipts add column if not exists user_sha256 text;
alter table public.monthly_v7_migration_receipts add column if not exists site_sha256 text;

create or replace function public.monthly_v7_safe_date(p_value text)
returns date
language sql
immutable
as $$
  select case
    when coalesce(p_value, '') ~ '^\d{4}-\d{2}-\d{2}$' then p_value::date
    else null
  end
$$;

create or replace function public.monthly_v7_migrate_workspace(p_workspace_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  legacy_row public.monthly_report_cloud_data%rowtype;
  workspace_row public.monthly_v7_workspaces%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  source_payload jsonb;
  source_hash text;
  module_row record;
  record_group record;
  record_row record;
  user_row record;
  module_count int := 0;
  record_count int := 0;
  user_count int := 0;
  owner_count int := 0;
  site_hash text;
  v_legacy_file_id text;
  source_projection jsonb;
  actual_projection jsonb;
  report_hash text;
  module_hash text;
  record_hash text;
  user_hash text;
  site_projection_hash text;
begin
  select * into legacy_row
  from public.monthly_report_cloud_data
  where workspace_key = p_workspace_key
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'LEGACY_WORKSPACE_NOT_FOUND';
  end if;

  source_payload := coalesce(legacy_row.payload, '{}'::jsonb);
  source_hash := encode(digest(convert_to(source_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_workspaces(legacy_workspace_key)
  values (p_workspace_key)
  on conflict (legacy_workspace_key)
  do update set updated_at = now()
  returning * into workspace_row;

  if workspace_row.authority_state not in ('LEGACY_ACTIVE','DRAINING','FROZEN','NORMALIZED_MAINTENANCE') then
    raise exception using errcode = '55000', message = 'NORMALIZED_AUTHORITY_ALREADY_ACTIVE';
  end if;

  insert into public.monthly_v7_legacy_snapshots(
    workspace_id, source_revision, source_updated_at, payload, payload_sha256
  ) values (
    workspace_row.id, legacy_row.revision, legacy_row.updated_at, source_payload, source_hash
  ) on conflict do nothing;

  v_legacy_file_id := coalesce(nullif(source_payload->>'fileId', ''), 'legacy-current');

  insert into public.monthly_v7_reports(
    workspace_id, legacy_file_id, title, report_date, period, settings
  ) values (
    workspace_row.id,
    v_legacy_file_id,
    coalesce(nullif(source_payload#>>'{report,title}', ''), '月度安全會議報告'),
    public.monthly_v7_safe_date(source_payload#>>'{report,date}'),
    coalesce(source_payload#>'{report,period}', '{}'::jsonb),
    jsonb_build_object('legacyVersion', coalesce(source_payload->'version', '6'::jsonb))
  )
  on conflict (workspace_id, legacy_file_id)
  do update set
    title = excluded.title,
    report_date = excluded.report_date,
    period = excluded.period,
    settings = public.monthly_v7_reports.settings || excluded.settings,
    updated_at = now(),
    deleted_at = null
  returning * into report_row;

  update public.monthly_v7_report_items
  set deleted_at = now(), updated_at = now()
  where report_id = report_row.id and deleted_at is null;

  for module_row in
    select value as payload, ordinality
    from jsonb_array_elements(coalesce(source_payload#>'{report,modules}', '[]'::jsonb))
      with ordinality as module(value, ordinality)
  loop
    insert into public.monthly_v7_report_items(
      report_id, legacy_item_id, sort_rank, payload
    ) values (
      report_row.id,
      coalesce(nullif(module_row.payload->>'id', ''), 'index:' || module_row.ordinality::text),
      module_row.ordinality,
      module_row.payload - '_v7Id' - '_v7Revision'
    )
    on conflict (report_id, legacy_item_id)
    do update set
      sort_rank = excluded.sort_rank,
      payload = excluded.payload,
      updated_at = now(),
      deleted_at = null;
    module_count := module_count + 1;
  end loop;

  update public.monthly_v7_record_items
  set deleted_at = now(), updated_at = now()
  where workspace_id = workspace_row.id and deleted_at is null;

  for record_group in
    select key as record_type, value as rows
    from jsonb_each(coalesce(source_payload->'records', '{}'::jsonb))
    where key in ('inspections','deficiencies','detentions','actions','trainings')
  loop
    if jsonb_typeof(record_group.rows) <> 'array' then
      raise exception using errcode = '22023', message = 'LEGACY_RECORD_GROUP_NOT_ARRAY:' || record_group.record_type;
    end if;
    for record_row in
      select value as payload, ordinality
      from jsonb_array_elements(record_group.rows) with ordinality as item(value, ordinality)
    loop
      insert into public.monthly_v7_record_items(
        workspace_id, record_type, legacy_id, record_date, payload
      ) values (
        workspace_row.id,
        record_group.record_type,
        coalesce(nullif(record_row.payload->>'id', ''), 'index:' || record_row.ordinality::text),
        public.monthly_v7_safe_date(coalesce(
          nullif(record_row.payload->>'date', ''),
          nullif(record_row.payload->>'dueDate', ''),
          nullif(record_row.payload->>'releaseDate', '')
        )),
        record_row.payload - '_v7Id' - '_v7Revision'
      )
      on conflict (workspace_id, record_type, legacy_id)
      do update set
        record_date = excluded.record_date,
        payload = excluded.payload,
        updated_at = now(),
        deleted_at = null;
      record_count := record_count + 1;
    end loop;
  end loop;

  update public.monthly_v7_users
  set active = false, version = version + 1, updated_at = now()
  where workspace_id = workspace_row.id and active;

  for user_row in
    select value as payload
    from jsonb_array_elements(coalesce(source_payload->'users', '[]'::jsonb))
  loop
    if nullif(btrim(user_row.payload->>'username'), '') is null then
      raise exception using errcode = '22023', message = 'LEGACY_USER_WITHOUT_USERNAME';
    end if;
    if coalesce(user_row.payload->>'role', 'operator') not in ('owner','admin','operator') then
      raise exception using errcode = '22023', message = 'LEGACY_USER_INVALID_ROLE';
    end if;
    if nullif(user_row.payload->>'passwordHash', '') is null then
      raise exception using errcode = '22023', message = 'LEGACY_USER_WITHOUT_PASSWORD_HASH';
    end if;

    insert into public.monthly_v7_users(
      workspace_id, username, display_name, role, password_scheme, password_hash, active
    ) values (
      workspace_row.id,
      btrim(user_row.payload->>'username'),
      coalesce(nullif(btrim(user_row.payload->>'displayName'), ''), btrim(user_row.payload->>'username')),
      coalesce(user_row.payload->>'role', 'operator'),
      'legacy_sha256',
      user_row.payload->>'passwordHash',
      true
    )
    on conflict (workspace_id, username)
    do update set
      display_name = excluded.display_name,
      role = excluded.role,
      password_scheme = excluded.password_scheme,
      password_hash = excluded.password_hash,
      active = true,
      version = public.monthly_v7_users.version + 1,
      updated_at = now();
    user_count := user_count + 1;
  end loop;

  select count(*)::int into owner_count
  from public.monthly_v7_users
  where workspace_id = workspace_row.id and active and role = 'owner';

  if owner_count <> 1 then
    raise exception using errcode = '23514', message = 'LEGACY_OWNER_COUNT_MUST_BE_ONE';
  end if;

  site_hash := nullif(source_payload#>>'{siteAccess,passwordHash}', '');
  if site_hash is not null then
    insert into public.monthly_v7_site_access(workspace_id, password_scheme, password_hash, generation, updated_at)
    values (workspace_row.id, 'legacy_sha256', site_hash, 1, coalesce(
      case when coalesce(source_payload#>>'{siteAccess,updatedAt}', '') ~ '^\d{4}-\d{2}-\d{2}T' then (source_payload#>>'{siteAccess,updatedAt}')::timestamptz else null end,
      now()
    ))
    on conflict (workspace_id)
    do update set
      password_scheme = excluded.password_scheme,
      password_hash = excluded.password_hash,
      updated_at = excluded.updated_at;
  end if;

  source_projection := jsonb_build_object(
    'title',coalesce(nullif(source_payload#>>'{report,title}', ''), '月度安全會議報告'),
    'date',public.monthly_v7_safe_date(source_payload#>>'{report,date}'),
    'period',coalesce(source_payload#>'{report,period}', '{}'::jsonb)
  );
  actual_projection := jsonb_build_object('title',report_row.title,'date',report_row.report_date,'period',report_row.period);
  if source_projection is distinct from actual_projection then
    raise exception using errcode='23514', message='MIGRATION_REPORT_CONTENT_MISMATCH';
  end if;
  report_hash := encode(digest(convert_to(source_projection::text,'UTF8'),'sha256'),'hex');

  select coalesce(jsonb_agg(m.value - '_v7Id' - '_v7Revision' order by m.ordinality),'[]'::jsonb)
  into source_projection
  from jsonb_array_elements(coalesce(source_payload#>'{report,modules}','[]'::jsonb)) with ordinality m(value,ordinality);
  select coalesce(jsonb_agg(i.payload order by i.sort_rank),'[]'::jsonb)
  into actual_projection
  from public.monthly_v7_report_items i where i.report_id=report_row.id and i.deleted_at is null;
  if source_projection is distinct from actual_projection then
    raise exception using errcode='23514', message='MIGRATION_MODULE_CONTENT_MISMATCH';
  end if;
  module_hash := encode(digest(convert_to(source_projection::text,'UTF8'),'sha256'),'hex');

  select coalesce(jsonb_agg(jsonb_build_object(
    'record_type',q.record_type,'legacy_id',q.legacy_id,'payload',q.payload
  ) order by q.record_type,q.legacy_id),'[]'::jsonb)
  into source_projection
  from (
    select g.key record_type,
      coalesce(nullif(r.value->>'id',''),'index:'||r.ordinality::text) legacy_id,
      r.value - '_v7Id' - '_v7Revision' payload
    from jsonb_each(coalesce(source_payload->'records','{}'::jsonb)) g
    cross join lateral jsonb_array_elements(g.value) with ordinality r(value,ordinality)
    where g.key in ('inspections','deficiencies','detentions','actions','trainings')
  ) q;
  select coalesce(jsonb_agg(jsonb_build_object(
    'record_type',i.record_type,'legacy_id',i.legacy_id,'payload',i.payload
  ) order by i.record_type,i.legacy_id),'[]'::jsonb)
  into actual_projection
  from public.monthly_v7_record_items i where i.workspace_id=workspace_row.id and i.deleted_at is null;
  if source_projection is distinct from actual_projection then
    raise exception using errcode='23514', message='MIGRATION_RECORD_CONTENT_MISMATCH';
  end if;
  record_hash := encode(digest(convert_to(source_projection::text,'UTF8'),'sha256'),'hex');

  select coalesce(jsonb_agg(jsonb_build_object(
    'username',btrim(u.value->>'username'),
    'display_name',coalesce(nullif(btrim(u.value->>'displayName'),''),btrim(u.value->>'username')),
    'role',coalesce(u.value->>'role','operator'),
    'password_scheme','legacy_sha256','password_hash',u.value->>'passwordHash'
  ) order by btrim(u.value->>'username')),'[]'::jsonb)
  into source_projection
  from jsonb_array_elements(coalesce(source_payload->'users','[]'::jsonb)) u(value);
  select coalesce(jsonb_agg(jsonb_build_object(
    'username',u.username,'display_name',u.display_name,'role',u.role,
    'password_scheme',u.password_scheme,'password_hash',u.password_hash
  ) order by u.username),'[]'::jsonb)
  into actual_projection
  from public.monthly_v7_users u where u.workspace_id=workspace_row.id and u.active;
  if source_projection is distinct from actual_projection then
    raise exception using errcode='23514', message='MIGRATION_USER_CONTENT_MISMATCH';
  end if;
  user_hash := encode(digest(convert_to(source_projection::text,'UTF8'),'sha256'),'hex');

  source_projection := to_jsonb(site_hash);
  actual_projection := (select to_jsonb(p.password_hash) from public.monthly_v7_site_access p where p.workspace_id=workspace_row.id);
  if source_projection is distinct from actual_projection then
    raise exception using errcode='23514', message='MIGRATION_SITE_HASH_MISMATCH';
  end if;
  site_projection_hash := encode(digest(convert_to(coalesce(source_projection,'null'::jsonb)::text,'UTF8'),'sha256'),'hex');

  insert into public.monthly_v7_migration_receipts(
    workspace_id, source_revision, payload_sha256,
    report_sha256, module_sha256, record_sha256, user_sha256, site_sha256,
    report_count, module_count, record_count, user_count, owner_count
  ) values (
    workspace_row.id, legacy_row.revision, source_hash,
    report_hash, module_hash, record_hash, user_hash, site_projection_hash,
    1, module_count, record_count, user_count, owner_count
  )
  on conflict (workspace_id, source_revision, payload_sha256)
  do update set
    report_sha256 = excluded.report_sha256,
    module_sha256 = excluded.module_sha256,
    record_sha256 = excluded.record_sha256,
    user_sha256 = excluded.user_sha256,
    site_sha256 = excluded.site_sha256,
    report_count = excluded.report_count,
    module_count = excluded.module_count,
    record_count = excluded.record_count,
    user_count = excluded.user_count,
    owner_count = excluded.owner_count,
    completed_at = now();

  if (select count(*) from public.monthly_v7_report_items where report_id = report_row.id and deleted_at is null) <> module_count then
    raise exception using errcode = '23514', message = 'MIGRATION_MODULE_COUNT_MISMATCH';
  end if;
  if (select count(*) from public.monthly_v7_record_items where workspace_id = workspace_row.id and deleted_at is null) <> record_count then
    raise exception using errcode = '23514', message = 'MIGRATION_RECORD_COUNT_MISMATCH';
  end if;
  if (select count(*) from public.monthly_v7_users where workspace_id = workspace_row.id and active) <> user_count then
    raise exception using errcode = '23514', message = 'MIGRATION_USER_COUNT_MISMATCH';
  end if;

  return jsonb_build_object(
    'ok', true,
    'workspace_id', workspace_row.id,
    'report_id', report_row.id,
    'source_revision', legacy_row.revision,
    'payload_sha256', source_hash,
    'report_sha256', report_hash,
    'module_sha256', module_hash,
    'record_sha256', record_hash,
    'user_sha256', user_hash,
    'site_sha256', site_projection_hash,
    'module_count', module_count,
    'record_count', record_count,
    'user_count', user_count,
    'owner_count', owner_count,
    'authority_state', workspace_row.authority_state,
    'authority_epoch', workspace_row.authority_epoch
  );
end;
$$;

do $$
declare
  item record;
begin
  for item in
    select legacy.workspace_key
    from public.monthly_report_cloud_data legacy
    left join public.monthly_v7_workspaces w on w.legacy_workspace_key=legacy.workspace_key
    where w.id is null or w.authority_state='LEGACY_ACTIVE'
    order by legacy.workspace_key
  loop
    perform public.monthly_v7_migrate_workspace(item.workspace_key);
  end loop;
end
$$;

-- 重新定義 V6 RPC：LEGACY_ACTIVE 時維持原行為；切換開始後由資料庫端阻斷舊分頁。
create or replace function public.get_monthly_report_cloud_data(p_workspace_key text)
returns table(payload jsonb, updated_at timestamptz, revision bigint, updated_by text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  v_authority_state text;
begin
  select w.authority_state into v_authority_state
  from public.monthly_v7_workspaces w
  where w.legacy_workspace_key=p_workspace_key
  for share;
  if found and v_authority_state<>'LEGACY_ACTIVE' then
    raise exception using errcode='55000',message='AUTHORITY_CHANGED';
  end if;
  return query
    select m.payload,m.updated_at,m.revision,m.updated_by
    from public.monthly_report_cloud_data m
    where m.workspace_key=p_workspace_key
    limit 1;
end;
$$;

create or replace function public.upsert_monthly_report_cloud_data(
  p_workspace_key text,
  p_payload jsonb,
  p_expected_revision bigint default null,
  p_saved_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  current_row public.monthly_report_cloud_data%rowtype;
  saved_row public.monthly_report_cloud_data%rowtype;
  authority_state text;
begin
  if p_workspace_key is null or btrim(p_workspace_key)='' then
    raise exception using errcode='22023',message='workspace key is required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='payload must be a JSON object';
  end if;

  -- FOR SHARE 與 activation 對 workspace row 的 UPDATE lock 形成切換 barrier。
  select w.authority_state into authority_state
  from public.monthly_v7_workspaces w
  where w.legacy_workspace_key=p_workspace_key
  for share;
  if found and authority_state<>'LEGACY_ACTIVE' then
    raise exception using errcode='55000',message='AUTHORITY_CHANGED';
  end if;

  select * into current_row
  from public.monthly_report_cloud_data
  where workspace_key=p_workspace_key
  for update;

  if found then
    if p_expected_revision is null or p_expected_revision<>current_row.revision then
      return jsonb_build_object(
        'ok',false,'conflict',true,'revision',current_row.revision,'payload',current_row.payload,
        'updated_at',current_row.updated_at,'updated_by',current_row.updated_by
      );
    end if;
    update public.monthly_report_cloud_data
    set payload=p_payload,revision=current_row.revision+1,updated_at=now(),updated_by=nullif(btrim(p_saved_by),'')
    where workspace_key=p_workspace_key
    returning * into saved_row;
  else
    if p_expected_revision is not null and p_expected_revision<>0 then
      return jsonb_build_object('ok',false,'conflict',true,'revision',0,'payload',null);
    end if;
    insert into public.monthly_report_cloud_data(workspace_key,payload,revision,updated_at,updated_by)
    values(p_workspace_key,p_payload,1,now(),nullif(btrim(p_saved_by),''))
    returning * into saved_row;
  end if;
  return jsonb_build_object(
    'ok',true,'conflict',false,'revision',saved_row.revision,'payload',saved_row.payload,
    'updated_at',saved_row.updated_at,'updated_by',saved_row.updated_by
  );
end;
$$;

create table if not exists public.monthly_v7_site_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  auth_uid uuid not null,
  client_session_id text not null,
  policy_generation bigint not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_monthly_v7_site_sessions_lookup
  on public.monthly_v7_site_sessions(workspace_id, auth_uid, expires_at);

create table if not exists public.monthly_v7_user_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  user_id uuid not null references public.monthly_v7_users(id) on delete cascade,
  site_session_id uuid not null references public.monthly_v7_site_sessions(id) on delete cascade,
  auth_uid uuid not null,
  client_session_id text not null,
  user_version bigint not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_monthly_v7_user_sessions_lookup
  on public.monthly_v7_user_sessions(workspace_id, auth_uid, expires_at);

create or replace function public.monthly_v7_password_matches(
  p_scheme text,
  p_hash text,
  p_password text
)
returns boolean
language sql
stable
set search_path = pg_catalog, extensions, public
as $$
  select case
    when p_scheme = 'legacy_sha256' then
      encode(digest(convert_to(coalesce(p_password, ''), 'UTF8'), 'sha256'), 'hex') = p_hash
    when p_scheme = 'bcrypt' then
      crypt(coalesce(p_password, ''), p_hash) = p_hash
    else false
  end
$$;

create or replace function public.monthly_v7_get_status(p_workspace_key text)
returns jsonb
language sql
security definer
set search_path = pg_catalog, extensions, public
as $$
  select jsonb_build_object(
    'ok', true,
    'workspace_id', w.id,
    'authority_state', w.authority_state,
    'authority_epoch', w.authority_epoch,
    'minimum_client_version', w.minimum_client_version
  )
  from public.monthly_v7_workspaces w
  where w.legacy_workspace_key = p_workspace_key
  limit 1
$$;

create or replace function public.monthly_v7_open_site(
  p_workspace_key text,
  p_password text,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  policy_row public.monthly_v7_site_access%rowtype;
  session_row public.monthly_v7_site_sessions%rowtype;
  caller_uid uuid := auth.uid();
begin
  if caller_uid is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode = '22023', message = 'CLIENT_SESSION_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = '28P01', message = 'INVALID_CREDENTIALS';
  end if;

  select * into policy_row
  from public.monthly_v7_site_access
  where workspace_id = workspace_row.id
  for update;
  if not found or not public.monthly_v7_password_matches(policy_row.password_scheme, policy_row.password_hash, p_password) then
    raise exception using errcode = '28P01', message = 'INVALID_CREDENTIALS';
  end if;

  if policy_row.password_scheme = 'legacy_sha256' then
    update public.monthly_v7_site_access
    set password_scheme = 'bcrypt',
        password_hash = crypt(coalesce(p_password, ''), gen_salt('bf', 10)),
        updated_at = now()
    where workspace_id = workspace_row.id;
  end if;

  delete from public.monthly_v7_site_sessions where expires_at <= now();
  insert into public.monthly_v7_site_sessions(
    workspace_id, auth_uid, client_session_id, policy_generation, expires_at
  ) values (
    workspace_row.id, caller_uid, btrim(p_client_session_id), policy_row.generation, now() + interval '12 hours'
  ) returning * into session_row;

  return jsonb_build_object(
    'ok', true,
    'site_session_id', session_row.id,
    'expires_at', session_row.expires_at,
    'workspace_id', workspace_row.id,
    'authority_state', workspace_row.authority_state,
    'authority_epoch', workspace_row.authority_epoch,
    'minimum_client_version', workspace_row.minimum_client_version
  );
end;
$$;

create or replace function public.monthly_v7_login_user(
  p_workspace_key text,
  p_site_session_id uuid,
  p_username text,
  p_password text,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  site_session public.monthly_v7_site_sessions%rowtype;
  user_row public.monthly_v7_users%rowtype;
  session_row public.monthly_v7_user_sessions%rowtype;
  caller_uid uuid := auth.uid();
begin
  if caller_uid is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = '28P01', message = 'INVALID_CREDENTIALS';
  end if;

  select s.* into site_session
  from public.monthly_v7_site_sessions s
  join public.monthly_v7_site_access p on p.workspace_id = s.workspace_id
  where s.id = p_site_session_id
    and s.workspace_id = workspace_row.id
    and s.auth_uid = caller_uid
    and s.client_session_id = btrim(p_client_session_id)
    and s.policy_generation = p.generation
    and s.expires_at > now();
  if not found then
    raise exception using errcode = '28000', message = 'SITE_SESSION_INVALID';
  end if;

  select * into user_row
  from public.monthly_v7_users
  where workspace_id = workspace_row.id
    and username = btrim(p_username)
    and active
  for update;
  if not found or not public.monthly_v7_password_matches(user_row.password_scheme, user_row.password_hash, p_password) then
    raise exception using errcode = '28P01', message = 'INVALID_CREDENTIALS';
  end if;

  if user_row.password_scheme = 'legacy_sha256' then
    update public.monthly_v7_users
    set password_scheme = 'bcrypt',
        password_hash = crypt(coalesce(p_password, ''), gen_salt('bf', 10)),
        updated_at = now()
    where id = user_row.id
    returning * into user_row;
  end if;

  delete from public.monthly_v7_user_sessions where expires_at <= now();
  insert into public.monthly_v7_user_sessions(
    workspace_id, user_id, site_session_id, auth_uid, client_session_id, user_version, expires_at
  ) values (
    workspace_row.id, user_row.id, site_session.id, caller_uid,
    btrim(p_client_session_id), user_row.version, least(site_session.expires_at, now() + interval '12 hours')
  ) returning * into session_row;

  update public.monthly_v7_site_sessions
  set last_seen_at = now()
  where id = site_session.id;

  return jsonb_build_object(
    'ok', true,
    'user_session_id', session_row.id,
    'expires_at', session_row.expires_at,
    'user', jsonb_build_object(
      'id', user_row.id,
      'username', user_row.username,
      'displayName', user_row.display_name,
      'role', user_row.role,
      'active', user_row.active,
      'version', user_row.version
    )
  );
end;
$$;

create or replace function public.monthly_v7_get_snapshot(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  caller_uid uuid := auth.uid();
  site_ok boolean;
  user_ok boolean := false;
  module_rows jsonb;
  record_rows jsonb;
  user_rows jsonb;
begin
  if caller_uid is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = '28000', message = 'SITE_SESSION_INVALID';
  end if;

  select exists(
    select 1
    from public.monthly_v7_site_sessions s
    join public.monthly_v7_site_access p on p.workspace_id = s.workspace_id
    where s.id = p_site_session_id
      and s.workspace_id = workspace_row.id
      and s.auth_uid = caller_uid
      and s.policy_generation = p.generation
      and s.expires_at > now()
  ) into site_ok;
  if not site_ok then
    raise exception using errcode = '28000', message = 'SITE_SESSION_INVALID';
  end if;

  if p_user_session_id is not null then
    select exists(
      select 1
      from public.monthly_v7_user_sessions s
      join public.monthly_v7_users u on u.id = s.user_id
      where s.id = p_user_session_id
        and s.workspace_id = workspace_row.id
        and s.site_session_id = p_site_session_id
        and s.auth_uid = caller_uid
        and s.user_version = u.version
        and u.active
        and s.expires_at > now()
    ) into user_ok;
    if not user_ok then
      raise exception using errcode = '28000', message = 'USER_SESSION_INVALID';
    end if;
  end if;

  select * into report_row
  from public.monthly_v7_reports
  where workspace_id = workspace_row.id and deleted_at is null
  order by updated_at desc, id
  limit 1;
  if not found then
    raise exception using errcode = 'P0002', message = 'REPORT_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'legacyItemId', i.legacy_item_id,
    'sortRank', i.sort_rank,
    'payload', i.payload,
    'revision', i.revision,
    'updatedAt', i.updated_at
  ) order by i.sort_rank, i.id), '[]'::jsonb)
  into module_rows
  from public.monthly_v7_report_items i
  where i.report_id = report_row.id and i.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'recordType', r.record_type,
    'legacyId', r.legacy_id,
    'recordDate', r.record_date,
    'payload', r.payload,
    'revision', r.revision,
    'updatedAt', r.updated_at
  ) order by r.record_type, r.record_date nulls last, r.id), '[]'::jsonb)
  into record_rows
  from public.monthly_v7_record_items r
  where r.workspace_id = workspace_row.id and r.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id,
    'username', u.username,
    'displayName', u.display_name,
    'role', u.role,
    'active', u.active,
    'version', u.version
  ) order by case u.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.username), '[]'::jsonb)
  into user_rows
  from public.monthly_v7_users u
  where u.workspace_id = workspace_row.id and u.active;

  update public.monthly_v7_site_sessions set last_seen_at = now() where id = p_site_session_id;
  if p_user_session_id is not null then
    update public.monthly_v7_user_sessions set last_seen_at = now() where id = p_user_session_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'authorityState', workspace_row.authority_state,
    'authorityEpoch', workspace_row.authority_epoch,
    'minimumClientVersion', workspace_row.minimum_client_version,
    'workspaceId', workspace_row.id,
    'watermark', (select coalesce(max(e.sequence),0) from public.monthly_v7_change_events e where e.workspace_id=workspace_row.id),
    'report', jsonb_build_object(
      'id', report_row.id,
      'legacyFileId', report_row.legacy_file_id,
      'title', report_row.title,
      'date', report_row.report_date,
      'period', report_row.period,
      'revision', report_row.revision,
      'status', report_row.status
    ),
    'modules', module_rows,
    'records', record_rows,
    'users', user_rows
  );
end;
$$;

create or replace function public.monthly_v7_logout(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  removed_id uuid;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then return jsonb_build_object('ok',true,'alreadyLoggedOut',true); end if;
  if p_user_session_id is not null then
    delete from public.monthly_v7_user_sessions
    where id=p_user_session_id and workspace_id=workspace_row.id and auth_uid=auth.uid();
  end if;
  delete from public.monthly_v7_site_sessions
  where id=p_site_session_id and workspace_id=workspace_row.id and auth_uid=auth.uid()
  returning id into removed_id;
  return jsonb_build_object('ok',true,'revoked',removed_id is not null);
end;
$$;

create table if not exists public.monthly_v7_entity_leases (
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  lease_id uuid not null default gen_random_uuid(),
  holder_user_id uuid not null references public.monthly_v7_users(id) on delete cascade,
  holder_user_session_id uuid not null references public.monthly_v7_user_sessions(id) on delete cascade,
  client_session_id text not null,
  fencing_token bigint not null default 1 check (fencing_token > 0),
  claimed_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key(workspace_id, entity_type, entity_id)
);

create index if not exists idx_monthly_v7_entity_leases_expiry
  on public.monthly_v7_entity_leases(workspace_id, expires_at);

create table if not exists public.monthly_v7_operations (
  operation_id uuid primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  actor_user_id uuid not null references public.monthly_v7_users(id) on delete cascade,
  command_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  request_hash text not null,
  status text not null check (status in ('STARTED','COMMITTED','REJECTED')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_monthly_v7_operations_workspace_created
  on public.monthly_v7_operations(workspace_id, created_at desc);

create table if not exists public.monthly_v7_entity_events (
  id bigserial primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  actor_user_id uuid references public.monthly_v7_users(id) on delete set null,
  operation_id uuid references public.monthly_v7_operations(operation_id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  before_revision bigint,
  after_revision bigint,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.monthly_v7_change_events (
  sequence bigserial primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  entity_revision bigint,
  action text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_monthly_v7_change_events_workspace_sequence
  on public.monthly_v7_change_events(workspace_id, sequence);

create or replace function public.monthly_v7_session_user(
  p_workspace_id uuid,
  p_user_session_id uuid,
  p_client_session_id text
)
returns public.monthly_v7_users
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  user_row public.monthly_v7_users%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  select u.* into user_row
  from public.monthly_v7_user_sessions s
  join public.monthly_v7_users u on u.id = s.user_id
  join public.monthly_v7_site_sessions site on site.id = s.site_session_id
  join public.monthly_v7_site_access policy on policy.workspace_id = site.workspace_id
  where s.id = p_user_session_id
    and s.workspace_id = p_workspace_id
    and s.auth_uid = auth.uid()
    and s.client_session_id = btrim(p_client_session_id)
    and s.user_version = u.version
    and s.expires_at > now()
    and u.active
    and site.auth_uid = auth.uid()
    and site.policy_generation = policy.generation
    and site.expires_at > now();
  if not found then
    raise exception using errcode = '28000', message = 'USER_SESSION_INVALID';
  end if;
  update public.monthly_v7_user_sessions set last_seen_at = now() where id = p_user_session_id;
  return user_row;
end;
$$;

create or replace function public.monthly_v7_entity_exists(
  p_workspace_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, extensions, public
as $$
  select case
    when p_entity_type = 'module' then exists(
      select 1 from public.monthly_v7_report_items i
      join public.monthly_v7_reports r on r.id = i.report_id
      where i.id = p_entity_id and r.workspace_id = p_workspace_id
        and i.deleted_at is null and r.deleted_at is null
    )
    when p_entity_type like 'record:%' then exists(
      select 1 from public.monthly_v7_record_items r
      where r.id = p_entity_id and r.workspace_id = p_workspace_id
        and r.record_type = split_part(p_entity_type, ':', 2)
        and r.deleted_at is null
    )
    when p_entity_type in ('report_meta','report_structure','kpi_batch') then exists(
      select 1 from public.monthly_v7_reports r
      where r.id = p_entity_id and r.workspace_id = p_workspace_id and r.deleted_at is null
    )
    else false
  end
$$;

create or replace function public.monthly_v7_claim_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_entity_type text,
  p_entity_id uuid,
  p_ttl_seconds int default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  holder_name text;
  ttl_seconds int := greatest(30, least(coalesce(p_ttl_seconds, 90), 180));
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;
  user_row := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE', 'authorityState', workspace_row.authority_state);
  end if;
  if not public.monthly_v7_entity_exists(workspace_row.id, p_entity_type, p_entity_id) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
  end if;

  insert into public.monthly_v7_entity_leases(
    workspace_id, entity_type, entity_id, holder_user_id, holder_user_session_id,
    client_session_id, expires_at
  ) values (
    workspace_row.id, p_entity_type, p_entity_id, user_row.id, p_user_session_id,
    btrim(p_client_session_id), now() + make_interval(secs => ttl_seconds)
  ) on conflict (workspace_id, entity_type, entity_id) do nothing;

  select * into lease_row
  from public.monthly_v7_entity_leases
  where workspace_id = workspace_row.id
    and entity_type = p_entity_type
    and entity_id = p_entity_id
  for update;

  if lease_row.expires_at > now()
     and not (
       lease_row.holder_user_id = user_row.id
       and lease_row.holder_user_session_id = p_user_session_id
       and lease_row.client_session_id = btrim(p_client_session_id)
     ) then
    select display_name into holder_name from public.monthly_v7_users where id = lease_row.holder_user_id;
    return jsonb_build_object(
      'ok', false,
      'error', 'LEASE_HELD',
      'holder_display_name', holder_name,
      'expires_at', lease_row.expires_at,
      'entity_type', p_entity_type,
      'entity_id', p_entity_id
    );
  end if;

  if lease_row.expires_at <= now() then
    update public.monthly_v7_entity_leases
    set lease_id = gen_random_uuid(),
        holder_user_id = user_row.id,
        holder_user_session_id = p_user_session_id,
        client_session_id = btrim(p_client_session_id),
        fencing_token = fencing_token + 1,
        claimed_at = now(),
        heartbeat_at = now(),
        expires_at = now() + make_interval(secs => ttl_seconds)
    where workspace_id = workspace_row.id
      and entity_type = p_entity_type
      and entity_id = p_entity_id
    returning * into lease_row;
  elsif lease_row.holder_user_session_id = p_user_session_id
    and lease_row.client_session_id = btrim(p_client_session_id) then
    update public.monthly_v7_entity_leases
    set heartbeat_at = now(),
        expires_at = now() + make_interval(secs => ttl_seconds)
    where workspace_id = workspace_row.id
      and entity_type = p_entity_type
      and entity_id = p_entity_id
    returning * into lease_row;
  end if;

  return jsonb_build_object(
    'ok', true,
    'entity_type', lease_row.entity_type,
    'entity_id', lease_row.entity_id,
    'lease_id', lease_row.lease_id,
    'fencing_token', lease_row.fencing_token,
    'holder_user_id', lease_row.holder_user_id,
    'client_session_id', lease_row.client_session_id,
    'expires_at', lease_row.expires_at,
    'authority_epoch', workspace_row.authority_epoch
  );
end;
$$;

create or replace function public.monthly_v7_renew_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_entity_type text,
  p_entity_id uuid,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_ttl_seconds int default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  ttl_seconds int:=greatest(30,least(coalesce(p_ttl_seconds,90),180));
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  select * into lease_row from public.monthly_v7_entity_leases
  where workspace_id=workspace_row.id and entity_type=p_entity_type and entity_id=p_entity_id for update;
  if not found or workspace_row.authority_state<>'NORMALIZED_ACTIVE' or lease_row.expires_at<=now()
     or lease_row.lease_id<>p_lease_id or lease_row.fencing_token<>p_fencing_token
     or lease_row.holder_user_id<>user_row.id or lease_row.holder_user_session_id<>p_user_session_id
     or lease_row.client_session_id<>btrim(p_client_session_id) then
    return jsonb_build_object('ok',false,'error','LEASE_LOST');
  end if;
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()+make_interval(secs=>ttl_seconds)
  where workspace_id=workspace_row.id and entity_type=p_entity_type and entity_id=p_entity_id returning * into lease_row;
  return jsonb_build_object('ok',true,'entity_type',p_entity_type,'entity_id',p_entity_id,
    'lease_id',lease_row.lease_id,'fencing_token',lease_row.fencing_token,'expires_at',lease_row.expires_at);
end;
$$;

create or replace function public.monthly_v7_release_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_entity_type text,
  p_entity_id uuid,
  p_lease_id uuid,
  p_fencing_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  select * into lease_row from public.monthly_v7_entity_leases
  where workspace_id=workspace_row.id and entity_type=p_entity_type and entity_id=p_entity_id for update;
  if not found or lease_row.lease_id<>p_lease_id or lease_row.fencing_token<>p_fencing_token
     or lease_row.holder_user_id<>user_row.id or lease_row.holder_user_session_id<>p_user_session_id
     or lease_row.client_session_id<>btrim(p_client_session_id) then
    return jsonb_build_object('ok',false,'error','LEASE_LOST');
  end if;
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
  where workspace_id=workspace_row.id and entity_type=p_entity_type and entity_id=p_entity_id;
  return jsonb_build_object('ok',true,'entity_type',p_entity_type,'entity_id',p_entity_id,'released',true);
end;
$$;

create or replace function public.monthly_v7_reorder_modules(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_expected_report_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_module_order jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  order_row record;
  request_hash text;
  response jsonb;
  active_count int;
  listed_count int;
  matched_count int;
  next_revision bigint;
  before_order jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if jsonb_typeof(p_module_order)<>'array' then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','reorder_modules','report_id',p_report_id,'expected_report_revision',p_expected_report_revision,
    'lease_id',p_lease_id,'fencing_token',p_fencing_token,'order',p_module_order
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'reorder_modules','report_structure',p_report_id,request_hash,'STARTED') on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into report_row from public.monthly_v7_reports where id=p_report_id and workspace_id=workspace_row.id and deleted_at is null for update;
  select * into lease_row from public.monthly_v7_entity_leases where workspace_id=workspace_row.id and entity_type='report_structure' and entity_id=p_report_id for update;
  if report_row.id is null or workspace_row.authority_state<>'NORMALIZED_ACTIVE' then response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
  elsif not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id or lease_row.fencing_token<>p_fencing_token
     or lease_row.holder_user_id<>user_row.id or lease_row.holder_user_session_id<>p_user_session_id
     or lease_row.client_session_id<>btrim(p_client_session_id) then response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
  elsif report_row.revision<>p_expected_report_revision then response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',report_row.revision);
  end if;
  if response is null then
    select count(*)::int,coalesce(jsonb_agg(id order by sort_rank,id),'[]'::jsonb) into active_count,before_order
      from public.monthly_v7_report_items where report_id=p_report_id and deleted_at is null;
    select jsonb_array_length(p_module_order),count(distinct value)::int into listed_count,matched_count from jsonb_array_elements_text(p_module_order)t(value);
    if listed_count<>active_count or matched_count<>active_count then response:=jsonb_build_object('ok',false,'error','ORDER_MUST_INCLUDE_ALL_MODULES'); end if;
  end if;
  if response is null then
    select count(*)::int into matched_count from public.monthly_v7_report_items i
      join jsonb_array_elements_text(p_module_order)t(value) on i.id=t.value::uuid
      where i.report_id=p_report_id and i.deleted_at is null;
    if matched_count<>active_count then response:=jsonb_build_object('ok',false,'error','ORDER_MUST_INCLUDE_ALL_MODULES'); end if;
  end if;
  if response is not null then
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id; return response;
  end if;
  for order_row in select value,ordinality from jsonb_array_elements_text(p_module_order) with ordinality t(value,ordinality)
  loop update public.monthly_v7_report_items set sort_rank=order_row.ordinality,updated_at=now(),updated_by_user_id=user_row.id where id=order_row.value::uuid; end loop;
  next_revision:=report_row.revision+1;
  update public.monthly_v7_reports set revision=next_revision,updated_at=now(),updated_by_user_id=user_row.id where id=p_report_id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload,after_payload)
  values(workspace_row.id,user_row.id,p_operation_id,'report_structure',p_report_id,'reorder',report_row.revision,next_revision,before_order,p_module_order);
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'report_structure',p_report_id,next_revision,'reorder');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now() where workspace_id=workspace_row.id and entity_type='report_structure' and entity_id=p_report_id;
  response:=jsonb_build_object('ok',true,'entityType','report_structure','entityId',p_report_id,'reportRevision',next_revision,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
end;
$$;

drop function if exists public.monthly_v7_delete_module(text, uuid, text, uuid, uuid, bigint, bigint, uuid, bigint);

create or replace function public.monthly_v7_delete_module(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_module_id uuid,
  p_expected_module_revision bigint,
  p_expected_report_revision bigint,
  p_structure_lease_id uuid,
  p_structure_fencing_token bigint,
  p_module_lease_id uuid,
  p_module_fencing_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype; user_row public.monthly_v7_users%rowtype;
  item_row public.monthly_v7_report_items%rowtype; report_row public.monthly_v7_reports%rowtype;
  structure_lease_row public.monthly_v7_entity_leases%rowtype; module_lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text; response jsonb; next_module_revision bigint; next_report_revision bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  request_hash:=encode(digest(convert_to(jsonb_build_object('command','delete_module','module_id',p_module_id,
    'expected_module_revision',p_expected_module_revision,'expected_report_revision',p_expected_report_revision,
    'structure_lease_id',p_structure_lease_id,'structure_fencing_token',p_structure_fencing_token,
    'module_lease_id',p_module_lease_id,'module_fencing_token',p_module_fencing_token)::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'delete_module','module',p_module_id,request_hash,'STARTED') on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH'); end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;

  select i.* into item_row from public.monthly_v7_report_items i join public.monthly_v7_reports r on r.id=i.report_id
    where i.id=p_module_id and r.workspace_id=workspace_row.id and i.deleted_at is null for update of i;
  if not found then
    response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  select * into report_row from public.monthly_v7_reports where id=item_row.report_id for update;
  select * into structure_lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type='report_structure' and entity_id=report_row.id for update;
  select * into module_lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type='module' and entity_id=p_module_id for update;

  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then response:=jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE');
  elsif structure_lease_row.lease_id is null or structure_lease_row.expires_at<=now()
     or structure_lease_row.lease_id<>p_structure_lease_id or structure_lease_row.fencing_token<>p_structure_fencing_token
     or structure_lease_row.holder_user_id<>user_row.id or structure_lease_row.holder_user_session_id<>p_user_session_id
     or structure_lease_row.client_session_id<>btrim(p_client_session_id) then response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
  elsif module_lease_row.lease_id is null or module_lease_row.expires_at<=now()
     or module_lease_row.lease_id<>p_module_lease_id or module_lease_row.fencing_token<>p_module_fencing_token
     or module_lease_row.holder_user_id<>user_row.id or module_lease_row.holder_user_session_id<>p_user_session_id
     or module_lease_row.client_session_id<>btrim(p_client_session_id) then response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
  elsif item_row.revision<>p_expected_module_revision then response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',item_row.revision);
  elsif report_row.revision<>p_expected_report_revision then response:=jsonb_build_object('ok',false,'error','REPORT_REVISION_CONFLICT','currentRevision',report_row.revision);
  elsif (select count(*) from public.monthly_v7_report_items where report_id=report_row.id and deleted_at is null)<=1 then response:=jsonb_build_object('ok',false,'error','LAST_MODULE_REQUIRED');
  end if;
  if response is not null then update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id; return response; end if;

  next_module_revision:=item_row.revision+1; next_report_revision:=report_row.revision+1;
  update public.monthly_v7_report_items set revision=next_module_revision,deleted_at=now(),updated_at=now(),updated_by_user_id=user_row.id where id=p_module_id;
  update public.monthly_v7_reports set revision=next_report_revision,updated_at=now(),updated_by_user_id=user_row.id where id=report_row.id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload)
  values(workspace_row.id,user_row.id,p_operation_id,'module',p_module_id,'delete',item_row.revision,next_module_revision,item_row.payload);
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'module',p_module_id,next_module_revision,'delete');
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'report_structure',report_row.id,next_report_revision,'delete');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and ((entity_type='module' and entity_id=p_module_id) or (entity_type='report_structure' and entity_id=report_row.id));
  response:=jsonb_build_object('ok',true,'entityType','module','entityId',p_module_id,'revision',next_module_revision,'reportRevision',next_report_revision,'deleted',true,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_save_module(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_module_id uuid,
  p_expected_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  item_row public.monthly_v7_report_items%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  next_revision bigint;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;
  user_row := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE', 'authorityState', workspace_row.authority_state);
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'save_module',
    'entity_id', p_module_id,
    'expected_revision', p_expected_revision,
    'lease_id', p_lease_id,
    'fencing_token', p_fencing_token,
    'payload', p_payload
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_operations(
    operation_id, workspace_id, actor_user_id, command_type,
    entity_type, entity_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, user_row.id, 'save_module',
    'module', p_module_id, request_hash, 'STARTED'
  ) on conflict (operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_operations
  where operation_id = p_operation_id
  for update;

  if operation_row.workspace_id <> workspace_row.id
     or operation_row.actor_user_id <> user_row.id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then
    return operation_row.result;
  end if;

  select i.* into item_row
  from public.monthly_v7_report_items i
  join public.monthly_v7_reports r on r.id = i.report_id
  where i.id = p_module_id
    and r.workspace_id = workspace_row.id
    and i.deleted_at is null
    and r.deleted_at is null
  for update of i;
  if not found then
    response := jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
    update public.monthly_v7_operations set status='REJECTED', result=response, completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;

  select * into lease_row
  from public.monthly_v7_entity_leases
  where workspace_id = workspace_row.id
    and entity_type = 'module'
    and entity_id = p_module_id
  for update;
  if not found
     or lease_row.expires_at <= now()
     or lease_row.lease_id <> p_lease_id
     or lease_row.fencing_token <> p_fencing_token
     or lease_row.holder_user_id <> user_row.id
     or lease_row.holder_user_session_id <> p_user_session_id
     or lease_row.client_session_id <> btrim(p_client_session_id) then
    response := jsonb_build_object('ok', false, 'error', 'LEASE_LOST');
    update public.monthly_v7_operations set status='REJECTED', result=response, completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;

  if item_row.revision <> p_expected_revision then
    response := jsonb_build_object(
      'ok', false,
      'error', 'REVISION_CONFLICT',
      'currentRevision', item_row.revision,
      'serverPayload', item_row.payload
    );
    update public.monthly_v7_operations set status='REJECTED', result=response, completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;

  next_revision := item_row.revision + 1;
  update public.monthly_v7_report_items
  set payload = p_payload - '_v7Id' - '_v7Revision',
      revision = next_revision,
      updated_by_user_id = user_row.id,
      updated_at = now()
  where id = item_row.id;

  insert into public.monthly_v7_entity_events(
    workspace_id, actor_user_id, operation_id, entity_type, entity_id,
    action, before_revision, after_revision, before_payload, after_payload
  ) values (
    workspace_row.id, user_row.id, p_operation_id, 'module', item_row.id,
    'update', item_row.revision, next_revision, item_row.payload, p_payload - '_v7Id' - '_v7Revision'
  );
  insert into public.monthly_v7_change_events(
    workspace_id, entity_type, entity_id, entity_revision, action
  ) values (workspace_row.id, 'module', item_row.id, next_revision, 'update');

  -- 釋放持有權但保留 row 與 fencing counter，下一位接管時 token 必須單調增加。
  update public.monthly_v7_entity_leases
  set heartbeat_at = now(), expires_at = now()
  where workspace_id = workspace_row.id and entity_type = 'module' and entity_id = item_row.id;

  response := jsonb_build_object(
    'ok', true,
    'entityType', 'module',
    'entityId', item_row.id,
    'revision', next_revision,
    'operationId', p_operation_id
  );
  update public.monthly_v7_operations
  set status='COMMITTED', result=response, completed_at=now()
  where operation_id = p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_create_record(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_record_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  new_id uuid := gen_random_uuid();
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002', message='WORKSPACE_NOT_FOUND'; end if;
  user_row := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE');
  end if;
  if p_record_type not in ('inspections','deficiencies','detentions','actions','trainings')
     or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;
  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command','create_record','record_type',p_record_type,'payload',p_payload
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(
    operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status
  ) values (
    p_operation_id,workspace_row.id,user_row.id,'create_record','record:'||p_record_type,new_id,request_hash,'STARTED'
  ) on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  new_id := operation_row.entity_id;
  insert into public.monthly_v7_record_items(
    id,workspace_id,record_type,legacy_id,record_date,payload,revision,updated_by_user_id
  ) values (
    new_id,workspace_row.id,p_record_type,'v7:'||new_id::text,
    public.monthly_v7_safe_date(coalesce(nullif(p_payload->>'date',''),nullif(p_payload->>'dueDate',''),nullif(p_payload->>'releaseDate',''))),
    p_payload-'_v7Id'-'_v7Revision',1,user_row.id
  );
  insert into public.monthly_v7_entity_events(
    workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,after_revision,after_payload
  ) values (workspace_row.id,user_row.id,p_operation_id,'record:'||p_record_type,new_id,'create',1,p_payload-'_v7Id'-'_v7Revision');
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'record:'||p_record_type,new_id,1,'create');
  response := jsonb_build_object('ok',true,'entityType','record:'||p_record_type,'entityId',new_id,'revision',1,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_save_record(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_record_id uuid,
  p_expected_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  item_row public.monthly_v7_record_items%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  entity_kind text;
  next_revision bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row := public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  if jsonb_typeof(p_payload)<>'object' then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); end if;
  select * into item_row from public.monthly_v7_record_items
    where id=p_record_id and workspace_id=workspace_row.id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
  entity_kind := 'record:'||item_row.record_type;
  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command','save_record','entity_id',p_record_id,'expected_revision',p_expected_revision,
    'lease_id',p_lease_id,'fencing_token',p_fencing_token,'payload',p_payload
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'save_record',entity_kind,p_record_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type=entity_kind and entity_id=p_record_id for update;
  if not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id
     or lease_row.fencing_token<>p_fencing_token or lease_row.holder_user_id<>user_row.id
     or lease_row.holder_user_session_id<>p_user_session_id or lease_row.client_session_id<>btrim(p_client_session_id) then
    response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  if item_row.revision<>p_expected_revision then
    response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',item_row.revision,'serverPayload',item_row.payload);
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  next_revision:=item_row.revision+1;
  update public.monthly_v7_record_items set
    payload=p_payload-'_v7Id'-'_v7Revision',
    record_date=public.monthly_v7_safe_date(coalesce(nullif(p_payload->>'date',''),nullif(p_payload->>'dueDate',''),nullif(p_payload->>'releaseDate',''))),
    revision=next_revision,updated_by_user_id=user_row.id,updated_at=now()
  where id=p_record_id;
  insert into public.monthly_v7_entity_events(
    workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload,after_payload
  ) values(workspace_row.id,user_row.id,p_operation_id,entity_kind,p_record_id,'update',item_row.revision,next_revision,item_row.payload,p_payload-'_v7Id'-'_v7Revision');
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,entity_kind,p_record_id,next_revision,'update');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and entity_type=entity_kind and entity_id=p_record_id;
  response:=jsonb_build_object('ok',true,'entityType',entity_kind,'entityId',p_record_id,'revision',next_revision,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_delete_record(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_record_id uuid,
  p_expected_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  item_row public.monthly_v7_record_items%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  entity_kind text;
  next_revision bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  select * into item_row from public.monthly_v7_record_items where id=p_record_id and workspace_id=workspace_row.id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
  entity_kind:='record:'||item_row.record_type;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','delete_record','entity_id',p_record_id,'expected_revision',p_expected_revision,
    'lease_id',p_lease_id,'fencing_token',p_fencing_token
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'delete_record',entity_kind,p_record_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type=entity_kind and entity_id=p_record_id for update;
  if not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id
     or lease_row.fencing_token<>p_fencing_token or lease_row.holder_user_id<>user_row.id
     or lease_row.holder_user_session_id<>p_user_session_id or lease_row.client_session_id<>btrim(p_client_session_id) then
    response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  if item_row.revision<>p_expected_revision then
    response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',item_row.revision,'serverPayload',item_row.payload);
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  next_revision:=item_row.revision+1;
  update public.monthly_v7_record_items set revision=next_revision,deleted_at=now(),updated_at=now(),updated_by_user_id=user_row.id where id=p_record_id;
  insert into public.monthly_v7_entity_events(
    workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload
  ) values(workspace_row.id,user_row.id,p_operation_id,entity_kind,p_record_id,'delete',item_row.revision,next_revision,item_row.payload);
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,entity_kind,p_record_id,next_revision,'delete');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and entity_type=entity_kind and entity_id=p_record_id;
  response:=jsonb_build_object('ok',true,'entityType',entity_kind,'entityId',p_record_id,'revision',next_revision,'deleted',true,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_save_report_meta(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_expected_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_title text,
  p_report_date text,
  p_period jsonb,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  before_payload jsonb;
  after_payload jsonb;
  next_revision bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  if nullif(btrim(p_title),'') is null or jsonb_typeof(p_period)<>'object' or jsonb_typeof(p_settings)<>'object' then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','save_report_meta','report_id',p_report_id,'expected_revision',p_expected_revision,
    'lease_id',p_lease_id,'fencing_token',p_fencing_token,'title',btrim(p_title),
    'date',p_report_date,'period',p_period,'settings',p_settings
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'save_report_meta','report_meta',p_report_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into report_row from public.monthly_v7_reports where id=p_report_id and workspace_id=workspace_row.id and deleted_at is null for update;
  if not found then response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
  else
    select * into lease_row from public.monthly_v7_entity_leases
      where workspace_id=workspace_row.id and entity_type='report_meta' and entity_id=p_report_id for update;
    if not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id
       or lease_row.fencing_token<>p_fencing_token or lease_row.holder_user_id<>user_row.id
       or lease_row.holder_user_session_id<>p_user_session_id or lease_row.client_session_id<>btrim(p_client_session_id) then
      response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
    elsif report_row.revision<>p_expected_revision then
      response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',report_row.revision);
    end if;
  end if;
  if response is not null then
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  before_payload:=jsonb_build_object('title',report_row.title,'date',report_row.report_date,'period',report_row.period,'settings',report_row.settings);
  after_payload:=jsonb_build_object('title',btrim(p_title),'date',public.monthly_v7_safe_date(p_report_date),'period',p_period,'settings',p_settings);
  next_revision:=report_row.revision+1;
  update public.monthly_v7_reports set title=btrim(p_title),report_date=public.monthly_v7_safe_date(p_report_date),
    period=p_period,settings=p_settings,revision=next_revision,updated_by_user_id=user_row.id,updated_at=now()
  where id=p_report_id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload,after_payload)
  values(workspace_row.id,user_row.id,p_operation_id,'report_meta',p_report_id,'update',report_row.revision,next_revision,before_payload,after_payload);
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'report_meta',p_report_id,next_revision,'update');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and entity_type='report_meta' and entity_id=p_report_id;
  response:=jsonb_build_object('ok',true,'entityType','report_meta','entityId',p_report_id,'revision',next_revision,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_create_module(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_expected_report_revision bigint,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  new_id uuid:=gen_random_uuid();
  next_report_revision bigint;
  next_rank numeric(24,8);
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  if jsonb_typeof(p_payload)<>'object' then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','create_module','report_id',p_report_id,'expected_report_revision',p_expected_report_revision,
    'lease_id',p_lease_id,'fencing_token',p_fencing_token,'payload',p_payload
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'create_module','module',new_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  new_id:=operation_row.entity_id;
  select * into report_row from public.monthly_v7_reports where id=p_report_id and workspace_id=workspace_row.id and deleted_at is null for update;
  select * into lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type='report_structure' and entity_id=p_report_id for update;
  if report_row.id is null then response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
  elsif not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id
     or lease_row.fencing_token<>p_fencing_token or lease_row.holder_user_id<>user_row.id
     or lease_row.holder_user_session_id<>p_user_session_id or lease_row.client_session_id<>btrim(p_client_session_id) then
    response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
  elsif report_row.revision<>p_expected_report_revision then
    response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','currentRevision',report_row.revision);
  end if;
  if response is not null then
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  select coalesce(max(sort_rank),0)+1 into next_rank from public.monthly_v7_report_items where report_id=p_report_id and deleted_at is null;
  insert into public.monthly_v7_report_items(id,report_id,legacy_item_id,sort_rank,payload,revision,updated_by_user_id)
  values(new_id,p_report_id,'v7:'||new_id::text,next_rank,p_payload-'_v7Id'-'_v7Revision',1,user_row.id);
  next_report_revision:=report_row.revision+1;
  update public.monthly_v7_reports set revision=next_report_revision,updated_by_user_id=user_row.id,updated_at=now() where id=p_report_id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,after_revision,after_payload)
  values(workspace_row.id,user_row.id,p_operation_id,'module',new_id,'create',1,p_payload-'_v7Id'-'_v7Revision');
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'module',new_id,1,'create');
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'report_structure',p_report_id,next_report_revision,'create');
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and entity_type='report_structure' and entity_id=p_report_id;
  response:=jsonb_build_object('ok',true,'entityType','module','entityId',new_id,'revision',1,
    'reportRevision',next_report_revision,'sortRank',next_rank,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_save_module_batch(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  user_row public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_entity_leases%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  item_row public.monthly_v7_report_items%rowtype;
  change_row record;
  request_hash text;
  response jsonb;
  updated_rows jsonb:='[]'::jsonb;
  change_count int;
  matched_count int;
  expected bigint;
  next_revision bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  user_row:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  if jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)=0 or jsonb_array_length(p_changes)>100 then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','save_module_batch','report_id',p_report_id,'lease_id',p_lease_id,
    'fencing_token',p_fencing_token,'changes',p_changes
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,user_row.id,'save_module_batch','kpi_batch',p_report_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>user_row.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into lease_row from public.monthly_v7_entity_leases
    where workspace_id=workspace_row.id and entity_type='kpi_batch' and entity_id=p_report_id for update;
  if not found or lease_row.expires_at<=now() or lease_row.lease_id<>p_lease_id
     or lease_row.fencing_token<>p_fencing_token or lease_row.holder_user_id<>user_row.id
     or lease_row.holder_user_session_id<>p_user_session_id or lease_row.client_session_id<>btrim(p_client_session_id) then
    response:=jsonb_build_object('ok',false,'error','LEASE_LOST');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;

  select jsonb_array_length(p_changes),count(distinct (c.value->>'moduleId'))::int
  into change_count,matched_count from jsonb_array_elements(p_changes)c(value);
  if change_count<>matched_count then
    response:=jsonb_build_object('ok',false,'error','DUPLICATE_TARGET');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  -- 先按 UUID 固定順序鎖定所有 row；完成全體 revision 驗證前不做任何更新。
  perform 1
  from public.monthly_v7_report_items i
  join jsonb_array_elements(p_changes)c(value) on i.id=(c.value->>'moduleId')::uuid
  where i.report_id=p_report_id and i.deleted_at is null
  order by i.id
  for update of i;
  select count(*)::int into matched_count
  from public.monthly_v7_report_items i
  join jsonb_array_elements(p_changes)c(value) on i.id=(c.value->>'moduleId')::uuid
  where i.report_id=p_report_id and i.deleted_at is null;
  if matched_count<>change_count then
    response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  for change_row in select value from jsonb_array_elements(p_changes) order by value->>'moduleId'
  loop
    if jsonb_typeof(change_row.value->'payload')<>'object' then
      response:=jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); exit;
    end if;
    expected:=(change_row.value->>'expectedRevision')::bigint;
    select * into item_row from public.monthly_v7_report_items where id=(change_row.value->>'moduleId')::uuid;
    if item_row.revision<>expected then
      response:=jsonb_build_object('ok',false,'error','REVISION_CONFLICT','entityId',item_row.id,'currentRevision',item_row.revision); exit;
    end if;
  end loop;
  if response is not null then
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  for change_row in select value from jsonb_array_elements(p_changes) order by value->>'moduleId'
  loop
    select * into item_row from public.monthly_v7_report_items where id=(change_row.value->>'moduleId')::uuid;
    next_revision:=item_row.revision+1;
    update public.monthly_v7_report_items set payload=(change_row.value->'payload')-'_v7Id'-'_v7Revision',
      revision=next_revision,updated_by_user_id=user_row.id,updated_at=now() where id=item_row.id;
    insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload,after_payload)
    values(workspace_row.id,user_row.id,p_operation_id,'module',item_row.id,'batch_update',item_row.revision,next_revision,item_row.payload,(change_row.value->'payload')-'_v7Id'-'_v7Revision');
    insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
    values(workspace_row.id,'module',item_row.id,next_revision,'batch_update');
    updated_rows:=updated_rows||jsonb_build_array(jsonb_build_object('entityId',item_row.id,'revision',next_revision));
  end loop;
  update public.monthly_v7_entity_leases set heartbeat_at=now(),expires_at=now()
    where workspace_id=workspace_row.id and entity_type='kpi_batch' and entity_id=p_report_id;
  response:=jsonb_build_object('ok',true,'entityType','kpi_batch','entityId',p_report_id,'updated',updated_rows,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
end;
$$;

create table if not exists public.monthly_v7_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  report_id uuid not null references public.monthly_v7_reports(id) on delete cascade,
  snapshot_kind text not null check(snapshot_kind in ('pdf','history','published','manual')),
  watermark bigint not null,
  report_revision bigint not null,
  content jsonb not null,
  content_sha256 text not null,
  created_by_user_id uuid references public.monthly_v7_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_monthly_v7_report_snapshots_report_created
  on public.monthly_v7_report_snapshots(report_id,created_at desc);

create or replace function public.monthly_v7_create_report_snapshot(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid,
  p_operation_id uuid,
  p_report_id uuid,
  p_snapshot_kind text default 'pdf'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  report_row public.monthly_v7_reports%rowtype;
  snapshot_row public.monthly_v7_report_snapshots%rowtype;
  new_id uuid:=gen_random_uuid();
  request_hash text;
  module_rows jsonb;
  record_rows jsonb;
  snapshot_content jsonb;
  content_hash text;
  current_watermark bigint;
  response jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found or workspace_row.authority_state<>'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE');
  end if;
  select u.* into actor
  from public.monthly_v7_user_sessions us
  join public.monthly_v7_users u on u.id=us.user_id
  join public.monthly_v7_site_sessions ss on ss.id=us.site_session_id
  join public.monthly_v7_site_access policy on policy.workspace_id=ss.workspace_id
  where us.id=p_user_session_id and us.workspace_id=workspace_row.id and us.site_session_id=p_site_session_id
    and us.auth_uid=auth.uid() and us.user_version=u.version and u.active and us.expires_at>now()
    and ss.auth_uid=auth.uid() and ss.policy_generation=policy.generation and ss.expires_at>now();
  if not found then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;
  if p_snapshot_kind not in ('pdf','history','published','manual') then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','create_report_snapshot','report_id',p_report_id,'snapshot_kind',p_snapshot_kind
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,actor.id,'create_report_snapshot','report_snapshot',new_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>actor.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  new_id:=operation_row.entity_id;

  -- 短 barrier：與 report/module/record 的 ROW EXCLUSIVE writer lock 互斥，讀完立即隨 RPC transaction 釋放。
  lock table public.monthly_v7_reports in share mode;
  lock table public.monthly_v7_report_items in share mode;
  lock table public.monthly_v7_record_items in share mode;

  select * into report_row from public.monthly_v7_reports
  where id=p_report_id and workspace_id=workspace_row.id and deleted_at is null;
  if not found then
    response:=jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'legacyItemId',i.legacy_item_id,'sortRank',i.sort_rank,'revision',i.revision,'payload',i.payload
  ) order by i.sort_rank,i.id),'[]'::jsonb) into module_rows
  from public.monthly_v7_report_items i where i.report_id=p_report_id and i.deleted_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'recordType',r.record_type,'legacyId',r.legacy_id,'recordDate',r.record_date,'revision',r.revision,'payload',r.payload
  ) order by r.record_type,r.record_date nulls last,r.id),'[]'::jsonb) into record_rows
  from public.monthly_v7_record_items r where r.workspace_id=workspace_row.id and r.deleted_at is null;
  select coalesce(max(sequence),0) into current_watermark from public.monthly_v7_change_events where workspace_id=workspace_row.id;
  snapshot_content:=jsonb_build_object(
    'report',jsonb_build_object('id',report_row.id,'legacyFileId',report_row.legacy_file_id,'title',report_row.title,
      'date',report_row.report_date,'period',report_row.period,'settings',report_row.settings,'revision',report_row.revision,'status',report_row.status),
    'modules',module_rows,'records',record_rows,'watermark',current_watermark,'authorityEpoch',workspace_row.authority_epoch
  );
  content_hash:=encode(digest(convert_to(snapshot_content::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_report_snapshots(
    id,workspace_id,report_id,snapshot_kind,watermark,report_revision,content,content_sha256,created_by_user_id
  ) values(new_id,workspace_row.id,p_report_id,p_snapshot_kind,current_watermark,report_row.revision,snapshot_content,content_hash,actor.id)
  returning * into snapshot_row;
  response:=jsonb_build_object('ok',true,'snapshotId',snapshot_row.id,'snapshotKind',snapshot_row.snapshot_kind,
    'contentSha256',snapshot_row.content_sha256,'createdAt',snapshot_row.created_at,'snapshot',snapshot_row.content,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_get_report_snapshot(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid,
  p_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  session_ok boolean;
  snapshot_row public.monthly_v7_report_snapshots%rowtype;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;
  select exists(
    select 1 from public.monthly_v7_user_sessions us
    join public.monthly_v7_users u on u.id=us.user_id
    join public.monthly_v7_site_sessions ss on ss.id=us.site_session_id
    join public.monthly_v7_site_access policy on policy.workspace_id=ss.workspace_id
    where us.id=p_user_session_id and us.workspace_id=workspace_row.id and us.site_session_id=p_site_session_id
      and us.auth_uid=auth.uid() and us.user_version=u.version and u.active and us.expires_at>now()
      and ss.auth_uid=auth.uid() and ss.policy_generation=policy.generation and ss.expires_at>now()
  ) into session_ok;
  if not session_ok then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;
  select * into snapshot_row from public.monthly_v7_report_snapshots
  where id=p_snapshot_id and workspace_id=workspace_row.id;
  if not found then return jsonb_build_object('ok',false,'error','SNAPSHOT_NOT_FOUND'); end if;
  return jsonb_build_object('ok',true,'snapshotId',snapshot_row.id,'snapshotKind',snapshot_row.snapshot_kind,
    'contentSha256',snapshot_row.content_sha256,'createdAt',snapshot_row.created_at,'snapshot',snapshot_row.content);
end;
$$;

create or replace function public.monthly_v7_create_user(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_username text,
  p_display_name text,
  p_role text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  new_user public.monthly_v7_users%rowtype;
  new_id uuid:=gen_random_uuid();
  request_hash text;
  response jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  actor:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if workspace_row.authority_state<>'NORMALIZED_ACTIVE' then return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE'); end if;
  if actor.role not in ('owner','admin') then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  if p_role not in ('owner','admin','operator') or nullif(btrim(p_username),'') is null
     or nullif(btrim(p_display_name),'') is null or length(coalesce(p_password,''))<8 then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;
  if p_role='owner' and actor.role<>'owner' then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','create_user','username',btrim(p_username),'display_name',btrim(p_display_name),
    'role',p_role,'password_digest',encode(digest(convert_to(p_password,'UTF8'),'sha256'),'hex')
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,actor.id,'create_user','user',new_id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>actor.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  new_id:=operation_row.entity_id;
  if exists(select 1 from public.monthly_v7_users where workspace_id=workspace_row.id and username=btrim(p_username) and active) then
    response:=jsonb_build_object('ok',false,'error','USERNAME_EXISTS');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  if p_role='owner' then
    update public.monthly_v7_users set role='admin',version=version+1,updated_at=now()
    where workspace_id=workspace_row.id and role='owner' and active;
  end if;
  insert into public.monthly_v7_users(id,workspace_id,username,display_name,role,password_scheme,password_hash,active)
  values(new_id,workspace_row.id,btrim(p_username),btrim(p_display_name),p_role,'bcrypt',crypt(p_password,gen_salt('bf',10)),true)
  returning * into new_user;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,after_revision,after_payload)
  values(workspace_row.id,actor.id,p_operation_id,'user',new_id,'create',new_user.version,
    jsonb_build_object('username',new_user.username,'displayName',new_user.display_name,'role',new_user.role,'active',new_user.active));
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'user',new_id,new_user.version,'create');
  response:=jsonb_build_object('ok',true,'entityType','user','entityId',new_id,'user',jsonb_build_object(
    'id',new_id,'username',new_user.username,'displayName',new_user.display_name,'role',new_user.role,'active',true,'version',new_user.version
  ),'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
exception when unique_violation then
  return jsonb_build_object('ok',false,'error','USERNAME_EXISTS');
end;
$$;

create or replace function public.monthly_v7_update_user(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_target_user_id uuid,
  p_username text,
  p_display_name text,
  p_role text,
  p_new_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  target public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  before_payload jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  actor:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if actor.role not in ('owner','admin') then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  select * into target from public.monthly_v7_users where id=p_target_user_id and workspace_id=workspace_row.id and active for update;
  if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
  if target.role='owner' and actor.role<>'owner' then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  if p_role='owner' and actor.role<>'owner' then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  if target.role='owner' and p_role<>'owner' then return jsonb_build_object('ok',false,'error','OWNER_TRANSFER_REQUIRED'); end if;
  if p_role not in ('owner','admin','operator') or nullif(btrim(p_username),'') is null or nullif(btrim(p_display_name),'') is null
     or (p_new_password is not null and p_new_password<>'' and length(p_new_password)<8) then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','update_user','target',p_target_user_id,'username',btrim(p_username),'display_name',btrim(p_display_name),
    'role',p_role,'password_digest',case when coalesce(p_new_password,'')='' then null else encode(digest(convert_to(p_new_password,'UTF8'),'sha256'),'hex') end
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,actor.id,'update_user','user',target.id,request_hash,'STARTED')
  on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>actor.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  if exists(select 1 from public.monthly_v7_users where workspace_id=workspace_row.id and username=btrim(p_username) and id<>target.id and active) then
    response:=jsonb_build_object('ok',false,'error','USERNAME_EXISTS');
    update public.monthly_v7_operations set status='REJECTED',result=response,completed_at=now() where operation_id=p_operation_id;
    return response;
  end if;
  before_payload:=jsonb_build_object('username',target.username,'displayName',target.display_name,'role',target.role,'active',target.active);
  if p_role='owner' and target.role<>'owner' then
    update public.monthly_v7_users set role='admin',version=version+1,updated_at=now()
    where workspace_id=workspace_row.id and role='owner' and active;
  end if;
  update public.monthly_v7_users set username=btrim(p_username),display_name=btrim(p_display_name),role=p_role,
    password_scheme=case when coalesce(p_new_password,'')='' then password_scheme else 'bcrypt' end,
    password_hash=case when coalesce(p_new_password,'')='' then password_hash else crypt(p_new_password,gen_salt('bf',10)) end,
    version=version+1,updated_at=now()
  where id=target.id returning * into target;
  delete from public.monthly_v7_user_sessions where user_id=target.id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload,after_payload)
  values(workspace_row.id,actor.id,p_operation_id,'user',target.id,'update',target.version-1,target.version,before_payload,
    jsonb_build_object('username',target.username,'displayName',target.display_name,'role',target.role,'active',target.active));
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'user',target.id,target.version,'update');
  response:=jsonb_build_object('ok',true,'entityType','user','entityId',target.id,'user',jsonb_build_object(
    'id',target.id,'username',target.username,'displayName',target.display_name,'role',target.role,'active',target.active,'version',target.version
  ),'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
exception when unique_violation then
  return jsonb_build_object('ok',false,'error','USERNAME_EXISTS');
end;
$$;

create or replace function public.monthly_v7_delete_user(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  target public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  actor:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if actor.role not in ('owner','admin') then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  select * into target from public.monthly_v7_users where id=p_target_user_id and workspace_id=workspace_row.id and active for update;
  if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
  if target.role='owner' or target.id=actor.id then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object('command','delete_user','target',target.id)::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,actor.id,'delete_user','user',target.id,request_hash,'STARTED') on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>actor.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  update public.monthly_v7_users set active=false,version=version+1,updated_at=now() where id=target.id returning * into target;
  delete from public.monthly_v7_user_sessions where user_id=target.id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,before_revision,after_revision,before_payload)
  values(workspace_row.id,actor.id,p_operation_id,'user',target.id,'delete',target.version-1,target.version,
    jsonb_build_object('username',target.username,'displayName',target.display_name,'role',target.role,'active',true));
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'user',target.id,target.version,'delete');
  response:=jsonb_build_object('ok',true,'entityType','user','entityId',target.id,'deleted',true,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_update_site_password(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_operations%rowtype;
  request_hash text;
  response jsonb;
  next_generation bigint;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND'; end if;
  actor:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if actor.role not in ('owner','admin') then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  if length(coalesce(p_new_password,''))<8 then return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD'); end if;
  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','update_site_password','password_digest',encode(digest(convert_to(p_new_password,'UTF8'),'sha256'),'hex')
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.monthly_v7_operations(operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status)
  values(p_operation_id,workspace_row.id,actor.id,'update_site_password','site_policy',workspace_row.id,request_hash,'STARTED') on conflict(operation_id) do nothing;
  select * into operation_row from public.monthly_v7_operations where operation_id=p_operation_id for update;
  if operation_row.workspace_id<>workspace_row.id or operation_row.actor_user_id<>actor.id or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  update public.monthly_v7_site_access set password_scheme='bcrypt',password_hash=crypt(p_new_password,gen_salt('bf',10)),
    generation=generation+1,updated_at=now() where workspace_id=workspace_row.id returning generation into next_generation;
  update public.monthly_v7_workspaces set site_policy_generation=next_generation,updated_at=now() where id=workspace_row.id;
  delete from public.monthly_v7_site_sessions where workspace_id=workspace_row.id;
  insert into public.monthly_v7_entity_events(workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,after_revision)
  values(workspace_row.id,actor.id,p_operation_id,'site_policy',workspace_row.id,'rotate',next_generation);
  insert into public.monthly_v7_change_events(workspace_id,entity_type,entity_id,entity_revision,action)
  values(workspace_row.id,'site_policy',workspace_row.id,next_generation,'rotate');
  response:=jsonb_build_object('ok',true,'entityType','site_policy','entityId',workspace_row.id,
    'generation',next_generation,'requiresReauth',true,'operationId',p_operation_id);
  update public.monthly_v7_operations set status='COMMITTED',result=response,completed_at=now() where operation_id=p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_get_changes_since(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid,
  p_after_sequence bigint default 0,
  p_limit int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  session_ok boolean;
  event_rows jsonb;
  next_watermark bigint := greatest(coalesce(p_after_sequence,0),0);
  has_more boolean := false;
  row_limit int := greatest(1,least(coalesce(p_limit,200),500));
begin
  if auth.uid() is null then raise exception using errcode='28000',message='AUTH_REQUIRED'; end if;
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;
  select exists(
    select 1 from public.monthly_v7_user_sessions us
    join public.monthly_v7_users u on u.id=us.user_id
    join public.monthly_v7_site_sessions ss on ss.id=us.site_session_id
    join public.monthly_v7_site_access policy on policy.workspace_id=ss.workspace_id
    where us.id=p_user_session_id and us.workspace_id=workspace_row.id
      and us.site_session_id=p_site_session_id and us.auth_uid=auth.uid()
      and us.user_version=u.version and u.active and us.expires_at>now()
      and ss.auth_uid=auth.uid() and ss.policy_generation=policy.generation and ss.expires_at>now()
  ) into session_ok;
  if not session_ok then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence',q.sequence,'entityType',q.entity_type,'entityId',q.entity_id,
    'revision',q.entity_revision,'action',q.action,'createdAt',q.created_at
  ) order by q.sequence),'[]'::jsonb), coalesce(max(q.sequence),next_watermark)
  into event_rows,next_watermark
  from (
    select e.* from public.monthly_v7_change_events e
    where e.workspace_id=workspace_row.id and e.sequence>greatest(coalesce(p_after_sequence,0),0)
    order by e.sequence
    limit row_limit
  ) q;
  select exists(
    select 1 from public.monthly_v7_change_events e
    where e.workspace_id=workspace_row.id and e.sequence>next_watermark
  ) into has_more;
  return jsonb_build_object('ok',true,'watermark',next_watermark,'events',event_rows,'hasMore',has_more);
end;
$$;

create or replace function public.monthly_v7_get_entity(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  session_ok boolean;
  module_row public.monthly_v7_report_items%rowtype;
  record_row public.monthly_v7_record_items%rowtype;
  report_row public.monthly_v7_reports%rowtype;
begin
  if auth.uid() is null then raise exception using errcode='28000',message='AUTH_REQUIRED'; end if;
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key=p_workspace_key;
  if not found then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;
  select exists(
    select 1 from public.monthly_v7_user_sessions us
    join public.monthly_v7_users u on u.id=us.user_id
    join public.monthly_v7_site_sessions ss on ss.id=us.site_session_id
    join public.monthly_v7_site_access policy on policy.workspace_id=ss.workspace_id
    where us.id=p_user_session_id and us.workspace_id=workspace_row.id
      and us.site_session_id=p_site_session_id and us.auth_uid=auth.uid()
      and us.user_version=u.version and u.active and us.expires_at>now()
      and ss.auth_uid=auth.uid() and ss.policy_generation=policy.generation and ss.expires_at>now()
  ) into session_ok;
  if not session_ok then raise exception using errcode='28000',message='READ_SESSION_INVALID'; end if;

  if p_entity_type='module' then
    select i.* into module_row from public.monthly_v7_report_items i
    join public.monthly_v7_reports r on r.id=i.report_id
    where i.id=p_entity_id and r.workspace_id=workspace_row.id;
    if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
    if module_row.deleted_at is not null then return jsonb_build_object('ok',true,'entityType','module','entityId',p_entity_id,'deleted',true,'revision',module_row.revision); end if;
    return jsonb_build_object('ok',true,'entityType','module','entityId',module_row.id,
      'legacyItemId',module_row.legacy_item_id,'sortRank',module_row.sort_rank,
      'revision',module_row.revision,'payload',module_row.payload,'deleted',false);
  elsif p_entity_type like 'record:%' then
    select * into record_row from public.monthly_v7_record_items
    where id=p_entity_id and workspace_id=workspace_row.id and record_type=split_part(p_entity_type,':',2);
    if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
    if record_row.deleted_at is not null then return jsonb_build_object('ok',true,'entityType',p_entity_type,'entityId',p_entity_id,'deleted',true,'revision',record_row.revision); end if;
    return jsonb_build_object('ok',true,'entityType',p_entity_type,'entityId',record_row.id,
      'legacyId',record_row.legacy_id,'recordDate',record_row.record_date,
      'revision',record_row.revision,'payload',record_row.payload,'deleted',false);
  elsif p_entity_type='report_meta' then
    select * into report_row from public.monthly_v7_reports
    where id=p_entity_id and workspace_id=workspace_row.id and deleted_at is null;
    if not found then return jsonb_build_object('ok',false,'error','ENTITY_NOT_FOUND'); end if;
    return jsonb_build_object('ok',true,'entityType','report_meta','entityId',report_row.id,
      'revision',report_row.revision,'payload',jsonb_build_object(
        'title',report_row.title,'date',report_row.report_date,'period',report_row.period,'settings',report_row.settings
      ),'deleted',false);
  else
    return jsonb_build_object('ok',false,'error','INVALID_ENTITY_TYPE');
  end if;
end;
$$;

-- V7 tables are not browser-writable; browser writes only through validated RPCs.
alter table public.monthly_v7_workspaces enable row level security;
alter table public.monthly_v7_reports enable row level security;
alter table public.monthly_v7_report_items enable row level security;
alter table public.monthly_v7_record_items enable row level security;
alter table public.monthly_v7_users enable row level security;
alter table public.monthly_v7_site_access enable row level security;
alter table public.monthly_v7_legacy_snapshots enable row level security;
alter table public.monthly_v7_migration_receipts enable row level security;
alter table public.monthly_v7_site_sessions enable row level security;
alter table public.monthly_v7_user_sessions enable row level security;
alter table public.monthly_v7_entity_leases enable row level security;
alter table public.monthly_v7_operations enable row level security;
alter table public.monthly_v7_entity_events enable row level security;
alter table public.monthly_v7_change_events enable row level security;
alter table public.monthly_v7_report_snapshots enable row level security;

create or replace function public.monthly_v7_can_read_change_events(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path=pg_catalog,public
as $$
  select exists (
    select 1
    from public.monthly_v7_site_sessions s
    join public.monthly_v7_site_access p on p.workspace_id=s.workspace_id
    where s.workspace_id=p_workspace_id
      and s.auth_uid=auth.uid()
      and s.policy_generation=p.generation
      and s.expires_at>now()
  )
$$;

drop policy if exists monthly_v7_change_event_hint_select on public.monthly_v7_change_events;
create policy monthly_v7_change_event_hint_select
on public.monthly_v7_change_events
for select
to authenticated
using (public.monthly_v7_can_read_change_events(monthly_v7_change_events.workspace_id));

revoke all on public.monthly_v7_workspaces from anon, authenticated;
revoke all on public.monthly_v7_reports from anon, authenticated;
revoke all on public.monthly_v7_report_items from anon, authenticated;
revoke all on public.monthly_v7_record_items from anon, authenticated;
revoke all on public.monthly_v7_users from anon, authenticated;
revoke all on public.monthly_v7_site_access from anon, authenticated;
revoke all on public.monthly_v7_legacy_snapshots from anon, authenticated;
revoke all on public.monthly_v7_migration_receipts from anon, authenticated;
revoke all on public.monthly_v7_site_sessions from anon, authenticated;
revoke all on public.monthly_v7_user_sessions from anon, authenticated;
revoke all on public.monthly_v7_entity_leases from anon, authenticated;
revoke all on public.monthly_v7_operations from anon, authenticated;
revoke all on public.monthly_v7_entity_events from anon, authenticated;
revoke all on public.monthly_v7_change_events from anon, authenticated;
revoke all on public.monthly_v7_report_snapshots from anon, authenticated;
grant select on public.monthly_v7_change_events to authenticated;

revoke execute on function public.monthly_v7_safe_date(text) from public, anon, authenticated;
revoke execute on function public.monthly_v7_migrate_workspace(text) from public, anon, authenticated;
revoke execute on function public.monthly_v7_password_matches(text, text, text) from public, anon, authenticated;
revoke execute on function public.monthly_v7_get_status(text) from public;
revoke execute on function public.monthly_v7_open_site(text, text, text) from public;
revoke execute on function public.monthly_v7_login_user(text, uuid, text, text, text) from public;
revoke execute on function public.monthly_v7_get_snapshot(text, uuid, uuid) from public;
revoke execute on function public.monthly_v7_logout(text, uuid, uuid) from public;
revoke execute on function public.monthly_v7_session_user(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.monthly_v7_entity_exists(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.monthly_v7_can_read_change_events(uuid) from public, anon;
revoke execute on function public.monthly_v7_claim_lease(text, uuid, text, text, uuid, int) from public;
revoke execute on function public.monthly_v7_save_module(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) from public;
revoke execute on function public.monthly_v7_create_record(text, uuid, text, uuid, text, jsonb) from public;
revoke execute on function public.monthly_v7_save_record(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) from public;
revoke execute on function public.monthly_v7_delete_record(text, uuid, text, uuid, uuid, bigint, uuid, bigint) from public;
revoke execute on function public.monthly_v7_get_changes_since(text, uuid, uuid, bigint, int) from public;
revoke execute on function public.monthly_v7_get_entity(text, uuid, uuid, text, uuid) from public;
revoke execute on function public.monthly_v7_save_report_meta(text, uuid, text, uuid, uuid, bigint, uuid, bigint, text, text, jsonb, jsonb) from public;
revoke execute on function public.monthly_v7_create_module(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) from public;
revoke execute on function public.monthly_v7_save_module_batch(text, uuid, text, uuid, uuid, uuid, bigint, jsonb) from public;
revoke execute on function public.monthly_v7_create_user(text, uuid, text, uuid, text, text, text, text) from public;
revoke execute on function public.monthly_v7_update_user(text, uuid, text, uuid, uuid, text, text, text, text) from public;
revoke execute on function public.monthly_v7_delete_user(text, uuid, text, uuid, uuid) from public;
revoke execute on function public.monthly_v7_update_site_password(text, uuid, text, uuid, text) from public;
revoke execute on function public.monthly_v7_create_report_snapshot(text, uuid, uuid, uuid, uuid, text) from public;
revoke execute on function public.monthly_v7_get_report_snapshot(text, uuid, uuid, uuid) from public;
revoke execute on function public.monthly_v7_renew_lease(text, uuid, text, text, uuid, uuid, bigint, int) from public;
revoke execute on function public.monthly_v7_release_lease(text, uuid, text, text, uuid, uuid, bigint) from public;
revoke execute on function public.monthly_v7_reorder_modules(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) from public;
revoke execute on function public.monthly_v7_delete_module(text, uuid, text, uuid, uuid, bigint, bigint, uuid, bigint, uuid, bigint) from public;

grant execute on function public.monthly_v7_get_status(text) to anon, authenticated;
grant execute on function public.monthly_v7_can_read_change_events(uuid) to authenticated;
grant execute on function public.monthly_v7_open_site(text, text, text) to authenticated;
grant execute on function public.monthly_v7_login_user(text, uuid, text, text, text) to authenticated;
grant execute on function public.monthly_v7_get_snapshot(text, uuid, uuid) to authenticated;
grant execute on function public.monthly_v7_logout(text, uuid, uuid) to authenticated;
grant execute on function public.monthly_v7_claim_lease(text, uuid, text, text, uuid, int) to authenticated;
grant execute on function public.monthly_v7_save_module(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) to authenticated;
grant execute on function public.monthly_v7_create_record(text, uuid, text, uuid, text, jsonb) to authenticated;
grant execute on function public.monthly_v7_save_record(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) to authenticated;
grant execute on function public.monthly_v7_delete_record(text, uuid, text, uuid, uuid, bigint, uuid, bigint) to authenticated;
grant execute on function public.monthly_v7_get_changes_since(text, uuid, uuid, bigint, int) to authenticated;
grant execute on function public.monthly_v7_get_entity(text, uuid, uuid, text, uuid) to authenticated;
grant execute on function public.monthly_v7_save_report_meta(text, uuid, text, uuid, uuid, bigint, uuid, bigint, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.monthly_v7_create_module(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) to authenticated;
grant execute on function public.monthly_v7_save_module_batch(text, uuid, text, uuid, uuid, uuid, bigint, jsonb) to authenticated;
grant execute on function public.monthly_v7_create_user(text, uuid, text, uuid, text, text, text, text) to authenticated;
grant execute on function public.monthly_v7_update_user(text, uuid, text, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.monthly_v7_delete_user(text, uuid, text, uuid, uuid) to authenticated;
grant execute on function public.monthly_v7_update_site_password(text, uuid, text, uuid, text) to authenticated;
grant execute on function public.monthly_v7_create_report_snapshot(text, uuid, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.monthly_v7_get_report_snapshot(text, uuid, uuid, uuid) to authenticated;
grant execute on function public.monthly_v7_renew_lease(text, uuid, text, text, uuid, uuid, bigint, int) to authenticated;
grant execute on function public.monthly_v7_release_lease(text, uuid, text, text, uuid, uuid, bigint) to authenticated;
grant execute on function public.monthly_v7_reorder_modules(text, uuid, text, uuid, uuid, bigint, uuid, bigint, jsonb) to authenticated;
grant execute on function public.monthly_v7_delete_module(text, uuid, text, uuid, uuid, bigint, bigint, uuid, bigint, uuid, bigint) to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(
       select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='monthly_v7_change_events'
     ) then
    execute 'alter publication supabase_realtime add table public.monthly_v7_change_events';
  end if;
exception when undefined_table then
  null;
end
$$;
