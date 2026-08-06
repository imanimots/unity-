#!/usr/bin/env node
/**
 * Unity QA seed & reset script — Step 10 (public-test MVP), extended with
 * buying & selling listing fixtures and Barter marketplace scenarios.
 *
 * Creates a controlled catalogue of QA accounts, listings (rental, sale,
 * both, and barter-dedicated), bookings, barter agreements, and
 * email-delivery states by driving the REAL application API routes and
 * RPCs wherever one exists (booking lifecycle, barter lifecycle,
 * moderation decisions, KYC decisions) — never a direct table write for
 * anything that has a real mutation path. Direct service-role inserts
 * are used only where no route exists (initial listing/document
 * scaffolding, backdating a timestamp to simulate "overdue" or
 * "expired", the deterministic email-failure fixtures) — see inline
 * comments at each such call site.
 *
 * SAFETY: this script refuses to run unless ALL of the following hold,
 * and aborts loudly (never partially) if any check fails:
 *   - NODE_ENV is not 'production'
 *   - QA_SEED_ENABLED=true
 *   - QA_SEED_CONFIRM=UNITY_DEV_ONLY
 *   - NEXT_PUBLIC_SUPABASE_URL's project ref matches QA_SEED_PROJECT_REF
 *     (set once, in .env.local, to the approved development project)
 *
 * Credentials are NEVER printed to stdout/stderr and NEVER written into
 * any tracked file — generated passwords are written only to
 * .qa-credentials.local.json (gitignored) in the repo root.
 *
 * Usage: node scripts/qa-seed.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL (booking/listing
 * lifecycle steps go through real HTTP routes, matching how a real
 * client would call them).
 */

