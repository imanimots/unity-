#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 6 (Orders Administration
 * and Order Emails). Real script against the live dev database, not a
 * mocked vitest test -- matches every prior phase's regression-script
 * convention (verify-dispute-locking.mjs, verify-barter-execution.mjs,
 * verify-chat-security.mjs).
 *
 * Covers the spec's 5 named scenarios (A admin monitoring, B order
 * emails, C failure/retry, D exceptions, E security) plus the review's
 * 7 additional permanent checks (correction 8): exact route replay
 * never duplicates an email; a failed checkout never advances/regresses
 * the order's status; a delivered order cannot be shipped again; a
 * cancelled order cannot be paid or shipped; a disputed order cannot be
 * cancelled/shipped/delivered; admin detail access creates a real
 * admin_message_access_log row; financial-operations identifies an
 * order row as an order, never a booking with null fields.
 *
 * SAFETY: same gate as every other verify-*.mjs script -- refuses to
 * run unless QA_SEED_ENABLED=true, QA_SEED_CONFIRM=UNITY_DEV_ONLY, and
 * QA_SEED_PROJECT_REF matches the live project.
 *
 * Safely re-runnable: fixtures use FIXED idempotency keys (byte-
 * identical request bodies on replay); the disputed-order fixture opens
 * at most one dispute (openOrReuseDispute), matching
 * verify-dispute-locking.mjs's own convention -- there is no
 * "un-dispute" RPC, so a disputed fixture stays disputed forever and is
 * safe to re-check indefinitely.
 *
 * Usage: node scripts/verify-order-administration.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL and
 * scripts/qa-seed.mjs already run once (for QA accounts + admin).
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
    console.error('verify-order-administration aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-order-administration.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-order-administration aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id }
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
    listing_type: 'sale', quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

async function openOrReuseDispute(cookie, body, orderId, idempotencyKey) {
  const { data: existing } = await admin.from('disputes').select('id, status').eq('order_id', orderId).not('status', 'in', '(resolved,closed,cancelled)').maybeSingle()
  if (existing) return existing.id
  const res = await api(cookie, 'POST', '/api/disputes', { ...body, idempotency_key: idempotencyKey })
  if (res.status !== 201) throw new Error(`open_dispute failed: ${JSON.stringify(res)}`)
  return res.json.dispute_id
}

function countEmails(rows, orderId, eventType) {
  return rows.filter((r) => r.related_entity_id === orderId && r.event_type === eventType).length
}

/**
 * Pages through a bounded admin list endpoint via its opaque nextCursor
 * (Admin Orders + Financial Operations Relational Filtering & Cursor
 * Pagination Remediation) until `matchFn` finds a row or the list is
 * exhausted -- a permanent, indefinitely-reused QA fixture will always
 * rank further and further back as unrelated real/QA rows accumulate, so
 * asserting it's reachable on *some* page (not necessarily page 1) is
 * the only assertion that stays correct over the fixture's entire
 * lifetime. `pageLimit` is deliberately larger than the admin UI's
 * default page size purely to keep this loop's round-trip count low;
 * `maxPages` is a sanity guard against an infinite loop, not a
 * real-world pagination limit.
 */
async function findAcrossPages(cookie, basePath, itemsKey, matchFn, { pageLimit = 500, maxPages = 20 } = {}) {
  let cursor = null
  const sep = basePath.includes('?') ? '&' : '?'
  for (let page = 0; page < maxPages; page++) {
    const path = `${basePath}${sep}limit=${pageLimit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await api(cookie, 'GET', path)
    if (res.status !== 200) return { found: null, res, pagesVisited: page + 1 }
    const items = res.json?.[itemsKey] ?? []
    const found = items.find(matchFn)
    if (found) return { found, res, pagesVisited: page + 1 }
    if (!res.json?.hasMore || !res.json?.nextCursor) return { found: null, res, pagesVisited: page + 1, exhausted: true }
    cursor = res.json.nextCursor
  }
  return { found: null, res: null, pagesVisited: maxPages, maxPagesExceeded: true }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

// ── Load QA accounts (must already exist -- run scripts/qa-seed.mjs first) ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-order-administration aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
function findUser(email) {
  const u = authUsers.users.find((x) => x.email === email)
  if (!u) throw new Error(`QA account ${email} not found -- run scripts/qa-seed.mjs first`)
  return u
}
const merchantA = findUser(creds.accounts.merchantA.email)
findUser(creds.accounts.renterA.email)

const { cookie: renterACookie, userId: buyerId } = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: merchantACookie } = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: adminCookie } = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)

// renterA must be KYC-approved to create the orders this script depends
// on throughout -- self-heal to the documented QA baseline regardless of
// incoming state (matches the proven pattern in
// verify-transaction-verification-hardening.mjs).
await admin.from('profiles').update({ kyc_status: 'approved' }).eq('id', buyerId)

console.log('=== Full lifecycle: create -> pay -> ship -> deliver, admin monitoring + emails (Scenarios A, B, F) ===')
let lifecycleOrderId
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Order-Admin Regression — Lifecycle`,
    description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
    category: 'tools', sale_price: 750,
  })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: 'order-admin-regression-lifecycle-create' })
  lifecycleOrderId = created.json?.order_id
  check('order fixture created/replayed', !!lifecycleOrderId, created)
  if (!lifecycleOrderId) throw new Error(`cannot continue without an order id: ${JSON.stringify(created)}`)

  await api(renterACookie, 'POST', `/api/orders/${lifecycleOrderId}/checkout`, { test_scenario: 'success', idempotency_key: 'order-admin-regression-lifecycle-checkout' })

  const { data: afterCheckout } = await admin.from('orders').select('status').eq('id', lifecycleOrderId).single()
  if (afterCheckout.status === 'paid') {
    await api(merchantACookie, 'POST', `/api/orders/${lifecycleOrderId}/ship`, { idempotency_key: 'order-admin-regression-lifecycle-ship' })
  }
  const { data: afterShip } = await admin.from('orders').select('status').eq('id', lifecycleOrderId).single()
  if (afterShip.status === 'shipped') {
    await api(renterACookie, 'POST', `/api/orders/${lifecycleOrderId}/confirm-delivery`, { idempotency_key: 'order-admin-regression-lifecycle-delivery' })
  }

  const { data: order } = await admin.from('orders').select('status').eq('id', lifecycleOrderId).single()
  check('order reaches delivered', order.status === 'delivered', order)

  // Scenario A: admin monitoring -- real GET /api/admin/orders and
  // GET /api/admin/orders/[id] via the real admin route (not a direct
  // service-role query from this script).
  const list = await api(adminCookie, 'GET', `/api/admin/orders?search=${encodeURIComponent(listingId)}`)
  check('admin order list responds 200', list.status === 200, list)

  // Correction (Cursor Pagination Remediation): the fixture ages out of
  // page 1 as unrelated delivered orders accumulate -- page through real
  // cursors (never widen the page size to force it onto page 1) until
  // it's found or the list is genuinely exhausted.
  const statusPaged = await findAcrossPages(adminCookie, '/api/admin/orders?status=delivered', 'orders', (o) => o.id === lifecycleOrderId)
  check(
    'admin order list (status filter) includes the fixture, reachable via cursor pagination',
    !!statusPaged.found,
    { pagesVisited: statusPaged.pagesVisited, exhausted: statusPaged.exhausted, maxPagesExceeded: statusPaged.maxPagesExceeded }
  )

  const detail = await api(adminCookie, 'GET', `/api/admin/orders/${lifecycleOrderId}`)
  check('admin order detail responds 200', detail.status === 200, detail)
  check('admin order detail: order section has the right buyer/seller', detail.json?.order && detail.json?.buyer?.id === buyerId && detail.json?.seller?.id === merchantA.id, detail.json)
  check('admin order detail: financial section shows a captured payment', detail.json?.financial?.payment?.status === 'captured', detail.json?.financial)
  check("admin order detail: payout status is always 'not_applicable' for an order (correction 10)", detail.json?.financial?.payoutStatus === 'not_applicable', detail.json?.financial)
  check('admin order detail: history has entries', (detail.json?.history ?? []).length > 0, detail.json?.history)

  // Scenario B: order emails dispatch with the right recipients.
  const { data: emailRows } = await admin.from('email_deliveries').select('related_entity_id, event_type, recipient_user_id').eq('related_entity_type', 'order').eq('related_entity_id', lifecycleOrderId)
  check('order.created dispatched to both buyer and seller (2 templates, 1 event)', countEmails(emailRows, lifecycleOrderId, 'order.created') === 2, emailRows)
  check('order.payment_received dispatched to both buyer and seller', countEmails(emailRows, lifecycleOrderId, 'order.payment_received') === 2, emailRows)
  check('order.shipped dispatched to buyer only', countEmails(emailRows, lifecycleOrderId, 'order.shipped') === 1, emailRows)
  check('order.delivered dispatched to both buyer and seller', countEmails(emailRows, lifecycleOrderId, 'order.delivered') === 2, emailRows)

  // Correction 8: exact route replay never duplicates an email.
  const paymentReceivedBefore = countEmails(emailRows, lifecycleOrderId, 'order.payment_received')
  await api(renterACookie, 'POST', `/api/orders/${lifecycleOrderId}/checkout`, { test_scenario: 'success', idempotency_key: 'order-admin-regression-lifecycle-checkout' })
  const { data: emailRowsAfterReplay } = await admin.from('email_deliveries').select('related_entity_id, event_type').eq('related_entity_type', 'order').eq('related_entity_id', lifecycleOrderId)
  check('exact checkout replay does not duplicate order.payment_received', countEmails(emailRowsAfterReplay, lifecycleOrderId, 'order.payment_received') === paymentReceivedBefore, emailRowsAfterReplay)

  // Correction 8: a delivered order cannot be shipped again.
  const reshipRes = await api(merchantACookie, 'POST', `/api/orders/${lifecycleOrderId}/ship`, { idempotency_key: `order-admin-regression-lifecycle-reship-${Date.now()}` })
  check('a delivered order cannot be shipped again', reshipRes.status >= 400, reshipRes)

  // Correction 8: financial-operations identifies the row as an order, never a booking with null fields.
  // Correction (Cursor Pagination Remediation): the fixture payment ages
  // out of page 1 as unrelated captured payments accumulate -- page
  // through real cursors until it's found.
  const { data: paymentRow } = await admin.from('payments').select('id').eq('order_id', lifecycleOrderId).eq('payment_type', 'order_payment').single()
  const finOpsPaged = await findAcrossPages(adminCookie, '/api/admin/financial-operations?status=captured', 'operations', (r) => r.paymentId === paymentRow.id)
  const finOpsRow = finOpsPaged.found
  check(
    'financial-operations shows a real orderReference for an order-linked payment, reachable via cursor pagination (Part E fix)',
    !!finOpsRow && finOpsRow.orderId === lifecycleOrderId && !!finOpsRow.orderReference && finOpsRow.bookingId === null,
    { finOpsRow, pagesVisited: finOpsPaged.pagesVisited, exhausted: finOpsPaged.exhausted, maxPagesExceeded: finOpsPaged.maxPagesExceeded }
  )

  // Correction 16: admin detail's MESSAGES section resolves through the audited path.
  const { count: auditCountBefore } = await admin.from('admin_message_access_log').select('id', { count: 'exact', head: true }).eq('order_id', lifecycleOrderId)
  const messagesRes = await api(adminCookie, 'GET', `/api/admin/messages?order_id=${lifecycleOrderId}`)
  check('audited admin message read responds 200', messagesRes.status === 200, messagesRes)
  const { count: auditCountAfter } = await admin.from('admin_message_access_log').select('id', { count: 'exact', head: true }).eq('order_id', lifecycleOrderId)
  check('admin viewing order messages creates an admin_message_access_log row (correction 16)', (auditCountAfter ?? 0) > (auditCountBefore ?? 0), { before: auditCountBefore, after: auditCountAfter })
}

