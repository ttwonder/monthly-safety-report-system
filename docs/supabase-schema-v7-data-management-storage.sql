-- V7 數據管理增量：密碼權限矩陣與 Supabase 空間統計
-- Build: Monthly 7.3.0 / Topic Reports 1.7.0
-- 執行順序：V7 + trusted-device-resume + topic-reports + topic-reports-v2 之後。
-- 本檔可重跑；不包含任何密碼、token 或 service-role credential。

begin;

-- Admin 可維護非 Owner 帳號資料，但只有 Owner 可重設其他人的登入密碼；
-- Admin 只能重設自己的登入密碼。任何帳號版本變更都撤銷該帳號舊 session / user-resume token。
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
  password_change boolean := coalesce(p_new_password, '') <> '';
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);
  select * into workspace_row
  from public.monthly_v7_workspaces
  where id = workspace_row.id
  for update;

  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if actor.role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  select * into target
  from public.monthly_v7_users
  where id = p_target_user_id
    and workspace_id = workspace_row.id
    and active
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
  end if;

  if target.role = 'owner' and actor.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if p_role = 'owner' and actor.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if target.role = 'owner' and p_role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'OWNER_TRANSFER_REQUIRED');
  end if;
  if password_change and actor.role <> 'owner' and target.id <> actor.id then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if p_role not in ('owner', 'admin', 'operator')
     or nullif(btrim(p_username), '') is null
     or nullif(btrim(p_display_name), '') is null
     or (password_change and length(p_new_password) < 8) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'update_user',
    'target', p_target_user_id,
    'username', btrim(p_username),
    'display_name', btrim(p_display_name),
    'role', p_role,
    'password_digest', case
      when not password_change then null
      else encode(digest(convert_to(p_new_password, 'UTF8'), 'sha256'), 'hex')
    end
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_operations(
    operation_id, workspace_id, actor_user_id, command_type,
    entity_type, entity_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'update_user',
    'user', target.id, request_hash, 'STARTED'
  ) on conflict(operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_operations
  where operation_id = p_operation_id
  for update;
  if operation_row.workspace_id <> workspace_row.id
     or operation_row.actor_user_id <> actor.id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED', 'REJECTED') then
    return operation_row.result;
  end if;

  if exists(
    select 1
    from public.monthly_v7_users
    where workspace_id = workspace_row.id
      and username = btrim(p_username)
      and id <> target.id
      and active
  ) then
    response := jsonb_build_object('ok', false, 'error', 'USERNAME_EXISTS');
    update public.monthly_v7_operations
    set status = 'REJECTED', result = response, completed_at = now()
    where operation_id = p_operation_id;
    return response;
  end if;

  before_payload := jsonb_build_object(
    'username', target.username,
    'displayName', target.display_name,
    'role', target.role,
    'active', target.active
  );

  if p_role = 'owner' and target.role <> 'owner' then
    update public.monthly_v7_users
    set role = 'admin', version = version + 1, updated_at = now()
    where workspace_id = workspace_row.id and role = 'owner' and active;
  end if;

  update public.monthly_v7_users
  set username = btrim(p_username),
      display_name = btrim(p_display_name),
      role = p_role,
      password_scheme = case when password_change then 'bcrypt' else password_scheme end,
      password_hash = case when password_change then crypt(p_new_password, gen_salt('bf', 10)) else password_hash end,
      version = version + 1,
      updated_at = now()
  where id = target.id
  returning * into target;

  update public.monthly_v7_resume_tokens
  set revoked_at = coalesce(revoked_at, now())
  where workspace_id = workspace_row.id
    and user_id = target.id
    and purpose = 'user';
  delete from public.monthly_v7_user_sessions where user_id = target.id;

  insert into public.monthly_v7_entity_events(
    workspace_id, actor_user_id, operation_id, entity_type, entity_id,
    action, before_revision, after_revision, before_payload, after_payload
  ) values (
    workspace_row.id, actor.id, p_operation_id, 'user', target.id,
    'update', target.version - 1, target.version, before_payload,
    jsonb_build_object(
      'username', target.username,
      'displayName', target.display_name,
      'role', target.role,
      'active', target.active
    )
  );
  insert into public.monthly_v7_change_events(
    workspace_id, entity_type, entity_id, entity_revision, action
  ) values (
    workspace_row.id, 'user', target.id, target.version, 'update'
  );

  response := jsonb_build_object(
    'ok', true,
    'entityType', 'user',
    'entityId', target.id,
    'user', jsonb_build_object(
      'id', target.id,
      'username', target.username,
      'displayName', target.display_name,
      'role', target.role,
      'active', target.active,
      'version', target.version
    ),
    'passwordChanged', password_change,
    'requiresUserReauth', password_change,
    'operationId', p_operation_id
  );
  update public.monthly_v7_operations
  set status = 'COMMITTED', result = response, completed_at = now()
  where operation_id = p_operation_id;
  return response;
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'USERNAME_EXISTS');
end;
$$;

