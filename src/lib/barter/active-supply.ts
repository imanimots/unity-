// Skills + Tasks under Barter -- pure TS mirror of the combined
// active-supply cap formula computed by `_lock_and_count_active_supply()`
// in supabase/migrations/20260901000009_skills_tasks_barter_posts_rpcs.sql
// (plan §11): COUNT of the caller's own active `listings` rows plus
// their active, direction='available' `barter_skill_task_posts` rows,
// compared against the merchant plan's listing cap
// (`v_active_count >= v_listing_limit` => at capacity).
//
// Looking-For posts are NEVER included in this count (plan §6/§11) --
// this is enforced structurally, not by convention: this function's
// signature only accepts an "active Available Skill/Task posts" count
// parameter, so there is no parameter through which a Looking-For post
// count could even be passed in. See the test file for a regression
// demonstrating this.
//
// Pure: no imports, no side effects.

/** Combined active-supply count -- active listings + active-Available
 * Skill/Task posts. Trivial sum; the real documentation value is the
 * signature itself, which structurally excludes Looking-For posts. */
export function combinedActiveSupplyCount(activeListingsCount: number, activeAvailableSkillTaskPostsCount: number): number {
  return activeListingsCount + activeAvailableSkillTaskPostsCount
}

/** Mirrors the SQL guard `v_active_count >= v_listing_limit` -- at
 * capacity when the current count has reached (or exceeded) the cap. */
export function isAtCapacity(currentCount: number, cap: number): boolean {
  return currentCount >= cap
}