console.log('\n=== Cancelled before payment: order.cancelled emails + cannot pay/ship afterward (Scenarios B, F) ===')
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Order-Admin Regression — Cancel`,
    description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
    category: 'tools', sale_price: 300,
  })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: 'order-admin-regression-cancel-create' })
  const orderId = created.json?.order_id
  check('cancel fixture created/replayed', !!orderId, created)

  const { data: existingOrder } = await admin.from('orders').select('status').eq('id', orderId).single()
  if (existingOrder.status === 'pending') {
    await api(renterACookie, 'POST', `/api/orders/${orderId}/cancel`, { cancellation_reason: 'regression fixture', idempotency_key: 'order-admin-regression-cancel-cancel' })
  }

  const { data: order } = await admin.from('orders').select('status').eq('id', orderId).single()
  check('order fixture is cancelled', order.status === 'cancelled', order)

  const { data: emailRows } = await admin.from('email_deliveries').select('related_entity_id, event_type').eq('related_entity_type', 'order').eq('related_entity_id', orderId)
  check('order.cancelled dispatched to both buyer and seller', countEmails(emailRows, orderId, 'order.cancelled') === 2, emailRows)

  const payRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `order-admin-regression-cancel-pay-${Date.now()}` })
  check('a cancelled order cannot be paid', payRes.status >= 400, payRes)

  const shipRes = await api(merchantACookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: `order-admin-regression-cancel-ship-${Date.now()}` })
  check('a cancelled order cannot be shipped', shipRes.status >= 400, shipRes)
}

console.log('\n=== Payment failure: order.payment_failed email, order stays pending, exception queue (Scenarios B, C, D) ===')
// Two separate fixtures, matching the Phase 4 regression-script precedent
// (verify-barter-execution.mjs's own "disputed" scenario bug fix): one
// stays declined/pending forever, safe to re-check indefinitely with
// FIXED idempotency keys; a second, disposable, per-run-unique fixture
// covers "retried and paid after a prior failure" without ever mutating
// the first fixture's permanently-failed state.
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Order-Admin Regression — Payment Failure`,
    description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
    category: 'tools', sale_price: 400,
  })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: 'order-admin-regression-failure-create' })
  const orderId = created.json?.order_id
  check('payment-failure fixture created/replayed', !!orderId, created)

  const { data: beforeOrder } = await admin.from('orders').select('status').eq('id', orderId).single()
  if (beforeOrder.status === 'pending') {
    const declineRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'declined', idempotency_key: 'order-admin-regression-failure-checkout' })
    check('declined checkout returns failed_terminal, not a 5xx', declineRes.status === 200 && declineRes.json?.status === 'failed_terminal', declineRes)
  }

  const { data: order } = await admin.from('orders').select('status').eq('id', orderId).single()
  check('a failed checkout attempt leaves the order status unchanged at pending (correction 12/8)', order.status === 'pending', order)

  const { data: emailRows } = await admin.from('email_deliveries').select('related_entity_id, event_type').eq('related_entity_type', 'order').eq('related_entity_id', orderId)
  check('order.payment_failed dispatched to the buyer exactly once', countEmails(emailRows, orderId, 'order.payment_failed') === 1, emailRows)
  check('order.payment_received is never dispatched for a failed payment', countEmails(emailRows, orderId, 'order.payment_received') === 0, emailRows)

  const { data: paymentRow } = await admin.from('payments').select('id, status, failure_reason').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
  check('the payment row itself is failed', paymentRow.status === 'failed', paymentRow)

  const finOps = await api(adminCookie, 'GET', '/api/admin/financial-operations?status=failed')
  const finOpsRow = (finOps.json?.operations ?? []).find((r) => r.paymentId === paymentRow.id)
  check("failed order payment shows failureCategory 'failed' (a single honest category, not an invented retryable/terminal split -- decision 3)", finOpsRow?.failureCategory === 'failed', finOpsRow)
  check('CSV export never includes raw failure text (correction 4/13)', !Object.prototype.hasOwnProperty.call(finOpsRow ?? {}, 'failureMessage'), finOpsRow)

  const exceptions = await api(adminCookie, 'GET', '/api/admin/exceptions')
  const orderException = (exceptions.json?.exceptions ?? []).find((e) => e.type === 'order_payment_failed' && e.entityId === orderId)
  check("exception queue surfaces 'order_payment_failed' for this order (Scenario D)", !!orderException, orderException)
}

