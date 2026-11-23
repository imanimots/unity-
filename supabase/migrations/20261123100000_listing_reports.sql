-- LISTING REPORTS — "Report Listing" feature (customer-journey P1
-- completion phase, batch 8). Deliberately minimal: a report queue for
-- a human moderator to act on, not a new moderation-action system of
-- its own. Closing a report never itself changes the listing -- an
-- admin who decides action is warranted uses the EXISTING listing
-- moderation path (admin/listings/[id] -> /suspend etc., already live)
-- exactly as the review_reports report queue never itself invalidates
-- a review; it only ever feeds a human decision.
--
-- Modeled directly on public.profile_reports (self-report prevention
-- via a table check) and public.review_reports (status lifecycle,
-- resolved_at/resolved_by/resolution_note, zero client RLS policies,
-- RPC-gated insert) -- not a polymorphic target_type since this report
-- only ever targets a listing.

create table if not exists public.listing_reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles(id),
  listing_id      uuid not null references public.listings(id),
  reason          text not null check (reason in ('prohibited_item', 'misleading_listing', 'scam_fraud', 'counterfeit', 'inappropriate_content', 'other')),
  description     text,
  status          text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  resolved_at     timestamptz,
  resolved_by     uuid references public.profiles(id),
  resolution_note text,
  created_at      timestamptz not null default now()
);

create index if not exists listing_reports_listing_idx on public.listing_reports (listing_id);
create index if not exists listing_reports_status_idx on public.listing_reports (status) where status = 'open';
-- One OPEN report per reporter per listing -- re-reporting an already-open
-- report is a duplicate, not a new signal; a new report after the prior
-- one is resolved is allowed (the listing may have changed since).
create unique index if not exists listing_reports_reporter_listing_open_uidx
  on public.listing_reports (reporter_id, listing_id) where status = 'open';

alter table public.listing_reports enable row level security;
-- Deliberately zero client policies -- admin/service-role visibility
-- only, matching public.profile_reports and public.review_reports'
-- own established precedent exactly.

comment on table public.listing_reports is 'Report Listing feature. Reporting never auto-hides/suspends the listing. Self-report prevention and listing existence are verified server-side in report_listing(), never trusted from the client.';

-- ─────────────────────────────────────────
-- report_listing — authenticated user reports a listing they don't own.
-- ─────────────────────────────────────────
create or replace function public.report_listing(
  p_reporter_id uuid,
  p_listing_id uuid,
  p_reason text,
  p_description text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_report_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reporter_id is null then raise exception 'not authenticated'; end if;
  if p_reason not in ('prohibited_item', 'misleading_listing', 'scam_fraud', 'counterfeit', 'inappropriate_content', 'other') then
    raise exception 'invalid report reason';
  end if;

  select id, merchant_id into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if p_reporter_id = v_listing.merchant_id then raise exception 'you cannot report your own listing'; end if;

  if p_idempotency_key is not null then
    if exists (select 1 from public.idempotency_keys where merchant_id = p_reporter_id and operation = 'report_listing' and idempotency_key = p_idempotency_key) then
      select (result->>'report_id')::uuid into v_report_id from public.idempotency_keys
        where merchant_id = p_reporter_id and operation = 'report_listing' and idempotency_key = p_idempotency_key;
      return jsonb_build_object('report_id', v_report_id);
    end if;
  end if;

  -- An existing OPEN report from this same reporter on this same listing
  -- is a duplicate, not a new signal -- return it rather than erroring,
  -- so a double-submit (e.g. a slow network retry) is harmless.
  select id into v_report_id from public.listing_reports
    where reporter_id = p_reporter_id and listing_id = p_listing_id and status = 'open';
  if v_report_id is not null then
    return jsonb_build_object('report_id', v_report_id, 'already_reported', true);
  end if;

  insert into public.listing_reports (reporter_id, listing_id, reason, description)
  values (p_reporter_id, p_listing_id, p_reason, p_description)
  returning id into v_report_id;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_reporter_id, 'report_listing', p_idempotency_key, md5(p_listing_id::text || p_reason), jsonb_build_object('report_id', v_report_id));
  end if;

  return jsonb_build_object('report_id', v_report_id);
end;
$$;
revoke all on function public.report_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.report_listing(uuid, uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- admin_close_listing_report — dismiss a report, or mark it reviewed
-- (typically after the admin has separately acted on the listing via
-- the existing admin/listings moderation path). Never touches the
-- listing itself.
-- ─────────────────────────────────────────
create or replace function public.admin_close_listing_report(
  p_admin_id uuid,
  p_report_id uuid,
  p_status text,
  p_resolution_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_status not in ('reviewed', 'dismissed') then raise exception 'invalid report status'; end if;

  update public.listing_reports set status = p_status, resolved_at = now(), resolved_by = p_admin_id, resolution_note = p_resolution_note
    where id = p_report_id and status = 'open';
  if not found then raise exception 'report not found or already closed'; end if;

  return jsonb_build_object('report_id', p_report_id, 'status', p_status);
end;
$$;
revoke all on function public.admin_close_listing_report(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_close_listing_report(uuid, uuid, text, text, text) to service_role;
