import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalizationEntityType, PersonalizationKind, PersonalizationMode, PersonalizationViewRecord } from './types'

function isMissingRelationError(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST202' || !!error?.message?.includes('does not exist')
}

export interface RecordViewInput {
  entityType: PersonalizationEntityType
  entityId: string
  mode: PersonalizationMode | null
  category: string | null
  kind: PersonalizationKind | null
  province: string | null
  city: string | null
}

/** Records one meaningful view (Section 13). Fails silently (logged, not
 * thrown) on a missing-relation error -- see the dev-environment note in
 * preferences.ts. A view is never worth breaking the page over. */
export async function recordPersonalizationView(supabase: SupabaseClient, userId: string, input: RecordViewInput): Promise<void> {
  const { error } = await supabase.rpc('record_personalization_view', {
    p_user_id: userId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_mode: input.mode,
    p_category: input.category,
    p_kind: input.kind,
    p_province: input.province,
    p_city: input.city,
  })
  if (error && !isMissingRelationError(error)) {
    console.error('recordPersonalizationView failed', error.message)
  }
}

export async function getServerViews(supabase: SupabaseClient, userId: string): Promise<PersonalizationViewRecord[]> {
  const { data, error } = await supabase
    .from('user_personalization_views')
    .select('*')
    .eq('user_id', userId)
    .order('last_viewed_at', { ascending: false })
    .limit(200)

  if (error || !data) return []

  return data.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    mode: row.mode,
    category: row.category,
    kind: row.kind,
    province: row.province,
    city: row.city,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at,
  }))
}

export interface CompletedTransactionAffinity {
  categories: string[]
  modes: PersonalizationMode[]
}

interface JoinedListingCategoryRow {
  listing: { category: string | null; is_test: boolean } | null
}
interface JoinedAnchorListingCategoryRow {
  anchor_listing: { category: string | null; is_test: boolean } | null
}

/**
 * Reads genuine completion signal directly from the EXISTING,
 * authoritative tables (Section 18) -- no duplication, no new table.
 * Excludes is_test content and every non-terminal-success status
 * (Section 19). `resetCutoff` (personalization_reset_at) excludes
 * transactions created before the user's last reset, since there is no
 * stored copy of this signal to delete (Section 39).
 */
export async function getCompletedTransactionAffinity(
  supabase: SupabaseClient,
  userId: string,
  resetCutoff: string | null
): Promise<CompletedTransactionAffinity> {
  const categories = new Set<string>()
  const modes = new Set<PersonalizationMode>()

  // Sale orders -- delivered is the canonical terminal-success value.
  {
    const base = supabase
      .from('orders')
      .select('listing:listings!inner(category, is_test)')
      .eq('buyer_id', userId)
      .eq('status', 'delivered')
      .eq('listing.is_test', false)
    const { data } = await (resetCutoff ? base.gt('created_at', resetCutoff) : base)
    for (const row of (data ?? []) as unknown as JoinedListingCategoryRow[]) {
      if (row.listing?.category) categories.add(row.listing.category)
      modes.add('buy')
    }
  }

  // Rental bookings -- returned is the canonical terminal-success value.
  {
    const base = supabase
      .from('bookings')
      .select('listing:listings!inner(category, is_test)')
      .eq('renter_id', userId)
      .eq('status', 'returned')
      .eq('listing.is_test', false)
    const { data } = await (resetCutoff ? base.gt('created_at', resetCutoff) : base)
    for (const row of (data ?? []) as unknown as JoinedListingCategoryRow[]) {
      if (row.listing?.category) categories.add(row.listing.category)
      modes.add('rent')
    }
  }

  // Barter agreements -- 'completed' is the canonical terminal-success
  // value. Category context comes from the anchor listing (barter has
  // no is_test of its own, derived via the anchor listing's is_test).
  {
    const base = supabase
      .from('barter_agreements')
      .select('anchor_listing:listings!inner(category, is_test)')
      .or(`party_a_id.eq.${userId},party_b_id.eq.${userId}`)
      .eq('status', 'completed')
      .eq('anchor_listing.is_test', false)
    const { data } = await (resetCutoff ? base.gt('proposed_at', resetCutoff) : base)
    for (const row of (data ?? []) as unknown as JoinedAnchorListingCategoryRow[]) {
      if (row.anchor_listing?.category) categories.add(row.anchor_listing.category)
      modes.add('barter')
    }
  }

  // RTB agreements -- 'completed' is the canonical terminal-success
  // value; RTB has its own is_test column.
  {
    const base = supabase
      .from('rent_to_buy_agreements')
      .select('is_test, listing:listings!inner(category)')
      .eq('customer_id', userId)
      .eq('status', 'completed')
      .eq('is_test', false)
    const { data } = await (resetCutoff ? base.gt('created_at', resetCutoff) : base)
    for (const row of (data ?? []) as unknown as JoinedListingCategoryRow[]) {
      if (row.listing?.category) categories.add(row.listing.category)
      modes.add('rent')
    }
  }

  return { categories: [...categories], modes: [...modes] }
}