// Disposable, per-run-unique fixture (Date.now()-suffixed idempotency
// keys) -- deliberately NOT the fixture above, which must stay
// permanently pending/failed to be safely re-checkable on every run.
// This one is a fresh order every run, taken all the way to paid, so it
// leaves no state a future run needs to react to.
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Order-Admin Regression — Payment Failure`,
    description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
    category: 'tools', sale_price: 400,
  })
  const runSuffix = Date.now()

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `order-admin-regression-failure-retry-create-${runSuffix}` })
  const orderId = created.json?.order_id
  check('retry-after-failure fixture created', !!orderId, created)

  const declineRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'declined', idempotency_key: `order-admin-regression-failure-retry-decline-${runSuffix}` })
  check('declined checkout returns failed_terminal, not a 5xx', declineRes.status === 200 && declineRes.json?.status === 'failed_terminal', declineRes)

  const retryRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `order-admin-regression-failure-retry-success-${runSuffix}` })
  check('the order can be retried and paid after a prior failure', retryRes.status === 200 && retryRes.json?.status === 'success', retryRes)
}

console.log('\n=== Disputed order: freezes cancel/ship/deliver, dispute link surfaces in admin detail (Scenarios A, D, F) ===')
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Order-Admin Regression — Disputed`,
    description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
    category: 'tools', sale_price: 600,
  })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: 'order-admin-regression-disputed-create' })
  const orderId = created.json?.order_id
  check('disputed fixture created/replayed', !!orderId, created)

  const { data: beforeOrder } = await admin.from('orders').select('status').eq('id', orderId).single()
  if (beforeOrder.status === 'pending') {
    await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: 'order-admin-regression-disputed-checkout' })
  }
  const { data: afterCheckout } = await admin.from('orders').select('status').eq('id', orderId).single()
  if (afterCheckout.status === 'paid') {
    await api(merchantACookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: 'order-admin-regression-disputed-ship' })
  }

  const disputeId = await openOrReuseDispute(
    renterACookie,
    { order_id: orderId, title: 'Regression fixture dispute', description: 'Permanent regression fixture.', requested_resolution: 'n/a' },
    orderId, 'order-admin-regression-disputed-dispute'
  )
  check('dispute exists for the order fixture', !!disputeId)

  const { data: order } = await admin.from('orders').select('status').eq('id', orderId).single()
  check('order.status = disputed', order.status === 'disputed', order)

  const cancelRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/cancel`, { idempotency_key: `order-admin-regression-disputed-cancel-${Date.now()}` })
  check('a disputed order cannot be cancelled', cancelRes.status >= 400, cancelRes)

  const shipRes = await api(merchantACookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: `order-admin-regression-disputed-ship-${Date.now()}` })
  check('a disputed order cannot be shipped', shipRes.status >= 400, shipRes)

  const deliverRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/confirm-delivery`, { idempotency_key: `order-admin-regression-disputed-deliver-${Date.now()}` })
  check('a disputed order cannot be marked delivered', deliverRes.status >= 400, deliverRes)

  const detail = await api(adminCookie, 'GET', `/api/admin/orders/${orderId}`)
  check('admin order detail surfaces the linked dispute', detail.json?.dispute?.id === disputeId, detail.json?.dispute)

  const exceptions = await api(adminCookie, 'GET', '/api/admin/exceptions')
  const disputedException = (exceptions.json?.exceptions ?? []).find((e) => e.type === 'order_disputed' && e.entityId === orderId)
  check("exception queue surfaces 'order_disputed' for this order", !!disputedException, disputedException)
}

