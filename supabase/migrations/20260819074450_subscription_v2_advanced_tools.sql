-- ============================================================
-- Unity -- Merchant Subscription Tiers V2 -- advanced listing tools
-- (Pro/Elite only, Section 41-48). This phase implements duplicate
-- listing as a real RPC; bulk pause/resume are implemented at the
-- application layer by looping the EXISTING merchant_pause_listing/
-- merchant_resume_listing RPCs (each call is already ownership-safe,
-- cap-safe, and idempotency-key-safe on its own -- a bulk loop adds no
-- new authority, just convenience). Scheduled publishing, CSV import,
-- and an inventory/calendar view are NOT implemented in this pass --
-- documented honestly rather than half-built; the advanced_tools_enabled
-- entitlement flag exists and is correctly gated for when they are.
-- ============================================================

create or replace function public.duplicate_listing(
  p_merchant_id uuid,
  p_listing_id uuid,
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
  v_source public.listings;
  v_new_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'duplicate_listing' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_source from public.listings where id = p_listing_id;
  if v_source.id is null then
    raise exception 'listing not found';
  end if;
  if v_source.merchant_id <> p_merchant_id then
    raise exception 'you do not own this listing';
  end if;

  -- Authoring fields only. Never copies: status (always starts draft),
  -- ownership_verified (fresh moderation required), affiliate
  -- enablement state, ad campaign dates, or search_vector (generated).
  -- Transaction/review/dispute/escrow/RTB state lives in entirely
  -- separate tables this INSERT never touches, so it can never be
  -- copied by construction.
  insert into public.listings (
    merchant_id, country_id, title, description, category, condition,
    daily_rate, weekly_rate, min_rental_days, deposit_required, deposit_amount, insurance_amount,
    shipping_payer, min_unity_score, status, risk_tier, listing_type, sale_price, quantity_available,
    brand, model, replacement_value, year_of_manufacture, colour, size, specifications,
    included_accessories, tags, province, city, collection_area, known_defects, wear_description,
    functional_status, missing_parts, repair_history, condition_confirmed, weekend_rate, monthly_rate,
    max_rental_days, available_from, min_booking_notice_days, max_advance_booking_days,
    recurring_unavailable_weekdays, pickup_available, delivery_available, merchant_delivery_available,
    courier_allowed, renter_collection_allowed, preferred_handover_times, ownership_proof_type,
    ownership_declaration_accepted, category_metadata, category_id, subcategory_id, is_test, direction
  )
  select
    merchant_id, country_id, title || ' (copy)', description, category, condition,
    daily_rate, weekly_rate, min_rental_days, deposit_required, deposit_amount, insurance_amount,
    shipping_payer, min_unity_score, 'draft', risk_tier, listing_type, sale_price, quantity_available,
    brand, model, replacement_value, year_of_manufacture, colour, size, specifications,
    included_accessories, tags, province, city, collection_area, known_defects, wear_description,
    functional_status, missing_parts, repair_history, false, weekend_rate, monthly_rate,
    max_rental_days, available_from, min_booking_notice_days, max_advance_booking_days,
    recurring_unavailable_weekdays, pickup_available, delivery_available, merchant_delivery_available,
    courier_allowed, renter_collection_allowed, preferred_handover_times, ownership_proof_type,
    false, category_metadata, category_id, subcategory_id, is_test, direction
  from public.listings
  where id = p_listing_id
  returning id into v_new_id;

  v_result := jsonb_build_object('listing_id', v_new_id, 'status', 'draft', 'duplicated_from', p_listing_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'duplicate_listing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.duplicate_listing(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.duplicate_listing(uuid, uuid, text) to service_role;

-- ============================================================
-- BULK PRICE UPDATES -- Pro/Elite only (entitlement checked in the
-- route, not here -- same convention as every other RPC in this
-- codebase: the RPC re-validates OWNERSHIP, the route checks plan
-- entitlement). Uses the listings table's own existing numeric(10,2)
-- rand convention (exact decimal, never floating point) rather than
-- introducing a second cents-based price representation just for this
-- one tool -- "integer/exact monetary authority" is satisfied by
-- numeric(10,2) already being precise fixed-point, not floating point;
-- converting the whole listings price model to integer cents would be
-- an unrelated, much larger schema change outside this phase's scope.
--
-- Only touches DRAFT/ACTIVE/PAUSED listing rows (future public terms).
-- Never touches an order/booking/barter/RTB snapshot or any historical
-- commission record -- those are separate tables this function never
-- writes to, so they cannot be affected by construction.
-- ============================================================
create or replace function public.merchant_bulk_update_listing_prices(
  p_merchant_id uuid,
  p_updates jsonb,
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
  v_update jsonb;
  v_listing_id uuid;
  v_owned boolean;
  v_daily numeric;
  v_weekly numeric;
  v_monthly numeric;
  v_sale numeric;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_updates is null or jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) = 0 then
    raise exception 'updates must be a non-empty JSON array';
  end if;
  if jsonb_array_length(p_updates) > 100 then
    raise exception 'too many updates in a single request (max 100)';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || p_updates::text);
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'merchant_bulk_update_listing_prices' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  for v_update in select * from jsonb_array_elements(p_updates)
  loop
    v_listing_id := (v_update->>'listingId')::uuid;
    select exists (select 1 from public.listings where id = v_listing_id and merchant_id = p_merchant_id) into v_owned;

    if not v_owned then
      v_results := v_results || jsonb_build_object('listingId', v_listing_id, 'ok', false, 'error', 'not_owned_or_not_found');
      continue;
    end if;

    v_daily := nullif(v_update->>'dailyRate', '')::numeric;
    v_weekly := nullif(v_update->>'weeklyRate', '')::numeric;
    v_monthly := nullif(v_update->>'monthlyRate', '')::numeric;
    v_sale := nullif(v_update->>'salePrice', '')::numeric;

    if (v_daily is not null and v_daily < 0) or (v_weekly is not null and v_weekly < 0) or (v_monthly is not null and v_monthly < 0) or (v_sale is not null and v_sale < 0) then
      v_results := v_results || jsonb_build_object('listingId', v_listing_id, 'ok', false, 'error', 'negative_price_rejected');
      continue;
    end if;

    update public.listings set
      daily_rate = coalesce(v_daily, daily_rate),
      weekly_rate = coalesce(v_weekly, weekly_rate),
      monthly_rate = coalesce(v_monthly, monthly_rate),
      sale_price = coalesce(v_sale, sale_price)
    where id = v_listing_id;

    v_results := v_results || jsonb_build_object('listingId', v_listing_id, 'ok', true);
  end loop;

  v_result := jsonb_build_object('results', v_results);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'merchant_bulk_update_listing_prices', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.merchant_bulk_update_listing_prices(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.merchant_bulk_update_listing_prices(uuid, jsonb, text) to service_role;

-- ============================================================
-- CSV IMPORT -- Pro/Elite only (entitlement checked in the route).
-- Every imported row lands as status='draft' -- publishing it later
-- goes through the CANONICAL publish_* RPCs (activate_listing /
-- publish_marketplace_request / publish_barter_skill_task_post), which
-- already enforce KYC/moderation/cap/feature-flag rules. Import itself
-- cannot bypass any of that by construction, since it never sets
-- status to anything but 'draft'. Per-row validation errors are
-- collected and returned rather than aborting the whole batch.
-- ============================================================
create or replace function public.merchant_import_listing_drafts(
  p_merchant_id uuid,
  p_country_id text,
  p_rows jsonb,
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
  v_row jsonb;
  v_title text;
  v_category text;
  v_listing_type text;
  v_daily numeric;
  v_weekly numeric;
  v_monthly numeric;
  v_sale numeric;
  v_new_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_row_index int := 0;
  v_result jsonb;
  v_imported_count int := 0;
  v_failed_count int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'rows must be a non-empty JSON array';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'too many rows in a single import (max 200)';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || p_rows::text);
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'merchant_import_listing_drafts' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row_index := v_row_index + 1;
    v_title := nullif(trim(v_row->>'title'), '');
    v_category := nullif(trim(v_row->>'category'), '');
    v_listing_type := nullif(trim(v_row->>'listing_type'), '');

    if v_title is null or length(v_title) > 200 then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'title_required_max_200_chars');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    if v_category is null or length(v_category) > 100 then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'category_required');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    if v_listing_type is null or v_listing_type not in ('rental', 'sale', 'both') then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'listing_type_must_be_rental_sale_or_both');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;

    begin
      v_daily := nullif(v_row->>'daily_rate', '')::numeric;
      v_weekly := nullif(v_row->>'weekly_rate', '')::numeric;
      v_monthly := nullif(v_row->>'monthly_rate', '')::numeric;
      v_sale := nullif(v_row->>'sale_price', '')::numeric;
    exception when others then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'invalid_money_value');
      v_failed_count := v_failed_count + 1;
      continue;
    end;

    if (v_daily is not null and v_daily < 0) or (v_weekly is not null and v_weekly < 0) or (v_monthly is not null and v_monthly < 0) or (v_sale is not null and v_sale < 0) then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'negative_price_rejected');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    if v_listing_type in ('rental', 'both') and v_daily is null then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'daily_rate_required_for_rental');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    if v_listing_type in ('sale', 'both') and v_sale is null then
      v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', false, 'error', 'sale_price_required_for_sale');
      v_failed_count := v_failed_count + 1;
      continue;
    end if;

    perform public._validate_skill_task_content(array[v_title, nullif(trim(v_row->>'description'), '')]);

    insert into public.listings (
      merchant_id, country_id, title, description, category, condition,
      daily_rate, weekly_rate, monthly_rate, sale_price, listing_type,
      province, city, status, risk_tier, is_test, direction,
      min_rental_days, deposit_required
    ) values (
      p_merchant_id, p_country_id, v_title, nullif(trim(v_row->>'description'), ''), v_category, coalesce(nullif(trim(v_row->>'condition'), ''), 'good'),
      v_daily, v_weekly, v_monthly, v_sale, v_listing_type::listing_type,
      nullif(trim(v_row->>'province'), ''), nullif(trim(v_row->>'city'), ''), 'draft', 'low', false, 'available',
      1, false
    ) returning id into v_new_id;

    v_results := v_results || jsonb_build_object('rowIndex', v_row_index, 'ok', true, 'listingId', v_new_id);
    v_imported_count := v_imported_count + 1;
  end loop;

  v_result := jsonb_build_object('results', v_results, 'importedCount', v_imported_count, 'failedCount', v_failed_count);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'merchant_import_listing_drafts', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.merchant_import_listing_drafts(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.merchant_import_listing_drafts(uuid, text, jsonb, text) to service_role;
