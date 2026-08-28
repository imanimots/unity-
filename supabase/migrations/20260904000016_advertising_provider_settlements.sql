-- Advertising MVP -- funding authority hardening.
--
-- PROVEN GAP (diagnosis phase, isolated is_test QA fixture): fund_ad_campaign()
-- previously accepted ANY non-empty p_provider_reference string as proof of
-- payment -- a completely fabricated reference, never produced by any
-- provider.charge() call, successfully funded a campaign. This migration
-- closes that gap with a genuine verified-settlement authority: a campaign
-- may only be provider-funded by consuming a settlement row that trusted
-- server code recorded AFTER a real (or, in dev, real-mock) charge
-- succeeded -- never by a bare string supplied at funding time.
--
-- Advertising-only accounting throughout: no FK/coupling to payments,
-- escrow, merchant_payouts, affiliate earnings, commissions, or
-- subscription billing, matching every other Advertising financial table.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_settlement_status') then
    create type ad_settlement_status as enum ('verified');
  end if;
end$$;

-- ── ad_provider_settlements ── confirmed provider money receipt only ──
-- One row per confirmed charge. Never created for a declined/timeout/
-- failed charge attempt -- those simply never produce a row here. This
-- is deliberately NOT a payment-attempt lifecycle table (no 'pending'/
-- 'failed' rows) since the current scope only needs final verified
-- settlement authority, per the binding remediation brief.
create table if not exists public.ad_provider_settlements (
  id                  uuid primary key default gen_random_uuid(),
  advertiser_id       uuid not null references public.ad_advertisers(id),
  provider            text not null,
  provider_reference  text not null,
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null default 'ZAR',
  status              ad_settlement_status not null default 'verified',
  verified_at         timestamptz not null default now(),
  is_test             boolean not null default false,
  created_at          timestamptz not null default now(),
  -- One external payment reference can never be recorded twice, from any
  -- provider or any advertiser -- the structural guarantee that a single
  -- real charge cannot be turned into two settlements.
  constraint ad_provider_settlements_reference_unique unique (provider, provider_reference)
);

create index if not exists ad_provider_settlements_advertiser_idx on public.ad_provider_settlements(advertiser_id);

alter table public.ad_provider_settlements enable row level security;

create policy "ad_provider_settlements: owner read"
  on public.ad_provider_settlements for select
  using (exists (select 1 from public.ad_advertisers a where a.id = ad_provider_settlements.advertiser_id and a.owner_profile_id = auth.uid()));

create policy "ad_provider_settlements: admin read"
  on public.ad_provider_settlements for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No insert/update/delete policy for any client role -- trusted
-- server/service-role authority only, via record_ad_provider_settlement()
-- below. A settlement representing confirmed receipt is never casually
-- editable or deletable.
drop trigger if exists ad_provider_settlements_immutable on public.ad_provider_settlements;
create trigger ad_provider_settlements_immutable
  before update or delete on public.ad_provider_settlements
  for each row execute procedure public.prevent_row_mutation();

-- ── ad_campaign_funding: link to the settlement it actually consumed ──
-- Nullable and additive -- existing 'balance'-funded rows and every
-- historical 'provider'-funded row stay exactly as they are, with
-- settlement_id NULL. Those historical rows are never backfilled with an
-- invented settlement (their provenance from before this migration is not
-- independently provable) and remain permanently identifiable as legacy;
-- the hardened fund_ad_campaign() below refuses to accept them as
-- authority for any NEW funding going forward.
alter table public.ad_campaign_funding add column if not exists settlement_id uuid references public.ad_provider_settlements(id);

-- Structural (DB-level, not just application-level) guarantee that one
-- verified settlement can fund at most one campaign, ever.
create unique index if not exists ad_campaign_funding_settlement_unique on public.ad_campaign_funding(settlement_id) where settlement_id is not null;

