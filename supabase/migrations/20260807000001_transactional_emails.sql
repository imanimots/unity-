-- ============================================================
-- Transactional emails (Step 8)
-- ============================================================
-- One delivery-record table, service-role-only, backing a provider-neutral
-- email dispatch service (src/lib/email/). Mutable (unlike the Step 7
-- legal_acceptances audit log) -- a delivery's status genuinely transitions
-- pending -> sent/failed_retryable/failed_terminal, and a retryable
-- failure is re-attempted in place (same row, attempts incremented), never
-- as a fresh duplicate row. Idempotency is a real unique constraint, not
-- just an application-level check -- two concurrent dispatch attempts for
-- the same (event, entity, recipient, template version, occurrence)
-- cannot both insert.
--
-- template_vars stores only the non-sensitive display data actually passed
-- to the template renderer (booking reference, listing title, dates,
-- amounts, display names) -- never raw provider errors, ID/passport
-- numbers, private addresses, ownership-document detail, or payment
-- references. This is what makes retry-failed simple: it re-renders from
-- the stored vars rather than re-deriving fresh context, and enforces
-- "provider retry creates no duplicate delivery record" by updating the
-- same row.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type email_delivery_status as enum ('pending', 'sent', 'failed_retryable', 'failed_terminal');
exception when duplicate_object then null; end $$;

create table if not exists public.email_deliveries (
  id uuid primary key default uuid_generate_v4(),
  event_type text not null,
  template_id text not null,
  template_version text not null,
  recipient_user_id uuid not null references public.profiles(id),
  recipient_email text,
  related_entity_type text not null check (related_entity_type in ('booking', 'listing', 'identity_verification')),
  related_entity_id uuid not null,
  template_vars jsonb not null default '{}'::jsonb,
  provider text,
  provider_message_id text,
  status email_delivery_status not null default 'pending',
  idempotency_key text not null,
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_deliveries_idempotency_key_unique unique (idempotency_key)
);

create index if not exists email_deliveries_recipient_idx on public.email_deliveries(recipient_user_id, created_at);
create index if not exists email_deliveries_entity_idx on public.email_deliveries(related_entity_type, related_entity_id);
create index if not exists email_deliveries_retry_idx on public.email_deliveries(status) where status = 'failed_retryable';

create or replace function public.touch_email_delivery_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists email_deliveries_touch_updated_at on public.email_deliveries;
create trigger email_deliveries_touch_updated_at
  before update on public.email_deliveries
  for each row execute procedure public.touch_email_delivery_updated_at();

alter table public.email_deliveries enable row level security;

create policy "email_deliveries: own read"
  on public.email_deliveries for select
  using (recipient_user_id = auth.uid());

-- No insert/update/delete policy for anon/authenticated -- every write
-- goes through the service-role client inside src/lib/email/service.ts.
-- Internal error detail (last_error) is written here but this table is
-- never rendered directly to a non-admin user -- src/lib/email never
-- exposes last_error to a booking/listing/verification response.

-- ------------------------------------------------------------
-- EXPIRE_UNPAID_ACCEPTED_BOOKINGS -- extended (CREATE OR REPLACE, same
-- signature) to also return the array of booking ids it just expired, so
-- the calling code (src/lib/bookings/lazy-expiry.ts) can dispatch exactly
-- one booking.payment_expired email per newly-expired booking without a
-- second query. Skipped-because-ready bookings are correctly excluded
-- (only bookings that actually transitioned are included). Behaviour is
-- otherwise byte-for-byte unchanged from the Step 6 version.
-- ------------------------------------------------------------
create or replace function public.expire_unpaid_accepted_bookings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_expired_count int := 0;
  v_skipped_ready_count int := 0;
  v_rental_status payment_status;
  v_deposit_status payment_status;
  v_deposit_required boolean;
  v_ready boolean;
  v_expired_ids uuid[] := array[]::uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_row in
    select id, deposit_amount_snapshot from public.bookings
    where status = 'accepted' and payment_due_at is not null and payment_due_at < now()
    for update skip locked
  loop
    select status into v_rental_status from public.payments
      where booking_id = v_row.id and payment_type = 'rental_charge';

    v_deposit_required := coalesce(v_row.deposit_amount_snapshot, 0) > 0;
    if v_deposit_required then
      select status into v_deposit_status from public.payments
        where booking_id = v_row.id and payment_type = 'deposit';
    else
      v_deposit_status := null;
    end if;

    v_ready := (v_rental_status = 'captured') and (not v_deposit_required or v_deposit_status = 'authorised');

    if v_ready then
      v_skipped_ready_count := v_skipped_ready_count + 1;
      continue;
    end if;

    update public.bookings
    set status = 'expired', payment_expired_at = now(), version = version + 1
    where id = v_row.id;

    insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_row.id, null, 'system', 'booking_payment_expired', 'accepted', 'expired', jsonb_build_object('reason', 'payment_deadline_passed'));

    v_expired_count := v_expired_count + 1;
    v_expired_ids := array_append(v_expired_ids, v_row.id);
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'skipped_ready_count', v_skipped_ready_count, 'expired_booking_ids', to_jsonb(v_expired_ids));
end;
$$;
