-- ============================================================
-- Step 11 Phase 2 -- disputes table hardening
-- ============================================================
-- Adds the columns the generic dispute lifecycle needs (title,
-- description, requested_resolution, assignment, outcome, and full
-- resolve/close/cancel/evidence-request timestamps + actors).
--
-- outcome uses generic values (favor_raiser/favor_respondent/
-- mutual_agreement/manual_settlement), not literal "merchant_wins"/
-- "customer_wins" -- barter has no merchant/customer distinction, just
-- two peer parties. UI copy maps favor_respondent -> "Merchant wins" /
-- favor_raiser -> "Customer wins" for booking/order framing, and
-- party-neutral language for barter -- one schema, domain-appropriate
-- display labels, no future migration needed to fix this for barter.
--
-- Drops "disputes: parties insert" -- dispute creation moves fully to
-- the open_dispute() RPC (migration 20260814000006), which is
-- idempotency-keyed and validates the raiser is a real party server-
-- side; the old policy let any party insert a raw row via RLS alone
-- with zero validation beyond party membership and zero idempotency.
-- After this migration, disputes has ZERO client write policies at
-- all -- matches barter_agreements' fully RPC-gated model exactly, and
-- is simpler than layering a privileged-fields trigger on top of a
-- policy that shouldn't exist anymore. The existing "disputes: parties
-- read" policy (extended for barter in Phase 1) is untouched.
--
-- reason/evidence_urls/resolution_notes are left in place, untouched --
-- reason is now used as the free-text detail the raiser gives at open
-- time (see open_dispute()'s p_description maps here... no: see
-- migration 6 -- reason stores p_reason, description stores the new
-- longer field); evidence_urls is superseded-but-not-removed by the new
-- dispute_evidence table (migration 5); resolution_notes is reused
-- as-is for the admin's final resolution notes.
--
-- disputes had 0 live rows at the time this migration was written
-- (confirmed via a live count query) so every new NOT NULL column is
-- safe with no backfill.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.disputes
  add column if not exists title text not null default '',
  add column if not exists description text not null default '',
  add column if not exists requested_resolution text not null default '',
  add column if not exists assigned_admin_id uuid references public.profiles(id),
  add column if not exists outcome text check (outcome in ('favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement')),
  add column if not exists resolved_by uuid references public.profiles(id),
  add column if not exists resolved_at timestamptz,
  add column if not exists closed_by uuid references public.profiles(id),
  add column if not exists closed_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists evidence_requested_by uuid references public.profiles(id),
  add column if not exists evidence_requested_at timestamptz,
  add column if not exists evidence_request_note text,
  add column if not exists updated_at timestamptz not null default now();

-- title/description/requested_resolution get a real value from
-- open_dispute() on every future insert -- the '' default only exists
-- to satisfy NOT NULL on a column add against a table that (harmlessly)
-- already has 0 rows; drop the default now so a future direct insert
-- (there shouldn't be one, RPC-only) can't silently succeed with blanks.
alter table public.disputes alter column title drop default;
alter table public.disputes alter column description drop default;
alter table public.disputes alter column requested_resolution drop default;

create or replace function public.touch_dispute_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists disputes_touch_updated_at on public.disputes;
create trigger disputes_touch_updated_at
  before update on public.disputes
  for each row execute function public.touch_dispute_updated_at();

drop policy if exists "disputes: parties insert" on public.disputes;
