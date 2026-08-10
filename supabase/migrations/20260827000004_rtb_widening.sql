-- ============================================================
-- Phase 5 -- Rent-to-Buy: additive widening of existing shared tables.
-- ============================================================
-- Buy/Rent/Barter are NOT redesigned -- every change here is the same
-- additive exactly-one-of-CHECK-widening pattern already used three
-- times in this codebase (messages/disputes/payments each already
-- went booking+order -> +barter -> [messages already +marketplace_offer
-- in Phase 4]). Adding a 5th/4th branch here follows that exact
-- precedent; nothing about an existing branch changes.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ── marketplace_requests.transaction_type ────────────────────
-- This is the exact widening Phase 4's own extensibility self-test
-- (Step AM) predicted: a plain text CHECK, not a coupled enum, so a 4th
-- value needs only this one constraint change -- no change to
-- marketplace_direction, the offers table, URL params, matching, or
-- accept_marketplace_offer's overall branching shape (only a new branch
-- added to it, in the RPC migration).
alter table public.marketplace_requests drop constraint if exists marketplace_requests_transaction_type_check;
alter table public.marketplace_requests add constraint marketplace_requests_transaction_type_check
  check (transaction_type in ('buy', 'rent', 'barter', 'rent_to_buy'));

-- ── messages ──────────────────────────────────────────────────
alter table public.messages add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

alter table public.messages drop constraint if exists messages_one_transaction_chk;
alter table public.messages add constraint messages_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and marketplace_offer_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and marketplace_offer_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and marketplace_offer_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and marketplace_offer_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and marketplace_offer_id is null and rent_to_buy_agreement_id is not null)
);

create index if not exists messages_rtb_agreement_idx on public.messages(rent_to_buy_agreement_id);

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
  or exists (
    select 1 from public.rent_to_buy_agreements a
    where a.id = messages.rent_to_buy_agreement_id
      and (a.merchant_id = auth.uid() or a.customer_id = auth.uid())
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
    or exists (
      select 1 from public.rent_to_buy_agreements a
      where a.id = messages.rent_to_buy_agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid())
    )
  )
);

-- ── disputes ──────────────────────────────────────────────────
alter table public.disputes add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

alter table public.disputes drop constraint if exists disputes_one_transaction_chk;
alter table public.disputes add constraint disputes_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is not null)
);

create index if not exists disputes_rtb_agreement_idx on public.disputes(rent_to_buy_agreement_id);

create or replace function public.is_dispute_participant(p_dispute_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.disputes d
    left join public.bookings b on b.id = d.booking_id
    left join public.orders o on o.id = d.order_id
    left join public.barter_agreements ba on ba.id = d.barter_agreement_id
    left join public.rent_to_buy_agreements rtb on rtb.id = d.rent_to_buy_agreement_id
    where d.id = p_dispute_id
      and (
        d.raised_by = p_user_id
        or b.renter_id = p_user_id or b.merchant_id = p_user_id
        or o.buyer_id = p_user_id or o.seller_id = p_user_id
        or ba.party_a_id = p_user_id or ba.party_b_id = p_user_id
        or rtb.merchant_id = p_user_id or rtb.customer_id = p_user_id
      )
  );
$$;

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
  or exists (
    select 1 from public.rent_to_buy_agreements a
    where a.id = disputes.rent_to_buy_agreement_id
      and (a.merchant_id = auth.uid() or a.customer_id = auth.uid())
  )
);

-- open_dispute() widened for the RTB branch. CREATE OR REPLACE alone is
-- NOT safe here -- adding a parameter (even appended at the end)
-- changes the type signature and Postgres would keep the old 9-param
-- version as a live, ambiguity-causing second overload (the exact bug
-- class found and fixed in Phase 4, 20260826000005). The old signature
-- is dropped explicitly first. Body is otherwise byte-identical to the
-- current authoritative version (20260824000001) -- same validation
-- order, same pre_dispute_status capture, same dispute_history/
-- idempotency_keys shape -- with one new elsif branch for
-- p_rent_to_buy_agreement_id mirroring the barter branch exactly.
drop function if exists public.open_dispute(uuid, uuid, uuid, uuid, text, text, text, text, text);