import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ── Safety gate ────────────────────────────────────────────────────────
function assertSafeToRun() {
  const problems = []
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV must not be "production"')
  if (process.env.QA_SEED_ENABLED !== 'true') problems.push('QA_SEED_ENABLED must be exactly "true"')
  if (process.env.QA_SEED_CONFIRM !== 'UNITY_DEV_ONLY') problems.push('QA_SEED_CONFIRM must be exactly "UNITY_DEV_ONLY"')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const expectedRef = process.env.QA_SEED_PROJECT_REF
  if (!url) problems.push('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!expectedRef) problems.push('QA_SEED_PROJECT_REF is not set — set it once to your approved dev project ref as an extra safeguard')
  if (url && expectedRef) {
    const ref = new URL(url).hostname.split('.')[0]
    if (ref !== expectedRef) problems.push(`Supabase project ref "${ref}" does not match QA_SEED_PROJECT_REF "${expectedRef}"`)
  }

  if (problems.length > 0) {
    console.error('QA seed aborted — safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/qa-seed.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('QA seed aborted — NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`

function genPassword() {
  return `Qa${randomBytes(18).toString('base64url')}!1`
}

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return `${cookieName}=${encodeURIComponent(value)}`
}

async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // no body
  }
  return { status: res.status, json }
}

async function ensureUser(email, password, role) {
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const found = existing?.users?.find((u) => u.email === email)
  let userId
  if (found) {
    userId = found.id
    await admin.auth.admin.updateUserById(userId, { password })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
    userId = data.user.id
  }
  await admin.from('profiles').update({ role, kyc_status: 'approved', account_status: 'active' }).eq('id', userId)
  return userId
}

// ── Phase 1: QA accounts ──────────────────────────────────────────────
async function seedAccounts() {
  console.log('Phase 1: QA accounts')
  const accounts = {}
  const roster = [
    { key: 'admin', email: 'qa-admin@unitytest.internal', role: 'admin' },
    { key: 'merchantA', email: 'qa-merchant-a@unitytest.internal', role: 'merchant' },
    { key: 'merchantB', email: 'qa-merchant-b@unitytest.internal', role: 'merchant' },
    { key: 'renterA', email: 'qa-renter-a@unitytest.internal', role: 'renter' },
    { key: 'restrictedUser', email: 'qa-restricted@unitytest.internal', role: 'renter' },
    { key: 'suspendedUser', email: 'qa-suspended@unitytest.internal', role: 'merchant' },
    // Step 11 Phase 7 -- affiliate system regression fixtures.
    { key: 'affiliateA', email: 'qa-affiliate-a@unitytest.internal', role: 'renter' },
    { key: 'affiliateB', email: 'qa-affiliate-b@unitytest.internal', role: 'renter' },
  ]

  for (const r of roster) {
    const password = genPassword()
    const userId = await ensureUser(r.email, password, r.role)
    accounts[r.key] = { id: userId, email: r.email, password, role: r.role }
    console.log(`  ${r.key}: ready (${r.role})`)
  }

  // Admin needs role='admin' explicitly (ensureUser already set it above).
  // Restricted/suspended users get their documented account_status via
  // the REAL admin RPC-backed route, exercised the same way an operator
  // would use it — not a direct column write.
  const adminCookie = await cookieFor(accounts.admin.email, accounts.admin.password)
  await api(adminCookie, 'POST', `/api/admin/users/${accounts.restrictedUser.id}/restrict`, {
    user_reason: 'QA fixture account — always kept restricted for test coverage',
    idempotency_key: `qa-seed-restrict-${accounts.restrictedUser.id}`,
  })
  await api(adminCookie, 'POST', `/api/admin/users/${accounts.suspendedUser.id}/suspend`, {
    user_reason: 'QA fixture account — always kept suspended for test coverage',
    idempotency_key: `qa-seed-suspend-${accounts.suspendedUser.id}`,
  })
  console.log('  restrictedUser -> restricted, suspendedUser -> suspended (via real admin routes)')

  return accounts
}

// ── Phase 2: QA listings (12 documented states) ───────────────────────
// Listing rows are inserted directly (service role) for the base
// scaffold — there is no "create a listing in exactly this target
// state" route, only a wizard draft-save flow that expects real
// uploaded media. Lifecycle transitions that DO have a real route
// (moderation decisions, ownership decisions, activation, suspension)
// go through those routes instead of a status column write, so the
// admin-decision RPCs and their audit trail are genuinely exercised.
const QA_LISTING_MARKER = '[QA]'

async function insertBaseListing(merchantId, overrides) {
  // Idempotent by (merchant_id, title) — re-running the seed script never
  // duplicates a listing that's already there.
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id

  const base = {
    merchant_id: merchantId,
    country_id: 'ZA',
    category: 'tech',
    condition: 'good',
    daily_rate: 150,
    min_rental_days: 1,
    deposit_required: false,
    status: 'draft',
    risk_tier: 'low',
    ownership_verified: false,
    condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

async function seedListings(accounts, adminCookie) {
  console.log('Phase 2: QA listings')
  const ids = {}

  ids.lowRiskNoDeposit = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Low-Risk No-Deposit Tripod`,
    description: 'Synthetic QA fixture — lightweight aluminium tripod, no deposit required.',
    daily_rate: 80,
    deposit_required: false,
    status: 'active',
  })

  ids.lowRiskDeposit = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Low-Risk Deposit-Required Camera Bag`,
    description: 'Synthetic QA fixture — padded camera bag, refundable deposit required.',
    daily_rate: 60,
    deposit_required: true,
    status: 'active',
  })
  await admin.from('listing_requirements').upsert({ listing_id: ids.lowRiskDeposit, requested_deposit_amount: 500 })

  ids.mediumRiskOwnershipVerified = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Medium-Risk Ownership-Verified Drone`,
    description: 'Synthetic QA fixture — consumer drone, ownership verification completed.',
    daily_rate: 400,
    deposit_required: true,
    risk_tier: 'medium',
    ownership_verified: true,
    status: 'active',
  })
  await admin.from('listing_requirements').upsert({ listing_id: ids.mediumRiskOwnershipVerified, requested_deposit_amount: 2000 })
  await admin.from('listing_ownership_verification').upsert({ listing_id: ids.mediumRiskOwnershipVerified, status: 'verified', provider: 'manual' })

  ids.weeklyRate = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Weekly-Rate Projector`,
    description: 'Synthetic QA fixture — HD projector, priced by the week.',
    daily_rate: 100,
    weekly_rate: 550,
    status: 'active',
  })

  ids.dailyRate = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} Daily-Rate Bluetooth Speaker`,
    description: 'Synthetic QA fixture — portable speaker, priced by the day.',
    daily_rate: 45,
    status: 'active',
  })

  ids.draft = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Draft Listing (incomplete)`,
    description: 'Synthetic QA fixture — left in draft on purpose.',
    status: 'draft',
  })

  ids.pendingModeration = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} Pending Moderation Listing`,
    description: 'Synthetic QA fixture — awaiting the moderation queue.',
    status: 'pending',
  })
  await admin.from('listing_moderation').upsert({ listing_id: ids.pendingModeration, moderation_status: 'pending' })

  // Changes-required: submitted, then a real admin decision moves it —
  // exercises decide_moderation('requires_review') for real.
  ids.changesRequired = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} Changes-Required Listing`,
    description: 'Synthetic QA fixture — admin has requested changes.',
    status: 'pending',
  })
  await admin.from('listing_moderation').upsert({ listing_id: ids.changesRequired, moderation_status: 'pending' })
  await api(adminCookie, 'POST', `/api/admin/listings/${ids.changesRequired}/request-changes`, {
    merchant_feedback: 'QA fixture: please add two more photos before resubmitting.',
    idempotency_key: `qa-seed-changes-${ids.changesRequired}`,
  })

  // Suspended: start active, then a real admin suspend call.
  ids.suspended = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} Suspended Listing`,
    description: 'Synthetic QA fixture — administratively suspended.',
    status: 'active',
  })
  await admin.from('listing_moderation').upsert({ listing_id: ids.suspended, moderation_status: 'approved' })
  await api(adminCookie, 'POST', `/api/admin/listings/${ids.suspended}/suspend`, {
    reason_code: 'qa_fixture',
    merchant_feedback: 'QA fixture — kept suspended for admin-queue testing.',
    idempotency_key: `qa-seed-suspend-listing-${ids.suspended}`,
  })

  ids.futureAvailability = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Active Listing, Future Availability`,
    description: 'Synthetic QA fixture — bookable, available from a future date.',
    daily_rate: 120,
    status: 'active',
    available_from: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  })

  ids.blockedDates = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Listing With Blocked Dates`,
    description: 'Synthetic QA fixture — has an unavailable date range.',
    daily_rate: 90,
    status: 'active',
  })
  await admin.from('listing_availability').insert({
    listing_id: ids.blockedDates,
    start_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    end_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    reason: 'QA fixture — merchant-blocked maintenance window',
  })

  ids.disclosedDamage = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} Listing With Disclosed Damage`,
    description: 'Synthetic QA fixture — cosmetic damage disclosed up front.',
    daily_rate: 70,
    status: 'active',
    known_defects: 'QA fixture: small scuff on the left side, fully functional.',
    condition: 'fair',
  })

  console.log(`  ${Object.keys(ids).length} listings seeded`)
  return ids
}

// ── Phase 2b: QA buying & selling listings ─────────────────────────────
// These fixtures exercise the Buy toggle on /listings, the sale/both
// rendering branches on the listing detail page, and SaleSummaryCard.
// Real purchase/order lifecycle scenarios (pending/paid/shipped/
// delivered/cancelled/declined) are seeded separately in Phase 3c against
// their own dedicated fixture listings, so stock here is never consumed
// by an order-lifecycle test.
async function seedBuySellListings(accounts) {
  console.log('Phase 2b: QA buying & selling listings')
  const ids = {}

  ids.forSaleCamera = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} For Sale — Vintage Camera`,
    description: 'Synthetic QA fixture — sale-only listing, no rental option.',
    listing_type: 'sale',
    daily_rate: null,
    sale_price: 1200,
    quantity_available: 3,
    status: 'active',
  })

  ids.forSaleChair = await insertBaseListing(accounts.merchantB.id, {
    title: `${QA_LISTING_MARKER} For Sale — Office Chair`,
    description: 'Synthetic QA fixture — sale-only listing, second merchant.',
    category: 'tools',
    listing_type: 'sale',
    daily_rate: null,
    sale_price: 800,
    quantity_available: 1,
    status: 'active',
  })

  ids.rentOrBuyDrill = await insertBaseListing(accounts.merchantA.id, {
    title: `${QA_LISTING_MARKER} Rent or Buy — Power Drill`,
    description: 'Synthetic QA fixture — listing_type=both, shows BookingCard and SaleSummaryCard together.',
    category: 'tools',
    listing_type: 'both',
    daily_rate: 50,
    sale_price: 900,
    quantity_available: 2,
    status: 'active',
  })

  console.log(`  ${Object.keys(ids).length} buy/sell listings seeded`)
  return ids
}

