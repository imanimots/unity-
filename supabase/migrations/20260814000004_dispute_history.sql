-- ============================================================
-- Step 11 Phase 2 -- dispute_history
-- ============================================================
-- Serves BOTH "history" and "audit" in one table -- not a second
-- admin_action_history-style table (that table's listing_id FK is hard
-- NOT NULL and listings-specific, confirmed via live schema query, so
-- it's the wrong shape to reuse for disputes). Instead this follows the
-- more recent, better precedent already set by order_history:
-- actor_role distinguishes participant vs. admin vs. system actions in
-- one append-only log, rather than splitting them across two tables.
--
-- Append-only via the shared prevent_row_mutation() trigger (already
-- defined in 20260729000003_listing_declarations_and_history.sql,
-- reused here exactly as booking_history/barter_history/order_history
-- already do -- never redefined).
--
-- Also defines is_dispute_participant() here (its first consumer) --
-- one reusable check for "is this user a party to this dispute" (via
-- raised_by, or via whichever of booking/order/barter_agreement the
-- dispute references), used by this table's RLS and reused again by
-- dispute_evidence's table + storage RLS in the next migration, instead
-- of repeating the 3-way join through bookings/orders/barter_agreements
-- in every policy.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.is_dispute_participant(p_dispute_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.disputes d
    left join public.bookings b on b.id = d.booking_id
    left join public.orders o on o.id = d.order_id
    left join public.barter_agreements ba on ba.id = d.barter_agreement_id
    where d.id = p_dispute_id
      and (
        d.raised_by = p_user_id
        or b.renter_id = p_user_id or b.merchant_id = p_user_id
        or o.buyer_id = p_user_id or o.seller_id = p_user_id
        or ba.party_a_id = p_user_id or ba.party_b_id = p_user_id
      )
  );
$$;

create table if not exists public.dispute_history (
  id uuid primary key default uuid_generate_v4(),
  dispute_id uuid not null references public.disputes(id) on delete cascade,
  actor_user_id uuid references public.profiles(id),
  actor_role text not null check (actor_role in ('raiser', 'respondent', 'admin', 'system')),
  event_type text not null,
  previous_status text,
  new_status text,
  metadata jsonb not null default '{}',
  idempotency_key text,
  created_at timestamptz not null default now()
);

create index if not exists dispute_history_dispute_idx on public.dispute_history(dispute_id, created_at);

alter table public.dispute_history enable row level security;

create policy "dispute_history: parties read"
  on public.dispute_history for select
  using (public.is_dispute_participant(dispute_id, auth.uid()));

create policy "dispute_history: admin read"
  on public.dispute_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists dispute_history_immutable on public.dispute_history;
create trigger dispute_history_immutable
  before update or delete on public.dispute_history
  for each row execute function public.prevent_row_mutation();
