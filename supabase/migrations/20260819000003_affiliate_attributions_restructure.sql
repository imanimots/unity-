-- ============================================================
-- Step 11 Phase 7 -- restructure affiliate_referrals -> affiliate_attributions
-- ============================================================
-- affiliate_referrals carries zero live rows (confirmed live this
-- session) and was designed for a "one row = one already-computed
-- commission" model incompatible with the new event-based commission
-- engine. Repurposed as the pure ATTRIBUTION record ("who gets credit
-- for this listing") -- commission calculation/lifecycle moves entirely
-- to the new affiliate_commissions table (next migration). Renamed for
-- clarity since its role changes completely.
--
-- The old `status` column (affiliate_status: pending/paid/cancelled)
-- described COMMISSION payment state -- that concept now lives on
-- affiliate_commissions.status. The new `status` column here describes
-- ATTRIBUTION validity (active/expired/consumed/blocked), a different
-- concept, so the column is dropped and re-added with new semantics
-- rather than reusing the old enum.
--
-- unique(referred_user_id, listing_id) is the actual DB-level
-- enforcement of "first valid referral wins" -- a second attribution
-- attempt for the same customer+listing conflicts at the database
-- level, not just an application check.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.affiliate_referrals rename to affiliate_attributions;

alter table public.affiliate_attributions
  drop column if exists commission_amount,
  drop column if exists status,
  drop column if exists booking_id,
  drop column if exists order_id;

alter table public.affiliate_attributions
  add column if not exists merchant_id uuid references public.profiles(id),
  add column if not exists referral_code text,
  add column if not exists attributed_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz,
  add column if not exists consumed_at timestamptz,
  add column if not exists source text not null default 'cookie' check (source in ('cookie', 'direct_link')),
  add column if not exists status text not null default 'active' check (status in ('active', 'expired', 'consumed', 'blocked'));

alter table public.affiliate_attributions
  alter column referred_user_id set not null,
  alter column listing_id set not null;

alter table public.affiliate_attributions
  add constraint affiliate_attributions_unique_customer_listing unique (referred_user_id, listing_id);

create index if not exists affiliate_attributions_merchant_idx on public.affiliate_attributions(merchant_id);
create index if not exists affiliate_attributions_listing_idx on public.affiliate_attributions(listing_id);

-- ─────────────────────────────────────────
-- RLS -- zero client write policies (Decision 5). Every mutation goes
-- through open_affiliate_attribution() (next-but-one migration).
-- ─────────────────────────────────────────
drop policy if exists "affiliate_referrals: affiliate read" on public.affiliate_attributions;

create policy "affiliate_attributions: affiliate read"
  on public.affiliate_attributions for select
  using (affiliate_id = auth.uid());

create policy "affiliate_attributions: merchant read"
  on public.affiliate_attributions for select
  using (merchant_id = auth.uid());