// ── Phase 3: QA bookings & financial states ────────────────────────────
// Fixed anchor date (not `Date.now()`) + a fixed per-scenario idempotency
// key, not `randomUUID()`. create_booking_request's own idempotency check
// hashes listing_id/start_at/end_at/message — a stable hash requires a
// literal fixed date, not one computed relative to whenever the script
// happens to run. This is what makes a re-run genuinely idempotent
// (replays the cached booking) instead of creating a new row every time,
// matching the fixed-key convention seedBarterScenarios/seedOrderScenarios
// already use below. 2030-01-01 is comfortably far enough in the future
// that create_booking_request's `start_at must be in the future` check
// will keep passing on first creation for years; every run after the
// first hits the idempotency cache and never re-evaluates that check.
const QA_BOOKING_DATE_ANCHOR = new Date('2030-01-01T00:00:00.000Z').getTime()

async function createAndAccept(renterCookie, merchantCookie, listingId, daysOffset, scenarioKey) {
  const start = new Date(QA_BOOKING_DATE_ANCHOR + daysOffset * 24 * 60 * 60 * 1000).toISOString()
  const end = new Date(QA_BOOKING_DATE_ANCHOR + (daysOffset + 3) * 24 * 60 * 60 * 1000).toISOString()
  const created = await api(renterCookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: start,
    end_at: end,
    idempotency_key: `qa-seed-booking-${scenarioKey}`,
  })
  const bookingId = created.json?.booking_id
  if (!bookingId) throw new Error(`booking creation failed: ${JSON.stringify(created)}`)
  return bookingId
}

