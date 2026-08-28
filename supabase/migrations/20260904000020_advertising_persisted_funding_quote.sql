-- Advertising MVP -- eliminate the price/plan race across the external
-- payment boundary.
--
-- PROVEN GAP: the previous provider flow (20260904000018) computed an
-- ephemeral quote in the route, charged the provider, then had
-- fund_ad_campaign() independently RE-RESOLVE current package price +
-- current effective plan and reject if they no longer matched the
-- settlement. With a real provider this is unsafe: the external charge
-- is irreversible the moment it succeeds, but a package-price or
-- subscription-plan change in the window between charging and
-- fund_ad_campaign() could still cause a rejection -- money moved,
-- campaign never funded. "Fail closed" is the right behavior against a
-- FABRICATED or MISMATCHED settlement; it is not an acceptable response
-- to a genuine, already-successful charge.
--
-- FIX: introduce a PERSISTED, server-authoritative funding quote
-- (ad_campaign_funding_quotes). Once created, its base price, discount
-- bps/cents, amount due, and currency are frozen -- a later package or
-- plan change can never alter an already-created quote. The provider is
-- charged the quote's exact frozen amount; the resulting settlement is
-- bound to that exact quote (not just to a generic amount); and
-- fund_ad_campaign() consumes the quote's frozen values directly rather
-- than re-deriving pricing from current package/plan state. A brand new
-- funding attempt (a brand new quote) always sees current authority --
-- only an ALREADY-STARTED attempt is protected from being re-priced out
-- from under itself.
--
-- Retry safety (Step 9): create_ad_campaign_funding_quote() reuses an
-- existing open (unconsumed, unexpired) quote for the same campaign
-- instead of minting a new one on every call, and the funding route
-- (updated alongside this migration) checks for an already-recorded
-- verified settlement before ever calling the provider again. Together
-- this means a retried funding attempt -- whether the retry is a fresh
-- quote lookup, a fresh settlement lookup, or a fresh fund_ad_campaign
-- call under the existing idempotency_key cache -- never requires a
-- second external charge for the same logical attempt.
--
-- Historical data: this migration inserts no rows into any existing
-- table and updates no existing row. Every already-funded campaign is
-- untouched. The new quote authority applies only to funding attempts
-- that begin after this migration is applied.

-- ── ad_campaign_funding_quotes ── frozen, single-use funding authority ──
create table if not exists public.ad_campaign_funding_quotes (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references public.ad_campaigns(id),
  advertiser_id         uuid not null references public.ad_advertisers(id),
  package_id            uuid not null references public.ad_packages(id),
  base_price_cents      integer not null check (base_price_cents >= 0),
  discount_bps          integer not null check (discount_bps between 0 and 10000),
  discount_cents        integer not null check (discount_cents >= 0),
  amount_due_cents      integer not null check (amount_due_cents >= 0),
  currency              text not null,
  subscription_plan_id  text references public.merchant_subscription_plans(id),
  is_test               boolean not null default false,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  -- Set exactly once, by fund_ad_campaign(), the moment this quote is
  -- actually consumed to fund a campaign. NULL means still open
  -- (usable) or abandoned (never charged) -- both are indistinguishable
  -- from this column alone, and that is fine: an abandoned quote simply
  -- expires and is never touched again.
  consumed_at           timestamptz
);

create index if not exists ad_campaign_funding_quotes_campaign_idx on public.ad_campaign_funding_quotes(campaign_id);
-- Fast lookup for the "reuse an open quote" retry-safety path.
create index if not exists ad_campaign_funding_quotes_open_idx on public.ad_campaign_funding_quotes(campaign_id, expires_at) where consumed_at is null;

alter table public.ad_campaign_funding_quotes enable row level security;

create policy "ad_campaign_funding_quotes: owner read"
  on public.ad_campaign_funding_quotes for select
  using (exists (select 1 from public.ad_advertisers a where a.id = ad_campaign_funding_quotes.advertiser_id and a.owner_profile_id = auth.uid()));

create policy "ad_campaign_funding_quotes: admin read"
  on public.ad_campaign_funding_quotes for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No insert/update/delete policy for any client role -- trusted
