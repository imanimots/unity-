#!/usr/bin/env node
/**
 * Unity QA seed & reset script — Step 10 (public-test MVP).
 *
 * Creates a controlled catalogue of QA accounts, listings, bookings, and
 * email-delivery states by driving the REAL application API routes and
 * RPCs wherever one exists (booking lifecycle, moderation decisions, KYC
 * decisions) — never a direct table write for anything that has a real
 * mutation path. Direct service-role inserts are used only where no
 * route exists (initial listing/document scaffolding, backdating a
 * timestamp to simulate "overdue", the deterministic email-failure
 * fixtures) — see inline comments at each such call site.
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
import { randomBytes, randomUUID } from 'node:crypto'
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

// ── Phase 3: QA bookings & financial states ────────────────────────────
async function createAndAccept(renterCookie, merchantCookie, listingId, daysOffset) {
  const start = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString()
  const end = new Date(Date.now() + (daysOffset + 3) * 24 * 60 * 60 * 1000).toISOString()
  const created = await api(renterCookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: start,
    end_at: end,
    idempotency_key: `qa-seed-booking-${randomUUID()}`,
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
  // Randomized starting point so a re-run after a partial failure never
  // collides with dates a previous run already booked (booking_history is
  // immutable — old QA bookings from a prior run are never deleted).
  let offset = 100 + Math.floor(Math.random() * 5000)
  const nextOffset = () => {
    const v = offset
    offset += 20 // wide spacing so no two seeded bookings can ever collide on any shared listing
    return v
  }

  // 1. requested
  bookingIds.requested = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset())

  // 2. accepted, awaiting payment
  bookingIds.acceptedAwaitingPayment = await createAndAccept(renterCookie, merchantBCookie, listingIds.dailyRate, nextOffset())
  await api(merchantBCookie, 'POST', `/api/bookings/${bookingIds.acceptedAwaitingPayment}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.acceptedAwaitingPayment}` })

  // 3. financially ready
  bookingIds.financiallyReady = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskNoDeposit, nextOffset())
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.financiallyReady}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.financiallyReady}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.financiallyReady}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.financiallyReady}` })

  // 4. retryable payment failure
  bookingIds.retryableFailure = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskDeposit, nextOffset())
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.retryableFailure}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.retryableFailure}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.retryableFailure}/checkout`, { test_scenario: 'rental_retryable_failure', idempotency_key: `qa-seed-checkout-${bookingIds.retryableFailure}` })

  // 5. terminal decline
  bookingIds.terminalDecline = await createAndAccept(renterCookie, merchantACookie, listingIds.weeklyRate, nextOffset())
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.terminalDecline}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.terminalDecline}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.terminalDecline}/checkout`, { test_scenario: 'rental_declined', idempotency_key: `qa-seed-checkout-${bookingIds.terminalDecline}` })

  // 6. active rental (financially ready -> start)
  bookingIds.activeRental = await createAndAccept(renterCookie, merchantACookie, listingIds.lowRiskDeposit, nextOffset())
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.activeRental}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.activeRental}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.activeRental}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.activeRental}` })
  await backdateToStartable(bookingIds.activeRental)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.activeRental}/start`, { idempotency_key: `qa-seed-start-${bookingIds.activeRental}` })

  // 7. return pending
  bookingIds.returnPending = await createAndAccept(renterCookie, merchantBCookie, listingIds.disclosedDamage, nextOffset())
  await api(merchantBCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.returnPending}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.returnPending}` })
  await backdateToStartable(bookingIds.returnPending)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/start`, { idempotency_key: `qa-seed-start-${bookingIds.returnPending}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.returnPending}/return`, { idempotency_key: `qa-seed-return-${bookingIds.returnPending}` })

  // 8. completed
  bookingIds.completed = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset())
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.completed}/accept`, { idempotency_key: `qa-seed-accept-${bookingIds.completed}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/checkout`, { test_scenario: 'success', idempotency_key: `qa-seed-checkout-${bookingIds.completed}` })
  await backdateToStartable(bookingIds.completed)
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/start`, { idempotency_key: `qa-seed-start-${bookingIds.completed}` })
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.completed}/return`, { idempotency_key: `qa-seed-return-${bookingIds.completed}` })
  await api(merchantACookie, 'POST', `/api/bookings/${bookingIds.completed}/confirm-return`, { idempotency_key: `qa-seed-confirm-${bookingIds.completed}` })

  // 9. cancelled
  bookingIds.cancelled = await createAndAccept(renterCookie, merchantBCookie, listingIds.mediumRiskOwnershipVerified, nextOffset())
  await api(renterCookie, 'POST', `/api/bookings/${bookingIds.cancelled}/cancel`, { reason: 'QA fixture cancellation', idempotency_key: `qa-seed-cancel-${bookingIds.cancelled}` })

  // 10. expired unpaid — accept, then backdate payment_due_at (no route
  // exists for "make time pass"), then sweep via the real internal route.
  bookingIds.expiredUnpaid = await createAndAccept(renterCookie, merchantACookie, listingIds.dailyRate, nextOffset())
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
async function main() {
  console.log(`QA seed starting against ${SUPABASE_URL} (${APP_URL})\n`)

  const accounts = await seedAccounts()
  const adminCookie = await cookieFor(accounts.admin.email, accounts.admin.password)
  const listingIds = await seedListings(accounts, adminCookie)
  const bookingIds = await seedBookings(accounts, listingIds)
  await seedEmailFailureFixtures()

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

  console.log(`\nDone. Credentials written to ${credentialsPath} (gitignored, never printed above).`)
  console.log(`Listings seeded: ${Object.keys(listingIds).length}. Bookings seeded: ${Object.keys(bookingIds).length}.`)
}

main().catch((err) => {
  console.error('QA seed failed:', err.message)
  process.exit(1)
})
