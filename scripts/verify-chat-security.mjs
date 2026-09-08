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
// Matches listMessages()'s own default page size (src/lib/messaging/service.ts: `input.limit ?? 50`).
const PAGE_SIZE_FOR_TEST = 50

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

// A fresh tag per script execution. The permanent BOOKING/ORDER/BARTER
// fixtures are reused indefinitely across runs, and listMessages() is a
// bounded ORDER BY created_at DESC LIMIT 50 query -- a fixed idempotency
// key on the send/attach-probe messages would replay the exact same row
// forever, letting it age outside that window as the thread accumulates
// history (confirmed live: the original fixed-key row ranked 56th in a
// 56-message thread). Tagging each run's probe messages keeps every
// assertion targeting a message that's actually in the returned window,
// without weakening what's asserted. The tag is still constant *within*
// one run, so the idempotent-replay check below (reusing the same key)
// still verifies real replay/dedupe behavior, not just uniqueness.
const RUN_TAG = `${Date.now()}`

// ── Generic thread-level checks, reused across booking/order/barter ──
async function checkThreadSecurity(cfg) {
  console.log(`\n=== ${cfg.label}: send / read / non-participant / forged id / idempotency ===`)

  const sendRes = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: `Hello from the ${cfg.label} regression fixture`,
    idempotency_key: `chat-regression-${cfg.type}-send-${RUN_TAG}`,
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
    idempotency_key: `chat-regression-${cfg.type}-send-${RUN_TAG}`,
  })
  check(`${cfg.label}: idempotent replay returns the same message`, replay.status === 201 && replay.json?.id === messageId, replay)

  return messageId
}

async function checkAttachments(cfg) {
  console.log(`\n=== ${cfg.label}: attachments ===`)

  const sendRes = await api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content: 'Attachment probe',
    idempotency_key: `chat-regression-${cfg.type}-attach-msg-${RUN_TAG}`,
  })
  const messageId = sendRes.json?.id
  check(`${cfg.label}: attachment probe message sent`, sendRes.status === 201, sendRes)
  if (!messageId) return null

  // Attachments are immutable/append-only by design (no update/delete
  // client policy -- see 20260815000001_message_attachments.sql), so a
  // re-run can't just overwrite last run's object at the same path. The
  // storage path stays fixed per type/transaction/user (only the message
  // it attaches to changes every run via RUN_TAG now), so reset by path
  // directly -- removing/deleting something that doesn't exist yet is a
  // safe no-op -- rather than by message_id, which is always fresh now
  // and would never match a prior run's row.
  const path = `${cfg.type}/${cfg.transactionId}/${cfg.partyA.userId}/regression-test.jpg`
  await admin.storage.from('chat-attachments').remove([path])
  await admin.from('message_attachments').delete().eq('storage_path', path)

  const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

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

  return { messageId, attachmentId: registerRes.json?.id ?? null }
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

