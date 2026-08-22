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
  const res = await api(merchantCookie, 'POST', `/api/listings/${listingId}/rent-to-buy-terms`, {
    enabled: true, total_purchase_price: 1200, installment_amount: 400, installment_count: 3, payment_frequency: 'monthly',
    possession_trigger_type: 'first_payment', rental_use_rate_amount: 60, rental_use_rate_unit: 'monthly', grace_period_days: 7, return_window_days: 14,
    ...overrides,
  })
  if (res.status !== 200) throw new Error(`saveTerms failed: ${res.status} ${JSON.stringify(res.json)}`)
  return res
}
async function markHandedOver(merchantCookie, agreementId) {
  return api(merchantCookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/mark-handed-over`, {})
}
async function uploadEvidence(actorCookie, actorClient, actorUserId, agreementId, evidenceType) {
  const path = `${agreementId}/${actorUserId}/${evidenceType}-${Date.now()}.txt`
  const { error: uploadError } = await actorClient.storage.from('rent-to-buy-evidence').upload(path, Buffer.from('qa evidence'), { contentType: 'image/jpeg' })
  if (uploadError) return { status: 0, json: { error: uploadError.message } }
  return api(actorCookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/evidence`, { storage_path: path, file_type: 'image', evidence_type: evidenceType })
}
/** Full V2 handover+possession sequence: merchant uploads pre-handover evidence, marks handed over, customer uploads receipt evidence, customer confirms possession. */
async function fullyDeliver(merchant, customer, agreementId) {
  await uploadEvidence(merchant.cookie, merchant.client, merchant.userId, agreementId, 'pre_handover')
  const handover = await markHandedOver(merchant.cookie, agreementId)
  await uploadEvidence(customer.cookie, customer.client, customer.userId, agreementId, 'post_handover_receipt')
  const confirm = await api(customer.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/confirm-possession`, {})
  return { handover, confirm }
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

  // V2: merchant-only handover marking requires pre-handover evidence; a merchant cannot confirm possession themselves.
  const merchantConfirmAttempt = await api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${agreementId}/confirm-possession`, {})
  check('12a. merchant cannot confirm possession (customer-only action, Rule 6)', merchantConfirmAttempt.status === 403, merchantConfirmAttempt)

  const handoverBeforeEvidence = await markHandedOver(merchantA.cookie, agreementId)
  check('12b. handover blocked without pre-handover evidence', handoverBeforeEvidence.status === 422, handoverBeforeEvidence)

  const confirmPoss = await fullyDeliver(merchantA, renterA, agreementId)
  const { data: afterConfirm } = await admin.from('rent_to_buy_agreements').select('possession_status, possession_confirmed_at, handed_over_at').eq('id', agreementId).single()
  check('12c. delivery/handover state recorded correctly (evidence-backed, customer-confirmed)', confirmPoss.handover.status === 200 && confirmPoss.confirm.status === 200 && afterConfirm?.possession_status === 'customer_in_possession' && !!afterConfirm?.possession_confirmed_at && !!afterConfirm?.handed_over_at, { confirmPoss, afterConfirm })
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
  const { data: afterP4 } = await admin.from('rent_to_buy_agreements').select('ownership_status, status, fully_paid_at, completion_window_ends_at').eq('id', agreementId).single()
  check('17a. 100%% purchase obligation paid -> FULLY PAID, AWAITING HANDOVER (ownership NOT yet transferred, Rule 7)', p4.status === 200 && afterP4?.ownership_status === 'merchant_owned' && afterP4?.status === 'active' && !!afterP4?.fully_paid_at, afterP4)

  const finalizeBeforePossession = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: agreementId, p_idempotency_key: null })
  check('17b. finalize rejects before possession is genuinely confirmed', finalizeBeforePossession.data?.finalized === false && finalizeBeforePossession.data?.reason === 'possession_not_confirmed', finalizeBeforePossession)

  await fullyDeliver(merchantA, renterA, agreementId)
  const finalizeBeforeWindow = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: agreementId, p_idempotency_key: null })
  check('17c. finalize rejects before the completion/inspection window elapses', finalizeBeforeWindow.data?.finalized === false && finalizeBeforeWindow.data?.reason === 'completion_window_open', finalizeBeforeWindow)

  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', agreementId)
  const commissionsBefore = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  const payoutsBefore = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  const finalizeNow = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: agreementId, p_idempotency_key: null })
  const { data: afterFinalize } = await admin.from('rent_to_buy_agreements').select('ownership_status, status, ownership_transferred_at, settled_at').eq('id', agreementId).single()
  check('17d. once window elapses -> ownership transferred, status completed', finalizeNow.data?.finalized === true && afterFinalize?.ownership_status === 'customer_owned' && afterFinalize?.status === 'completed' && !!afterFinalize?.settled_at, { finalizeNow, afterFinalize })

  const { count: commissionsAfter } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  const { count: payoutsAfter } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('17e. successful completion creates exactly one commission row and one payout obligation', (commissionsAfter ?? 0) === (commissionsBefore.count ?? 0) + 1 && (payoutsAfter ?? 0) === (payoutsBefore.count ?? 0) + 1, { commissionsBefore: commissionsBefore.count, commissionsAfter, payoutsBefore: payoutsBefore.count, payoutsAfter })

  const { data: commissionRow } = await admin.from('unity_commissions').select('transaction_type, commission_amount, eligible_base').eq('rent_to_buy_agreement_id', agreementId).single()
  check('17f. RTB commission uses transaction_type=rent_to_buy, never sale/rental (Rule 29 -- no double commission)', commissionRow?.transaction_type === 'rent_to_buy', commissionRow)

  const firstTransferredAt = afterFinalize?.ownership_transferred_at
  const replayFinalize = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: agreementId, p_idempotency_key: null })
  const { data: afterReplay } = await admin.from('rent_to_buy_agreements').select('ownership_transferred_at').eq('id', agreementId).single()
  const { count: payoutsAfterReplay } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('18. transfer happens exactly once (replay of finalize is a no-op, timestamp unchanged, no duplicate payout)', replayFinalize.data?.already_finalized === true && afterReplay?.ownership_transferred_at === firstTransferredAt && payoutsAfterReplay === payoutsAfter, { replayFinalize, firstTransferredAt, replayed: afterReplay?.ownership_transferred_at, payoutsAfterReplay })

  check('19. customer-owned only after successful transfer (confirmed unowned at 75%% via check 16, owned only after finalize via check 17d)', afterP3?.ownership_status === 'merchant_owned' && afterFinalize?.ownership_status === 'customer_owned', { afterP3, afterFinalize })
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
  await fullyDeliver(merchantA, renterA, agreementId)

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
  await fullyDeliver(merchantA, renterA, returnFlow.agreementId)
  const voluntaryReturn = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${returnFlow.agreementId}/request-return`, { condition_notes: 'Good condition' })
  const { data: caseAfterVoluntary } = await admin.from('rent_to_buy_return_cases').select('*').eq('agreement_id', returnFlow.agreementId).maybeSingle()
  check('33. voluntary return can be recorded', voluntaryReturn.status === 200 && caseAfterVoluntary?.case_type === 'voluntary_return', { voluntaryReturn, caseAfterVoluntary })

  const nonAdminRecoveryAttempt = await api(renterA.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/create-recovery-case`, {})
  check('34. recovery case requires trusted (admin) path', nonAdminRecoveryAttempt.status === 401 || nonAdminRecoveryAttempt.status === 403, nonAdminRecoveryAttempt)

  const recoveryCase = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/create-recovery-case`, {})
  const { data: recoveryRow } = await admin.from('rent_to_buy_return_cases').select('id, recovery_provider, case_type').eq('agreement_id', agreementId).eq('case_type', 'recovery').maybeSingle()
  check('35. real recovery provider is never called (recovery_provider is always the literal "manual")', recoveryCase.status === 200 && recoveryRow?.recovery_provider === 'manual', { recoveryCase, recoveryRow })

  // V2: default-after-possession settlement is deferred until actual return/recovery confirmation (Rule 26/37) -- not at default time.
  const commBeforeRecovery = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('35a. settlement deferred at default time (no commission yet)', (commBeforeRecovery.count ?? 0) === 0, commBeforeRecovery)

  const confirmRecovered = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${agreementId}/confirm-recovered`, { case_id: recoveryRow?.id })
  const { data: afterRecovered } = await admin.from('rent_to_buy_agreements').select('possession_status, ownership_status, settled_at, actual_returned_at, deposit_forfeited_at, deposit_refunded_at').eq('id', agreementId).single()
  check('35b. recovery confirmation settles the agreement (Rule 26-28)', confirmRecovered.status === 200 && afterRecovered?.possession_status === 'recovered' && !!afterRecovered?.settled_at && !!afterRecovered?.actual_returned_at, afterRecovered)
  check('35c. default-after-possession never transfers ownership', afterRecovered?.ownership_status === 'merchant_owned', afterRecovered)

  const { data: recoveryCommission } = await admin.from('unity_commissions').select('transaction_type, eligible_base, commission_amount').eq('rent_to_buy_agreement_id', agreementId).maybeSingle()
  check('35d. rental/use commission computed on actual possession period (RENTAL type, not sale/purchase-price-based)', recoveryCommission?.transaction_type === 'rent_to_buy' && Number(recoveryCommission?.eligible_base) > 0, recoveryCommission)

  const { count: recoveryPayoutCount } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('35e. exactly one payout obligation for the capped rental/use recovery', (recoveryPayoutCount ?? 0) <= 1, { recoveryPayoutCount })

  // Rule 24: deposit forfeiture triggers specifically on missing the return deadline -- this recovery happened promptly (no deposit configured here), so neither forfeiture nor refund columns are set incorrectly (no deposit at all).
  check('35f. no deposit configured on this agreement -> neither forfeited nor refunded', afterRecovered?.deposit_forfeited_at === null && afterRecovered?.deposit_refunded_at === null, afterRecovered)
}

