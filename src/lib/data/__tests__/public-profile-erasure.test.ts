import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

vi.mock('@/lib/subscriptions/entitlements', () => ({
  getMerchantEntitlements: vi.fn().mockResolvedValue({ eliteBadgeEnabled: false, businessNameEnabled: false }),
}))

let profileRow: Record<string, unknown> | null = null

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: profileRow, error: null }),
            }),
          }),
        }
      }
      // orders/bookings/barter_agreements/rent_to_buy_agreements count queries
      return {
        select: () => ({
          eq: () => ({
            or: async () => ({ count: 0, data: null, error: null }),
          }),
        }),
      }
    },
    rpc: () => ({
      maybeSingle: async () => ({ data: { review_count: 0, average_rating: null }, error: null }),
    }),
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => fakeSupabase(),
}))

const { getPublicProfile } = await import('../profiles')

beforeEach(() => {
  profileRow = null
})

describe('getPublicProfile account-status tombstone (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F1)', () => {
  it('1. an active profile is available', async () => {
    profileRow = {
      id: 'user-1',
      display_name: 'Ari',
      full_name: 'Ari Botha',
      business_name: null,
      avatar_url: null,
      role: 'renter',
      kyc_status: 'approved',
      unity_score: 4.5,
      account_status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    }
    const result = await getPublicProfile('user-1')
    expect(result.status).toBe('ok')
  })

  it('2. a suspended profile is unavailable', async () => {
    profileRow = { id: 'user-2', account_status: 'suspended', display_name: 'X', full_name: null, business_name: null, avatar_url: null, role: 'renter', kyc_status: 'none', unity_score: 5, created_at: '2026-01-01T00:00:00Z' }
    const result = await getPublicProfile('user-2')
    expect(result).toEqual({ status: 'unavailable' })
  })

  it('3. an erased profile is unavailable/tombstoned, same as suspended (P2 finding D)', async () => {
    profileRow = {
      id: 'user-3',
      account_status: 'erased',
      display_name: 'Deleted User',
      full_name: 'Deleted User',
      business_name: null,
      avatar_url: null,
      role: 'merchant',
      kyc_status: 'approved',
      unity_score: 4.2,
      created_at: '2025-01-01T00:00:00Z',
    }
    const result = await getPublicProfile('user-3')
    expect(result).toEqual({ status: 'unavailable' })
  })

  it('4. the unavailable result for an erased profile never surfaces any field at all -- no name, avatar, or any other data leaks through', async () => {
    profileRow = { id: 'user-4', account_status: 'erased', display_name: 'Deleted User', full_name: 'Deleted User', business_name: null, avatar_url: null, role: 'renter', kyc_status: 'none', unity_score: 5, created_at: '2026-01-01T00:00:00Z' }
    const result = await getPublicProfile('user-4')
    expect(Object.keys(result)).toEqual(['status'])
  })

  it('5. a missing row is not_found, independent of account_status', async () => {
    profileRow = null
    const result = await getPublicProfile('user-5')
    expect(result).toEqual({ status: 'not_found' })
  })
})