const attachmentProbes = {}
for (const cfg of [bookingCfg, orderCfg, barterCfg]) {
  await checkThreadSecurity(cfg)
  attachmentProbes[cfg.type] = await checkAttachments(cfg)
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

// ── Stack 3 Phase A: >50-message pagination (opaque (created_at, id) keyset cursor) ──
console.log('\n=== PAGINATION: >50-message thread ===')
let paginationBookingId
let paginationNextCursor
{
  const paginationListingId = await insertBaseListing(merchantA.userId, {
    title: `${QA_LISTING_MARKER} Chat-Security Regression — Pagination`,
    description: 'Permanent regression fixture for verify-chat-security.mjs pagination checks — do not delete.',
  })
  const paginationBookingCreate = await api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: paginationListingId,
    start_at: '2032-01-01T00:00:00.000Z',
    end_at: '2032-01-04T00:00:00.000Z',
    idempotency_key: 'chat-regression-pagination-booking-create-v1',
  })
  paginationBookingId = paginationBookingCreate.json?.booking_id
  if (!paginationBookingId) {
    const { data: existingBooking } = await admin.from('bookings').select('id').eq('listing_id', paginationListingId).eq('renter_id', renterA.userId).maybeSingle()
    paginationBookingId = existingBooking?.id
  }
  check('pagination fixture booking created/replayed', !!paginationBookingId, paginationBookingCreate)

  if (paginationBookingId) {
    // Idempotent across re-runs -- top up to the target total rather than
    // sending 75 fresh messages every single run (the thread would grow
    // unboundedly otherwise).
    const TARGET_TOTAL = PAGE_SIZE_FOR_TEST + 25
    const { count: existingCount } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('booking_id', paginationBookingId)
    const toSend = Math.max(0, TARGET_TOTAL - (existingCount ?? 0))
    for (let i = 0; i < toSend; i++) {
      const seq = (existingCount ?? 0) + i + 1
      await api(renterA.cookie, 'POST', '/api/messages', {
        booking_id: paginationBookingId,
        content: `Pagination fixture message #${seq}`,
        idempotency_key: `chat-regression-pagination-msg-${seq}`,
      })
    }
    const { count: totalCount } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('booking_id', paginationBookingId)
    check(`pagination fixture thread has at least ${TARGET_TOTAL} messages`, (totalCount ?? 0) >= TARGET_TOTAL, { totalCount })

    // A. initial page (authorized participant) -- newest PAGE_SIZE_FOR_TEST
    const initialPage = await api(renterA.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}`)
    const initialMessages = initialPage.json?.messages ?? []
    check(`pagination: initial page returns exactly ${PAGE_SIZE_FOR_TEST} (authorized participant)`, initialPage.status === 200 && initialMessages.length === PAGE_SIZE_FOR_TEST, { status: initialPage.status, count: initialMessages.length })
    paginationNextCursor = initialPage.json?.nextCursor ?? null
    check('pagination: initial page returns a nextCursor (more history exists)', !!paginationNextCursor, { nextCursor: paginationNextCursor })

    // B. older page via the opaque (created_at, id) keyset cursor (see
    // src/lib/messaging/cursor.ts) -- already supported server-side by
    // listMessages() -- no new route.
    const olderPage = paginationNextCursor
      ? await api(renterA.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}&cursor=${encodeURIComponent(paginationNextCursor)}`)
      : { status: 0, json: null }
    const olderMessages = olderPage.json?.messages ?? []
    check('pagination: older page loads successfully via cursor=', olderPage.status === 200, olderPage)

    // C. combined unique -- 0 duplicates
    const combinedIds = new Set([...initialMessages, ...olderMessages].map((m) => m.id))
    check(
      'pagination: combined unique count matches the sum of both pages (0 duplicates)',
      combinedIds.size === initialMessages.length + olderMessages.length,
      { combinedUnique: combinedIds.size, initial: initialMessages.length, older: olderMessages.length }
    )

    // D. 0 missing, relative to the true newest TARGET_TOTAL rows in the DB
    const { data: allDbMessages } = await admin.from('messages').select('id').eq('booking_id', paginationBookingId).order('created_at', { ascending: false }).limit(TARGET_TOTAL)
    const missing = (allDbMessages ?? []).filter((m) => !combinedIds.has(m.id)).length
    check('pagination: 0 missing messages across both pages', missing === 0, { missing, dbTotal: (allDbMessages ?? []).length, combinedTotal: combinedIds.size })

    // E. chronological order preserved within and across pages
    const isChron = (arr) => arr.every((m, i) => i === 0 || new Date(arr[i - 1].created_at).getTime() <= new Date(m.created_at).getTime())
    check('pagination: initial page is chronologically ordered', isChron(initialMessages), {})
    check('pagination: older page is chronologically ordered', isChron(olderMessages), {})
    check(
      'pagination: the older page entirely precedes the initial page (correct boundary, no overlap/gap)',
      olderMessages.length === 0 || new Date(olderMessages[olderMessages.length - 1].created_at).getTime() <= new Date(initialMessages[0].created_at).getTime(),
      {}
    )

    // F. unrelated authenticated user DENY, both initial and older/cursor requests
    const initialAsOutsider = await api(outsider.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}`)
    check('pagination: unrelated authenticated user DENY on initial page', initialAsOutsider.status === 404, initialAsOutsider)
    const olderAsOutsider = paginationNextCursor
      ? await api(outsider.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}&cursor=${encodeURIComponent(paginationNextCursor)}`)
      : { status: 404 }
    check('pagination: unrelated authenticated user DENY on older/cursor page', olderAsOutsider.status === 404, olderAsOutsider)

    // G. anonymous DENY
    const initialAsAnon = await api(null, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}`)
    check('pagination: anonymous DENY', initialAsAnon.status === 401, initialAsAnon)

    // H. cross-thread cursor -- a cursor minted for the pagination thread
    // is bound to that thread's id (see computeMessagesCursorContext in
    // src/lib/messaging/cursor.ts), so replaying it against a DIFFERENT
    // thread -- even one renterA is legitimately a participant of -- is
    // rejected outright (400), not silently substituted with that other
    // thread's own page. Stronger than mere non-leakage: the cursor is
    // never even accepted cross-thread.
    const crossThreadCursor = paginationNextCursor
      ? await api(renterA.cookie, 'GET', `/api/messages?booking_id=${bookingId}&limit=${PAGE_SIZE_FOR_TEST}&cursor=${encodeURIComponent(paginationNextCursor)}`)
      : { status: 0, json: null }
    check(
      'pagination: a cursor minted for a different thread is rejected (400) even against a thread the caller legitimately participates in',
      crossThreadCursor.status === 400,
      crossThreadCursor
    )

    // I. invalid cursor -- safe error, no leakage/crash
    const invalidCursor = await api(renterA.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&cursor=not-a-real-cursor`)
    check('pagination: invalid cursor value is rejected safely (400), not a 5xx/crash', invalidCursor.status === 400, invalidCursor)
  }
}

