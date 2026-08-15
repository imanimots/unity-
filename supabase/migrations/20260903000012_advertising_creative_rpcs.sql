-- Advertising MVP -- Phase 12: external creative submit/edit + admin
-- moderation.
--
-- Any material change to a previously-approved creative invalidates
-- that approval and forces re-review (binding) -- enforced here, the
-- only write path to ad_creatives. If the campaign was already active
-- when the creative changes, it is pulled back to pending_review too
-- (an approved-then-edited external creative must stop serving until
-- re-approved).

create or replace function public.update_ad_creative(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_headline text,
  p_cta_text text,
  p_destination_url text,
  p_image_url text default null,
  p_short_description text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_creative public.ad_creatives;
  v_material_change boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_destination_url !~ '^https://' then
    raise exception 'destination_url must use https';
  end if;
  if p_destination_url ~* '^https://(javascript|data|file):' then
    raise exception 'unsafe destination_url scheme';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if not exists (select 1 from public.ad_advertisers a where a.id = v_campaign.advertiser_id and a.owner_profile_id = p_actor_profile_id) then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_campaign.target_type <> 'external' then
    raise exception 'only external campaigns have a creative';
  end if;

  select * into v_creative from public.ad_creatives where campaign_id = p_campaign_id for update;
  if not found then
    raise exception 'creative not found';
  end if;

  v_material_change := (
    v_creative.headline is distinct from p_headline
    or v_creative.image_url is distinct from p_image_url
    or v_creative.cta_text is distinct from p_cta_text
    or v_creative.destination_url is distinct from p_destination_url
    or v_creative.short_description is distinct from p_short_description
  );

  update public.ad_creatives set
    headline = p_headline,
    image_url = p_image_url,
    cta_text = p_cta_text,
    destination_url = p_destination_url,
    short_description = p_short_description,
    moderation_status = case when v_material_change and moderation_status = 'approved' then 'pending_review' else moderation_status end,
    approved_by = case when v_material_change and moderation_status = 'approved' then null else approved_by end,
    approved_at = case when v_material_change and moderation_status = 'approved' then null else approved_at end,
    updated_at = now()
  where campaign_id = p_campaign_id
  returning * into v_creative;

  if v_material_change then
    insert into public.ad_creative_history (creative_id, actor_type, actor_id, action_type, previous_status, new_status)
    values (v_creative.id, 'advertiser', p_actor_profile_id, 'edited_material_change', 'approved', 'pending_review');

    -- An already-active campaign whose approved creative just materially
    -- changed must stop serving until re-approved.
    if v_campaign.status = 'active' then
      update public.ad_campaigns set status = 'pending_review', updated_at = now() where id = p_campaign_id;
      insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
      values (p_campaign_id, 'system', p_actor_profile_id, 'creative_changed_pulled_from_serving', 'active', 'pending_review', 'approved creative materially changed, re-review required');
    end if;
  end if;

  return to_jsonb(v_creative);
end;
$$;

revoke all on function public.update_ad_creative(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_ad_creative(uuid, uuid, text, text, text, text, text, text) to service_role;

-- ── admin_approve_ad_creative ──────────────────────────────────────────
create or replace function public.admin_approve_ad_creative(p_admin_id uuid, p_campaign_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creative public.ad_creatives;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  select * into v_creative from public.ad_creatives where campaign_id = p_campaign_id for update;
  if not found then
    raise exception 'creative not found';
  end if;
  if v_creative.moderation_status <> 'pending_review' then
    raise exception 'creative is not pending review (current: %)', v_creative.moderation_status;
  end if;

  update public.ad_creatives set
    moderation_status = 'approved', approved_by = p_admin_id, approved_at = now(),
    approved_version = approved_version + 1, rejection_reason = null, updated_at = now()
  where campaign_id = p_campaign_id
  returning * into v_creative;

  insert into public.ad_creative_history (creative_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (v_creative.id, 'admin', p_admin_id, 'approved', 'pending_review', 'approved', p_reason);

  return to_jsonb(v_creative);
end;
$$;

revoke all on function public.admin_approve_ad_creative(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_approve_ad_creative(uuid, uuid, text) to service_role;

-- ── admin_reject_ad_creative ────────────────────────────────────────────
create or replace function public.admin_reject_ad_creative(p_admin_id uuid, p_campaign_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creative public.ad_creatives;
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

  select * into v_creative from public.ad_creatives where campaign_id = p_campaign_id for update;
  if not found then
    raise exception 'creative not found';
  end if;
  if v_creative.moderation_status <> 'pending_review' then
    raise exception 'creative is not pending review (current: %)', v_creative.moderation_status;
  end if;

  update public.ad_creatives set
    moderation_status = 'rejected', rejection_reason = p_reason, updated_at = now()
  where campaign_id = p_campaign_id
  returning * into v_creative;

  insert into public.ad_creative_history (creative_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (v_creative.id, 'admin', p_admin_id, 'rejected', 'pending_review', 'rejected', p_reason);

  return to_jsonb(v_creative);
end;
$$;

revoke all on function public.admin_reject_ad_creative(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_reject_ad_creative(uuid, uuid, text) to service_role;
