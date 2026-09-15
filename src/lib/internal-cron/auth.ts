/**
 * Shared cron-authentication authority for every internal scheduled
 * route (P4 -- Production Operations: Scheduled Job Activation).
 *
 * Behaviorally mirrors the exact dual-secret contract already proven
 * live by src/app/api/internal/reviews/process-deadlines/route.ts --
 * that route keeps its own inline copy (a parked file, untouched by
 * this module); this factors the SAME behavior out once so the other
 * 17 internal routes don't each duplicate it.
 *
 * Two independent secrets, either one authorizes a request:
 * - CRON_SECRET -- Vercel Cron's own platform-fixed env var name (not
 *   renameable, not configurable via vercel.json). Once set on the
 *   project, Vercel automatically attaches `Authorization: Bearer
 *   <value>` to every scheduled invocation, which Vercel Cron always
 *   issues via GET.
 * - INTERNAL_CRON_SECRET -- this codebase's pre-existing convention for
 *   manual/curl invocation, unchanged from every internal route's
 *   original contract (see docs/PUBLIC_TEST_RUNBOOK.md).
 *
 * Fails closed if neither secret is configured server-side -- never
 * treats an unconfigured secret as authorization. Never accepts a
 * query-string secret. Never logs, echoes, or otherwise exposes which
 * secret matched or any secret material. Pure function of the request
 * + environment -- no database/network access, matching the existing
 * Reviews implementation's own scope exactly.
 */
export function hasCronAuthConfigured(): boolean {
  return Boolean(process.env.INTERNAL_CRON_SECRET || process.env.CRON_SECRET)
}

export function isAuthorizedCronRequest(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false

  const internalSecret = process.env.INTERNAL_CRON_SECRET
  const vercelCronSecret = process.env.CRON_SECRET
  if (!internalSecret && !vercelCronSecret) return false

  if (internalSecret && authHeader === `Bearer ${internalSecret}`) return true
  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) return true
  return false
}
