-- ============================================================
-- Payment domain RLS (Phase 2C)
-- ============================================================
-- No client may set payment status, alter amounts, or mark anything
-- successful -- every payment table gets a read-only policy for the
-- parties involved (or no client policy at all) and zero write policies
-- for anon/authenticated. All mutation happens through service-role-only
-- RPCs (20260801000004), the same trust boundary already proven for
-- bookings and listings.
--
-- ledger_entries and payment_webhook_events get NO client-facing policy
-- at all -- the ledger is an internal accounting record (parties see
-- their payments/refunds/payouts, which is the user-facing view of the
-- same facts), and webhook events are raw untrusted provider input that
-- was never meant to be client-readable. Both patterns mirror
-- idempotency_keys' "RLS enabled, zero policies" convention from Phase 2A.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.payments enable row level security;
create policy "payments: parties read"
  on public.payments for select
  using (renter_id = auth.uid() or merchant_id = auth.uid());

alter table public.payment_attempts enable row level security;
create policy "payment_attempts: parties read"
  on public.payment_attempts for select
  using (
    exists (
      select 1 from public.payments p
      where p.id = payment_attempts.payment_id
        and (p.renter_id = auth.uid() or p.merchant_id = auth.uid())
    )
  );

alter table public.payment_events enable row level security;
create policy "payment_events: parties read"
  on public.payment_events for select
  using (
    exists (
      select 1 from public.payments p
      where p.id = payment_events.payment_id
        and (p.renter_id = auth.uid() or p.merchant_id = auth.uid())
    )
  );
drop trigger if exists prevent_payment_events_mutation on public.payment_events;
create trigger prevent_payment_events_mutation
  before update or delete on public.payment_events
  for each row execute procedure public.prevent_row_mutation();

alter table public.refunds enable row level security;
create policy "refunds: parties read"
  on public.refunds for select
  using (
    exists (
      select 1 from public.payments p
      where p.id = refunds.payment_id
        and (p.renter_id = auth.uid() or p.merchant_id = auth.uid())
    )
  );

alter table public.merchant_payouts enable row level security;
create policy "merchant_payouts: own read"
  on public.merchant_payouts for select
  using (merchant_id = auth.uid());

alter table public.ledger_entries enable row level security;
-- Deliberately zero policies -- see header.

alter table public.payment_webhook_events enable row level security;
-- Deliberately zero policies -- see header.

-- Defense-in-depth: even though no INSERT/UPDATE policy exists for
-- authenticated/anon on any of these tables, a trigger-level guard
-- mirrors the pattern already used for listings and bookings in case a
-- policy is ever mistakenly reintroduced.
create or replace function public.protect_payment_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      raise exception 'payments must be created via a payment RPC, not a direct insert';
    else
      new.status := old.status;
      new.amount := old.amount;
      new.renter_id := old.renter_id;
      new.merchant_id := old.merchant_id;
      new.booking_id := old.booking_id;
      new.provider_reference := old.provider_reference;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_payment_privileged_fields_trg on public.payments;
create trigger protect_payment_privileged_fields_trg
  before insert or update on public.payments
  for each row execute procedure public.protect_payment_privileged_fields();