// ── Stack 3 Phase A follow-up: equal created_at tie-breaker (adversarial) ──
// created_at has no UNIQUE constraint (messages table, 20260613000001) --
// Postgres now() is stable within a transaction, so distinct messages can
// legally share an identical created_at. A plain created_at-only keyset
// cursor silently drops any same-timestamp row not already returned on
// the page it landed in, once that group straddles a page boundary.
// Proven live pre-fix via a scratch probe using this exact fixture shape
// (44 distinct-newer + 8 tied-at-T + 5 distinct-older = 57 total): the
// created_at-only implementation returned only 55 of 57 (2 permanently
// missing, page1=50/page2=5, 0 duplicates) -- confirming the defect via
// the real API, not a synthetic unit test. This block is the permanent
// regression form of that probe, run against the shipped composite
// (created_at, id) keyset fix.
console.log('\n=== PAGINATION: equal created_at tie-breaker (adversarial) ===')
{
  const tieListingId = await insertBaseListing(merchantA.userId, {
    title: `${QA_LISTING_MARKER} Chat-Security Regression — Tie Breaker`,
    description: 'Permanent regression fixture for verify-chat-security.mjs equal-created_at pagination checks — do not delete.',
  })
  const tieBookingCreate = await api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: tieListingId,
    start_at: '2033-01-01T00:00:00.000Z',
    end_at: '2033-01-04T00:00:00.000Z',
    idempotency_key: 'chat-regression-tiebreak-booking-create-v1',
  })
  let tieBookingId = tieBookingCreate.json?.booking_id
  if (!tieBookingId) {
    const { data: existing } = await admin.from('bookings').select('id').eq('listing_id', tieListingId).eq('renter_id', renterA.userId).maybeSingle()
    tieBookingId = existing?.id
  }
  check('tie-breaker fixture booking created/replayed', !!tieBookingId, tieBookingCreate)

  if (tieBookingId) {
    // Deterministic, reproducible on every re-run -- replace the fixture
    // set each time rather than accumulating (this is a fixed synthetic
    // scenario, not organically-growing history like the other fixtures).
    await admin.from('messages').delete().eq('booking_id', tieBookingId)

    const T = new Date('2033-06-01T12:00:00.000Z')
    const rows = []
    for (let i = 44; i >= 1; i--) {
      rows.push({ booking_id: tieBookingId, sender_id: renterA.userId, content: `newer-${i}`, created_at: new Date(T.getTime() + i * 1000).toISOString() })
    }
    for (let i = 1; i <= 8; i++) {
      rows.push({ booking_id: tieBookingId, sender_id: renterA.userId, content: `tied-${i}`, created_at: T.toISOString() })
    }
    for (let i = 1; i <= 5; i++) {
      rows.push({ booking_id: tieBookingId, sender_id: renterA.userId, content: `older-${i}`, created_at: new Date(T.getTime() - i * 1000).toISOString() })
    }
    const { data: tieInserted, error: tieInsertError } = await admin.from('messages').insert(rows).select('id')
    check('tie-breaker fixture: 57 messages inserted (44 distinct-newer + 8 tied-at-T + 5 distinct-older, straddling the 50 boundary)', !tieInsertError && tieInserted?.length === 57, tieInsertError ?? { inserted: tieInserted?.length })

    const expectedIds = new Set((tieInserted ?? []).map((m) => m.id))

    const tiePage1 = await api(renterA.cookie, 'GET', `/api/messages?booking_id=${tieBookingId}&limit=${PAGE_SIZE_FOR_TEST}`)
    const tiePage1Ids = (tiePage1.json?.messages ?? []).map((m) => m.id)
    const tieCursor = tiePage1.json?.nextCursor ?? null

    const tiePage2 = tieCursor
      ? await api(renterA.cookie, 'GET', `/api/messages?booking_id=${tieBookingId}&limit=${PAGE_SIZE_FOR_TEST}&cursor=${encodeURIComponent(tieCursor)}`)
      : { status: 0, json: null }
    const tiePage2Ids = (tiePage2.json?.messages ?? []).map((m) => m.id)

    const tieCombined = new Set([...tiePage1Ids, ...tiePage2Ids])
    const tieMissing = [...expectedIds].filter((id) => !tieCombined.has(id))
    const tieDuplicates = tiePage1Ids.length + tiePage2Ids.length - tieCombined.size

    check('tie-breaker: expected 57, page1=50, page2=7', tiePage1Ids.length === 50 && tiePage2Ids.length === 57 - 50, {
      expected: 57, page1: tiePage1Ids.length, page2: tiePage2Ids.length,
    })
    check('tie-breaker: 0 duplicates across both pages', tieDuplicates === 0, { duplicates: tieDuplicates })
    check('tie-breaker: 0 missing across both pages (every id from the shared-timestamp group accounted for)', tieMissing.length === 0, { missing: tieMissing.length, missingIds: tieMissing })
    check('tie-breaker: combined unique count is exactly 57', tieCombined.size === 57, { combinedUnique: tieCombined.size })
  }
}