create or replace function public.open_dispute(
  p_raiser_user_id uuid,
  p_booking_id uuid default null,
  p_order_id uuid default null,
  p_barter_agreement_id uuid default null,
  p_rent_to_buy_agreement_id uuid default null,
  p_title text default null,
  p_reason text default null,
  p_description text default null,
  p_requested_resolution text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute_id uuid;
  v_reference_count int;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_booking record;
  v_order record;
  v_agreement record;
  v_rtb record;
  v_respondent_id uuid;
  v_pre_dispute_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_raiser_user_id is null then
    raise exception 'raiser is required';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'description is required';
  end if;
  if p_requested_resolution is null or length(trim(p_requested_resolution)) = 0 then
    raise exception 'requested resolution is required';
  end if;

  v_reference_count := (case when p_booking_id is not null then 1 else 0 end)
    + (case when p_order_id is not null then 1 else 0 end)
    + (case when p_barter_agreement_id is not null then 1 else 0 end)
    + (case when p_rent_to_buy_agreement_id is not null then 1 else 0 end);
  if v_reference_count <> 1 then
    raise exception 'exactly one of booking_id, order_id, barter_agreement_id, or rent_to_buy_agreement_id is required';
  end if;

  v_request_hash := md5(
    coalesce(p_booking_id::text, '') || '|' || coalesce(p_order_id::text, '') || '|' || coalesce(p_barter_agreement_id::text, '') || '|' ||
    coalesce(p_rent_to_buy_agreement_id::text, '') || '|' ||
    coalesce(p_title, '') || '|' || coalesce(p_reason, '') || '|' || coalesce(p_description, '') || '|' || coalesce(p_requested_resolution, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_raiser_user_id and operation = 'open_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if p_booking_id is not null then
    select id, renter_id, merchant_id, status::text into v_booking from public.bookings where id = p_booking_id for update;
    if v_booking.id is null then
      raise exception 'booking not found';
    end if;
    if v_booking.renter_id <> p_raiser_user_id and v_booking.merchant_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this booking';
    end if;
    v_respondent_id := case when v_booking.renter_id = p_raiser_user_id then v_booking.merchant_id else v_booking.renter_id end;
    if exists (select 1 from public.disputes where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this booking';
    end if;
    v_pre_dispute_status := v_booking.status;
    update public.bookings set status = 'disputed' where id = p_booking_id;
  elsif p_order_id is not null then
    select id, buyer_id, seller_id, status::text into v_order from public.orders where id = p_order_id for update;
    if v_order.id is null then
      raise exception 'order not found';
    end if;
    if v_order.buyer_id <> p_raiser_user_id and v_order.seller_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this order';
    end if;
    v_respondent_id := case when v_order.buyer_id = p_raiser_user_id then v_order.seller_id else v_order.buyer_id end;
    if exists (select 1 from public.disputes where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this order';
    end if;
    v_pre_dispute_status := v_order.status;
    update public.orders set status = 'disputed' where id = p_order_id;
  elsif p_barter_agreement_id is not null then
    select id, party_a_id, party_b_id, status::text into v_agreement from public.barter_agreements where id = p_barter_agreement_id for update;
    if v_agreement.id is null then
      raise exception 'barter agreement not found';
    end if;
    if v_agreement.party_a_id <> p_raiser_user_id and v_agreement.party_b_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this barter agreement';
    end if;
    v_respondent_id := case when v_agreement.party_a_id = p_raiser_user_id then v_agreement.party_b_id else v_agreement.party_a_id end;
    if exists (select 1 from public.disputes where barter_agreement_id = p_barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this barter agreement';
    end if;
    v_pre_dispute_status := v_agreement.status;
    update public.barter_agreements set status = 'disputed' where id = p_barter_agreement_id;
  else
    select id, merchant_id, customer_id, status::text into v_rtb from public.rent_to_buy_agreements where id = p_rent_to_buy_agreement_id for update;
    if v_rtb.id is null then
      raise exception 'rent-to-buy agreement not found';
    end if;
    if v_rtb.merchant_id <> p_raiser_user_id and v_rtb.customer_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this rent-to-buy agreement';
    end if;
    v_respondent_id := case when v_rtb.merchant_id = p_raiser_user_id then v_rtb.customer_id else v_rtb.merchant_id end;
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this rent-to-buy agreement';
    end if;
    v_pre_dispute_status := v_rtb.status;
    update public.rent_to_buy_agreements set status = 'disputed' where id = p_rent_to_buy_agreement_id;
  end if;

  insert into public.disputes (
    booking_id, order_id, barter_agreement_id, rent_to_buy_agreement_id, raised_by, title, reason, description, requested_resolution, status, pre_dispute_status
  ) values (
    p_booking_id, p_order_id, p_barter_agreement_id, p_rent_to_buy_agreement_id, p_raiser_user_id, p_title, p_reason, p_description, p_requested_resolution, 'open', v_pre_dispute_status
  )
  returning id into v_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (v_dispute_id, p_raiser_user_id, 'raiser', 'dispute_opened', null, 'open', p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', v_dispute_id, 'status', 'open', 'respondent_id', v_respondent_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_raiser_user_id, 'open_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.open_dispute(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.open_dispute(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text) to service_role;

-- ── payments ──────────────────────────────────────────────────
alter table public.payments add column if not exists rent_to_buy_agreement_id uuid references public.rent_to_buy_agreements(id);

alter table public.payments drop constraint if exists payments_one_transaction_chk;
alter table public.payments add constraint payments_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is not null)
);

-- Deliberately NO (rent_to_buy_agreement_id, payment_type) uniqueness
-- constraint like barter's -- unlike a one-time barter deposit/cash
-- adjustment, 'rent_to_buy_installment' legitimately repeats many times
-- for the same agreement (once per settled instalment). Uniqueness for
-- installment payments is instead enforced one layer up, by
-- rent_to_buy_installments' own (agreement_id, sequence) uniqueness and
-- its payment_id link (set exactly once per instalment row). The
-- deposit type genuinely is "at most once per agreement", so it alone
-- gets a partial unique index.
create unique index if not exists payments_rtb_deposit_unique on public.payments(rent_to_buy_agreement_id)
  where payment_type = 'rent_to_buy_deposit' and rent_to_buy_agreement_id is not null;

create index if not exists payments_rtb_agreement_idx on public.payments(rent_to_buy_agreement_id);

-- ── email_deliveries ──────────────────────────────────────────
alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;
alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile', 'merchant_payout', 'merchant_subscription', 'unity_commission', 'escrow_transaction', 'marketplace_request', 'rent_to_buy_agreement'])
);
