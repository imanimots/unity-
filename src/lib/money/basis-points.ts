/**
 * The one rounding rule for every percentage-of-money calculation in
 * this codebase (subscription economics -- Phase 1, Unity commission --
 * Phase 2): integer cents in, integer basis points in, round-half-up
 * integer cents out via Math.round. Never floating-point financial
 * arithmetic beyond this single, shared, unit-tested boundary -- every
 * caller converts rands to integer cents first, applies bps here, and
 * converts back only for display/storage.
 *
 * Mirrored in SQL by _calculate_unity_commission()
 * (supabase/migrations/20260823000003_unity_commission_calc_and_qualify_rpcs.sql),
 * which uses Postgres's own exact decimal `round()` on numeric --
 * mathematically identical for non-negative 2-decimal-place money, so
 * the two implementations can never silently diverge.
 */
export function applyBps(amountCents: number, bps: number): number {
  return Math.round((amountCents * bps) / 10000)
}