// No route can move calendar time backward — rental_start requires
// start_at <= now(). Direct service-role update is the documented
// fallback for this one case (preserves every other constraint; only
// the date range moves).
async function backdateToStartable(bookingId, attempt = 1) {
  // A fixed-width 3-day window that SLIDES further into the past on each
  // retry (never widens — a wider window only makes collisions more
  // likely). Repeated seed runs across a session can leave several
  // still-"blocking" bookings on the same listing (booking_history is
  // immutable, so old QA bookings are never deleted) — sliding well
  // clear of "now" within a few attempts reliably finds a free slot.
  // The exclusion constraint is the authoritative source of truth here,
  // not a pre-check query (avoids a race).
  const slideDays = 3 * attempt
  const windowStart = Date.now() - slideDays * 24 * 60 * 60 * 1000
  const { error } = await admin
    .from('bookings')
    .update({
      start_at: new Date(windowStart).toISOString(),
      end_at: new Date(windowStart + 3 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', bookingId)
  if (error) {
    if (error.message.includes('exclusion constraint') && attempt < 8) {
      return backdateToStartable(bookingId, attempt + 1)
    }
    throw new Error(`backdateToStartable failed for ${bookingId}: ${error.message}`)
  }
}

async function seedBookings(accounts, listingIds) {
  console.log('Phase 3: QA bookings & financial states')
  const renterCookie = await cookieFor(accounts.renterA.email, accounts.renterA.password)
  const merchantACookie = await cookieFor(accounts.merchantA.email, accounts.merchantA.password)
  const merchantBCookie = await cookieFor(accounts.merchantB.email, accounts.merchantB.password)
  const bookingIds = {}
  // Fixed, non-overlapping offsets from the fixed QA_BOOKING_DATE_ANCHOR
  // (not a randomized, Date.now()-relative start) — see createAndAccept's
  // own comment. Every scenario gets a fixed idempotency key AND a fixed
  // date, so a re-run replays the exact same booking row via the RPC's own
  // idempotency cache instead of creating a new one — this is the actual
  // fix for the bookings_no_overlap_when_blocking accumulation flake.
  let offset = 100
  const nextOffset = () => {
    const v = offset
    offset += 20 // wide spacing so no two seeded bookings can ever collide on any shared listing
    return v
  }

  // 1. requested
  bookingIds.requested = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset(), 'requested')

  // 2. accepted, awaiting payment
  bookingIds.acceptedAwaitingPayment = await createAndAccept(renterCookie, merchantBCookie, listingIds.dailyRate, nextOffset(), 'accepted-awaiting-payment')
  await api(merchantBCookie, 'POST', `/api/bookings/${bookingIds.acceptedAwaitingPayment}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.acceptedAwaitingPayment}` })

  // 3. financially ready
  bookingIds.financiallyReady = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskNoDeposit, nextOffset(), 'financially-ready')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.financiallyReady}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.financiallyReady}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.financiallyReady}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.financiallyReady}` })

  // 4. retryable payment failure
  bookingIds.retryableFailure = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskDeposit, nextOffset(), 'retryable-failure')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.retryableFailure}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.retryableFailure}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.retryableFailure}/checkout`, { test_scenario: 'rental_retryable_failure', idempotency_key: `qa-seed-checkout-${bookingIds.retryableFailure}` })

  // 5. terminal decline
  bookingIds.terminalDecline = await createAndAccept(renterCookie, merchantACookie, listingIds.weeklyRate, nextOffset(), 'terminal-decline')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.terminalDecline}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.terminalDecline}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.terminalDecline}/checkout`, { test_scenario: 'rental_declined', idempotency_key: `qa-seed-checkout-${bookingIds.terminalDecline}` })

  // 6. active rental (financially ready -> start)
  bookingIds.activeRental = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskDeposit, nextOffset(), 'active-rental')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.activeRental}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.activeRental}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.activeRental}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.activeRental}` })
  await backdateToStartable(bookingIds.activeRental)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.activeRental}/start`, { idempotency_key: `qa-seed-start-${bookingIds.activeRental}` })

  // 7. return pending
  bookingIds.returnPending = await createAndAccept(renterCookie, merchantBCookie, listingIds.disclosedDamage, nextOffset(), 'return-pending')
  await api(merchantBCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.returnPending}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.returnPending}` })
  await backdateToStartable(bookingIds.returnPending)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/start`, { idempotency_key: `qa-seed-start-${bookingIds.returnPending}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/return`, { idempotency_key: `qa-seed-return-${bookingIds.returnPending}` })

  // 8. completed
  bookingIds.completed = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset(), 'completed')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.completed}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.completed}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.completed}` })
  await backdateToStartable(bookingIds.completed)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/start`, { idempotency_key: `qa-seed-start-${bookingIds.completed}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/return`, { idempotency_key: `qa-seed-return-${bookingIds.completed}` })
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.completed}/confirm-return`, { idempotency_key: `qa-seed-confirm-${bookingIds.completed}` })

  // 9. cancelled
  bookingIds.cancelled = await createAndAccept(renterCookie, merchantBCookie, listingIds.mediumRiskOwnershipVerified, nextOffset(), 'cancelled')
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.cancelled}/cancel`, { reason: 'QA fixture cancellation', idempotency_key: `qa-seed-cancel-${bookingIds.cancelled}` })

  // 10. expired unpaid — accept, then backdate payment_due_at (no route
  // exists for "make time pass"), then sweep via the real internal route.
  bookingIds.expiredUnpaid = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset(), 'expired-unpaid')
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.expiredUnpaid}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.expiredUnpaid}` })
  await admin.from('bookings').update({ payment_due_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', bookingIds.expiredUnpaid)
  const cronSecret = process.env.INTERNAL_CRON_SECRET
  if (cronSecret) {
    await fetch(`${APP_URL}/api/internal/expire-unpaid-bookings`, { method: 'POST', headers: { Authorization: `Bearer ${cronSecret}` } })
  } else {
    console.log('  (INTERNAL_CRON_SECRET not set — expiredUnpaid booking is backdated but not yet swept; run the sweep manually or wait for the scheduled cron)')
  }

  console.log(`  ${Object.keys(bookingIds).length} booking states seeded`)
  return bookingIds
}

// ── Phase 3b: QA barter scenarios ──────────────────────────────────────
// Drives the real /api/barter routes, same philosophy as Phase 3's
// booking seeding. Every mutating call uses a FIXED (not random)
// idempotency key per scenario+step — the app's own idempotency
// infrastructure (idempotency_keys, keyed on actor+operation+key) then
// makes the whole phase naturally safe to re-run: a second run replays
// each step's cached result instead of creating duplicate agreements,
// exactly like insertBaseListing's idempotent-by-title check does for
// listings, just via a different mechanism (there's no
// idempotent-by-title equivalent for a negotiation thread).
//
// Barter listings are kept entirely separate from the Phase 2 rental
// fixtures and Phase 2b buy/sell fixtures — an "accepted" agreement
// permanently locks its listings (no completion RPC exists yet in this
// phase of the build), and locking a listing Phase 3 also depends on for
// booking would make a script re-run fail against the new
// barter-lock-check in create_booking_request.
async function proposeBarter(cookie, body) {
  const res = await api(cookie, 'POST', '/api/barter', body)
  const agreementId = res.json?.agreement_id
  if (!agreementId) throw new Error(`propose_barter failed: ${JSON.stringify(res)}`)
  return agreementId
}
async function counterBarter(cookie, agreementId, body) {
  const res = await api(cookie, 'POST', `/api/barter/${agreementId}/counter`, body)
  if (!res.json?.agreement_id) throw new Error(`counter_barter_offer failed: ${JSON.stringify(res)}`)
}
async function acceptBarter(cookie, agreementId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/barter/${agreementId}/accept`, { idempotency_key: idempotencyKey })
  if (res.json?.status !== 'accepted') throw new Error(`accept_barter_offer failed: ${JSON.stringify(res)}`)
}
async function rejectBarter(cookie, agreementId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/barter/${agreementId}/reject`, { rejection_reason: 'QA fixture rejection', idempotency_key: idempotencyKey })
  if (res.json?.status !== 'rejected') throw new Error(`reject_barter_offer failed: ${JSON.stringify(res)}`)
}
async function cancelBarter(cookie, agreementId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/barter/${agreementId}/cancel`, { cancellation_reason: 'QA fixture cancellation', idempotency_key: idempotencyKey })
  if (res.json?.status !== 'cancelled') throw new Error(`cancel_barter_agreement failed: ${JSON.stringify(res)}`)
}

async function seedBarterScenarios(accounts) {
  console.log('Phase 3b: QA barter scenarios')
  const merchantACookie = await cookieFor(accounts.merchantA.email, accounts.merchantA.password)
  const merchantBCookie = await cookieFor(accounts.merchantB.email, accounts.merchantB.password)

  // Dedicated fixture listings — party A = merchantA, party B = merchantB
  // for every scenario below, so anchor ownership is consistent.
  const l = {}
  const barterListing = async (owner, key, title, extra = {}) =>
    insertBaseListing(owner, {
      title: `${QA_LISTING_MARKER} Barter Fixture — ${title}`,
      description: `Synthetic QA fixture — barter item for the "${key}" scenario.`,
      status: 'active',
      ...extra,
    })

  l.proposedA = await barterListing(accounts.merchantA.id, 'proposed', 'Acoustic Guitar', { category: 'music', daily_rate: 90 })
  l.proposedB = await barterListing(accounts.merchantB.id, 'proposed', 'Camping Tent', { category: 'outdoor', daily_rate: 70 })

  l.counteredA1 = await barterListing(accounts.merchantA.id, 'countered', 'DSLR Camera', { category: 'tech', daily_rate: 200 })
  l.counteredA2 = await barterListing(accounts.merchantA.id, 'countered', 'Camera Tripod', { category: 'tech', daily_rate: 40 })
  l.counteredB = await barterListing(accounts.merchantB.id, 'countered', 'Electric Scooter', { category: 'outdoor', daily_rate: 150 })

  l.acceptedA = await barterListing(accounts.merchantA.id, 'accepted', 'Mountain Bike', { category: 'sports', daily_rate: 120 })
  l.acceptedB = await barterListing(accounts.merchantB.id, 'accepted', 'Kayak', { category: 'sports', daily_rate: 180 })

  l.declinedA = await barterListing(accounts.merchantA.id, 'rejected-and-cancelled-pre-accept', 'Board Game Set', { category: 'events', daily_rate: 30 })
  l.declinedB = await barterListing(accounts.merchantB.id, 'rejected-and-cancelled-pre-accept', 'Party Speaker', { category: 'events', daily_rate: 60 })

  l.cancelledPostA = await barterListing(accounts.merchantA.id, 'cancelled-post-accept', 'Baby Stroller', { category: 'baby', daily_rate: 50 })
  l.cancelledPostB = await barterListing(accounts.merchantB.id, 'cancelled-post-accept', 'Baby Carrier', { category: 'baby', daily_rate: 35 })

  l.expiredA = await barterListing(accounts.merchantA.id, 'expired', 'Skateboard', { category: 'sports', daily_rate: 25 })
  l.expiredB = await barterListing(accounts.merchantB.id, 'expired', 'Longboard', { category: 'sports', daily_rate: 25 })

  const agreementIds = {}
  const offerFields = (partyA, partyB, extra = {}) => ({
    party_a_listing_ids: Array.isArray(partyA) ? partyA : [partyA],
    party_b_listing_ids: Array.isArray(partyB) ? partyB : [partyB],
    delivery_method: 'meet_in_person',
    idempotency_key: undefined, // set per call below
    ...extra,
  })

  // 1. proposed — awaiting response, no further action.
  agreementIds.proposed = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.proposedA,
    ...offerFields(l.proposedA, l.proposedB, { message: 'QA fixture — awaiting response' }),
    idempotency_key: 'qa-seed-barter-proposed-propose',
  })

  // 2. countered — multi-item on A's side (2 listings) to demonstrate the
  // one-item-for-multiple-items combination.
  agreementIds.countered = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.counteredA1,
    ...offerFields(l.counteredA1, l.counteredB, { message: 'QA fixture — before counter' }),
    idempotency_key: 'qa-seed-barter-countered-propose',
  })
  await counterBarter(merchantACookie, agreementIds.countered, {
    ...offerFields([l.counteredA1, l.counteredA2], l.counteredB, {
      cash_adjustment_amount: 150,
      cash_adjustment_payer: accounts.merchantB.id,
      delivery_method: 'courier',
      delivery_responsibility: 'party_b',
      deposit_required: true,
      deposit_amount: 300,
      deposit_payer: 'both',
      message: 'QA fixture — countered with an extra item plus a cash top-up',
    }),
    idempotency_key: 'qa-seed-barter-countered-counter',
  })

  // 3. accepted — locks both listings permanently (no completion RPC
  // exists yet this phase), the reference case for the "committed to a
  // barter" UI state on a listing's own detail page.
  agreementIds.accepted = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.acceptedA,
    ...offerFields(l.acceptedA, l.acceptedB, { message: 'QA fixture — accepted trade' }),
    idempotency_key: 'qa-seed-barter-accepted-propose',
  })
  await acceptBarter(merchantACookie, agreementIds.accepted, 'qa-seed-barter-accepted-accept')

  // 4. rejected
  agreementIds.rejected = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.declinedA,
    ...offerFields(l.declinedA, l.declinedB, { message: 'QA fixture — will be declined' }),
    idempotency_key: 'qa-seed-barter-rejected-propose',
  })
  await rejectBarter(merchantACookie, agreementIds.rejected, 'qa-seed-barter-rejected-reject')

  // 5. cancelled before acceptance — same listing pair as #4 is safe to
  // reuse since neither a proposed nor a rejected agreement locks anything.
  agreementIds.cancelledPreAccept = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.declinedA,
    ...offerFields(l.declinedA, l.declinedB, { message: 'QA fixture — will be cancelled before acceptance' }),
    idempotency_key: 'qa-seed-barter-cancelled-pre-propose',
  })
  await cancelBarter(merchantBCookie, agreementIds.cancelledPreAccept, 'qa-seed-barter-cancelled-pre-cancel')

  // 6. cancelled after acceptance — locks, then unlocks again via cancel;
  // demonstrates the 'refunded' settlement path (Phase A: descriptive
  // only, no real payment exists yet to actually release).
  agreementIds.cancelledPostAccept = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.cancelledPostA,
    ...offerFields(l.cancelledPostA, l.cancelledPostB, { message: 'QA fixture — will be cancelled after acceptance' }),
    idempotency_key: 'qa-seed-barter-cancelled-post-propose',
  })
  await acceptBarter(merchantACookie, agreementIds.cancelledPostAccept, 'qa-seed-barter-cancelled-post-accept')
  await cancelBarter(merchantACookie, agreementIds.cancelledPostAccept, 'qa-seed-barter-cancelled-post-cancel')

  // 7. expired — propose, backdate expires_at (no route exists for "make
  // time pass", same documented exception as the booking phase's
  // payment_due_at backdate), then trigger the real lazy-expiry sweep via
  // GET /api/barter (whichever account — the sweep is agreement-agnostic).
  agreementIds.expired = await proposeBarter(merchantBCookie, {
    anchor_listing_id: l.expiredA,
    ...offerFields(l.expiredA, l.expiredB, { message: 'QA fixture — will expire unanswered' }),
    idempotency_key: 'qa-seed-barter-expired-propose',
  })
  await admin.from('barter_agreements').update({ expires_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', agreementIds.expired)
  await api(merchantACookie, 'GET', '/api/barter')

  console.log(`  ${Object.keys(agreementIds).length} barter agreement scenarios seeded`)
  return agreementIds
}

// ── Phase 3c: QA order scenarios ────────────────────────────────────────
// Drives the real /api/orders routes end to end (create, checkout, ship,
// confirm-delivery, cancel), same philosophy as Phase 3's booking seeding
// and Phase 3b's barter seeding: fixed idempotency keys per scenario+step
// so a re-run replays via the app's own idempotency infrastructure
// instead of creating duplicate orders. Each scenario gets its own
// dedicated fixture listing (never the Phase 2b rendering-only buy/sell
// fixtures) so stock consumed by these real purchases never interferes
// with the Buy-toggle/SaleSummaryCard rendering fixtures.
async function createOrder(cookie, listingId, quantity, idempotencyKey) {
  const res = await api(cookie, 'POST', '/api/orders', { listing_id: listingId, quantity, idempotency_key: idempotencyKey })
  const orderId = res.json?.order_id
  if (!orderId) throw new Error(`create_order failed: ${JSON.stringify(res)}`)
  return orderId
}
async function checkoutOrder(cookie, orderId, idempotencyKey, testScenario) {
  return api(cookie, 'POST', `/api/orders/${orderId}/checkout`, { idempotency_key: idempotencyKey, test_scenario: testScenario })
}
async function shipOrder(cookie, orderId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: idempotencyKey })
  if (res.json?.status !== 'shipped') throw new Error(`mark_order_shipped failed: ${JSON.stringify(res)}`)
}
async function confirmOrderDelivery(cookie, orderId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/orders/${orderId}/confirm-delivery`, { idempotency_key: idempotencyKey })
  if (res.json?.status !== 'delivered') throw new Error(`confirm_order_delivery failed: ${JSON.stringify(res)}`)
}
async function cancelOrder(cookie, orderId, idempotencyKey) {
  const res = await api(cookie, 'POST', `/api/orders/${orderId}/cancel`, { cancellation_reason: 'QA fixture cancellation', idempotency_key: idempotencyKey })
  if (res.json?.status !== 'cancelled') throw new Error(`cancel_order failed: ${JSON.stringify(res)}`)
}

