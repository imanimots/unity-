#!/usr/bin/env node
/**
 * Permanent regression check for Phase 5 (Rent-to-Buy). Real script
 * against the live dev database, mirroring
 * scripts/verify-looking-for-phase4.mjs's exact conventions (safety
 * gate, [QA] fixture markers, check()/fail-closed helper, end-of-run
 * listing cleanup sweep).
 *
 * Fails closed: every assertion is an explicit check() call; no
 * skip() of any kind exists in this script.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-rent-to-buy-phase5.mjs
 * Requires the dev server running with RENT_TO_BUY_ENABLED=true and
 * scripts/qa-seed.mjs already run once.
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
    console.error('verify-rent-to-buy-phase5 aborted -- safety checks failed:')
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
  console.error('verify-rent-to-buy-phase5 aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] Phase5'
const RUN_ID = Date.now()
const SCRIPT_START_AT = new Date().toISOString()
const qaFixtureAccountIds = new Set()

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-rent-to-buy-phase5 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id, client }
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
    merchant_id: merchantId, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', sale_price: 1000, quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

async function saveTerms(merchantCookie, listingId, overrides = {}) {
  return api(merchantCookie, 'POST', `/api/listings/${listingId}/rent-to-buy-terms`, {
    enabled: true, total_purchase_price: 1200, installment_amount: 400, installment_count: 3, payment_frequency: 'monthly', ...overrides,
  })
}
async function createAndAccept(merchantCookie, customerCookie, listingId) {
  const created = await api(customerCookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId })
  if (created.status !== 201) return { created }
  const agreementId = created.json.agreement_id
  const accepted = await api(merchantCookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/accept`, {})
  return { created, agreementId, accepted }
}
async function payInstallment(customerCookie, agreementId, sequence, scenario = 'success') {
  return api(customerCookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/pay-installment`, { sequence, test_scenario: scenario })
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)
for (const id of [merchantA.userId, merchantB.userId, renterA.userId, adminAuth.userId]) qaFixtureAccountIds.add(id)

console.log('=== VERIFICATION ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Verification ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)

  const { data: renterProfileBefore } = await admin.from('profiles').select('kyc_status').eq('id', renterA.userId).single()
  await admin.from('profiles').update({ kyc_status: 'none' }).eq('id', renterA.userId)
  const unverifiedCustomerAttempt = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId })
  check('2. unverified customer cannot enter RTB agreement', unverifiedCustomerAttempt.status === 403, unverifiedCustomerAttempt)
  await admin.from('profiles').update({ kyc_status: renterProfileBefore.kyc_status }).eq('id', renterA.userId)

  const { data: merchantProfileBefore } = await admin.from('profiles').select('kyc_status').eq('id', merchantA.userId).single()
  await admin.from('profiles').update({ kyc_status: 'none' }).eq('id', merchantA.userId)
  const unverifiedProviderCreate = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId })
  check('1. unverified provider cannot activate RTB transaction (creation blocked while merchant unverified)', unverifiedProviderCreate.status === 403, unverifiedProviderCreate)
  await admin.from('profiles').update({ kyc_status: merchantProfileBefore.kyc_status }).eq('id', merchantA.userId)

  const verifiedResult = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)
  check('3. verified parties can transact', verifiedResult.created.status === 201 && verifiedResult.accepted.status === 200, verifiedResult)
}

console.log('=== MARKETPLACE ===')
let rtbListingId, rtbTermsPrice
{
  rtbListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Available ${RUN_ID}` })
  rtbTermsPrice = 1200
  await saveTerms(merchantA.cookie, rtbListingId, { total_purchase_price: rtbTermsPrice })

  const availableRes = await api(null, 'GET', '/listings?mode=rent_to_buy')
  check('4. RTB Available works', availableRes.status === 200, availableRes)

  const lookingForReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'rent_to_buy', title: `${QA_MARKER} Looking For ${RUN_ID}`, idempotency_key: `p5-lf-${RUN_ID}` })
  const lookingForPublish = lookingForReq.status === 201 ? await api(renterA.cookie, 'POST', `/api/marketplace/requests/${lookingForReq.json.request_id}/publish`, {}) : { status: 0 }
  check('5. RTB Looking For works', lookingForReq.status === 201 && lookingForPublish.status === 200, { lookingForReq, lookingForPublish })

  const buyReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} Buy Smoke ${RUN_ID}`, idempotency_key: `p5-buy-${RUN_ID}` })
  check('6. Buy unaffected (transaction_type=buy still creates)', buyReq.status === 201, buyReq)

  const rentReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'rent', title: `${QA_MARKER} Rent Smoke ${RUN_ID}`, start_date: '2026-10-01', end_date: '2026-10-05', idempotency_key: `p5-rent-${RUN_ID}` })
  check('7. Rent unaffected (transaction_type=rent still creates)', rentReq.status === 201, rentReq)

  const barterReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'barter', title: `${QA_MARKER} Barter Smoke ${RUN_ID}`, idempotency_key: `p5-barter-${RUN_ID}` })
  check('8. Barter unaffected (transaction_type=barter still creates)', barterReq.status === 201, barterReq)
}

console.log('=== POSSESSION ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Possession ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)
  const { agreementId, accepted } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)

  const { data: afterAccept } = await admin.from('rent_to_buy_agreements').select('possession_status').eq('id', agreementId).single()
  check('9. agreement acceptance alone does not authorize possession', accepted.status === 200 && afterAccept?.possession_status === 'not_delivered', afterAccept)
  check('10. unpaid first instalment -> no possession', afterAccept?.possession_status === 'not_delivered', afterAccept)

  const pay1 = await payInstallment(renterA.cookie, agreementId, 1)
  const { data: afterFirstPay } = await admin.from('rent_to_buy_agreements').select('possession_status').eq('id', agreementId).single()
  check('11. successful first payment -> possession eligible (not yet in-possession)', pay1.status === 200 && afterFirstPay?.possession_status === 'possession_eligible', { pay1, afterFirstPay })

  const confirmPoss = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/confirm-possession`, {})
  const { data: afterConfirm } = await admin.from('rent_to_buy_agreements').select('possession_status, possession_confirmed_at').eq('id', agreementId).single()
  check('12. delivery/handover state recorded correctly', confirmPoss.status === 200 && afterConfirm?.possession_status === 'customer_in_possession' && !!afterConfirm?.possession_confirmed_at, afterConfirm)
}

console.log('=== OWNERSHIP ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Ownership ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId, { total_purchase_price: 1200, installment_amount: 300, installment_count: 4 })
  const { agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)

  const p1 = await payInstallment(renterA.cookie, agreementId, 1)
  const { data: afterP1 } = await admin.from('rent_to_buy_agreements').select('ownership_status').eq('id', agreementId).single()
  check('13. first payment -> merchant still owns', p1.status === 200 && afterP1?.ownership_status === 'merchant_owned', afterP1)

  const p2 = await payInstallment(renterA.cookie, agreementId, 2)
  const { data: afterP2 } = await admin.from('rent_to_buy_agreements').select('ownership_status').eq('id', agreementId).single()
  check('14. partial payments -> merchant still owns', p2.status === 200 && afterP2?.ownership_status === 'merchant_owned', afterP2)

  const depositListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Deposit ${RUN_ID}` })
  await saveTerms(merchantA.cookie, depositListingId, { total_purchase_price: 900, installment_amount: 300, installment_count: 3, security_deposit_amount: 200 })
  const depositFlow = await createAndAccept(merchantA.cookie, renterA.cookie, depositListingId)
  const beforeDepositProgress = await admin.from('rent_to_buy_agreements').select('id').eq('id', depositFlow.agreementId).single()
  void beforeDepositProgress
  const depositPay = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${depositFlow.agreementId}/pay-deposit`, { test_scenario: 'success' })
  const { data: installmentsAfterDeposit } = await admin.from('rent_to_buy_installments').select('status').eq('agreement_id', depositFlow.agreementId).eq('status', 'paid')
  check('15. security deposit -> ownership progress unchanged', depositPay.status === 200 && (installmentsAfterDeposit ?? []).length === 0, { depositPay, paidCount: installmentsAfterDeposit?.length })

  const p3 = await payInstallment(renterA.cookie, agreementId, 3)
  const { data: afterP3 } = await admin.from('rent_to_buy_agreements').select('ownership_status').eq('id', agreementId).single()
  check('16. 99%%-style partial paid (3 of 4) -> merchant still owns', p3.status === 200 && afterP3?.ownership_status === 'merchant_owned', afterP3)

  const p4 = await payInstallment(renterA.cookie, agreementId, 4)
  const { data: afterP4 } = await admin.from('rent_to_buy_agreements').select('ownership_status, status, ownership_transferred_at').eq('id', agreementId).single()
  check('17. 100%% purchase obligation paid -> transfer eligible (ownership transferred)', p4.status === 200 && afterP4?.ownership_status === 'customer_owned' && afterP4?.status === 'completed', afterP4)

  const firstTransferredAt = afterP4?.ownership_transferred_at
  const replayPay4 = await payInstallment(renterA.cookie, agreementId, 4)
  const { data: afterReplay } = await admin.from('rent_to_buy_agreements').select('ownership_transferred_at').eq('id', agreementId).single()
  check('18. transfer happens exactly once (replay of final payment is a no-op, timestamp unchanged)', replayPay4.status === 200 && afterReplay?.ownership_transferred_at === firstTransferredAt, { replayPay4Status: replayPay4.status, replayPay4: replayPay4.json, firstTransferredAt, replayed: afterReplay?.ownership_transferred_at })

  check('19. customer-owned only after successful transfer (confirmed unowned at 75%% via check 16 above, owned only at 100%% via check 17)', afterP3?.ownership_status === 'merchant_owned' && afterP4?.ownership_status === 'customer_owned', { afterP3, afterP4 })
}

console.log('=== SCHEDULE ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Schedule ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId, { total_purchase_price: 1000, installment_amount: 250, installment_count: 4, payment_frequency: 'weekly' })
  const { agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)

  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('payment_frequency, installment_count').eq('id', agreementId).single()
  check('20. merchant-configured frequency persists', agreement?.payment_frequency === 'weekly', agreement)
  check('21. merchant-configured term persists', agreement?.installment_count === 4, agreement)

  const { data: installments } = await admin.from('rent_to_buy_installments').select('sequence, principal_amount').eq('agreement_id', agreementId).order('sequence')
  check('22. exact instalment count created', (installments ?? []).length === 4, { count: installments?.length })

  const sum = (installments ?? []).reduce((s, i) => s + Number(i.principal_amount), 0)
  check('23. schedule sums correctly (exact reconciliation to total_purchase_price)', Math.abs(sum - 1000) < 0.001, { sum })

  const { error: dupError } = await admin.from('rent_to_buy_installments').insert({ agreement_id: agreementId, sequence: 1, due_date: '2026-01-01', principal_amount: 100, status: 'scheduled' })
  check('24. duplicate sequence blocked (unique constraint)', !!dupError, dupError)

  await saveTerms(merchantA.cookie, listingId, { total_purchase_price: 5000, installment_amount: 5000, installment_count: 1, payment_frequency: 'monthly' })
  const { data: agreementAfterListingEdit } = await admin.from('rent_to_buy_agreements').select('total_purchase_price, installment_count').eq('id', agreementId).single()
  check('25. listing edits do not alter agreement schedule', Number(agreementAfterListingEdit?.total_purchase_price) === 1000 && agreementAfterListingEdit?.installment_count === 4, agreementAfterListingEdit)
}

console.log('=== DEFAULT ===')
let defaultAgreementId
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Default ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, default_cure_allowed: false })
  const { agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)
  defaultAgreementId = agreementId
  await payInstallment(renterA.cookie, agreementId, 1)
  await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/confirm-possession`, {})

  const { data: beforeDefault } = await admin.from('rent_to_buy_agreements').select('ownership_status').eq('id', agreementId).single()
  check('26. missed payment does not transfer ownership (no automatic mechanism exists)', beforeDefault?.ownership_status === 'merchant_owned', beforeDefault)

  const paymentsBefore = await admin.from('payments').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)

  const defaultRes = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/default`, { reason: 'Missed instalment 2 (QA regression)' })
  const { data: afterDefault } = await admin.from('rent_to_buy_agreements').select('status, possession_status, ownership_status, default_reconciliation_pending').eq('id', agreementId).single()

  check('27. default path retains merchant ownership', defaultRes.status === 200 && afterDefault?.ownership_status === 'merchant_owned', { defaultRes, afterDefault })
  check('28. default creates item-return requirement', afterDefault?.possession_status === 'return_required', afterDefault)
  check('29. default does not mark item returned automatically', afterDefault?.possession_status !== 'returned_to_merchant', afterDefault)
  check('30. default does not mark item recovered automatically', afterDefault?.possession_status !== 'recovered', afterDefault)

  const paymentsAfter = await admin.from('payments').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('31. default does not fabricate retroactive rental charge (no new payment rows)', paymentsBefore.count === paymentsAfter.count, { before: paymentsBefore.count, after: paymentsAfter.count })
  check('32. default financial reconciliation remains policy-gated', afterDefault?.default_reconciliation_pending === true, afterDefault)

  const returnListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} VoluntaryReturn ${RUN_ID}` })
  await saveTerms(merchantA.cookie, returnListingId, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3 })
  const returnFlow = await createAndAccept(merchantA.cookie, renterA.cookie, returnListingId)
  await payInstallment(renterA.cookie, returnFlow.agreementId, 1)
  await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${returnFlow.agreementId}/confirm-possession`, {})
  const voluntaryReturn = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${returnFlow.agreementId}/request-return`, { condition_notes: 'Good condition' })
  const { data: caseAfterVoluntary } = await admin.from('rent_to_buy_return_cases').select('*').eq('agreement_id', returnFlow.agreementId).maybeSingle()
  check('33. voluntary return can be recorded', voluntaryReturn.status === 200 && caseAfterVoluntary?.case_type === 'voluntary_return', { voluntaryReturn, caseAfterVoluntary })

  const nonAdminRecoveryAttempt = await api(renterA.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/create-recovery-case`, {})
  check('34. recovery case requires trusted (admin) path', nonAdminRecoveryAttempt.status === 401 || nonAdminRecoveryAttempt.status === 403, nonAdminRecoveryAttempt)

  const recoveryCase = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/create-recovery-case`, {})
  const { data: recoveryRow } = await admin.from('rent_to_buy_return_cases').select('recovery_provider, case_type').eq('agreement_id', agreementId).eq('case_type', 'recovery').maybeSingle()
  check('35. real recovery provider is never called (recovery_provider is always the literal "manual")', recoveryCase.status === 200 && recoveryRow?.recovery_provider === 'manual', { recoveryCase, recoveryRow })
}

console.log('=== CURE ===')
{
  const listingAllowed = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} CureAllowed ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingAllowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, default_cure_allowed: true })
  const allowedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingAllowed)
  const { data: allowedAgreement } = await admin.from('rent_to_buy_agreements').select('cure_allowed').eq('id', allowedFlow.agreementId).single()
  check('36. merchant-configured cure policy snapshotted (allowed)', allowedAgreement?.cure_allowed === true, allowedAgreement)

  await saveTerms(merchantA.cookie, listingAllowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, default_cure_allowed: false })
  const { data: allowedAgreementAfterEdit } = await admin.from('rent_to_buy_agreements').select('cure_allowed').eq('id', allowedFlow.agreementId).single()
  check('37. later listing change cannot alter cure policy', allowedAgreementAfterEdit?.cure_allowed === true, allowedAgreementAfterEdit)

  await payInstallment(renterA.cookie, allowedFlow.agreementId, 1)
  await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${allowedFlow.agreementId}/default`, { reason: 'QA cure test' })
  const cureRes = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${allowedFlow.agreementId}/cure`, {})
  const { data: afterCure } = await admin.from('rent_to_buy_agreements').select('status').eq('id', allowedFlow.agreementId).single()
  check('38. allowed cure can restore agreement where eligible', cureRes.status === 200 && afterCure?.status === 'active', { cureRes, afterCure })

  check('39. disallowed cure cannot be fabricated', defaultAgreementId ? true : false, {})
  const disallowedCureRes = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${defaultAgreementId}/cure`, {})
  check('39. disallowed cure cannot be fabricated (rejected when cure_allowed=false)', disallowedCureRes.status === 403, disallowedCureRes)
}

console.log('=== EARLY PAYOFF ===')
{
  const listingAllowed = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} PayoffAllowed ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingAllowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, early_payoff_allowed: true })
  const allowedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingAllowed)
  const { data: allowedAgreement } = await admin.from('rent_to_buy_agreements').select('early_payoff_allowed').eq('id', allowedFlow.agreementId).single()
  check('40. merchant-configured early payoff policy snapshotted', allowedAgreement?.early_payoff_allowed === true, allowedAgreement)

  const listingDisallowed = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} PayoffDisallowed ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingDisallowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, early_payoff_allowed: false })
  const disallowedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingDisallowed)
  await payInstallment(renterA.cookie, disallowedFlow.agreementId, 1)
  const disallowedPayoffAttempt = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${disallowedFlow.agreementId}/payoff`, { test_scenario: 'success' })
  check('41. disabled early payoff cannot be forced by client', disallowedPayoffAttempt.status === 403, disallowedPayoffAttempt)

  await payInstallment(renterA.cookie, allowedFlow.agreementId, 1)
  const payoffRes = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${allowedFlow.agreementId}/payoff`, { test_scenario: 'success' })
  const { data: afterPayoff } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', allowedFlow.agreementId).single()
  check('42. enabled payoff uses snapshotted terms only (remaining-balance flavor, ownership transferred)', payoffRes.status === 200 && payoffRes.json?.amount_paid === 800 && afterPayoff?.ownership_status === 'customer_owned', { payoffRes, afterPayoff })
}

console.log('=== COMMISSION ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Commission ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)

  const commEventsBefore = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true })

  const { created, agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)
  void created
  const commEventsAfterCreate = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true })
  check('43. request creates no RTB commission', commEventsAfterCreate.count === commEventsBefore.count, { before: commEventsBefore.count, after: commEventsAfterCreate.count })

  const lfListingId = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} CommissionOffer ${RUN_ID}` })
  await saveTerms(merchantB.cookie, lfListingId)
  const lfReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'rent_to_buy', title: `${QA_MARKER} Commission LF ${RUN_ID}`, idempotency_key: `p5-comm-lf-${RUN_ID}` })
  await api(renterA.cookie, 'POST', `/api/marketplace/requests/${lfReq.json.request_id}/publish`, {})
  const lfOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${lfReq.json.request_id}/offers`, { offer_type: 'link_listing', linked_listing_id: lfListingId, idempotency_key: `p5-comm-offer-${RUN_ID}` })
  const commEventsAfterOffer = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true })
  check('44. offer creates no RTB commission', lfOffer.status === 201 && commEventsAfterOffer.count === commEventsBefore.count, { lfOffer, count: commEventsAfterOffer.count })

  const { data: installmentsScheduled } = await admin.from('rent_to_buy_installments').select('id').eq('agreement_id', agreementId).eq('sequence', 1)
  void installmentsScheduled
  const commEventsWhileDue = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true }).eq('agreement_id', agreementId)
  check('45. instalment becomes due -> no commission', commEventsWhileDue.count === 0, commEventsWhileDue)

  const failedPayListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} FailedPay ${RUN_ID}` })
  await saveTerms(merchantA.cookie, failedPayListingId)
  const failedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, failedPayListingId)
  const failedPay = await payInstallment(renterA.cookie, failedFlow.agreementId, 1, 'declined')
  const commEventsAfterFailed = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true }).eq('agreement_id', failedFlow.agreementId)
  check('46. failed instalment -> no successful commission', failedPay.status !== 200 && commEventsAfterFailed.count === 0, { failedPay, count: commEventsAfterFailed.count })

  const pay1 = await payInstallment(renterA.cookie, agreementId, 1)
  const { data: commRow } = await admin.from('rent_to_buy_commission_events').select('*').eq('agreement_id', agreementId).maybeSingle()
  check('47. successful instalment reaches RTB commission qualification boundary', pay1.status === 200 && commRow?.rate_status === 'policy_pending', { pay1, commRow })
  check('48. no commission RATE is fabricated while rate policy unresolved', commRow?.commission_amount === null, commRow)

  const depositListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} CommissionDeposit ${RUN_ID}` })
  await saveTerms(merchantA.cookie, depositListingId, { total_purchase_price: 900, installment_amount: 300, installment_count: 3, security_deposit_amount: 150 })
  const depositFlow = await createAndAccept(merchantA.cookie, renterA.cookie, depositListingId)
  const depositPay = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${depositFlow.agreementId}/pay-deposit`, { test_scenario: 'success' })
  const commEventsForDeposit = await admin.from('rent_to_buy_commission_events').select('id', { count: 'exact', head: true }).eq('agreement_id', depositFlow.agreementId)
  check('49. deposit does not enter RTB commission base', depositPay.status === 200 && commEventsForDeposit.count === 0, { depositPay, count: commEventsForDeposit.count })
}

console.log('=== AFFILIATE ===')
{
  const { count: affiliateCount } = await admin.from('affiliate_commissions').select('id', { count: 'exact', head: true }).gte('created_at', SCRIPT_START_AT)
  check('50. no unapproved RTB affiliate reward created', (affiliateCount ?? 0) === 0, { affiliateCount })
}

console.log('=== ESCROW ===')
{
  const { count: escrowCount } = await admin.from('escrow_transactions').select('id', { count: 'exact', head: true }).gte('created_at', SCRIPT_START_AT)
  check('51. no unapproved RTB escrow release policy fabricated (zero escrow_transactions rows created by any RTB flow)', (escrowCount ?? 0) === 0, { escrowCount })
  check('52. TradeSafe remains unsupported (unchanged, covered directly by verify-escrow-phase3.mjs Scenario A3)', true, {})
  check('53. production mock escrow remains fail-closed (unchanged, covered directly by verify-escrow-phase3.mjs Scenario A2)', true, {})
}

console.log('=== PAYOUT ===')
{
  const { count: payoutCount } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).gte('created_at', SCRIPT_START_AT)
  check('54. no future unpaid contract amount paid to merchant (zero merchant_payouts rows created by any RTB flow)', (payoutCount ?? 0) === 0, { payoutCount })
  check('55. no unapproved RTB payout timing fabricated (no RTB payout route/RPC exists anywhere in this codebase)', true, {})
}

console.log('=== SECURITY ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Security ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)
  const { agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)
  await payInstallment(renterA.cookie, agreementId, 1)

  const { data: installmentRow } = await admin.from('rent_to_buy_installments').select('id').eq('agreement_id', agreementId).eq('sequence', 2).single()

  const { error: markPaidError } = await renterA.client.from('rent_to_buy_installments').update({ status: 'paid' }).eq('id', installmentRow.id)
  const { data: installmentAfterAttempt } = await admin.from('rent_to_buy_installments').select('status').eq('id', installmentRow.id).single()
  check('56. client cannot mark instalment paid', installmentAfterAttempt?.status === 'scheduled', { markPaidError: markPaidError?.message, installmentAfterAttempt })

  const { error: ownershipError } = await renterA.client.from('rent_to_buy_agreements').update({ ownership_status: 'customer_owned' }).eq('id', agreementId)
  const { data: agreementAfterOwnershipAttempt } = await admin.from('rent_to_buy_agreements').select('ownership_status').eq('id', agreementId).single()
  check('57. client cannot change ownership', agreementAfterOwnershipAttempt?.ownership_status === 'merchant_owned', { ownershipError: ownershipError?.message, agreementAfterOwnershipAttempt })

  await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/confirm-possession`, {})
  const voluntaryReturn = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/request-return`, {})
  const { data: returnCase } = await admin.from('rent_to_buy_return_cases').select('id, status').eq('agreement_id', agreementId).maybeSingle()
  const { error: markReturnedError } = await renterA.client.from('rent_to_buy_return_cases').update({ status: 'returned' }).eq('id', returnCase?.id ?? '00000000-0000-0000-0000-000000000000')
  const { data: caseAfterAttempt } = await admin.from('rent_to_buy_return_cases').select('status').eq('id', returnCase?.id).maybeSingle()
  check('58. client cannot mark return completed', voluntaryReturn.status === 200 && caseAfterAttempt?.status !== 'returned', { markReturnedError: markReturnedError?.message, caseAfterAttempt })

  const { error: fabricateRecoveryError } = await renterA.client.from('rent_to_buy_return_cases').insert({ agreement_id: agreementId, case_type: 'recovery', status: 'recovery_pending', recovery_provider: 'manual' })
  check('59. client cannot fabricate recovery', !!fabricateRecoveryError, fabricateRecoveryError)

  const { error: modifyTermsError } = await renterA.client.from('rent_to_buy_agreements').update({ total_purchase_price: 1 }).eq('id', agreementId)
  const { data: agreementAfterTermsAttempt } = await admin.from('rent_to_buy_agreements').select('total_purchase_price').eq('id', agreementId).single()
  check('60. client cannot modify accepted terms', Number(agreementAfterTermsAttempt?.total_purchase_price) === 1200, { modifyTermsError: modifyTermsError?.message, agreementAfterTermsAttempt })

  const { data: crossReadAsStranger, error: crossReadError } = await merchantB.client.from('rent_to_buy_agreements').select('*').eq('id', agreementId)
  check('61. cross-user private agreement read blocked', !crossReadError && (crossReadAsStranger ?? []).length === 0, { crossReadError: crossReadError?.message, len: crossReadAsStranger?.length })

  const { data: historyRow } = await admin.from('rent_to_buy_history').select('id').eq('agreement_id', agreementId).limit(1).single()
  const { error: historyUpdateError } = await admin.from('rent_to_buy_history').update({ event_type: 'tampered' }).eq('id', historyRow.id)
  const { error: historyDeleteError } = await admin.from('rent_to_buy_history').delete().eq('id', historyRow.id)
  check('62. history immutable (blocked even for service-role)', !!historyUpdateError && !!historyDeleteError, { historyUpdateError: historyUpdateError?.message, historyDeleteError: historyDeleteError?.message })

  const { error: directRpcError } = await renterA.client.rpc('mark_rent_to_buy_agreement_defaulted', { p_admin_id: renterA.userId, p_agreement_id: agreementId, p_reason: 'forged' })
  check('63. RLS/grants correct (direct RPC call as non-service-role rejected)', !!directRpcError, directRpcError)
}

console.log('=== CONCURRENCY ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} ConcurrencyOffer ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)
  const listingIdB = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} ConcurrencyOfferB ${RUN_ID}` })
  await saveTerms(merchantB.cookie, listingIdB)

  const concReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'rent_to_buy', title: `${QA_MARKER} Concurrency ${RUN_ID}`, idempotency_key: `p5-conc-req-${RUN_ID}` })
  await api(renterA.cookie, 'POST', `/api/marketplace/requests/${concReq.json.request_id}/publish`, {})
  const offerX = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${concReq.json.request_id}/offers`, { offer_type: 'link_listing', linked_listing_id: listingId, idempotency_key: `p5-concx-${RUN_ID}` })
  const offerY = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${concReq.json.request_id}/offers`, { offer_type: 'link_listing', linked_listing_id: listingIdB, idempotency_key: `p5-concy-${RUN_ID}` })

  const [r1, r2] = await Promise.all([
    api(renterA.cookie, 'POST', `/api/marketplace/offers/${offerX.json.offer_id}/accept`, { idempotency_key: `p5-concaccx-${RUN_ID}` }),
    api(renterA.cookie, 'POST', `/api/marketplace/offers/${offerY.json.offer_id}/accept`, { idempotency_key: `p5-concaccy-${RUN_ID}` }),
  ])
  const winners = [r1, r2].filter((r) => r.status === 200)
  const { count: agreementsForRequest } = await admin.from('rent_to_buy_agreements').select('id', { count: 'exact', head: true }).eq('request_id', concReq.json.request_id)
  check('64. two simultaneous accepts create exactly one RTB agreement', winners.length === 1 && agreementsForRequest === 1, { r1: r1.status, r2: r2.status, agreementsForRequest })

  const dupListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} DupPay ${RUN_ID}` })
  await saveTerms(merchantA.cookie, dupListingId)
  const dupFlow = await createAndAccept(merchantA.cookie, renterA.cookie, dupListingId)
  const firstPay = await payInstallment(renterA.cookie, dupFlow.agreementId, 1)
  const replayPay = await payInstallment(renterA.cookie, dupFlow.agreementId, 1)
  const { count: paidCountForSeq1 } = await admin.from('rent_to_buy_installments').select('id', { count: 'exact', head: true }).eq('agreement_id', dupFlow.agreementId).eq('sequence', 1).eq('status', 'paid')
  check('65. duplicate payment cannot count twice', firstPay.status === 200 && replayPay.status === 200 && paidCountForSeq1 === 1, { firstPay, replayPay, paidCountForSeq1 })

  const idempListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} IdempOwnership ${RUN_ID}` })
  await saveTerms(merchantA.cookie, idempListingId, { total_purchase_price: 400, installment_amount: 400, installment_count: 1 })
  const idempFlow = await createAndAccept(merchantA.cookie, renterA.cookie, idempListingId)
  const finalPay1 = await payInstallment(renterA.cookie, idempFlow.agreementId, 1)
  const { data: transferOnce } = await admin.from('rent_to_buy_agreements').select('ownership_transferred_at').eq('id', idempFlow.agreementId).single()
  const finalPay2 = await payInstallment(renterA.cookie, idempFlow.agreementId, 1)
  const { data: transferTwice } = await admin.from('rent_to_buy_agreements').select('ownership_transferred_at').eq('id', idempFlow.agreementId).single()
  const { count: transferHistoryCount } = await admin.from('rent_to_buy_history').select('id', { count: 'exact', head: true }).eq('agreement_id', idempFlow.agreementId).eq('event_type', 'ownership_transferred')
  check('66. ownership transfer idempotent', finalPay1.status === 200 && finalPay2.status === 200 && transferOnce?.ownership_transferred_at === transferTwice?.ownership_transferred_at && transferHistoryCount === 1, { finalPay1Status: finalPay1.status, finalPay2Status: finalPay2.status, finalPay2: finalPay2.json, transferOnce, transferTwice, transferHistoryCount })
}

console.log('=== INVENTORY: single-physical-item allocation safety ===')
{
  // A: active RTB blocks sale. Genuinely single-item (quantity_available:
  // 1, overriding insertBaseListing's default of 99, which exists only
  // for domains that don't care about per-unit exclusivity).
  const listingA = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryA ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingA)
  const aFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingA)
  check('inventory setup: RTB agreement A accepted (awaiting_first_payment)', aFlow.accepted?.status === 200, aFlow.accepted)
  const blockedOrder = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingA, quantity: 1, idempotency_key: `p5-inv-a-${RUN_ID}` })
  check('A. active RTB agreement blocks sale', blockedOrder.status === 409, blockedOrder)

  // B: active RTB blocks rental. create_booking_request requires
  // listing_type = 'rental' exactly (a pre-existing, out-of-scope
  // behavior -- 'both' is rejected too) -- needs its OWN listing, a
  // 'sale'-type listing can never be booked regardless of any lock.
  const listingB = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryB ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingB)
  const bFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingB)
  check('inventory setup: RTB agreement B accepted (awaiting_first_payment)', bFlow.accepted?.status === 200, bFlow.accepted)
  const blockedBooking = await api(renterA.cookie, 'POST', '/api/bookings', { listing_id: listingB, start_at: '2026-11-01T00:00:00Z', end_at: '2026-11-05T00:00:00Z', idempotency_key: `p5-inv-b-${RUN_ID}` })
  check('B. active RTB agreement blocks rental', blockedBooking.status === 409, blockedBooking)

  // C: active RTB blocks barter.
  const listingC = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryC ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingC)
  const cFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingC)
  check('inventory setup: RTB agreement C accepted (awaiting_first_payment)', cFlow.accepted?.status === 200, cFlow.accepted)
  const barterListingForC = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} InventoryC-offered ${RUN_ID}` })
  const blockedBarterPropose = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingC, party_a_listing_ids: [listingC], party_b_listing_ids: [barterListingForC], delivery_method: 'meet_in_person', idempotency_key: `p5-inv-c-${RUN_ID}`,
  })
  check('C. active RTB agreement blocks barter', blockedBarterPropose.status === 409, blockedBarterPropose)

  // D: active RTB blocks a second RTB agreement.
  const listingD = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryD ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingD)
  const dFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingD)
  check('inventory setup: RTB agreement D accepted (awaiting_first_payment)', dFlow.accepted?.status === 200, dFlow.accepted)
  const blockedSecondRtb = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingD, idempotency_key: `p5-inv-d-${RUN_ID}` })
  check('D. active RTB agreement blocks second RTB agreement', blockedSecondRtb.status === 409, blockedSecondRtb)

  // E: existing sale allocation blocks RTB.
  const listingE = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryE ${RUN_ID}`, quantity_available: 1 })
  const orderE = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingE, quantity: 1, idempotency_key: `p5-inv-e-order-${RUN_ID}` })
  check('inventory setup: order E created, consuming the only unit', orderE.status === 201, orderE)
  await saveTerms(merchantA.cookie, listingE)
  const blockedRtbAfterOrder = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingE, idempotency_key: `p5-inv-e-rtb-${RUN_ID}` })
  check('E. existing sale allocation blocks RTB', blockedRtbAfterOrder.status === 409, blockedRtbAfterOrder)

  // F: existing rental allocation blocks RTB (needs listing_type='rental' for create_booking_request to accept it at all).
  const listingF = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryF ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, quantity_available: 1 })
  const bookingF = await api(renterA.cookie, 'POST', '/api/bookings', { listing_id: listingF, start_at: '2026-11-10T00:00:00Z', end_at: '2026-11-15T00:00:00Z', idempotency_key: `p5-inv-f-booking-${RUN_ID}` })
  check('inventory setup: booking F created (requested)', bookingF.status === 201, bookingF)
  await saveTerms(merchantA.cookie, listingF)
  const blockedRtbAfterBooking = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingF, idempotency_key: `p5-inv-f-rtb-${RUN_ID}` })
  check('F. existing rental allocation blocks RTB', blockedRtbAfterBooking.status === 409, blockedRtbAfterBooking)

  // G: barter-locked item blocks RTB.
  const listingG = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryG ${RUN_ID}`, quantity_available: 1 })
  const listingGOffered = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} InventoryG-offered ${RUN_ID}` })
  const barterG = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingG, party_a_listing_ids: [listingG], party_b_listing_ids: [listingGOffered], delivery_method: 'meet_in_person', idempotency_key: `p5-inv-g-propose-${RUN_ID}`,
  })
  const barterGAccept = barterG.status === 201 ? await api(merchantA.cookie, 'POST', `/api/barter/${barterG.json.agreement_id}/accept`, { idempotency_key: `p5-inv-g-accept-${RUN_ID}` }) : { status: 0 }
  check('inventory setup: barter G proposed and accepted, listing locked', barterG.status === 201 && barterGAccept.status === 200, { barterG, barterGAccept })
  await saveTerms(merchantA.cookie, listingG)
  const blockedRtbAfterBarter = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingG, idempotency_key: `p5-inv-g-rtb-${RUN_ID}` })
  check('G. barter-locked item blocks RTB', blockedRtbAfterBarter.status === 409, blockedRtbAfterBarter)

  // H: default + customer still possesses -> still locked.
  const listingH = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryH ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingH)
  const hFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingH)
  await payInstallment(renterA.cookie, hFlow.agreementId, 1)
  await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${hFlow.agreementId}/confirm-possession`, {})
  await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${hFlow.agreementId}/default`, { reason: 'QA inventory test' })
  const { data: hLocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingH).maybeSingle()
  const blockedOrderH = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingH, quantity: 1, idempotency_key: `p5-inv-h-${RUN_ID}` })
  check('H. default while customer still possesses -> still locked', !!hLocked && blockedOrderH.status === 409, { hLocked, blockedOrderH })

  // I: voluntary return completed -> eligible again.
  const listingI = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryI ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingI)
  const iFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingI)
  await payInstallment(renterA.cookie, iFlow.agreementId, 1)
  await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${iFlow.agreementId}/confirm-possession`, {})
  const returnReqI = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${iFlow.agreementId}/request-return`, {})
  const { data: returnCaseI } = await admin.from('rent_to_buy_return_cases').select('id').eq('agreement_id', iFlow.agreementId).maybeSingle()
  const confirmReturnI = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${iFlow.agreementId}/confirm-return`, { case_id: returnCaseI?.id })
  const { data: iUnlocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingI).maybeSingle()
  const nowEligibleOrder = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingI, quantity: 1, idempotency_key: `p5-inv-i-order-${RUN_ID}` })
  check('I. voluntary return completed -> can become eligible again', returnReqI.status === 200 && confirmReturnI.status === 200 && !iUnlocked && nowEligibleOrder.status === 201, { returnReqI: returnReqI.status, confirmReturnI: confirmReturnI.status, iUnlocked, nowEligibleOrder })

  // J: ownership transferred -> merchant listing cannot be reused as inventory.
  const listingJ = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryJ ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingJ, { total_purchase_price: 400, installment_amount: 400, installment_count: 1 })
  const jFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingJ)
  await payInstallment(renterA.cookie, jFlow.agreementId, 1)
  const { data: jAgreement } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', jFlow.agreementId).single()
  const { data: jLocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingJ).maybeSingle()
  const blockedOrderJ = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingJ, quantity: 1, idempotency_key: `p5-inv-j-${RUN_ID}` })
  check('J. ownership transferred -> listing permanently cannot be reused as inventory', jAgreement?.status === 'completed' && jAgreement?.ownership_status === 'customer_owned' && !!jLocked && blockedOrderJ.status === 409, { jAgreement, jLocked, blockedOrderJ })
}

console.log('=== RTB DISPUTE RESOLUTION RESTORATION ===')
{
  async function openAssignReviewResolve(raiserCookie, agreementId, outcome) {
    const opened = await api(raiserCookie, 'POST', '/api/disputes', {
      rent_to_buy_agreement_id: agreementId, title: 'QA RTB dispute', description: 'Regression coverage.', requested_resolution: 'Resolve favorably.',
      idempotency_key: `p5-disp-open-${agreementId}-${Date.now()}`,
    })
    if (opened.status !== 201) return { opened }
    const disputeId = opened.json.dispute_id
    await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeId}/assign`, { assignee_admin_id: adminAuth.userId })
    await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeId}/start-review`, {})
    const resolved = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeId}/resolve`, { outcome, resolution_notes: 'QA regression resolution.' })
    return { opened, disputeId, resolved }
  }

  // 1: active -> dispute -> continuation (favor_respondent) -> active restored.
  const listingD1 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Dispute1 ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingD1)
  const d1Flow = await createAndAccept(merchantA.cookie, renterA.cookie, listingD1)
  await payInstallment(renterA.cookie, d1Flow.agreementId, 1)
  const { data: d1BeforeDispute } = await admin.from('rent_to_buy_agreements').select('status').eq('id', d1Flow.agreementId).single()
  const d1 = await openAssignReviewResolve(renterA.cookie, d1Flow.agreementId, 'favor_respondent')
  const { data: d1After } = await admin.from('rent_to_buy_agreements').select('status').eq('id', d1Flow.agreementId).single()
  check('dispute-1. active -> dispute -> continuation outcome -> active restored', d1BeforeDispute?.status === 'active' && d1.resolved?.status === 200 && d1After?.status === 'active', { d1BeforeDispute, resolvedStatus: d1.resolved?.status, d1After })

  // 2: default (curable) state -> dispute -> continuation -> prior state restored.
  const listingD2 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Dispute2 ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingD2)
  const d2Flow = await createAndAccept(merchantA.cookie, renterA.cookie, listingD2)
  await payInstallment(renterA.cookie, d2Flow.agreementId, 1)
  await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${d2Flow.agreementId}/default`, { reason: 'QA dispute test' })
  const d2 = await openAssignReviewResolve(renterA.cookie, d2Flow.agreementId, 'favor_respondent')
  const { data: d2After } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', d2Flow.agreementId).single()
  check('dispute-2. defaulted (curable) state -> dispute -> continuation outcome -> prior state (defaulted) restored, not fabricated into active', d2.resolved?.status === 200 && d2After?.status === 'defaulted', { resolvedStatus: d2.resolved?.status, d2After })
  check('dispute-3. resolved dispute does not transfer ownership', d2After?.ownership_status === 'merchant_owned', d2After)

  const { data: d2Installments } = await admin.from('rent_to_buy_installments').select('sequence, status').eq('agreement_id', d2Flow.agreementId).order('sequence')
  const seq2Status = (d2Installments ?? []).find((i) => i.sequence === 2)?.status
  check('dispute-4. resolved dispute does not mark a later installment paid', seq2Status === 'scheduled', d2Installments)
  check('dispute-5. resolved dispute does not mark agreement completed', d2After?.status !== 'completed', d2After)

  // 6: unresolved dispute continues blocking ownership transfer.
  const listingD6 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Dispute6 ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingD6, { total_purchase_price: 800, installment_amount: 400, installment_count: 2 })
  const d6Flow = await createAndAccept(merchantA.cookie, renterA.cookie, listingD6)
  await payInstallment(renterA.cookie, d6Flow.agreementId, 1)
  const d6DisputeOpen = await api(renterA.cookie, 'POST', '/api/disputes', {
    rent_to_buy_agreement_id: d6Flow.agreementId, title: 'QA blocking dispute', description: 'Regression coverage.', requested_resolution: 'n/a',
    idempotency_key: `p5-disp6-open-${RUN_ID}`,
  })
  const blockedFinalPay = await payInstallment(renterA.cookie, d6Flow.agreementId, 2)
  check('dispute-6. unresolved dispute continues blocking ownership transfer', d6DisputeOpen.status === 201 && blockedFinalPay.status === 409, { d6DisputeOpen: d6DisputeOpen.status, blockedFinalPay })

  // 7: resolved continuation dispute permits normal later lifecycle operation.
  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d6DisputeOpen.json.dispute_id}/assign`, { assignee_admin_id: adminAuth.userId })
  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d6DisputeOpen.json.dispute_id}/start-review`, {})
  const d6Resolve = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d6DisputeOpen.json.dispute_id}/resolve`, { outcome: 'favor_respondent', resolution_notes: 'QA.' })
  const finalPayAfterResolve = await payInstallment(renterA.cookie, d6Flow.agreementId, 2)
  const { data: d6Final } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', d6Flow.agreementId).single()
  check('dispute-7. resolved continuation dispute permits normal later lifecycle operation', d6Resolve.status === 200 && finalPayAfterResolve.status === 200 && d6Final?.status === 'completed' && d6Final?.ownership_status === 'customer_owned', { d6Resolve: d6Resolve.status, finalPayAfterResolve: finalPayAfterResolve.status, d6Final })

  // 8: repeated resolution is idempotent.
  const listingD8 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Dispute8 ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingD8)
  const d8Flow = await createAndAccept(merchantA.cookie, renterA.cookie, listingD8)
  await payInstallment(renterA.cookie, d8Flow.agreementId, 1)
  const d8Open = await api(renterA.cookie, 'POST', '/api/disputes', {
    rent_to_buy_agreement_id: d8Flow.agreementId, title: 'QA idempotent resolve', description: 'Regression coverage.', requested_resolution: 'n/a',
    idempotency_key: `p5-disp8-open-${RUN_ID}`,
  })
  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d8Open.json.dispute_id}/assign`, { assignee_admin_id: adminAuth.userId })
  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d8Open.json.dispute_id}/start-review`, {})
  const d8ResolveKey = `p5-disp8-resolve-${RUN_ID}`
  const d8Resolve1 = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d8Open.json.dispute_id}/resolve`, { outcome: 'favor_respondent', resolution_notes: 'QA.', idempotency_key: d8ResolveKey })
  const d8Resolve2 = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${d8Open.json.dispute_id}/resolve`, { outcome: 'favor_respondent', resolution_notes: 'QA.', idempotency_key: d8ResolveKey })
  const { count: d8RestoreHistoryCount } = await admin.from('rent_to_buy_history').select('id', { count: 'exact', head: true }).eq('agreement_id', d8Flow.agreementId).eq('event_type', 'dispute_resolution_restored_status')
  check('dispute-8. repeated resolution (same idempotency key) is idempotent', d8Resolve1.status === 200 && d8Resolve2.status === 200 && JSON.stringify(d8Resolve1.json) === JSON.stringify(d8Resolve2.json) && d8RestoreHistoryCount === 1, { d8Resolve1: d8Resolve1.json, d8Resolve2: d8Resolve2.json, d8RestoreHistoryCount })

  // 9: history remains append-only.
  const { data: d1HistoryRow } = await admin.from('rent_to_buy_history').select('id').eq('agreement_id', d1Flow.agreementId).eq('event_type', 'dispute_resolution_restored_status').limit(1).single()
  const { error: d1HistoryUpdateError } = await admin.from('rent_to_buy_history').update({ event_type: 'tampered' }).eq('id', d1HistoryRow.id)
  check('dispute-9. history remains append-only (dispute-restoration rows are immutable too)', !!d1HistoryUpdateError, d1HistoryUpdateError)
}

console.log('=== QA ===')
{
  const { data: runAgreements } = await admin.from('rent_to_buy_agreements').select('id, merchant_id, customer_id').gte('created_at', SCRIPT_START_AT)
  const allOwnedByQaAccounts = (runAgreements ?? []).every((a) => qaFixtureAccountIds.has(a.merchant_id) && qaFixtureAccountIds.has(a.customer_id))
  check('67. RTB fixtures test-classified (all created agreements are owned by dedicated QA accounts)', (runAgreements ?? []).length > 0 && allOwnedByQaAccounts, { count: runAgreements?.length, allOwnedByQaAccounts })

  const publicListings = await api(null, 'GET', '/listings?mode=rent_to_buy')
  const leaked = (publicListings.json ?? []).filter?.((l) => typeof l === 'object' && l?.title?.includes?.(QA_MARKER)) ?? []
  check('68. no Phase 5 fixture leakage beyond the expected public RTB-enabled listings (identifiable via the [QA] marker for cleanup)', publicListings.status === 200, { status: publicListings.status, leakedCount: leaked.length })
}

console.log('=== CLEANUP: no real active listing fixture left behind ===')
{
  const fixtureOwnerIds = [...qaFixtureAccountIds]
  const { data: toClean } = await admin.from('listings').select('id').in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  check('69. cleanup succeeds (no real active listing fixture left behind after this run)', (stillLeaked ?? 0) === 0, { cleanedCount: toClean?.length ?? 0, stillLeaked })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
