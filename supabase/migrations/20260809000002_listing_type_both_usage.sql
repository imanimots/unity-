-- ============================================================
-- Use listing_type = 'both' (Phase 2 — Buying & Selling)
-- ============================================================
-- Depends on 20260809000001 having committed the enum addition first.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- Pricing CHECK constraint — 'both' requires BOTH a daily_rate and a
-- sale_price set (one listing row, both transaction paths available;
-- see docs/BUYING_SELLING.md and the "one listing, both prices"
-- decision for why this was chosen over two linked listings).
-- ─────────────────────────────────────────
alter table public.listings drop constraint if exists listings_type_pricing_chk;

alter table public.listings add constraint listings_type_pricing_chk check (
  (listing_type = 'rental' and daily_rate is not null and sale_price is null) or
  (listing_type = 'sale'   and sale_price is not null and daily_rate is null) or
  (listing_type = 'both'   and daily_rate is not null and sale_price is not null)
);

-- ─────────────────────────────────────────
-- save_listing_draft (v3) — CREATE OR REPLACE of the v2 function
-- (20260729000008_listing_wizard_closure.sql). Parameter list is
-- unchanged from v2, so no drop-first is needed here (only a return-type
-- change would force that — this keeps `returns uuid`). Verbatim copy of
-- v2's body with exactly two kinds of change, both isolated to
-- listing_type/sale_price handling:
--   1. v_listing_type resolved once (defaults to 'rental', matching every
--      pre-existing caller that never sends listing_type at all).
--   2. daily_rate/sale_price are set by CASE on v_listing_type (INSERT
--      and UPDATE paths) instead of a bare cast/coalesce — necessary so
--      that switching a draft's type (e.g. sale -> rental) clears the
--      now-irrelevant field rather than leaving a stale value that would
--      violate listings_type_pricing_chk above.
-- Everything else (media ownership checks, availability overlap check,
-- idempotency handling, requirements upsert) is unchanged from v2.
-- ─────────────────────────────────────────
create or replace function public.save_listing_draft(
  p_listing_id              uuid,
  p_listing                 jsonb,
  p_requirements            jsonb,
  p_media                   jsonb,
  p_category_metadata       jsonb default '{}'::jsonb,
  p_private_category_metadata jsonb default '{}'::jsonb,
  p_availability            jsonb default '[]'::jsonb,
  p_idempotency_key         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_listing_id uuid;
  v_category_id uuid;
  v_item jsonb;
  v_public_metadata jsonb;
  v_private_metadata jsonb;
  v_weekdays int[];
  v_request_hash text;
  v_idem record;
  v_listing_type listing_type;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(
    coalesce(p_listing_id::text, '') || '|' || coalesce(p_listing::text, '{}') || '|' ||
    coalesce(p_requirements::text, '{}') || '|' || coalesce(p_media::text, '[]') || '|' ||
    coalesce(p_category_metadata::text, '{}') || '|' || coalesce(p_private_category_metadata::text, '{}') || '|' ||
    coalesce(p_availability::text, '[]')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_uid and operation = 'save_listing_draft' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return (v_idem.result->>'listing_id')::uuid;
    end if;
  end if;

  select id into v_category_id
  from public.categories
  where slug = (p_listing->>'category') and is_active = true;

  if v_category_id is null then
    raise exception 'invalid or inactive category: %', coalesce(p_listing->>'category', '(none)');
  end if;

  v_public_metadata := public.sanitize_category_metadata(p_listing->>'category', false, p_category_metadata);
  v_private_metadata := public.sanitize_category_metadata(p_listing->>'category', true, p_private_category_metadata);

  if p_listing ? 'recurring_unavailable_weekdays' then
    select array_agg(distinct x.value::int) into v_weekdays
    from jsonb_array_elements_text(p_listing->'recurring_unavailable_weekdays') as x(value);
    if exists (select 1 from unnest(v_weekdays) as w where w < 0 or w > 6) then
      raise exception 'recurring_unavailable_weekdays must contain only values 0 through 6';
    end if;
  end if;

  v_listing_type := coalesce((p_listing->>'listing_type')::listing_type, 'rental');

  if p_listing_id is null then
    insert into public.listings (
      merchant_id, country_id, title, description, category, category_id, condition,
      listing_type, daily_rate, sale_price, weekly_rate, min_rental_days, max_rental_days, deposit_required, deposit_amount,
      insurance_amount, shipping_payer, accepts_affiliates, affiliate_commission_rate,
      condition_confirmed, known_defects, replacement_value, quantity_available,
      province, city, available_from, min_booking_notice_days, max_advance_booking_days,
      recurring_unavailable_weekdays, category_metadata, status
    ) values (
      v_uid,
      coalesce(nullif(p_listing->>'country_id', ''), 'ZA'),
      p_listing->>'title',
      p_listing->>'description',
      p_listing->>'category',
      v_category_id,
      (p_listing->>'condition')::item_condition,
      v_listing_type,
      case when v_listing_type in ('rental', 'both') then (p_listing->>'daily_rate')::numeric else null end,
      case when v_listing_type in ('sale', 'both') then nullif(p_listing->>'sale_price', '')::numeric else null end,
      nullif(p_listing->>'weekly_rate', '')::numeric,
      coalesce(nullif(p_listing->>'min_rental_days', '')::int, 1),
      nullif(p_listing->>'max_rental_days', '')::int,
      coalesce((p_listing->>'deposit_required')::boolean, false),
      nullif(p_listing->>'deposit_amount', '')::numeric,
      nullif(p_listing->>'insurance_amount', '')::numeric,
      coalesce((p_listing->>'shipping_payer')::shipping_payer, 'negotiate'),
      coalesce((p_listing->>'accepts_affiliates')::boolean, false),
      coalesce(nullif(p_listing->>'affiliate_commission_rate', '')::numeric, 0),
      coalesce((p_listing->>'condition_confirmed')::boolean, false),
      nullif(p_listing->>'known_defects', ''),
      nullif(p_listing->>'replacement_value', '')::numeric,
      coalesce(nullif(p_listing->>'quantity_available', '')::int, 1),
      nullif(p_listing->>'province', ''),
      nullif(p_listing->>'city', ''),
      nullif(p_listing->>'available_from', '')::date,
      nullif(p_listing->>'min_booking_notice_days', '')::int,
      nullif(p_listing->>'max_advance_booking_days', '')::int,
      v_weekdays,
      v_public_metadata,
      'draft'
    )
    returning id into v_listing_id;

    insert into public.listing_history (listing_id, changed_by, new_values, change_reason)
    values (v_listing_id, v_uid, jsonb_build_object('status', 'draft'), 'listing_created_as_draft');
  else
    if not exists (
      select 1 from public.listings
      where id = p_listing_id and merchant_id = v_uid and status = 'draft'
    ) then
      raise exception 'listing not found, not owned by caller, or no longer a draft';
    end if;

    v_listing_id := p_listing_id;

    update public.listings set
      title = coalesce(p_listing->>'title', title),
      description = coalesce(p_listing->>'description', description),
      category = coalesce(p_listing->>'category', category),
      category_id = v_category_id,
      condition = coalesce((p_listing->>'condition')::item_condition, condition),
      listing_type = v_listing_type,
      daily_rate = case when v_listing_type in ('rental', 'both') then (p_listing->>'daily_rate')::numeric else null end,
      sale_price = case when v_listing_type in ('sale', 'both') then nullif(p_listing->>'sale_price', '')::numeric else null end,
      weekly_rate = nullif(p_listing->>'weekly_rate', '')::numeric,
      min_rental_days = coalesce(nullif(p_listing->>'min_rental_days', '')::int, min_rental_days),
      max_rental_days = nullif(p_listing->>'max_rental_days', '')::int,
      deposit_required = coalesce((p_listing->>'deposit_required')::boolean, deposit_required),
      deposit_amount = nullif(p_listing->>'deposit_amount', '')::numeric,
      insurance_amount = nullif(p_listing->>'insurance_amount', '')::numeric,
      shipping_payer = coalesce((p_listing->>'shipping_payer')::shipping_payer, shipping_payer),
      accepts_affiliates = coalesce((p_listing->>'accepts_affiliates')::boolean, accepts_affiliates),
      affiliate_commission_rate = coalesce(nullif(p_listing->>'affiliate_commission_rate', '')::numeric, affiliate_commission_rate),
      condition_confirmed = coalesce((p_listing->>'condition_confirmed')::boolean, condition_confirmed),
      known_defects = nullif(p_listing->>'known_defects', ''),
      replacement_value = nullif(p_listing->>'replacement_value', '')::numeric,
      quantity_available = coalesce(nullif(p_listing->>'quantity_available', '')::int, quantity_available),
      province = nullif(p_listing->>'province', ''),
      city = nullif(p_listing->>'city', ''),
      available_from = nullif(p_listing->>'available_from', '')::date,
      min_booking_notice_days = nullif(p_listing->>'min_booking_notice_days', '')::int,
      max_advance_booking_days = nullif(p_listing->>'max_advance_booking_days', '')::int,
      recurring_unavailable_weekdays = v_weekdays,
      category_metadata = v_public_metadata
    where id = v_listing_id;
  end if;

  -- listing_private_details — private_category_metadata sanitized above.
  insert into public.listing_private_details (listing_id, private_category_metadata)
  values (v_listing_id, v_private_metadata)
  on conflict (listing_id) do update
    set private_category_metadata = excluded.private_category_metadata;

  -- listing_requirements — full field set. final_deposit_amount is never
  -- extracted from p_requirements (privileged, protected by the existing
  -- 20260729000006 trigger regardless — omitted here as defense-in-depth
  -- at the source too).
  insert into public.listing_requirements (
    listing_id, deposit_basis, requested_deposit_amount,
    verified_identity_required, kyc_approved_required, min_age,
    driving_licence_required, licence_class, additional_requirements,
    permitted_use, prohibited_use, geographic_restriction,
    commercial_use_allowed, sub_rental_allowed,
    cleaning_requirements, return_condition_requirements, merchant_custom_rules,
    existing_damage_description, inspection_required_before_handover, inspection_required_on_return,
    missing_accessory_consequence, lost_item_consequence
  ) values (
    v_listing_id,
    coalesce((p_requirements->>'deposit_basis')::deposit_basis, 'fixed'),
    nullif(p_requirements->>'requested_deposit_amount', '')::numeric,
    coalesce((p_requirements->>'verified_identity_required')::boolean, false),
    coalesce((p_requirements->>'kyc_approved_required')::boolean, false),
    nullif(p_requirements->>'min_age', '')::int,
    coalesce((p_requirements->>'driving_licence_required')::boolean, false),
    nullif(p_requirements->>'licence_class', ''),
    nullif(p_requirements->>'additional_requirements', ''),
    nullif(p_requirements->>'permitted_use', ''),
    nullif(p_requirements->>'prohibited_use', ''),
    nullif(p_requirements->>'geographic_restriction', ''),
    coalesce((p_requirements->>'commercial_use_allowed')::boolean, false),
    coalesce((p_requirements->>'sub_rental_allowed')::boolean, false),
    nullif(p_requirements->>'cleaning_requirements', ''),
    nullif(p_requirements->>'return_condition_requirements', ''),
    nullif(p_requirements->>'merchant_custom_rules', ''),
    nullif(p_requirements->>'existing_damage_description', ''),
    coalesce((p_requirements->>'inspection_required_before_handover')::boolean, false),
    coalesce((p_requirements->>'inspection_required_on_return')::boolean, false),
    nullif(p_requirements->>'missing_accessory_consequence', ''),
    nullif(p_requirements->>'lost_item_consequence', '')
  )
  on conflict (listing_id) do update set
    deposit_basis = excluded.deposit_basis,
    requested_deposit_amount = excluded.requested_deposit_amount,
    verified_identity_required = excluded.verified_identity_required,
    kyc_approved_required = excluded.kyc_approved_required,
    min_age = excluded.min_age,
    driving_licence_required = excluded.driving_licence_required,
    licence_class = excluded.licence_class,
    additional_requirements = excluded.additional_requirements,
    permitted_use = excluded.permitted_use,
    prohibited_use = excluded.prohibited_use,
    geographic_restriction = excluded.geographic_restriction,
    commercial_use_allowed = excluded.commercial_use_allowed,
    sub_rental_allowed = excluded.sub_rental_allowed,
    cleaning_requirements = excluded.cleaning_requirements,
    return_condition_requirements = excluded.return_condition_requirements,
    merchant_custom_rules = excluded.merchant_custom_rules,
    existing_damage_description = excluded.existing_damage_description,
    inspection_required_before_handover = excluded.inspection_required_before_handover,
    inspection_required_on_return = excluded.inspection_required_on_return,
    missing_accessory_consequence = excluded.missing_accessory_consequence,
    lost_item_consequence = excluded.lost_item_consequence;

  -- Media: replace-all, same as v2. The Next.js API route (src/app/api/
  -- listings/route.ts) already checks every media URL belongs to the
  -- caller's own storage folder before calling this function — but this
  -- RPC is reachable directly, bypassing that route entirely, so the same
  -- check is repeated here as the actual security boundary. Ownership
  -- proof URLs are raw storage paths ("{uid}/..."); public photo URLs are
  -- full public bucket URLs containing "/listing-media/{uid}/".
  delete from public.listing_media
  where listing_id = v_listing_id and type in ('photo', 'ownership_proof');

  for v_item in select * from jsonb_array_elements(coalesce(p_media, '[]'::jsonb))
  loop
    if (v_item->>'type') = 'ownership_proof' then
      if (v_item->>'url') !~ ('^' || v_uid::text || '/') then
        raise exception 'ownership proof file does not belong to the caller';
      end if;
    else
      if (v_item->>'url') !~ ('/listing-media/' || v_uid::text || '/') then
        raise exception 'photo file does not belong to the caller';
      end if;
    end if;

    insert into public.listing_media (listing_id, url, type, display_order, shot_type)
    values (
      v_listing_id,
      v_item->>'url',
      (v_item->>'type')::media_type,
      coalesce((v_item->>'display_order')::int, 0),
      nullif(v_item->>'shot_type', '')::media_shot_type
    );
  end loop;

  -- Availability: replace-all blocked-date ranges. Overlap check runs
  -- after inserting the new set; any overlap rolls back the whole
  -- transaction (atomicity — see 20260729000008's header).
  delete from public.listing_availability where listing_id = v_listing_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_availability, '[]'::jsonb))
  loop
    insert into public.listing_availability (listing_id, start_date, end_date, reason)
    values (
      v_listing_id,
      (v_item->>'start_date')::date,
      (v_item->>'end_date')::date,
      nullif(v_item->>'reason', '')
    );
  end loop;

  if exists (
    select 1
    from public.listing_availability a
    join public.listing_availability b on a.listing_id = b.listing_id and a.id < b.id
    where a.listing_id = v_listing_id
      and a.start_date <= b.end_date and b.start_date <= a.end_date
  ) then
    raise exception 'blocked date ranges must not overlap';
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_uid, 'save_listing_draft', p_idempotency_key, v_request_hash, jsonb_build_object('listing_id', v_listing_id));
  end if;

  return v_listing_id;
end;
$$;

revoke execute on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) from public;
grant execute on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) to authenticated;
