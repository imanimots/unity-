import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

/**
 * P5D-GCP-AUTH-I: mechanical wiring proof. Parses the real route files on
 * disk (never a hand-copied list of their contents) to prove exactly the
 * 16 eligible routes reference the new isAuthorizedGcpSchedulerRequest()
 * check, and that the frozen parked route does not -- its auth path is
 * explicitly unchanged by this phase.
 */

const REPO_ROOT = resolve(__dirname, '../../../..')

const ELIGIBLE_ROUTES = [
  'src/app/api/internal/expire-unpaid-bookings/route.ts',
  'src/app/api/internal/expire-marketplace-requests/route.ts',
  'src/app/api/internal/email/send-payment-reminders/route.ts',
  'src/app/api/internal/email/retry-failed/route.ts',
  'src/app/api/internal/affiliate/review-and-approve/route.ts',
  'src/app/api/internal/affiliate/queue-payouts/route.ts',
  'src/app/api/internal/affiliate/process-payouts/route.ts',
  'src/app/api/internal/affiliate/reconcile-refunds/route.ts',
  'src/app/api/internal/commissions/finalize-earned/route.ts',
  'src/app/api/internal/commissions/reconcile-refunds/route.ts',
  'src/app/api/internal/payouts/reconcile-missing/route.ts',
  'src/app/api/internal/payouts/reconcile/route.ts',
  'src/app/api/internal/rent-to-buy/finalize-due-ownership/route.ts',
  'src/app/api/internal/subscriptions/apply-due/route.ts',
  'src/app/api/internal/subscriptions/execute-scheduled-publications/route.ts',
  'src/app/api/internal/advertising/finalize-expired/route.ts',
]

const FROZEN_ROUTE = 'src/app/api/internal/reviews/process-deadlines/route.ts'

describe('GCP OIDC route wiring (category: P5D-GCP-AUTH-I mechanical scope)', () => {
  it('eligible route count is exactly 16', () => {
    expect(ELIGIBLE_ROUTES).toHaveLength(16)
  })

  it.each(ELIGIBLE_ROUTES)('%s imports and calls isAuthorizedGcpSchedulerRequest, short-circuited after the static check', (relPath) => {
    const content = readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
    expect(content).toMatch(/import\s*\{[^}]*isAuthorizedGcpSchedulerRequest[^}]*\}\s*from\s*['"]@\/lib\/internal-cron\/auth['"]/)
    expect(content).toMatch(/if\s*\(\s*!isAuthorizedCronRequest\(request\)\s*&&\s*!\(\s*await\s+isAuthorizedGcpSchedulerRequest\(request\)\s*\)\s*\)/)
  })

  it('the frozen reviews/process-deadlines route does NOT reference the new verifier at all', () => {
    const content = readFileSync(resolve(REPO_ROOT, FROZEN_ROUTE), 'utf8')
    expect(content).not.toContain('isAuthorizedGcpSchedulerRequest')
  })

  it('no route outside the eligible set references the new verifier (confirms the migration did not silently overreach)', () => {
    const grepOutput = execSync(
      `grep -rl "isAuthorizedGcpSchedulerRequest" src/app/api/internal/ src/lib/internal-cron/auth.ts || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    const matchedFiles = grepOutput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => f !== 'src/lib/internal-cron/auth.ts')
    expect(matchedFiles.sort()).toEqual([...ELIGIBLE_ROUTES].sort())
  })
})