-- server/service-role authority only, via create_ad_campaign_funding_quote()
-- and fund_ad_campaign() (which sets consumed_at). A quote's financial
-- fields are never updated after creation by any code path -- only
-- consumed_at is ever written post-insert, and only once (NULL -> a
-- timestamp, never changed again, never reverted). This codebase's
-- existing prevent_row_mutation() blocks ALL updates unconditionally,
-- which would make consumed_at unsettable -- this table needs its own
-- narrow trigger instead of that shared one.
create or replace function public._ad_campaign_funding_quotes_guard()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'ad_campaign_funding_quotes records are immutable and cannot be deleted';
  end if;
  if OLD.campaign_id is distinct from NEW.campaign_id
    or OLD.advertiser_id is distinct from NEW.advertiser_id
    or OLD.package_id is distinct from NEW.package_id
    or OLD.base_price_cents is distinct from NEW.base_price_cents
    or OLD.discount_bps is distinct from NEW.discount_bps
    or OLD.discount_cents is distinct from NEW.discount_cents
    or OLD.amount_due_cents is distinct from NEW.amount_due_cents
    or OLD.currency is distinct from NEW.currency
    or OLD.subscription_plan_id is distinct from NEW.subscription_plan_id
    or OLD.is_test is distinct from NEW.is_test
    or OLD.created_at is distinct from NEW.created_at
    or OLD.expires_at is distinct from NEW.expires_at
  then
    raise exception 'ad_campaign_funding_quotes financial/identity fields are immutable after creation';
  end if;
  if OLD.consumed_at is not null and NEW.consumed_at is distinct from OLD.consumed_at then
    raise exception 'ad_campaign_funding_quotes.consumed_at can only be set once';
  end if;
  return NEW;
end;
$$;

drop trigger if exists ad_campaign_funding_quotes_guard on public.ad_campaign_funding_quotes;
create trigger ad_campaign_funding_quotes_guard
  before update or delete on public.ad_campaign_funding_quotes
  for each row execute procedure public._ad_campaign_funding_quotes_guard();

-- ── ad_provider_settlements: bind a settlement to the exact quote it
-- was charged for ── additive, nullable (historical settlements from
-- before this migration, and any future non-quote-bound settlement,
-- simply have quote_id NULL).
alter table public.ad_provider_settlements add column if not exists quote_id uuid references public.ad_campaign_funding_quotes(id);
create unique index if not exists ad_provider_settlements_quote_unique on public.ad_provider_settlements(quote_id) where quote_id is not null;

-- ── ad_campaign_funding: record which quote (if any) was consumed ──
-- additive, nullable -- balance-funded rows and any historical
-- provider-funded row never had a quote and stay NULL forever.
alter table public.ad_campaign_funding add column if not exists quote_id uuid references public.ad_campaign_funding_quotes(id);
create unique index if not exists ad_campaign_funding_quote_unique on public.ad_campaign_funding(quote_id) where quote_id is not null;

