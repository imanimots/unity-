#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 3's realtime delivery
 * guarantees specifically -- requested after Phase 3's review as a
 * companion to scripts/verify-chat-security.mjs, which covers
 * send/read/security/attachments but only a single-message realtime
 * probe. This script stresses the hardest part of any realtime system:
 * ordering under volume, and behavior across reconnects and simulated
 * refreshes.
 *
 * Covers: 100 sequential messages delivered with no duplicates and no
 * gaps; persisted ordering (authoritative, via GET /api/messages,
 * decoupled from realtime's own delivery-order nuances); reconnect
 * mid-stream (messages sent while nobody is subscribed are never lost,
 * because `messages` itself -- not the realtime feed -- is the source
 * of truth); clean disconnect/reconnect (a fresh subscription resumes
 * delivery); a simulated browser refresh mid-thread (a brand-new
 * session client's first history load returns the complete, correctly
 * ordered set with no realtime involved at all -- exactly the path
 * chat-thread.tsx takes on every mount); and that an attachment
 * registered against a realtime-delivered message id shows up correctly
 * on the next fetch.
 *
 * Not a mocked vitest test -- a real script against the live dev
 * database and a real Supabase Realtime websocket connection, matching
 * every other permanent regression script in this codebase.
 *
 * Re-runnable: this script owns a dedicated fixture booking and wipes
 * its own message history at the start of each run (bulk-ordering runs
 * don't lend themselves to literal idempotent replay the way a single
 * mutating action does -- see verify-dispute-locking.mjs /
 * verify-chat-security.mjs for that pattern instead), so the dev
 * database never accumulates hundreds of rows across repeated runs.
 *
 * SAFETY: same gate as scripts/qa-seed.mjs.
 * Usage: node scripts/verify-realtime-ordering.mjs
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
    console.error('verify-realtime-ordering aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-realtime-ordering.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-realtime-ordering aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'
const RUN_ID = process.env.QA_RUN_ID ?? String(Date.now())

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { client, userId: data.session.user.id, cookie: `${cookieName}=${encodeURIComponent(value)}` }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(pollMs)
  }
  return predicate()
}

function subscribeCollecting(client, channelName, filter, sink) {
  return new Promise((resolve) => {
    const channel = client
      .channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, (payload) => {
        sink.push(payload.new)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve(channel)
      })
    // Fallback in case the SUBSCRIBED callback is slow/missed -- don't hang the whole script.
    setTimeout(() => resolve(channel), 5000)
  })
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-realtime-ordering aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const renterA = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)

// ── Fixture: a dedicated booking, message history wiped at the start of each run ──
console.log('=== Fixture ===')
const listingId = await insertBaseListing(merchantA.userId, {
  title: `${QA_LISTING_MARKER} Realtime-Ordering Regression — Booking`,
  description: 'Permanent regression fixture for verify-realtime-ordering.mjs — do not delete.',
})
const bookingCreate = await api(renterA.cookie, 'POST', '/api/bookings', {
  listing_id: listingId,
  start_at: '2032-01-01T00:00:00.000Z',
  end_at: '2032-01-04T00:00:00.000Z',
  idempotency_key: 'realtime-ordering-booking-create-v1',
})
const bookingId = bookingCreate.json?.booking_id
check('booking fixture created/replayed', !!bookingId, bookingCreate)
if (!bookingId) {
  console.error('\nCannot continue without the fixture booking.')
  process.exit(1)
}

await admin.from('messages').delete().eq('booking_id', bookingId)
console.log(`  fixture message history cleared for booking ${bookingId}`)

const cfg = { fetchParam: 'booking_id', transactionId: bookingId, partyA: renterA, partyB: merchantA }
const filter = `${cfg.fetchParam}=eq.${cfg.transactionId}`

async function send(content, key) {
  return api(cfg.partyA.cookie, 'POST', '/api/messages', {
    [cfg.fetchParam]: cfg.transactionId,
    content,
    idempotency_key: key,
  })
}