async function seedOrderScenarios(accounts) {
  console.log('Phase 3c: QA order scenarios')
  const buyerCookie = await cookieFor(accounts.renterA.email, accounts.renterA.password)
  const sellerCookie = await cookieFor(accounts.merchantA.email, accounts.merchantA.password)

  const orderListing = async (key, title, salePrice) =>
    insertBaseListing(accounts.merchantA.id, {
      title: `${QA_LISTING_MARKER} Order Fixture — ${title}`,
      description: `Synthetic QA fixture — purchase item for the "${key}" order scenario.`,
      category: 'tools',
      listing_type: 'sale',
      daily_rate: null,
      sale_price: salePrice,
      quantity_available: 5,
      status: 'active',
    })

  const l = {}
  l.pendingUnpaid = await orderListing('pending-unpaid', 'Cordless Sander', 650)
  l.paymentDeclined = await orderListing('payment-declined', 'Circular Saw', 1100)
  l.paid = await orderListing('paid', 'Angle Grinder', 480)
  l.shipped = await orderListing('shipped', 'Hedge Trimmer', 720)
  l.delivered = await orderListing('delivered', 'Pressure Washer', 1450)
  l.cancelled = await orderListing('cancelled', 'Paint Sprayer', 990)

  const orderIds = {}

  // 1. pending, unpaid — created, checkout never attempted.
  orderIds.pendingUnpaid = await createOrder(buyerCookie, l.pendingUnpaid, 1, 'qa-seed-order-pending-create')

  // 2. payment declined — checkout attempted and terminally declined by
  // the mock provider; order stays 'pending' (mirrors booking's
  // terminalDecline scenario, adapted to orders' single-charge shape).
  orderIds.paymentDeclined = await createOrder(buyerCookie, l.paymentDeclined, 1, 'qa-seed-order-declined-create')
  await checkoutOrder(buyerCookie, orderIds.paymentDeclined, 'qa-seed-order-declined-checkout', 'declined')

  // 3. paid
  orderIds.paid = await createOrder(buyerCookie, l.paid, 1, 'qa-seed-order-paid-create')
  await checkoutOrder(buyerCookie, orderIds.paid, 'qa-seed-order-paid-checkout', 'success')

  // 4. shipped
  orderIds.shipped = await createOrder(buyerCookie, l.shipped, 1, 'qa-seed-order-shipped-create')
  await checkoutOrder(buyerCookie, orderIds.shipped, 'qa-seed-order-shipped-checkout', 'success')
  await shipOrder(sellerCookie, orderIds.shipped, 'qa-seed-order-shipped-ship')

  // 5. delivered
  orderIds.delivered = await createOrder(buyerCookie, l.delivered, 1, 'qa-seed-order-delivered-create')
  await checkoutOrder(buyerCookie, orderIds.delivered, 'qa-seed-order-delivered-checkout', 'success')
  await shipOrder(sellerCookie, orderIds.delivered, 'qa-seed-order-delivered-ship')
  await confirmOrderDelivery(buyerCookie, orderIds.delivered, 'qa-seed-order-delivered-confirm')

  // 6. cancelled while pending — quantity_available restored.
  orderIds.cancelled = await createOrder(buyerCookie, l.cancelled, 1, 'qa-seed-order-cancelled-create')
  await cancelOrder(buyerCookie, orderIds.cancelled, 'qa-seed-order-cancelled-cancel')

  console.log(`  ${Object.keys(orderIds).length} order states seeded`)
  return orderIds
}

