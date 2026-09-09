-- ============================================================
-- Fix-forward: finalize_kyc_document_upload rowtype INTO binding
-- ============================================================
-- Live-discovered defect (KYC Orphan Cleanup Phase B3A final
-- pre-commit gate, atomic-success rollback proof): every
-- `select <named columns> into v_result` and
-- `insert ... returning <named columns> into v_result` in
-- 20260909133312's function used `v_result` declared as
-- `public.identity_verification_documents%rowtype`. PL/pgSQL's
-- `... INTO <rowtype var>` binds POSITIONALLY against the rowtype's
-- own declared column order -- it does NOT match by name against the
-- SELECT/RETURNING list. That table's real column order is
-- (id, user_id, document_type, storage_path, mime_type, file_size,
-- uploaded_at) -- 7 columns, with user_id second -- while every
-- SELECT/RETURNING list in the prior migration named only 6 columns
-- (id, document_type, storage_path, mime_type, file_size, uploaded_at),
-- omitting user_id entirely. Positionally, this shifted every field
-- after `id` by one: v_result.user_id got the document_type value,
-- v_result.document_type got storage_path, and so on -- reproduced
-- live as `ERROR: 22P02: invalid input syntax for type uuid:
-- "identity_document"` (the document_type string landing in the uuid
-- user_id field) the moment a genuinely successful finalization was
-- attempted (in a rolled-back transaction, never committed -- this
-- defect was never live in production and created zero bad rows).
--
-- This means EVERY finalize call that would otherwise have reached a
-- v_result-populating statement -- including the ordinary, fully
-- valid "upload matched, register it" happy path -- was broken from
-- the moment 20260909133312 was applied. None of the direct-attack
-- tests already proven live caught this, because every one of them
-- raises its exception BEFORE ever reaching a v_result assignment.
--
-- Fix: replace the single composite v_result variable with individual
-- scalar variables, one per returned field, bound by explicit
-- positional correspondence between each SELECT/RETURNING list and its
-- own INTO list (both now the same order, so there is no room for a
-- table-column-order mismatch to silently reappear -- and no future
-- ALTER TABLE ADD COLUMN on identity_verification_documents can ever
-- reintroduce this class of bug, since nothing here depends on that
-- table's column order at all anymore).
--
-- Plain CREATE OR REPLACE -- the function's signature (p_intent_id
-- uuid) is unchanged, so this is not the DROP-then-CREATE case Phase
-- B3's own hardening notes flagged for a genuine parameter-list
-- change. Existing EXECUTE grants (authenticated only, from
-- 20260909175055) are untouched by a body replacement.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.finalize_kyc_document_upload(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid                    uuid := auth.uid();
  v_intent                 public.kyc_document_upload_intents%rowtype;
  v_storage_size           bigint;
  v_storage_mime           text;
  v_existing_count         int;
  v_conflict_count         int;
  v_result_id              uuid;
  v_result_document_type   public.identity_document_type;
  v_result_storage_path    text;
  v_result_mime_type       text;
  v_result_file_size       bigint;
  v_result_uploaded_at     timestamptz;
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
      into v_result_id, v_result_document_type, v_result_storage_path, v_result_mime_type, v_result_file_size, v_result_uploaded_at
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
      'id', v_result_id, 'document_type', v_result_document_type, 'storage_path', v_result_storage_path,
      'mime_type', v_result_mime_type, 'file_size', v_result_file_size, 'uploaded_at', v_result_uploaded_at
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
      into v_result_id, v_result_document_type, v_result_storage_path, v_result_mime_type, v_result_file_size, v_result_uploaded_at
    from public.identity_verification_documents
    where storage_path = v_intent.storage_path
    order by uploaded_at desc
    limit 1;

    update public.kyc_document_upload_intents
    set status = 'finalized', finalized_at = now()
    where id = v_intent.id;

    return jsonb_build_object(
      'id', v_result_id, 'document_type', v_result_document_type, 'storage_path', v_result_storage_path,
      'mime_type', v_result_mime_type, 'file_size', v_result_file_size, 'uploaded_at', v_result_uploaded_at
    );
  end if;

  -- Genuinely new registration -- metadata insert and intent
  -- finalization commit together in this one transaction.
  insert into public.identity_verification_documents (user_id, document_type, storage_path, mime_type, file_size)
  values (v_uid, v_intent.document_type, v_intent.storage_path, v_intent.mime_type, v_intent.file_size)
  returning id, document_type, storage_path, mime_type, file_size, uploaded_at
    into v_result_id, v_result_document_type, v_result_storage_path, v_result_mime_type, v_result_file_size, v_result_uploaded_at;

  update public.kyc_document_upload_intents
  set status = 'finalized', finalized_at = now()
  where id = v_intent.id;

  return jsonb_build_object(
    'id', v_result_id, 'document_type', v_result_document_type, 'storage_path', v_result_storage_path,
    'mime_type', v_result_mime_type, 'file_size', v_result_file_size, 'uploaded_at', v_result_uploaded_at
  );
end;
$$;
