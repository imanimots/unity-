-- ============================================================
-- E33 -- Peach payout execution, async reconciliation & destination
-- snapshot binding
-- ============================================================
-- Builds the real provider-execution layer for merchant payouts and
-- affiliate commission payouts. Production remains fail-closed:
-- PAYMENT_PROVIDER stays absent, and a NEW, separately-controlled
-- PEACH_PAYOUTS_EXECUTION_ENABLED gate (enforced in TypeScript, see
-- src/lib/payments/payout-execution/gate.ts) must independently be
-- "true" before any execution code path runs -- PAYMENT_PROVIDER=peach
-- alone must never auto-enable payouts, since Peach already serves
-- charges/deposits under that same env var.
--
-- CRITICAL LIVE-DOCS FINDING #1 (fixed here): the Peach Payouts OAuth
-- token endpoint lives on a SEPARATE host (dashboard.peachpayments.com
-- / sandbox-dashboard.peachpayments.com) from the Payouts API host
-- (payouts.peachpayments.com / sandbox-payouts.peachpayments.com).
-- E32's PeachPayoutsClient posted the token request to the Payouts
-- host -- a real bug, fixed in src/lib/payments/providers/peach/
-- banv-client.ts and payouts-config.ts this phase, not just documented.
--
-- CRITICAL LIVE-DOCS FINDING #2 (fixed here): Peach's `bankName` enum
-- for a real realtime-eft create-payout call (25 literal values, e.g.
-- "FNB", "TYMEBANK", "YWBN MUTUAL BANK") does not match E32's
-- payout_banks.display_name strings, and 3 of E32's
-- payout_supported=true banks (Mukuru, Mercantile Bank, Rand Merchant
-- Bank) are ABSENT from this literal enum entirely -- confirmed via
-- the live createpayoutrequest API reference, a different and more
-- authoritative source than the general "supported banks" docs page
-- E32's seed data was built from. Fixed additively: a new nullable
-- payout_banks.peach_payout_bank_name column, populated only for the
-- confirmed 22 matches (finbond_net1 already payout_supported=false,
-- unaffected). E33's submission path requires this column non-null --
-- layered on top of, not replacing, E32's existing payout_supported
-- flag.
--
-- RECIPIENT/DESTINATION MODEL: unchanged from E32. Every provider
-- attempt binds an immutable payout_destinations.id snapshot at
-- creation time (payout_provider_attempts.payout_destination_id) --
-- never re-resolved later, so a subsequent bank-detail change can
-- never redirect an in-flight payout.
--
-- CURRENCY AUTHORITY: merchant_payouts has NO currency column
-- (confirmed by audit -- the only immutable source is the ledger_entries
-- row create_merchant_payout() writes at creation time, linked via
-- ledger_entries.payout_id, currency hardcoded 'ZAR' there). Every new
-- merchant-side RPC below requires that row to exist with currency =
-- 'ZAR', failing closed otherwise. affiliate_commissions.currency
-- already exists as a real column and is checked directly.
--
-- PROVIDER ATTEMPT MODEL: one unified table, payout_provider_attempts,
-- with a domain-FK CHECK (exactly one of merchant_payout_id/
-- affiliate_commission_id non-null) rather than a polymorphic
-- (entity_type, entity_id) pair. "At most one nonterminal attempt per
-- domain row" is enforced the same way payout_destinations enforces
-- "at most one current destination per owner" -- a real partial unique
-- index, not application discipline (see payout_destinations_one_
-- current_per_owner_idx precedent, 20261111184936).
--
-- STATE APPLICATION: a single shared "apply provider truth" RPC per
-- domain (complete_merchant_payout_provider_attempt /
-- complete_affiliate_payout_provider_attempt) is called from THREE
-- places identically -- immediately after the create-payout HTTP
-- response, from the payout-status webhook, and from query
-- reconciliation -- so there is exactly one authority for what a given
-- Peach status means for the domain row, never three divergent
-- implementations. Idempotent, monotonic on provider_last_updated_at
-- (an older update can never regress a newer one), and never mutates
-- the domain row for a superseded/non-active attempt.
--
-- DOMAIN STATUS: payout_status gains 'reversed' (ALTER TYPE ADD VALUE
-- -- safe in this same migration file because the new value is only
-- ever referenced inside function bodies below, never in a top-level
-- DML statement in this same transaction). affiliate_commission_status
-- already has 'reversed' (confirmed by audit, Phase 7) -- no enum
-- change needed there. The existing, generic _merchant_payout_
-- transition()/_affiliate_commission_transition() helpers need zero
-- changes themselves (both already take the new-status value as a
-- plain parameter) -- only new top-level RPCs call them with the
-- right arguments.
--
-- MANUAL-FLOW CONFLICT GUARD: mark_payout_paid/mark_payout_failed/
-- retry_payout are widened (CREATE OR REPLACE, bodies otherwise
-- byte-identical) to refuse outright if a nonterminal provider attempt
-- already exists for the payout -- manual admin action must never
-- silently override live provider authority. This is the one
-- deliberate exception to "do not alter unrelated historical
-- functions": E33's own brief explicitly requires this guard (unlike
-- E32-R1's auth.role() cleanup, which was scoped to functions E32
-- itself introduced).
--
-- SECURITY: every new function here follows the post-E32-R1 idiom --
-- SECURITY DEFINER, search_path = '', REVOKE ALL FROM
-- public/anon/authenticated, GRANT EXECUTE TO service_role only, NO
-- auth.role() caller guard (the grant/revoke pair is the sole privilege
-- boundary). payout_provider_attempts gets RLS enabled, an explicit
-- deny-all policy, and explicit client revokes -- unlike
-- payout_destinations, it has NO owner-read policy at all (this is
-- operational financial-execution authority, read only through
-- server/admin APIs, not general product data).
-- ============================================================

