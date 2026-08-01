/**
 * Runs once when a new Next.js server instance starts (dev, build, or
 * production) — see docs/PUBLIC_TEST_RUNBOOK.md's "environment
 * validation" section. Logs a names-only report (never values) and, in
 * production only, throws to fail the boot if a required variable is
 * missing or invalid — a public-test deployment must never silently run
 * half-configured.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { validateEnvironment, formatEnvReport } = await import('@/lib/env/validate')
  const report = validateEnvironment()
  console.log(formatEnvReport(report))

  if (!report.ok && process.env.NODE_ENV === 'production') {
    throw new Error(`Environment validation failed — missing/invalid: ${report.criticalFailures.join(', ')}`)
  }
}
