import { createHash } from 'crypto'

/**
 * Mirrors submit_listing_for_review()'s request_hash formula exactly
 * (supabase/migrations/20260730000002_restrict_submit_to_server.sql):
 * md5(listing_id || '|' || declaration_types::text), where Postgres casts
 * an array to text as `{elem1,elem2,...}` in the array's own order. This
 * lets the API route recognize a genuine retry — same listing, same
 * declarations — before calling the RPC, without re-deriving completeness
 * or duplicating any business rule. Must stay byte-for-byte in sync with
 * the SQL formula; a change on either side breaks replay detection.
 *
 * Declaration order matters here, exactly as it does in the SQL cast — a
 * retry must send declarations in the same order as the original request.
 * The wizard always does, since it builds the array from a fixed constant
 * (DECLARATION_TYPES in validation.ts), not from user-controlled ordering.
 */
export function computeSubmitRequestHash(listingId: string, declarationTypes: readonly string[]): string {
  const pgArrayText = `{${declarationTypes.join(',')}}`
  return createHash('md5').update(`${listingId}|${pgArrayText}`).digest('hex')
}
