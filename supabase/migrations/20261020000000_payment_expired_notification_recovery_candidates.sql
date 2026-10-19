-- ============================================================
-- P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1
--
-- Fixes a starvation defect in recoverMissingPaymentExpiredEmails()
-- (src/lib/email/dispatch-expiry.ts): the prior implementation selected
-- "first 100 expired bookings within a 7-day lookback, ORDER BY
-- payment_expired_at ASC" and only filtered out already-resolved rows
-- IN APPLICATION MEMORY, after that fetch. Because status='expired'
-- and payment_expired_at IS NOT NULL never change once set, an
-- already-fully-resolved booking remains eligible for that same base
-- query forever (until it ages out of the lookback window) -- so under
-- sustained volume the SAME oldest resolved rows can occupy the batch
-- on every tick, starving a genuinely missing newer booking out of the
-- batch entirely, and the old 7-day cutoff could then permanently drop
-- that missing booking from consideration with no other recovery path.
--
-- This RPC moves the "is this genuinely unresolved" predicate to the
-- database, BEFORE any LIMIT is applied, by returning only MISSING
-- RECIPIENT WORK -- one row per (booking, recipient) pair that has no
-- email_deliveries row at all yet -- rather than arbitrary expired
-- bookings. Once a recipient's delivery row is created (by the normal
-- dispatch path, by this recovery path, or by a race between the two),
-- that exact (booking, recipient) tuple no longer satisfies the
-- NOT EXISTS predicate on the next call, so it naturally falls out of
-- the candidate set -- the query is self-draining under backlog with no
-- cursor/checkpoint state needed, and carries no age cutoff at all: an
-- old unresolved row remains a candidate indefinitely, bounded only by
-- LIMIT and deterministic ordering, never by a hard horizon that could
-- silently abandon it.
--
-- Read-only: selects only, never writes to bookings or email_deliveries.
-- Reuses the existing bookings_payment_expired_idx (partial index on
-- payment_expired_at where not null, supabase/migrations/
-- 20260805000001_payment_readiness.sql) for the ordered outer scan, and
-- the existing email_deliveries_entity_idx (related_entity_type,
-- related_entity_id, supabase/migrations/20260807000001_transactional_
-- emails.sql) for the per-booking anti-join lookup -- no new index
-- added; each booking has at most a handful of email_deliveries rows
-- across all event types, so the per-row NOT EXISTS check is cheap and
-- bounded once narrowed by that existing index. No new notification
-- identity is introduced: callers still dispatch through sendTemplate's
-- existing (event_type, booking_id, recipient_user_id, template_version)
-- idempotency key, unchanged.
-- ============================================================

create or replace function public.find_missing_payment_expired_notifications(p_limit integer default 100)
returns table (
  booking_id uuid,
  recipient_role text,
  recipient_user_id uuid,
  payment_expired_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  return query
  select missing.booking_id, missing.recipient_role, missing.recipient_user_id, missing.payment_expired_at
  from (
    select b.id as booking_id, 'renter'::text as recipient_role, b.renter_id as recipient_user_id, b.payment_expired_at
    from public.bookings b
    where b.status = 'expired'
      and b.payment_expired_at is not null
      and not exists (
        select 1
        from public.email_deliveries ed
        where ed.related_entity_type = 'booking'
          and ed.related_entity_id = b.id
          and ed.event_type = 'booking.payment_expired'
          and ed.recipient_user_id = b.renter_id
      )
    union all
    select b.id, 'merchant'::text, b.merchant_id, b.payment_expired_at
    from public.bookings b
    where b.status = 'expired'
      and b.payment_expired_at is not null
      and not exists (
        select 1
        from public.email_deliveries ed
        where ed.related_entity_type = 'booking'
          and ed.related_entity_id = b.id
          and ed.event_type = 'booking.payment_expired'
          and ed.recipient_user_id = b.merchant_id
      )
  ) missing
  order by missing.payment_expired_at asc, missing.booking_id asc, missing.recipient_role asc
  limit greatest(coalesce(p_limit, 100), 1);
end;
$$;

revoke all on function public.find_missing_payment_expired_notifications(integer) from public, anon, authenticated;
grant execute on function public.find_missing_payment_expired_notifications(integer) to service_role;