-- ── create_ad_campaign_funding_quote ── the ONLY way a persisted,
-- authoritative quote can come into existence. Reuses an existing open
-- quote for the same campaign when one exists (retry-safety -- a route
-- retry never mints a second quote, and therefore never risks a second
-- external charge), otherwise computes fresh from the current package
-- price and current effective plan via the same _ad_resolve_discount()
-- formula every other pricing path already uses.
create or replace function public.create_ad_campaign_funding_quote(p_actor_profile_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_advertiser public.ad_advertisers;
  v_package public.ad_packages;
  v_discount record;
  v_quote public.ad_campaign_funding_quotes;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;
  if not found then
    raise exception 'campaign not found';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_campaign.status <> 'draft' then
    raise exception 'campaign is not in draft status (current: %)', v_campaign.status;
  end if;

  select * into v_quote from public.ad_campaign_funding_quotes
    where campaign_id = p_campaign_id and consumed_at is null and expires_at > now()
    order by created_at desc limit 1;
  if found then
    return jsonb_build_object(
      'quote_id', v_quote.id, 'campaign_id', v_quote.campaign_id,
      'base_price_cents', v_quote.base_price_cents, 'currency', v_quote.currency,
      'plan_id', v_quote.subscription_plan_id, 'discount_bps', v_quote.discount_bps,
      'discount_cents', v_quote.discount_cents, 'amount_due_cents', v_quote.amount_due_cents,
      'is_test', v_quote.is_test, 'expires_at', v_quote.expires_at
    );
  end if;

  select * into v_package from public.ad_packages where id = v_campaign.package_id;
  if not found then
    raise exception 'package not found';
  end if;
  if not v_package.is_active then
    raise exception 'package is no longer available for funding';
  end if;

  select * into v_discount from public._ad_resolve_discount(v_package.price_cents, v_advertiser.owner_profile_id);

  insert into public.ad_campaign_funding_quotes (
    campaign_id, advertiser_id, package_id, base_price_cents, discount_bps, discount_cents,
    amount_due_cents, currency, subscription_plan_id, is_test, expires_at
  ) values (
    p_campaign_id, v_advertiser.id, v_package.id, v_package.price_cents, v_discount.discount_bps, v_discount.discount_cents,
    v_discount.final_amount_cents, v_package.currency, v_discount.plan_id, v_campaign.is_test, now() + interval '15 minutes'
  ) returning * into v_quote;

  return jsonb_build_object(
    'quote_id', v_quote.id, 'campaign_id', v_quote.campaign_id,
    'base_price_cents', v_quote.base_price_cents, 'currency', v_quote.currency,
    'plan_id', v_quote.subscription_plan_id, 'discount_bps', v_quote.discount_bps,
    'discount_cents', v_quote.discount_cents, 'amount_due_cents', v_quote.amount_due_cents,
    'is_test', v_quote.is_test, 'expires_at', v_quote.expires_at
  );
end;
$$;

revoke all on function public.create_ad_campaign_funding_quote(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_ad_campaign_funding_quote(uuid, uuid) to service_role;

-- ── record_ad_provider_settlement ── widened with an OPTIONAL trailing
-- p_quote_id, appended with a default -- the existing parameter list
-- (types and order) is unchanged, so this remains a safe CREATE OR
-- REPLACE (no DROP needed), matching this codebase's own established
-- distinction between appending a defaulted parameter and genuinely
-- changing an existing one. When a quote is supplied, the settlement is
-- validated against and permanently bound to that exact quote -- the
-- direct closure of "settlement corresponds to the authoritative quote
-- it was charged for." Expiry is checked HERE (before a settlement can
-- ever be created) specifically so an already-expired, never-charged
-- quote can never retroactively acquire a settlement -- but once a
-- settlement legitimately exists, fund_ad_campaign() below never
-- re-checks expiry, so a genuinely successful charge is never stranded
-- by a slow retry landing after the nominal window.
create or replace function public.record_ad_provider_settlement(
  p_advertiser_id uuid,
  p_provider text,
  p_provider_reference text,
  p_amount_cents integer,
  p_currency text,
  p_is_test boolean default false,
  p_quote_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_quote public.ad_campaign_funding_quotes;
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

  if p_quote_id is not null then
    select * into v_quote from public.ad_campaign_funding_quotes where id = p_quote_id for update;
    if not found then
      raise exception 'funding quote not found';
    end if;
    if v_quote.advertiser_id <> p_advertiser_id then
      raise exception 'funding quote does not belong to this advertiser';
    end if;
    if v_quote.consumed_at is not null then
      raise exception 'funding quote has already been consumed';
    end if;
    if now() >= v_quote.expires_at then
      raise exception 'funding quote has expired';
    end if;
    if v_quote.amount_due_cents <> p_amount_cents then
      raise exception 'settlement amount does not match the funding quote';
    end if;
    if v_quote.currency <> p_currency then
      raise exception 'settlement currency does not match the funding quote';
    end if;
    if v_quote.is_test <> p_is_test then
      raise exception 'settlement test/live status does not match the funding quote';
    end if;
    if exists (select 1 from public.ad_provider_settlements where quote_id = p_quote_id) then
      raise exception 'a settlement has already been recorded for this funding quote';
    end if;
  end if;

  insert into public.ad_provider_settlements (advertiser_id, provider, provider_reference, amount_cents, currency, is_test, quote_id)
  values (p_advertiser_id, p_provider, p_provider_reference, p_amount_cents, p_currency, p_is_test, p_quote_id)
  returning * into v_settlement;

  return to_jsonb(v_settlement);
end;
$$;

revoke all on function public.record_ad_provider_settlement(uuid, text, text, integer, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.record_ad_provider_settlement(uuid, text, text, integer, text, boolean, uuid) to service_role;

-- ── fund_ad_campaign ── widened with an OPTIONAL trailing p_quote_id,
-- appended with a default -- safe CREATE OR REPLACE, same reasoning as
-- above. Balance funding is UNCHANGED (still resolves current package +
-- current effective plan atomically, in the same locked transaction --
-- no external race exists for balance funding, so no quote is required
-- or accepted). Provider funding now REQUIRES a quote, consumes its
-- frozen values directly, and never re-derives pricing from current
-- package/plan state -- the exact fix for the proven race. True
-- superset of the live body immediately preceding this migration
-- (20260904000018, the only migration that has touched this function
-- since the settlement-authority hardening): every existing check
-- (ownership, advertiser status, draft-only, idempotency, package
-- lock/active, settlement authority checks, single-consumption,
-- live-eligibility gate) is preserved; the provider branch's pricing
-- source changes from a fresh _ad_resolve_discount() call to the locked,
-- consumed quote's own frozen columns.
create or replace function public.fund_ad_campaign(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_funding_source ad_funding_source,
  p_settlement_id uuid default null,
  p_idempotency_key text default null,
  p_quote_id uuid default null
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
  v_quote public.ad_campaign_funding_quotes;
  v_discount record;
  v_base_price_cents integer;
  v_discount_bps integer;
  v_discount_cents integer;
  v_final_amount_cents integer;
  v_plan_id text;
  v_currency text;
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

  v_request_hash := md5(coalesce(p_campaign_id::text,'') || '|' || coalesce(p_funding_source::text,'') || '|' || coalesce(p_settlement_id::text,'') || '|' || coalesce(p_quote_id::text,''));
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

  select * into v_package from public.ad_packages where id = v_campaign.package_id for update;
  if not found or not v_package.is_active then
    raise exception 'package is no longer available for funding';
  end if;

  if p_funding_source = 'balance' then
    -- Unchanged: no external race exists for balance funding, so it
    -- safely resolves current package + current effective plan
    -- atomically, in this same locked transaction, exactly as
    -- 20260904000018 already established. A quote is neither required
    -- nor accepted here -- it exists solely to protect the external
    -- payment boundary.
    if p_quote_id is not null then
      raise exception 'a funding quote is not used for balance funding';
    end if;
    select * into v_discount from public._ad_resolve_discount(v_package.price_cents, v_advertiser.owner_profile_id);
    v_base_price_cents := v_package.price_cents;
    v_discount_bps := v_discount.discount_bps;
    v_discount_cents := v_discount.discount_cents;
    v_final_amount_cents := v_discount.final_amount_cents;
    v_plan_id := v_discount.plan_id;
    v_currency := v_package.currency;

    select * into v_account from public.ad_balance_accounts where advertiser_id = v_advertiser.id for update;
    if v_account.balance_cents < v_final_amount_cents then
      raise exception 'insufficient advertising balance';
    end if;
    v_new_balance := v_account.balance_cents - v_final_amount_cents;

    update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;

    insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, idempotency_key)
    values (v_account.id, p_campaign_id, 'campaign_purchase_debit', -v_final_amount_cents, v_new_balance, 'advertiser', p_actor_profile_id, p_idempotency_key);
  else
    -- Provider funding: consume the FROZEN quote -- never re-derive
    -- pricing from current package/plan state. This is the direct fix
    -- for the proven race: nothing here can disagree with what the
    -- provider was actually charged, because nothing here recomputes
    -- anything -- it only validates that the settlement corresponds to
    -- this exact quote and reads the quote's own frozen columns.
    if p_quote_id is null then
      raise exception 'a funding quote is required to fund via provider';
    end if;
    select * into v_quote from public.ad_campaign_funding_quotes where id = p_quote_id for update;
    if not found then
      raise exception 'funding quote not found';
    end if;
    if v_quote.campaign_id <> p_campaign_id then
      raise exception 'funding quote does not belong to this campaign';
    end if;
    if v_quote.advertiser_id <> v_advertiser.id then
      raise exception 'funding quote does not belong to this advertiser';
    end if;
    if v_quote.is_test <> v_campaign.is_test then
      raise exception 'funding quote test/live status does not match the campaign';
    end if;
    if v_quote.consumed_at is not null then
      raise exception 'funding quote has already been consumed';
    end if;

    if p_settlement_id is null then
      raise exception 'a verified provider settlement is required to fund via provider';
    end if;
    select * into v_settlement from public.ad_provider_settlements where id = p_settlement_id for update;
    if not found then
      raise exception 'settlement not found';
    end if;
    if v_settlement.quote_id is distinct from p_quote_id then
      raise exception 'settlement does not correspond to this funding quote';
    end if;
    if v_settlement.advertiser_id <> v_advertiser.id then
      raise exception 'settlement does not belong to this advertiser';
    end if;
    if v_settlement.status <> 'verified' then
      raise exception 'settlement is not in a verified state';
    end if;
    if v_settlement.amount_cents <> v_quote.amount_due_cents then
      raise exception 'settlement amount does not match the funding quote';
    end if;
    if v_settlement.currency <> v_quote.currency then
      raise exception 'settlement currency does not match the funding quote';
    end if;
    if v_settlement.is_test <> v_campaign.is_test then
      raise exception 'settlement test/live status does not match the campaign';
    end if;
    if exists (select 1 from public.ad_campaign_funding where settlement_id = p_settlement_id) then
      raise exception 'this settlement has already been consumed by another campaign';
    end if;
    if exists (select 1 from public.ad_campaign_funding where quote_id = p_quote_id) then
      raise exception 'this funding quote has already been consumed by another campaign';
    end if;

    update public.ad_campaign_funding_quotes set consumed_at = now() where id = p_quote_id;

    v_provider_reference := v_settlement.provider_reference;
    v_base_price_cents := v_quote.base_price_cents;
    v_discount_bps := v_quote.discount_bps;
    v_discount_cents := v_quote.discount_cents;
    v_final_amount_cents := v_quote.amount_due_cents;
    v_plan_id := v_quote.subscription_plan_id;
    v_currency := v_quote.currency;
  end if;

  insert into public.ad_campaign_funding (campaign_id, funding_source, amount_cents, provider_reference, settlement_id, quote_id)
  values (p_campaign_id, p_funding_source, v_final_amount_cents, v_provider_reference, p_settlement_id, p_quote_id);

  v_new_status := case when v_advertiser.advertiser_type = 'unity' then 'active' else 'pending_review' end;

  if v_new_status = 'active' and not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve -- cannot auto-activate';
  end if;

  -- Final authoritative funding snapshot. Financial fields come from
  -- v_base_price_cents/v_discount_bps/v_discount_cents/v_final_amount_cents
  -- (the FROZEN quote for provider funding, or the just-resolved current
  -- state for balance funding) -- never re-read from v_package/plan
  -- again after this point, for either funding source.
  update public.ad_campaigns set
    status = v_new_status,
    snapshot_placement_type = v_package.placement_type,
    snapshot_placement_tier = v_package.placement_tier,
    snapshot_position_band = v_package.position_band,
    snapshot_price_cents = v_final_amount_cents,
    snapshot_currency = v_currency,
    snapshot_impression_quota = v_package.impression_quota,
    snapshot_commercial_version = v_package.commercial_version,
    snapshot_base_price_cents = v_base_price_cents,
    snapshot_discount_bps = v_discount_bps,
    snapshot_discount_cents = v_discount_cents,
    snapshot_subscription_plan_id = v_plan_id,
    funded_amount_cents = v_final_amount_cents,
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

revoke all on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text, uuid) to service_role;