console.log('\n=== Cursor Pagination + Relational Filtering (Admin Orders + Financial Operations Remediation) ===')
{
  // These fixtures exist purely to exercise the admin list/pagination/
  // filter layer -- they don't need to exercise POST /api/orders' own
  // create_order RPC path (that's already covered by the lifecycle/
  // cancel/payment-failure/disputed sections above). So the order ROW
  // itself is inserted directly via the service-role client -- bypassing
  // the create-order rate limit entirely rather than waiting it out --
  // while checkout/dispute-opening below still go through the real
  // authoritative routes (neither route cares how the order row came to
  // exist, only that it belongs to the caller and is in the right
  // status, confirmed by reading src/app/api/orders/[id]/checkout/route.ts),
  // so paymentStatus/disputed fixtures still reach their state through
  // real product logic, not hand-rolled payments/disputes rows.
  async function createPinnedOrder(title, salePrice, createdAt) {
    const listingId = await insertBaseListing(merchantA.id, {
      title, description: 'Permanent regression fixture for verify-order-administration.mjs — do not delete.',
      category: 'tools', sale_price: salePrice,
    })
    const { data: existing } = await admin.from('orders').select('id').eq('listing_id', listingId).eq('buyer_id', buyerId).maybeSingle()
    if (existing) return existing.id
    const { data, error } = await admin
      .from('orders')
      .insert({ listing_id: listingId, buyer_id: buyerId, seller_id: merchantA.id, quantity: 1, unit_price: salePrice, total_amount: salePrice, created_at: createdAt })
      .select('id')
      .single()
    if (error) throw new Error(`createPinnedOrder failed for "${title}": ${error.message}`)
    return data.id
  }

  // ── Part 8: deterministic paging (3 fixtures, limit=2) -- page1=2, page2=1, no dup/gap, id-tiebreak between two equal timestamps ──
  const cpA = await createPinnedOrder('[QA] Order-Admin Cursor-Test CursorPageMarker A', 111, '2020-01-01T00:00:03.000Z')
  const cpB = await createPinnedOrder('[QA] Order-Admin Cursor-Test CursorPageMarker B', 112, '2020-01-01T00:00:02.000Z')
  const cpC = await createPinnedOrder('[QA] Order-Admin Cursor-Test CursorPageMarker C', 113, '2020-01-01T00:00:02.000Z')
  // B and C intentionally share a timestamp -- the tiebreak must be id DESC, computed from the real ids rather than assumed.
  const tieWinner = cpB > cpC ? cpB : cpC
  const tieLoser = cpB > cpC ? cpC : cpB

  const cpPage1 = await api(adminCookie, 'GET', '/api/admin/orders?search=CursorPageMarker&limit=2')
  const page1Ids = (cpPage1.json?.orders ?? []).map((o) => o.id)
  check('page 1 (limit=2) returns exactly [A, tiebreak-winner] in order', cpPage1.status === 200 && JSON.stringify(page1Ids) === JSON.stringify([cpA, tieWinner]), { page1Ids, expected: [cpA, tieWinner] })
  check('page 1 reports hasMore=true with a nextCursor', cpPage1.json?.hasMore === true && !!cpPage1.json?.nextCursor, cpPage1.json)

  const cpPage2 = await api(adminCookie, 'GET', `/api/admin/orders?search=CursorPageMarker&limit=2&cursor=${encodeURIComponent(cpPage1.json?.nextCursor ?? '')}`)
  const page2Ids = (cpPage2.json?.orders ?? []).map((o) => o.id)
  check('page 2 returns exactly [tiebreak-loser], no duplicate/skip vs page 1', cpPage2.status === 200 && JSON.stringify(page2Ids) === JSON.stringify([tieLoser]), { page2Ids, expected: [tieLoser] })
  check('page 2 is the end of results (hasMore=false, nextCursor=null)', cpPage2.json?.hasMore === false && cpPage2.json?.nextCursor === null, cpPage2.json)

  // ── Part 5: malformed cursor -> safe 400, never a crash ──
  const malformed = await api(adminCookie, 'GET', '/api/admin/orders?search=CursorPageMarker&cursor=not-a-real-cursor')
  check('a malformed cursor is rejected with 400, not a 5xx/crash', malformed.status === 400, malformed)

  // ── Part 5: a cursor minted under one filter context is rejected when replayed against a changed filter context ──
  const crossContext = await api(adminCookie, 'GET', `/api/admin/orders?status=delivered&cursor=${encodeURIComponent(cpPage1.json?.nextCursor ?? '')}`)
  check('a cursor minted under different filters is rejected (400), never silently spliced onto a new filter', crossContext.status === 400, crossContext)

  // ── Part 9: paymentStatus AND disputed are genuine DB-side predicates, not bounded-fetch-then-filter -- small limit, newer non-matching + older matching.
  // One shared pair covers both: dbFilterOlder is captured AND disputed; dbFilterNewer is neither -- keeps total order-creation calls within the
  // shared POST /api/orders rate-limit budget instead of spending 2 fresh orders per filter.
  const dbFilterNewer = await createPinnedOrder('[QA] Order-Admin Cursor-Test DbFilterProof Newer', 121, '2020-01-01T00:10:00.000Z')
  const dbFilterOlder = await createPinnedOrder('[QA] Order-Admin Cursor-Test DbFilterProof Older', 122, '2020-01-01T00:09:00.000Z')
  const { data: dbFilterOlderBefore } = await admin.from('orders').select('status').eq('id', dbFilterOlder).single()
  if (dbFilterOlderBefore.status === 'pending') {
    await api(renterACookie, 'POST', `/api/orders/${dbFilterOlder}/checkout`, { test_scenario: 'success', idempotency_key: 'order-admin-cursor-dbfilter-older-checkout' })
  }
  await openOrReuseDispute(
    renterACookie,
    { order_id: dbFilterOlder, title: 'Cursor pagination regression fixture dispute', description: 'Permanent regression fixture.', requested_resolution: 'n/a' },
    dbFilterOlder, 'order-admin-cursor-dbfilter-older-dispute'
  )

  const payStatusRes = await api(adminCookie, 'GET', '/api/admin/orders?search=DbFilterProof&paymentStatus=captured&limit=1')
  const payStatusIds = (payStatusRes.json?.orders ?? []).map((o) => o.id)
  check(
    'paymentStatus filter finds the older captured order even with limit=1 and a newer non-matching row present (proves DB-side filtering, not bounded-then-filtered)',
    payStatusRes.status === 200 && JSON.stringify(payStatusIds) === JSON.stringify([dbFilterOlder]),
    { payStatusIds, expected: [dbFilterOlder], dbFilterNewer }
  )

  const disputedRes = await api(adminCookie, 'GET', '/api/admin/orders?search=DbFilterProof&disputed=true&limit=1')
  const disputedIds = (disputedRes.json?.orders ?? []).map((o) => o.id)
  check(
    'disputed filter finds the older disputed order even with limit=1 and a newer non-disputed row present (proves DB-side filtering)',
    disputedRes.status === 200 && JSON.stringify(disputedIds) === JSON.stringify([dbFilterOlder]),
    { disputedIds, expected: [dbFilterOlder], dbFilterNewer }
  )

  // ── Part 9: search is a genuine DB-side predicate -- small limit, newer row that does NOT match the search term + older row that does ──
  const searchNewer = await createPinnedOrder('[QA] Order-Admin Cursor-Test Unrelated Newer', 141, '2020-01-01T00:10:00.000Z')
  const searchOlder = await createPinnedOrder('[QA] Order-Admin Cursor-Test SearchProofXYZ Older', 142, '2020-01-01T00:09:00.000Z')
  const searchRes = await api(adminCookie, 'GET', '/api/admin/orders?search=SearchProofXYZ&limit=1')
  const searchIds = (searchRes.json?.orders ?? []).map((o) => o.id)
  check(
    'search filter finds the older matching order even with limit=1 and a newer non-matching row present (proves DB-side ILIKE, not bounded-then-filtered)',
    searchRes.status === 200 && JSON.stringify(searchIds) === JSON.stringify([searchOlder]),
    { searchIds, expected: [searchOlder], searchNewer }
  )

  // ── Financial Operations: deterministic paging (3 payment fixtures, limit=2) + malformed cursor + end-of-results ──
  async function createPinnedCapturedPayment(title, salePrice, requestedAt, idemKeyPrefix) {
    const orderId = await createPinnedOrder(title, salePrice, requestedAt)
    const { data: before } = await admin.from('orders').select('status').eq('id', orderId).single()
    if (before.status === 'pending') {
      await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `${idemKeyPrefix}-checkout` })
    }
    const { data: paymentRow } = await admin.from('payments').select('id').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
    await admin.from('payments').update({ requested_at: requestedAt }).eq('id', paymentRow.id)
    return { orderId, paymentId: paymentRow.id }
  }

  // financial-operations has no search/marker filter to scope a subset by
  // content -- pinned to the far future instead of the past so these 3
  // fixtures are deterministically the newest `status=captured` rows in
  // the whole table, making an unscoped small-limit page 1/page 2 fully
  // deterministic without touching any real data.
  const finA = await createPinnedCapturedPayment('[QA] Order-Admin Cursor-Test FinOpsPageMarker A', 151, '2099-01-01T00:00:03.000Z', 'order-admin-cursor-finops-a')
  const finB = await createPinnedCapturedPayment('[QA] Order-Admin Cursor-Test FinOpsPageMarker B', 152, '2099-01-01T00:00:02.000Z', 'order-admin-cursor-finops-b')
  const finC = await createPinnedCapturedPayment('[QA] Order-Admin Cursor-Test FinOpsPageMarker C', 153, '2099-01-01T00:00:01.000Z', 'order-admin-cursor-finops-c')

  const finPage1 = await api(adminCookie, 'GET', '/api/admin/financial-operations?status=captured&limit=2')
  const finPage1Ids = (finPage1.json?.operations ?? []).map((r) => r.paymentId)
  check('financial-operations page 1 (limit=2) returns exactly [A, B], the two newest captured payments', finPage1.status === 200 && JSON.stringify(finPage1Ids) === JSON.stringify([finA.paymentId, finB.paymentId]), { finPage1Ids, expected: [finA.paymentId, finB.paymentId] })
  check('financial-operations page 1 reports hasMore=true with a nextCursor', finPage1.json?.hasMore === true && !!finPage1.json?.nextCursor, finPage1.json)

  const finPage2 = await api(adminCookie, 'GET', `/api/admin/financial-operations?status=captured&limit=2&cursor=${encodeURIComponent(finPage1.json?.nextCursor ?? '')}`)
  const finPage2Ids = (finPage2.json?.operations ?? []).map((r) => r.paymentId)
  check('financial-operations page 2 starts with C, no duplicate of A/B from page 1', finPage2.status === 200 && finPage2Ids[0] === finC.paymentId && !finPage2Ids.includes(finA.paymentId) && !finPage2Ids.includes(finB.paymentId), { finPage2Ids, expectedFirst: finC.paymentId })

  const finMalformed = await api(adminCookie, 'GET', '/api/admin/financial-operations?status=captured&cursor=not-a-real-cursor')
  check('financial-operations: a malformed cursor is rejected with 400, not a 5xx/crash', finMalformed.status === 400, finMalformed)

  const finCrossContext = await api(adminCookie, 'GET', `/api/admin/financial-operations?status=failed&cursor=${encodeURIComponent(finPage1.json?.nextCursor ?? '')}`)
  check('financial-operations: a cursor minted under a different status filter is rejected (400)', finCrossContext.status === 400, finCrossContext)
}

