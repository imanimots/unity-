-- ============================================================
-- Ownership verification schema (Step 3, public-test MVP)
-- ============================================================
-- Provider-neutral ownership verification state, kept separate from
-- listing_moderation on purpose -- reviewing whether a merchant actually
-- owns an item (evidence-based) and reviewing whether a listing is fit to
-- publish (completeness/policy) are different decisions with different
-- actors and different failure modes, matching how listing_moderation was
-- already kept separate from listings.status. This table is the current
-- state (one row per listing, mutable, same shape as listing_moderation);
-- the immutable decision trail reuses the existing listing_history table
-- as-is (old_values/new_values/change_reason/changed_by already cover an
-- ownership-verification decision's shape without any new column there).
--
-- No row exists for a listing until a review actually starts
-- (start_ownership_review upserts it) -- the application layer treats a
-- missing row as an implicit default (not_required or pending, depending
-- on the listing's risk tier) rather than eagerly writing a row for every
-- submitted listing. See src/lib/ownership-verification/manual-provider.ts.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type ownership_verification_status as enum (
    'not_required', 'pending', 'under_review',
    'additional_evidence_required', 'verified', 'rejected'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.listing_ownership_verification (
  listing_id       uuid primary key references public.listings(id) on delete cascade,
  status           ownership_verification_status not null default 'pending',
  -- Which provider produced this decision -- 'manual' today, 'sumsub' (or
  -- another) later. Never inferred from application code; always written
  -- explicitly by the provider adapter that made the call.
  provider         text not null default 'manual',
  -- Future provider's own applicant/check id -- always null for 'manual'.
  provider_reference text,
  -- Internal only -- never exposed to merchants (same split as
  -- listing_moderation.moderation_notes vs rejection_reason).
  reviewer_notes   text,
  -- Merchant-safe -- what the merchant is allowed to see.
  merchant_feedback text,
  reason_code      text,
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists listing_ownership_verification_status_idx
  on public.listing_ownership_verification(status);

alter table public.listing_ownership_verification enable row level security;

-- Same profiles.role='admin' RLS pattern as listing_moderation
-- (20260729000004_listing_moderation.sql) and listing_history
-- (20260729000003_listing_declarations_and_history.sql).
create policy "listing_ownership_verification: admin read"
  on public.listing_ownership_verification for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

create policy "listing_ownership_verification: admin update"
  on public.listing_ownership_verification for update
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- No public policy, no merchant policy (see the view below), no client
-- INSERT policy -- only the service-role RPCs in
-- 20260803000003_admin_moderation_rpcs.sql create/update rows.

-- Merchant-safe view -- deliberately narrow column list (no
-- reviewer_notes, no reason_code, no provider_reference), same pattern as
-- listing_moderation_merchant_view: security_invoker = false, its own
-- auth.uid() filter baked into the query, runs with the view owner's
-- (privileged) rights to read the locked-down base table.
create or replace view public.listing_ownership_verification_merchant_view
with (security_invoker = false)
as
select
  ov.listing_id,
  ov.status,
  ov.merchant_feedback,
  ov.reviewed_at
from public.listing_ownership_verification ov
join public.listings l on l.id = ov.listing_id
where l.merchant_id = auth.uid();

grant select on public.listing_ownership_verification_merchant_view to authenticated;

-- ─────────────────────────────────────────
-- admin_action_history — append-only, admin-only audit trail carrying the
-- full internal detail (reviewer_notes/internal_note, reason_code) of
-- every admin decision. Added deliberately, not as a default choice:
-- listing_history (20260729000003) already covers "what changed and
-- when" with a merchant-read policy for the listing's own merchant --
-- exactly the wrong place for reviewer-internal content. Reusing it for
-- admin decisions would mean either leaking internal notes to the
-- merchant via that read policy, or omitting internal notes entirely and
-- losing them the moment the next decision overwrites
-- listing_moderation/listing_ownership_verification's mutable current-state
-- row. Neither satisfies "preserving previous decisions" for internal
-- content, so a dedicated table is genuinely needed here -- the one case
-- this migration set doesn't just extend existing structures.
--
-- listing_history is still written by every admin RPC too, but only with
-- the status-transition + merchant_feedback shape it already safely
-- supports -- this table is the ONLY place reason_code/internal notes are
-- ever persisted.
-- ─────────────────────────────────────────
create table if not exists public.admin_action_history (
  id               uuid primary key default uuid_generate_v4(),
  listing_id       uuid not null references public.listings(id) on delete cascade,
  action_type      text not null,
  admin_id         uuid not null references public.profiles(id),
  reason_code      text,
  internal_note    text,
  merchant_feedback text,
  previous_status  text,
  new_status       text,
  created_at       timestamptz not null default now()
);

create index if not exists admin_action_history_listing_id_idx on public.admin_action_history(listing_id, created_at);

alter table public.admin_action_history enable row level security;

create policy "admin_action_history: admin read"
  on public.admin_action_history for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- No merchant policy, no public policy, no client INSERT policy -- only
-- the service-role RPCs in 20260803000003_admin_moderation_rpcs.sql write
-- rows. Immutable for every role including service_role, same
-- prevent_row_mutation() trigger already used by listing_declarations and
-- listing_history (20260729000003) -- reused, not duplicated.
drop trigger if exists admin_action_history_immutable on public.admin_action_history;
create trigger admin_action_history_immutable
  before update or delete on public.admin_action_history
  for each row execute procedure public.prevent_row_mutation();
