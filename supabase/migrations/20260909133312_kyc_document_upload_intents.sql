-- ============================================================
-- KYC Orphan Cleanup Phase B3A -- staged upload intents
-- ============================================================
-- Closes the "zero server trace" half of the KYC pre-registration
-- abandoned-upload gap (Phase B design report) for NEW uploads, without
-- yet touching retention (B3C/B3D, a separate future phase) or removing
-- the legacy B1 no-intent registration path (B3B, also separate).
--
-- Lifecycle: pending -> finalized | expired | cleaned. No `claimed`/
-- `failed` states -- finalization is one atomic database transaction
-- (this migration's own function), so a crash mid-finalization always
-- rolls back to exactly `pending`, unexpired; there is no persisted
-- middle state to strand. `expired`/`cleaned` are written only by the
-- future B3C cleanup worker (not created this migration).
--
-- Security model (KYC Orphan Cleanup Phase B3 -- Final Database-
-- Authority Gate): the finalize function is the sole, self-contained
-- authority -- it must be safe against direct RPC invocation by an
-- authenticated client, independent of whether
-- POST /api/verification/documents ever ran first. It derives identity
-- from auth.uid() (never a parameter, matching
-- public.save_listing_draft's own established self-service pattern --
-- 20260729000008 -- not the admin-acting-on-behalf-of-another-user
-- p_user_id shape used by this same domain's existing
-- submit_identity_verification/decide_identity_verification, which is a
-- structurally different problem: caller != subject there, caller ==
-- subject here), independently re-verifies the real Storage object via
-- direct SQL against storage.objects (confirmed live this phase: exact
-- columns bucket_id/name/metadata jsonb with keys 'size'/'mimetype'),
-- and performs the metadata insert + intent finalization in one
-- transaction so `intent.status = 'finalized'` is mathematically
-- guaranteed to imply a corresponding identity_verification_documents
-- row exists from that same commit.
--
-- kyc_document_upload_intents carries ZERO client-facing RLS policies
-- (no SELECT/INSERT/UPDATE/DELETE for authenticated or anon) -- proven
-- necessary, not merely cautious: live-checked this phase, this
-- project's default `anon`/`authenticated` table grants already include
-- full SELECT/INSERT/UPDATE/DELETE on identity_verification_documents
-- (Supabase's standard project-wide default), meaning RLS is the ONLY
-- thing preventing arbitrary client access to that table today -- the
-- exact same default grants apply to any new public-schema table,
-- including this one. RLS enabled with zero policies is therefore both
-- necessary and sufficient to deny all client access, identical in
-- mechanism to how every other sensitive table in this schema is
-- protected (no table in this project uses an explicit REVOKE -- RLS
-- alone is the established, working convention, confirmed still true
-- here). `finalized` is reachable only through this migration's
-- SECURITY DEFINER function; there is no direct client UPDATE path to
-- it at all (a prior draft of this design proposed a narrow owner
-- UPDATE policy for exactly this transition and it was rejected in
-- design review -- a client could satisfy any WITH CHECK clause on
-- `status` alone without a real registered document existing, which
-- violates the intended invariant; removing the policy entirely closes
-- this the same way an unreachable path can't be misused).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- kyc_document_upload_intents
-- ─────────────────────────────────────────
create table if not exists public.kyc_document_upload_intents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  document_type identity_document_type not null,
  storage_path  text not null unique,
  mime_type     text not null,
  file_size     bigint not null,
  status        text not null default 'pending',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  finalized_at  timestamptz,
  cleaned_at    timestamptz,
  constraint kyc_document_upload_intents_status_check
    check (status in ('pending', 'finalized', 'expired', 'cleaned')),
  constraint kyc_document_upload_intents_file_size_check
    check (file_size > 0 and file_size <= 10485760),
  constraint kyc_document_upload_intents_mime_type_check
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  constraint kyc_document_upload_intents_expiry_check
    check (expires_at > created_at)
);

-- Cleanup worker's own future primary query shape (not created this
-- migration -- B3C). `storage_path`'s own UNIQUE constraint already
-- creates its own index, covering the "same path, no ambiguity" need
-- without a second explicit index.
create index if not exists kyc_document_upload_intents_cleanup_idx
  on public.kyc_document_upload_intents(status, expires_at);

alter table public.kyc_document_upload_intents enable row level security;

-- No policies at all, deliberately -- see header comment. Intent
-- creation happens via the service-role client from an authenticated
-- Next.js route; every status transition happens via the SECURITY
-- DEFINER function below (finalize) or, in a future migration, a
-- service-role cleanup worker (expire/clean) -- never a direct client
-- table operation of any kind.

-- No prevent_row_mutation() trigger on this table -- unlike
-- identity_verification_documents, intents are lifecycle scaffolding,
-- not evidentiary content; mutability (status transitions) is the
-- entire point.

-- ─────────────────────────────────────────
-- finalize_kyc_document_upload -- the sole, self-contained
-- authority for turning a pending intent into a registered KYC
-- document. Safe against direct RPC invocation (Phase B3's Final
-- Database-Authority Gate) -- every invariant is re-derived and
-- re-checked inside this function; nothing is trusted from the
-- calling route or from any earlier check it may have performed.
-- ─────────────────────────────────────────
create or replace function public.finalize_kyc_document_upload(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid            uuid := auth.uid();
  v_intent         public.kyc_document_upload_intents%rowtype;
  v_storage_size   bigint;
  v_storage_mime   text;
  v_existing_count int;
  v_conflict_count int;
  v_result         public.identity_verification_documents%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Row-lock the intent -- the sole serialization point against a
  -- concurrent duplicate finalize call and, in a future migration,
  -- against a concurrent cleanup expiry-claim on the same row (both
  -- sides transition status via a plain UPDATE against this same row;
  -- ordinary Postgres row-level locking makes exactly one side's
  -- transition win, the other observes the post-commit reality).
  select * into v_intent
  from public.kyc_document_upload_intents
  where id = p_intent_id and user_id = v_uid
  for update;

  if not found then
    -- Covers both "no such intent" and "belongs to another user" --
    -- identical, deliberately unspecific response either way.
    raise exception 'intent_not_found';
  end if;

  if v_intent.status = 'finalized' then
    -- Idempotent replay: registered evidence is authoritative. No new
    -- insert, no Storage mutation, regardless of how many times this
    -- is called.
    select id, document_type, storage_path, mime_type, file_size, uploaded_at
      into v_result
    from public.identity_verification_documents
    where storage_path = v_intent.storage_path
    order by uploaded_at desc
    limit 1;

    if not found then
      -- Should be unreachable given the invariant this function itself
      -- maintains (finalized always implies a same-transaction insert)
      -- -- fail closed rather than fabricate a result.
      raise exception 'finalized_intent_missing_document';
    end if;

    return jsonb_build_object(
      'id', v_result.id, 'document_type', v_result.document_type, 'storage_path', v_result.storage_path,
      'mime_type', v_result.mime_type, 'file_size', v_result.file_size, 'uploaded_at', v_result.uploaded_at
    );
  end if;

  if v_intent.status <> 'pending' then
    -- expired or cleaned -- too late, no metadata, no state change.
    raise exception 'intent_expired';
  end if;

  if v_intent.expires_at <= now() then
    -- Time-expired but not yet claimed by the (future) cleanup worker --
    -- same outward behavior, no state mutation here either; only the
    -- cleanup worker ever writes the stored 'expired' value.
    raise exception 'intent_expired';
  end if;

  -- Authoritative Storage existence + integrity check -- direct SQL
  -- against storage.objects, independent of and never trusting any
  -- prior route-level check.
  select (metadata ->> 'size')::bigint, metadata ->> 'mimetype'
    into v_storage_size, v_storage_mime
  from storage.objects
  where bucket_id = 'kyc-documents' and name = v_intent.storage_path;

  if not found then
    raise exception 'storage_object_missing';
  end if;

  if v_storage_mime is distinct from v_intent.mime_type or v_storage_size is distinct from v_intent.file_size then
    raise exception 'storage_metadata_mismatch';
  end if;

  -- Existing-metadata replay/conflict check -- no uniqueness assumption
  -- (B1's own accepted bounded residual: more than one row can
  -- reference one path). All matching rows must agree, or this fails
  -- as a conflict; either way nothing is deleted.
  select count(*) into v_existing_count
  from public.identity_verification_documents
  where storage_path = v_intent.storage_path;

  if v_existing_count > 0 then
    select count(*) into v_conflict_count
    from public.identity_verification_documents
    where storage_path = v_intent.storage_path
      and (document_type <> v_intent.document_type or mime_type <> v_intent.mime_type or file_size <> v_intent.file_size);

    if v_conflict_count > 0 then
      raise exception 'metadata_conflict';
    end if;

    -- Every existing row agrees -- finalize against it, no new insert
    -- (covers the B2-legacy-insert-policy interaction: a row could
    -- exist here even though this function never created it).
    select id, document_type, storage_path, mime_type, file_size, uploaded_at
      into v_result
    from public.identity_verification_documents
    where storage_path = v_intent.storage_path
    order by uploaded_at desc
    limit 1;

    update public.kyc_document_upload_intents
    set status = 'finalized', finalized_at = now()
    where id = v_intent.id;

    return jsonb_build_object(
      'id', v_result.id, 'document_type', v_result.document_type, 'storage_path', v_result.storage_path,
      'mime_type', v_result.mime_type, 'file_size', v_result.file_size, 'uploaded_at', v_result.uploaded_at
    );
  end if;

  -- Genuinely new registration -- metadata insert and intent
  -- finalization commit together in this one transaction.
  insert into public.identity_verification_documents (user_id, document_type, storage_path, mime_type, file_size)
  values (v_uid, v_intent.document_type, v_intent.storage_path, v_intent.mime_type, v_intent.file_size)
  returning id, document_type, storage_path, mime_type, file_size, uploaded_at into v_result;

  update public.kyc_document_upload_intents
  set status = 'finalized', finalized_at = now()
  where id = v_intent.id;

  return jsonb_build_object(
    'id', v_result.id, 'document_type', v_result.document_type, 'storage_path', v_result.storage_path,
    'mime_type', v_result.mime_type, 'file_size', v_result.file_size, 'uploaded_at', v_result.uploaded_at
  );
end;
$$;

-- Least privilege: PUBLIC and anon explicitly denied; only authenticated
-- callers (the function derives their real identity from auth.uid()
-- itself -- see header) may invoke it. service_role is not granted --
-- nothing in this design ever calls this function as service_role.
revoke all on function public.finalize_kyc_document_upload(uuid) from public;
grant execute on function public.finalize_kyc_document_upload(uuid) to authenticated;
