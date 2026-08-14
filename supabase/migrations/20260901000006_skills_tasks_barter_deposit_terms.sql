-- ============================================================
-- Skills + Tasks under Barter -- multi-party deposit terms.
-- ============================================================
-- Additive alongside the EXISTING singular barter_offers.deposit_
-- amount/deposit_payer/deposit_required fields, which are NOT
-- touched, repurposed, or removed -- they remain the live path for
-- item-only (or any offer not needing independent per-party amounts
-- or milestone-linked release) exactly as they work today. This
-- table is authoritative only for an offer that actually has rows
-- here; the legacy-vs-new mutual-exclusivity invariant is enforced
-- in propose_barter()/counter_barter_offer() (the only write path),
-- which explicitly nulls the legacy fields when these rows exist.
-- ============================================================

create table public.barter_deposit_terms (
  id              uuid primary key default gen_random_uuid(),
  offer_id        uuid not null references public.barter_offers(id) on delete restrict,
  payer_id        uuid not null references public.profiles(id),
  amount          numeric(12,2) not null check (amount > 0),
  currency        text not null default 'ZAR',
  release_basis   text not null check (release_basis in ('full_on_completion', 'milestone_weighted')),
  created_at      timestamptz not null default now(),

  unique (offer_id, payer_id)
);

create index barter_deposit_terms_offer_idx on public.barter_deposit_terms(offer_id);

-- No third-party payer -- payer_id must be one of the offer's own
-- agreement parties. Expressed as a trigger (not a plain CHECK)
-- since it requires a join through barter_offers -> barter_agreements.
create or replace function public.validate_barter_deposit_term_payer()
returns trigger
language plpgsql
as $$
declare
  v_agreement_id uuid;
  v_party_a uuid;
  v_party_b uuid;
begin
  select ba.id, ba.party_a_id, ba.party_b_id into v_agreement_id, v_party_a, v_party_b
  from public.barter_offers bo
  join public.barter_agreements ba on ba.id = bo.agreement_id
  where bo.id = new.offer_id;

  if new.payer_id <> v_party_a and new.payer_id <> v_party_b then
    raise exception 'deposit payer must be a party to the agreement';
  end if;

  return new;
end;
$$;

create trigger barter_deposit_terms_validate_payer
  before insert on public.barter_deposit_terms
  for each row execute procedure public.validate_barter_deposit_term_payer();

alter table public.barter_deposit_terms enable row level security;

create policy "barter_deposit_terms: participants read"
  on public.barter_deposit_terms for select
  using (exists (
    select 1 from public.barter_offers bo
    join public.barter_agreements ba on ba.id = bo.agreement_id
    where bo.id = offer_id and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
  ));

-- Zero client write policies -- fully RPC-gated.
