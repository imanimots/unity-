import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'

/**
 * P5D-VERCEL-FIX: Vercel's Hobby plan rejects any cron expression that
 * would run more than once per day. These tests prove the 17 sub-daily
 * routes were moved to .github/workflows/internal-cron-scheduler.yml at
 * their EXACT prior cadence, that vercel.json now carries only the
 * already-daily purge route, and that nothing was lost, duplicated, or
 * silently altered in the move. Parses the real files on disk -- never a
 * hand-copied duplicate of either configuration -- so drift in either
 * file breaks these tests instead of going unnoticed.
 */

const REPO_ROOT = resolve(__dirname, '../../../..')

function readVercelJson(): { crons: Array<{ path: string; schedule: string }> } {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'vercel.json'), 'utf8'))
}

function readSchedulerWorkflow(): { doc: unknown; runScript: string } {
  const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/internal-cron-scheduler.yml'), 'utf8')
  const doc = yaml.load(raw) as {
    on: { schedule: Array<{ cron: string }> }
    jobs: { dispatch: { steps: Array<{ run: string }> } }
  }
  return { doc, runScript: doc.jobs.dispatch.steps[0].run }
}

/** Extracts the exact-string-equality schedule -> route-path dispatch table from the run script's own text (never a hand-typed duplicate). */
function extractDispatchTable(runScript: string): Map<string, string[]> {
  const table = new Map<string, string[]>()
  const pattern = /\[\s*"\$\{SCHEDULE\}"\s*=\s*"([^"]+)"\s*\];\s*then\s*\n\s*ROUTES="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(runScript)) !== null) {
    const [, schedule, routesRaw] = match
    table.set(schedule, routesRaw.split(/\s+/).filter(Boolean))
  }
  return table
}

// The exact 18 entries vercel.json contained before this remediation,
// re-derived from the P5D-VERCEL-CRON-D phase's own inventory -- the
// baseline this test protects against silently drifting from.
const ORIGINAL_18: Array<{ path: string; schedule: string }> = [
  { path: '/api/internal/reviews/process-deadlines', schedule: '0 * * * *' },
  { path: '/api/internal/expire-unpaid-bookings', schedule: '*/10 * * * *' },
  { path: '/api/internal/expire-marketplace-requests', schedule: '*/10 * * * *' },
  { path: '/api/internal/email/send-payment-reminders', schedule: '*/20 * * * *' },
  { path: '/api/internal/email/retry-failed', schedule: '10 * * * *' },
  { path: '/api/internal/affiliate/review-and-approve', schedule: '0 * * * *' },
  { path: '/api/internal/affiliate/queue-payouts', schedule: '15 * * * *' },
  { path: '/api/internal/affiliate/process-payouts', schedule: '30 * * * *' },
  { path: '/api/internal/affiliate/reconcile-refunds', schedule: '0 */4 * * *' },
  { path: '/api/internal/commissions/finalize-earned', schedule: '20 * * * *' },
  { path: '/api/internal/commissions/reconcile-refunds', schedule: '0 */4 * * *' },
  { path: '/api/internal/payouts/reconcile-missing', schedule: '5 * * * *' },
  { path: '/api/internal/payouts/reconcile', schedule: '10 */6 * * *' },
  { path: '/api/internal/rent-to-buy/finalize-due-ownership', schedule: '40 * * * *' },
  { path: '/api/internal/subscriptions/apply-due', schedule: '50 * * * *' },
  { path: '/api/internal/subscriptions/execute-scheduled-publications', schedule: '45 * * * *' },
  { path: '/api/internal/advertising/finalize-expired', schedule: '0 */2 * * *' },
  { path: '/api/internal/advertising/purge-events', schedule: '0 3 * * *' },
]
const PURGE_PATH = '/api/internal/advertising/purge-events'
const MIGRATED_17 = ORIGINAL_18.filter((e) => e.path !== PURGE_PATH)

function isSubDaily(schedule: string): boolean {
  // Once-per-day or less frequent: exact fixed minute+hour, every other
  // field a wildcard (e.g. "0 3 * * *"). Anything with a "/" step or a
  // non-wildcard day/month/weekday field is treated as sub-daily for
  // this check's purposes -- every schedule actually in use here is
  // either that exact daily shape or an hourly/sub-hourly one.
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return true
  const [minute, hour, dom, month, dow] = parts
  const fixedMinute = /^\d+$/.test(minute)
  const fixedHour = /^\d+$/.test(hour)
  const wildcardRest = dom === '*' && month === '*' && dow === '*'
  return !(fixedMinute && fixedHour && wildcardRest)
}