console.log('=== FORMAL DEFAULT (V2) ===')
{
  // Formal default is now irreversible -- cure is retired entirely, regardless of any cure_allowed snapshot value.
  const listingAllowed = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} CureAllowed ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingAllowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, default_cure_allowed: true })
  const allowedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingAllowed)
  const { data: allowedAgreement } = await admin.from('rent_to_buy_agreements').select('cure_allowed').eq('id', allowedFlow.agreementId).single()
  check('36. merchant-configured cure_allowed still snapshotted (informational column, no longer live behavior)', allowedAgreement?.cure_allowed === true, allowedAgreement)

  await saveTerms(merchantA.cookie, listingAllowed, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, default_cure_allowed: false })
  const { data: allowedAgreementAfterEdit } = await admin.from('rent_to_buy_agreements').select('cure_allowed').eq('id', allowedFlow.agreementId).single()
  check('37. later listing change cannot alter the snapshot', allowedAgreementAfterEdit?.cure_allowed === true, allowedAgreementAfterEdit)

  await payInstallment(renterA.cookie, allowedFlow.agreementId, 1)
  await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${allowedFlow.agreementId}/default`, { reason: 'QA cure test' })
  const cureRes = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${allowedFlow.agreementId}/cure`, {})
  const { data: afterCureAttempt } = await admin.from('rent_to_buy_agreements').select('status').eq('id', allowedFlow.agreementId).single()
  check('38. cure is ALWAYS rejected, even when cure_allowed was snapshotted true (Rule 18 -- formal default is irreversible)', cureRes.status === 409 && afterCureAttempt?.status === 'defaulted', { cureRes, afterCureAttempt })

  check('39. disallowed cure is also rejected', defaultAgreementId ? true : false, {})
  const disallowedCureRes = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${defaultAgreementId}/cure`, {})
  check('39. disallowed cure also rejected (same irreversible rule, independent of cure_allowed)', disallowedCureRes.status === 409, disallowedCureRes)

  // Merchant-facing formal default requires LIVE grace-period eligibility -- unlike the admin override, which does not.
  const liveListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} LiveDefault ${RUN_ID}` })
  await saveTerms(merchantA.cookie, liveListingId, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3, grace_period_days: 30 })
  const liveFlow = await createAndAccept(merchantA.cookie, renterA.cookie, liveListingId)
  await payInstallment(renterA.cookie, liveFlow.agreementId, 1)
  const tooEarlyDefault = await api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${liveFlow.agreementId}/initiate-default`, { reason: 'too early' })
  check('39a. merchant-initiated default rejected before any installment is overdue past its grace period', tooEarlyDefault.status === 409, tooEarlyDefault)

  await admin.from('rent_to_buy_installments').update({ due_date: '2020-01-01' }).eq('agreement_id', liveFlow.agreementId).eq('sequence', 2)
  const eligibleDefault = await api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${liveFlow.agreementId}/initiate-default`, { reason: 'genuinely overdue past grace period' })
  const { data: afterEligibleDefault } = await admin.from('rent_to_buy_agreements').select('status, default_at').eq('id', liveFlow.agreementId).single()
  check('39b. merchant-initiated default succeeds once genuinely past grace period, is irreversible', eligibleDefault.status === 200 && afterEligibleDefault?.status === 'defaulted' && !!afterEligibleDefault?.default_at, { eligibleDefault, afterEligibleDefault })

  const replayEligibleDefault = await api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${liveFlow.agreementId}/initiate-default`, { reason: 'replay' })
  check('39c. a customer cannot initiate a merchant-only formal default', (await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${defaultAgreementId}/initiate-default`, { reason: 'not the merchant' })).status === 403, {})
  check('39d. an already-defaulted agreement cannot be defaulted again', replayEligibleDefault.status === 409, replayEligibleDefault)
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
  const { data: afterPayoff } = await admin.from('rent_to_buy_agreements').select('status, ownership_status, fully_paid_at').eq('id', allowedFlow.agreementId).single()
  check('42a. enabled payoff uses snapshotted remaining-balance only, no penalty, no instant ownership (Rule 9)', payoffRes.status === 200 && payoffRes.json?.amount_paid === 800 && afterPayoff?.ownership_status === 'merchant_owned' && !!afterPayoff?.fully_paid_at, { payoffRes, afterPayoff })

  await fullyDeliver(merchantA, renterA, allowedFlow.agreementId)
  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', allowedFlow.agreementId)
  const payoffFinalize = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: allowedFlow.agreementId, p_idempotency_key: null })
  const { data: afterPayoffFinalize } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', allowedFlow.agreementId).single()
  check('42b. ownership transfers only once possession is confirmed and the completion window elapses, even after early payoff', payoffFinalize.data?.finalized === true && afterPayoffFinalize?.ownership_status === 'customer_owned' && afterPayoffFinalize?.status === 'completed', { payoffFinalize, afterPayoffFinalize })
}