-- ------------------------------------------------------------
-- payout_status: add 'reversed'. affiliate_commission_status already
-- has it (Phase 7) -- confirmed, not re-added.
-- ------------------------------------------------------------
alter type public.payout_status add value if not exists 'reversed';

-- merchant_payouts.payout_method's existing CHECK only allowed
-- ('manual', 'mock_validation') -- both admin-attested values. A
-- provider-executed payout needs its own distinct value so it is
-- never confused with either; merchant_payouts.provider_reference
-- holds Unity's own provider_payout_id (not Peach's provider_request_id,
-- which lives only on payout_provider_attempts -- see that table's
-- own comment for why the two are never conflated) for a 'peach'-method
-- row. Widening only -- every existing row's value remains valid.
alter table public.merchant_payouts drop constraint if exists merchant_payouts_payout_method_check;
alter table public.merchant_payouts add constraint merchant_payouts_payout_method_check
  check (payout_method is null or payout_method in ('manual', 'mock_validation', 'peach'));

-- ------------------------------------------------------------
-- payout_banks: additive, stricter, submission-ready bank-name mapping
-- (see CRITICAL LIVE-DOCS FINDING #2 above). NULL for every bank this
-- literal enum does not contain.
-- ------------------------------------------------------------
alter table public.payout_banks add column if not exists peach_payout_bank_name text;

update public.payout_banks set peach_payout_bank_name = v.bank_name
from (values
  ('absa', 'ABSA'),
  ('access_bank', 'ACCESS BANK'),
  ('african_bank', 'AFRICAN BANK'),
  ('african_bank_business', 'AFRICAN BANK BUSINESS'),
  ('albaraka_bank', 'ALBARAKA BANK'),
  ('bank_zero_mukuru', 'BANK ZERO - MUKURU'),
  ('bank_zero_mutual', 'BANK ZERO MUTUAL BANK'),
  ('bidvest_bank', 'BIDVEST BANK'),
  ('bidvest_bank_alliances', 'BIDVEST BANK ALLIANCES'),
  ('capitec_bank', 'CAPITEC BANK'),
  ('capitec_business', 'CAPITEC BUSINESS'),
  ('discovery_bank', 'DISCOVERY BANK'),
  ('enl_mutual_bank', 'YWBN MUTUAL BANK'),
  ('finbond_epe', 'FINBOND EPE'),
  ('finbond_mutual_bank', 'FINBOND MUTUAL BANK'),
  ('fnb', 'FNB'),
  ('gotyme_bank', 'TYMEBANK'),
  ('hbz_bank', 'HBZ BANK LIMITED'),
  ('investec_bank', 'INVESTEC BANK LIMITED'),
  ('nedbank', 'NEDBANK'),
  ('old_mutual_bank', 'OLD MUTUAL BANK'),
  ('sasfin_bank', 'SASFIN BANK'),
  ('standard_bank', 'STANDARD BANK'),
  ('standard_chartered_bank_sa', 'STANDARD CHARTERED BANK SA'),
  ('ubank', 'UBANK LTD')
) as v(bank_code, bank_name)
where public.payout_banks.bank_code = v.bank_code;
-- Deliberately NOT updated (stay NULL): finbond_net1 (already
-- payout_supported=false), mukuru, mercantile_bank, rand_merchant_bank
-- (payout_supported=true from E32's general-docs-page seed, but absent
-- from this literal, more authoritative bankName enum -- cannot
-- actually be submitted to a real create-payout call).

-- ============================================================
-- PAYOUT_PROVIDER_ATTEMPTS
-- ============================================================
create table if not exists public.payout_provider_attempts (
  id uuid primary key default gen_random_uuid(),
  merchant_payout_id uuid references public.merchant_payouts(id),
  affiliate_commission_id uuid references public.affiliate_commissions(id),
  payout_destination_id uuid not null references public.payout_destinations(id),
  provider text not null default 'peach',
  provider_payout_id uuid not null,
  provider_request_id uuid,
  attempt_number int not null default 1 check (attempt_number > 0),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null,
  provider_status text not null default 'pending' check (provider_status in (
    'pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'
  )),
  result_code text,
  provider_last_updated_at timestamptz,
  failure_category text check (failure_category is null or failure_category in (
    'provider_declined', 'provider_cancelled', 'provider_timeout', 'provider_unknown', 'internal_consistency_error'
  )),
  submission_started_at timestamptz not null default now(),
  submitted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_provider_attempts_one_domain_fk_chk check (
    (merchant_payout_id is not null and affiliate_commission_id is null) or
    (merchant_payout_id is null and affiliate_commission_id is not null)
  )
);

-- provider_payout_id uniqueness: Peach currently recommends it and
-- states it is becoming mandatory -- treated as mandatory now (phase
-- brief §16).
create unique index if not exists payout_provider_attempts_provider_payout_id_idx
  on public.payout_provider_attempts (provider, provider_payout_id);

-- The actual concurrency backstop for "at most one nonterminal attempt
-- per domain row" -- a unique_violation here, not application-level
-- locking, exactly mirroring payout_destinations_one_current_per_owner_idx.
create unique index if not exists payout_provider_attempts_merchant_active_idx
  on public.payout_provider_attempts (merchant_payout_id)
  where merchant_payout_id is not null and provider_status in ('pending', 'processing');

create unique index if not exists payout_provider_attempts_affiliate_active_idx
  on public.payout_provider_attempts (affiliate_commission_id)
  where affiliate_commission_id is not null and provider_status in ('pending', 'processing');

create index if not exists payout_provider_attempts_merchant_idx
  on public.payout_provider_attempts (merchant_payout_id, created_at desc) where merchant_payout_id is not null;
create index if not exists payout_provider_attempts_affiliate_idx
  on public.payout_provider_attempts (affiliate_commission_id, created_at desc) where affiliate_commission_id is not null;

alter table public.payout_provider_attempts enable row level security;

-- E32-R1 idiom: an explicit deny-all policy, not zero policies, so
-- Supabase's rls_enabled_no_policy advisor does not flag this table.
-- No owner-read policy at all, unlike payout_destinations -- this is
-- operational financial-execution authority, read only through
-- server/admin APIs (service_role), never directly by a client.
create policy "payout_provider_attempts: deny all client access"
  on public.payout_provider_attempts for all
  to public
  using (false)
  with check (false);

revoke all on public.payout_provider_attempts from public, anon, authenticated;

-- ============================================================
-- HELPERS
-- ============================================================

-- ------------------------------------------------------------
-- _merchant_payout_ledger_currency -- the one immutable currency
-- authority for a merchant payout (see header comment). Returns null
-- if no ledger row exists yet, which the calling RPC treats as a
-- fail-closed condition, never a default-to-ZAR guess.
-- ------------------------------------------------------------
create or replace function public._merchant_payout_ledger_currency(p_payout_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select currency from public.ledger_entries
  where payout_id = p_payout_id and entry_type = 'merchant_payout'
  limit 1;
$$;

revoke all on function public._merchant_payout_ledger_currency(uuid) from public, anon, authenticated;
grant execute on function public._merchant_payout_ledger_currency(uuid) to service_role;

-- ------------------------------------------------------------
-- _payout_provider_attempts_has_active -- the manual-flow conflict
-- guard primitive, reused by both domains' manual RPCs below.
-- ------------------------------------------------------------
create or replace function public._payout_provider_attempts_has_active(p_merchant_payout_id uuid, p_affiliate_commission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payout_provider_attempts
    where provider_status in ('pending', 'processing')
      and (
        (p_merchant_payout_id is not null and merchant_payout_id = p_merchant_payout_id)
        or (p_affiliate_commission_id is not null and affiliate_commission_id = p_affiliate_commission_id)
      )
  );
$$;

revoke all on function public._payout_provider_attempts_has_active(uuid, uuid) from public, anon, authenticated;
grant execute on function public._payout_provider_attempts_has_active(uuid, uuid) to service_role;

-- ============================================================
-- MERCHANT PAYOUT PROVIDER EXECUTION
-- ============================================================

-- ------------------------------------------------------------
-- START_MERCHANT_PAYOUT_PROVIDER_ATTEMPT -- atomic: re-validates
-- status/eligibility/currency/destination/bank exactly like
-- mark_payout_processing does, PLUS binds the current verified
-- destination snapshot and creates the attempt row, PLUS transitions
-- pending/failed -> processing, all in one call (closing the exact
-- two-RPC-race class this engagement's own E28-R1 phase already fixed
-- once for disputes -- never reopen it here). The provider_payout_id
-- (a genuine v4 UUID) is generated and persisted HERE, before any HTTP
-- call is ever made by the caller.
-- ------------------------------------------------------------
create or replace function public.start_merchant_payout_provider_attempt(
  p_admin_id uuid,
  p_payout_id uuid,
  p_provider text default 'peach'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout public.merchant_payouts;
  v_block text;
  v_currency text;
  v_destination_elig jsonb;
  v_destination_id uuid;
  v_bank_name text;
  v_provider_payout_id uuid := gen_random_uuid();
  v_attempt_id uuid;
  v_attempt_number int;
  v_amount_minor_units bigint;
begin
  select * into v_payout from public.merchant_payouts where id = p_payout_id for update;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status not in ('pending', 'failed') then
    raise exception 'payout is in status % and cannot start a provider attempt from here', v_payout.status;
  end if;

  v_block := public._merchant_payout_full_eligibility_block(v_payout);
  if v_block is not null then
    raise exception 'payout is not currently eligible to process: %', v_block;
  end if;

  v_currency := public._merchant_payout_ledger_currency(p_payout_id);
  if v_currency is null then
    raise exception 'no ledger currency record found for this payout -- cannot prove currency authority';
  end if;
  if v_currency <> 'ZAR' then
    raise exception 'ledger currency % is not ZAR -- real-time EFT payouts are ZAR only', v_currency;
  end if;

  v_destination_elig := public._payout_destination_eligibility(v_payout.merchant_id);
  if not (v_destination_elig ->> 'eligible')::boolean then
    raise exception 'merchant has no eligible payout destination: %', v_destination_elig ->> 'reason';
  end if;
  v_destination_id := (v_destination_elig ->> 'destination_id')::uuid;

  select pb.peach_payout_bank_name into v_bank_name
  from public.payout_destinations pd
  join public.payout_banks pb on pb.bank_code = pd.bank_code
  where pd.id = v_destination_id;
  if v_bank_name is null then
    raise exception 'destination bank has no confirmed Peach payout bankName mapping -- cannot submit a real-time EFT payout';
  end if;

  v_amount_minor_units := round(v_payout.amount * 100);
  if v_amount_minor_units < 1 or v_amount_minor_units > 500000000 then
    raise exception 'payout amount is outside Peach''s accepted range for a single real-time EFT payout';
  end if;

  if public._payout_provider_attempts_has_active(p_payout_id, null) then
    raise exception 'a provider attempt is already active for this payout';
  end if;

  select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
  from public.payout_provider_attempts where merchant_payout_id = p_payout_id;

  begin
    insert into public.payout_provider_attempts (
      merchant_payout_id, payout_destination_id, provider, provider_payout_id,
      attempt_number, amount, currency
    ) values (
      p_payout_id, v_destination_id, p_provider, v_provider_payout_id,
      v_attempt_number, v_payout.amount, v_currency
    )
    returning id into v_attempt_id;
  exception
    when unique_violation then
      raise exception 'a concurrent provider-attempt start is already in progress for this payout -- please retry';
  end;

  perform public._merchant_payout_transition(
    p_payout_id, 'processing', array['pending', 'failed']::payout_status[],
    'provider', p_admin_id, 'provider_attempt_started', 'peach payout attempt ' || v_attempt_id::text,
    null, null, null, null, true, null
  );

  return jsonb_build_object(
    'attempt_id', v_attempt_id,
    'provider_payout_id', v_provider_payout_id,
    'destination_id', v_destination_id,
    'bank_name', v_bank_name,
    'amount', v_payout.amount,
    'amount_minor_units', v_amount_minor_units,
    'currency', v_currency,
    'attempt_number', v_attempt_number
  );
end;
$$;

revoke all on function public.start_merchant_payout_provider_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_merchant_payout_provider_attempt(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- COMPLETE_MERCHANT_PAYOUT_PROVIDER_ATTEMPT -- the single shared
-- "apply provider truth" authority (phase brief §62), called
-- identically from the create-response handler, the payout webhook,
-- and query reconciliation (p_source distinguishes them for audit
-- only, never changes the transition logic itself).
--
-- Monotonic: an incoming p_provider_last_updated_at older than (or
-- equal to) the attempt's own current value is ignored outright
-- (idempotent no-op), protecting against out-of-order webhook
-- delivery. A first call (create-response) always applies, since the
-- attempt's provider_last_updated_at starts null.
--
-- Terminal-state idempotency: if the attempt is already resolved with
-- the same provider_status, this is a no-op (duplicate webhook safe).
--
-- Domain transition only happens for a TERMINAL provider_status
-- (successful/failed/cancelled/reversed) -- pending/processing only
-- update the attempt row's own metadata, never touching
-- merchant_payouts at all (it is already 'processing' from the start
-- call). provider_request_id/submitted_at are set once, via coalesce,
-- on whichever call first supplies them (normally the create-response
-- call) -- never overwritten afterward.
-- ------------------------------------------------------------
create or replace function public.complete_merchant_payout_provider_attempt(
  p_attempt_id uuid,
  p_provider_status text,
  p_result_code text default null,
  p_provider_request_id uuid default null,
  p_provider_last_updated_at timestamptz default null,
  p_source text default 'webhook'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payout_provider_attempts;
  v_payout public.merchant_payouts;
  v_failure_category text;
begin
  if p_provider_status not in ('pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed') then
    raise exception 'invalid provider status %', p_provider_status;
  end if;
  if p_source not in ('create_response', 'webhook', 'query_reconciliation') then
    raise exception 'invalid source %', p_source;
  end if;

  select * into v_attempt from public.payout_provider_attempts where id = p_attempt_id for update;
  if v_attempt.id is null then
    raise exception 'provider attempt not found';
  end if;
  if v_attempt.merchant_payout_id is null then
    raise exception 'attempt % is not a merchant-payout attempt', p_attempt_id;
  end if;

  -- Idempotent no-op: already resolved to this exact status.
  if v_attempt.resolved_at is not null and v_attempt.provider_status = p_provider_status then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- Out-of-order protection: an older (or equal) update never
  -- regresses a newer one. A null incoming timestamp (the synchronous
  -- create-response call never has Peach's own lastUpdated for a
  -- brand-new payout) is treated as "no ordering evidence" and allowed
  -- through once, only while the attempt has no lastUpdated of its own
  -- yet.
  if p_provider_last_updated_at is not null and v_attempt.provider_last_updated_at is not null
     and p_provider_last_updated_at <= v_attempt.provider_last_updated_at then
    return jsonb_build_object('ok', true, 'ignored_out_of_order', true);
  end if;

  update public.payout_provider_attempts
  set provider_status = p_provider_status,
      result_code = coalesce(p_result_code, result_code),
      provider_request_id = coalesce(provider_request_id, p_provider_request_id),
      provider_last_updated_at = coalesce(p_provider_last_updated_at, provider_last_updated_at),
      submitted_at = coalesce(submitted_at, case when p_source = 'create_response' then now() else submitted_at end),
      resolved_at = case when p_provider_status in ('successful', 'failed', 'cancelled', 'reversed') then now() else resolved_at end,
      failure_category = case
        when p_provider_status = 'cancelled' then 'provider_cancelled'
        when p_provider_status = 'failed' then 'provider_declined'
        else failure_category
      end,
      updated_at = now()
  where id = p_attempt_id;

  -- Non-terminal: attempt metadata only, domain stays 'processing'.
  if p_provider_status in ('pending', 'processing') then
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  select * into v_payout from public.merchant_payouts where id = v_attempt.merchant_payout_id for update;

  -- A reversal must only ever apply from 'paid' -- anything else means
  -- this attempt is not (or no longer) the authoritative current one
  -- for the payout (e.g. a stale/duplicate delivery), so the domain
  -- row is left untouched rather than raising (idempotent-safe).
  if p_provider_status = 'reversed' then
    if v_payout.status = 'paid' then
      -- p_payout_reference/p_payout_method are ignored by the
      -- transition helper for any new_status other than 'paid' (see
      -- its own UPDATE's CASE branches) -- passing null here is
      -- explicit about that, not a loss of data; the payout's own
      -- paid_at/provider_reference/payout_method from when it was
      -- originally marked paid remain untouched, exactly satisfying
      -- "do not rewrite prior paid history" (phase brief §37).
      perform public._merchant_payout_transition(
        v_payout.id, 'reversed', array['paid']::payout_status[],
        'provider', null, 'provider_reversed', 'peach payout reversal, attempt ' || p_attempt_id::text,
        null, null, null, null, false, null
      );
      return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'reversed');
    end if;
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  -- successful/failed/cancelled only apply while the payout is still
  -- 'processing' under THIS attempt's authority -- if it has already
  -- moved on (e.g. an admin manually failed it, or an earlier attempt
  -- already resolved it), this result is stale and is not applied.
  if v_payout.status <> 'processing' then
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  if p_provider_status = 'successful' then
    perform public._merchant_payout_transition(
      v_payout.id, 'paid', array['processing']::payout_status[],
      'provider', null, 'provider_paid', 'peach payout successful, attempt ' || p_attempt_id::text,
      null, null, v_attempt.provider_payout_id::text, 'peach', false, null
    );
    return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'paid');
  end if;

  v_failure_category := case when p_provider_status = 'cancelled' then 'provider_unavailable' else 'provider_declined' end;
  perform public._merchant_payout_transition(
    v_payout.id, 'failed', array['processing']::payout_status[],
    'provider', null, 'provider_' || p_provider_status, 'peach payout ' || p_provider_status || ', attempt ' || p_attempt_id::text,
    v_failure_category, 'The payment provider could not complete this payout.', null, null, false, null
  );
  return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'failed');
end;
$$;

revoke all on function public.complete_merchant_payout_provider_attempt(uuid, text, text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_merchant_payout_provider_attempt(uuid, text, text, uuid, timestamptz, text) to service_role;

-- ============================================================
-- AFFILIATE PAYOUT PROVIDER EXECUTION (mirrors the merchant pair above)
-- ============================================================

create or replace function public.start_affiliate_payout_provider_attempt(
  p_commission_id uuid,
  p_provider text default 'peach'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commission public.affiliate_commissions;
  v_destination_elig jsonb;
  v_destination_id uuid;
  v_bank_name text;
  v_provider_payout_id uuid := gen_random_uuid();
  v_attempt_id uuid;
  v_attempt_number int;
  v_amount_minor_units bigint;
begin
  select * into v_commission from public.affiliate_commissions where id = p_commission_id for update;
  if v_commission.id is null then
    raise exception 'commission not found';
  end if;
  if v_commission.status <> 'payout_queued' then
    raise exception 'commission is in status % and cannot start a provider attempt from here', v_commission.status;
  end if;
  if v_commission.currency <> 'ZAR' then
    raise exception 'commission currency % is not ZAR -- real-time EFT payouts are ZAR only', v_commission.currency;
  end if;

  v_destination_elig := public._payout_destination_eligibility(v_commission.affiliate_id);
  if not (v_destination_elig ->> 'eligible')::boolean then
    raise exception 'affiliate has no eligible payout destination: %', v_destination_elig ->> 'reason';
  end if;
  v_destination_id := (v_destination_elig ->> 'destination_id')::uuid;

  select pb.peach_payout_bank_name into v_bank_name
  from public.payout_destinations pd
  join public.payout_banks pb on pb.bank_code = pd.bank_code
  where pd.id = v_destination_id;
  if v_bank_name is null then
    raise exception 'destination bank has no confirmed Peach payout bankName mapping -- cannot submit a real-time EFT payout';
  end if;

  v_amount_minor_units := round(v_commission.commission_amount * 100);
  if v_amount_minor_units < 1 or v_amount_minor_units > 500000000 then
    raise exception 'commission amount is outside Peach''s accepted range for a single real-time EFT payout';
  end if;

  if public._payout_provider_attempts_has_active(null, p_commission_id) then
    raise exception 'a provider attempt is already active for this commission';
  end if;

  select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
  from public.payout_provider_attempts where affiliate_commission_id = p_commission_id;

  begin
    insert into public.payout_provider_attempts (
      affiliate_commission_id, payout_destination_id, provider, provider_payout_id,
      attempt_number, amount, currency
    ) values (
      p_commission_id, v_destination_id, p_provider, v_provider_payout_id,
      v_attempt_number, v_commission.commission_amount, v_commission.currency
    )
    returning id into v_attempt_id;
  exception
    when unique_violation then
      raise exception 'a concurrent provider-attempt start is already in progress for this commission -- please retry';
  end;

  update public.affiliate_commissions
  set payout_provider = p_provider, payout_requested_at = now()
  where id = p_commission_id and status = 'payout_queued';

  perform public._affiliate_commission_transition(
    p_commission_id, 'processing', array['payout_queued']::public.affiliate_commission_status[],
    'provider', null, 'peach payout attempt ' || v_attempt_id::text, null, null
  );

  return jsonb_build_object(
    'attempt_id', v_attempt_id,
    'provider_payout_id', v_provider_payout_id,
    'destination_id', v_destination_id,
    'bank_name', v_bank_name,
    'amount', v_commission.commission_amount,
    'amount_minor_units', v_amount_minor_units,
    'currency', v_commission.currency,
    'attempt_number', v_attempt_number
  );
end;
$$;

revoke all on function public.start_affiliate_payout_provider_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.start_affiliate_payout_provider_attempt(uuid, text) to service_role;

create or replace function public.complete_affiliate_payout_provider_attempt(
  p_attempt_id uuid,
  p_provider_status text,
  p_result_code text default null,
  p_provider_request_id uuid default null,
  p_provider_last_updated_at timestamptz default null,
  p_source text default 'webhook'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payout_provider_attempts;
  v_commission public.affiliate_commissions;
begin
  if p_provider_status not in ('pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed') then
    raise exception 'invalid provider status %', p_provider_status;
  end if;
  if p_source not in ('create_response', 'webhook', 'query_reconciliation') then
    raise exception 'invalid source %', p_source;
  end if;

  select * into v_attempt from public.payout_provider_attempts where id = p_attempt_id for update;
  if v_attempt.id is null then
    raise exception 'provider attempt not found';
  end if;
  if v_attempt.affiliate_commission_id is null then
    raise exception 'attempt % is not an affiliate-commission attempt', p_attempt_id;
  end if;

  if v_attempt.resolved_at is not null and v_attempt.provider_status = p_provider_status then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  if p_provider_last_updated_at is not null and v_attempt.provider_last_updated_at is not null
     and p_provider_last_updated_at <= v_attempt.provider_last_updated_at then
    return jsonb_build_object('ok', true, 'ignored_out_of_order', true);
  end if;

  update public.payout_provider_attempts
  set provider_status = p_provider_status,
      result_code = coalesce(p_result_code, result_code),
      provider_request_id = coalesce(provider_request_id, p_provider_request_id),
      provider_last_updated_at = coalesce(p_provider_last_updated_at, provider_last_updated_at),
      submitted_at = coalesce(submitted_at, case when p_source = 'create_response' then now() else submitted_at end),
      resolved_at = case when p_provider_status in ('successful', 'failed', 'cancelled', 'reversed') then now() else resolved_at end,
      failure_category = case
        when p_provider_status = 'cancelled' then 'provider_cancelled'
        when p_provider_status = 'failed' then 'provider_declined'
        else failure_category
      end,
      updated_at = now()
  where id = p_attempt_id;

  if p_provider_status in ('pending', 'processing') then
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  select * into v_commission from public.affiliate_commissions where id = v_attempt.affiliate_commission_id for update;

  if p_provider_status = 'reversed' then
    if v_commission.status = 'paid' then
      perform public._affiliate_commission_transition(
        v_commission.id, 'reversed', array['paid']::public.affiliate_commission_status[],
        'provider', null, 'peach payout reversal, attempt ' || p_attempt_id::text, v_attempt.provider_payout_id::text, null
      );
      return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'reversed');
    end if;
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  if v_commission.status <> 'processing' then
    return jsonb_build_object('ok', true, 'domain_transitioned', false);
  end if;

  if p_provider_status = 'successful' then
    update public.affiliate_commissions
    set payout_provider_reference = v_attempt.provider_payout_id::text, payout_confirmed_at = now()
    where id = v_commission.id and status = 'processing';
    perform public._affiliate_commission_transition(
      v_commission.id, 'paid', array['processing']::public.affiliate_commission_status[],
      'provider', null, 'peach payout successful, attempt ' || p_attempt_id::text, v_attempt.provider_payout_id::text, null
    );
    return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'paid');
  end if;

  perform public._affiliate_commission_transition(
    v_commission.id, 'failed', array['processing']::public.affiliate_commission_status[],
    'provider', null, 'peach payout ' || p_provider_status || ', attempt ' || p_attempt_id::text, null, null
  );
  return jsonb_build_object('ok', true, 'domain_transitioned', true, 'new_status', 'failed');
end;
$$;

revoke all on function public.complete_affiliate_payout_provider_attempt(uuid, text, text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_affiliate_payout_provider_attempt(uuid, text, text, uuid, timestamptz, text) to service_role;

-- ============================================================
-- MANUAL-FLOW CONFLICT GUARD -- widen the 3 existing manual RPCs
-- (phase brief §53). Bodies otherwise byte-identical to their current
-- live definitions; only the new guard clause is added, immediately
-- after each function's existing not-found/status check.
-- ============================================================

create or replace function public.mark_payout_paid(
  p_admin_id uuid,
  p_payout_id uuid,
  p_payout_reference text,
  p_payout_method text,
  p_confirm_manual_payment boolean,
  p_reason text default null,
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
  v_payout public.merchant_payouts;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not p_confirm_manual_payment then
    raise exception 'manual payment confirmation is required';
  end if;
  if p_payout_reference is null or length(trim(p_payout_reference)) = 0 then
    raise exception 'payout reference is required';
  end if;
  if p_payout_method not in ('manual', 'mock_validation') then
    raise exception 'invalid payout method';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_payout_reference, '') || '|' || coalesce(p_payout_method, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_payout_paid' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'processing' then
    raise exception 'payout is in status % and cannot be marked paid from here', v_payout.status;
  end if;

  -- E33: a live provider attempt is the authoritative path for this
  -- payout -- manual confirmation must not race or silently override it.
  if public._payout_provider_attempts_has_active(p_payout_id, null) then
    raise exception 'a payment provider attempt is currently active for this payout -- manual confirmation is not permitted while it is in progress';
  end if;

  v_block := public._merchant_payout_still_safe_to_pay_block(v_payout);
  if v_block is not null then
    raise exception 'payout is no longer safe to pay: %', v_block;
  end if;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'paid', array['processing']::payout_status[],
    'admin', p_admin_id, 'mark_paid', p_reason,
    null, null, p_payout_reference, p_payout_method, false, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_payout_paid', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_payout_paid(uuid, uuid, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.mark_payout_paid(uuid, uuid, text, text, boolean, text, text) to service_role;

create or replace function public.mark_payout_failed(
  p_admin_id uuid,
  p_payout_id uuid,
  p_failure_category text,
  p_reason text,
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
  v_payout public.merchant_payouts;
  v_failure_message_safe text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;
  if p_failure_category not in (
    'recipient_details_unavailable', 'recipient_details_invalid', 'provider_unavailable', 'provider_declined',
    'compliance_review', 'account_restricted', 'source_payment_issue', 'internal_consistency_error', 'other'
  ) then
    raise exception 'invalid failure category';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_failure_category, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_payout_failed' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'processing' then
    raise exception 'payout is in status % and cannot be marked failed from here', v_payout.status;
  end if;

  -- E33: unlike mark_payout_paid, this guard does NOT block while a
  -- provider attempt is active in a way that would prevent ever
  -- recovering from a stuck attempt -- but a RESOLVED (terminal,
  -- already-failed) provider attempt means the provider's own
  -- authority already applied via complete_merchant_payout_provider_
  -- attempt, so a second, manual "mark failed" on top of that is
  -- redundant at best; refuse only while an attempt is still
  -- genuinely live (pending/processing), matching mark_payout_paid.
  if public._payout_provider_attempts_has_active(p_payout_id, null) then
    raise exception 'a payment provider attempt is currently active for this payout -- manual failure is not permitted while it is in progress; reconcile the provider attempt instead';
  end if;

  v_failure_message_safe := case p_failure_category
    when 'recipient_details_unavailable' then 'Merchant payout details are not available.'
    when 'recipient_details_invalid' then 'Merchant payout details could not be validated.'
    when 'provider_unavailable' then 'The payment provider was unavailable.'
    when 'provider_declined' then 'The payment provider declined this payout.'
    when 'compliance_review' then 'This payout requires compliance review.'
    when 'account_restricted' then 'The merchant account is restricted.'
    when 'source_payment_issue' then 'The source payment for this payout has an issue.'
    when 'internal_consistency_error' then 'An internal error prevented this payout.'
    else 'This payout could not be completed.'
  end;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'failed', array['processing']::payout_status[],
    'admin', p_admin_id, 'mark_failed', p_reason,
    p_failure_category, v_failure_message_safe, null, null, false, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_payout_failed', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_payout_failed(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_payout_failed(uuid, uuid, text, text, text) to service_role;

create or replace function public.retry_payout(
  p_admin_id uuid,
  p_payout_id uuid,
  p_reason text,
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
  v_payout public.merchant_payouts;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'retry_payout' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'failed' then
    raise exception 'payout is in status % and cannot retry from here', v_payout.status;
  end if;

  -- E33: retry after an AMBIGUOUS provider outcome is never permitted
  -- (phase brief §56) -- a live (pending/processing) attempt means the
  -- outcome is not yet authoritative; reconcile it first.
  if public._payout_provider_attempts_has_active(p_payout_id, null) then
    raise exception 'a payment provider attempt is currently active for this payout -- manual retry is not permitted while it is in progress; reconcile the provider attempt instead';
  end if;

  v_block := public._merchant_payout_full_eligibility_block(v_payout);
  if v_block is not null then
    raise exception 'payout is not currently eligible to process: %', v_block;
  end if;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'processing', array['failed']::payout_status[],
    'admin', p_admin_id, 'retry', p_reason,
    null, null, null, null, true, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status, 'attempt_count', v_payout.attempt_count);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'retry_payout', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.retry_payout(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.retry_payout(uuid, uuid, text, text) to service_role;
