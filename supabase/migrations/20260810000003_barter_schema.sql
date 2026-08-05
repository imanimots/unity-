-- ============================================================
-- Barter marketplace (Phase 4) — core schema
-- ============================================================
-- barter_agreements / barter_offers / barter_offer_items /
-- barter_confirmations / barter_history / barter_locked_listings.
--
-- One barter_agreements row per negotiation thread, never re-created for
-- a counter-offer -- its id is what chat, disputes, payments, and history
-- all link to. The actual negotiated *content* (which listings each side
-- offers, cash adjustment, delivery, deposit terms, message) lives in
-- barter_offers, one row per version, each a complete replacement
-- package -- a counter is never a partial patch. accepted_offer_id is
-- set exactly once by accept_barter_offer() and never changes again,
-- which is what makes accepted terms immutable. See the plan doc
-- (Barter Marketplace MVP Implementation Plan) for the full design
-- rationale -- this migration is schema only, RPCs land in
-- 20260810000011_barter_rpcs.sql once payments/disputes widening exist.
-- ============================================================

create or replace function public.generate_barter_reference()
returns text
language sql
as $$
  select 'BT-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
$$;

-- ─────────────────────────────────────────
-- barter_agreements
-- ─────────────────────────────────────────
create table public.barter_agreements (
  id                      uuid primary key default uuid_generate_v4(),
  agreement_reference     text unique not null default public.generate_barter_reference(),

  -- The listing whose detail page the "Propose Trade" flow was opened
  -- from -- informational context only, not necessarily part of the
  -- final offered item set (a counter may ask for a different or wider
  -- combination of party_a's listings than just this one).
  anchor_listing_id       uuid not null references public.listings(id),

  -- party_a = the anchor listing's owner at proposal time; party_b = the
  -- proposer. Both fixed for the life of the agreement -- a barter is
  -- always exactly two parties (no multi-party support, per spec).
  party_a_id              uuid not null references public.profiles(id),
  party_b_id              uuid not null references public.profiles(id),

  status                  barter_status not null default 'proposed',

  -- FKs added below once barter_offers exists.
  current_offer_id        uuid,
  accepted_offer_id       uuid,

  version                 int not null default 1,

  -- Reversible admin suspend -- distinct from force-cancel (terminal).
  -- Every party-initiated RPC checks this immediately after loading the
  -- row and rejects while it's set.
  admin_hold              boolean not null default false,
  admin_hold_reason       text,

  proposed_at             timestamptz not null default now(),
  accepted_at             timestamptz,
  rejected_at             timestamptz,
  rejected_by             uuid references public.profiles(id),
  rejection_reason        text,
  cancelled_at            timestamptz,
  cancelled_by            uuid references public.profiles(id),
  cancellation_reason     text,
  -- 'refunded' | 'frozen_pending_dispute' | 'not_applicable' -- see the
  -- cancellation-settlement heuristic in the plan doc (kept as free text
  -- rather than an enum since it's a small, RPC-internal vocabulary that
  -- doesn't need a real Postgres type the way barter_status does).
  cancellation_settlement text,

  -- Deadline for a response to the current pending offer. Recomputed by
  -- propose_barter (initial) and reset by every valid counter_barter_offer
  -- call -- each round of negotiation gets its own full response window.
  -- No longer consulted once status leaves ('proposed','countered').
  expires_at              timestamptz,

  completed_at            timestamptz,
  disputed_at             timestamptz,

  updated_at              timestamptz not null default now(),

  constraint barter_agreements_parties_distinct_chk check (party_a_id <> party_b_id)
);

create index barter_agreements_party_a_idx    on public.barter_agreements(party_a_id, status);
create index barter_agreements_party_b_idx    on public.barter_agreements(party_b_id, status);
create index barter_agreements_anchor_idx     on public.barter_agreements(anchor_listing_id);
create index barter_agreements_status_idx     on public.barter_agreements(status);
create index barter_agreements_expires_idx    on public.barter_agreements(expires_at) where status in ('proposed', 'countered');
create index barter_agreements_reference_idx  on public.barter_agreements(agreement_reference);

create or replace function public.touch_barter_agreement_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger barter_agreements_touch_updated_at
  before update on public.barter_agreements
  for each row execute procedure public.touch_barter_agreement_updated_at();

-- ─────────────────────────────────────────
-- barter_offers -- one row per negotiation round, full replacement
-- package (never a partial diff against the previous version).
-- ─────────────────────────────────────────
create table public.barter_offers (
  id                     uuid primary key default uuid_generate_v4(),
  agreement_id           uuid not null references public.barter_agreements(id) on delete cascade,
  version                int not null,
  proposed_by            uuid not null references public.profiles(id),
  status                 text not null default 'pending' check (status in ('pending', 'accepted', 'superseded', 'rejected', 'withdrawn')),

  cash_adjustment_amount numeric(12,2) not null default 0 check (cash_adjustment_amount >= 0),
  cash_adjustment_payer  uuid references public.profiles(id),

  -- Physical-item delivery only -- 'digital_delivery'/'on_site_service'
  -- are service-oriented and out of scope for Item<->Item MVP barter.
  delivery_method        text not null check (delivery_method in ('meet_in_person', 'courier', 'self_collection', 'other')),
  delivery_notes         text,
  -- Who executes the chosen delivery method -- distinct from the method
  -- itself (e.g. delivery_method='courier', delivery_responsibility=
  -- 'party_a' means party A arranges/pays the courier).
  delivery_responsibility text check (delivery_responsibility in ('party_a', 'party_b', 'shared', 'each_handles_own', 'not_applicable')),

  deposit_required       boolean not null default false,
  deposit_amount         numeric(12,2),
  deposit_currency       text not null default 'ZAR',
  deposit_payer          text check (deposit_payer in ('party_a', 'party_b', 'both')),

  message                text,
  created_at             timestamptz not null default now(),

  unique (agreement_id, version),

  constraint barter_offers_deposit_chk check (
    (deposit_required = false and deposit_amount is null and deposit_payer is null)
    or (deposit_required = true and deposit_amount is not null and deposit_amount > 0 and deposit_payer is not null)
  ),
  constraint barter_offers_cash_adjustment_chk check (
    (cash_adjustment_amount = 0 and cash_adjustment_payer is null)
    or (cash_adjustment_amount > 0 and cash_adjustment_payer is not null)
  )
);

create index barter_offers_agreement_idx on public.barter_offers(agreement_id, version);

alter table public.barter_agreements
  add constraint barter_agreements_current_offer_fk  foreign key (current_offer_id)  references public.barter_offers(id),
  add constraint barter_agreements_accepted_offer_fk foreign key (accepted_offer_id) references public.barter_offers(id);

-- ─────────────────────────────────────────
-- barter_offer_items -- N listings per side per offer version. Item<->Item
-- only (MVP scope decision) -- no service arm on this table by design.
-- ─────────────────────────────────────────
create table public.barter_offer_items (
  id          uuid primary key default uuid_generate_v4(),
  offer_id    uuid not null references public.barter_offers(id) on delete cascade,
  listing_id  uuid not null references public.listings(id),
  -- Which party is contributing this listing -- validated at RPC time to
  -- actually match listings.merchant_id, never trusted from the client.
  offered_by  uuid not null references public.profiles(id),
  created_at  timestamptz not null default now(),

  unique (offer_id, listing_id)
);

create index barter_offer_items_offer_idx    on public.barter_offer_items(offer_id);
create index barter_offer_items_listing_idx  on public.barter_offer_items(listing_id);

-- ─────────────────────────────────────────
-- barter_confirmations -- one row per party per agreement. Completion
-- only occurs once both rows exist. confirmation_note/user_agent_category
-- are the privacy-minimal completion-evidence variant (POPIA-conscious --
-- no IP address, raw or hashed, is ever captured).
-- ─────────────────────────────────────────
create table public.barter_confirmations (
  id                  uuid primary key default uuid_generate_v4(),
  agreement_id        uuid not null references public.barter_agreements(id) on delete cascade,
  party_id            uuid not null references public.profiles(id),
  confirmation_note   text,
  user_agent_category text check (user_agent_category in ('mobile', 'desktop', 'unknown')),
  confirmed_at        timestamptz not null default now(),

  unique (agreement_id, party_id)
);

create index barter_confirmations_agreement_idx on public.barter_confirmations(agreement_id);

-- ─────────────────────────────────────────
-- barter_history -- append-only audit trail, same shape and the same
-- shared immutability trigger as booking_history. Full-row party read --
-- unlike identity_verification_history there's no admin-only-vs-party-
-- safe split needed here, every barter event type is already safe for
-- both parties to see (admin-authored events like force-cancel/dispute
-- resolution just write actor_role='admin').
-- ─────────────────────────────────────────
create table public.barter_history (
  id              uuid primary key default uuid_generate_v4(),
  agreement_id    uuid not null references public.barter_agreements(id) on delete cascade,
  actor_user_id   uuid references public.profiles(id),
  actor_role      text check (actor_role in ('party_a', 'party_b', 'system', 'admin')),
  event_type      text not null,
  previous_status barter_status,
  new_status      barter_status not null,
  metadata        jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index barter_history_agreement_idx on public.barter_history(agreement_id, created_at);

alter table public.barter_history enable row level security;

create policy "barter_history: parties read"
  on public.barter_history for select
  using (
    exists (
      select 1 from public.barter_agreements
      where barter_agreements.id = barter_history.agreement_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );

-- Reuses the existing prevent_row_mutation() function, defined once in
-- 20260729000003_listing_declarations_and_history.sql -- not redefined.
create trigger prevent_barter_history_mutation
  before update or delete on public.barter_history
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- barter_agreements / barter_offers / barter_offer_items / barter_confirmations
-- RLS: select-only for parties, zero client write policies -- every
-- mutation goes through a service-role RPC (20260810000011_barter_rpcs.sql),
-- exactly like bookings/booking_history/idempotency_keys.
-- ─────────────────────────────────────────
alter table public.barter_agreements  enable row level security;
alter table public.barter_offers      enable row level security;
alter table public.barter_offer_items enable row level security;
alter table public.barter_confirmations enable row level security;

create policy "barter_agreements: parties read"
  on public.barter_agreements for select
  using (party_a_id = auth.uid() or party_b_id = auth.uid());

create policy "barter_offers: parties read"
  on public.barter_offers for select
  using (
    exists (
      select 1 from public.barter_agreements
      where barter_agreements.id = barter_offers.agreement_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );

create policy "barter_offer_items: parties read"
  on public.barter_offer_items for select
  using (
    exists (
      select 1 from public.barter_offers
      join public.barter_agreements on barter_agreements.id = barter_offers.agreement_id
      where barter_offers.id = barter_offer_items.offer_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );

create policy "barter_confirmations: parties read"
  on public.barter_confirmations for select
  using (
    exists (
      select 1 from public.barter_agreements
      where barter_agreements.id = barter_confirmations.agreement_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────
-- barter_locked_listings -- live view, not a listings.status value or
-- boolean column. A listing is locked iff it's in the ACCEPTED offer's
-- item list of a NON-TERMINAL agreement. Nothing locks while an
-- agreement is merely proposed/countered. Unlocking is automatic: the
-- moment status reaches a terminal value for any reason, the view stops
-- matching -- no explicit "unlock" step exists anywhere.
--
-- Public select grant is intentional -- it reveals only listing_id/
-- agreement_id, no more sensitive than a listing's own public status.
-- ─────────────────────────────────────────
create view public.barter_locked_listings as
select boi.listing_id, ba.id as agreement_id
from public.barter_offer_items boi
join public.barter_offers bo on bo.id = boi.offer_id
join public.barter_agreements ba on ba.id = bo.agreement_id
where bo.id = ba.accepted_offer_id
  and ba.status not in ('completed', 'cancelled', 'rejected', 'expired');

grant select on public.barter_locked_listings to anon, authenticated;
