-- ============================================================
-- Step 11 Phase 3 -- message_thread_presence
-- ============================================================
-- A small heartbeat table, not full presence: chat-thread.tsx upserts
-- its own row on mount and every ~25s while a thread is visible/focused
-- (RLS: a user may only write their own row); the email-notification
-- debounce (src/lib/messaging/notify.ts) checks it first, before
-- falling back to the original "did the recipient send a message here
-- recently" heuristic. Left to expire naturally -- no delete policy, no
-- explicit clear-on-unmount; a stale row simply ages past the debounce
-- window and stops suppressing emails.
--
-- transaction_type/transaction_id (not the exactly-one-of FK-column
-- pattern messages/disputes use) -- this table has no FK referential
-- integrity need (it's an ephemeral signal, nothing else ever joins
-- against it), so a plain composite primary key is simpler and gives a
-- straightforward upsert target.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.message_thread_presence (
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('booking', 'order', 'barter')),
  transaction_id uuid not null,
  last_active_at timestamptz not null default now(),
  primary key (user_id, transaction_type, transaction_id)
);

alter table public.message_thread_presence enable row level security;

create policy "message_thread_presence: own upsert insert"
  on public.message_thread_presence for insert
  with check (user_id = auth.uid());

create policy "message_thread_presence: own upsert update"
  on public.message_thread_presence for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "message_thread_presence: participant read"
  on public.message_thread_presence for select
  using (
    (transaction_type = 'booking' and exists (
      select 1 from public.bookings b where b.id = transaction_id and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
    ))
    or (transaction_type = 'order' and exists (
      select 1 from public.orders o where o.id = transaction_id and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    ))
    or (transaction_type = 'barter' and exists (
      select 1 from public.barter_agreements ba where ba.id = transaction_id and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
    ))
  );
