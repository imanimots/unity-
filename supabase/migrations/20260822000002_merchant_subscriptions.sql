-- ============================================================
-- Unity Phase 1 -- Merchant Subscriptions & Economics
-- Merchant subscription state (one row per merchant, account-level --
-- never per-listing), immutable history, and provider-neutral mock
-- billing attempts.
--
-- No row is created for a merchant merely to represent "on Starter" --
-- an absent row IS Starter, resolved deterministically by
-- getEffectiveMerchantPlan() (src/lib/subscriptions/effective-plan.ts).
-- A row is only created the first time a merchant's plan actually
-- changes (upgrade, or an admin correction).
-- ============================================================

create table if not exists public.merchant_subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  merchant_id                 uuid not null unique references public.profiles(id),
  current_plan_id             text not null default 'starter' references public.merchant_subscription_plans(id),
  current_plan_effective_at   timestamptz not null default now(),
  -- A scheduled future change -- both null when nothing is pending.
  pending_plan_id             text references public.merchant_subscription_plans(id),
  pending_plan_effective_at   timestamptz,
  -- Explicit named states, never inferred from null-ness alone:
  --   active           -- current_plan_id is in effect, nothing pending
  --   pending_change   -- a scheduled upgrade/downgrade will apply at pending_plan_effective_at
  --   cancelled        -- the paid plan was cancelled; will revert to Starter at pending_plan_effective_at
  status                      text not null default 'active'
                                check (status in ('active', 'pending_change', 'cancelled')),
  last_transition_category    text
                                check (last_transition_category is null or last_transition_category in
                                  ('upgrade', 'downgrade', 'cancellation', 'reversion', 'admin_correction', 'pending_change_cancelled')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint merchant_subscriptions_pending_consistency check (
    (status = 'active' and pending_plan_id is null and pending_plan_effective_at is null)
    or (status in ('pending_change', 'cancelled') and pending_plan_id is not null and pending_plan_effective_at is not null)
  )
);

create index if not exists merchant_subscriptions_pending_due_idx
  on public.merchant_subscriptions(pending_plan_effective_at)
  where status in ('pending_change', 'cancelled');

create or replace function public.touch_merchant_subscription_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger merchant_subscriptions_touch_updated_at
  before update on public.merchant_subscriptions
  for each row execute procedure public.touch_merchant_subscription_updated_at();

alter table public.merchant_subscriptions enable row level security;

create policy "merchant_subscriptions: own read"
  on public.merchant_subscriptions for select
  using (merchant_id = auth.uid());

create policy "merchant_subscriptions: admin read"
  on public.merchant_subscriptions for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Zero client write policies -- every mutation goes through the RPCs in
-- the next migration (service-role only), matching every other
-- financial/authority domain in this codebase (barter_agreements,
-- disputes, affiliate_commissions, merchant_payouts).

-- ─────────────────────────────────────────
-- MERCHANT_SUBSCRIPTION_HISTORY -- immutable, append-only
-- ─────────────────────────────────────────
create table if not exists public.merchant_subscription_history (
  id                   uuid primary key default gen_random_uuid(),
  merchant_id          uuid not null references public.profiles(id),
  previous_plan_id     text references public.merchant_subscription_plans(id),
  new_plan_id          text not null references public.merchant_subscription_plans(id),
  requested_at         timestamptz not null default now(),
  effective_at         timestamptz not null,
  actor_type           text not null check (actor_type in ('merchant', 'admin', 'system')),
  actor_id             uuid,
  change_category      text not null check (change_category in
                          ('upgrade', 'downgrade', 'cancellation', 'reversion', 'admin_correction', 'pending_change_cancelled')),
  reason               text,
  billing_reference     text,
  idempotency_key      text,
  created_at           timestamptz not null default now()
);

create index if not exists merchant_subscription_history_merchant_idx
  on public.merchant_subscription_history(merchant_id, created_at);

alter table public.merchant_subscription_history enable row level security;

create policy "merchant_subscription_history: own read"
  on public.merchant_subscription_history for select
  using (merchant_id = auth.uid());

create policy "merchant_subscription_history: admin read"
  on public.merchant_subscription_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists merchant_subscription_history_immutable on public.merchant_subscription_history;
create trigger merchant_subscription_history_immutable
  before update or delete on public.merchant_subscription_history
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- MERCHANT_SUBSCRIPTION_BILLING_ATTEMPTS -- provider-neutral mock
-- billing audit trail. "provider" stays a generic label ('mock' in
-- every environment today) -- never a real vendor name, so a future
-- real provider slots in without a schema change. No real charge is
-- ever made in this phase.
-- ─────────────────────────────────────────
create table if not exists public.merchant_subscription_billing_attempts (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references public.profiles(id),
  plan_id             text not null references public.merchant_subscription_plans(id),
  amount_cents        integer not null check (amount_cents >= 0),
  currency            text not null default 'ZAR',
  provider            text not null default 'mock',
  provider_reference  text,
  status              text not null check (status in ('succeeded', 'failed')),
  failure_reason      text,
  mock_scenario       text,
  idempotency_key     text,
  created_at          timestamptz not null default now()
);

create index if not exists merchant_subscription_billing_attempts_merchant_idx
  on public.merchant_subscription_billing_attempts(merchant_id, created_at);

alter table public.merchant_subscription_billing_attempts enable row level security;

create policy "merchant_subscription_billing_attempts: own read"
  on public.merchant_subscription_billing_attempts for select
  using (merchant_id = auth.uid());

create policy "merchant_subscription_billing_attempts: admin read"
  on public.merchant_subscription_billing_attempts for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists merchant_subscription_billing_attempts_immutable on public.merchant_subscription_billing_attempts;
create trigger merchant_subscription_billing_attempts_immutable
  before update or delete on public.merchant_subscription_billing_attempts
  for each row execute procedure public.prevent_row_mutation();
