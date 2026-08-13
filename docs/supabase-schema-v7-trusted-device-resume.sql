-- 月度安全會議報告系統 V7：可信裝置 resume（additive backend capability）
--
-- Release order:
--   1. Run this migration and verify its RPCs before deploying any frontend that calls them.
--   2. Older frontends ignore these dormant tables/RPCs and continue using existing site/user sessions.
--
-- Security invariants:
--   * Raw resume tokens are returned once by RPCs and are never stored server-side.
--   * The database stores only SHA-256 token verifiers.
--   * Site and user resume credentials are separate and single-use when exchanged.
--   * Device validity is bound to workspace authority epoch, site-policy generation and auth.uid().
--   * User resume is additionally bound to user id, version, active state and role.
--   * The browser has no direct table access; all access is through security-definer RPCs.

begin;

create table if not exists public.monthly_v7_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  auth_uid uuid not null,
  authority_epoch bigint not null check (authority_epoch > 0),
  site_policy_generation bigint not null check (site_policy_generation > 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  check (expires_at > created_at)
);

create index if not exists idx_monthly_v7_trusted_devices_lookup
  on public.monthly_v7_trusted_devices(workspace_id, auth_uid, expires_at)
  where revoked_at is null;

create table if not exists public.monthly_v7_resume_mutexes (
  workspace_id uuid primary key references public.monthly_v7_workspaces(id) on delete cascade
);

