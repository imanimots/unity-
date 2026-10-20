import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getBookingConditionEvidenceSignedUrl } from '../evidence-access'

/**
 * Mirrors the reasoning already applied to src/lib/disputes/evidence-access.ts
 * and src/lib/rent-to-buy/evidence-access.ts: authorization is entirely
 * delegated to the `asUser` client's own query (which in production is
 * gated by booking_condition_evidence's real RLS) -- this fake proves
 * the function's OWN logic (the (id, booking_id) compound match, the
 * admin-client-only signing step, the 120s-shaped result), not RLS
 * itself. That is explicitly out of scope for a unit test with no live
 * Postgres available.
 */
function fakeAsUser(row: { id: string; storage_path: string } | null): SupabaseClient {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  }))
  return { from } as unknown as SupabaseClient
}

function fakeAdmin(signed: { signedUrl: string } | null, error: unknown = null): SupabaseClient {
  const createSignedUrl = vi.fn(() => Promise.resolve({ data: signed, error }))
  return { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient
}

describe('getBookingConditionEvidenceSignedUrl (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  it('1. returns a signed URL for a visible row', async () => {
    const asUser = fakeAsUser({ id: 'ev-1', storage_path: 'booking-1/user-1/pre_handover-1.jpg' })
    const admin = fakeAdmin({ signedUrl: 'https://signed.example/x' })
    const result = await getBookingConditionEvidenceSignedUrl(asUser, admin, 'booking-1', 'ev-1')
    expect(result.url).toBe('https://signed.example/x')
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('2. throws evidence_not_found when the asUser-scoped read returns no row (RLS denial or genuinely missing, indistinguishable)', async () => {
    const asUser = fakeAsUser(null)
    const admin = fakeAdmin({ signedUrl: 'unused' })
    await expect(getBookingConditionEvidenceSignedUrl(asUser, admin, 'booking-1', 'ev-1')).rejects.toThrow('evidence_not_found')
  })

  it('3. throws could_not_sign_url if the admin client fails to sign', async () => {
    const asUser = fakeAsUser({ id: 'ev-1', storage_path: 'booking-1/user-1/pre_handover-1.jpg' })
    const admin = fakeAdmin(null, { message: 'signing failed' })
    await expect(getBookingConditionEvidenceSignedUrl(asUser, admin, 'booking-1', 'ev-1')).rejects.toThrow('could_not_sign_url')
  })

  it('4. never signs using the asUser client -- only the admin client is ever passed to storage.createSignedUrl', async () => {
    const row = { id: 'ev-1', storage_path: 'booking-1/user-1/pre_handover-1.jpg' }
    const asUser = fakeAsUser(row)
    const asUserStorageSpy = vi.fn()
    ;(asUser as unknown as { storage: unknown }).storage = { from: () => ({ createSignedUrl: asUserStorageSpy }) }
    const admin = fakeAdmin({ signedUrl: 'https://signed.example/x' })
    await getBookingConditionEvidenceSignedUrl(asUser, admin, 'booking-1', 'ev-1')
    expect(asUserStorageSpy).not.toHaveBeenCalled()
  })
})
