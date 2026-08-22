-- ============================================================
-- Rent-to-Buy V2 -- economic model schema.
-- ============================================================
-- Replaces the incomplete/contradictory placeholder RTB economics
-- (per-installment 'policy_pending' commission events, immediate
-- ownership transfer on 100%-paid, hardcoded first-installment
-- possession trigger, no deposit-before-handover gate, no grace/
-- return-window/forfeiture/amendment concepts) with the full RTB V2
-- product authority: rental-style possession + installment purchase +
-- escrow + eventual ownership transfer, possession != ownership,
-- merchant-defined possession trigger, mandatory completion/inspection
-- window before ownership finalizes, formal default (irreversible) vs
-- default-eligible (computed, never auto-transitioned), rental/use
-- settlement capped at held purchase escrow, RENTAL commission (never
-- sale), late-return deposit forfeiture, bilateral amendments.
--
-- Additive only in this file -- every new column has a safe default so
-- existing rows (all currently pre-V2, either historical/completed or
-- mid-lifecycle) remain valid. Behavioral RPC changes are in the
-- companion RPC migration.
-- ============================================================

-- ── new dedicated enum for rental/use billing unit ──
-- Deliberately NOT reusing rent_to_buy_frequency (weekly/biweekly/
-- monthly, for the INSTALLMENT schedule) -- the rental/use rate's
-- billing unit is a distinct concept that may legitimately differ from
-- the purchase installment cadence, and needs 'daily' (Rule 13), which
-- payment_frequency does not have. A fresh CREATE TYPE, usable within
-- this same migration/transaction (unlike ALTER TYPE ... ADD VALUE on
-- an existing enum).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_rate_unit') then
    create type rent_to_buy_rate_unit as enum ('daily', 'weekly', 'monthly');
  end if;
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_possession_trigger_type') then
    create type rent_to_buy_possession_trigger_type as enum ('first_payment', 'installment_count', 'percentage', 'full_payment');
  end if;
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_amendment_status') then
    create type rent_to_buy_amendment_status as enum ('proposed', 'accepted', 'withdrawn', 'superseded');
  end if;
end $$;

-- ── rent_to_buy_listing_terms: merchant-configurable source of truth ──
alter table public.rent_to_buy_listing_terms
  add column if not exists possession_trigger_type public.rent_to_buy_possession_trigger_type not null default 'first_payment',
  add column if not exists possession_trigger_value numeric(12,4),
  add column if not exists rental_use_rate_amount numeric(12,2) not null default 0 check (rental_use_rate_amount >= 0),
  add column if not exists rental_use_rate_unit public.rent_to_buy_rate_unit not null default 'monthly',
  add column if not exists wear_damage_standard text,
  add column if not exists grace_period_days int not null default 7 check (grace_period_days >= 0),
  add column if not exists return_window_days int not null default 14 check (return_window_days >= 0);

alter table public.rent_to_buy_listing_terms
  add constraint rtb_listing_terms_possession_trigger_value_chk check (
    (possession_trigger_type in ('first_payment', 'full_payment') and possession_trigger_value is null)
    or (possession_trigger_type = 'installment_count' and possession_trigger_value is not null and possession_trigger_value > 0)
    or (possession_trigger_type = 'percentage' and possession_trigger_value is not null and possession_trigger_value > 0 and possession_trigger_value <= 100)
  );

-- ── rent_to_buy_agreements: accepted-terms snapshot + full lifecycle tracking ──
alter table public.rent_to_buy_agreements
  add column if not exists possession_trigger_type public.rent_to_buy_possession_trigger_type not null default 'first_payment',
  add column if not exists possession_trigger_value numeric(12,4),
  add column if not exists rental_use_rate_amount numeric(12,2) not null default 0 check (rental_use_rate_amount >= 0),
  add column if not exists rental_use_rate_unit public.rent_to_buy_rate_unit not null default 'monthly',
  add column if not exists wear_damage_standard text,
  add column if not exists grace_period_days int not null default 7 check (grace_period_days >= 0),
  add column if not exists return_window_days int not null default 14 check (return_window_days >= 0),
  add column if not exists rental_commission_rate_bps int check (rental_commission_rate_bps is null or rental_commission_rate_bps >= 0),
  -- Commission plan snapshot, taken at acceptance alongside the rate
  -- itself (Rule 29) -- lets settlement build a unity_commissions row
  -- without re-resolving the merchant's (possibly since-changed) live
  -- plan, exactly matching how sale/rental commission rows already
  -- snapshot merchant_plan_id/plan_commercial_version once and never
  -- recompute them later.
  add column if not exists commission_merchant_plan_id text references public.merchant_subscription_plans(id),
  add column if not exists commission_plan_commercial_version int,
  -- Handover/possession sub-state markers (Rule 5/6) -- no new
  -- possession_status enum value needed; 'possession_eligible' covers
  -- both "not yet handed over" and "handed over, awaiting customer
  -- confirmation", distinguished by handed_over_at.
  add column if not exists possession_eligible_at timestamptz,
  add column if not exists deposit_funded_at timestamptz,
  add column if not exists handed_over_at timestamptz,
  -- Fully-paid vs ownership-finalized are now distinct events (Rule 4/7)
  -- -- ownership_transferred_at (already existed) is repurposed to mean
  -- ONLY the final, post-inspection-window finalization moment; this
  -- new column captures the earlier "100% paid" moment on its own.
  add column if not exists fully_paid_at timestamptz,
  add column if not exists completion_window_ends_at timestamptz,
  -- Formal default, return, and forfeiture tracking (Rule 17/18/22-24).
  -- default_at/default_reason/default_reconciliation_pending already
  -- exist and are reused as-is for FORMAL (irreversible) default.
  add column if not exists return_deadline_at timestamptz,
  add column if not exists actual_returned_at timestamptz,
  add column if not exists deposit_forfeited_at timestamptz,
  add column if not exists deposit_forfeiture_reason text,
  add column if not exists deposit_refunded_at timestamptz,
  add column if not exists settled_at timestamptz;

