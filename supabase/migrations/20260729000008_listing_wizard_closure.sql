-- ============================================================
-- Listing wizard closure pass (Phase 2A closure, schema only)
-- ============================================================
-- Closes gaps left by 20260729000007: category-specific metadata,
-- availability, full listing_requirements, and server-side idempotency.
-- `save_listing_draft` and `submit_listing_for_review` are DROPPED and
-- RECREATED here rather than edited in place — 20260729000007 is left
-- untouched (forward-only), and `create or replace function` cannot
-- change a parameter list without either matching the old signature
-- exactly or creating a second overloaded function alongside the old one
-- (which would leave the old, less-validated signature still callable).
-- Dropping first guarantees exactly one version of each function exists.
-- Not applied to any live database. Apply via: Supabase Dashboard →
-- SQL Editor → Run.
-- ============================================================

-- ─────────────────────────────────────────
-- DATA-INTEGRITY FIX — listing_declarations (20260729000003) has no
-- unique constraint on (listing_id, declaration_type), so a client
-- sending a duplicate type in submit_listing_for_review's
-- p_declaration_types array could otherwise insert two accepted rows for
-- the same declaration. The RPC below also deduplicates the array before
-- looping (defense-in-depth) — this constraint is the actual guarantee,
-- since it holds even against a future code path that forgets to dedupe.
-- ─────────────────────────────────────────
alter table public.listing_declarations
  add constraint listing_declarations_listing_type_uniq unique (listing_id, declaration_type);

-- ─────────────────────────────────────────
-- CATEGORY FIELD DEFINITIONS — the authoritative (SQL-side) allowlist of
-- which category_metadata / private_category_metadata keys are valid per
-- category. src/lib/listings/category-fields.ts is the TS mirror used for
-- wizard rendering and client-side validation; this table is what
-- actually gates what `save_listing_draft` will persist, since the RPC is
-- reachable directly (not only via the Next.js API route) — mirrors why
-- `declaration_catalogue` (20260729000007) resolves server-side instead
-- of trusting client input.
-- ─────────────────────────────────────────
create table if not exists public.category_field_definitions (
  category_slug text not null references public.categories(slug),
  field_key      text not null,
  is_private     boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (category_slug, field_key)
);

alter table public.category_field_definitions enable row level security;

create policy "category_field_definitions: public read"
  on public.category_field_definitions for select using (true);

-- No write policy — managed via migration/admin connection only, same
-- convention as `categories`/`subcategories`/`declaration_catalogue`.

insert into public.category_field_definitions (category_slug, field_key, is_private) values
  ('vehicles', 'transmission', false),
  ('vehicles', 'fuel_type', false),
  ('vehicles', 'mileage', false),
  ('vehicles', 'vin', true),
  ('vehicles', 'registration_number', true),
  ('vehicles', 'ownership_document_id', true),
  ('tech', 'storage_capacity', false),
  ('tech', 'battery_condition', false),
  ('tech', 'charger_included', false),
  ('tech', 'activation_lock_status', false),
  ('tech', 'imei', true),
  ('tech', 'serial_number', true),
  ('tech', 'additional_verification_id', true),
  ('tools', 'power_source', false),
  ('tools', 'voltage', false),
  ('tools', 'operating_capacity', false),
  ('tools', 'safety_equipment_required', false)
on conflict (category_slug, field_key) do nothing;

