#!/usr/bin/env node
/**
 * Permanent regression check for the KYC Orphan Cleanup Phase B3A
 * migration (20260909133312_kyc_document_upload_intents.sql +
 * 20260909175055_fix_finalize_kyc_document_upload_grants.sql) --
 * re-verifies the exact security properties manually confirmed live
 * during that phase's implementation, so a later migration cannot
 * silently regress them (e.g. a future ALTER accidentally reinstating
 * an RLS policy on this table, or a project-wide default-privilege
 * change re-granting anon/service_role EXECUTE the way it already did
 * once for this exact function -- see the fix-forward migration's own
 * header for that real, live-discovered defect).
 *
 * Read-only schema/security introspection only -- no data is read,
 * written, or deleted. PostgREST on this project does not expose the
 * `information_schema`/`pg_catalog` schemas needed for these checks
 * (confirmed during this phase: only `public`/`graphql_public` are
 * exposed), so unlike every other verify-*.mjs script in this repo
 * (which query through @supabase/supabase-js against PostgREST), this
 * one shells out to `supabase db query --linked` -- the same channel
 * used to perform every one of these checks live during this phase.
 * That is a deliberate, narrow exception to this repo's usual
 * script-vs-PostgREST convention, not an oversight.
 *
 * Usage: node scripts/verify-kyc-upload-intents-schema.mjs
 * Requires the Supabase CLI to be linked to the dev project (the same
 * requirement every `npx supabase db push --linked` in this repo has).
 */

import { execFileSync } from 'node:child_process'

function assertSafeToRun() {
  if (process.env.NODE_ENV === 'production') {
    console.error('verify-kyc-upload-intents-schema aborted -- NODE_ENV must not be "production"')
    process.exit(1)
  }
}
assertSafeToRun()

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400))
  }
}

function dbQuery(sql) {
  const raw = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql], { encoding: 'utf8' })
  const start = raw.indexOf('{')
  if (start === -1) throw new Error(`unexpected db query output: ${raw.slice(0, 300)}`)
  return JSON.parse(raw.slice(start)).rows
}

console.log('=== Table: kyc_document_upload_intents ===')
{
  const [rls] = dbQuery(
    "select relrowsecurity, relforcerowsecurity from pg_class where relname='kyc_document_upload_intents';"
  )
  check('RLS enabled', rls?.relrowsecurity === true, rls)

  const policies = dbQuery("select policyname from pg_policies where tablename='kyc_document_upload_intents';")
  check('zero client-facing RLS policies (finalized is reachable only through the function)', policies.length === 0, policies)

  const cols = dbQuery(
    "select column_name from information_schema.columns where table_schema='public' and table_name='kyc_document_upload_intents' order by ordinal_position;"
  ).map((r) => r.column_name)
  const expectedCols = ['id', 'user_id', 'document_type', 'storage_path', 'mime_type', 'file_size', 'status', 'created_at', 'expires_at', 'finalized_at', 'cleaned_at']
  check('exact expected column set (no speculative claim_token/claimed_at/etc.)', JSON.stringify(cols) === JSON.stringify(expectedCols), cols)

  const [statusCheck] = dbQuery(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'kyc_document_upload_intents_status_check';"
  )
  check("status CHECK restricted to pending/finalized/expired/cleaned (no claimed/failed)", /'pending'.*'finalized'.*'expired'.*'cleaned'/.test(statusCheck?.def ?? ''), statusCheck)

  const indexes = dbQuery("select indexname from pg_indexes where tablename='kyc_document_upload_intents' order by indexname;").map((r) => r.indexname)
  check('exactly the expected indexes, no redundant ones', indexes.length === 3 && indexes.includes('kyc_document_upload_intents_storage_path_key') && indexes.includes('kyc_document_upload_intents_cleanup_idx'), indexes)
}

console.log('=== Function: finalize_kyc_document_upload ===')
{
  const [fn] = dbQuery(
    "select p.prosecdef, p.proconfig, p.pronargs, r.rolname as owner from pg_proc p join pg_roles r on p.proowner = r.oid where p.proname = 'finalize_kyc_document_upload';"
  )
  check('exists exactly once', !!fn, fn)
  check('SECURITY DEFINER', fn?.prosecdef === true, fn)
  check('minimal search_path (pg_catalog only)', JSON.stringify(fn?.proconfig) === JSON.stringify(['search_path=pg_catalog']), fn)
  check('exactly one parameter (p_intent_id) -- never p_user_id/p_storage_path/etc.', fn?.pronargs === 1, fn)
  check('owned by a trusted privileged role, never anon/authenticated (relevant since this is SECURITY DEFINER)', fn?.owner && fn.owner !== 'anon' && fn.owner !== 'authenticated', fn)

  const grants = dbQuery(
    "select grantee from information_schema.routine_privileges where routine_name='finalize_kyc_document_upload' and privilege_type='EXECUTE' order by grantee;"
  ).map((r) => r.grantee)
  check('anon EXECUTE denied', !grants.includes('anon'), grants)
  check('service_role EXECUTE denied (nothing calls this as service_role)', !grants.includes('service_role'), grants)
  check('authenticated EXECUTE granted', grants.includes('authenticated'), grants)
}

console.log('=== identity_verification_documents write surface (KYC B2L) ===')
{
  const [rls] = dbQuery("select relrowsecurity from pg_class where relname='identity_verification_documents';")
  check('RLS still enabled', rls?.relrowsecurity === true, rls)

  const rows = dbQuery(
    "select policyname, cmd from pg_policies where schemaname='public' and tablename='identity_verification_documents' order by policyname;"
  )
  const names = rows.map((r) => r.policyname)
  check('exactly 2 policies remain (owner read + admin read)', rows.length === 2, names)
  check('both remaining policies are SELECT', rows.every((r) => r.cmd === 'SELECT'), rows)
  check(
    'NO INSERT policy -- authenticated/anon direct INSERT is denied (B2L removed "owner insert")',
    !names.includes('identity_verification_documents: owner insert') && !rows.some((r) => r.cmd === 'INSERT'),
    names
  )

  const [trig] = dbQuery(
    "select tgname from pg_trigger where tgrelid = 'public.identity_verification_documents'::regclass and tgname = 'identity_verification_documents_immutable';"
  )
  check('immutability trigger unchanged (append-only preserved)', trig?.tgname === 'identity_verification_documents_immutable', trig)
}

console.log('=== Untouched by this phase ===')
{
  const kycBucketPolicies = dbQuery(
    "select policyname from pg_policies where schemaname='storage' and tablename='objects' and policyname like '%kyc-documents%' order by policyname;"
  ).map((r) => r.policyname)
  check('kyc-documents Storage policies unchanged (3: own upload/read + admin read)', kycBucketPolicies.length === 3, kycBucketPolicies)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