alter table public.rent_to_buy_agreements
  add constraint rtb_agreements_deposit_settlement_once_chk check (
    deposit_forfeited_at is null or deposit_refunded_at is null
  );

comment on column public.rent_to_buy_agreements.default_at is 'Formal default moment (Rule 18) -- irreversible once set. Never confused with grace-period expiry, which is a computed, non-persisted eligibility fact (see rent_to_buy_default_eligibility()).';
comment on column public.rent_to_buy_agreements.ownership_transferred_at is 'Set ONLY once the full completion pipeline clears (100% paid + possession confirmed + completion window passed + no blocking dispute) -- never at the moment 100% is merely paid (see fully_paid_at for that).';

-- ── rent_to_buy_amendments: bilateral schedule amendments (Rule 21) ──
-- total_purchase_price is never amendable (kept off the changeable-field
-- set entirely -- the safest reading of "merchant cannot unilaterally
-- increase the agreed purchase price"). Only forward-looking schedule
-- fields may be proposed: remaining installment schedule (as a fresh
-- jsonb array of {sequence, due_date, principal_amount} for still-
-- 'scheduled' installments only), grace_period_days, return_window_days.
create table if not exists public.rent_to_buy_amendments (
  id                    uuid primary key default gen_random_uuid(),
  agreement_id          uuid not null references public.rent_to_buy_agreements(id),
  status                public.rent_to_buy_amendment_status not null default 'proposed',
  proposed_by           uuid not null references public.profiles(id),
  proposed_changes      jsonb not null,
  previous_snapshot     jsonb not null,
  reason                text,
  proposed_at           timestamptz not null default now(),
  responded_at          timestamptz,
  responded_by          uuid references public.profiles(id),
  decline_reason        text,
  created_at            timestamptz not null default now()
);

create index if not exists rtb_amendments_agreement_idx on public.rent_to_buy_amendments(agreement_id, created_at);

alter table public.rent_to_buy_amendments enable row level security;

create policy "rtb_amendments: parties read" on public.rent_to_buy_amendments
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_amendments.agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid()))
  );
-- Zero client write policies -- every mutation is RPC-gated (companion migration).

-- ── rent_to_buy_evidence: handover/return condition evidence ──
-- Mirrors dispute_evidence's exact, genuinely-real architecture (this
-- is deliberately NOT a reuse of the booking pre/post-rental media
-- page, which is mock-only/setTimeout-fake with no real backend at
-- all -- see the companion report for the full audit finding). Same
-- 2-segment storage path convention, same private-bucket pattern,
-- same "no RPC layer, direct insert after revalidation" model,
-- immutable/append-only (no update/delete client policy).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_evidence_type') then
    create type rent_to_buy_evidence_type as enum ('pre_handover', 'post_handover_receipt', 'pre_return', 'post_return');
  end if;
end $$;

create table if not exists public.rent_to_buy_evidence (
  id                uuid primary key default gen_random_uuid(),
  agreement_id      uuid not null references public.rent_to_buy_agreements(id),
  uploaded_by       uuid not null references public.profiles(id),
  evidence_type     public.rent_to_buy_evidence_type not null,
  storage_path      text not null,
  file_type         text not null check (file_type in ('image', 'video', 'pdf')),
  display_order     int not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists rtb_evidence_agreement_idx on public.rent_to_buy_evidence(agreement_id, evidence_type);

alter table public.rent_to_buy_evidence enable row level security;

create policy "rtb_evidence: parties read" on public.rent_to_buy_evidence
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_evidence.agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid()))
  );
create policy "rtb_evidence: admin read" on public.rent_to_buy_evidence
  for select using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
-- No client INSERT/UPDATE/DELETE policy -- rows are written only by the
-- API route via a service-role client (same as dispute_evidence).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rent-to-buy-evidence', 'rent-to-buy-evidence', false,
  20971520, -- 20MB (allows short condition videos, unlike dispute-evidence's 10MB image/pdf-only cap)
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf']
)
on conflict (id) do nothing;

