#!/usr/bin/env node
/**
 * Permanent regression check for the P2 RTB dispute-evidence storage RLS
 * fix (20260905213151_widen_dispute_evidence_storage_policies_for_rtb.sql).
 * Real script against the live dev database, mirroring
 * scripts/verify-clickable-profiles.mjs's exact conventions (safety gate,
 * [QA] fixture markers, check() fail-closed helper, cookieFor returning a
 * real per-actor client for direct-RLS proofs).
 *
 * This is a narrow, dedicated home rather than an extension of
 * scripts/verify-rent-to-buy-phase5.mjs: that file is a large (859-line)
 * RTB *product behavior* suite driven almost entirely through the HTTP
 * api() helper, whereas this is a *storage RLS security matrix* --
 * genuinely different in shape (direct per-actor Supabase Storage client
 * calls proving upload/read authorization), and it exercises no RTB
 * product behavior at all. scripts/verify-dispute-locking.mjs is the
 * closest existing "general dispute" verifier but covers status-locking,
 * not evidence storage -- also not the right home. No existing script
 * touches dispute_evidence at all (confirmed by repo-wide audit).
 *
 * Fails closed: every assertion is an explicit check() call; no skip()
 * of any kind exists in this script.
 *
 * Usage: QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<ref> node scripts/verify-rtb-dispute-evidence-storage.mjs
 * Requires the dev server running and scripts/qa-seed.mjs already run once.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

function assertSafeToRun() {
  const problems = []
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV must not be "production"')
  if (process.env.QA_SEED_ENABLED !== 'true') problems.push('QA_SEED_ENABLED must be exactly "true"')
  if (process.env.QA_SEED_CONFIRM !== 'UNITY_DEV_ONLY') problems.push('QA_SEED_CONFIRM must be exactly "UNITY_DEV_ONLY"')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const expectedRef = process.env.QA_SEED_PROJECT_REF
  if (!url) problems.push('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!expectedRef) problems.push('QA_SEED_PROJECT_REF is not set')
  if (url && expectedRef) {
    const ref = new URL(url).hostname.split('.')[0]
    if (ref !== expectedRef) problems.push(`Supabase project ref "${ref}" does not match QA_SEED_PROJECT_REF "${expectedRef}"`)
  }
  if (problems.length > 0) {
    console.error('verify-rtb-dispute-evidence-storage aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}
assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-rtb-dispute-evidence-storage aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] RTBDisputeEvidence'
const RUN_ID = Date.now()
const DISPOSABLE_USER_PASSWORD = 'QA-Disposable-Pass-1!'

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-rtb-dispute-evidence-storage aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id, client }
}
async function createDisposableUser(label) {
  const email = `qa-rtbdispute-${label}-${RUN_ID}@unitytest.internal`
  const { data: user } = await admin.auth.admin.createUser({ email, password: DISPOSABLE_USER_PASSWORD, email_confirm: true })
  await admin.from('profiles').update({ kyc_status: 'approved', account_status: 'active' }).eq('id', user.user.id)
  return { userId: user.user.id, ...(await cookieFor(email, DISPOSABLE_USER_PASSWORD)) }
}
async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}
async function insertBaseListing(merchantId, overrides) {
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', sale_price: 5000, quantity_available: 1, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true, is_test: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}
async function insertRtbAgreement(merchantId, customerId, overrides) {
  const base = {
    merchant_id: merchantId, customer_id: customerId,
    total_purchase_price: 5000, installment_amount: 500, payment_frequency: 'monthly', installment_count: 10,
    is_test: true,
  }
  const { data, error } = await admin.from('rent_to_buy_agreements').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertRtbAgreement failed: ${error.message}`)
  return data.id
}
async function insertDispute(agreementId, raisedBy, overrides) {
  const base = {
    rent_to_buy_agreement_id: agreementId, raised_by: raisedBy,
    title: `${QA_MARKER} ${RUN_ID}`, description: 'QA regression fixture -- storage RLS proof',
    requested_resolution: 'QA regression -- no real resolution requested', status: 'open',
  }
  const { data, error } = await admin.from('disputes').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertDispute failed: ${error.message}`)
  return data.id
}

const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077653f0000000a49444154789c6360000002000155a2d0eb0000000049454e44ae426082', 'hex')
async function tryUpload(client, path) {
  const { error } = await client.storage.from('dispute-evidence').upload(path, tinyPng, { contentType: 'image/png', upsert: false })
  return { allowed: !error, error }
}
async function tryRead(client, path) {
  const { data, error } = await client.storage.from('dispute-evidence').download(path)
  return { allowed: !error, size: data?.size, error }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const merchantB = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)
const unrelatedUser = await createDisposableUser('unrelated')
const bCustomer = await createDisposableUser('bcustomer')

console.log('=== Fixture setup: two independent RTB disputes (A, B) ===')
const listingAId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Listing A ${RUN_ID}` })
const agreementAId = await insertRtbAgreement(merchantA.userId, renterA.userId, { listing_id: listingAId })
const disputeAId = await insertDispute(agreementAId, renterA.userId, {})
console.log(`  dispute A: agreement=${agreementAId} dispute=${disputeAId} (merchant=merchantA, customer=renterA, raised_by=renterA)`)

const listingBId = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Listing B ${RUN_ID}` })
const agreementBId = await insertRtbAgreement(merchantB.userId, bCustomer.userId, { listing_id: listingBId })
const disputeBId = await insertDispute(agreementBId, merchantB.userId, {})
console.log(`  dispute B: agreement=${agreementBId} dispute=${disputeBId} (merchant=merchantB, customer=bCustomer, raised_by=merchantB, fully disjoint from A)`)

const pathA = `${disputeAId}/${renterA.userId}/${RUN_ID}-a.png`
const pathB = `${disputeBId}/${merchantB.userId}/${RUN_ID}-b.png`

console.log('=== Security matrix: dispute-evidence storage RLS ===')

// A. dispute raiser upload -- ALLOW (already worked before the fix; control)
const upA = await tryUpload(renterA.client, pathA)
check('A. dispute raiser (renterA) upload -> ALLOW', upA.allowed, upA.error)

// B. RTB counterparty upload -- ALLOW (THE FIX -- was DENY before the migration)
const pathA2 = `${disputeAId}/${merchantA.userId}/${RUN_ID}-a2.png`
const upB = await tryUpload(merchantA.client, pathA2)
check('B. RTB counterparty (merchantA, did not raise the dispute) upload -> ALLOW (the fix)', upB.allowed, upB.error)

// register both objects as real dispute_evidence rows via the actual API route
const regA = await api(renterA.cookie, 'POST', `/api/disputes/${disputeAId}/evidence`, { storage_path: pathA, file_type: 'image', idempotency_key: `rtbdispute-a-${RUN_ID}` })
check('registered evidence A via the real API route', regA.status === 201, regA)
const regA2 = await api(merchantA.cookie, 'POST', `/api/disputes/${disputeAId}/evidence`, { storage_path: pathA2, file_type: 'image', idempotency_key: `rtbdispute-a2-${RUN_ID}` })
check('registered evidence A2 (counterparty upload) via the real API route', regA2.status === 201, regA2)

// C. dispute raiser read (their own object) -- ALLOW
const rdC = await tryRead(renterA.client, pathA)
check('C. dispute raiser (renterA) read -> ALLOW', rdC.allowed, rdC.error)

// D. RTB counterparty read (the raiser's object) -- ALLOW (THE FIX)
const rdD = await tryRead(merchantA.client, pathA)
check('D. RTB counterparty (merchantA) read of raiser-uploaded object -> ALLOW (the fix)', rdD.allowed, rdD.error)

// E. unrelated authenticated user upload -- DENY
const upE = await tryUpload(unrelatedUser.client, `${disputeAId}/${unrelatedUser.userId}/${RUN_ID}-e.png`)
check('E. unrelated authenticated user upload -> DENY', !upE.allowed, upE)

// F. unrelated authenticated user read -- DENY
const rdF = await tryRead(unrelatedUser.client, pathA)
check('F. unrelated authenticated user read -> DENY', !rdF.allowed, rdF)

// G. anonymous read -- DENY
const anon = createClient(SUPABASE_URL, ANON_KEY)
const rdG = await tryRead(anon, pathA)
check('G. anonymous read -> DENY', !rdG.allowed, rdG)

// Cross-dispute: raise B's own evidence object first (as B's raiser) so H has something real to deny access to
const upBraiser = await tryUpload(merchantB.client, pathB)
check('setup: dispute B raiser (merchantB) can upload their own evidence', upBraiser.allowed, upBraiser.error)

// H. participant in DIFFERENT RTB dispute (renterA, a real party to A only) reads B's evidence -- DENY
const rdH = await tryRead(renterA.client, pathB)
check('H. cross-dispute: A-participant (renterA) read of B evidence -> DENY', !rdH.allowed, rdH)

// I. wrong-dispute upload: renterA (A participant, not a B participant) uploads into B's path -- DENY
const upI = await tryUpload(renterA.client, `${disputeBId}/${renterA.userId}/${RUN_ID}-i.png`)
check('I. cross-dispute: A-participant (renterA) upload into B path -> DENY', !upI.allowed, upI)

// J. metadata insert by wrong participant through the real API route -- DENY (403, is_dispute_participant() rejects)
const regJ = await api(renterA.cookie, 'POST', `/api/disputes/${disputeBId}/evidence`, { storage_path: `${disputeBId}/${renterA.userId}/${RUN_ID}-j.png`, file_type: 'image', idempotency_key: `rtbdispute-j-${RUN_ID}` })
check('J. cross-dispute: real API rejects evidence registration by a non-participant (403)', regJ.status === 403, regJ)

// K. admin read -- ALLOW (admin's own JWT, not service role)
const rdK = await tryRead(adminAuth.client, pathA)
check('K. admin (own JWT, role-derived) read -> ALLOW', rdK.allowed, rdK)

console.log('=== Control: DB metadata RLS unchanged (dispute_evidence table) ===')
const metaMerchantA = await merchantA.client.from('dispute_evidence').select('id').eq('dispute_id', disputeAId)
check('DB metadata: RTB merchant (merchantA) SELECT -> ALLOW', (metaMerchantA.data ?? []).length > 0, metaMerchantA)
const metaRenterA = await renterA.client.from('dispute_evidence').select('id').eq('dispute_id', disputeAId)
check('DB metadata: RTB customer (renterA) SELECT -> ALLOW', (metaRenterA.data ?? []).length > 0, metaRenterA)
const metaUnrelated = await unrelatedUser.client.from('dispute_evidence').select('id').eq('dispute_id', disputeAId)
check('DB metadata: unrelated user SELECT -> DENY (0 rows)', (metaUnrelated.data ?? []).length === 0, metaUnrelated)
const metaAnon = await anon.from('dispute_evidence').select('id').eq('dispute_id', disputeAId)
check('DB metadata: anonymous SELECT -> DENY (0 rows)', (metaAnon.data ?? []).length === 0, metaAnon)
const metaAdmin = await adminAuth.client.from('dispute_evidence').select('id').eq('dispute_id', disputeAId)
check('DB metadata: admin SELECT -> ALLOW', (metaAdmin.data ?? []).length > 0, metaAdmin)

console.log('=== Control: bucket configuration unchanged ===')
const { data: bucketInfo } = await admin.storage.getBucket('dispute-evidence')
check('bucket remains private (public=false)', bucketInfo?.public === false, bucketInfo)
check('bucket file size limit unchanged (10MB)', bucketInfo?.file_size_limit === 10485760, bucketInfo)
const allowedMimes = bucketInfo?.allowed_mime_types ?? []
check('bucket allowed MIME types unchanged (no SVG/HTML)', allowedMimes.length === 4 && allowedMimes.includes('image/jpeg') && allowedMimes.includes('application/pdf') && !allowedMimes.some((m) => /svg|html|javascript/i.test(m)), bucketInfo)

console.log('=== CLEANUP: quarantine ephemeral RTB dispute-evidence fixtures ===')
{
  // Calling the real /api/disputes/[id]/evidence route above (regA, regA2)
  // wrote real dispute_history rows -- and dispute_history is immutable
  // (prevent_row_mutation() trigger, 20260814000004_dispute_history.sql),
  // which transitively blocks deleting the disputes row (FK), which in
  // turn blocks deleting rent_to_buy_agreements/listings (FK). This is
  // the product's own evidentiary-integrity design working exactly as
  // intended -- not a defect, and not something this cleanup should ever
  // try to force through. What CAN and should be cleaned: the storage
  // objects and the dispute_evidence metadata rows themselves (no
  // immutability trigger on either). The dispute/agreement/listing rows
  // remain permanently, already is_test=true, as harmless QA history --
  // matching this session's established norm for anything a genuine
  // product invariant prevents from being deleted (e.g. disposable auth
  // users are never deleted for the identical reason).
  await admin.storage.from('dispute-evidence').remove([pathA, pathA2, pathB])
  const { error: evidenceDeleteErr } = await admin.from('dispute_evidence').delete().in('dispute_id', [disputeAId, disputeBId])
  const { data: objLeft } = await admin.storage.from('dispute-evidence').list(disputeAId)
  const { data: evidenceLeft } = await admin.from('dispute_evidence').select('id').in('dispute_id', [disputeAId, disputeBId])
  check('cleanup succeeds (evidence storage objects and metadata rows removed)', !evidenceDeleteErr && (objLeft ?? []).length === 0 && (evidenceLeft ?? []).length === 0, { evidenceDeleteErr, objLeft, evidenceLeft })

  const { data: agreements } = await admin.from('rent_to_buy_agreements').select('is_test').in('id', [agreementAId, agreementBId])
  const { data: listings } = await admin.from('listings').select('is_test').in('id', [listingAId, listingBId])
  check('dispute/agreement/listing rows remain (blocked by dispute_history immutability, by design) but are is_test=true', agreements.every((a) => a.is_test === true) && listings.every((l) => l.is_test === true), { agreements, listings })
  console.log(`  (disputes ${disputeAId}, ${disputeBId} and their agreements/listings are retained permanently -- dispute_history is immutable by design; all are is_test=true)`)
  // Disposable auth users (unrelatedUser, bCustomer) are deliberately never
  // deleted -- matches this session's established convention (deleting an
  // auth user can cascade-delete rows it owns elsewhere; harmless,
  // never-reused housekeeping debt instead).
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
