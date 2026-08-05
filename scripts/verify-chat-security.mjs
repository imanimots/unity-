#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 3 (Real Chat). Mirrors
 * scripts/verify-dispute-locking.mjs's shape and philosophy exactly: a
 * real script against the live dev database, not a mocked vitest test
 * (this codebase has never mocked Supabase RPC/RLS/Realtime/Storage
 * behavior in a unit test). Re-run this any time a future phase touches
 * messages/message_attachments/message_thread_presence RLS, the
 * messaging routes, or the Realtime publication, to confirm chat
 * security still holds.
 *
 * Covers (review point 10's exact list): booking/order/barter
 * messaging, forged ids, non-participant access, attachment access,
 * realtime reception, and idempotent replay -- plus dispute-tagged
 * messaging (the "one thread, not two" model) and audited admin
 * access, both specific to this phase's architecture.
 *
 * Safely re-runnable: every send uses a FIXED idempotency key, so
 * re-running replays the same message row instead of creating
 * duplicates. Fixtures are dedicated [QA] Chat-Security listings,
 * separate from every other regression script's fixtures.
 *
 * SAFETY: same gate as scripts/qa-seed.mjs.
 * Usage: node scripts/verify-chat-security.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL.
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
    console.error('verify-chat-security aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-chat-security.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-chat-security aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'

async function clientFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return { client, userId: data.session.user.id, cookie: `${cookieName}=${encodeURIComponent('base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64'))}` }
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
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    daily_rate: 150, min_rental_days: 1, deposit_required: false, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

// ── Load QA accounts (must already exist -- run scripts/qa-seed.mjs first if not) ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-chat-security aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await clientFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await clientFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await clientFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const outsider = await clientFor(creds.accounts.restrictedUser.email, creds.accounts.restrictedUser.password)
const adminSession = creds.accounts.admin ? await clientFor(creds.accounts.admin.email, creds.accounts.admin.password) : null

const FORGED_ID = '00000000-0000-4000-8000-000000000000'

// ── Generic thread-level checks, reused across booking/order/barter ──
async function checkThreadSecurity(cfg) {
  console.log(`\n=== ${cfg.label}: send / read / non-participant / forged id / idempotency ===`)

  const sendRes = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: `Hello from the ${cfg.label} regression fixture`,
    idempotency_key: `chat-regression-${cfg.type}-send-v1`,
  })
  check(`${cfg.label}: party A can send`, sendRes.status === 201, sendRes)
  const messageId = sendRes.json?.id
  if (!messageId) return null

  const listAsB = await api(cfg.partyB.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}`)
  check(
    `${cfg.label}: party B can read party A's message`,
    listAsB.status === 200 && (listAsB.json?.messages ?? []).some((m) => m.id === messageId),
    listAsB
  )

  const listAsOutsider = await api(outsider.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}`)
  check(`${cfg.label}: non-participant GET is rejected`, listAsOutsider.status === 404, listAsOutsider)

  const sendAsOutsider = await api(outsider.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: 'intruder message',
    idempotency_key: `chat-regression-${cfg.type}-outsider-v1`,
  })
  check(`${cfg.label}: non-participant POST is rejected`, sendAsOutsider.status >= 400, sendAsOutsider)

  const forgedGet = await api(cfg.partyA.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${FORGED_ID}`)
  check(`${cfg.label}: forged transaction id GET is rejected`, forgedGet.status === 404, forgedGet)

  const forgedSend = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: FORGED_ID,
    content: 'should not land anywhere',
    idempotency_key: `chat-regression-${cfg.type}-forged-send-v1`,
  })
  check(`${cfg.label}: forged transaction id POST is rejected`, forgedSend.status === 404, forgedSend)

  const replay = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: `Hello from the ${cfg.label} regression fixture`,
    idempotency_key: `chat-regression-${cfg.type}-send-v1`,
  })
  check(`${cfg.label}: idempotent replay returns the same message`, replay.status === 201 && replay.json?.id === messageId, replay)

  return messageId
}