-- ── record_ad_provider_settlement ── the ONLY way a verified settlement
-- can come into existence. Trusted server code calls this immediately
-- after (and only after) a real provider.charge()/mock charge reports
-- success -- never reachable from client input, never reachable from a
-- declined/timeout/failed charge result.
create or replace function public.record_ad_provider_settlement(
  p_advertiser_id uuid,
  p_provider text,
  p_provider_reference text,
  p_amount_cents integer,
  p_currency text,
  p_is_test boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_settlement public.ad_provider_settlements;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id;
  if not found then
    raise exception 'advertiser not found';
  end if;

  if p_provider is null or char_length(trim(p_provider)) = 0 then
    raise exception 'provider is required';
  end if;
  if p_provider_reference is null or char_length(trim(p_provider_reference)) = 0 then
    raise exception 'provider reference is required';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_cents must be a positive integer';
  end if;
  if p_currency is null or char_length(trim(p_currency)) = 0 then
    raise exception 'currency is required';
  end if;

  if exists (select 1 from public.ad_provider_settlements where provider = p_provider and provider_reference = p_provider_reference) then
    raise exception 'this provider reference has already been recorded as a settlement';
  end if;

  insert into public.ad_provider_settlements (advertiser_id, provider, provider_reference, amount_cents, currency, is_test)
  values (p_advertiser_id, p_provider, p_provider_reference, p_amount_cents, p_currency, p_is_test)
  returning * into v_settlement;

  return to_jsonb(v_settlement);
end;
$$;

revoke all on function public.record_ad_provider_settlement(uuid, text, text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.record_ad_provider_settlement(uuid, text, text, integer, text, boolean) to service_role;

-- ── fund_ad_campaign ── hardened. This is a genuine signature change
-- (p_provider_reference text -> p_settlement_id uuid), not a widening --
-- the entire point is that a bare client/caller-supplied string can never
-- again be treated as proof of payment, so the old parameter shape must
-- not remain reachable. Explicit DROP + CREATE (never a bare CREATE OR
-- REPLACE across a signature change) to avoid leaving an ambiguous
-- second overload reachable via PostgREST, matching this codebase's own
-- established Round-6 guardrail for signature changes.
drop function if exists public.fund_ad_campaign(uuid, uuid, ad_funding_source, text, text);

create function public.fund_ad_campaign(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_funding_source ad_funding_source,
  p_settlement_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_advertiser public.ad_advertisers;
  v_package public.ad_packages;
  v_account public.ad_balance_accounts;
  v_settlement public.ad_provider_settlements;
  v_new_balance integer;
  v_new_status ad_campaign_status;
  v_provider_reference text;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id for update;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_advertiser.status in ('suspended', 'rejected') then
    raise exception 'advertiser account is not eligible to fund campaigns (status: %)', v_advertiser.status;
  end if;
  if v_campaign.status <> 'draft' then
    raise exception 'campaign is not in draft status (current: %)', v_campaign.status;
  end if;

  v_request_hash := md5(coalesce(p_campaign_id::text,'') || '|' || coalesce(p_funding_source::text,'') || '|' || coalesce(p_settlement_id::text,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_profile_id and operation = 'fund_ad_campaign' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Re-fetch and lock the package -- this IS the binding commercial
  -- snapshot point. An admin editing/deactivating the catalogue row
  -- after this moment can never rewrite this campaign's economics.
  select * into v_package from public.ad_packages where id = v_campaign.package_id for update;
  if not found or not v_package.is_active then
    raise exception 'package is no longer available for funding';
  end if;

  if p_funding_source = 'balance' then
    -- Unchanged from the pre-hardening version -- balance funding never
    -- touches a provider settlement at all.
    select * into v_account from public.ad_balance_accounts where advertiser_id = v_advertiser.id for update;
    if v_account.balance_cents < v_package.price_cents then
      raise exception 'insufficient advertising balance';
    end if;
    v_new_balance := v_account.balance_cents - v_package.price_cents;

    update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;

    insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, idempotency_key)
    values (v_account.id, p_campaign_id, 'campaign_purchase_debit', -v_package.price_cents, v_new_balance, 'advertiser', p_actor_profile_id, p_idempotency_key);
  else
    -- Provider funding now requires a matching VERIFIED settlement --
    -- never a bare reference string. Every one of these checks is the
    -- direct closure of the proven gap: a fabricated reference (no
    -- matching row), another advertiser's real settlement, a wrong
    -- amount, a wrong currency, an unverified/non-final status, or a
    -- settlement already consumed by another campaign all fail here.
    if p_settlement_id is null then
      raise exception 'a verified provider settlement is required to fund via provider';
    end if;

    select * into v_settlement from public.ad_provider_settlements where id = p_settlement_id for update;
    if not found then
      raise exception 'settlement not found';
    end if;
    if v_settlement.advertiser_id <> v_advertiser.id then
      raise exception 'settlement does not belong to this advertiser';
    end if;
    if v_settlement.status <> 'verified' then
      raise exception 'settlement is not in a verified state';
    end if;
    if v_settlement.amount_cents <> v_package.price_cents then
      raise exception 'settlement amount does not match the campaign''s authoritative price';
    end if;
    if v_settlement.currency <> v_package.currency then
      raise exception 'settlement currency does not match the campaign''s authoritative currency';
    end if;
    if v_settlement.is_test <> v_campaign.is_test then
      raise exception 'settlement test/live status does not match the campaign';
    end if;
    if exists (select 1 from public.ad_campaign_funding where settlement_id = p_settlement_id) then
      raise exception 'this settlement has already been consumed by another campaign';
    end if;

    v_provider_reference := v_settlement.provider_reference;
  end if;

  insert into public.ad_campaign_funding (campaign_id, funding_source, amount_cents, provider_reference, settlement_id)
  values (p_campaign_id, p_funding_source, v_package.price_cents, v_provider_reference, p_settlement_id);

  -- Re-snapshot from the (locked, current) package row -- the
  -- authoritative economic snapshot.
  v_new_status := case when v_advertiser.advertiser_type = 'unity' then 'active' else 'pending_review' end;

  if v_new_status = 'active' and not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve -- cannot auto-activate';
  end if;

  update public.ad_campaigns set
    status = v_new_status,
    snapshot_placement_type = v_package.placement_type,
    snapshot_placement_tier = v_package.placement_tier,
    snapshot_position_band = v_package.position_band,
    snapshot_price_cents = v_package.price_cents,
    snapshot_currency = v_package.currency,
    snapshot_impression_quota = v_package.impression_quota,
    snapshot_commercial_version = v_package.commercial_version,
    funded_amount_cents = v_package.price_cents,
    activated_at = case when v_new_status = 'active' then now() else activated_at end,
    updated_at = now()
  where id = p_campaign_id
  returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (p_campaign_id, 'advertiser', p_actor_profile_id, 'funded', 'draft', v_new_status);

  v_result := to_jsonb(v_campaign);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_profile_id, 'fund_ad_campaign', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text) from public, anon, authenticated;
grant execute on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text) to service_role;