-- 進站密碼只允許唯一 Owner 修改；沿用 trusted-device migration 的同交易撤銷語義。
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
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);
  select * into workspace_row
  from public.monthly_v7_workspaces
  where id = workspace_row.id
  for update;

  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if actor.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if length(coalesce(p_new_password, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'update_site_password',
    'password_digest', encode(digest(convert_to(p_new_password, 'UTF8'), 'sha256'), 'hex')
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_operations(
    operation_id, workspace_id, actor_user_id, command_type,
    entity_type, entity_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'update_site_password',
    'site_policy', workspace_row.id, request_hash, 'STARTED'
  ) on conflict(operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_operations
  where operation_id = p_operation_id
  for update;
  if operation_row.workspace_id <> workspace_row.id
     or operation_row.actor_user_id <> actor.id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED', 'REJECTED') then
    return operation_row.result;
  end if;

  update public.monthly_v7_site_access
  set password_scheme = 'bcrypt',
      password_hash = crypt(p_new_password, gen_salt('bf', 10)),
      generation = generation + 1,
      updated_at = now()
  where workspace_id = workspace_row.id
  returning generation into next_generation;

  update public.monthly_v7_workspaces
  set site_policy_generation = next_generation, updated_at = now()
  where id = workspace_row.id;

  update public.monthly_v7_trusted_devices
  set revoked_at = coalesce(revoked_at, now()),
      revoked_reason = coalesce(revoked_reason, 'site_policy_changed')
  where workspace_id = workspace_row.id;
  update public.monthly_v7_resume_tokens
  set revoked_at = coalesce(revoked_at, now())
  where workspace_id = workspace_row.id;
  delete from public.monthly_v7_site_sessions
  where workspace_id = workspace_row.id;

  insert into public.monthly_v7_entity_events(
    workspace_id, actor_user_id, operation_id, entity_type,
    entity_id, action, after_revision
  ) values (
    workspace_row.id, actor.id, p_operation_id, 'site_policy',
    workspace_row.id, 'rotate', next_generation
  );
  insert into public.monthly_v7_change_events(
    workspace_id, entity_type, entity_id, entity_revision, action
  ) values (
    workspace_row.id, 'site_policy', workspace_row.id, next_generation, 'rotate'
  );

  response := jsonb_build_object(
    'ok', true,
    'entityType', 'site_policy',
    'entityId', workspace_row.id,
    'generation', next_generation,
    'requiresReauth', true,
    'operationId', p_operation_id
  );
  update public.monthly_v7_operations
  set status = 'COMMITTED', result = response, completed_at = now()
  where operation_id = p_operation_id;
  return response;
end;
$$;

-- Owner / Admin 的只讀空間總覽。
-- databaseTotalBytes / appDatabasePhysicalBytes 是物理配置量；
-- monthlyReports.logicalBytes 是可歸屬內容列 + 快照列的邏輯量，不冒充資料頁面分攤。
create or replace function public.monthly_v7_get_storage_stats(
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
  database_total_bytes bigint := 0;
  app_database_physical_bytes bigint := 0;
  storage_object_bytes bigint := 0;
  storage_object_count bigint := 0;
  monthly_rows jsonb := '[]'::jsonb;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;

  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if actor.role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  select pg_database_size(current_database())::bigint
  into database_total_bytes;

  select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint
  into app_database_physical_bytes
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'm')
    and (c.relname like 'monthly_v7\_%' escape '\' or c.relname = 'monthly_report_cloud_data');

  if to_regclass('storage.objects') is not null then
    execute $storage$
      select
        count(*)::bigint,
        coalesce(sum(
          case
            when coalesce(metadata ->> 'size', '') ~ '^[0-9]+$'
              then (metadata ->> 'size')::bigint
            else 0
          end
        ), 0)::bigint
      from storage.objects
    $storage$
    into storage_object_count, storage_object_bytes;
  end if;

  select coalesce(jsonb_agg(row_json order by updated_at desc), '[]'::jsonb)
  into monthly_rows
  from (
    select
      r.updated_at,
      jsonb_build_object(
        'id', r.id,
        'legacyFileId', r.legacy_file_id,
        'title', r.title,
        'reportDate', r.report_date,
        'contentBytes', pg_column_size(r)::bigint + item_size.bytes,
        'snapshotBytes', snapshot_size.bytes,
        'logicalBytes', pg_column_size(r)::bigint + item_size.bytes + snapshot_size.bytes,
        'pdfSnapshots', pdf_snapshot_rows.rows
      ) as row_json
    from public.monthly_v7_reports r
    cross join lateral (
      select coalesce(sum(pg_column_size(i)::bigint), 0)::bigint as bytes
      from public.monthly_v7_report_items i
      where i.report_id = r.id
    ) item_size
    cross join lateral (
      select coalesce(sum(pg_column_size(s)::bigint), 0)::bigint as bytes
      from public.monthly_v7_report_snapshots s
      where s.report_id = r.id
    ) snapshot_size
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'reportRevision', s.report_revision,
        'contentSha256', s.content_sha256,
        'createdAt', s.created_at,
        'createdBy', creator.display_name,
        'logicalBytes', pg_column_size(s)::bigint
      ) order by s.created_at desc, s.id desc), '[]'::jsonb) as rows
      from public.monthly_v7_report_snapshots s
      left join public.monthly_v7_users creator on creator.id = s.created_by_user_id
      where s.report_id = r.id
        and s.snapshot_kind = 'pdf'
    ) pdf_snapshot_rows
    where r.workspace_id = workspace_row.id
      and r.deleted_at is null
  ) sized;

  return jsonb_build_object(
    'ok', true,
    'generatedAt', clock_timestamp(),
    'databaseTotalBytes', database_total_bytes,
    'appDatabasePhysicalBytes', app_database_physical_bytes,
    'storageObjectBytes', storage_object_bytes,
    'storageObjectCount', storage_object_count,
    'staticSiteHost', 'github-pages',
    'staticSiteInSupabase', false,
    'monthlyReports', monthly_rows,
    'logicalMetric', 'content_and_snapshots'
  );