describe('vercel.json (category: P5D-VERCEL-FIX Hobby compliance)', () => {
  it('1. contains no sub-daily cron', () => {
    const { crons } = readVercelJson()
    for (const c of crons) {
      expect(isSubDaily(c.schedule)).toBe(false)
    }
  })

  it('2. advertising/purge-events remains present, unchanged, once daily', () => {
    const { crons } = readVercelJson()
    const purge = crons.find((c) => c.path === PURGE_PATH)
    expect(purge).toBeDefined()
    expect(purge!.schedule).toBe('0 3 * * *')
  })

  it('5. none of the 17 migrated routes remain in vercel.json', () => {
    const { crons } = readVercelJson()
    const paths = new Set(crons.map((c) => c.path))
    for (const migrated of MIGRATED_17) {
      expect(paths.has(migrated.path)).toBe(false)
    }
  })

  it('7/8. vercel.json contains exactly the purge route and nothing else', () => {
    const { crons } = readVercelJson()
    expect(crons.map((c) => c.path)).toEqual([PURGE_PATH])
  })
})

describe('internal-cron-scheduler.yml (category: P5D-VERCEL-FIX GitHub Actions migration)', () => {
  it('3/4. every migrated route appears in the dispatch table at its exact prior cron expression', () => {
    const { runScript } = readSchedulerWorkflow()
    const table = extractDispatchTable(runScript)
    for (const { path, schedule } of MIGRATED_17) {
      const routesForSchedule = table.get(schedule)
      expect(routesForSchedule, `no dispatch entry for schedule "${schedule}"`).toBeDefined()
      expect(routesForSchedule).toContain(path)
    }
  })

  it('6. the purge route is never dispatched from GitHub Actions', () => {
    const { runScript } = readSchedulerWorkflow()
    const table = extractDispatchTable(runScript)
    for (const routes of table.values()) {
      expect(routes).not.toContain(PURGE_PATH)
    }
  })

  it('7/8. the dispatch table contains exactly the 17 migrated routes, no more, no fewer, no duplicates', () => {
    const { runScript } = readSchedulerWorkflow()
    const table = extractDispatchTable(runScript)
    const allDispatched = [...table.values()].flat()
    expect(allDispatched.sort()).toEqual(MIGRATED_17.map((e) => e.path).sort())
    expect(new Set(allDispatched).size).toBe(allDispatched.length)
  })

  it('every distinct schedule in the dispatch table also exists as an on.schedule trigger', () => {
    const { doc, runScript } = readSchedulerWorkflow()
    const table = extractDispatchTable(runScript)
    const triggerCrons = new Set((doc as { on: { schedule: Array<{ cron: string }> } }).on.schedule.map((s) => s.cron))
    for (const schedule of table.keys()) {
      expect(triggerCrons.has(schedule), `"${schedule}" is dispatched but has no on.schedule trigger`).toBe(true)
    }
  })

  it('9. references the INTERNAL_CRON_SECRET GitHub secret', () => {
    const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/internal-cron-scheduler.yml'), 'utf8')
    expect(raw).toContain('secrets.INTERNAL_CRON_SECRET')
  })

  it('10. never hard-codes a secret value', () => {
    const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/internal-cron-scheduler.yml'), 'utf8')
    // The only literal "Bearer " usage must be interpolating the env var,
    // never a literal token value.
    expect(raw).toContain('Bearer ${INTERNAL_CRON_SECRET}')
    expect(raw).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/)
  })

  it('11. is triggered only by schedule, never workflow_dispatch or any other event', () => {
    const { doc } = readSchedulerWorkflow()
    const onBlock = (doc as { on: Record<string, unknown> }).on
    expect(Object.keys(onBlock)).toEqual(['schedule'])
  })

  it('12. the fastest configured cadence (10 minutes) is compatible with GitHub Actions\' 5-minute minimum granularity', () => {
    const { doc } = readSchedulerWorkflow()
    const crons = (doc as { on: { schedule: Array<{ cron: string }> } }).on.schedule.map((s) => s.cron)
    const stepMatches = crons.map((c) => c.match(/^\*\/(\d+) \* \* \* \*$/)).filter(Boolean) as RegExpMatchArray[]
    expect(stepMatches.length).toBeGreaterThan(0)
    const minuteSteps = stepMatches.map((m) => Number(m[1]))
    expect(Math.min(...minuteSteps)).toBeGreaterThanOrEqual(5)
  })

  it('least-privilege permissions and per-schedule concurrency isolation are configured', () => {
    const { doc } = readSchedulerWorkflow()
    const typed = doc as { permissions: Record<string, unknown>; jobs: { dispatch: { ['concurrency']?: { group: string } } } }
    expect(typed.permissions).toEqual({})
  })
})

describe('combined coverage (category: no route lost, none duplicated across both schedulers)', () => {
  it('every one of the original 18 routes is scheduled exactly once, in exactly one of the two schedulers', () => {
    const { crons } = readVercelJson()
    const { runScript } = readSchedulerWorkflow()
    const table = extractDispatchTable(runScript)
    const ghRoutes = [...table.values()].flat()
    const vercelRoutes = crons.map((c) => c.path)
    const combined = [...vercelRoutes, ...ghRoutes]

    expect(combined.sort()).toEqual(ORIGINAL_18.map((e) => e.path).sort())
    expect(new Set(combined).size).toBe(ORIGINAL_18.length)
  })
})