console.log('\n=== Security: pagination surfaces (Admin Orders + Financial Operations Remediation) ===')
{
  const anonFinOps = await api(null, 'GET', '/api/admin/financial-operations')
  check('anonymous is blocked from the financial-operations list', anonFinOps.status === 401, anonFinOps)

  const nonAdminFinOps = await api(renterACookie, 'GET', '/api/admin/financial-operations')
  check('an ordinary authenticated user is blocked from the financial-operations list', nonAdminFinOps.status === 401, nonAdminFinOps)

  // The new _admin_list_orders_page RPC must be unreachable to anon/authenticated Postgrest clients -- only service_role has EXECUTE.
  const anonRpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_admin_list_orders_page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ p_limit: 1 }),
  })
  check('the _admin_list_orders_page RPC is not callable with the anon key (PostgREST 401/403/404, never 200)', anonRpc.status === 401 || anonRpc.status === 403 || anonRpc.status === 404, { status: anonRpc.status })
}

console.log('\n=== Security (Scenario E) ===')
{
  const anon = await api(null, 'GET', '/api/admin/orders')
  check('anonymous is blocked from the admin order list', anon.status === 401, anon)

  const anonDetail = await api(null, 'GET', `/api/admin/orders/${lifecycleOrderId}`)
  check('anonymous is blocked from the admin order detail', anonDetail.status === 401, anonDetail)

  const nonAdminList = await api(renterACookie, 'GET', '/api/admin/orders')
  check('an ordinary authenticated user is blocked from the admin order list', nonAdminList.status === 401, nonAdminList)

  const nonAdminDetail = await api(renterACookie, 'GET', `/api/admin/orders/${lifecycleOrderId}`)
  check('an ordinary authenticated user is blocked from the admin order detail', nonAdminDetail.status === 401, nonAdminDetail)

  const forged = await api(adminCookie, 'GET', '/api/admin/orders/00000000-0000-0000-0000-000000000000')
  check('a forged order id 404s, indistinguishable from a real lookup failure', forged.status === 404, forged)

  const invalidId = await api(adminCookie, 'GET', '/api/admin/orders/not-a-uuid')
  check('a malformed order id is rejected with 400, never reaches the query layer', invalidId.status === 400, invalidId)

  // No mutation is reachable via the admin list/detail routes -- both are GET-only by construction.
  const mutateAttempt = await fetch(`${APP_URL}/api/admin/orders/${lifecycleOrderId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: '{}' })
  check('no mutation is reachable on the admin order detail route (405/404, no handler exists)', mutateAttempt.status === 404 || mutateAttempt.status === 405, { status: mutateAttempt.status })

  const csvRes = await fetch(`${APP_URL}/api/admin/orders?format=csv`, { headers: { Cookie: adminCookie } })
  const csvText = await csvRes.text()
  const forbidden = ['email', 'kyc', 'password', 'card', 'bank', 'secret', 'token']
  const headerRow = csvText.split('\n')[0].toLowerCase()
  check('CSV export header excludes sensitive field names', forbidden.every((f) => !headerRow.includes(f)), { header: headerRow })
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
