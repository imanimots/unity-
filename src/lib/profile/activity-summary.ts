import type { SupabaseClient } from '@supabase/supabase-js'

export interface ActivitySummary {
  bookingsCount: number
  listingsCount: number
  tradesCount: number
}

/**
 * Real, read-only row counts for the Profile page's Activity tile --
 * never a rendered list (unlike the renter dashboard's own mock-data
 * booking list), so there is no business logic to get wrong here, only
 * three independent COUNT queries scoped to the caller's own rows.
 */
export async function getActivitySummary(
  supabase: SupabaseClient,
  userId: string
): Promise<ActivitySummary> {
  const [bookings, listings, trades] = await Promise.all([
    supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('renter_id', userId),
    supabase.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId),
    supabase
      .from('barter_agreements')
      .select('id', { count: 'exact', head: true })
      .or(`party_a_id.eq.${userId},party_b_id.eq.${userId}`),
  ])

  return {
    bookingsCount: bookings.count ?? 0,
    listingsCount: listings.count ?? 0,
    tradesCount: trades.count ?? 0,
  }
}
