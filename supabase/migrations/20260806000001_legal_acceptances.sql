-- ============================================================
-- Legal acceptances (Step 7)
-- ============================================================
-- Minimal, append-only audit log of which policy versions a user accepted
-- and where. Deliberately generic rather than a dedicated table per
-- consent point -- listing submission already has its own, richer
-- declaration mechanism (listing_declarations, 20260729000003) which is
-- reused unchanged for that checkpoint; this table covers the four
-- checkpoints that had no existing mechanism: registration, booking
-- request, checkout, and identity-verification submission.
--
-- user_id is always the server-verified session user (getRequestProfile())
-- -- never client-supplied. policy_version is always resolved server-side
-- from the legal registry (src/lib/legal/registry.ts) at accept time --
-- never accepted from the request body -- so a forged version string
-- cannot be recorded. There is no anon/authenticated write policy at all;
-- every insert goes through POST /api/legal/accept using the service-role
-- client, mirroring the trust boundary already established for bookings/
-- listings (see docs/BOOKING_LIFECYCLE.md "RLS and RPC trust boundary").
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.legal_acceptances (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id),
  policy_slug text not null,
  policy_version text not null,
  context text not null check (context in ('registration', 'booking_request', 'checkout', 'verification')),
  created_at timestamptz not null default now()
);

create index if not exists legal_acceptances_user_idx on public.legal_acceptances(user_id, policy_slug, created_at);

alter table public.legal_acceptances enable row level security;

create policy "legal_acceptances: own read"
  on public.legal_acceptances for select
  using (user_id = auth.uid());

-- No insert/update/delete policy for anon/authenticated -- written only by
-- POST /api/legal/accept via the service-role client. Reuses the existing
-- prevent_row_mutation() function (20260729000003_listing_declarations_and_history.sql)
-- rather than redefining it, so no update/delete is possible for any role,
-- service_role included -- an accepted record can never be altered.
drop trigger if exists prevent_legal_acceptances_mutation on public.legal_acceptances;
create trigger prevent_legal_acceptances_mutation
  before update or delete on public.legal_acceptances
  for each row execute procedure public.prevent_row_mutation();