create or replace function public.monthly_v7_lock_resume_mutex(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.monthly_v7_resume_mutexes(workspace_id)
  values(p_workspace_id)
  on conflict(workspace_id) do nothing;

  perform workspace_id
  from public.monthly_v7_resume_mutexes
  where workspace_id=p_workspace_id
  for update;
end;
$$;

revoke execute on function public.monthly_v7_lock_resume_mutex(uuid) from public, anon, authenticated;

create table if not exists public.monthly_v7_resume_tokens (
  id uuid primary key default gen_random_uuid(),
  trusted_device_id uuid not null references public.monthly_v7_trusted_devices(id) on delete cascade,
  workspace_id uuid not null references public.monthly_v7_workspaces(id) on delete cascade,
  purpose text not null check (purpose in ('site','user')),
  user_id uuid references public.monthly_v7_users(id) on delete cascade,
  user_version bigint,
  user_role text,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  replaced_by_token_id uuid references public.monthly_v7_resume_tokens(id) on delete set null,
  check (expires_at > issued_at),
  check (
    (purpose = 'site' and user_id is null and user_version is null and user_role is null)
    or
    (purpose = 'user' and user_id is not null and user_version is not null and user_version > 0
      and user_role in ('owner','admin','operator'))
  )
);

create index if not exists idx_monthly_v7_resume_tokens_device_purpose
  on public.monthly_v7_resume_tokens(trusted_device_id, purpose, expires_at)
  where consumed_at is null and revoked_at is null;

with ranked_active as (
  select id,row_number() over(
    partition by trusted_device_id,purpose
    order by issued_at desc,id desc
  ) as active_rank
  from public.monthly_v7_resume_tokens
  where consumed_at is null and revoked_at is null
)
update public.monthly_v7_resume_tokens t
set revoked_at=now()
from ranked_active r
where r.id=t.id and r.active_rank>1;

create unique index if not exists idx_monthly_v7_resume_tokens_one_active_per_purpose
  on public.monthly_v7_resume_tokens(trusted_device_id,purpose)
  where consumed_at is null and revoked_at is null;

alter table public.monthly_v7_site_sessions
  add column if not exists trusted_device_id uuid references public.monthly_v7_trusted_devices(id) on delete set null;

alter table public.monthly_v7_site_sessions
  add column if not exists authority_epoch bigint;

create or replace function public.monthly_v7_bind_site_session_authority_epoch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  select w.authority_epoch into new.authority_epoch
  from public.monthly_v7_workspaces w
  where w.id=new.workspace_id;
  if new.authority_epoch is null then
    raise exception using errcode='23503',message='WORKSPACE_NOT_FOUND';
  end if;
  return new;
end;
$$;

revoke execute on function public.monthly_v7_bind_site_session_authority_epoch() from public, anon, authenticated;

drop trigger if exists monthly_v7_bind_site_session_authority_epoch
  on public.monthly_v7_site_sessions;
create trigger monthly_v7_bind_site_session_authority_epoch
before insert or update of workspace_id on public.monthly_v7_site_sessions
for each row execute function public.monthly_v7_bind_site_session_authority_epoch();

update public.monthly_v7_site_sessions s
set authority_epoch=w.authority_epoch
from public.monthly_v7_workspaces w
where w.id=s.workspace_id
  and s.authority_epoch is null;

alter table public.monthly_v7_site_sessions
  alter column authority_epoch set not null;

create index if not exists idx_monthly_v7_site_sessions_trusted_device
  on public.monthly_v7_site_sessions(trusted_device_id)
  where trusted_device_id is not null;

alter table public.monthly_v7_trusted_devices enable row level security;
alter table public.monthly_v7_resume_tokens enable row level security;
alter table public.monthly_v7_resume_mutexes enable row level security;

create or replace function public.monthly_v7_issue_site_resume(
  p_workspace_key text,
  p_site_session_id uuid,
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
  site_session public.monthly_v7_site_sessions%rowtype;
  device_row public.monthly_v7_trusted_devices%rowtype;
  token_row public.monthly_v7_resume_tokens%rowtype;
  caller_uid uuid := auth.uid();
  raw_token text;
begin
  if caller_uid is null then
    raise exception using errcode='28000', message='AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode='22023', message='CLIENT_SESSION_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    raise exception using errcode='28000', message='SITE_SESSION_INVALID';
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;
  if workspace_row.authority_state is distinct from 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE');
  end if;

  select * into policy_row
  from public.monthly_v7_site_access
  where workspace_id=workspace_row.id;
  if not found then
    raise exception using errcode='28000', message='SITE_SESSION_INVALID';
  end if;

  select * into site_session
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and client_session_id=btrim(p_client_session_id)
    and policy_generation=policy_row.generation
    and authority_epoch=workspace_row.authority_epoch
    and expires_at>now()
  for update;
  if not found then
    raise exception using errcode='28000', message='SITE_SESSION_INVALID';
  end if;

  if site_session.trusted_device_id is not null then
    select * into device_row
    from public.monthly_v7_trusted_devices
    where id=site_session.trusted_device_id
      and workspace_id=workspace_row.id
      and auth_uid=caller_uid
      and authority_epoch=workspace_row.authority_epoch
      and site_policy_generation=policy_row.generation
      and revoked_at is null
      and expires_at>now()
    for update;
    if not found then
      raise exception using errcode='28000',message='SITE_SESSION_INVALID';
    end if;
  else
    insert into public.monthly_v7_trusted_devices(
      workspace_id,auth_uid,authority_epoch,site_policy_generation,expires_at
    ) values (
      workspace_row.id,caller_uid,workspace_row.authority_epoch,policy_row.generation,now()+interval '12 hours'
    ) returning * into device_row;

    update public.monthly_v7_site_sessions
    set trusted_device_id=device_row.id
    where id=site_session.id;
  end if;

  update public.monthly_v7_resume_tokens
  set revoked_at=now()
  where trusted_device_id=device_row.id
    and purpose='site'
    and consumed_at is null
    and revoked_at is null;

  raw_token := encode(gen_random_bytes(32),'hex');
  insert into public.monthly_v7_resume_tokens(
    trusted_device_id,workspace_id,purpose,token_hash,expires_at
  ) values (
    device_row.id,workspace_row.id,'site',
    encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),
    least(device_row.expires_at,now()+interval '12 hours')
  ) returning * into token_row;

  return jsonb_build_object(
    'ok',true,
    'trusted_device_id',device_row.id,
    'resume_token',raw_token,
    'expires_at',token_row.expires_at,
    'authority_epoch',device_row.authority_epoch,
    'site_policy_generation',device_row.site_policy_generation
  );
end;
$$;

revoke execute on function public.monthly_v7_issue_site_resume(text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_issue_site_resume(text,uuid,text) to authenticated;

create or replace function public.monthly_v7_exchange_site_resume(
  p_workspace_key text,
  p_resume_token text,
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
  token_row public.monthly_v7_resume_tokens%rowtype;
  replacement_row public.monthly_v7_resume_tokens%rowtype;
  device_row public.monthly_v7_trusted_devices%rowtype;
  session_row public.monthly_v7_site_sessions%rowtype;
  caller_uid uuid := auth.uid();
  raw_token text;
  token_hash_value text;
begin
  if caller_uid is null then
    raise exception using errcode='28000', message='AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode='22023', message='CLIENT_SESSION_REQUIRED';
  end if;
  if nullif(btrim(p_resume_token), '') is null then
    return jsonb_build_object('ok',false,'error','SITE_RESUME_INVALID');
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',false,'error','SITE_RESUME_INVALID');
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;
  if workspace_row.authority_state is distinct from 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','SITE_RESUME_INVALID');
  end if;

  select * into policy_row
  from public.monthly_v7_site_access
  where workspace_id=workspace_row.id;
  if not found then
    return jsonb_build_object('ok',false,'error','SITE_RESUME_INVALID');
  end if;

  token_hash_value := encode(digest(convert_to(btrim(p_resume_token),'UTF8'),'sha256'),'hex');
  select t.* into token_row
  from public.monthly_v7_resume_tokens t
  join public.monthly_v7_trusted_devices d on d.id=t.trusted_device_id
  where t.workspace_id=workspace_row.id
    and t.purpose='site'
    and t.token_hash=token_hash_value
    and t.consumed_at is null
    and t.revoked_at is null
    and t.expires_at>now()
    and d.workspace_id=workspace_row.id
    and d.auth_uid=caller_uid
    and d.authority_epoch=workspace_row.authority_epoch
    and d.site_policy_generation=policy_row.generation
    and d.revoked_at is null
    and d.expires_at>now()
  for update of t;
  if not found then
    return jsonb_build_object('ok',false,'error','SITE_RESUME_INVALID');
  end if;

  select * into device_row
  from public.monthly_v7_trusted_devices
  where id=token_row.trusted_device_id
  for update;

  raw_token := encode(gen_random_bytes(32),'hex');
  update public.monthly_v7_resume_tokens
  set consumed_at=now()
  where id=token_row.id;

  insert into public.monthly_v7_resume_tokens(
    trusted_device_id,workspace_id,purpose,token_hash,expires_at
  ) values (
    device_row.id,workspace_row.id,'site',
    encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),
    least(device_row.expires_at,now()+interval '12 hours')
  ) returning * into replacement_row;

  update public.monthly_v7_resume_tokens
  set replaced_by_token_id=replacement_row.id
  where id=token_row.id;

  insert into public.monthly_v7_site_sessions(
    workspace_id,auth_uid,client_session_id,policy_generation,expires_at,trusted_device_id
  ) values (
    workspace_row.id,caller_uid,btrim(p_client_session_id),policy_row.generation,
    least(device_row.expires_at,now()+interval '12 hours'),device_row.id
  ) returning * into session_row;

  update public.monthly_v7_trusted_devices
  set last_seen_at=now()
  where id=device_row.id;

  return jsonb_build_object(
    'ok',true,
    'site_session_id',session_row.id,
    'trusted_device_id',device_row.id,
    'resume_token',raw_token,
    'expires_at',session_row.expires_at,
    'authority_state',workspace_row.authority_state,
    'authority_epoch',workspace_row.authority_epoch,
    'minimum_client_version',workspace_row.minimum_client_version
  );
end;
$$;

revoke execute on function public.monthly_v7_exchange_site_resume(text,text,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_exchange_site_resume(text,text,text) to authenticated;

create or replace function public.monthly_v7_forget_trusted_device(
  p_workspace_key text,
  p_site_session_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  session_row public.monthly_v7_site_sessions%rowtype;
  device_id uuid;
  caller_uid uuid := auth.uid();
begin
  if caller_uid is null then
    raise exception using errcode='28000', message='AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode='22023', message='CLIENT_SESSION_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',false,'error','TRUSTED_DEVICE_NOT_FOUND');
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;

  select * into session_row
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and client_session_id=btrim(p_client_session_id)
    and expires_at>now()
  for update;
  if not found or session_row.trusted_device_id is null then
    return jsonb_build_object('ok',false,'error','TRUSTED_DEVICE_NOT_FOUND');
  end if;
  device_id := session_row.trusted_device_id;

  update public.monthly_v7_trusted_devices
  set revoked_at=coalesce(revoked_at,now()),revoked_reason=coalesce(revoked_reason,'forgotten_by_user')
  where id=device_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid;
  if not found then
    return jsonb_build_object('ok',false,'error','TRUSTED_DEVICE_NOT_FOUND');
  end if;

  update public.monthly_v7_resume_tokens
  set revoked_at=coalesce(revoked_at,now())
  where trusted_device_id=device_id;

  delete from public.monthly_v7_site_sessions
  where trusted_device_id=device_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid;

  return jsonb_build_object(
    'ok',true,
    'forgotten',true,
    'trusted_device_id',device_id
  );
end;
$$;

revoke execute on function public.monthly_v7_forget_trusted_device(text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_forget_trusted_device(text,uuid,text) to authenticated;

create or replace function public.monthly_v7_issue_user_resume(
  p_workspace_key text,
  p_site_session_id uuid,
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
  policy_row public.monthly_v7_site_access%rowtype;
  site_session public.monthly_v7_site_sessions%rowtype;
  user_session public.monthly_v7_user_sessions%rowtype;
  user_row public.monthly_v7_users%rowtype;
  device_row public.monthly_v7_trusted_devices%rowtype;
  token_row public.monthly_v7_resume_tokens%rowtype;
  caller_uid uuid := auth.uid();
  raw_token text;
begin
  if caller_uid is null then
    raise exception using errcode='28000', message='AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode='22023', message='CLIENT_SESSION_REQUIRED';
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_SESSION_INVALID');
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;
  if workspace_row.authority_state is distinct from 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','AUTHORITY_NOT_ACTIVE');
  end if;

  select * into policy_row
  from public.monthly_v7_site_access
  where workspace_id=workspace_row.id;

  select * into site_session
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and client_session_id=btrim(p_client_session_id)
    and policy_generation=policy_row.generation
    and authority_epoch=workspace_row.authority_epoch
    and expires_at>now();
  if not found then
    return jsonb_build_object('ok',false,'error','SITE_SESSION_INVALID');
  end if;
  if site_session.trusted_device_id is null then
    return jsonb_build_object('ok',false,'error','TRUSTED_DEVICE_REQUIRED');
  end if;

  select * into user_session
  from public.monthly_v7_user_sessions
  where id=p_user_session_id
    and workspace_id=workspace_row.id
    and site_session_id=site_session.id
    and auth_uid=caller_uid
    and client_session_id=btrim(p_client_session_id)
    and expires_at>now();
  if not found then
    return jsonb_build_object('ok',false,'error','USER_SESSION_INVALID');
  end if;

  select * into user_row
  from public.monthly_v7_users
  where id=user_session.user_id
    and workspace_id=workspace_row.id
    and version=user_session.user_version
    and active
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_SESSION_INVALID');
  end if;

  select * into device_row
  from public.monthly_v7_trusted_devices
  where id=site_session.trusted_device_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and authority_epoch=workspace_row.authority_epoch
    and site_policy_generation=policy_row.generation
    and revoked_at is null
    and expires_at>now()
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','TRUSTED_DEVICE_REQUIRED');
  end if;

  update public.monthly_v7_resume_tokens
  set revoked_at=now()
  where trusted_device_id=device_row.id
    and purpose='user'
    and consumed_at is null
    and revoked_at is null;

  raw_token := encode(gen_random_bytes(32),'hex');
  insert into public.monthly_v7_resume_tokens(
    trusted_device_id,workspace_id,purpose,user_id,user_version,user_role,token_hash,expires_at
  ) values (
    device_row.id,workspace_row.id,'user',user_row.id,user_row.version,user_row.role,
    encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),
    least(device_row.expires_at,site_session.expires_at,user_session.expires_at,now()+interval '12 hours')
  ) returning * into token_row;

  return jsonb_build_object(
    'ok',true,
    'trusted_device_id',device_row.id,
    'resume_token',raw_token,
    'expires_at',token_row.expires_at,
    'user',jsonb_build_object(
      'id',user_row.id,
      'username',user_row.username,
      'displayName',user_row.display_name,
      'role',user_row.role,
      'active',user_row.active,
      'version',user_row.version
    )
  );
end;
$$;

revoke execute on function public.monthly_v7_issue_user_resume(text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_issue_user_resume(text,uuid,uuid,text) to authenticated;

create or replace function public.monthly_v7_exchange_user_resume(
  p_workspace_key text,
  p_site_session_id uuid,
  p_resume_token text,
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
  site_session public.monthly_v7_site_sessions%rowtype;
  device_row public.monthly_v7_trusted_devices%rowtype;
  token_row public.monthly_v7_resume_tokens%rowtype;
  replacement_row public.monthly_v7_resume_tokens%rowtype;
  user_row public.monthly_v7_users%rowtype;
  session_row public.monthly_v7_user_sessions%rowtype;
  caller_uid uuid := auth.uid();
  raw_token text;
  token_hash_value text;
begin
  if caller_uid is null then
    raise exception using errcode='28000', message='AUTH_REQUIRED';
  end if;
  if nullif(btrim(p_client_session_id), '') is null then
    raise exception using errcode='22023', message='CLIENT_SESSION_REQUIRED';
  end if;
  if nullif(btrim(p_resume_token), '') is null then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;
  if workspace_row.authority_state is distinct from 'NORMALIZED_ACTIVE' then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  select * into policy_row
  from public.monthly_v7_site_access
  where workspace_id=workspace_row.id;

  select * into site_session
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and client_session_id=btrim(p_client_session_id)
    and policy_generation=policy_row.generation
    and authority_epoch=workspace_row.authority_epoch
    and trusted_device_id is not null
    and expires_at>now()
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  select * into device_row
  from public.monthly_v7_trusted_devices
  where id=site_session.trusted_device_id
    and workspace_id=workspace_row.id
    and auth_uid=caller_uid
    and authority_epoch=workspace_row.authority_epoch
    and site_policy_generation=policy_row.generation
    and revoked_at is null
    and expires_at>now()
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  token_hash_value := encode(digest(convert_to(btrim(p_resume_token),'UTF8'),'sha256'),'hex');
  select * into token_row
  from public.monthly_v7_resume_tokens
  where trusted_device_id=device_row.id
    and workspace_id=workspace_row.id
    and purpose='user'
    and token_hash=token_hash_value
    and consumed_at is null
    and revoked_at is null
    and expires_at>now()
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  select * into user_row
  from public.monthly_v7_users
  where id=token_row.user_id
    and workspace_id=workspace_row.id
    and version=token_row.user_version
    and role=token_row.user_role
    and active
  for update;
  if not found then
    return jsonb_build_object('ok',false,'error','USER_RESUME_INVALID');
  end if;

  raw_token := encode(gen_random_bytes(32),'hex');
  update public.monthly_v7_resume_tokens
  set consumed_at=now()
  where id=token_row.id;

  insert into public.monthly_v7_resume_tokens(
    trusted_device_id,workspace_id,purpose,user_id,user_version,user_role,token_hash,expires_at
  ) values (
    device_row.id,workspace_row.id,'user',user_row.id,user_row.version,user_row.role,
    encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),
    least(device_row.expires_at,site_session.expires_at,now()+interval '12 hours')
  ) returning * into replacement_row;

  update public.monthly_v7_resume_tokens
  set replaced_by_token_id=replacement_row.id
  where id=token_row.id;

  insert into public.monthly_v7_user_sessions(
    workspace_id,user_id,site_session_id,auth_uid,client_session_id,user_version,expires_at
  ) values (
    workspace_row.id,user_row.id,site_session.id,caller_uid,btrim(p_client_session_id),user_row.version,
    least(device_row.expires_at,site_session.expires_at,now()+interval '12 hours')
  ) returning * into session_row;

  update public.monthly_v7_trusted_devices
  set last_seen_at=now()
  where id=device_row.id;

  return jsonb_build_object(
    'ok',true,
    'user_session_id',session_row.id,
    'trusted_device_id',device_row.id,
    'resume_token',raw_token,
    'expires_at',session_row.expires_at,
    'user',jsonb_build_object(
      'id',user_row.id,
      'username',user_row.username,
      'displayName',user_row.display_name,
      'role',user_row.role,
      'active',user_row.active,
      'version',user_row.version
    )
  );
end;
$$;

revoke execute on function public.monthly_v7_exchange_user_resume(text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_exchange_user_resume(text,uuid,text,text) to authenticated;

create or replace function public.monthly_v7_logout_user(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  site_session public.monthly_v7_site_sessions%rowtype;
  user_session public.monthly_v7_user_sessions%rowtype;
  removed_id uuid;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',true,'alreadyLoggedOut',true,'revoked',false);
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;

  select * into user_session
  from public.monthly_v7_user_sessions
  where id=p_user_session_id
    and workspace_id=workspace_row.id
    and site_session_id=p_site_session_id
    and auth_uid=auth.uid()
  for update;
  if not found then
    return jsonb_build_object('ok',true,'alreadyLoggedOut',true,'revoked',false);
  end if;

  select * into site_session
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=auth.uid();

  if site_session.trusted_device_id is not null then
    update public.monthly_v7_resume_tokens
    set revoked_at=coalesce(revoked_at,now())
    where trusted_device_id=site_session.trusted_device_id
      and workspace_id=workspace_row.id
      and purpose='user'
      and user_id=user_session.user_id
      and consumed_at is null
      and revoked_at is null;
  end if;

  delete from public.monthly_v7_user_sessions
  where id=user_session.id
  returning id into removed_id;

  return jsonb_build_object(
    'ok',true,
    'alreadyLoggedOut',removed_id is null,
    'revoked',removed_id is not null
  );
end;
$$;

revoke execute on function public.monthly_v7_logout_user(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.monthly_v7_logout_user(text,uuid,uuid) to authenticated;

create or replace function public.monthly_v7_logout(
  p_workspace_key text,
  p_site_session_id uuid,
  p_user_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  workspace_row public.monthly_v7_workspaces%rowtype;
  site_session public.monthly_v7_site_sessions%rowtype;
  removed_id uuid;
  device_id uuid;
begin
  select * into workspace_row
  from public.monthly_v7_workspaces
  where legacy_workspace_key=p_workspace_key;
  if not found then
    return jsonb_build_object('ok',true,'alreadyLoggedOut',true,'revoked',false);
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;

  select * into site_session
  from public.monthly_v7_site_sessions
  where id=p_site_session_id
    and workspace_id=workspace_row.id
    and auth_uid=auth.uid()
  for update;
  if not found then
    return jsonb_build_object('ok',true,'alreadyLoggedOut',true,'revoked',false);
  end if;
  device_id := site_session.trusted_device_id;

  if device_id is not null then
    update public.monthly_v7_trusted_devices
    set revoked_at=coalesce(revoked_at,now()),revoked_reason=coalesce(revoked_reason,'site_logout')
    where id=device_id
      and workspace_id=workspace_row.id
      and auth_uid=auth.uid();

    update public.monthly_v7_resume_tokens
    set revoked_at=coalesce(revoked_at,now())
    where trusted_device_id=device_id;

    delete from public.monthly_v7_site_sessions
    where trusted_device_id=device_id
      and workspace_id=workspace_row.id
      and auth_uid=auth.uid();
    return jsonb_build_object('ok',true,'revoked',true,'trustedDeviceRevoked',true);
  end if;

  if p_user_session_id is not null then
    delete from public.monthly_v7_user_sessions
    where id=p_user_session_id
      and workspace_id=workspace_row.id
      and auth_uid=auth.uid();
  end if;
  delete from public.monthly_v7_site_sessions
  where id=site_session.id
  returning id into removed_id;

  return jsonb_build_object(
    'ok',true,
    'revoked',removed_id is not null,
    'trustedDeviceRevoked',false
  );
end;
$$;

revoke execute on function public.monthly_v7_logout(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.monthly_v7_logout(text,uuid,uuid) to authenticated;

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
  where legacy_workspace_key=p_workspace_key;
  if not found then
    raise exception using errcode='P0002',message='WORKSPACE_NOT_FOUND';
  end if;

  perform public.monthly_v7_lock_resume_mutex(workspace_row.id);

  select * into workspace_row
  from public.monthly_v7_workspaces
  where id=workspace_row.id
  for update;

  actor:=public.monthly_v7_session_user(workspace_row.id,p_user_session_id,p_client_session_id);
  if actor.role not in ('owner','admin') then
    return jsonb_build_object('ok',false,'error','FORBIDDEN');
  end if;
  if length(coalesce(p_new_password,''))<8 then
    return jsonb_build_object('ok',false,'error','INVALID_PAYLOAD');
  end if;

  request_hash:=encode(digest(convert_to(jsonb_build_object(
    'command','update_site_password',
    'password_digest',encode(digest(convert_to(p_new_password,'UTF8'),'sha256'),'hex')
  )::text,'UTF8'),'sha256'),'hex');

  insert into public.monthly_v7_operations(
    operation_id,workspace_id,actor_user_id,command_type,entity_type,entity_id,request_hash,status
  ) values (
    p_operation_id,workspace_row.id,actor.id,'update_site_password','site_policy',workspace_row.id,request_hash,'STARTED'
  ) on conflict(operation_id) do nothing;

  select * into operation_row
  from public.monthly_v7_operations
  where operation_id=p_operation_id
  for update;
  if operation_row.workspace_id<>workspace_row.id
     or operation_row.actor_user_id<>actor.id
     or operation_row.request_hash<>request_hash then
    return jsonb_build_object('ok',false,'error','IDEMPOTENCY_MISMATCH');
  end if;
  if operation_row.status in ('COMMITTED','REJECTED') then
    return operation_row.result;
  end if;

  update public.monthly_v7_site_access
  set password_scheme='bcrypt',
      password_hash=crypt(p_new_password,gen_salt('bf',10)),
      generation=generation+1,
      updated_at=now()
  where workspace_id=workspace_row.id
  returning generation into next_generation;

  update public.monthly_v7_workspaces
  set site_policy_generation=next_generation,updated_at=now()
  where id=workspace_row.id;

  update public.monthly_v7_trusted_devices
  set revoked_at=coalesce(revoked_at,now()),
      revoked_reason=coalesce(revoked_reason,'site_policy_changed')
  where workspace_id=workspace_row.id;

  update public.monthly_v7_resume_tokens
  set revoked_at=coalesce(revoked_at,now())
  where workspace_id=workspace_row.id;

  delete from public.monthly_v7_site_sessions
  where workspace_id=workspace_row.id;

  insert into public.monthly_v7_entity_events(
    workspace_id,actor_user_id,operation_id,entity_type,entity_id,action,after_revision
  ) values (
    workspace_row.id,actor.id,p_operation_id,'site_policy',workspace_row.id,'rotate',next_generation
  );
  insert into public.monthly_v7_change_events(
    workspace_id,entity_type,entity_id,entity_revision,action
  ) values (
    workspace_row.id,'site_policy',workspace_row.id,next_generation,'rotate'
  );

  response:=jsonb_build_object(
    'ok',true,
    'entityType','site_policy',
    'entityId',workspace_row.id,
    'generation',next_generation,
    'requiresReauth',true,
    'operationId',p_operation_id
  );
  update public.monthly_v7_operations
  set status='COMMITTED',result=response,completed_at=now()
  where operation_id=p_operation_id;
  return response;
end;
$$;

revoke execute on function public.monthly_v7_update_site_password(text,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.monthly_v7_update_site_password(text,uuid,text,uuid,text) to authenticated;

revoke all on public.monthly_v7_trusted_devices from public, anon, authenticated;
revoke all on public.monthly_v7_resume_tokens from public, anon, authenticated;
revoke all on public.monthly_v7_resume_mutexes from public, anon, authenticated;

commit;
