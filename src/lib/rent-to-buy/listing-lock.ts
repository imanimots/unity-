import { IS_MOCK_MODE } from '@/lib/mock/data'

/**
 * Reads the rent_to_buy_locked_listings view (20260828000001_rtb_inventory_
 * locking.sql) -- mirrors src/lib/barter/listing-lock.ts exactly. A listing
 * is locked once its RTB agreement is accepted (not merely requested) and
 * stays locked through completion or until the item is physically returned/
 * recovered. Mock mode has no RTB data at all, so nothing is ever locked
 * there.
 */
export async function isListingRentToBuyLocked(listingId: string): Promise<boolean> {
  if (IS_MOCK_MODE) return false

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return false

  const { data } = await supabase.from('rent_to_buy_locked_listings').select('listing_id').eq('listing_id', listingId).maybeSingle()
  return Boolean(data)
}
