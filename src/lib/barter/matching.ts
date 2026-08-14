// Skills + Tasks under Barter -- pure parts of the matching-signal
// computation extracted from the two matches routes:
//   src/app/api/barter/skill-task/[id]/matches/route.ts
//   src/app/api/marketplace/requests/[id]/matches/route.ts
//
// Only `deliveryModeCompatible` had a route-file duplicate worth
// extracting (the skill-task route's inline arrow function); the
// marketplace-requests route never computed a compatibilityCount or
// applied delivery-mode filtering for its own listing candidates, so
// there was nothing equivalent to extract from it for those two --
// it still benefits from being able to import this module for future
// use, so all three are exported centrally here.
//
// Deterministic, explainable, no numeric monetary score (plan §34-35).
// Pure: no imports, no side effects.

/** Mirrors the skill-task matches route's inline deliveryModeCompatible:
 * null on either side -> true (unknown, don't exclude); either side
 * 'either' -> true; otherwise exact match required. */
export function deliveryModeCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true
  if (a === 'either' || b === 'either') return true
  return a === b
}

/** Count of true values in a signals record -- the plain, non-monetary
 * "compatibility_count = number of true signals" rule from plan §35. */
export function computeCompatibilityCount(signals: Record<string, boolean>): number {
  return Object.values(signals).filter(Boolean).length
}

/** Sorts candidates by compatibilityCount DESC, tie-broken by
 * created_at DESC then id ASC -- mirrors the skill-task matches
 * route's effective ordering: its DB query already orders candidates
 * `created_at DESC, id ASC` before Array.prototype.sort (stable as of
 * ES2019) re-sorts by compatibilityCount DESC, so ties preserve that
 * original order. This function makes that tie-break explicit and
 * independent of any upstream query ordering. */
export function sortByCompatibilityDesc<T extends { compatibilityCount: number; created_at: string; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.compatibilityCount !== a.compatibilityCount) return b.compatibilityCount - a.compatibilityCount
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}
