-- ============================================================
-- Phase 4 -- widen messages for marketplace request/offer chat.
-- ============================================================
-- Mirrors the booking_id/order_id/barter_agreement_id widening pattern
-- exactly (20260813000001) -- same exact-one-of CHECK shape, extended
-- to a 4th branch. Reuses 100% of the existing real-chat
-- infrastructure (GET/POST /api/messages, chat-thread.tsx, Realtime) --
-- not a parallel messaging system.
--
-- Linked to the OFFER, not the request directly: a request can have
-- many responders, each needing their own private 1:1 thread with the
-- requester -- an offer row is the natural, already-unique (request,
-- responder) anchor. "Message Requester" (Step F path 3) creates a
-- message_only-type offer purely to anchor the conversation -- it
-- carries no commercial terms and needs no separate linkage mechanism.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.messages
  add column if not exists marketplace_offer_id uuid references public.marketplace_request_offers(id);

alter table public.messages drop constraint if exists messages_one_transaction_chk;
alter table public.messages add constraint messages_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and marketplace_offer_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and marketplace_offer_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and marketplace_offer_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and marketplace_offer_id is not null)
);

create index if not exists messages_marketplace_offer_idx on public.messages(marketplace_offer_id);

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
  or exists (
    select 1 from public.marketplace_request_offers o
    join public.marketplace_requests r on r.id = o.request_id
    where o.id = messages.marketplace_offer_id
      and (o.responder_id = auth.uid() or r.requester_id = auth.uid())
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
    or exists (
      select 1 from public.marketplace_request_offers o
      join public.marketplace_requests r on r.id = o.request_id
      where o.id = messages.marketplace_offer_id
        and (o.responder_id = auth.uid() or r.requester_id = auth.uid())
    )
  )
);