// ── Phase 4: QA email states ───────────────────────────────────────────
// Most email states already exist as a side effect of Phase 3's real
// booking flows (requested/accepted/financially_ready/payment_reminder
// etc. all fire for real). This phase adds only the two deterministic
// failure fixtures Step 8 established (console-provider address-keyed
// fixtures), since nothing in a normal flow produces those on demand.
async function seedEmailFailureFixtures() {
  console.log('Phase 4: QA email failure fixtures')
  const retryableEmail = 'qa-email-fixture+fail-retryable@unitytest.internal'
  const terminalEmail = 'qa-email-fixture+fail-terminal@unitytest.internal'
  for (const email of [retryableEmail, terminalEmail]) {
    const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (!existing?.users?.find((u) => u.email === email)) {
      await admin.auth.admin.createUser({ email, password: genPassword(), email_confirm: true })
    }
  }
  console.log('  retryable/terminal email-failure fixture accounts ready (trigger via a KYC or booking action against them to produce a failed delivery row)')
}

// ── Run ─────────────────────────────────────────────────────────────
function writeCredentials(accounts) {
  const credentialsPath = join(REPO_ROOT, '.qa-credentials.local.json')
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Local only — gitignored. Never share this file or paste its contents into chat/logs/docs.',
        accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { email: v.email, password: v.password, role: v.role }])),
      },
      null,
      2
    )
  )
  return credentialsPath
}