// ── Stack 3 Phase B: authorized signed attachment viewing ──
console.log('\n=== ATTACHMENT ACCESS: authorized signed viewing ===')
{
  const bookingProbe = attachmentProbes.booking
  const orderProbe = attachmentProbes.order

  if (bookingProbe?.messageId && bookingProbe?.attachmentId) {
    const { messageId, attachmentId } = bookingProbe

    const accSender = await api(bookingCfg.partyA.cookie, 'POST', `/api/messages/${messageId}/attachments/${attachmentId}/access`)
    check('attachment access: sender (uploader) -> 200 + signed url', accSender.status === 200 && !!accSender.json?.url, accSender)

    const accParticipant = await api(bookingCfg.partyB.cookie, 'POST', `/api/messages/${messageId}/attachments/${attachmentId}/access`)
    check('attachment access: other thread participant -> 200 + signed url', accParticipant.status === 200 && !!accParticipant.json?.url, accParticipant)

    const accOutsider = await api(outsider.cookie, 'POST', `/api/messages/${messageId}/attachments/${attachmentId}/access`)
    check('attachment access: unrelated authenticated user -> DENY (404)', accOutsider.status === 404 && !accOutsider.json?.url, accOutsider)

    const accAnon = await api(null, 'POST', `/api/messages/${messageId}/attachments/${attachmentId}/access`)
    check('attachment access: anonymous -> DENY (401)', accAnon.status === 401, accAnon)

    if (adminSession) {
      const accAdmin = await api(adminSession.cookie, 'POST', `/api/messages/${messageId}/attachments/${attachmentId}/access`)
      check('attachment access: admin -> 200 + signed url', accAdmin.status === 200 && !!accAdmin.json?.url, accAdmin)
    }

    if (accSender.json?.url) {
      const fetched = await fetch(accSender.json.url)
      check('attachment access: signed URL retrieval actually returns the object (200)', fetched.status === 200, { status: fetched.status })
    } else {
      check('attachment access: signed URL retrieval actually returns the object (200)', false, { reason: 'no url from sender access check' })
    }

    // message/attachment mismatch: renterA is a genuine participant in
    // BOTH the booking and order threads, so a denial here is
    // attributable specifically to the (id, message_id) mismatch, not to
    // renterA lacking thread membership.
    if (orderProbe?.messageId) {
      const crossMismatch = await api(bookingCfg.partyA.cookie, 'POST', `/api/messages/${orderProbe.messageId}/attachments/${attachmentId}/access`)
      check(
        'attachment access: message/attachment mismatch (order message + booking attachment, same authorized user) -> DENY (404)',
        crossMismatch.status === 404 && !crossMismatch.json?.url,
        crossMismatch
      )
    }
  } else {
    check('attachment access matrix: booking attachment probe fixture available', false, bookingProbe)
  }
}

