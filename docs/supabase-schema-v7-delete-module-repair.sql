-- V7.0.3 additive repair: require report_structure + module leases for module deletion.
-- Safe after NORMALIZED_ACTIVE. Do not rerun activation.
begin;

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

revoke execute on function public.monthly_v7_delete_module(text, uuid, text, uuid, uuid, bigint, bigint, uuid, bigint, uuid, bigint) from public, anon;
grant execute on function public.monthly_v7_delete_module(text, uuid, text, uuid, uuid, bigint, bigint, uuid, bigint, uuid, bigint) to authenticated;

commit;

select
  case when to_regprocedure('public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint)') is null then 'PASS' else 'FAIL' end as old_delete_signature_removed,
  case when to_regprocedure('public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)') is not null then 'PASS' else 'FAIL' end as dual_lease_delete_installed,
  case when not has_function_privilege('anon', 'public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)', 'EXECUTE') then 'PASS' else 'FAIL' end as anon_blocked,
  case when has_function_privilege('authenticated', 'public.monthly_v7_delete_module(text,uuid,text,uuid,uuid,bigint,bigint,uuid,bigint,uuid,bigint)', 'EXECUTE') then 'PASS' else 'FAIL' end as authenticated_allowed;
