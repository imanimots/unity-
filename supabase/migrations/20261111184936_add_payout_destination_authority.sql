-- ============================================================
-- E32 -- Payout recipient banking authority, verification & secure storage
-- ============================================================
-- Establishes WHERE a future real payout (merchant or affiliate, Peach
-- or otherwise) would send money -- nothing in this migration moves
-- money or activates a payout provider. Peach's merchant_payout /
-- affiliate_payout capabilities remain false after this migration
-- (unchanged from E30); createMerchantPayout/createAffiliatePayout stay
-- NotImplementedError stubs.
--
-- RECIPIENT MODEL (confirmed by audit, not guessed): Unity has exactly
-- one canonical identity, public.profiles(id) (= auth.users.id). There
-- is no separate merchants/affiliates table -- "merchant" is a
-- profiles.role enum value, "affiliate" an independent profiles.
-- is_affiliate boolean -- so one profile can be both at once, and a
-- single bank destination legitimately serves both purposes for that
-- person. Destinations are therefore owned by profiles(id) directly,
-- purpose-agnostic, never a polymorphic (recipient_type, recipient_id)
-- pair.
--
-- STORAGE: Supabase Vault (vault.create_secret), not a new pgsodium
-- integration -- confirmed via current official docs this phase that
-- pgsodium is pending deprecation for new use while Vault's own API is
-- stable and already uses pgsodium internally without the caller
-- needing to touch it. The vault schema is structurally un-exposable
-- via the Data API (supabase/config.toml [api] schemas = ["public",
-- "graphql_public"] -- vault was never in that list and cannot be), and
-- its default grants are service_role-only. The one function that ever
-- reads vault.decrypted_secrets lives in the pre-existing `private`
-- schema (created by 20261104090000, also never Data-API-exposed) and
-- is itself service_role-only -- never a public "reveal secret" RPC.
--
-- Public-facing columns on payout_destinations are, by construction,
-- already safe (no raw account number, no vault pointer -- that FK
-- lives in the separate private.payout_destination_secrets table), so
-- owner/admin read access is granted directly via RLS on the real
-- table rather than a separate masked view.
--
-- VERSIONING: every row is an immutable version once created --
-- bank_code/universal_branch_code/account_type/account_last4 are never
-- UPDATEd by any RPC in this file after INSERT. Replacing a destination
-- always INSERTs a new version and flips the previous one's is_current
-- to false in the same transaction (create_payout_destination). A
-- partial unique index enforces "at most one current+enabled
-- destination per owner" as a real database constraint, not just RPC
-- discipline, so a concurrent double-create loses on a unique_violation
-- rather than racing to two simultaneously-current rows.
--
-- KYC REUSE: Peach's BANV `idNumber`/`lastName` are sourced live, at
-- submission time, from the ALREADY-STRUCTURED public.
-- identity_verifications table (id_reference_number/legal_surname,
-- confirmed by audit to already exist, not document-only) -- never
-- copied into this feature's own tables. A destination cannot be
-- submitted for verification until identity_verifications.status =
-- 'approved' for that owner; this fails closed with a clear error
-- rather than inventing identity data, so no BLOCKED verdict is needed
-- for the identity side of this phase.
--
-- VERIFICATION FINALITY: only Peach's own top-level `status =
-- 'successful'` on a signed webhook or an authenticated query
-- reconciliation call may set verification_status = 'verified'. HTTP
-- 200 on BANV creation, a verification id being issued, or any admin
-- action never does. "Stale" is computed at eligibility-check time
-- (verified AND verification_expires_at < now()) rather than stored as
-- an enum value, avoiding the need for a cron sweep in this phase while
-- still failing closed.
--
-- WEBHOOK REUSE: BANV results reuse the existing, already provider-
-- neutral payment_webhook_events table and its claim/complete/error
-- lease RPCs (record_webhook_event / claim_webhook_event_processing /
-- mark_webhook_event_processed / mark_webhook_event_error, all from
-- 20260801000004/20260924120000) completely unchanged, under a new
-- provider value 'peach_banv' -- no new webhook ledger is created here.
--
-- search_path = '' with fully-qualified public./private. references on
-- every new function, matching the current post-20261101130000 /
-- post-20261111112418 idiom. Every write-capable function: revoke all
-- from public/anon/authenticated, grant execute to service_role only,
-- plus an explicit auth.role() <> 'service_role' guard in the body.
-- ============================================================

create extension if not exists supabase_vault with schema vault;

-- Already created by 20261104090000; idempotent guard for a
-- self-contained read of this file.
create schema if not exists private;

-- ------------------------------------------------------------
-- PAYOUT_BANKS -- non-secret reference catalog. Source: Peach's current
-- official "Supported banks" table (developer.peachpayments.com/docs/
-- peach-payouts), fetched live this phase, 2026-11-11. Payout and BANV
-- support are independently tracked because they are genuinely
-- asymmetric for several banks (e.g. Bidvest Bank Alliances: payout
-- yes, BANV no; Finbond Net1: payout no, BANV yes -- confirmed from the
-- same table, not assumed). Update strategy: a new forward migration
-- whenever Peach's own list changes -- no runtime-editable catalog in
-- this phase.
-- ------------------------------------------------------------
create table if not exists public.payout_banks (
  bank_code text primary key,
  display_name text not null,
  universal_branch_code text,
  payout_supported boolean not null default false,
  banv_supported boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.payout_banks (bank_code, display_name, universal_branch_code, payout_supported, banv_supported) values
  ('absa', 'Absa', '632005', true, true),
  ('access_bank', 'Access Bank', '410105', true, true),
  ('african_bank', 'African Bank', '430000', true, true),
  ('african_bank_business', 'African Bank Business (formerly Grindrod Bank)', '584000', true, true),
  ('albaraka_bank', 'Albaraka Bank', '800000', true, true),
  ('bank_zero_mukuru', 'Bank Zero - Mukuru', '435000', true, false),
  ('bank_zero_mutual', 'Bank Zero Mutual Bank', '888000', true, false),
  ('bidvest_bank', 'Bidvest Bank', '462005', true, true),
  ('bidvest_bank_alliances', 'Bidvest Bank Alliances', '683000', true, false),
  ('capitec_bank', 'Capitec Bank (excluding Live Better accounts)', '470010', true, true),
  ('capitec_business', 'Capitec Business', '450105', true, true),
  ('discovery_bank', 'Discovery Bank', '679000', true, true),
  ('enl_mutual_bank', 'eNL Mutual Bank (formerly YWBN Mutual Bank)', '353000', true, true),
  ('finbond_epe', 'Finbond EPE', '589000', true, false),
  ('finbond_mutual_bank', 'Finbond Mutual Bank', '589000', true, true),
  ('finbond_net1', 'Finbond Net1', null, false, true),
  ('fnb', 'FNB (First National Bank)', '250655', true, true),
  ('gotyme_bank', 'GoTyme Bank (formerly TymeBank)', '678910', true, true),
  ('hbz_bank', 'HBZ Bank Limited', '570105', true, false),
  ('investec_bank', 'Investec Bank Limited', '580105', true, true),
  ('nedbank', 'Nedbank', '198765', true, true),
  ('mercantile_bank', 'Mercantile Bank', '450105', true, false),
  ('mukuru', 'Mukuru', '410105', true, false),
  ('old_mutual_bank', 'Old Mutual Bank', '352000', true, true),
  ('rand_merchant_bank', 'Rand Merchant Bank (RMB)', '250655', true, true),
  ('sasfin_bank', 'Sasfin Bank', '683000', true, false),
  ('standard_bank', 'Standard Bank', '051001', true, true),
  ('standard_chartered_bank_sa', 'Standard Chartered Bank SA', '730020', true, true),
  ('ubank', 'Ubank Ltd', '431010', true, false)
on conflict (bank_code) do nothing;

alter table public.payout_banks enable row level security;

create policy "payout_banks: authenticated read"
  on public.payout_banks for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- PAYOUT_DESTINATIONS -- immutable versions. Columns here are, by
-- construction, never sensitive: no raw account number, no vault
-- pointer (that lives in private.payout_destination_secrets).
-- ------------------------------------------------------------
create table if not exists public.payout_destinations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  version int not null,
  supersedes_id uuid references public.payout_destinations(id),
  is_current boolean not null default true,
  bank_code text not null references public.payout_banks(bank_code),
  universal_branch_code text not null,
  account_type text not null check (account_type in (
    'current_cheque_account', 'savings_account', 'transmission_account',
    'bond_account', 'subscription_share', 'unknown'
  )),
  account_last4 text not null check (char_length(account_last4) between 1 and 4),
  verification_status text not null default 'unverified' check (verification_status in (
    'unverified', 'pending', 'processing', 'verified', 'failed'
  )),
  verification_provider text,
  verification_id text,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  disabled_at timestamptz,
  disabled_by uuid references public.profiles(id),
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_destinations_version_positive check (version > 0)
);

create unique index if not exists payout_destinations_owner_version_idx
  on public.payout_destinations (owner_id, version);

-- The actual concurrency backstop (see header comment) -- a
-- unique_violation here, not application-level locking, is what
-- guarantees "at most one current+enabled destination per owner".
create unique index if not exists payout_destinations_one_current_per_owner_idx
  on public.payout_destinations (owner_id)
  where is_current and disabled_at is null;

create index if not exists payout_destinations_owner_idx on public.payout_destinations (owner_id, created_at desc);

alter table public.payout_destinations enable row level security;

create policy "payout_destinations: owner read"
  on public.payout_destinations for select
  using (owner_id = auth.uid());

create policy "payout_destinations: admin read"
  on public.payout_destinations for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- ------------------------------------------------------------
-- Ownership helper for the two tables below, matching the current
-- (post-20261104090000) idiom: a one-argument, auth.uid()-deriving,
-- `private`-schema predicate meant only for RLS USING clauses -- never
-- called via PostgREST .rpc() (private is not Data-API-exposed).
-- ------------------------------------------------------------
create or replace function private.is_payout_destination_owner(p_destination_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payout_destinations
    where id = p_destination_id and owner_id = auth.uid()
  );
$$;

revoke all on function private.is_payout_destination_owner(uuid) from public, anon;
grant execute on function private.is_payout_destination_owner(uuid) to authenticated;

-- ------------------------------------------------------------
-- PAYOUT_DESTINATION_VERIFICATION_ATTEMPTS -- one row per BANV create
-- call. field_results holds Peach's nine per-attribute positive/
-- negative/unverified attestation OUTCOMES (not raw banking values --
-- safe to store and display). Legitimately transitions pending/
-- processing -> successful/failed/error via UPDATE (mirrors the
-- dispute_financial_dispositions "append + update-to-complete"
-- precedent), so prevent_row_mutation() guards DELETE only here, not
-- UPDATE.
-- ------------------------------------------------------------
create table if not exists public.payout_destination_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.payout_destinations(id),
  provider text not null default 'peach',
  provider_verification_id text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'successful', 'failed', 'error')),
  result_code text,
  field_results jsonb,
  failure_category text,
  trigger text not null check (trigger in ('initial', 'replacement', 'reverification', 'admin_manual', 'reconciliation')),
  created_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists payout_destination_verification_attempts_destination_idx
  on public.payout_destination_verification_attempts (destination_id, requested_at desc);

create unique index if not exists payout_destination_verification_attempts_provider_ref_idx
  on public.payout_destination_verification_attempts (provider, provider_verification_id)
  where provider_verification_id is not null;

alter table public.payout_destination_verification_attempts enable row level security;

create policy "payout_destination_verification_attempts: owner read"
  on public.payout_destination_verification_attempts for select
  using (private.is_payout_destination_owner(destination_id));

create policy "payout_destination_verification_attempts: admin read"
  on public.payout_destination_verification_attempts for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists payout_destination_verification_attempts_no_delete on public.payout_destination_verification_attempts;
create trigger payout_destination_verification_attempts_no_delete
  before delete on public.payout_destination_verification_attempts
  for each row execute function public.prevent_row_mutation();

-- ------------------------------------------------------------
-- PAYOUT_DESTINATION_HISTORY -- pure append-only audit trail, following
-- the merchant_payout_history / dispute_history precedent exactly (one
-- shared cross-domain audit table does not exist in this codebase).
-- Never contains raw banking data.
-- ------------------------------------------------------------
create table if not exists public.payout_destination_history (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.payout_destinations(id),
  owner_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in (
    'destination_created', 'destination_replaced', 'verification_requested',
    'verification_submitted', 'verification_processing', 'verification_succeeded',
    'verification_failed', 'destination_disabled'
  )),
  actor_type text not null check (actor_type in ('owner', 'admin', 'system', 'provider')),
  actor_id uuid references public.profiles(id),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists payout_destination_history_destination_idx
  on public.payout_destination_history (destination_id, created_at);

alter table public.payout_destination_history enable row level security;

create policy "payout_destination_history: owner read"
  on public.payout_destination_history for select
  using (owner_id = auth.uid());

create policy "payout_destination_history: admin read"
  on public.payout_destination_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists payout_destination_history_immutable on public.payout_destination_history;
create trigger payout_destination_history_immutable
  before update or delete on public.payout_destination_history
  for each row execute function public.prevent_row_mutation();

-- ------------------------------------------------------------
-- PRIVATE.PAYOUT_DESTINATION_SECRETS -- the only link between a
-- public-facing destination row and its Vault secret. Lives in the
-- `private` schema (not Data-API-exposed, per supabase/config.toml)
-- rather than as a column on payout_destinations itself -- defense in
-- depth beyond Vault's own non-exposure, per the phase brief's explicit
-- preference for keeping the secret pointer outside ordinary
-- client-readable data.
-- ------------------------------------------------------------
create table if not exists private.payout_destination_secrets (
  destination_id uuid primary key references public.payout_destinations(id),
  vault_secret_id uuid not null,
  created_at timestamptz not null default now()
);

alter table private.payout_destination_secrets enable row level security;
-- No policy at all -- private is not Data-API-exposed, and this table
-- carries no SELECT/INSERT/UPDATE/DELETE grant to anon/authenticated
-- below, so RLS here is belt-and-suspenders, not the primary control.

-- ============================================================
-- RPCs
-- ============================================================

-- ------------------------------------------------------------
-- CREATE_PAYOUT_DESTINATION -- atomic: supersede any existing current
-- destination, create the Vault secret, insert the new version, link
-- it, write the audit row. All in one PL/pgSQL call -- per this
-- project's established transaction-boundary precedent (E28-R1/E29/
-- E30), an unhandled exception anywhere in this body rolls back every
-- write it made, so a Vault secret creation failure can never leave a
-- destination row claiming to be current (§82-84 of the phase brief).
-- Ownership (is p_actor_id allowed to act for p_owner_id) is the
-- calling API route's job, same as every other admin/self-service RPC
-- in this codebase -- this function trusts service_role callers to
-- have already checked that.
-- ------------------------------------------------------------
create or replace function public.create_payout_destination(
  p_owner_id uuid,
  p_bank_code text,
  p_account_number text,
  p_account_type text,
  p_actor_id uuid,
  p_actor_type text default 'owner'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bank public.payout_banks;
  v_previous public.payout_destinations;
  v_new_id uuid := gen_random_uuid();
  v_secret_id uuid;
  v_last4 text;
  v_version int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_account_number !~ '^[0-9]{1,13}$' then
    raise exception 'account number must be 1-13 numeric characters';
  end if;
  if p_account_type not in ('current_cheque_account', 'savings_account', 'transmission_account', 'bond_account', 'subscription_share', 'unknown') then
    raise exception 'invalid account type';
  end if;

  select * into v_bank from public.payout_banks where bank_code = p_bank_code and active;
  if v_bank.bank_code is null then
    raise exception 'unknown or inactive bank_code %', p_bank_code;
  end if;
  if not v_bank.payout_supported then
    raise exception 'bank % does not support payouts', p_bank_code;
  end if;

  select * into v_previous from public.payout_destinations
  where owner_id = p_owner_id and is_current and disabled_at is null;

  v_version := coalesce(v_previous.version, 0) + 1;
  v_last4 := right(p_account_number, 4);

  if v_previous.id is not null then
    update public.payout_destinations set is_current = false, updated_at = now() where id = v_previous.id;
  end if;

  -- Vault secret name follows the phase brief's explicit naming rule --
  -- the destination uuid only, never any bank/PII fragment.
  v_secret_id := vault.create_secret(p_account_number, 'payout_destination:' || v_new_id::text, null);

  insert into public.payout_destinations (
    id, owner_id, version, supersedes_id, is_current, bank_code, universal_branch_code,
    account_type, account_last4
  ) values (
    v_new_id, p_owner_id, v_version, v_previous.id, true, p_bank_code, v_bank.universal_branch_code,
    p_account_type, v_last4
  );

  insert into private.payout_destination_secrets (destination_id, vault_secret_id)
  values (v_new_id, v_secret_id);

  insert into public.payout_destination_history (destination_id, owner_id, event_type, actor_type, actor_id, metadata)
  values (
    v_new_id, p_owner_id,
    case when v_previous.id is null then 'destination_created' else 'destination_replaced' end,
    p_actor_type, p_actor_id,
    jsonb_build_object('bank_code', p_bank_code, 'version', v_version, 'supersedes_id', v_previous.id)
  );

  return jsonb_build_object('destination_id', v_new_id, 'version', v_version, 'verification_status', 'unverified');
exception
  when unique_violation then
    raise exception 'a concurrent bank-detail change is already in progress for this owner -- please retry';
end;
$$;

revoke all on function public.create_payout_destination(uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_payout_destination(uuid, text, text, text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- GET_PAYOUT_DESTINATION_ACCOUNT_NUMBER -- the one place raw account
-- data is ever read back. Deliberately NOT a generic "get secret by id"
-- RPC (phase brief explicitly prohibits that) in effect: it is
-- purpose-named, consumed only by this phase's own server-side
-- BANV-submission orchestrator code, and gated by the exact same
-- revoke-all/grant-service_role-only pattern as every other sensitive
-- RPC in this codebase (record_webhook_event, create_merchant_payout,
-- record_refund_provider_result, etc) -- none of those live in
-- `private` either, because PostgREST's .rpc() can only ever reach a
-- function in a Data-API-exposed schema (supabase/config.toml [api]
-- schemas = ["public", "graphql_public"]), same reasoning
-- 20261104090000 already documented for why its own RLS-only
-- predicates (never called via .rpc()) could move to `private` while
-- the two-argument, application-callable forms could not. This
-- function IS called via .rpc() by server code holding the
-- service_role key -- anon/authenticated never can, by grant -- so it
-- must stay in `public`. Never returned to a browser by any caller.
-- ------------------------------------------------------------
create or replace function public.get_payout_destination_account_number(p_destination_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_number text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select vault.decrypted_secrets.decrypted_secret into v_account_number
  from private.payout_destination_secrets
  join vault.decrypted_secrets on vault.decrypted_secrets.id = private.payout_destination_secrets.vault_secret_id
  where private.payout_destination_secrets.destination_id = p_destination_id;

  if v_account_number is null then
    raise exception 'no stored account number for destination %', p_destination_id;
  end if;

  return v_account_number;
end;
$$;

revoke all on function public.get_payout_destination_account_number(uuid) from public, anon, authenticated;
grant execute on function public.get_payout_destination_account_number(uuid) to service_role;

-- ------------------------------------------------------------
-- START_BANK_VERIFICATION_ATTEMPT -- called immediately before the
-- orchestrator makes the Peach BANV create call. Refuses up front for a
-- disabled/non-current destination or a bank with banv_supported =
-- false (phase brief §42 -- no automatic verified state when BANV
-- simply isn't offered).
-- ------------------------------------------------------------
create or replace function public.start_bank_verification_attempt(
  p_destination_id uuid,
  p_trigger text,
  p_actor_id uuid default null,
  p_actor_type text default 'owner'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dest public.payout_destinations;
  v_bank public.payout_banks;
  v_attempt_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_trigger not in ('initial', 'replacement', 'reverification', 'admin_manual', 'reconciliation') then
    raise exception 'invalid trigger %', p_trigger;
  end if;

  select * into v_dest from public.payout_destinations where id = p_destination_id;
  if v_dest.id is null then
    raise exception 'destination % not found', p_destination_id;
  end if;
  if not v_dest.is_current or v_dest.disabled_at is not null then
    raise exception 'destination % is not current or is disabled -- cannot start verification', p_destination_id;
  end if;

  select * into v_bank from public.payout_banks where bank_code = v_dest.bank_code;
  if not v_bank.banv_supported then
    raise exception 'bank % does not support bank account verification', v_dest.bank_code;
  end if;

  insert into public.payout_destination_verification_attempts (destination_id, trigger, created_by, status)
  values (p_destination_id, p_trigger, p_actor_id, 'pending')
  returning id into v_attempt_id;

  -- Monotonic: never regress an already-verified destination just
  -- because a new attempt started (e.g. a manual re-verification before
  -- expiry). Otherwise move it into pending.
  if v_dest.verification_status <> 'verified' then
    update public.payout_destinations set verification_status = 'pending', updated_at = now() where id = p_destination_id;
  end if;

  insert into public.payout_destination_history (destination_id, owner_id, event_type, actor_type, actor_id, metadata)
  values (p_destination_id, v_dest.owner_id, 'verification_requested', p_actor_type, p_actor_id, jsonb_build_object('attempt_id', v_attempt_id, 'trigger', p_trigger));

  return jsonb_build_object('attempt_id', v_attempt_id);
end;
$$;

revoke all on function public.start_bank_verification_attempt(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.start_bank_verification_attempt(uuid, text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RECORD_BANK_VERIFICATION_SUBMITTED -- called right after Peach's
-- create-BANV HTTP call returns 200 with a bankVerificationId. This is
-- NOT finality (phase brief §33/§35) -- it only records the provider's
-- own reference and whatever initial status Peach itself returned.
-- ------------------------------------------------------------
create or replace function public.record_bank_verification_submitted(
  p_attempt_id uuid,
  p_provider_verification_id text,
  p_initial_status text,
  p_result_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payout_destination_verification_attempts;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_initial_status not in ('pending', 'processing', 'successful', 'failed') then
    raise exception 'invalid initial status %', p_initial_status;
  end if;

  select * into v_attempt from public.payout_destination_verification_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    raise exception 'verification attempt % not found', p_attempt_id;
  end if;

  update public.payout_destination_verification_attempts
  set provider_verification_id = p_provider_verification_id,
      status = case when p_initial_status = 'successful' then 'processing' else p_initial_status end,
      result_code = p_result_code
  where id = p_attempt_id;

  if p_initial_status = 'processing' or p_initial_status = 'successful' then
    update public.payout_destinations set verification_status = 'processing', updated_at = now()
    where id = v_attempt.destination_id and verification_status <> 'verified';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.record_bank_verification_submitted(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_bank_verification_submitted(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------
-- RECORD_BANK_VERIFICATION_RESULT -- the one place verification_status
-- can ever become 'verified' or 'failed'. Called from the BANV webhook
-- handler (p_source = 'webhook') or admin/cron query reconciliation
-- (p_source = 'query_reconciliation') -- never from an admin action
-- directly (phase brief §35).
--
-- Looked up by (provider, provider_verification_id), not attempt_id --
-- the caller (webhook/reconciliation) only ever knows Peach's own
-- bankVerificationId. Idempotent on a duplicate final result (§54): if
-- the attempt is already resolved with the same status, this is a
-- no-op. Guards against reactivating a superseded destination (§86/
-- §87): only mutates payout_destinations when the attempt's destination
-- is still is_current and not disabled. Guards against regression
-- (§55): never moves a destination backward from 'verified'.
-- ------------------------------------------------------------
create or replace function public.record_bank_verification_result(
  p_provider text,
  p_provider_verification_id text,
  p_status text,
  p_result_code text,
  p_field_results jsonb,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payout_destination_verification_attempts;
  v_dest public.payout_destinations;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_status not in ('pending', 'processing', 'successful', 'failed') then
    raise exception 'invalid status %', p_status;
  end if;
  if p_source not in ('webhook', 'query_reconciliation') then
    raise exception 'invalid source %', p_source;
  end if;

  select * into v_attempt from public.payout_destination_verification_attempts
  where provider = p_provider and provider_verification_id = p_provider_verification_id;

  if v_attempt.id is null then
    raise exception 'no verification attempt found for provider % / verification id %', p_provider, p_provider_verification_id;
  end if;

  -- Idempotent no-op on a duplicate final result for the same attempt.
  if v_attempt.resolved_at is not null and v_attempt.status = p_status then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- A non-final status (pending/processing) arriving after this
  -- attempt already reached a final state is ignored outright -- never
  -- regress an attempt's own record either.
  if v_attempt.resolved_at is not null and p_status in ('pending', 'processing') then
    return jsonb_build_object('ok', true, 'ignored_out_of_order', true);
  end if;

  update public.payout_destination_verification_attempts
  set status = p_status,
      result_code = p_result_code,
      field_results = p_field_results,
      resolved_at = case when p_status in ('successful', 'failed') then now() else resolved_at end
  where id = v_attempt.id;

  select * into v_dest from public.payout_destinations where id = v_attempt.destination_id;

  -- Only mutate the destination if it is still the current, enabled
  -- one -- a late result for a superseded version must never reactivate
  -- it (§86/§87), and never regress an already-verified destination
  -- (§55).
  if v_dest.is_current and v_dest.disabled_at is null and v_dest.verification_status <> 'verified' then
    if p_status = 'successful' then
      update public.payout_destinations
      set verification_status = 'verified', verified_at = now(), verification_expires_at = now() + interval '90 days',
          verification_provider = p_provider, verification_id = p_provider_verification_id, updated_at = now()
      where id = v_dest.id;
    elsif p_status = 'failed' then
      update public.payout_destinations
      set verification_status = 'failed', updated_at = now()
      where id = v_dest.id;
    elsif p_status = 'processing' then
      update public.payout_destinations set verification_status = 'processing', updated_at = now() where id = v_dest.id;
    end if;
  end if;

  insert into public.payout_destination_history (destination_id, owner_id, event_type, actor_type, metadata)
  values (
    v_attempt.destination_id, v_dest.owner_id,
    case p_status
      when 'successful' then 'verification_succeeded'
      when 'failed' then 'verification_failed'
      else 'verification_processing'
    end,
    'provider',
    jsonb_build_object('attempt_id', v_attempt.id, 'source', p_source, 'result_code', p_result_code, 'applied_to_destination', v_dest.is_current and v_dest.disabled_at is null)
  );

  return jsonb_build_object('ok', true, 'applied_to_destination', v_dest.is_current and v_dest.disabled_at is null);
end;
$$;

revoke all on function public.record_bank_verification_result(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_bank_verification_result(text, text, text, text, jsonb, text) to service_role;

-- ------------------------------------------------------------
-- DISABLE_PAYOUT_DESTINATION -- soft-disable only. Hard delete is
-- explicitly out of scope for this phase (phase brief §67: retention
-- policy must be defined before any deletion is implemented, and this
-- phase does not define one).
-- ------------------------------------------------------------
create or replace function public.disable_payout_destination(
  p_destination_id uuid,
  p_actor_id uuid,
  p_actor_type text default 'owner',
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dest public.payout_destinations;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_dest from public.payout_destinations where id = p_destination_id;
  if v_dest.id is null then
    raise exception 'destination % not found', p_destination_id;
  end if;

  update public.payout_destinations
  set disabled_at = now(), disabled_by = p_actor_id, disabled_reason = p_reason, updated_at = now()
  where id = p_destination_id and disabled_at is null;

  insert into public.payout_destination_history (destination_id, owner_id, event_type, actor_type, actor_id, metadata)
  values (p_destination_id, v_dest.owner_id, 'destination_disabled', p_actor_type, p_actor_id, jsonb_build_object('reason', p_reason));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.disable_payout_destination(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.disable_payout_destination(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- _PAYOUT_DESTINATION_ELIGIBILITY -- the one authoritative check a
-- future payout-execution phase must call before sending money
-- anywhere. Leading underscore matches this codebase's existing
-- internal-helper naming convention (_rtb_merchant_payout_exception_
-- candidates, _merchant_payout_full_eligibility_block, etc).
-- "Stale" is computed here, live, rather than stored.
-- ------------------------------------------------------------
create or replace function public._payout_destination_eligibility(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dest public.payout_destinations;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_dest from public.payout_destinations
  where owner_id = p_owner_id and is_current and disabled_at is null;

  if v_dest.id is null then
    return jsonb_build_object('eligible', false, 'reason', 'no_destination', 'destination_id', null);
  end if;
  if v_dest.verification_status = 'verified' and v_dest.verification_expires_at < now() then
    return jsonb_build_object('eligible', false, 'reason', 'stale', 'destination_id', v_dest.id);
  end if;
  if v_dest.verification_status <> 'verified' then
    return jsonb_build_object('eligible', false, 'reason', v_dest.verification_status, 'destination_id', v_dest.id);
  end if;

  return jsonb_build_object('eligible', true, 'reason', null, 'destination_id', v_dest.id);
end;
$$;

revoke all on function public._payout_destination_eligibility(uuid) from public, anon, authenticated;
grant execute on function public._payout_destination_eligibility(uuid) to service_role;
