-- Advertising MVP -- Phase 7: advertiser-account lifecycle RPCs.
--
-- 'unity' advertisers are created already-active (no manual gate --
-- reuses the caller's existing KYC/identity, no new KYC provider).
-- 'external' advertisers always start pending_review and require an
-- explicit admin approval RPC before any campaign of theirs may ever
-- serve. All security definer, service-role-only, matching every other
-- admin/financial RPC in this codebase exactly.

create or replace function public.create_ad_advertiser(
  p_owner_profile_id uuid,
  p_advertiser_type ad_advertiser_type,
  p_display_name text,
  p_is_test boolean default false,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_advertiser public.ad_advertisers;
  v_status ad_advertiser_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_owner_profile_id is null then
    raise exception 'owner profile id is required';
  end if;
  if p_display_name is null or char_length(trim(p_display_name)) = 0 then
    raise exception 'display name is required';
  end if;

  v_request_hash := md5(coalesce(p_owner_profile_id::text, '') || '|' || coalesce(p_advertiser_type::text, '') || '|' || coalesce(p_display_name, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_owner_profile_id and operation = 'create_ad_advertiser' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_status := case when p_advertiser_type = 'unity' then 'active' else 'pending_review' end;

  insert into public.ad_advertisers (owner_profile_id, advertiser_type, display_name, status, is_test)
  values (p_owner_profile_id, p_advertiser_type, trim(p_display_name), v_status, p_is_test)
  returning * into v_advertiser;

  insert into public.ad_advertiser_history (advertiser_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (v_advertiser.id, 'advertiser', p_owner_profile_id, 'created', null, v_status);

  -- Every advertiser gets a zero-balance Advertising Balance account at
  -- creation time -- it is never withdrawable, only ever used to fund
  -- future campaigns.
  insert into public.ad_balance_accounts (advertiser_id, balance_cents)
  values (v_advertiser.id, 0);

  v_result := to_jsonb(v_advertiser);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_owner_profile_id, 'create_ad_advertiser', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_ad_advertiser(uuid, ad_advertiser_type, text, boolean, text) from public, anon, authenticated;
grant execute on function public.create_ad_advertiser(uuid, ad_advertiser_type, text, boolean, text) to service_role;

-- ── admin_approve_ad_advertiser ─────────────────────────────────────
create or replace function public.admin_approve_ad_advertiser(
  p_admin_id uuid,
  p_advertiser_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_previous ad_advertiser_status;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id for update;
  if not found then
    raise exception 'advertiser not found';
  end if;
  if v_advertiser.advertiser_type <> 'external' then
    raise exception 'only external advertisers require approval';
  end if;
  if v_advertiser.status <> 'pending_review' then
    raise exception 'advertiser is not pending review (current status: %)', v_advertiser.status;
  end if;

  v_previous := v_advertiser.status;

  update public.ad_advertisers
  set status = 'approved', approved_by = p_admin_id, approved_at = now(), updated_at = now()
  where id = p_advertiser_id
  returning * into v_advertiser;

  insert into public.ad_advertiser_history (advertiser_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_advertiser_id, 'admin', p_admin_id, 'approved', v_previous, 'approved', p_reason);

  return to_jsonb(v_advertiser);
end;
$$;

revoke all on function public.admin_approve_ad_advertiser(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_approve_ad_advertiser(uuid, uuid, text, text) to service_role;

-- ── admin_reject_ad_advertiser ──────────────────────────────────────
create or replace function public.admin_reject_ad_advertiser(
  p_admin_id uuid,
  p_advertiser_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_previous ad_advertiser_status;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id for update;
  if not found then
    raise exception 'advertiser not found';
  end if;
  if v_advertiser.advertiser_type <> 'external' then
    raise exception 'only external advertisers can be rejected';
  end if;
  if v_advertiser.status <> 'pending_review' then
    raise exception 'advertiser is not pending review (current status: %)', v_advertiser.status;
  end if;

  v_previous := v_advertiser.status;

  update public.ad_advertisers
  set status = 'rejected', updated_at = now()
  where id = p_advertiser_id
  returning * into v_advertiser;

  insert into public.ad_advertiser_history (advertiser_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_advertiser_id, 'admin', p_admin_id, 'rejected', v_previous, 'rejected', p_reason);

  return to_jsonb(v_advertiser);
end;
$$;

revoke all on function public.admin_reject_ad_advertiser(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_reject_ad_advertiser(uuid, uuid, text, text) to service_role;

-- ── admin_suspend_ad_advertiser ── suspends every campaign too ──────
create or replace function public.admin_suspend_ad_advertiser(
  p_admin_id uuid,
  p_advertiser_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_previous ad_advertiser_status;
  v_campaign record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id for update;
  if not found then
    raise exception 'advertiser not found';
  end if;
  if v_advertiser.status = 'suspended' then
    -- idempotent no-op replay
    return to_jsonb(v_advertiser);
  end if;

  v_previous := v_advertiser.status;

  update public.ad_advertisers
  set status = 'suspended', suspension_reason = p_reason, updated_at = now()
  where id = p_advertiser_id
  returning * into v_advertiser;

  insert into public.ad_advertiser_history (advertiser_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_advertiser_id, 'admin', p_admin_id, 'suspended', v_previous, 'suspended', p_reason);

  -- Every active/paused campaign belonging to this advertiser stops
  -- serving immediately -- suspension is enforced live at serve time
  -- too (belt-and-suspenders), but we also transition campaign state
  -- here so the advertiser dashboard reflects reality immediately.
  for v_campaign in
    select * from public.ad_campaigns where advertiser_id = p_advertiser_id and status in ('active', 'paused') for update
  loop
    update public.ad_campaigns set status = 'suspended', updated_at = now() where id = v_campaign.id;
    insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
    values (v_campaign.id, 'admin', p_admin_id, 'suspended_via_advertiser_suspension', v_campaign.status, 'suspended', p_reason);
  end loop;

  return to_jsonb(v_advertiser);
end;
$$;

revoke all on function public.admin_suspend_ad_advertiser(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_suspend_ad_advertiser(uuid, uuid, text, text) to service_role;