-- Path convention: {agreement_id}/{uploader_uid}/{filename} -- identical
-- shape to dispute_evidence's own path, compared as text (never cast to
-- uuid, avoiding the exact pitfall dispute_evidence's own comment warns
-- about for a malformed path segment).
create policy "storage rtb-evidence: participant read"
  on storage.objects for select
  using (
    bucket_id = 'rent-to-buy-evidence'
    and exists (
      select 1 from public.rent_to_buy_agreements a
      where a.id::text = (storage.foldername(name))[1]
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid())
    )
  );

create policy "storage rtb-evidence: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'rent-to-buy-evidence'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.rent_to_buy_agreements a
      where a.id::text = (storage.foldername(name))[1]
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid())
    )
  );

create policy "storage rtb-evidence: admin read"
  on storage.objects for select
  using (
    bucket_id = 'rent-to-buy-evidence'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );
-- No delete policy for anyone but service_role, by design (immutable).

-- ── unity_commissions: widen for RTB settlement-based commission ──
-- RTB commission is ONE row per agreement (computed once, at
-- settlement, from the actual possession period -- Rule 30), never
-- one-per-payment like sale/rental. payment_id therefore becomes
-- nullable (still unique when present), and the exactly-one-of
-- transaction check widens from 2-way (order/booking) to 3-way
-- (order/booking/rent_to_buy_agreement).
alter table public.unity_commissions
  add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

alter table public.unity_commissions alter column payment_id drop not null;

alter table public.unity_commissions drop constraint if exists unity_commissions_one_transaction_chk;
alter table public.unity_commissions add constraint unity_commissions_one_transaction_chk check (
  (order_id is not null and booking_id is null and rent_to_buy_agreement_id is null)
  or (order_id is null and booking_id is not null and rent_to_buy_agreement_id is null)
  or (order_id is null and booking_id is null and rent_to_buy_agreement_id is not null)
);

alter table public.unity_commissions drop constraint if exists unity_commissions_transaction_type_check;
alter table public.unity_commissions add constraint unity_commissions_transaction_type_check
  check (transaction_type in ('sale', 'rental', 'rent_to_buy'));

-- One settlement commission per agreement, ever (mirrors payment_id's
-- own uniqueness for the per-payment sale/rental case).
create unique index if not exists unity_commissions_rtb_agreement_unique
  on public.unity_commissions(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

create index if not exists unity_commissions_rtb_idx on public.unity_commissions(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

-- ── merchant_payouts: extend beyond bookings to RTB settlements ──
alter table public.merchant_payouts
  add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

-- No exactly-one-of CHECK existed before this migration (booking_id was
-- the only reference column and every existing row already has it set)
-- -- adding one now is additive and safe: every pre-existing row already
-- satisfies "booking_id is not null and rent_to_buy_agreement_id is
-- null".
alter table public.merchant_payouts drop constraint if exists merchant_payouts_one_transaction_chk;
alter table public.merchant_payouts add constraint merchant_payouts_one_transaction_chk check (
  (booking_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and rent_to_buy_agreement_id is not null)
);

create unique index if not exists merchant_payouts_rtb_agreement_unique
  on public.merchant_payouts(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

create index if not exists merchant_payouts_rtb_idx on public.merchant_payouts(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

-- ── escrow_transactions: extend beyond order/booking/barter to RTB ──
alter table public.escrow_transactions
  add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

alter table public.escrow_transactions drop constraint if exists escrow_transactions_transaction_type_check;
alter table public.escrow_transactions add constraint escrow_transactions_transaction_type_check
  check (transaction_type in ('sale', 'rental', 'barter', 'rent_to_buy'));

create index if not exists escrow_transactions_rtb_idx on public.escrow_transactions(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

-- ── ledger_entries: traceability only, not a transaction-family gate ──
-- booking_id is already nullable with no exactly-one-of CHECK today, so
-- this is a pure additive convenience column for RTB entries (commission/
-- payout/refund) to be traceable back to their agreement -- not a
-- structural requirement the way the three tables above are.
alter table public.ledger_entries
  add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

create index if not exists ledger_entries_rtb_idx on public.ledger_entries(rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null;

-- rent_to_buy_commission_events (the old per-installment placeholder
-- table) is superseded by the settlement-based unity_commissions row
-- above -- it is NOT dropped (immutable historical data, and dropping
-- a table is exactly the kind of destructive action this phase must
-- avoid) but is no longer written to going forward (see the companion
-- RPC migration; qualify_rent_to_buy_commission_event is retired
-- there). Its rate_status stays permanently 'policy_pending' for every
-- existing row -- an accurate historical record that no real rate was
-- ever computed under the old placeholder model.
comment on table public.rent_to_buy_commission_events is 'Superseded by unity_commissions (rent_to_buy_agreement_id) as of RTB V2 -- retained for historical/audit purposes only, no longer written to.';