// ── Stack 3 integration: >50-message thread + attachments on both pages ──
console.log('\n=== INTEGRATED: >50-message thread + attachments across both pages ===')
{
  if (paginationBookingId) {
    const { data: oldestMsg } = await admin.from('messages').select('id').eq('booking_id', paginationBookingId).order('created_at', { ascending: true }).limit(1).single()
    const { data: newestMsg } = await admin.from('messages').select('id').eq('booking_id', paginationBookingId).order('created_at', { ascending: false }).limit(1).single()
    const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

    async function attachTo(msgId, tag) {
      const path = `booking/${paginationBookingId}/${renterA.userId}/pagination-${tag}.jpg`
      await admin.storage.from('chat-attachments').remove([path])
      await admin.from('message_attachments').delete().eq('storage_path', path)
      await renterA.client.storage.from('chat-attachments').upload(path, fakeImage, { contentType: 'image/jpeg', upsert: false })
      const reg = await api(renterA.cookie, 'POST', `/api/messages/${msgId}/attachments`, { storage_path: path, file_type: 'image', idempotency_key: `chat-regression-pagination-attach-${tag}-${Date.now()}` })
      return reg.json?.id ?? null
    }

    const newestAttachmentId = newestMsg ? await attachTo(newestMsg.id, 'newest') : null
    const oldestAttachmentId = oldestMsg ? await attachTo(oldestMsg.id, 'oldest') : null
    check('integrated: attachment on newest (initial-page) message registered', !!newestAttachmentId, {})
    check('integrated: attachment on oldest (older-page) message registered', !!oldestAttachmentId, {})

    const initialWithAttach = await api(renterA.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}`)
    const initialMsgs2 = initialWithAttach.json?.messages ?? []
    const newestInInitial = initialMsgs2.find((m) => m.id === newestMsg?.id)
    check('integrated: newest-page attachment metadata is present in the initial page response', (newestInInitial?.attachments ?? []).length > 0, newestInInitial)

    const initialWithAttachCursor = initialWithAttach.json?.nextCursor ?? null
    const olderWithAttach = initialWithAttachCursor
      ? await api(renterA.cookie, 'GET', `/api/messages?booking_id=${paginationBookingId}&limit=${PAGE_SIZE_FOR_TEST}&cursor=${encodeURIComponent(initialWithAttachCursor)}`)
      : { json: null }
    const oldestInOlder = (olderWithAttach.json?.messages ?? []).find((m) => m.id === oldestMsg?.id)
    check('integrated: older-page attachment metadata is preserved across pagination (never omitted)', (oldestInOlder?.attachments ?? []).length > 0, oldestInOlder)

    if (newestAttachmentId && newestMsg) {
      const accNewest = await api(renterA.cookie, 'POST', `/api/messages/${newestMsg.id}/attachments/${newestAttachmentId}/access`)
      check('integrated: newest-page attachment is viewable by an authorized participant', accNewest.status === 200 && !!accNewest.json?.url, accNewest)
    }
    if (oldestAttachmentId && oldestMsg) {
      const accOldest = await api(renterA.cookie, 'POST', `/api/messages/${oldestMsg.id}/attachments/${oldestAttachmentId}/access`)
      check('integrated: older-page attachment is viewable by an authorized participant (no access difference by page)', accOldest.status === 200 && !!accOldest.json?.url, accOldest)
    }

    const { count: newestAttachCount } = await admin.from('message_attachments').select('id', { count: 'exact', head: true }).eq('message_id', newestMsg?.id)
    check('integrated: no duplicate attachment rows on the newest-page message', (newestAttachCount ?? 0) === 1, { newestAttachCount })

    console.log(
      '  NOTE: realtime message INSERT events never carry attachment metadata by design -- attachments are registered in a separate follow-up call after the message row exists, and there is no message_attachments realtime subscription anywhere in this codebase. Attachment metadata always requires a fresh GET (initial load, pagination, or thread switch). This is the existing, correct mechanism -- preserved as-is, not changed by this phase.'
    )
  }
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
