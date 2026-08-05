-- ============================================================
-- Step 11 Phase 3 -- messages admin read + admin_message_access_log
-- ============================================================
-- messages gets its first admin-read RLS policy (mirrors
-- dispute_evidence: admin read's convention exactly) -- read-only, no
-- admin write policy anywhere, matching Part E/G of the Phase 3 brief.
--
-- admin_message_access_log is the first "an admin *viewed* X" audit
-- table in this codebase -- GET /api/admin/messages (and the retrofitted
-- admin dispute detail page, both via the shared
-- src/lib/messaging/admin.ts service) write one row here before
-- returning any message data, so every admin read of a user's private
-- conversation is a durable, queryable fact. Admin-only read, service-
-- role-only insert (no client insert policy at all -- an admin reading
-- their own access log is a later concern, not required by this
-- phase's brief).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create policy "messages: admin read"
  on public.messages for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

create table if not exists public.admin_message_access_log (
  id uuid primary key default uuid_generate_v4(),
  admin_id uuid not null references public.profiles(id),
  booking_id uuid references public.bookings(id),
  order_id uuid references public.orders(id),
  barter_agreement_id uuid references public.barter_agreements(id),
  dispute_id uuid references public.disputes(id),
  accessed_at timestamptz not null default now(),
  constraint admin_message_access_log_one_transaction_chk check (
    (booking_id is not null and order_id is null and barter_agreement_id is null) or
    (booking_id is null and order_id is not null and barter_agreement_id is null) or
    (booking_id is null and order_id is null and barter_agreement_id is not null)
  )
);

create index if not exists admin_message_access_log_admin_idx on public.admin_message_access_log(admin_id, accessed_at);

alter table public.admin_message_access_log enable row level security;

create policy "admin_message_access_log: admin read"
  on public.admin_message_access_log for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- written only by service-role,
-- and never mutated (an access log entry is a fact, not edited later).