async function checkAttachments(cfg) {
  console.log(`\n=== ${cfg.label}: attachments ===`)

  const sendRes = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: 'Attachment probe',
    idempotency_key: `chat-regression-${cfg.type}-attach-msg-v1`,
  })
  const messageId = sendRes.json?.id
  check(`${cfg.label}: attachment probe message sent`, sendRes.status === 201, sendRes)
  if (!messageId) return

  // Attachments are immutable/append-only by design (no update/delete
  // client policy -- see 20260815000001_message_attachments.sql), so a
  // re-run can't just overwrite last run's object at the same path.
  // Reset via the service-role client (bypasses RLS) so this check stays
  // safely re-runnable indefinitely rather than accumulating attachments
  // across runs or colliding on a fixed path.
  const { data: existingAttachments } = await admin.from('message_attachments').select('id, storage_path').eq('message_id', messageId)
  if (existingAttachments?.length) {
    await admin.storage.from('chat-attachments').remove(existingAttachments.map((a) => a.storage_path))
    await admin.from('message_attachments').delete().eq('message_id', messageId)
  }

  const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const path = `${cfg.type}/${cfg.transactionId}/${cfg.partyA.userId}/regression-test.jpg`

  const { error: uploadError } = await cfg.partyA.client.storage.from('chat-attachments').upload(path, fakeImage, { contentType: 'image/jpeg', upsert: false })
  check(`${cfg.label}: participant can upload to the thread's storage path`, !uploadError, uploadError)

  const registerRes = await api(cfg.partyA.cookie, 'POST', `/api/messages/${messageId}/attachments`, {
    storage_path: path,
    file_type: 'image',
    idempotency_key: `chat-regression-${cfg.type}-attach-register-${Date.now()}`,
  })
  check(`${cfg.label}: attachment registration succeeds`, registerRes.status === 201, registerRes)

  const mismatchedPath = `${cfg.type}/${cfg.transactionId}/${outsider.userId}/spoofed.jpg`
  const registerMismatch = await api(cfg.partyA.cookie, 'POST', `/api/messages/${messageId}/attachments`, {
    storage_path: mismatchedPath,
    file_type: 'image',
    idempotency_key: `chat-regression-${cfg.type}-attach-mismatch-${Date.now()}`,
  })
  check(`${cfg.label}: attachment path-prefix mismatch is rejected`, registerMismatch.status === 403, registerMismatch)

  const outsiderPath = `${cfg.type}/${cfg.transactionId}/${outsider.userId}/intruder-${Date.now()}.jpg`
  const { error: outsiderUploadError } = await outsider.client.storage.from('chat-attachments').upload(outsiderPath, fakeImage, { contentType: 'image/jpeg', upsert: false })
  check(`${cfg.label}: non-participant cannot upload to this thread's storage path`, !!outsiderUploadError, outsiderUploadError)

  const listAsB = await api(cfg.partyB.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}`)
  const withAttachment = (listAsB.json?.messages ?? []).find((m) => m.id === messageId)
  check(`${cfg.label}: registered attachment is visible to the other party`, (withAttachment?.attachments ?? []).length > 0, withAttachment)
}

async function checkRealtime(cfg) {
  console.log(`\n=== ${cfg.label}: realtime reception ===`)

  const received = new Promise((resolve) => {
    const channel = cfg.partyB.client
      .channel(`regression-${cfg.type}-${cfg.transactionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `${cfg.fetchParam}=eq.${cfg.transactionId}` },
        (payload) => {
          cfg.partyB.client.removeChannel(channel)
          resolve(payload.new)
        }
      )
      .subscribe()
  })

  await new Promise((r) => setTimeout(r, 1500)) // let the subscription establish before sending

  await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: `Realtime probe ${Date.now()}`,
    idempotency_key: `chat-regression-${cfg.type}-realtime-${Date.now()}`,
  })

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000))
  const result = await Promise.race([received, timeout])
  check(`${cfg.label}: realtime delivers the new message to the other party`, !!result, result)
}

// ── Fixtures ──
console.log('=== Fixtures ===')

const bookingListingId = await insertBaseListing(merchantA.userId, {
  title: `${QA_LISTING_MARKER} Chat-Security Regression — Booking`,
  description: 'Permanent regression fixture for verify-chat-security.mjs — do not delete.',
})
const bookingCreate = await api(renterA.cookie, 'POST', '/api/bookings', {
  listing_id: bookingListingId,
  start_at: '2031-01-01T00:00:00.000Z',
  end_at: '2031-01-04T00:00:00.000Z',
  idempotency_key: 'chat-regression-booking-create-v1',
})
const bookingId = bookingCreate.json?.booking_id
check('booking fixture created/replayed', !!bookingId, bookingCreate)

const orderListingId = await insertBaseListing(merchantA.userId, {
  title: `${QA_LISTING_MARKER} Chat-Security Regression — Order`,
  description: 'Permanent regression fixture for verify-chat-security.mjs — do not delete.',
  category: 'tools', listing_type: 'sale', daily_rate: null, sale_price: 250, quantity_available: 99,
})
const orderCreate = await api(renterA.cookie, 'POST', '/api/orders', {
  listing_id: orderListingId, quantity: 1, idempotency_key: 'chat-regression-order-create-v1',
})
const orderId = orderCreate.json?.order_id
check('order fixture created/replayed', !!orderId, orderCreate)