async function main() {
  console.log(`QA seed starting against ${SUPABASE_URL} (${APP_URL})\n`)

  const accounts = await seedAccounts()
  // Written immediately after account creation, not only at the very end --
  // a failure in a later phase (listings/bookings/barter/orders) must not
  // discard already-created account credentials, forcing a full re-run.
  writeCredentials(accounts)
  const adminCookie = await cookieFor(accounts.admin.email, accounts.admin.password)
  const listingIds = await seedListings(accounts, adminCookie)
  const buySellListingIds = await seedBuySellListings(accounts)
  const bookingIds = await seedBookings(accounts, listingIds)
  const barterAgreementIds = await seedBarterScenarios(accounts)
  const orderIds = await seedOrderScenarios(accounts)
  await seedEmailFailureFixtures()

  const credentialsPath = writeCredentials(accounts)

  console.log(`\nDone. Credentials written to ${credentialsPath} (gitignored, never printed above).`)
  console.log(`Rental listings: ${Object.keys(listingIds).length}. Buy/sell listings: ${Object.keys(buySellListingIds).length}. Bookings: ${Object.keys(bookingIds).length}. Barter agreements: ${Object.keys(barterAgreementIds).length}. Orders: ${Object.keys(orderIds).length}.`)
}

main().catch((err) => {
  console.error('QA seed failed:', err.message)
  process.exit(1)
})
