-- ============================================================
-- Identity verification schema (Step 4, public-test MVP)
-- ============================================================
-- Same architecture as Step 3's ownership-verification pass
-- (20260803000001-6, docs/ADMIN_MODERATION.md), applied to a different
-- domain: renter/merchant identity KYC instead of listing ownership
-- evidence. Deliberately three tables, not one, for the exact reason
-- Step 3 already learned the hard way (found live: putting internal
-- admin notes into a table with an owner-read policy leaked them) --
-- current state, evidence, and internal audit trail need different
-- read audiences and must not share a table where RLS (row-level, not
-- column-level) can't separate them.
--
--   identity_verifications          -- current state, 1 row per user,
--                                       admin read/write; owner reads via
--                                       a narrow self-view only (never the
--                                       base table directly, since it also
--                                       carries admin-only reviewer_notes/
--                                       reason_code/provider_reference).
--   identity_verification_documents -- append-only evidence rows (never
--                                       updated/deleted -- a replacement
--                                       is a new row; "current" documents
--                                       are the latest row per
--                                       document_type, same dedup-in-app
--                                       pattern Step 3 settled on for
--                                       listing_declarations after its own
--                                       immutability-vs-unique-constraint
--                                       conflict).
--   identity_verification_history   -- admin-only, immutable audit trail
--                                       (mirrors admin_action_history).
--                                       No user-facing history requirement
--                                       exists this pass (the user only
--                                       needs current status + current
--                                       safe feedback), so unlike Step 3's
--                                       listing_history this table has no
--                                       merchant-safe counterpart -- it is
--                                       simply never merchant/user-readable
--                                       at all.
--
-- profiles.kyc_status (existing enum: none/pending/approved/rejected,
-- already protected by protect_profile_privileged_fields -- see
-- 20260729000001) remains the coarse, public-readable summary every
-- other part of the app already reads (risk engine, completeness engine,
-- dashboard badges). It is kept in sync by the RPCs in
-- 20260804000002_identity_verification_rpcs.sql, the same
-- "richer private table syncs a pre-existing public summary field"
-- pattern Step 3 used for listings.ownership_verified.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type identity_verification_status as enum (
    'not_started', 'pending', 'under_review',
    'additional_information_required', 'approved', 'rejected'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type identity_document_type as enum ('identity_document', 'proof_of_address');
exception when duplicate_object then null; end $$;

do $$ begin
  create type identity_reference_type as enum ('sa_id', 'passport');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────
-- identity_verifications -- current state
-- ─────────────────────────────────────────
create table if not exists public.identity_verifications (
  user_id               uuid primary key references public.profiles(id) on delete cascade,
  status                identity_verification_status not null default 'not_started',
  legal_first_name      text,
  legal_surname         text,
  date_of_birth         date,
  id_reference_type     identity_reference_type,
  id_reference_number   text,
  nationality            text,
  country_of_residence  text,
  residential_address   text,
  -- Which provider produced the current decision -- 'manual' today,
  -- 'sumsub' later. Never inferred; always written explicitly by the
  -- provider adapter that made the call.
  provider              text not null default 'manual',
  provider_reference    text,
  -- Internal only -- never exposed via identity_verification_self_view.
  reviewer_notes        text,
  reason_code           text,
  -- User-safe -- what the user is allowed to see for a decision.
  user_feedback         text,
  review_count          int not null default 0,
  submitted_at          timestamptz,
  reviewed_by           uuid references public.profiles(id),
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists identity_verifications_status_idx on public.identity_verifications(status);

alter table public.identity_verifications enable row level security;

-- Same profiles.role='admin' RLS pattern as every other admin table
-- since Step 3.
create policy "identity_verifications: admin read"
  on public.identity_verifications for select
  using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

create policy "identity_verifications: admin update"
  on public.identity_verifications for update
  using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No public policy, no direct owner policy (see the view below), no
-- client INSERT policy -- only the service-role RPCs in
-- 20260804000002_identity_verification_rpcs.sql create/update rows.

-- Owner-safe view -- deliberately narrow column list: excludes
-- reviewer_notes, reason_code, provider_reference, reviewed_by. Includes
-- the user's own submitted legal details (their own data, safe for them
-- to read back) and user_feedback (designed to be safe). Same
-- security_invoker=false + baked-in auth.uid() filter pattern as
-- listing_moderation_merchant_view (20260729000004) and
-- listing_ownership_verification_merchant_view (20260803000001).
create or replace view public.identity_verification_self_view
with (security_invoker = false)
as
select
  iv.user_id,
  iv.status,
  iv.legal_first_name,
  iv.legal_surname,
  iv.date_of_birth,
  iv.id_reference_type,
  iv.id_reference_number,
  iv.nationality,
  iv.country_of_residence,
  iv.residential_address,
  iv.user_feedback,
  iv.review_count,
  iv.submitted_at,
  iv.reviewed_at
from public.identity_verifications iv
where iv.user_id = auth.uid();

grant select on public.identity_verification_self_view to authenticated;

-- ─────────────────────────────────────────
-- identity_verification_documents -- append-only evidence
-- ─────────────────────────────────────────
create table if not exists public.identity_verification_documents (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  document_type  identity_document_type not null,
  storage_path   text not null,
  mime_type      text not null,
  file_size      bigint not null,
  uploaded_at    timestamptz not null default now()
);

create index if not exists identity_verification_documents_user_idx
  on public.identity_verification_documents(user_id, document_type, uploaded_at desc);

alter table public.identity_verification_documents enable row level security;

create policy "identity_verification_documents: owner read"
  on public.identity_verification_documents for select
  using (auth.uid() = user_id);

create policy "identity_verification_documents: owner insert"
  on public.identity_verification_documents for insert
  with check (auth.uid() = user_id);

create policy "identity_verification_documents: admin read"
  on public.identity_verification_documents for select
  using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No UPDATE/DELETE policy for anyone, and immutable even for
-- service_role -- a replacement is a new row (see header comment); the
-- "current" document per type is simply the latest row, resolved in
-- application code (src/lib/identity-verification), same as Step 3's
-- listing_declarations after 20260803000006.
drop trigger if exists identity_verification_documents_immutable on public.identity_verification_documents;
create trigger identity_verification_documents_immutable
  before update or delete on public.identity_verification_documents
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- identity_verification_history -- admin-only, immutable audit trail
-- ─────────────────────────────────────────
create table if not exists public.identity_verification_history (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  action_type      text not null,
  -- Null for user-initiated actions (submitted/resubmitted).
  admin_id         uuid references public.profiles(id),
  reason_code      text,
  internal_note    text,
  user_feedback    text,
  previous_status  text,
  new_status       text,
  created_at       timestamptz not null default now()
);

create index if not exists identity_verification_history_user_idx
  on public.identity_verification_history(user_id, created_at);

alter table public.identity_verification_history enable row level security;

create policy "identity_verification_history: admin read"
  on public.identity_verification_history for select
  using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No user/merchant policy at all -- unlike listing_history in Step 3,
-- there is no user-facing history requirement this pass; the user only
-- ever reads current state via identity_verification_self_view.
drop trigger if exists identity_verification_history_immutable on public.identity_verification_history;
create trigger identity_verification_history_immutable
  before update or delete on public.identity_verification_history
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- Storage -- private KYC document bucket
-- ─────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kyc-documents', 'kyc-documents', false,
  10485760,  -- 10 MB -- identity documents don't need video/large-PDF allowances
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: {user_id}/{document_type}/{uuid}.{ext} -- own-folder
-- scoping via storage.foldername(name)[1], same pattern as
-- ownership-proofs (20260613000001).
create policy "storage kyc-documents: own upload"
  on storage.objects for insert
  with check (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "storage kyc-documents: own read"
  on storage.objects for select
  using (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "storage kyc-documents: admin read"
  on storage.objects for select
  using (
    bucket_id = 'kyc-documents'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No UPDATE/DELETE policy for anyone at the storage-object level either
-- -- matches the table-level immutability above; a replacement document
-- is a new object at a new random-uuid path, never an overwrite.
