-- ============================================================
-- Listing creation RPC — Phase 2A (merchant listing wizard persistence)
-- ============================================================
-- Two SECURITY DEFINER functions are the only server-authoritative path
-- for wizard persistence: save_listing_draft() and
-- submit_listing_for_review(). SECURITY DEFINER is necessary here — not a
-- weakening of RLS — because a single call spans tables with different
-- RLS postures: listings/listing_requirements/listing_private_details are
-- merchant-insertable directly, but listing_moderation and
-- listing_history have NO client-facing INSERT policy at all, by design
-- (Phase 0 — see docs/LISTING_SCHEMA.md). Rather than adding a broad new
-- client INSERT policy to those tables (which would let any authenticated
-- user insert directly, not just via this controlled path), these
-- functions perform the ownership/auth check themselves. auth.uid() is
-- read from the session JWT and is NOT affected by SECURITY DEFINER —
-- see the reasoning already established in
-- 20260729000001_fix_rls_privilege_escalation.sql and
-- 20260729000006_listing_security_hardening.sql.
--
-- These functions are reachable directly via Supabase's RPC endpoint by
-- any authenticated client — not only via the intended Next.js API route
-- — so no field that must never be client-controlled (see
-- docs/LISTING_SCHEMA.md) is ever taken from a client-supplied value here.
-- In particular, declaration wording/version/hash are resolved from the
-- server-owned declaration_catalogue table below, never from client
-- input, precisely because a client could otherwise call this RPC
-- directly and skip the Next.js layer entirely.
--
-- Both functions extract an explicit allowlist of keys from their jsonb
-- inputs and ignore anything else — never `jsonb_populate_record` against
-- the whole row, which would blindly accept whatever the client sent for
-- every column including privileged ones.
--
-- Not applied to any live database. Apply via: Supabase Dashboard →
-- SQL Editor → Run.
-- ============================================================

-- ─────────────────────────────────────────
-- BUCKET CONFIG FIX — the `ownership-proofs` bucket (initial schema
-- migration) only allows image/jpeg,png,webp + application/pdf at 20MB,
-- but the wizard's Ownership step has always told merchants "JPG, PNG,
-- PDF, MP4 — up to 50MB" (create-listing-flow.tsx) and its own info copy
-- mentions "a short video of the item" as an accepted proof. Wiring up
-- real uploads in this pass surfaced the mismatch — validating against
-- the weaker existing bucket config would silently reject video uploads
-- users have always been told are accepted. Widening the bucket to match
-- what the product already promises, not a new capability.
-- ─────────────────────────────────────────
update storage.buckets
set allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf','video/mp4'],
    file_size_limit = 52428800 -- 50 MB, matching the wizard's stated limit
where id = 'ownership-proofs';

-- ─────────────────────────────────────────
-- DECLARATION CATALOGUE — server-owned wording/version/hash per
-- declaration_type. Public read (the wizard must show the exact wording
-- before a merchant accepts it); no client write policy at all —
-- managed only via migration/admin connection. `wording_hash` uses
-- Postgres's built-in md5() rather than pgcrypto — this is a content
-- fingerprint for proving what wording was accepted, not a security
-- secret, so no cryptographic extension dependency is needed.
-- ─────────────────────────────────────────
create table if not exists public.declaration_catalogue (
  declaration_type declaration_type not null,
  version           text not null,
  wording           text not null,
  wording_hash      text not null,
  effective_date    date not null default current_date,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  primary key (declaration_type, version)
);

alter table public.declaration_catalogue enable row level security;

create policy "declaration_catalogue: public read"
  on public.declaration_catalogue for select using (true);

insert into public.declaration_catalogue (declaration_type, version, wording, wording_hash) values
  ('ownership_authority', '1.0',
   'I confirm that I own this item or have legal authority to rent it out on Unity.',
   md5('I confirm that I own this item or have legal authority to rent it out on Unity.')),
  ('condition_accuracy', '1.0',
   'I confirm that the condition and defects described are accurate to the best of my knowledge.',
   md5('I confirm that the condition and defects described are accurate to the best of my knowledge.')),
  ('image_accuracy', '1.0',
   'I confirm that the uploaded images represent the actual item being listed.',
   md5('I confirm that the uploaded images represent the actual item being listed.')),
  ('legal_and_safe_item', '1.0',
   'I confirm that this item is legal to rent and is safe and functional for its declared use.',
   md5('I confirm that this item is legal to rent and is safe and functional for its declared use.')),
  ('platform_terms', '1.0',
   'I agree to Unity''s listing, rental, dispute, and damage rules.',
   md5('I agree to Unity''s listing, rental, dispute, and damage rules.')),
  ('off_platform_transaction_policy', '1.0',
   'I understand that transacting outside Unity where prohibited, or providing false information, may result in account suspension.',
   md5('I understand that transacting outside Unity where prohibited, or providing false information, may result in account suspension.'))
on conflict (declaration_type, version) do nothing;

