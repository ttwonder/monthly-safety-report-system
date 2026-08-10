-- 月度安全會議報告系統 V7：正式 authority activation
--
-- 前置順序：
-- 1. 先執行 docs/supabase-schema-v7.sql（additive，仍為 LEGACY_ACTIVE）。
-- 2. 推送含 V7 client 的 GitHub commit，等待 Pages 完成。
-- 3. 在短暫維護視窗執行本檔，再要求所有使用者重新整理與登入。
--
-- 本檔會原子阻斷 V6 writer、從最新 cloud bundle 做最後一次 migration，然後啟用 V7。
-- 一旦 NORMALIZED_ACTIVE 接受逐項寫入，不得重新開啟 V6 整包 writer；故意沒有舊 writer rollback。

begin;

do $$
declare
  item record;
  receipt jsonb;
begin
  for item in
    select id, legacy_workspace_key, authority_state
    from public.monthly_v7_workspaces
    order by legacy_workspace_key
    for update
  loop
    if item.authority_state='NORMALIZED_ACTIVE' then
      continue;
    end if;
    if item.authority_state<>'LEGACY_ACTIVE' then
      raise exception using errcode='55000',message='UNSAFE_AUTHORITY_STATE:'||item.authority_state;
    end if;

    -- UPDATE lock 與 V6 upsert 的 FOR SHARE 構成 barrier：
    -- barrier 前完成的 save 會被最後 migration 納入；barrier 後的 save 會收到 AUTHORITY_CHANGED。
    update public.monthly_v7_workspaces
    set authority_state='DRAINING',updated_at=now()
    where id=item.id;
    update public.monthly_v7_workspaces
    set authority_state='FROZEN',updated_at=now()
    where id=item.id;

    receipt:=public.monthly_v7_migrate_workspace(item.legacy_workspace_key);
    if coalesce((receipt->>'ok')::boolean,false) is not true then
      raise exception using errcode='23514',message='FINAL_MIGRATION_FAILED';
    end if;

    -- 切換時使預先取得的 session/lease 全數失效，避免跨 epoch 保留寫入能力。
    delete from public.monthly_v7_entity_leases where workspace_id=item.id;
    delete from public.monthly_v7_user_sessions where workspace_id=item.id;
    delete from public.monthly_v7_site_sessions where workspace_id=item.id;

    update public.monthly_v7_workspaces
    set authority_state='NORMALIZED_ACTIVE',
        authority_epoch=authority_epoch+1,
        minimum_client_version=7,
        updated_at=now()
    where id=item.id;
  end loop;
end
$$;

-- 權限撤銷是第二道防線；函式內 authority gate 仍保留，供舊 grant/超級使用者路徑 fail closed。
revoke execute on function public.upsert_monthly_report_cloud_data(text,jsonb,bigint,text) from public,anon,authenticated;
revoke execute on function public.get_monthly_report_cloud_data(text) from public,anon,authenticated;

commit;
