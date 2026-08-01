import type { DeclarationType } from '@/types'

/**
 * Client-side mirror of `declaration_catalogue` (supabase/migrations/
 * 20260729000007_listing_creation_rpc.sql) — for displaying the exact
 * wording in the wizard's Review step before a merchant accepts it.
 *
 * The database is authoritative: `submit_listing_for_review()` resolves
 * version/hash from `declaration_catalogue` itself and ignores whatever
 * the client sends beyond "which types were checked." Keep this wording
 * in sync with the catalogue by hand — the same known-limitation pattern
 * already documented for src/lib/risk/engine.ts vs. its DB trigger.
 */
export const DECLARATION_CATALOGUE: { type: DeclarationType; version: string; wording: string }[] = [
  {
    type: 'ownership_authority',
    version: '1.0',
    wording: 'I confirm that I own this item or have legal authority to rent it out on Unity.',
  },
  {
    type: 'condition_accuracy',
    version: '1.0',
    wording: 'I confirm that the condition and defects described are accurate to the best of my knowledge.',
  },
  {
    type: 'image_accuracy',
    version: '1.0',
    wording: 'I confirm that the uploaded images represent the actual item being listed.',
  },
  {
    type: 'legal_and_safe_item',
    version: '1.0',
    wording: 'I confirm that this item is legal to rent and is safe and functional for its declared use.',
  },
  {
    type: 'platform_terms',
    version: '1.0',
    wording: "I agree to Unity's listing, rental, dispute, and damage rules.",
  },
  {
    type: 'off_platform_transaction_policy',
    version: '1.0',
    wording: 'I understand that transacting outside Unity where prohibited, or providing false information, may result in account suspension.',
  },
]
