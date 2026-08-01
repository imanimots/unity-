-- ============================================================
-- Admin overview aggregate RPC + exception-queue resolution tracking
-- (Step 9, public-test MVP — Admin Operations Dashboard)
-- ============================================================
-- get_admin_overview_stats() computes every overview number in one
-- round trip, server-side, so the browser never aggregates sensitive
-- totals itself (per the brief). Every count here is informational —
-- none of these numbers gate any real transition; the authoritative
-- derivation for an individual booking's financial readiness remains
-- src/lib/checkout/financial-readiness.ts, not this function. Where an
-- exact TypeScript-equivalent derivation would be expensive to
-- replicate in one aggregate SQL query, a documented proxy is used
-- instead (see docs/ADMIN_OPERATIONS.md's "known limitations").
--
-- Operational exceptions are computed live (not stored) by
-- src/lib/admin/operations.ts — this migration only adds the table that
-- tracks which computed exceptions an admin has already resolved/
-- dismissed, since "resolved" has no natural column to live on for
-- several exception types (e.g. "late successful provider event") that
-- have no single owning row to flag. A stable, deterministic id per
-- exception (exception_type + entity_type + entity_id) is what
-- resolution is keyed on.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.exception_resolutions (
  exception_type text not null,
  entity_type    text not null,
  entity_id      uuid not null,
  resolved_by    uuid not null references public.profiles(id),
  resolved_note  text,
  resolved_at    timestamptz not null default now(),
  primary key (exception_type, entity_type, entity_id)
);

alter table public.exception_resolutions enable row level security;

create policy "exception_resolutions: admin read"
  on public.exception_resolutions for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Resolutions may be legitimately re-applied if the underlying condition
-- recurs after a resolution (e.g. the same booking becomes overdue
-- again on a later cycle) -- so this table is not immutable the way
-- admin_notes/user_account_history are; it is UPSERT target, not an
-- append-only log. `resolve_exception` (below) upserts by primary key,
-- which is what makes an exact replay of the same resolve call safe.

create or replace function public.resolve_exception(
  p_exception_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_admin_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  insert into public.exception_resolutions (exception_type, entity_type, entity_id, resolved_by, resolved_note)
  values (p_exception_type, p_entity_type, p_entity_id, p_admin_id, p_note)
  on conflict (exception_type, entity_type, entity_id)
  do update set resolved_by = excluded.resolved_by, resolved_note = coalesce(excluded.resolved_note, public.exception_resolutions.resolved_note), resolved_at = public.exception_resolutions.resolved_at;

  v_result := jsonb_build_object('exception_type', p_exception_type, 'entity_type', p_entity_type, 'entity_id', p_entity_id, 'resolved', true);
  return v_result;
end;
$$;

revoke all on function public.resolve_exception(text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_exception(text, text, uuid, uuid, text) to service_role;

-- ─────────────────────────────────────────
-- get_admin_overview_stats — one aggregate query, one round trip.
-- ─────────────────────────────────────────
create or replace function public.get_admin_overview_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles),
    'active_users', (select count(*) from public.profiles where account_status = 'active'),
    'merchants', (select count(*) from public.profiles where role in ('merchant', 'both')),
    'renters', (select count(*) from public.profiles where role in ('renter', 'both')),
    'suspended_users', (select count(*) from public.profiles where account_status = 'suspended'),
    'restricted_users', (select count(*) from public.profiles where account_status = 'restricted'),

    'pending_kyc_reviews', (select count(*) from public.identity_verifications where status in ('pending', 'under_review')),
    'pending_ownership_reviews', (select count(*) from public.listing_ownership_verification where status in ('pending', 'under_review')),
    'pending_listing_moderation', (select count(*) from public.listing_moderation where moderation_status = 'pending'),

    'active_listings', (select count(*) from public.listings where status = 'active'),
    'suspended_listings', (select count(*) from public.listings where status = 'suspended'),

    'requested_bookings', (select count(*) from public.bookings where status = 'requested'),
    'accepted_awaiting_payment_bookings', (
      select count(*) from public.bookings b
      where b.status = 'accepted'
        and not exists (
          select 1 from public.payments p
          where p.booking_id = b.id and p.payment_type = 'rental_charge' and p.status = 'captured'
        )
    ),
    'financially_ready_bookings', (
      select count(*) from public.bookings b
      where b.status = 'accepted'
        and exists (
          select 1 from public.payments p
          where p.booking_id = b.id and p.payment_type = 'rental_charge' and p.status = 'captured'
        )
    ),
    'active_rentals', (select count(*) from public.bookings where status = 'active'),
    'overdue_payment_deadlines', (
      select count(*) from public.bookings
      where status = 'accepted' and payment_due_at is not null and payment_due_at < now() and payment_expired_at is null
    ),

    'failed_financial_workflows', (select count(*) from public.financial_workflows where status in ('failed_retryable', 'failed_terminal')),
    'retryable_email_failures', (select count(*) from public.email_deliveries where status = 'failed_retryable'),

    'generated_at', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_overview_stats() from public, anon, authenticated;
grant execute on function public.get_admin_overview_stats() to service_role;