-- ─────────────────────────────────────────
-- SAVE_LISTING_DRAFT — create-or-update. Called with p_listing_id = null
-- to create a new draft (returns the new id); called with an existing id
-- to update it (only while status = 'draft' and owned by the caller —
-- editing a submitted listing is a separate, more restrictive path, not
-- built this pass). Always leaves status at 'draft' — never sets
-- 'pending'/'active'/'rented' — see submit_listing_for_review() for the
-- only path that advances status.
-- ─────────────────────────────────────────
create or replace function public.save_listing_draft(
  p_listing_id  uuid,
  p_listing     jsonb,
  p_requirements jsonb,
  p_media       jsonb
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
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Resolve the wizard's category text to a real categories.id, rejecting
  -- an unknown or inactive category rather than trusting a raw slug —
  -- category_id is never accepted directly from the client.
  select id into v_category_id
  from public.categories
  where slug = (p_listing->>'category') and is_active = true;

  if v_category_id is null then
    raise exception 'invalid or inactive category: %', coalesce(p_listing->>'category', '(none)');
  end if;

  if p_listing_id is null then
    insert into public.listings (
      merchant_id, country_id, title, description, category, category_id, condition,
      daily_rate, weekly_rate, min_rental_days, deposit_required, deposit_amount,
      insurance_amount, shipping_payer, accepts_affiliates, affiliate_commission_rate,
      condition_confirmed, status
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
      coalesce((p_listing->>'deposit_required')::boolean, false),
      nullif(p_listing->>'deposit_amount', '')::numeric,
      nullif(p_listing->>'insurance_amount', '')::numeric,
      coalesce((p_listing->>'shipping_payer')::shipping_payer, 'negotiate'),
      coalesce((p_listing->>'accepts_affiliates')::boolean, false),
      coalesce(nullif(p_listing->>'affiliate_commission_rate', '')::numeric, 0),
      coalesce((p_listing->>'condition_confirmed')::boolean, false),
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
      deposit_required = coalesce((p_listing->>'deposit_required')::boolean, deposit_required),
      deposit_amount = nullif(p_listing->>'deposit_amount', '')::numeric,
      insurance_amount = nullif(p_listing->>'insurance_amount', '')::numeric,
      shipping_payer = coalesce((p_listing->>'shipping_payer')::shipping_payer, shipping_payer),
      accepts_affiliates = coalesce((p_listing->>'accepts_affiliates')::boolean, accepts_affiliates),
      affiliate_commission_rate = coalesce(nullif(p_listing->>'affiliate_commission_rate', '')::numeric, affiliate_commission_rate),
      condition_confirmed = coalesce((p_listing->>'condition_confirmed')::boolean, condition_confirmed)
    where id = v_listing_id;
  end if;

  -- listing_private_details / listing_requirements: always ensure a row
  -- exists once a listing does, so future edit passes have something to
  -- attach to without another migration. Deferred fields (see
  -- docs/LISTING_SCHEMA.md) stay at their column defaults.
  insert into public.listing_private_details (listing_id)
  values (v_listing_id)
  on conflict (listing_id) do nothing;

  insert into public.listing_requirements (listing_id, deposit_basis, requested_deposit_amount)
  values (v_listing_id, 'fixed', nullif(p_requirements->>'requested_deposit_amount', '')::numeric)
  on conflict (listing_id) do update
    set requested_deposit_amount = excluded.requested_deposit_amount;

  -- Media: replace this listing's photo/ownership_proof rows with the
  -- provided set. Files are already uploaded to Storage client-side
  -- before this call — this only writes metadata referencing those
  -- already-uploaded URLs/paths. display_order comes from array position.
  delete from public.listing_media
  where listing_id = v_listing_id and type in ('photo', 'ownership_proof');

  for v_item in select * from jsonb_array_elements(coalesce(p_media, '[]'::jsonb))
  loop
    insert into public.listing_media (listing_id, url, type, display_order, shot_type)
    values (
      v_listing_id,
      v_item->>'url',
      (v_item->>'type')::media_type,
      coalesce((v_item->>'display_order')::int, 0),
      nullif(v_item->>'shot_type', '')::media_shot_type
    );
  end loop;

  return v_listing_id;
end;
$$;

-- ─────────────────────────────────────────
-- SUBMIT_LISTING_FOR_REVIEW — advances a draft to 'pending'. Requires
-- every currently-active declaration_type to be present in
-- p_declaration_types (accepting only some is rejected). Declaration
-- version/hash are resolved from declaration_catalogue here — never
-- accepted from the client — closing the "call the RPC directly and skip
-- the app's version check" gap described in the header above.
-- ─────────────────────────────────────────
create or replace function public.submit_listing_for_review(
  p_listing_id uuid,
  p_declaration_types declaration_type[]
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
begin
  if v_uid is null then
    raise exception 'not authenticated';
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

  foreach v_type in array p_declaration_types
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

  return jsonb_build_object('listing_id', p_listing_id, 'status', 'pending');
end;
$$;

-- Explicit, narrow grants — only authenticated sessions may call these
-- (both also self-reject unauthenticated callers internally as a second
-- layer, consistent with this codebase's defense-in-depth convention).
revoke execute on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb) to authenticated;

revoke execute on function public.submit_listing_for_review(uuid, declaration_type[]) from public;
grant execute on function public.submit_listing_for_review(uuid, declaration_type[]) to authenticated;
