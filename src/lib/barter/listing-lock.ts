import { IS_MOCK_MODE } from '@/lib/mock/data'

/**
 * Reads the barter_locked_listings view (20260810000003_barter_schema.sql)
 * -- a listing is locked iff it's in the ACCEPTED offer's item list of a
 * non-terminal barter agreement. Mock mode has no barter data at all, so
 * nothing is ever locked there.
 */
export async function getBarterLockedListingIds(listingIds: string[]): Promise<Set<string>> {
  if (IS_MOCK_MODE || listingIds.length === 0) return new Set()

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return new Set()

  const { data } = await supabase.from('barter_locked_listings').select('listing_id').in('listing_id', listingIds)
  return new Set((data ?? []).map((row) => row.listing_id as string))
}

export async function isListingBarterLocked(listingId: string): Promise<boolean> {
  const locked = await getBarterLockedListingIds([listingId])
  return locked.has(listingId)
}

/** Every currently-locked listing id, unfiltered — used to exclude locked listings from the browse query (getListings()'s real-Supabase path). */
export async function getAllBarterLockedListingIds(): Promise<Set<string>> {
  if (IS_MOCK_MODE) return new Set()

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return new Set()

  const { data } = await supabase.from('barter_locked_listings').select('listing_id')
  return new Set((data ?? []).map((row) => row.listing_id as string))
}
