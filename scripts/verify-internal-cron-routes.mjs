#!/usr/bin/env node
/**
 * Permanent structural verifier for P4 -- Production Operations:
 * Scheduled Job Activation. Purely static/source-only -- no network, no
 * DB client, no credentials, no Supabase CLI, no mutation, no cron
 * route ever invoked. Safe to run anywhere, anytime.
 *
 * Proves, for every one of the 17 P4 candidate routes:
 *   - exports both GET and POST, delegating to the same handler
 *   - imports the shared cron-auth authority (src/lib/internal-cron/
 *     auth.ts), not a bespoke/duplicated auth check
 *   - appears in vercel.json's crons array exactly once, at the exact
 *     proposed schedule
 *   - contains no embedded secret value
 *
 * And, separately, that the pre-existing Reviews cron entry (and its
 * route -- a parked file, read-only here) is preserved exactly, and
 * that no KYC route was swept into vercel.json (it is scheduled via a
 * separate GitHub Actions workflow, outside this file entirely).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failures += 1
    console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500))
  }
}

function readFile(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// route path -> { file, schedule }
const CANDIDATES = [
  ['/api/internal/expire-unpaid-bookings', 'src/app/api/internal/expire-unpaid-bookings/route.ts', '*/10 * * * *'],
  ['/api/internal/expire-marketplace-requests', 'src/app/api/internal/expire-marketplace-requests/route.ts', '*/10 * * * *'],
  ['/api/internal/email/send-payment-reminders', 'src/app/api/internal/email/send-payment-reminders/route.ts', '*/20 * * * *'],
  ['/api/internal/email/retry-failed', 'src/app/api/internal/email/retry-failed/route.ts', '10 * * * *'],
  ['/api/internal/affiliate/review-and-approve', 'src/app/api/internal/affiliate/review-and-approve/route.ts', '0 * * * *'],
  ['/api/internal/affiliate/queue-payouts', 'src/app/api/internal/affiliate/queue-payouts/route.ts', '15 * * * *'],
  ['/api/internal/affiliate/process-payouts', 'src/app/api/internal/affiliate/process-payouts/route.ts', '30 * * * *'],
  ['/api/internal/affiliate/reconcile-refunds', 'src/app/api/internal/affiliate/reconcile-refunds/route.ts', '0 */4 * * *'],
  ['/api/internal/commissions/finalize-earned', 'src/app/api/internal/commissions/finalize-earned/route.ts', '20 * * * *'],
  ['/api/internal/commissions/reconcile-refunds', 'src/app/api/internal/commissions/reconcile-refunds/route.ts', '0 */4 * * *'],
  ['/api/internal/payouts/reconcile-missing', 'src/app/api/internal/payouts/reconcile-missing/route.ts', '5 * * * *'],
  ['/api/internal/payouts/reconcile', 'src/app/api/internal/payouts/reconcile/route.ts', '10 */6 * * *'],
  ['/api/internal/rent-to-buy/finalize-due-ownership', 'src/app/api/internal/rent-to-buy/finalize-due-ownership/route.ts', '40 * * * *'],
  ['/api/internal/subscriptions/apply-due', 'src/app/api/internal/subscriptions/apply-due/route.ts', '50 * * * *'],
  ['/api/internal/subscriptions/execute-scheduled-publications', 'src/app/api/internal/subscriptions/execute-scheduled-publications/route.ts', '45 * * * *'],
  ['/api/internal/advertising/finalize-expired', 'src/app/api/internal/advertising/finalize-expired/route.ts', '0 */2 * * *'],
  ['/api/internal/advertising/purge-events', 'src/app/api/internal/advertising/purge-events/route.ts', '0 3 * * *'],
]

const REVIEWS_PATH = '/api/internal/reviews/process-deadlines'
const REVIEWS_SCHEDULE = '0 * * * *'
const KYC_PATH = '/api/internal/kyc/cleanup-upload-intents'

function main() {
  console.log('=== P4 internal cron routes -- structural verification ===\n')

  const vercelConfig = JSON.parse(readFile('vercel.json'))
  const crons = vercelConfig.crons ?? []

  check('vercel.json declares a crons array', Array.isArray(crons))
  check('vercel.json has exactly 18 cron entries (17 P4 + Reviews)', crons.length === 18, { actual: crons.length })

  const reviewsEntry = crons.find((c) => c.path === REVIEWS_PATH)
  check('Reviews cron entry is present', Boolean(reviewsEntry))
  check('Reviews cron entry preserved exactly (path + schedule unchanged)', reviewsEntry?.schedule === REVIEWS_SCHEDULE, reviewsEntry)

  check('no KYC route present in vercel.json (scheduled via GitHub Actions instead)', !crons.some((c) => c.path === KYC_PATH))

  const seenPaths = new Set()
  for (const c of crons) {
    if (seenPaths.has(c.path)) check(`no duplicate cron path (${c.path})`, false, c)
    seenPaths.add(c.path)
  }
  check('no duplicate cron paths overall', seenPaths.size === crons.length)

  for (const [routePath, file, expectedSchedule] of CANDIDATES) {
    console.log(`\n--- ${routePath} ---`)
    const entry = crons.find((c) => c.path === routePath)
    check('scheduled in vercel.json exactly once', crons.filter((c) => c.path === routePath).length === 1, { routePath })
    check(`scheduled at the proposed cadence (${expectedSchedule})`, entry?.schedule === expectedSchedule, entry)

    const src = readFile(file)
    check('exports GET', /export async function GET\(/.test(src))
    check('exports POST', /export async function POST\(/.test(src))
    check('GET delegates to the shared handleCronRequest', /export async function GET\(request: NextRequest\) \{\s*return handleCronRequest\(request\)/.test(src))
    check('POST delegates to the SAME shared handleCronRequest (no drift between entry points)', /export async function POST\(request: NextRequest\) \{\s*return handleCronRequest\(request\)/.test(src))
    check(
      "imports the shared cron-auth authority (not a bespoke/duplicated check)",
      src.includes("from '@/lib/internal-cron/auth'") && src.includes('hasCronAuthConfigured') && src.includes('isAuthorizedCronRequest')
    )
    check('contains no embedded secret value (no bare Bearer-comparison string literal)', !/===\s*`Bearer \$\{secret\}`/.test(src) && !/process\.env\.INTERNAL_CRON_SECRET\s*\n?\s*if/.test(src))
  }

  const authSrc = readFile('src/lib/internal-cron/auth.ts')
  console.log('\n--- shared auth module ---')
  check('exports hasCronAuthConfigured', authSrc.includes('export function hasCronAuthConfigured'))
  check('exports isAuthorizedCronRequest', authSrc.includes('export function isAuthorizedCronRequest'))
  check('checks both INTERNAL_CRON_SECRET and CRON_SECRET', authSrc.includes('INTERNAL_CRON_SECRET') && authSrc.includes('CRON_SECRET'))
  check('requires a Bearer-prefixed header', authSrc.includes("startsWith('Bearer ')"))
  check('contains no embedded secret value', !/=\s*['"][A-Za-z0-9+/=]{16,}['"]/.test(authSrc))

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
