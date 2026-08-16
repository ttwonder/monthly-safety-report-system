-- 專題報告獨立 authority（新增式 migration）
-- Build: Topic Reports 1.0.0
-- 本檔只新增 topic tables/RPC；不修改月報 report/module/snapshot/change-event 語義。

begin;

create table if not exists public.monthly_v7_topic_number_counters (
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  business_date date not null,
  last_sequence integer not null default 0 check (last_sequence between 0 and 999),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, business_date)
);

create table if not exists public.monthly_v7_topic_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  system_number text not null check (system_number ~ '^SR-[0-9]{8}-[0-9]{3}$'),
  title text not null check (length(btrim(title)) between 1 and 240),
  report_date date not null,
  content jsonb not null check (
    jsonb_typeof(content) = 'object'
    and content ->> 'domain' = 'topic'
    and jsonb_typeof(content -> 'modules') = 'array'
  ),
  revision bigint not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft','final','archived')),
  created_by_user_id uuid not null references public.monthly_v7_users(id) on delete restrict,
  updated_by_user_id uuid not null references public.monthly_v7_users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, system_number),
  unique (workspace_id, id)
);

create index if not exists idx_monthly_v7_topic_reports_workspace_updated
  on public.monthly_v7_topic_reports(workspace_id, updated_at desc, system_number desc)
  where deleted_at is null;

create table if not exists public.monthly_v7_topic_report_leases (
  report_id uuid primary key references public.monthly_v7_topic_reports(id) on delete cascade,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  lease_id uuid not null default gen_random_uuid(),
  holder_user_id uuid not null references public.monthly_v7_users(id) on delete cascade,
  holder_user_session_id uuid not null references public.monthly_v7_user_sessions(id) on delete cascade,
  client_session_id text not null,
  editor_window_id uuid not null,
  fencing_token bigint not null default 1 check (fencing_token > 0),
  claimed_at timestamptz not null default clock_timestamp(),
  heartbeat_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz
);

create index if not exists idx_monthly_v7_topic_leases_workspace_expiry
  on public.monthly_v7_topic_report_leases(workspace_id, expires_at);

create table if not exists public.monthly_v7_topic_operations (
  operation_id uuid primary key,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  actor_user_id uuid not null references public.monthly_v7_users(id) on delete cascade,
  command_type text not null check (command_type in ('create_report','save_report','create_snapshot')),
  report_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('STARTED','COMMITTED','REJECTED')),
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create index if not exists idx_monthly_v7_topic_operations_workspace_created
  on public.monthly_v7_topic_operations(workspace_id, created_at desc);