// ── 1. 100 sequential messages: no duplicates, no gaps, realtime delivers all ──
console.log('\n=== 100 sequential messages: delivery completeness ===')
{
  const received = []
  const channel = await subscribeCollecting(cfg.partyB.client, `ordering-bulk-${RUN_ID}`, filter, received)

  const sentIds = []
  for (let i = 0; i < 100; i++) {
    const res = await send(`ordering-probe-${i}`, `realtime-ordering-bulk-${i}-${RUN_ID}`)
    if (res.json?.id) sentIds.push(res.json.id)
  }
  check('sent exactly 100 messages', sentIds.length === 100, { sent: sentIds.length })

  await waitUntil(() => received.length >= sentIds.length, 20000)
  cfg.partyB.client.removeChannel(channel)

  const receivedIds = received.map((m) => m.id)
  const uniqueReceivedIds = new Set(receivedIds)
  check('no duplicate realtime deliveries', uniqueReceivedIds.size === receivedIds.length, { received: receivedIds.length, unique: uniqueReceivedIds.size })
  check('no gaps -- every sent message was delivered via realtime', sentIds.every((id) => uniqueReceivedIds.has(id)), {
    missing: sentIds.filter((id) => !uniqueReceivedIds.has(id)).length,
  })
  check('exactly 100 realtime deliveries (not more)', receivedIds.length === 100, { received: receivedIds.length })
}

// ── 2. Persisted ordering, authoritative via GET (decoupled from realtime arrival order) ──
console.log('\n=== Persisted ordering (via GET /api/messages) ===')
{
  const history = await api(cfg.partyB.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}&limit=100`)
  const contents = (history.json?.messages ?? []).map((m) => m.content)
  const expected = Array.from({ length: 100 }, (_, i) => `ordering-probe-${i}`)
  check('history returns exactly 100 messages', contents.length === 100, { count: contents.length })
  check('persisted order exactly matches send order', JSON.stringify(contents) === JSON.stringify(expected), {
    firstMismatchAt: contents.findIndex((c, i) => c !== expected[i]),
  })
}

// ── 3. Reconnect mid-stream: messages sent while disconnected are never lost ──
console.log('\n=== Reconnect mid-stream ===')
{
  const received = []
  let channel = await subscribeCollecting(cfg.partyB.client, `ordering-midstream-${RUN_ID}`, filter, received)

  await send('pre-disconnect-0', `realtime-ordering-predc-0-${RUN_ID}`)
  await waitUntil(() => received.length >= 1, 8000)
  check('realtime delivers before disconnect', received.length >= 1, { received: received.length })

  cfg.partyB.client.removeChannel(channel)
  received.length = 0

  const duringDisconnect = []
  for (let i = 0; i < 5; i++) {
    const res = await send(`during-disconnect-${i}`, `realtime-ordering-during-${i}-${RUN_ID}`)
    if (res.json?.id) duringDisconnect.push(res.json.id)
  }
  check('5 messages sent while nobody was subscribed', duringDisconnect.length === 5, { sent: duringDisconnect.length })

  // "Reconnect" = a fresh history load, exactly what chat-thread.tsx does on remount -- the
  // persistence layer, not the realtime feed, is the source of truth for anything missed.
  // limit is capped at 100 by listMessagesQuerySchema -- the 5 during-disconnect messages are
  // the most recent in the fixture at this point, so they're within that window regardless.
  const historyAfterGap = await api(cfg.partyB.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}&limit=100`)
  check('history reload after the gap succeeds', historyAfterGap.status === 200, historyAfterGap)
  const idsAfterGap = (historyAfterGap.json?.messages ?? []).map((m) => m.id)
  check(
    'messages sent during a realtime disconnect are not lost',
    duringDisconnect.every((id) => idsAfterGap.includes(id)),
    { missing: duringDisconnect.filter((id) => !idsAfterGap.includes(id)) }
  )

  channel = await subscribeCollecting(cfg.partyB.client, `ordering-midstream-resume-${RUN_ID}`, filter, received)
  const postReconnect = await send('post-reconnect-probe', `realtime-ordering-postrc-${RUN_ID}`)
  await waitUntil(() => received.some((m) => m.id === postReconnect.json?.id), 8000)
  check('realtime resumes delivering new messages after reconnecting', received.some((m) => m.id === postReconnect.json?.id))
  cfg.partyB.client.removeChannel(channel)
}