const barterListingAId = await insertBaseListing(merchantA.userId, {
  title: `${QA_LISTING_MARKER} Chat-Security Regression — Barter A`,
  description: 'Permanent regression fixture for verify-chat-security.mjs — do not delete.',
  category: 'music', daily_rate: 80,
})
const barterListingBId = await insertBaseListing(merchantB.userId, {
  title: `${QA_LISTING_MARKER} Chat-Security Regression — Barter B`,
  description: 'Permanent regression fixture for verify-chat-security.mjs — do not delete.',
  category: 'outdoor', daily_rate: 60,
})
const barterPropose = await api(merchantB.cookie, 'POST', '/api/barter', {
  anchor_listing_id: barterListingAId,
  party_a_listing_ids: [barterListingAId],
  party_b_listing_ids: [barterListingBId],
  delivery_method: 'meet_in_person',
  message: 'Chat-security regression fixture',
  idempotency_key: 'chat-regression-barter-propose-v1',
})
let barterId = barterPropose.json?.agreement_id
if (!barterId) {
  const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', barterListingAId).maybeSingle()
  barterId = existing?.id
}
check('barter fixture agreement exists', !!barterId, barterPropose)

if (!bookingId || !orderId || !barterId) {
  console.error('\nCannot continue -- one or more fixtures failed to create.')
  process.exit(1)
}

// ── Run checks ──
const bookingCfg = { label: 'BOOKING', type: 'booking', fetchParam: 'booking_id', transactionId: bookingId, partyA: renterA, partyB: merchantA }
const orderCfg = { label: 'ORDER', type: 'order', fetchParam: 'order_id', transactionId: orderId, partyA: renterA, partyB: merchantA }
const barterCfg = { label: 'BARTER', type: 'barter', fetchParam: 'barter_agreement_id', transactionId: barterId, partyA: merchantB, partyB: merchantA }

for (const cfg of [bookingCfg, orderCfg, barterCfg]) {
  await checkThreadSecurity(cfg)
  await checkAttachments(cfg)
  await checkRealtime(cfg)
}

// ── Dispute-tagged messaging: one thread, not two ──
console.log('\n=== DISPUTE-TAGGED MESSAGING: same thread as the transaction, tagged for audit ===')
{
  const openDispute = await api(renterA.cookie, 'POST', '/api/disputes', {
    booking_id: bookingId,
    title: 'Chat-security regression dispute',
    description: 'Permanent regression fixture.',
    requested_resolution: 'n/a',
    idempotency_key: 'chat-regression-dispute-open-v1',
  })
  let disputeId = openDispute.json?.dispute_id
  if (!disputeId) {
    const { data: existing } = await admin.from('disputes').select('id').eq('booking_id', bookingId).maybeSingle()
    disputeId = existing?.id
  }
  check('dispute fixture exists for the booking', !!disputeId, openDispute)

  if (disputeId) {
    const sendViaDispute = await api(renterA.cookie, 'POST', '/api/disputes/' + disputeId + '/messages', {
      content: 'Dispute-tagged message from the regression script',
      idempotency_key: 'chat-regression-dispute-message-v1',
    })
    check('message sent via the dispute wrapper route', sendViaDispute.status === 201, sendViaDispute)
    const disputeMessageId = sendViaDispute.json?.id

    const viaGeneralThread = await api(merchantA.cookie, 'GET', `/api/messages?booking_id=${bookingId}`)
    check(
      'dispute-tagged message appears in the booking\'s general thread',
      (viaGeneralThread.json?.messages ?? []).some((m) => m.id === disputeMessageId && m.dispute_id === disputeId),
      viaGeneralThread
    )

    const viaDisputeWrapper = await api(merchantA.cookie, 'GET', `/api/disputes/${disputeId}/messages`)
    check(
      'the dispute wrapper GET also returns the full transaction thread',
      (viaDisputeWrapper.json?.messages ?? []).some((m) => m.id === disputeMessageId),
      viaDisputeWrapper
    )
  }
}

// ── Audited admin access ──
console.log('\n=== AUDITED ADMIN ACCESS ===')
if (adminSession) {
  const before = await admin.from('admin_message_access_log').select('id', { count: 'exact', head: true }).eq('booking_id', bookingId)
  const adminGet = await api(adminSession.cookie, 'GET', `/api/admin/messages?booking_id=${bookingId}`)
  check('admin can read the booking thread via the audited endpoint', adminGet.status === 200 && (adminGet.json?.messages ?? []).length > 0, adminGet)
  const after = await admin.from('admin_message_access_log').select('id', { count: 'exact', head: true }).eq('booking_id', bookingId)
  check('admin_message_access_log gained a row for this access', (after.count ?? 0) > (before.count ?? 0), { before: before.count, after: after.count })

  const adminSend = await api(adminSession.cookie, 'POST', '/api/messages', {
    booking_id: bookingId,
    content: 'admin trying to impersonate a party',
    idempotency_key: 'chat-regression-admin-send-v1',
  })
  check('admin cannot send as if a party (no admin write policy)', adminSend.status >= 400, adminSend)
} else {
  console.log('  skipped -- no admin QA account in .qa-credentials.local.json')
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