create table if not exists public.monthly_v7_topic_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  report_id uuid not null references public.monthly_v7_topic_reports(id) on delete cascade,
  report_revision bigint not null check (report_revision > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid not null references public.monthly_v7_users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_monthly_v7_topic_snapshots_report_created
  on public.monthly_v7_topic_report_snapshots(report_id, created_at desc);

alter table public.monthly_v7_topic_number_counters enable row level security;
alter table public.monthly_v7_topic_reports enable row level security;
alter table public.monthly_v7_topic_report_leases enable row level security;
alter table public.monthly_v7_topic_operations enable row level security;
alter table public.monthly_v7_topic_report_snapshots enable row level security;

revoke all on table public.monthly_v7_topic_number_counters from public, anon, authenticated;
revoke all on table public.monthly_v7_topic_reports from public, anon, authenticated;
revoke all on table public.monthly_v7_topic_report_leases from public, anon, authenticated;
revoke all on table public.monthly_v7_topic_operations from public, anon, authenticated;
revoke all on table public.monthly_v7_topic_report_snapshots from public, anon, authenticated;

create or replace function public.monthly_v7_topic_report_json(
  p_report public.monthly_v7_topic_reports
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, extensions, public
as $$
  select jsonb_build_object(
    'id', p_report.id,
    'systemNumber', p_report.system_number,
    'title', p_report.title,
    'reportDate', p_report.report_date,
    'content', p_report.content,
    'revision', p_report.revision,
    'status', p_report.status,
    'createdAt', p_report.created_at,
    'updatedAt', p_report.updated_at,
    'createdByUserId', p_report.created_by_user_id,
    'updatedByUserId', p_report.updated_by_user_id
  )
$$;

create or replace function public.monthly_v7_topic_lease_json(
  p_lease public.monthly_v7_topic_report_leases
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, extensions, public
as $$
  select jsonb_build_object(
    'reportId', p_lease.report_id,
    'leaseId', p_lease.lease_id,
    'fencingToken', p_lease.fencing_token,
    'editorWindowId', p_lease.editor_window_id,
    'expiresAt', p_lease.expires_at
  )
$$;

create or replace function public.monthly_v7_topic_list_reports(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  rows_json jsonb;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);

  select coalesce(jsonb_agg(row_json order by updated_at desc, system_number desc), '[]'::jsonb)
  into rows_json
  from (
    select
      r.updated_at,
      r.system_number,
      jsonb_build_object(
        'id', r.id,
        'systemNumber', r.system_number,
        'title', r.title,
        'reportDate', r.report_date,
        'revision', r.revision,
        'status', r.status,
        'moduleCount', coalesce(jsonb_array_length(r.content -> 'modules'), 0),
        'createdAt', r.created_at,
        'updatedAt', r.updated_at,
        'updatedBy', updater.display_name,
        'editing', case when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then true else false end,
        'holderDisplayName', case when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then holder.display_name else null end,
        'leaseExpiresAt', case when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then l.expires_at else null end
      ) as row_json
    from public.monthly_v7_topic_reports r
    join public.monthly_v7_users updater on updater.id = r.updated_by_user_id
    left join public.monthly_v7_topic_report_leases l on l.report_id = r.id
    left join public.monthly_v7_users holder on holder.id = l.holder_user_id
    where r.workspace_id = workspace_row.id and r.deleted_at is null
  ) listed;

  return jsonb_build_object('ok', true, 'reports', rows_json, 'actor', jsonb_build_object(
    'id', actor.id, 'username', actor.username, 'displayName', actor.display_name, 'role', actor.role
  ));
end;
$$;

create or replace function public.monthly_v7_topic_get_report(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_report_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  report_row public.monthly_v7_topic_reports%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  holder_name text;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  select * into report_row from public.monthly_v7_topic_reports
  where id = p_report_id and workspace_id = workspace_row.id and deleted_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND'); end if;

  select * into lease_row from public.monthly_v7_topic_report_leases
  where report_id = p_report_id and released_at is null and expires_at > clock_timestamp();
  if found then select display_name into holder_name from public.monthly_v7_users where id = lease_row.holder_user_id; end if;

  return jsonb_build_object(
    'ok', true,
    'report', public.monthly_v7_topic_report_json(report_row),
    'editing', lease_row.report_id is not null,
    'holderDisplayName', holder_name,
    'leaseExpiresAt', lease_row.expires_at,
    'actor', jsonb_build_object('id', actor.id, 'username', actor.username, 'displayName', actor.display_name, 'role', actor.role)
  );
end;
$$;

create or replace function public.monthly_v7_topic_create_report(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_editor_window_id uuid,
  p_title text,
  p_report_date date,
  p_content jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_topic_operations%rowtype;
  report_row public.monthly_v7_topic_reports%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  new_report_id uuid := gen_random_uuid();
  topic_business_date date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  next_sequence integer;
  request_hash text;
  response jsonb;
  normalized_content jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE');
  end if;
  if p_editor_window_id is null or nullif(btrim(p_title), '') is null or length(btrim(p_title)) > 240
     or p_report_date is null or p_content is null or jsonb_typeof(p_content) <> 'object'
     or p_content ->> 'domain' <> 'topic' or jsonb_typeof(p_content -> 'modules') <> 'array'
     or pg_column_size(p_content) > 25165824 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  normalized_content := p_content || jsonb_build_object(
    'schemaVersion', 1, 'domain', 'topic', 'title', btrim(p_title), 'reportDate', p_report_date
  );
  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'create_report', 'editorWindowId', p_editor_window_id,
    'title', btrim(p_title), 'reportDate', p_report_date, 'content', normalized_content
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_topic_operations(
    operation_id, workspace_id, actor_user_id, command_type, report_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'create_report', new_report_id, request_hash, 'STARTED'
  ) on conflict (operation_id) do nothing;

  select * into operation_row from public.monthly_v7_topic_operations
  where operation_id = p_operation_id for update;
  if operation_row.workspace_id <> workspace_row.id or operation_row.actor_user_id <> actor.id
     or operation_row.command_type <> 'create_report' or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  new_report_id := operation_row.report_id;

  insert into public.monthly_v7_topic_number_counters(workspace_id, business_date, last_sequence)
  values (workspace_row.id, topic_business_date, 0)
  on conflict (workspace_id, business_date) do nothing;
  select counters.last_sequence into next_sequence
  from public.monthly_v7_topic_number_counters counters
  where counters.workspace_id = workspace_row.id and counters.business_date = topic_business_date
  for update;
  if next_sequence >= 999 then
    response := jsonb_build_object('ok', false, 'error', 'SYSTEM_NUMBER_EXHAUSTED');
    update public.monthly_v7_topic_operations set status = 'REJECTED', result = response, completed_at = clock_timestamp()
    where operation_id = p_operation_id;
    return response;
  end if;
  next_sequence := next_sequence + 1;
  update public.monthly_v7_topic_number_counters counters
  set last_sequence = next_sequence, updated_at = clock_timestamp()
  where counters.workspace_id = workspace_row.id and counters.business_date = topic_business_date;

  insert into public.monthly_v7_topic_reports(
    id, workspace_id, system_number, title, report_date, content,
    revision, status, created_by_user_id, updated_by_user_id
  ) values (
    new_report_id, workspace_row.id,
    'SR-' || to_char(topic_business_date, 'YYYYMMDD') || '-' || lpad(next_sequence::text, 3, '0'),
    btrim(p_title), p_report_date, normalized_content,
    1, 'draft', actor.id, actor.id
  ) returning * into report_row;

  insert into public.monthly_v7_topic_report_leases(
    report_id, workspace_id, holder_user_id, holder_user_session_id,
    client_session_id, editor_window_id, fencing_token, expires_at
  ) values (
    report_row.id, workspace_row.id, actor.id, p_user_session_id,
    btrim(p_client_session_id), p_editor_window_id, 1, clock_timestamp() + interval '90 seconds'
  ) returning * into lease_row;

  response := jsonb_build_object(
    'ok', true,
    'report', public.monthly_v7_topic_report_json(report_row),
    'lease', public.monthly_v7_topic_lease_json(lease_row),
    'operationId', p_operation_id
  );
  update public.monthly_v7_topic_operations
  set status = 'COMMITTED', result = response, completed_at = clock_timestamp()
  where operation_id = p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_topic_acquire_report_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_report_id uuid,
  p_editor_window_id uuid,
  p_ttl_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  report_row public.monthly_v7_topic_reports%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  holder_name text;
  ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 90), 180));
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE');
  end if;
  if p_editor_window_id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD'); end if;
  select * into report_row from public.monthly_v7_topic_reports
  where id = p_report_id and workspace_id = workspace_row.id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND'); end if;

  select * into lease_row from public.monthly_v7_topic_report_leases
  where report_id = p_report_id for update;
  if not found then
    insert into public.monthly_v7_topic_report_leases(
      report_id, workspace_id, holder_user_id, holder_user_session_id,
      client_session_id, editor_window_id, fencing_token, expires_at
    ) values (
      report_row.id, workspace_row.id, actor.id, p_user_session_id,
      btrim(p_client_session_id), p_editor_window_id, 1, clock_timestamp() + make_interval(secs => ttl)
    ) returning * into lease_row;
  elsif lease_row.released_at is null and lease_row.expires_at > clock_timestamp()
    and lease_row.holder_user_id = actor.id
    and lease_row.holder_user_session_id = p_user_session_id
    and lease_row.client_session_id = btrim(p_client_session_id)
    and lease_row.editor_window_id = p_editor_window_id then
    update public.monthly_v7_topic_report_leases
    set heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => ttl)
    where report_id = p_report_id returning * into lease_row;
  elsif lease_row.released_at is null and lease_row.expires_at > clock_timestamp() then
    select display_name into holder_name from public.monthly_v7_users where id = lease_row.holder_user_id;
    return jsonb_build_object(
      'ok', false, 'error', 'LEASE_HELD', 'reportId', p_report_id,
      'holderDisplayName', holder_name, 'expiresAt', lease_row.expires_at
    );
  else
    update public.monthly_v7_topic_report_leases
    set lease_id = gen_random_uuid(), holder_user_id = actor.id,
        holder_user_session_id = p_user_session_id, client_session_id = btrim(p_client_session_id),
        editor_window_id = p_editor_window_id, fencing_token = fencing_token + 1,
        claimed_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
        expires_at = clock_timestamp() + make_interval(secs => ttl), released_at = null
    where report_id = p_report_id returning * into lease_row;
  end if;

  return public.monthly_v7_topic_lease_json(lease_row) || jsonb_build_object('ok', true, 'editable', true);
end;
$$;

create or replace function public.monthly_v7_topic_heartbeat_report_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_report_id uuid,
  p_editor_window_id uuid,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_ttl_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 90), 180));
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  update public.monthly_v7_topic_report_leases
  set heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => ttl)
  where report_id = p_report_id and workspace_id = workspace_row.id
    and lease_id = p_lease_id and fencing_token = p_fencing_token
    and holder_user_id = actor.id and holder_user_session_id = p_user_session_id
    and client_session_id = btrim(p_client_session_id) and editor_window_id = p_editor_window_id
    and released_at is null and expires_at > clock_timestamp()
  returning * into lease_row;
  if not found then return jsonb_build_object('ok', false, 'error', 'LEASE_LOST'); end if;
  return public.monthly_v7_topic_lease_json(lease_row) || jsonb_build_object('ok', true);
