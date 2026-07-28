-- ============================================================
-- Risk Engine (Phase 1 architecture change)
-- ============================================================
-- Replaces the removed credit-score gate with an automatic LOW /
-- MEDIUM / HIGH risk classification for every listing.
--
-- IMPORTANT: `listings.risk_tier` is computed exclusively by the
-- trigger below. The trigger overwrites NEW.risk_tier on every
-- insert/update regardless of what a client sends for that column,
-- so merchants/renters/API callers cannot override it — the only
-- way to change a listing's tier is to change the underlying
-- signals (price, category, merchant standing) that drive it.
--
-- Mirrors src/lib/risk/engine.ts — keep both in sync. See
-- docs/RISK_ENGINE.md for the full rule rationale.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

do $$ begin
  create type risk_tier as enum ('low', 'medium', 'high');
exception when duplicate_object then null; end $$;

alter table public.listings
  add column if not exists risk_tier risk_tier not null default 'low';

create or replace function public.compute_listing_risk_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  category_rank   int;
  value_rank      int;
  tier_rank       int;
  m_kyc_status    kyc_status;
  m_unity_score   numeric(3,2);
begin
  -- Category floor: some categories carry inherent risk regardless of price.
  category_rank := case NEW.category
    when 'vehicles' then 2
    when 'tech'     then 1
    when 'tools'    then 1
    when 'fashion'  then 1
    when 'music'    then 1
    else 0
  end;

  -- Value-based tier from daily rate (ZAR/day).
  value_rank := case
    when NEW.daily_rate >= 2500 then 2
    when NEW.daily_rate >= 500  then 1
    else 0
  end;

  tier_rank := greatest(category_rank, value_rank);

  -- Trust modifier: an unverified or low-standing merchant raises risk one tier.
  select kyc_status, unity_score into m_kyc_status, m_unity_score
  from public.profiles where id = NEW.merchant_id;

  if m_kyc_status is distinct from 'approved' or coalesce(m_unity_score, 0) < 3.0 then
    tier_rank := least(tier_rank + 1, 2);
  end if;

  NEW.risk_tier := case tier_rank
    when 2 then 'high'
    when 1 then 'medium'
    else 'low'
  end;

  return NEW;
end;
$$;

drop trigger if exists set_listing_risk_tier on public.listings;
create trigger set_listing_risk_tier
  before insert or update on public.listings
  for each row execute procedure public.compute_listing_risk_tier();

-- Backfill risk_tier for any existing rows (fires the same computation via a no-op update).
update public.listings set daily_rate = daily_rate where risk_tier is not null;
