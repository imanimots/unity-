import type { Profile } from '@/types'

/**
 * Canonical real/test/unknown data-scope contract for all current and
 * future Admin query code (D3-B onward). Authoritative source: D3-A/F1
 * (supabase/migrations/20261028083649_profiles_data_classification.sql),
 * which establishes profiles.data_classification as the three-state
 * model this module filters by. Server-side only -- nothing here is
 * safe or meaningful to import into a 'use client' component (callers
 * already follow this codebase's existing convention of importing only
 * `import type` from src/lib/admin/* when a client component needs a
 * type, e.g. src/app/admin/analytics/page.tsx).
 *
 * 'all' is a real, usable value -- but only ever by a caller's
 * explicit choice (see resolveAdminDataScope). It must never become
 * the implicit behavior when a scope is missing, invalid, or omitted.
 */
export type AdminDataScope = 'real' | 'test' | 'unknown' | 'all'

/** The three concrete states a profile (or profile-owned record) can resolve to. 'all' is a query-scope concept, not a classification value, so it is deliberately excluded here. */
export type ProfileDataClassification = Exclude<AdminDataScope, 'all'>

const VALID_SCOPES: readonly string[] = ['real', 'test', 'unknown', 'all']

export function isValidAdminDataScope(value: unknown): value is AdminDataScope {
  return typeof value === 'string' && VALID_SCOPES.includes(value)
}

/**
 * Resolves caller-supplied input (e.g. a query-string param) to a safe
 * AdminDataScope. Missing or invalid input NEVER resolves to 'all' --
 * the safe default is 'real', the same positive, non-guessing posture
 * as the D3-A migration itself (unresolved/unknown data is never
 * surfaced as real, and here it is also never surfaced by default at
 * all). A caller that genuinely wants every row, including unresolved
 * legacy data, must pass the literal string 'all' itself.
 */
export function resolveAdminDataScope(value: unknown): AdminDataScope {
  return isValidAdminDataScope(value) ? value : 'real'
}

/**
 * The profiles.data_classification value to filter by for a query
 * anchored directly on `profiles` (or any table filtered purely by its
 * own owning profile). Returns null for 'all', meaning "apply no
 * filter" -- never an implicit default, only ever reached when a
 * caller passed 'all' explicitly. Always a positive equality value for
 * the caller to use (e.g. `query.eq('data_classification', v)`),
 * never a negative/`<>` comparison -- the exact anti-pattern the D3-A
 * migration's own contract forbids, because `<> 'test'` would silently
 * include 'unknown' rows as if they were confirmed real.
 */
export function profileScopeFilterValue(scope: AdminDataScope): ProfileDataClassification | null {
  return scope === 'all' ? null : scope
}

/**
 * Canonical classification of a single profile (or any profile-owned
 * record with no entity-level is_test flag and exactly one owner).
 * A profile row that omits the column entirely (narrow select, or a
 * not-yet-migrated read path) is treated as 'unknown', never 'real' --
 * the same fail-safe the database column default itself encodes.
 */
export function classifyProfile(profile: Pick<Profile, 'data_classification'>): ProfileDataClassification {
  return profile.data_classification ?? 'unknown'
}

/**
 * Canonical classification for an entity that has BOTH its own
 * `is_test` boolean and one or more owning profiles -- e.g.
 * listings.merchant_id (single owner); bookings.renter_id +
 * bookings.merchant_id, orders.buyer_id + orders.seller_id,
 * reviews.reviewer_id + reviews.reviewee_id, review_windows.party_a_id
 * + .party_b_id, rent_to_buy_agreements.merchant_id + .customer_id
 * (dual owner -- confirmed from supabase/migrations/*.sql source, not
 * guessed). Precedence (per this phase's brief, Section 2/7):
 *
 *   1. explicit test evidence always wins: entity.is_test === true, OR
 *      ANY owner is positively 'test' -> TEST.
 *   2. REAL requires every applicable positive condition: the entity
 *      is not test AND EVERY owner is positively 'real'.
 *   3. everything else -> UNKNOWN. Never guessed into REAL.
 *
 * A dual/multi-owner table is never reduced to "whichever party" --
 * test evidence from EITHER party makes the whole record test, and
 * real requires ALL parties to be real. This is the smallest rule
 * that cannot silently promote an unresolved legacy party to real
 * merely because the other party happens to be real.
 */
export function classifyEntityWithOwners(
  entity: { is_test: boolean },
  owners: readonly Pick<Profile, 'data_classification'>[]
): ProfileDataClassification {
  const ownerClassifications = owners.map(classifyProfile)
  if (entity.is_test || ownerClassifications.some((c) => c === 'test')) return 'test'
  if (ownerClassifications.length > 0 && ownerClassifications.every((c) => c === 'real')) return 'real'
  return 'unknown'
}

/** Convenience wrapper for the common single-owner case (e.g. listings.merchant_id, barter_skill_task_posts.owner_id). */
export function classifyEntityWithOwner(
  entity: { is_test: boolean },
  owner: Pick<Profile, 'data_classification'>
): ProfileDataClassification {
  return classifyEntityWithOwners(entity, [owner])
}

/**
 * Same precedence as classifyEntityWithOwners, for tables confirmed to
 * have NO entity-level is_test column of their own -- e.g. bookings,
 * orders, barter_agreements (confirmed: no `is_test` column exists on
 * any of these three in supabase/migrations/*.sql). Provenance here
 * depends purely on the owning profile(s). Named separately from
 * classifyEntityWithOwners (rather than requiring every call site to
 * fabricate an `{ is_test: false }` object) so each call site documents
 * which structural case it is in.
 */
export function classifyOwnersOnly(
  owners: readonly Pick<Profile, 'data_classification'>[]
): ProfileDataClassification {
  return classifyEntityWithOwners({ is_test: false }, owners)
}

/**
 * Tables confirmed by direct source inspection (src/lib/admin/audit-service.ts)
 * to be immutable, system-wide admin-ACTION audit trails, not
 * business/customer data -- these must never be run through profile or
 * entity classification at all; they have no "real/test" meaning.
 * Deliberately not a speculative general-purpose table map: entries
 * are added only as each is individually confirmed from source, per
 * this phase's explicit instruction not to invent table relationships
 * ahead of time. D3-B does not retrofit the Audit/System Health admin
 * screens themselves -- this list exists only so a future caller can
 * ask "is this a system table" before reaching for classification.
 */
export const ADMIN_SYSTEM_AUDIT_TABLES = [
  'admin_action_history',
  'identity_verification_history',
  'user_account_history',
] as const

export type AdminSystemAuditTable = (typeof ADMIN_SYSTEM_AUDIT_TABLES)[number]

export function isAdminSystemAuditTable(table: string): table is AdminSystemAuditTable {
  return (ADMIN_SYSTEM_AUDIT_TABLES as readonly string[]).includes(table)
}