end;
$$;

-- Owner 對單一月報明確保留一筆 PDF 快照；其他種類與 authority 資料完全不碰。
-- expected IDs 必須與 transaction 內的現況完全相同；先鎖 report row，再以短 SHARE ROW EXCLUSIVE barrier 阻止新快照被誤刪並序列化清理交易。
create or replace function public.monthly_v7_prune_report_pdf_snapshots(
  p_workspace_key text,
  p_user_session_id uuid,
  p_client_session_id text,
  p_operation_id uuid,
  p_report_id uuid,
  p_keep_snapshot_id uuid,
  p_expected_snapshot_ids jsonb
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
  expected_ids jsonb := '[]'::jsonb;
  current_ids jsonb := '[]'::jsonb;
  expected_count integer := 0;
  distinct_count integer := 0;
  current_count integer := 0;
  deleted_count integer := 0;
  deleted_bytes bigint := 0;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;

  actor := public.monthly_v7_session_user(workspace_row.id, p_user_session_id, p_client_session_id);
  if actor.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'OWNER_REQUIRED');
  end if;
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE');
  end if;
  if p_operation_id is null or p_report_id is null or p_keep_snapshot_id is null
     or jsonb_typeof(p_expected_snapshot_ids) <> 'array'
     or jsonb_array_length(p_expected_snapshot_ids) < 1 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb),
         count(*)::integer,
         count(distinct value)::integer
  into expected_ids, expected_count, distinct_count
  from jsonb_array_elements_text(p_expected_snapshot_ids) expected(value);
  if expected_count <> distinct_count or exists(
    select 1
    from jsonb_array_elements_text(p_expected_snapshot_ids) expected(value)
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'prune_report_pdf_snapshots',
    'report_id', p_report_id,
    'keep_snapshot_id', p_keep_snapshot_id,
    'expected_snapshot_ids', expected_ids
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_operations(
    operation_id, workspace_id, actor_user_id, command_type,
    entity_type, entity_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'prune_report_pdf_snapshots',
    'report_snapshot_retention', p_report_id, request_hash, 'STARTED'
  ) on conflict(operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_operations
  where operation_id = p_operation_id
  for update;
  if operation_row.workspace_id <> workspace_row.id
     or operation_row.actor_user_id <> actor.id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED', 'REJECTED') then
    return operation_row.result;
  end if;

  perform 1
  from public.monthly_v7_reports
  where id = p_report_id
    and workspace_id = workspace_row.id
    and deleted_at is null
  for update;
  if not found then
    response := jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
    update public.monthly_v7_operations
    set status = 'REJECTED', result = response, completed_at = now()
    where operation_id = p_operation_id;
    return response;
  end if;

  lock table public.monthly_v7_report_snapshots in share row exclusive mode;

  select coalesce(jsonb_agg(s.id::text order by s.id::text), '[]'::jsonb), count(*)::integer
  into current_ids, current_count
  from public.monthly_v7_report_snapshots s
  where s.workspace_id = workspace_row.id
    and s.report_id = p_report_id
    and s.snapshot_kind = 'pdf';

  if current_ids <> expected_ids then
    response := jsonb_build_object(
      'ok', false,
      'error', 'SNAPSHOT_SET_CHANGED',
      'currentPdfSnapshotCount', current_count
    );
    update public.monthly_v7_operations
    set status = 'REJECTED', result = response, completed_at = now()
    where operation_id = p_operation_id;
    return response;
  end if;

  if not exists(
    select 1
    from public.monthly_v7_report_snapshots s
    where s.id = p_keep_snapshot_id
      and s.workspace_id = workspace_row.id
      and s.report_id = p_report_id
      and s.snapshot_kind = 'pdf'
  ) then
    response := jsonb_build_object('ok', false, 'error', 'KEEP_SNAPSHOT_INVALID');
    update public.monthly_v7_operations
    set status = 'REJECTED', result = response, completed_at = now()
    where operation_id = p_operation_id;
    return response;
  end if;

  select count(*)::integer, coalesce(sum(pg_column_size(s)::bigint), 0)::bigint
  into deleted_count, deleted_bytes
  from public.monthly_v7_report_snapshots s
  where s.workspace_id = workspace_row.id
    and s.report_id = p_report_id
    and s.snapshot_kind = 'pdf'
    and s.id <> p_keep_snapshot_id;

  delete from public.monthly_v7_report_snapshots s
  where s.workspace_id = workspace_row.id
    and s.report_id = p_report_id
    and s.snapshot_kind = 'pdf'
    and s.id <> p_keep_snapshot_id;

  response := jsonb_build_object(
    'ok', true,
    'reportId', p_report_id,
    'keptSnapshotId', p_keep_snapshot_id,
    'deletedCount', deleted_count,
    'deletedBytes', deleted_bytes,
    'remainingPdfSnapshotCount', 1,
    'operationId', p_operation_id
  );
  update public.monthly_v7_operations
  set status = 'COMMITTED', result = response, completed_at = now()
  where operation_id = p_operation_id;
  return response;
end;
$$;

-- 專題清單逐項回傳「報告列 + 專題快照列」邏輯量。
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
        'logicalBytes', pg_column_size(r)::bigint + snapshot_size.bytes,
        'snapshotBytes', snapshot_size.bytes,
        'createdAt', r.created_at,
        'updatedAt', r.updated_at,
        'updatedBy', updater.display_name,
        'editing', case
          when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then true
          else false
        end,
        'holderDisplayName', case
          when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then holder.display_name
          else null
        end,
        'leaseExpiresAt', case
          when l.report_id is not null and l.released_at is null and l.expires_at > clock_timestamp() then l.expires_at
          else null
        end
      ) as row_json
    from public.monthly_v7_topic_reports r
    join public.monthly_v7_users updater on updater.id = r.updated_by_user_id
    left join public.monthly_v7_topic_report_leases l on l.report_id = r.id
    left join public.monthly_v7_users holder on holder.id = l.holder_user_id
    cross join lateral (
      select coalesce(sum(pg_column_size(s)::bigint), 0)::bigint as bytes
      from public.monthly_v7_topic_report_snapshots s
      where s.report_id = r.id
    ) snapshot_size
    where r.workspace_id = workspace_row.id
      and r.deleted_at is null
  ) listed;

  return jsonb_build_object(
    'ok', true,
    'reports', rows_json,
    'actor', jsonb_build_object(
      'id', actor.id,
      'username', actor.username,
      'displayName', actor.display_name,
      'role', actor.role
    )
  );
end;
$$;

revoke execute on function public.monthly_v7_update_user(text,uuid,text,uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_update_user(text,uuid,text,uuid,uuid,text,text,text,text) to authenticated;

revoke execute on function public.monthly_v7_update_site_password(text,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_update_site_password(text,uuid,text,uuid,text) to authenticated;

revoke execute on function public.monthly_v7_get_storage_stats(text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_get_storage_stats(text,uuid,text) to authenticated;

revoke execute on function public.monthly_v7_prune_report_pdf_snapshots(text,uuid,text,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.monthly_v7_prune_report_pdf_snapshots(text,uuid,text,uuid,uuid,uuid,jsonb) to authenticated;

revoke execute on function public.monthly_v7_topic_list_reports(text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_topic_list_reports(text,uuid,text) to authenticated;

commit;