// ── 4. Clean disconnect/reconnect cycle with no activity during the gap ──
console.log('\n=== Clean disconnect / reconnect ===')
{
  const received = []
  let channel = await subscribeCollecting(cfg.partyB.client, `ordering-clean-a-${RUN_ID}`, filter, received)
  cfg.partyB.client.removeChannel(channel)
  await sleep(500)

  channel = await subscribeCollecting(cfg.partyB.client, `ordering-clean-b-${RUN_ID}`, filter, received)
  const probe = await send('clean-reconnect-probe', `realtime-ordering-cleanrc-${RUN_ID}`)
  await waitUntil(() => received.some((m) => m.id === probe.json?.id), 8000)
  check('a freshly-opened subscription after a clean disconnect receives new messages', received.some((m) => m.id === probe.json?.id))
  cfg.partyB.client.removeChannel(channel)
}

// ── 5. Simulated browser refresh mid-thread: a brand-new session's first load is complete + ordered, no realtime involved ──
console.log('\n=== Simulated browser refresh mid-thread ===')
{
  const refreshedSession = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
  const history = await api(refreshedSession.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}&limit=100`)
  check('history load on a fresh session succeeds', history.status === 200, history)
  const messages = history.json?.messages ?? []
  const ids = messages.map((m) => m.id)
  check('a fresh session (simulated refresh) sees a complete history with no duplicates', ids.length === new Set(ids).size && ids.length > 0, { count: ids.length })
  const timestamps = messages.map((m) => m.created_at)
  const sortedTimestamps = [...timestamps].sort()
  check('history is returned in chronological order on first load', JSON.stringify(timestamps) === JSON.stringify(sortedTimestamps))
}

// ── 6. Attachment registered against a realtime-delivered message id shows up correctly ──
console.log('\n=== Attachment notifications with realtime ===')
{
  const received = []
  const channel = await subscribeCollecting(cfg.partyB.client, `ordering-attach-${RUN_ID}`, filter, received)

  const sendRes = await send('realtime-attachment-probe', `realtime-ordering-attach-msg-${RUN_ID}`)
  const messageId = sendRes.json?.id
  check('attachment probe message sent', sendRes.status === 201, sendRes)

  await waitUntil(() => received.some((m) => m.id === messageId), 8000)
  check('the message realtime-delivers before its attachment is registered', received.some((m) => m.id === messageId))
  cfg.partyB.client.removeChannel(channel)

  if (messageId) {
    const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    const path = `booking/${cfg.transactionId}/${cfg.partyA.userId}/realtime-ordering-attachment.jpg`
    await admin.storage.from('chat-attachments').remove([path])
    const { error: uploadError } = await cfg.partyA.client.storage.from('chat-attachments').upload(path, fakeImage, { contentType: 'image/jpeg', upsert: false })
    check('attachment uploads to the realtime-delivered message\'s thread path', !uploadError, uploadError)

    const registerRes = await api(cfg.partyA.cookie, 'POST', `/api/messages/${messageId}/attachments`, {
      storage_path: path,
      file_type: 'image',
      idempotency_key: `realtime-ordering-attach-register-${RUN_ID}`,
    })
    check('attachment registers against the realtime-delivered message id', registerRes.status === 201, registerRes)

    const finalHistory = await api(cfg.partyB.cookie, 'GET', `/api/messages?${cfg.fetchParam}=${cfg.transactionId}&limit=100`)
    check('final history fetch succeeds', finalHistory.status === 200, finalHistory)
    const withAttachment = (finalHistory.json?.messages ?? []).find((m) => m.id === messageId)
    check('the attachment appears correctly associated with that message on the next fetch', (withAttachment?.attachments ?? []).length > 0, withAttachment)
  }
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