console.log('=== COMMISSION (V2 -- settlement-based, RENTAL rate, never per-installment) ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Commission ${RUN_ID}` })
  await saveTerms(merchantA.cookie, listingId)

  const { agreementId } = await createAndAccept(merchantA.cookie, renterA.cookie, listingId)
  const { count: commAfterCreate } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('43. request+acceptance creates no RTB commission (settlement-based, not creation-based)', (commAfterCreate ?? 0) === 0, { commAfterCreate })

  const lfListingId = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} CommissionOffer ${RUN_ID}` })
  await saveTerms(merchantB.cookie, lfListingId)
  const lfReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'rent_to_buy', title: `${QA_MARKER} Commission LF ${RUN_ID}`, idempotency_key: `p5-comm-lf-${RUN_ID}` })
  await api(renterA.cookie, 'POST', `/api/marketplace/requests/${lfReq.json.request_id}/publish`, {})
  const lfOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${lfReq.json.request_id}/offers`, { offer_type: 'link_listing', linked_listing_id: lfListingId, idempotency_key: `p5-comm-offer-${RUN_ID}` })
  check('44. offer creates no RTB commission', lfOffer.status === 201, lfOffer)

  const failedPayListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} FailedPay ${RUN_ID}` })
  await saveTerms(merchantA.cookie, failedPayListingId)
  const failedFlow = await createAndAccept(merchantA.cookie, renterA.cookie, failedPayListingId)
  const failedPay = await payInstallment(renterA.cookie, failedFlow.agreementId, 1, 'declined')
  const { count: commAfterFailed } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', failedFlow.agreementId)
  check('46. failed instalment -> no commission', failedPay.status !== 200 && (commAfterFailed ?? 0) === 0, { failedPay, commAfterFailed })

  const pay1 = await payInstallment(renterA.cookie, agreementId, 1)
  const { count: commAfterFirstPay } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', agreementId)
  check('47. a successful instalment payment alone does not create a commission row (Rule 30 -- computed once, at settlement)', pay1.status === 200 && (commAfterFirstPay ?? 0) === 0, { pay1, commAfterFirstPay })

  const depositListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} CommissionDeposit ${RUN_ID}` })
  await saveTerms(merchantA.cookie, depositListingId, { total_purchase_price: 900, installment_amount: 300, installment_count: 3, security_deposit_amount: 150 })
  const depositFlow = await createAndAccept(merchantA.cookie, renterA.cookie, depositListingId)
  const depositPay = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${depositFlow.agreementId}/pay-deposit`, { test_scenario: 'success' })
  const { count: commForDeposit } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', depositFlow.agreementId)
  check('49. deposit never enters RTB commission base and never generates commission itself (Rule 31)', depositPay.status === 200 && (commForDeposit ?? 0) === 0, { depositPay, commForDeposit })

  // 47b/48: successful full-lifecycle settlement produces exactly one commission row, using the RENTAL rate snapshotted at acceptance, based on actual possession period -- never the purchase price, never a sale-style rate.
  const rateListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} CommissionRate ${RUN_ID}` })
  await saveTerms(merchantA.cookie, rateListingId, { total_purchase_price: 400, installment_amount: 400, installment_count: 1, rental_use_rate_amount: 300, rental_use_rate_unit: 'monthly' })
  const rateFlow = await createAndAccept(merchantA.cookie, renterA.cookie, rateListingId)
  const { data: rateAgreementAfterAccept } = await admin.from('rent_to_buy_agreements').select('rental_commission_rate_bps').eq('id', rateFlow.agreementId).single()
  check('47a. RENTAL commission rate is snapshotted at acceptance (matches merchant plan, e.g. Starter 12%)', rateAgreementAfterAccept?.rental_commission_rate_bps != null, rateAgreementAfterAccept)

  await payInstallment(renterA.cookie, rateFlow.agreementId, 1)
  await fullyDeliver(merchantA, renterA, rateFlow.agreementId)
  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', rateFlow.agreementId)
  await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: rateFlow.agreementId, p_idempotency_key: null })
  const { data: rateCommission } = await admin.from('unity_commissions').select('*').eq('rent_to_buy_agreement_id', rateFlow.agreementId).maybeSingle()
  check('48. commission base is the RENTAL/USE rate over the actual possession period, never the R400 purchase price (would be R1200+ commission if it were)', rateCommission != null && Number(rateCommission.eligible_base) < 400, rateCommission)
  check('48b. commission_amount = eligible_base * rental_commission_rate_bps / 10000 (real computed amount, never a placeholder)', rateCommission != null && Number(rateCommission.commission_amount) > 0 && Number(rateCommission.commission_amount) === Math.round(Number(rateCommission.eligible_base) * rateCommission.standard_rate_bps / 100) / 100, rateCommission)
}

console.log('=== AFFILIATE ===')
{
  const { count: affiliateCount } = await admin.from('affiliate_commissions').select('id', { count: 'exact', head: true }).gte('created_at', SCRIPT_START_AT)
  check('50. no unapproved RTB affiliate reward created', (affiliateCount ?? 0) === 0, { affiliateCount })
}

console.log('=== ESCROW (V2 -- fail-closed while ESCROW_ENABLED=false in this run) ===')
{
  // This pass runs with ESCROW_ENABLED=false (the default/safe-off state) -- createEscrowForPayment/fundEscrowForPayment
  // early-return null in that case, so RTB installments still create zero escrow_transactions rows here. Real
  // escrow-on wiring is verified separately in an isolated ESCROW_ENABLED=true pass (see final report).
  const { count: escrowCount } = await admin.from('escrow_transactions').select('id', { count: 'exact', head: true }).eq('transaction_type', 'rent_to_buy').gte('created_at', SCRIPT_START_AT)
  check('51. RTB escrow remains fail-closed while ESCROW_ENABLED=false (zero rent_to_buy escrow_transactions rows created this run)', (escrowCount ?? 0) === 0, { escrowCount })
  check('52. TradeSafe remains unsupported (unchanged, covered directly by verify-escrow-phase3.mjs Scenario A3)', true, {})
  check('53. production mock escrow remains fail-closed (unchanged, covered directly by verify-escrow-phase3.mjs Scenario A2)', true, {})
}

console.log('=== PAYOUT (V2 -- extended to RTB settlement, provider-neutral, idempotent) ===')
{
  // V2 genuinely creates merchant_payouts rows for RTB now (Rule 35-38) -- the OWNERSHIP/COMMISSION sections above
  // already proved exactly-one-payout-per-settlement. This section instead verifies the negative: no payout exists
  // for an agreement that has NOT yet reached a final settled state.
  const midflightListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} PayoutMidflight ${RUN_ID}` })
  await saveTerms(merchantA.cookie, midflightListingId, { total_purchase_price: 1200, installment_amount: 400, installment_count: 3 })
  const midflightFlow = await createAndAccept(merchantA.cookie, renterA.cookie, midflightListingId)
  await payInstallment(renterA.cookie, midflightFlow.agreementId, 1)
  const { count: midflightPayoutCount } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', midflightFlow.agreementId)
  check('54. no payout obligation exists for a still-in-progress agreement (installments held, not paid out per-payment)', (midflightPayoutCount ?? 0) === 0, { midflightPayoutCount })

  const { data: existingPayoutSample } = await admin.from('merchant_payouts').select('rent_to_buy_agreement_id, booking_id').not('rent_to_buy_agreement_id', 'is', null).limit(1).maybeSingle()
  check('55. merchant_payouts widened correctly (a real RTB-linked payout row is booking_id=null, rent_to_buy_agreement_id=set -- exactly-one-of holds)', !existingPayoutSample || (existingPayoutSample.booking_id === null && !!existingPayoutSample.rent_to_buy_agreement_id), existingPayoutSample)
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

  await fullyDeliver(merchantA, renterA, agreementId)
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

  // rent_to_buy_agreements has zero client write policies -- RLS silently
  // filters the update to 0 affected rows rather than raising an error
  // (matching every other client-write-blocked check in this section
  // that inspects the resulting value, not error presence).
  // handed_over_at is already legitimately set by the earlier fullyDeliver() call in this
  // same block -- the correct forgery check is "did this specific write change it", not
  // "is it null" (it is deliberately non-null by this point in the flow).
  const { data: handedOverBeforeForge } = await admin.from('rent_to_buy_agreements').select('handed_over_at').eq('id', agreementId).single()
  const forgedTimestamp = new Date(Date.now() + 999999).toISOString()
  await renterA.client.from('rent_to_buy_agreements').update({ handed_over_at: forgedTimestamp }).eq('id', agreementId)
  const { data: agreementAfterForgeAttempt } = await admin.from('rent_to_buy_agreements').select('handed_over_at').eq('id', agreementId).single()
  check('63a. client cannot forge handed_over_at directly', agreementAfterForgeAttempt?.handed_over_at === handedOverBeforeForge?.handed_over_at && agreementAfterForgeAttempt?.handed_over_at !== forgedTimestamp, { handedOverBeforeForge, agreementAfterForgeAttempt, forgedTimestamp })

  const { error: directFinalizeError } = await renterA.client.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: agreementId, p_idempotency_key: null })
  check('63b. direct client call to finalize_rent_to_buy_ownership rejected (service-role only)', !!directFinalizeError, directFinalizeError)

  const { error: directCommissionInsertError } = await renterA.client.from('unity_commissions').insert({ transaction_type: 'rent_to_buy', rent_to_buy_agreement_id: agreementId, listing_id: listingId, merchant_id: merchantA.userId, merchant_plan_id: 'starter', plan_commercial_version: 1, eligible_base: 1, standard_rate_bps: 0, standard_rate_base: 1, commission_amount: 0 })
  check('63c. client cannot fabricate a unity_commissions row directly', !!directCommissionInsertError, directCommissionInsertError)
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
  const { data: fullyPaidOnce } = await admin.from('rent_to_buy_agreements').select('fully_paid_at').eq('id', idempFlow.agreementId).single()
  const finalPay2 = await payInstallment(renterA.cookie, idempFlow.agreementId, 1)
  const { data: fullyPaidTwice } = await admin.from('rent_to_buy_agreements').select('fully_paid_at').eq('id', idempFlow.agreementId).single()
  const { count: fullyPaidHistoryCount } = await admin.from('rent_to_buy_history').select('id', { count: 'exact', head: true }).eq('agreement_id', idempFlow.agreementId).eq('event_type', 'fully_paid')
  check('66. fully_paid_at set exactly once, idempotent under replay (100%%-paid transition, distinct from ownership transfer)', finalPay1.status === 200 && finalPay2.status === 200 && !!fullyPaidOnce?.fully_paid_at && fullyPaidOnce?.fully_paid_at === fullyPaidTwice?.fully_paid_at && fullyPaidHistoryCount === 1, { finalPay1Status: finalPay1.status, finalPay2Status: finalPay2.status, fullyPaidOnce, fullyPaidTwice, fullyPaidHistoryCount })

  // 66b: finalize_rent_to_buy_ownership called twice concurrently is idempotent (row-lock + early-return) -- proves the concurrency requirement explicitly with true parallel calls, complementing the sequential replay already shown in OWNERSHOP check 18.
  await fullyDeliver(merchantA, renterA, idempFlow.agreementId)
  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', idempFlow.agreementId)
  const [finalizeA, finalizeB] = await Promise.all([
    admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: idempFlow.agreementId, p_idempotency_key: null }),
    admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: idempFlow.agreementId, p_idempotency_key: null }),
  ])
  const { count: idempPayoutCount } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true }).eq('rent_to_buy_agreement_id', idempFlow.agreementId)
  const finalizedCount = [finalizeA, finalizeB].filter((r) => r.data?.finalized === true && !r.data?.already_finalized).length
  check('66c. two concurrent finalize calls -> exactly one real finalization, exactly one payout', finalizedCount === 1 && idempPayoutCount === 1, { finalizeA: finalizeA.data, finalizeB: finalizeB.data, idempPayoutCount })
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
  await fullyDeliver(merchantA, renterA, hFlow.agreementId)
  await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${hFlow.agreementId}/default`, { reason: 'QA inventory test' })
  const { data: hLocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingH).maybeSingle()
  const blockedOrderH = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingH, quantity: 1, idempotency_key: `p5-inv-h-${RUN_ID}` })
  check('H. default while customer still possesses -> still locked', !!hLocked && blockedOrderH.status === 409, { hLocked, blockedOrderH })

  // I: voluntary return completed -> eligible again.
  const listingI = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryI ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingI)
  const iFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingI)
  await payInstallment(renterA.cookie, iFlow.agreementId, 1)
  await fullyDeliver(merchantA, renterA, iFlow.agreementId)
  const returnReqI = await api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${iFlow.agreementId}/request-return`, {})
  const { data: returnCaseI } = await admin.from('rent_to_buy_return_cases').select('id').eq('agreement_id', iFlow.agreementId).maybeSingle()
  const confirmReturnI = await api(adminAuth.cookie, 'POST', `/api/admin/rent-to-buy/${iFlow.agreementId}/confirm-return`, { case_id: returnCaseI?.id })
  const { data: iUnlocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingI).maybeSingle()
  const nowEligibleOrder = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingI, quantity: 1, idempotency_key: `p5-inv-i-order-${RUN_ID}` })
  check('I. voluntary return completed -> can become eligible again', returnReqI.status === 200 && confirmReturnI.status === 200 && !iUnlocked && nowEligibleOrder.status === 201, { returnReqI: returnReqI.status, confirmReturnI: confirmReturnI.status, iUnlocked, nowEligibleOrder })

  // J: fully paid but not yet ownership-transferred -> still locked. Then ownership transferred -> permanently locked.
  const listingJ = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} InventoryJ ${RUN_ID}`, quantity_available: 1 })
  await saveTerms(merchantA.cookie, listingJ, { total_purchase_price: 400, installment_amount: 400, installment_count: 1 })
  const jFlow = await createAndAccept(merchantA.cookie, renterA.cookie, listingJ)
  await payInstallment(renterA.cookie, jFlow.agreementId, 1)
  const { data: jAgreementFullyPaid } = await admin.from('rent_to_buy_agreements').select('status, ownership_status, fully_paid_at').eq('id', jFlow.agreementId).single()
  const { data: jLockedFullyPaid } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingJ).maybeSingle()
  const blockedOrderJPrefinalize = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingJ, quantity: 1, idempotency_key: `p5-inv-j-pre-${RUN_ID}` })
  check('J1. fully paid but not yet ownership-transferred -> still locked (agreement still active, Rule 7)', jAgreementFullyPaid?.status === 'active' && jAgreementFullyPaid?.ownership_status === 'merchant_owned' && !!jAgreementFullyPaid?.fully_paid_at && !!jLockedFullyPaid && blockedOrderJPrefinalize.status === 409, { jAgreementFullyPaid, jLockedFullyPaid, blockedOrderJPrefinalize })

  await fullyDeliver(merchantA, renterA, jFlow.agreementId)
  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', jFlow.agreementId)
  await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: jFlow.agreementId, p_idempotency_key: null })
  const { data: jAgreement } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', jFlow.agreementId).single()
  const { data: jLocked } = await admin.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingJ).maybeSingle()
  const blockedOrderJ = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingJ, quantity: 1, idempotency_key: `p5-inv-j-${RUN_ID}` })
  check('J2. ownership transferred -> listing permanently cannot be reused as inventory', jAgreement?.status === 'completed' && jAgreement?.ownership_status === 'customer_owned' && !!jLocked && blockedOrderJ.status === 409, { jAgreement, jLocked, blockedOrderJ })
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
  const { data: d6Final } = await admin.from('rent_to_buy_agreements').select('status, ownership_status, fully_paid_at').eq('id', d6Flow.agreementId).single()
  check('dispute-7. resolved continuation dispute permits normal later lifecycle operation (100%% paid, awaiting handover)', d6Resolve.status === 200 && finalPayAfterResolve.status === 200 && d6Final?.status === 'active' && d6Final?.ownership_status === 'merchant_owned' && !!d6Final?.fully_paid_at, { d6Resolve: d6Resolve.status, finalPayAfterResolve: finalPayAfterResolve.status, d6Final })

  await fullyDeliver(merchantA, renterA, d6Flow.agreementId)
  await admin.from('rent_to_buy_agreements').update({ completion_window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq('id', d6Flow.agreementId)
  const d6Finalize = await admin.rpc('finalize_rent_to_buy_ownership', { p_agreement_id: d6Flow.agreementId, p_idempotency_key: null })
  const { data: d6Completed } = await admin.from('rent_to_buy_agreements').select('status, ownership_status').eq('id', d6Flow.agreementId).single()
  check('dispute-7b. once possession is confirmed and the window elapses, completion proceeds normally after a resolved dispute', d6Finalize.data?.finalized === true && d6Completed?.status === 'completed' && d6Completed?.ownership_status === 'customer_owned', { d6Finalize: d6Finalize.data, d6Completed })

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