-- Strips any key not on the allowlist for (category, visibility). Returns
-- '{}'::jsonb (never null) so callers can safely store the result
-- directly without a null-check.
create or replace function public.sanitize_category_metadata(
  p_category text,
  p_is_private boolean,
  p_payload jsonb
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
  from jsonb_each(coalesce(p_payload, '{}'::jsonb)) as kv(key, value)
  where exists (
    select 1 from public.category_field_definitions cfd
    where cfd.category_slug = p_category
      and cfd.field_key = kv.key
      and cfd.is_private = p_is_private
  );
$$;

-- ─────────────────────────────────────────
-- IDEMPOTENCY — no client-facing policy at all (RPC-internal only,
-- accessed only from within the SECURITY DEFINER functions below, same
-- "no policy = default deny, functions bypass via their owner's
-- privileges" pattern as listing_history/listing_moderation). Repeated
-- calls with the same (merchant, operation, key) short-circuit to the
-- cached result; a reused key with a different request payload is
-- rejected rather than silently returning a stale result for the wrong
-- request. Cleanup strategy: no scheduler exists in this codebase yet —
-- documented as a periodic manual/future-automated
-- `delete from idempotency_keys where created_at < now() - interval '48 hours'`,
-- not built here.
-- ─────────────────────────────────────────
create table if not exists public.idempotency_keys (
  merchant_id      uuid not null references public.profiles(id),
  operation        text not null,
  idempotency_key  text not null,
  request_hash     text not null,
  result           jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (merchant_id, operation, idempotency_key)
);

alter table public.idempotency_keys enable row level security;
-- Deliberately zero policies — see header.

-- ─────────────────────────────────────────
-- SAVE_LISTING_DRAFT (v2) — adds category metadata, availability ranges,
-- the full listing_requirements field set, and idempotency. Same
-- create-or-update / draft-only-editable / explicit-allowlist rules as
-- v1 (20260729000007). `p_requirements` and `p_listing` accept a wider
-- set of keys now; anything not explicitly extracted below is still
-- silently ignored, same as v1.
-- ─────────────────────────────────────────
drop function if exists public.save_listing_draft(uuid, jsonb, jsonb, jsonb);

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

  if p_listing_id is null then
    insert into public.listings (
      merchant_id, country_id, title, description, category, category_id, condition,
      daily_rate, weekly_rate, min_rental_days, max_rental_days, deposit_required, deposit_amount,
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
      (p_listing->>'daily_rate')::numeric,
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
      daily_rate = coalesce((p_listing->>'daily_rate')::numeric, daily_rate),
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

  -- Media: replace-all, same as v1. The Next.js API route (src/app/api/
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
  -- transaction (atomicity — see header).
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

-- ─────────────────────────────────────────
-- SUBMIT_LISTING_FOR_REVIEW (v2) — adds idempotency. Declaration
-- resolution logic unchanged from v1.
-- ─────────────────────────────────────────
drop function if exists public.submit_listing_for_review(uuid, declaration_type[]);

create or replace function public.submit_listing_for_review(
  p_listing_id uuid,
  p_declaration_types declaration_type[],
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_type declaration_type;
  v_now timestamptz := now();
  v_version text;
  v_hash text;
  v_required_count int;
  v_provided_count int;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_declaration_types::text, '{}'));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_uid and operation = 'submit_listing_for_review' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if not exists (
    select 1 from public.listings
    where id = p_listing_id and merchant_id = v_uid and status = 'draft'
  ) then
    raise exception 'listing not found, not owned by caller, or not in draft status';
  end if;

  select count(distinct declaration_type) into v_required_count
  from public.declaration_catalogue where is_active;

  select count(distinct t) into v_provided_count
  from unnest(coalesce(p_declaration_types, array[]::declaration_type[])) as t;

  if v_provided_count < v_required_count then
    raise exception 'all required declarations must be accepted before submission';
  end if;

  -- Deduplicate before inserting — defense-in-depth alongside the unique
  -- constraint on listing_declarations (see this file's header).
  foreach v_type in array (select array_agg(distinct t) from unnest(p_declaration_types) as t)
  loop
    select version, wording_hash into v_version, v_hash
    from public.declaration_catalogue
    where declaration_type = v_type and is_active
    order by effective_date desc
    limit 1;

    if v_version is null then
      raise exception 'no active declaration catalogue entry for %', v_type;
    end if;

    insert into public.listing_declarations (
      listing_id, merchant_id, declaration_type, declaration_version,
      declaration_text_hash, accepted, accepted_at
    ) values (
      p_listing_id, v_uid, v_type, v_version, v_hash, true, v_now
    );
  end loop;

  insert into public.listing_moderation (listing_id, moderation_status)
  values (p_listing_id, 'pending')
  on conflict (listing_id) do update set moderation_status = 'pending', updated_at = v_now;

  update public.listings set status = 'pending' where id = p_listing_id;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, v_uid,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'pending'),
    'listing_submitted_for_review'
  );

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_uid, 'submit_listing_for_review', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke execute on function public.submit_listing_for_review(uuid, declaration_type[], text) from public;
grant execute on function public.submit_listing_for_review(uuid, declaration_type[], text) to authenticated;
