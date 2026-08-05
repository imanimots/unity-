-- ============================================================
-- Step 11 Phase 1 -- widen messages/disputes for barter_agreement_id
-- ============================================================
-- Mirrors the booking_id/order_id widening already done twice
-- (20260720000003_buying_selling_schema.sql) -- same exact-one-of CHECK
-- shape, extended to a third transaction type.
--
-- messages: read AND write RLS extended to barter parties -- Phase 3
-- (Real Chat) inserts real barter messages via session-client writes
-- (RLS is the enforcement layer for this table, not an RPC).
--
-- disputes: read RLS extended to barter parties, INSERT policy is left
-- untouched (booking/order branches only). A client attempting to
-- insert a barter-flavored dispute row would still fail the existing
-- "disputes: parties insert" with_check clause (it has no barter
-- branch) even though the new CHECK constraint would permit the row
-- shape -- this is intentional. Dispute creation for barter agreements
-- is deferred to Phase 2's trusted RPC-based workflow.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ── messages ──────────────────────────────────────────────

alter table public.messages
  add column if not exists barter_agreement_id uuid references public.barter_agreements(id);

alter table public.messages drop constraint if exists messages_one_transaction_chk;
alter table public.messages add constraint messages_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null)
);

create index if not exists messages_barter_agreement_idx on public.messages(barter_agreement_id);

drop policy if exists "messages: parties read" on public.messages;
create policy "messages: parties read" on public.messages for select using (
  exists (
    select 1 from public.bookings
    where bookings.id = messages.booking_id
      and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
  )
  or exists (
    select 1 from public.orders
    where orders.id = messages.order_id
      and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
  )
  or exists (
    select 1 from public.barter_agreements
    where barter_agreements.id = messages.barter_agreement_id
      and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
  )
);

drop policy if exists "messages: parties send" on public.messages;
create policy "messages: parties send" on public.messages for insert with check (
  sender_id = auth.uid()
  and (
    exists (
      select 1 from public.bookings
      where bookings.id = messages.booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
    or exists (
      select 1 from public.orders
      where orders.id = messages.order_id
        and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
    )
    or exists (
      select 1 from public.barter_agreements
      where barter_agreements.id = messages.barter_agreement_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  )
);

-- ── disputes ──────────────────────────────────────────────

alter table public.disputes
  add column if not exists barter_agreement_id uuid references public.barter_agreements(id);

alter table public.disputes drop constraint if exists disputes_one_transaction_chk;
alter table public.disputes add constraint disputes_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null)
);

create index if not exists disputes_barter_agreement_idx on public.disputes(barter_agreement_id);

drop policy if exists "disputes: parties read" on public.disputes;
create policy "disputes: parties read" on public.disputes for select using (
  raised_by = auth.uid()
  or exists (
    select 1 from public.bookings
    where bookings.id = disputes.booking_id
      and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
  )
  or exists (
    select 1 from public.orders
    where orders.id = disputes.order_id
      and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
  )
  or exists (
    select 1 from public.barter_agreements
    where barter_agreements.id = disputes.barter_agreement_id
      and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
  )
);

-- "disputes: parties insert" is intentionally left unchanged (see header comment).
