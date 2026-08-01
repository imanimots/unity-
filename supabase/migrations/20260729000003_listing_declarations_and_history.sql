-- ============================================================
-- Listing declarations + history — schema design (Phase 0, schema only)
-- ============================================================
-- Two append-only, immutable audit tables:
--   - listing_declarations: the versioned legal record of what a merchant
--     accepted at listing-submission time (ownership authority, condition
--     accuracy, etc).
--   - listing_history: a general change log for listing rows, for merchant
--     transparency and dispute resolution.
-- Both are write-once by design — enforced with a hard BEFORE UPDATE OR
-- DELETE trigger that unconditionally raises, not just an RLS gap. Neither
-- table has an INSERT policy for anon/authenticated: rows are written by a
-- future server-side listing-mutation service using the service_role
-- client (which bypasses RLS), not by a database trigger. A blanket
-- "log every update" trigger was deliberately rejected — it would capture
-- every column touch with no business context (why the change happened),
-- which is worse than no log for dispute resolution. That service is not
-- built in this pass; this migration only prepares the tables it will
-- write to. No application code has been built against this yet.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

do $$ begin
  create type declaration_type as enum (
    'ownership_authority',
    'condition_accuracy',
    'image_accuracy',
    'legal_and_safe_item',
    'platform_terms',
    'off_platform_transaction_policy'
  );
exception when duplicate_object then null; end $$;

-- Shared immutability guard — used by both tables below. Raises
-- unconditionally, for every role including service_role, since there is
-- never a legitimate reason to alter or remove an accepted declaration or
-- a history entry after the fact.
create or replace function public.prevent_row_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% records are immutable and cannot be updated or deleted', TG_TABLE_NAME;
end;
$$;

-- ─────────────────────────────────────────
-- LISTING_DECLARATIONS
-- ─────────────────────────────────────────
create table if not exists public.listing_declarations (
  id                    uuid primary key default uuid_generate_v4(),
  listing_id            uuid not null references public.listings(id) on delete cascade,
  -- Populated server-side from the authenticated session by the future
  -- write path — never client-supplied. Not enforced in SQL (there is no
  -- write path yet to enforce it against); documented here so the future
  -- service implements it correctly.
  merchant_id           uuid not null references public.profiles(id),
  declaration_type      declaration_type not null,
  declaration_version   text not null,
  -- Hash of the exact declaration text shown at acceptance time, so the
  -- exact wording accepted can be proven later even if the copy changes.
  declaration_text_hash text not null,
  accepted              boolean not null default true,
  accepted_at           timestamptz not null default now(),
  ip_address            text,
  user_agent            text,
  created_at            timestamptz not null default now()
);

create index if not exists listing_declarations_listing_idx on public.listing_declarations(listing_id);
create index if not exists listing_declarations_merchant_idx on public.listing_declarations(merchant_id);

alter table public.listing_declarations enable row level security;

create policy "listing_declarations: merchant read own"
  on public.listing_declarations for select
  using (merchant_id = auth.uid());

-- No public policy, no INSERT policy (service_role only, see header),
-- no UPDATE/DELETE policy — and the trigger below blocks mutation even
-- for roles that would otherwise bypass RLS.

drop trigger if exists prevent_listing_declarations_mutation on public.listing_declarations;
create trigger prevent_listing_declarations_mutation
  before update or delete on public.listing_declarations
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- LISTING_HISTORY
-- ─────────────────────────────────────────
create table if not exists public.listing_history (
  id           uuid primary key default uuid_generate_v4(),
  listing_id   uuid not null references public.listings(id) on delete cascade,
  -- Null for system-initiated changes (e.g. a future automated risk-tier
  -- recompute) where there is no specific acting user.
  changed_by   uuid references public.profiles(id),
  old_values   jsonb,
  new_values   jsonb,
  change_reason text,
  created_at   timestamptz not null default now()
);

create index if not exists listing_history_listing_created_idx on public.listing_history(listing_id, created_at);

alter table public.listing_history enable row level security;

create policy "listing_history: merchant read own"
  on public.listing_history for select
  using (
    exists (
      select 1 from public.listings
      where listings.id = listing_history.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

-- New RLS pattern (not used elsewhere yet — admin reads have all been
-- mock-only so far): direct role check against profiles, matching how the
-- application layer already gates admin access (src/lib/supabase/
-- require-admin.ts's requireAdmin()).
create policy "listing_history: admin read all"
  on public.listing_history for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- No public policy, no INSERT policy (service_role only, see header).

drop trigger if exists prevent_listing_history_mutation on public.listing_history;
create trigger prevent_listing_history_mutation
  before update or delete on public.listing_history
  for each row execute procedure public.prevent_row_mutation();
