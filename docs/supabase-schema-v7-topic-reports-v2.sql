-- 專題報告 V2 增量修正：Owner 軟刪除
-- Build: Topic Reports 1.1.0
-- 只擴充 topic operation/RPC；不讀寫月報 report/module/snapshot/change-event。

begin;

alter table public.monthly_v7_topic_operations
  drop constraint if exists monthly_v7_topic_operations_command_type_check;

alter table public.monthly_v7_topic_operations
  add constraint monthly_v7_topic_operations_command_type_check
  check (command_type in ('create_report','save_report','create_snapshot','delete_report'));

create or replace function public.monthly_v7_topic_delete_report(
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
  lease_row public.monthly_v7_topic_report_leases%rowtype;
  holder_name text;
  request_hash text;
  response jsonb;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key = p_workspace_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKSPACE_NOT_FOUND';
  end if;

  actor := public.monthly_v7_session_user(
    workspace_row.id, p_user_session_id, p_client_session_id
  );
  if workspace_row.authority_state <> 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'AUTHORITY_NOT_ACTIVE');
  end if;
  if p_operation_id is null or p_report_id is null or p_expected_revision is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYLOAD');
  end if;

  request_hash := encode(digest(convert_to(jsonb_build_object(
    'command', 'delete_report',
    'reportId', p_report_id,
    'expectedRevision', p_expected_revision
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.monthly_v7_topic_operations(
    operation_id, workspace_id, actor_user_id, command_type,
    report_id, request_hash, status
  ) values (
    p_operation_id, workspace_row.id, actor.id, 'delete_report',
    p_report_id, request_hash, 'STARTED'
  ) on conflict (operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_topic_operations
  where operation_id = p_operation_id
  for update;

  if operation_row.workspace_id <> workspace_row.id
     or operation_row.actor_user_id <> actor.id
     or operation_row.command_type <> 'delete_report'
     or operation_row.report_id <> p_report_id
     or operation_row.request_hash <> request_hash then
    return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then
    return operation_row.result;
  end if;

  select * into report_row
  from public.monthly_v7_topic_reports
  where id = p_report_id
    and workspace_id = workspace_row.id
    and deleted_at is null
  for update;

  select * into lease_row
  from public.monthly_v7_topic_report_leases
  where report_id = p_report_id
  for update;

  if actor.role <> 'owner' then
    response := jsonb_build_object('ok', false, 'error', 'OWNER_REQUIRED');
  elsif report_row.id is null then
    response := jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
  elsif report_row.revision <> p_expected_revision then
    response := jsonb_build_object(
      'ok', false,
      'error', 'REVISION_CONFLICT',
      'currentRevision', report_row.revision
    );
  elsif lease_row.report_id is not null
     and lease_row.released_at is null
     and lease_row.expires_at > clock_timestamp() then
    select display_name into holder_name
    from public.monthly_v7_users
    where id = lease_row.holder_user_id;
    response := jsonb_build_object(
      'ok', false,
      'error', 'LEASE_HELD',
      'holderDisplayName', coalesce(holder_name, '其他使用者'),
      'expiresAt', lease_row.expires_at
    );
  else
    update public.monthly_v7_topic_reports
    set deleted_at = clock_timestamp(),
        revision = revision + 1,
        updated_by_user_id = actor.id,
        updated_at = clock_timestamp()
    where id = p_report_id
    returning * into report_row;

    update public.monthly_v7_topic_report_leases
    set released_at = coalesce(released_at, clock_timestamp()),
        expires_at = least(expires_at, clock_timestamp())
    where report_id = p_report_id;

    response := jsonb_build_object(
      'ok', true,
      'deleted', true,
      'reportId', report_row.id,
      'systemNumber', report_row.system_number,
      'title', report_row.title,
      'revision', report_row.revision,
      'deletedAt', report_row.deleted_at,
      'operationId', p_operation_id
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

revoke all on function public.monthly_v7_topic_delete_report(text,uuid,text,uuid,uuid,bigint)
  from public, anon;
grant execute on function public.monthly_v7_topic_delete_report(text,uuid,text,uuid,uuid,bigint)
  to authenticated;

commit;
