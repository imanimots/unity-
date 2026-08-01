-- ============================================================
-- Listing + listing_media security hardening (Phase 0, schema only)
-- ============================================================
-- Closes gaps the 20260729000001 privilege-escalation pass didn't reach
-- (it covered profiles/bookings/orders, not listings), plus two gaps
-- specific to the tables this listing-wizard-fields effort introduces.
-- Same pattern throughout: `auth.role() <> 'service_role'` triggers that
-- silently revert privileged columns, exactly like
-- `protect_profile_privileged_fields`/`protect_booking_financial_fields`
-- in 20260729000001_fix_rls_privilege_escalation.sql.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ─────────────────────────────────────────
-- LISTINGS — WITH CHECK was missing entirely (the one table the
-- 20260729000001 pass didn't touch), and no trigger protects
-- ownership_verified, merchant_id, or status the way risk_tier is already
-- protected by compute_listing_risk_tier().
-- ─────────────────────────────────────────
drop policy if exists "listings: merchant update" on public.listings;
create policy "listings: merchant update"
  on public.listings for update
  using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

-- Privileged fields, and exactly what a merchant may still do directly:
--   - merchant_id:         never client-settable (identity of the row).
--   - ownership_verified:  never client-settable — set only by a future
--                           admin/service-role verification workflow.
--   - status:               merchant MAY set 'draft' and 'pending'
--                           directly (save draft / submit for review) and
--                           may set 'paused' from 'active' (self-service
--                           pause). Merchant may NOT set 'active' or
--                           'rented' directly — 'active' requires a future
--                           service-role completeness + moderation check
--                           (see listing_moderation, listing_requirements,
--                           and getRiskRequirements() in
--                           src/lib/risk/engine.ts, none of which are
--                           replicated in SQL here — that logic belongs in
--                           application code, not a trigger, precisely
--                           because it will keep changing); 'rented'
--                           requires a real booking transition that
--                           doesn't exist yet either.
-- risk_tier is already protected by compute_listing_risk_tier()
-- (20260720000002_risk_engine.sql) — no change needed here.
--
-- Note for future readers: `featured`, `suspended`, `admin-approved`, and
-- `fraud-cleared` do not exist as columns anywhere in this schema. If one
-- is added later, it must be added to this same trigger's protected list,
-- not left as a plain client-writable column.
-- Handles both INSERT and UPDATE: the "listings: merchant insert" policy
-- (20260613000001_initial_schema.sql) only constrains merchant_id at
-- insert time — nothing stops a client from INSERTing a brand new row
-- with status='active' or ownership_verified=true from the start, which
-- would bypass an UPDATE-only trigger entirely. `old` doesn't exist on
-- INSERT, so that branch uses sensible defaults instead of reverting to a
-- prior value.
create or replace function public.protect_listing_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.ownership_verified := false;
      if new.status in ('active', 'rented') then
        new.status := 'draft';
      end if;
    else
      new.merchant_id := old.merchant_id;
      new.ownership_verified := old.ownership_verified;

      if new.status in ('active', 'rented') and new.status is distinct from old.status then
        new.status := old.status;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_listing_privileged_fields_trg on public.listings;
create trigger protect_listing_privileged_fields_trg
  before insert or update on public.listings
  for each row execute procedure public.protect_listing_privileged_fields();

-- ─────────────────────────────────────────
-- LISTING_REQUIREMENTS — final_deposit_amount is system-calculated (per
-- the risk-tier deposit rules); requested_deposit_amount stays freely
-- merchant-settable.
-- ─────────────────────────────────────────
-- Same INSERT-vs-UPDATE reasoning as protect_listing_privileged_fields()
-- above: "listing_requirements: merchant insert own" doesn't restrict
-- final_deposit_amount at insert time either.
create or replace function public.protect_listing_requirements_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.final_deposit_amount := null;
    else
      new.final_deposit_amount := old.final_deposit_amount;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_listing_requirements_privileged_fields_trg on public.listing_requirements;
create trigger protect_listing_requirements_privileged_fields_trg
  before insert or update on public.listing_requirements
  for each row execute procedure public.protect_listing_requirements_privileged_fields();

-- ─────────────────────────────────────────
-- LISTING_MEDIA — the existing "public read" policy has no `type` filter,
-- so ownership_proof rows (pointing into the private `ownership-proofs`
-- storage bucket) are publicly listable today via the table, even though
-- the bucket's own storage-object policy already keeps the file bytes
-- private. This leaks path/existence/naming/timestamp metadata. Table RLS
-- and storage RLS are two separate systems — fixing one does not fix the
-- other, so both are addressed here (storage fix follows below).
-- ─────────────────────────────────────────
drop policy if exists "listing_media: public read" on public.listing_media;
create policy "listing_media: public read"
  on public.listing_media for select
  using (type <> 'ownership_proof');

create policy "listing_media: owner read ownership proof"
  on public.listing_media for select
  using (
    type = 'ownership_proof'
    and exists (
      select 1 from public.listings
      where listings.id = listing_media.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_media: admin read ownership proof"
  on public.listing_media for select
  using (
    type = 'ownership_proof'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- ─────────────────────────────────────────
-- STORAGE — the existing `ownership-proofs` bucket policy
-- ("storage ownership-proofs: own read", from the initial schema
-- migration) only lets the uploading merchant read their own files by
-- path (`auth.uid()::text = foldername[1]`). There is no admin read path
-- at the storage-object level at all — so even after the table-level fix
-- above, an admin could see that an ownership-proof row exists but
-- couldn't actually view the file. This is the storage-layer half of the
-- same fix; do not assume the table fix alone covers it.
-- ─────────────────────────────────────────
create policy "storage ownership-proofs: admin read"
  on storage.objects for select
  using (
    bucket_id = 'ownership-proofs'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );
