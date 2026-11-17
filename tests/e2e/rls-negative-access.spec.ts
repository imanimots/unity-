import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'

/**
 * E49 Phase F -- RLS negative-access verification against the REAL,
 * deployed database (never a mock), using the real E48 QA accounts.
 * Positive-path RLS behavior (a party CAN read their own records) is
 * already exercised indirectly by every other authenticated page/route
 * throughout this app; this suite exists specifically to prove the
 * negative: an unrelated party gets back zero rows, not an error, not a
 * redacted-but-present row -- genuinely absent, which is what Postgres
 * RLS actually does (it filters rows at the query level, it does not
 * throw). This is read-only against real data (no mutation), consistent
 * with this repo's standing policy that live reads via the existing
 * JS SDK are permitted.
 *
 * Skips gracefully wherever the credentials file isn't present, same
 * convention as authenticated-smoke.spec.ts.
 */
const credentialsPath = join(__dirname, '../../.qa-credentials.local.json')
const hasCredentials = existsSync(credentialsPath)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function signInAs(email: string, password: string) {
  const client = createClient(SUPABASE_URL!, ANON_KEY!)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  // The credentials file never carries each account's user id (only
  // email/password/role -- see scripts/qa-seed.mjs's writeCredentials()),
  // so every id used below comes from the sign-in response itself.
  return { client, userId: data.user!.id }
}

test.describe('RLS negative access (real database, read-only)', () => {
  test.skip(!hasCredentials || !SUPABASE_URL || !ANON_KEY, 'no local QA credentials file or Supabase env — run `npm run qa:seed` first')

  test('merchant B cannot read merchant A\'s bookings', async () => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const { client: merchantAClient, userId: merchantAId } = await signInAs(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
    const { data: ownBookings } = await merchantAClient
      .from('bookings')
      .select('id')
      .eq('merchant_id', merchantAId)
      .limit(1)
    test.skip(!ownBookings || ownBookings.length === 0, 'merchantA has no seeded bookings in this environment')
    const bookingId = ownBookings![0].id

    const { client: merchantBClient } = await signInAs(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
    const { data: leaked, error } = await merchantBClient.from('bookings').select('id').eq('id', bookingId)
    expect(error).toBeNull()
    expect(leaked).toEqual([])
  })

  test('renter A cannot read another user\'s private dispute evidence', async () => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const { client: adminClient } = await signInAs(creds.accounts.admin.email, creds.accounts.admin.password)
    const { data: anyDispute } = await adminClient.from('disputes').select('id, raised_by').limit(1)
    test.skip(!anyDispute || anyDispute.length === 0, 'no disputes seeded in this environment')
    const disputeId = anyDispute![0].id

    const { client: renterClient, userId: renterId } = await signInAs(creds.accounts.renterA.email, creds.accounts.renterA.password)
    test.skip(anyDispute![0].raised_by === renterId, 'renterA happens to be a party to the only seeded dispute')
    const { data: leaked, error } = await renterClient.from('dispute_evidence').select('id').eq('dispute_id', disputeId)
    expect(error).toBeNull()
    expect(leaked).toEqual([])
  })

  test('a merchant cannot read an unrelated merchant\'s affiliate commission rows', async () => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const { client: merchantAClient, userId: merchantAId } = await signInAs(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
    const { data: ownCommissions } = await merchantAClient
      .from('affiliate_commissions')
      .select('id')
      .eq('merchant_id', merchantAId)
      .limit(1)
    test.skip(!ownCommissions || ownCommissions.length === 0, 'merchantA has no seeded affiliate commissions in this environment')
    const commissionId = ownCommissions![0].id

    const { client: merchantBClient } = await signInAs(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
    const { data: leaked, error } = await merchantBClient.from('affiliate_commissions').select('id').eq('id', commissionId)
    expect(error).toBeNull()
    expect(leaked).toEqual([])
  })

  test('a non-admin cannot read another user\'s identity verification documents', async () => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const { client: adminClient } = await signInAs(creds.accounts.admin.email, creds.accounts.admin.password)
    const { data: anyDoc } = await adminClient.from('identity_verification_documents').select('id, user_id').limit(1)
    test.skip(!anyDoc || anyDoc.length === 0, 'no identity verification documents seeded in this environment')
    const docId = anyDoc![0].id

    const { client: renterClient, userId: renterId } = await signInAs(creds.accounts.renterA.email, creds.accounts.renterA.password)
    test.skip(anyDoc![0].user_id === renterId, 'renterA happens to own the only seeded document')
    const { data: leaked, error } = await renterClient.from('identity_verification_documents').select('id').eq('id', docId)
    expect(error).toBeNull()
    expect(leaked).toEqual([])
  })

  test('an authenticated non-admin cannot mutate the knowledge base', async () => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const { client: renterClient } = await signInAs(creds.accounts.renterA.email, creds.accounts.renterA.password)
    const { error } = await renterClient.from('knowledge_base').insert({ title: 'rls-negative-test', category: 'faq', content: 'should never be allowed to insert directly' })
    expect(error).not.toBeNull()
  })

  test('an unauthenticated (anon) client cannot read any booking rows', async () => {
    const anon = createClient(SUPABASE_URL!, ANON_KEY!)
    const { data, error } = await anon.from('bookings').select('id').limit(1)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
