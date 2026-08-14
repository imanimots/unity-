// Skills + Tasks under Barter -- pure TS mirror of the Postgres
// function `_validate_skill_task_post_transition()` (and the admin-only
// suspend/restore actor-role rules layered around it), defined in
// supabase/migrations/20260901000009_skills_tasks_barter_posts_rpcs.sql.
//
// This is a documented, testable specification of the direction-aware
// status transition table the SQL function enforces -- its real value
// is catching future drift if someone edits the SQL (or this file)
// without updating the other. It does NOT replace the SQL function as
// the actual enforcement point; the RPC remains authoritative.
//
// Legal transitions (read directly from the SQL, plan §3):
//
// AVAILABLE:
//   draft -> active                        (owner, publish)
//   active -> paused | archived | suspended        (owner, except suspended=admin)
//   paused -> active | archived | suspended         (owner, except suspended=admin)
//   suspended -> active | paused                    (admin, restore)
//   Never reaches offers_received/matched.
//
// LOOKING_FOR:
//   draft -> active                                  (owner, publish)
//   active -> offers_received | closed | suspended   (system for offers_received, owner for closed, admin for suspended)
//   offers_received -> matched | closed | suspended  (system for matched, owner for closed, admin for suspended)
//   suspended -> active | offers_received             (admin, restore -- exact prior state)
//   closed | matched -> archived                      (owner)
//   No paused state for Looking-For.
//
// Actor-role gating (layered on top of the bare transition table, per
// §3/§33/D4/R5-3): suspending INTO 'suspended' is admin-only; restoring
// OUT OF 'suspended' is admin-only; every other transition is an owner
// action, except the two Looking-For system-only transitions
// (active -> offers_received on first offer, offers_received -> matched
// on accept), which only the system actor may perform.
//
// Pure: no imports, no side effects.

export type SkillTaskPostStatus = 'draft' | 'active' | 'offers_received' | 'matched' | 'paused' | 'closed' | 'archived' | 'suspended'
export type SkillTaskPostDirection = 'available' | 'looking_for'
export type SkillTaskPostActorRole = 'owner' | 'system' | 'admin'

function isBareTransitionLegal(current: SkillTaskPostStatus, next: SkillTaskPostStatus, direction: SkillTaskPostDirection): boolean {
  if (direction === 'available') {
    return (
      (current === 'draft' && next === 'active') ||
      (current === 'active' && (next === 'paused' || next === 'archived' || next === 'suspended')) ||
      (current === 'paused' && (next === 'active' || next === 'archived' || next === 'suspended')) ||
      (current === 'suspended' && (next === 'active' || next === 'paused'))
    )
  }

  // looking_for
  return (
    (current === 'draft' && next === 'active') ||
    (current === 'active' && (next === 'offers_received' || next === 'closed' || next === 'suspended')) ||
    (current === 'offers_received' && (next === 'matched' || next === 'closed' || next === 'suspended')) ||
    (current === 'suspended' && (next === 'active' || next === 'offers_received')) ||
    ((current === 'closed' || current === 'matched') && next === 'archived')
  )
}

// System-only transitions -- only the matching-engine/accept-path code
// (never a human owner or admin click) may perform these.
function isSystemOnlyTransition(current: SkillTaskPostStatus, next: SkillTaskPostStatus, direction: SkillTaskPostDirection): boolean {
  if (direction !== 'looking_for') return false
  return (current === 'active' && next === 'offers_received') || (current === 'offers_received' && next === 'matched')
}

// Admin-only transitions -- suspend (into 'suspended') and restore
// (out of 'suspended') per §33/D4/R5-3.
function isAdminOnlyTransition(current: SkillTaskPostStatus, next: SkillTaskPostStatus): boolean {
  return next === 'suspended' || current === 'suspended'
}

/** Reproduces the same legal-transition table as
 * `_validate_skill_task_post_transition()` plus the actor-role gating
 * that surrounds it in the RPC layer (owner vs system vs admin). */
export function isValidSkillTaskPostTransition(
  current: SkillTaskPostStatus,
  next: SkillTaskPostStatus,
  direction: SkillTaskPostDirection,
  actorRole: SkillTaskPostActorRole,
): boolean {
  if (!isBareTransitionLegal(current, next, direction)) return false

  if (isSystemOnlyTransition(current, next, direction)) {
    return actorRole === 'system'
  }

  if (isAdminOnlyTransition(current, next)) {
    return actorRole === 'admin'
  }

  // Every remaining legal transition is an owner action.
  return actorRole === 'owner'
}