end;
$$;

create or replace function public.monthly_v7_topic_release_report_lease(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_report_id uuid,
  p_editor_window_id uuid,
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
  actor public.monthly_v7_users%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  update public.monthly_v7_topic_report_leases
  set heartbeat_at = clock_timestamp(), expires_at = clock_timestamp(), released_at = clock_timestamp()
  where report_id = p_report_id and workspace_id = workspace_row.id
    and lease_id = p_lease_id and fencing_token = p_fencing_token
    and holder_user_id = actor.id and holder_user_session_id = p_user_session_id
    and client_session_id = btrim(p_client_session_id) and editor_window_id = p_editor_window_id
    and released_at is null
  returning * into lease_row;
  if not found then return jsonb_build_object('ok', false, 'error', 'LEASE_LOST'); end if;
  return jsonb_build_object(
    'ok', true, 'released', true, 'reportId', p_report_id,
    'leaseId', lease_row.lease_id, 'fencingToken', lease_row.fencing_token
  );
end;
$$;

create or replace function public.monthly_v7_topic_save_report(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_editor_window_id uuid,
  p_lease_id uuid,
  p_fencing_token bigint,
  p_expected_revision bigint,
  p_title text,
  p_report_date date,
  p_status text,
  p_content jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_topic_operations%rowtype;
  report_row public.monthly_v7_topic_reports%rowtype;
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  request_hash text;
  response jsonb;
  normalized_content jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE');
  end if;
  if p_editor_window_id is null or p_lease_id is null or p_fencing_token is null or p_expected_revision is null
     or nullif(btrim(p_title), '') is null or length(btrim(p_title)) > 240
     or p_report_date is null or p_status not in ('draft','final')
     or p_content is null or jsonb_typeof(p_content) <> 'object'
     or p_content ->> 'domain' <> 'topic' or jsonb_typeof(p_content -> 'modules') <> 'array'
     or pg_column_size(p_content) > 25165824 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;
  normalized_content := p_content || jsonb_build_object(
    'schemaVersion', 1, 'domain', 'topic', 'title', btrim(p_title), 'reportDate', p_report_date
  );
  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'save_report', 'reportId', p_report_id, 'editorWindowId', p_editor_window_id,
    'leaseId', p_lease_id, 'fencingToken', p_fencing_token, 'expectedRevision', p_expected_revision,
    'title', btrim(p_title), 'reportDate', p_report_date, 'status', p_status, 'content', normalized_content
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_topic_operations(
    operation_id, workspace_id, actor_user_id, command_type, report_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'save_report', p_report_id, request_hash, 'STARTED'
  ) on conflict (operation_id) do nothing;
  select * into operation_row from public.monthly_v7_topic_operations
  where operation_id = p_operation_id for update;
  if operation_row.workspace_id <> workspace_row.id or operation_row.actor_user_id <> actor.id
     or operation_row.command_type <> 'save_report' or operation_row.report_id <> p_report_id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;

  select * into report_row from public.monthly_v7_topic_reports
  where id = p_report_id and workspace_id = workspace_row.id and deleted_at is null for update;
  select * into lease_row from public.monthly_v7_topic_report_leases
  where report_id = p_report_id for update;
  if report_row.id is null then
    response := jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
  elsif lease_row.report_id is null or lease_row.released_at is not null or lease_row.expires_at <= clock_timestamp()
    or lease_row.lease_id <> p_lease_id or lease_row.fencing_token <> p_fencing_token
    or lease_row.holder_user_id <> actor.id or lease_row.holder_user_session_id <> p_user_session_id
    or lease_row.client_session_id <> btrim(p_client_session_id) or lease_row.editor_window_id <> p_editor_window_id then
    response := jsonb_build_object('ok', false, 'error', 'LEASE_LOST');
  elsif report_row.revision <> p_expected_revision then
    response := jsonb_build_object(
      'ok', false, 'error', 'REVISION_CONFLICT', 'currentRevision', report_row.revision,
      'report', public.monthly_v7_topic_report_json(report_row)
    );
  else
    update public.monthly_v7_topic_reports
    set title = btrim(p_title), report_date = p_report_date, status = p_status,
        content = normalized_content, revision = revision + 1,
        updated_by_user_id = actor.id, updated_at = clock_timestamp()
    where id = p_report_id returning * into report_row;
    update public.monthly_v7_topic_report_leases
    set heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + interval '90 seconds'
    where report_id = p_report_id returning * into lease_row;
    response := jsonb_build_object(
      'ok', true, 'report', public.monthly_v7_topic_report_json(report_row),
      'lease', public.monthly_v7_topic_lease_json(lease_row), 'operationId', p_operation_id
    );
    update public.monthly_v7_topic_operations
    set status = 'COMMITTED', result = response, completed_at = clock_timestamp()
    where operation_id = p_operation_id;
    return response;
  end if;

  update public.monthly_v7_topic_operations
  set status = 'REJECTED', result = response, completed_at = clock_timestamp()
  where operation_id = p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_topic_create_snapshot(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  operation_row public.monthly_v7_topic_operations%rowtype;
  report_row public.monthly_v7_topic_reports%rowtype;
  snapshot_row public.monthly_v7_topic_report_snapshots%rowtype;
  request_hash text;
  snapshot_content jsonb;
  response jsonb;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'create_snapshot', 'reportId', p_report_id, 'expectedRevision', p_expected_revision
  )::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.monthly_v7_topic_operations(
    operation_id, workspace_id, actor_user_id, command_type, report_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'create_snapshot', p_report_id, request_hash, 'STARTED'
  ) on conflict (operation_id) do nothing;
  select * into operation_row from public.monthly_v7_topic_operations
  where operation_id = p_operation_id for update;
  if operation_row.workspace_id <> workspace_row.id or operation_row.actor_user_id <> actor.id
     or operation_row.command_type <> 'create_snapshot' or operation_row.report_id <> p_report_id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then return operation_row.result; end if;
  select * into report_row from public.monthly_v7_topic_reports
  where id = p_report_id and workspace_id = workspace_row.id and deleted_at is null for share;
  if not found then response := jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
  elsif report_row.revision <> p_expected_revision then
    response := jsonb_build_object('ok', false, 'error', 'REVISION_CONFLICT', 'currentRevision', report_row.revision);
  else
    snapshot_content := jsonb_build_object('domain', 'topic', 'report', public.monthly_v7_topic_report_json(report_row));
    insert into public.monthly_v7_topic_report_snapshots(
      workspace_id, report_id, report_revision, content, content_sha256, created_by_user_id
    ) values (
      workspace_row.id, report_row.id, report_row.revision, snapshot_content,
      encode(digest(convert_to(snapshot_content::text, 'UTF8'), 'sha256'), 'hex'), actor.id
    ) returning * into snapshot_row;
    response := jsonb_build_object(
      'ok', true, 'snapshotId', snapshot_row.id, 'reportRevision', snapshot_row.report_revision,
      'contentSha256', snapshot_row.content_sha256, 'createdAt', snapshot_row.created_at,
      'snapshot', snapshot_row.content, 'operationId', p_operation_id
    );
    update public.monthly_v7_topic_operations
    set status = 'COMMITTED', result = response, completed_at = clock_timestamp()
    where operation_id = p_operation_id;
    return response;
  end if;
  update public.monthly_v7_topic_operations
  set status = 'REJECTED', result = response, completed_at = clock_timestamp()
  where operation_id = p_operation_id;
  return response;
end;
$$;

create or replace function public.monthly_v7_topic_get_snapshot(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  actor public.monthly_v7_users%rowtype;
  snapshot_row public.monthly_v7_topic_report_snapshots%rowtype;
begin
  select * into workspace_row from public.monthly_v7_workspaces where legacy_workspace_key = p_workspace_key;
  if not found then raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND'; end if;
  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  select * into snapshot_row from public.monthly_v7_topic_report_snapshots
  where id = p_snapshot_id and workspace_id = workspace_row.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'SNAPSHOT_NOT_FOUND'); end if;
  return jsonb_build_object(
    'ok', true, 'snapshotId', snapshot_row.id, 'reportRevision', snapshot_row.report_revision,
    'contentSha256', snapshot_row.content_sha256, 'createdAt', snapshot_row.created_at,
    'snapshot', snapshot_row.content
  );
end;
$$;

revoke all on function public.monthly_v7_topic_report_json(public.monthly_v7_topic_reports) from public, anon, authenticated;
revoke all on function public.monthly_v7_topic_lease_json(public.monthly_v7_topic_report_leases) from public, anon, authenticated;

revoke all on function public.monthly_v7_topic_list_reports(text,uuid,text) from public, anon;
revoke all on function public.monthly_v7_topic_get_report(text,uuid,text,uuid) from public, anon;
revoke all on function public.monthly_v7_topic_create_report(text,uuid,text,uuid,uuid,text,date,jsonb) from public, anon;
revoke all on function public.monthly_v7_topic_acquire_report_lease(text,uuid,text,uuid,uuid,integer) from public, anon;
revoke all on function public.monthly_v7_topic_heartbeat_report_lease(text,uuid,text,uuid,uuid,uuid,bigint,integer) from public, anon;
revoke all on function public.monthly_v7_topic_release_report_lease(text,uuid,text,uuid,uuid,uuid,bigint) from public, anon;
revoke all on function public.monthly_v7_topic_save_report(text,uuid,text,uuid,uuid,uuid,uuid,bigint,bigint,text,date,text,jsonb) from public, anon;
revoke all on function public.monthly_v7_topic_create_snapshot(text,uuid,text,uuid,uuid,bigint) from public, anon;
revoke all on function public.monthly_v7_topic_get_snapshot(text,uuid,text,uuid) from public, anon;

grant execute on function public.monthly_v7_topic_list_reports(text,uuid,text) to authenticated;
grant execute on function public.monthly_v7_topic_get_report(text,uuid,text,uuid) to authenticated;
grant execute on function public.monthly_v7_topic_create_report(text,uuid,text,uuid,uuid,text,date,jsonb) to authenticated;
grant execute on function public.monthly_v7_topic_acquire_report_lease(text,uuid,text,uuid,uuid,integer) to authenticated;
grant execute on function public.monthly_v7_topic_heartbeat_report_lease(text,uuid,text,uuid,uuid,uuid,bigint,integer) to authenticated;
grant execute on function public.monthly_v7_topic_release_report_lease(text,uuid,text,uuid,uuid,uuid,bigint) to authenticated;
grant execute on function public.monthly_v7_topic_save_report(text,uuid,text,uuid,uuid,uuid,uuid,bigint,bigint,text,date,text,jsonb) to authenticated;
grant execute on function public.monthly_v7_topic_create_snapshot(text,uuid,text,uuid,uuid,bigint) to authenticated;
grant execute on function public.monthly_v7_topic_get_snapshot(text,uuid,text,uuid) to authenticated;

commit;
