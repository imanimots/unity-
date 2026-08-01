import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')
const CHECKOUT_ROUTE_FILES = [
  join(REPO_ROOT, 'src/app/api/bookings/[id]/checkout/route.ts'),
  join(REPO_ROOT, 'src/app/api/bookings/[id]/financial-status/route.ts'),
]
const CHECKOUT_UI_FILES = [
  join(REPO_ROOT, 'src/app/(dashboard)/dashboard/renter/bookings/[id]/checkout/page.tsx'),
  join(REPO_ROOT, 'src/app/(dashboard)/dashboard/renter/bookings/[id]/checkout/checkout-flow.tsx'),
  join(REPO_ROOT, 'src/app/(dashboard)/dashboard/renter/bookings/page.tsx'),
  join(REPO_ROOT, 'src/app/(dashboard)/dashboard/merchant/bookings/page.tsx'),
]
const PAYMENT_COMPONENT_DIR = join(REPO_ROOT, 'src/components/payments')
const CHECKOUT_LIB_DIR = join(REPO_ROOT, 'src/lib/checkout')

function allTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allTsFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const MOCK_PROVIDER_IMPORT = /from ['"].*providers\/mock-provider['"]/
const PEACH_PROVIDER_IMPORT = /from ['"].*providers\/peach-provider['"]/

describe('architecture fitness: checkout stays provider-agnostic', () => {
  it('1. neither checkout API route imports a concrete provider directly', () => {
    for (const file of CHECKOUT_ROUTE_FILES) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(MOCK_PROVIDER_IMPORT)
      expect(content).not.toMatch(PEACH_PROVIDER_IMPORT)
    }
  })

  it('2. no checkout UI file (page, client component, or dashboard) imports a concrete provider directly', () => {
    for (const file of CHECKOUT_UI_FILES) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(MOCK_PROVIDER_IMPORT)
      expect(content).not.toMatch(PEACH_PROVIDER_IMPORT)
    }
  })

  it('3. no reusable payment status component imports a concrete provider directly', () => {
    for (const file of allTsFiles(PAYMENT_COMPONENT_DIR)) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(MOCK_PROVIDER_IMPORT)
      expect(content).not.toMatch(PEACH_PROVIDER_IMPORT)
    }
  })

  it('4. test-scenario.ts is the only checkout-domain file that references the MockScenario type', () => {
    const offenders: string[] = []
    for (const file of allTsFiles(CHECKOUT_LIB_DIR)) {
      if (file.endsWith('test-scenario.ts') || file.endsWith('index.ts') || file.includes('__tests__')) continue
      const content = readFileSync(file, 'utf-8')
      if (/MockScenario/.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('5. the checkout POST route resolves the provider only through authorizeBookingFinancials (the orchestrator barrel), never the registry directly', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/bookings/[id]/checkout/route.ts'), 'utf-8')
    expect(content).toMatch(/from '@\/lib\/payments\/orchestrator'/)
    expect(content).not.toMatch(/from ['"].*payments\/registry['"]/)
  })

  it('6. the accept route no longer imports the orchestrator -- acceptance and financial authorization are separate steps as of Step 5', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/bookings/[id]/accept/route.ts'), 'utf-8')
    expect(content).not.toMatch(/from '@\/lib\/payments\/orchestrator'/)
  })
})

describe('architecture fitness: Step 6 payment-readiness gate is centralized, not duplicated', () => {
  it('7. the start-rental route uses the one shared readiness gate helper, not its own payment query', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/bookings/[id]/start/route.ts'), 'utf-8')
    expect(content).toMatch(/from '@\/lib\/checkout\/readiness-gate'/)
    expect(content).toMatch(/getBookingFinancialEligibility/)
    // must not itself query payments/financial_workflows directly -- that
    // logic lives exactly once, inside loadBookingFinancialState.
    expect(content).not.toMatch(/\.from\(['"]payments['"]\)/)
    expect(content).not.toMatch(/\.from\(['"]financial_workflows['"]\)/)
  })

  it('8. every route that reads or mutates a booking\'s financial-readiness-sensitive state triggers the centralized lazy-expiry sweep', () => {
    const files = [
      'src/app/api/bookings/[id]/checkout/route.ts',
      'src/app/api/bookings/[id]/financial-status/route.ts',
      'src/app/api/bookings/[id]/start/route.ts',
      'src/app/api/bookings/[id]/route.ts',
      'src/app/api/bookings/route.ts',
    ]
    for (const rel of files) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf-8')
      expect(content).toMatch(/from '@\/lib\/bookings\/lazy-expiry'/)
      expect(content).toMatch(/triggerLazyExpirySweep/)
    }
  })

  it('9. no route computes financial readiness by comparing a provider name string -- readiness is always asked of deriveFinancialReadiness/getBookingFinancialEligibility, never "does this equal mock/peach"', () => {
    const files = [
      'src/app/api/bookings/[id]/checkout/route.ts',
      'src/app/api/bookings/[id]/start/route.ts',
    ]
    for (const rel of files) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf-8')
      expect(content).not.toMatch(/===\s*['"]mock['"]/)
      expect(content).not.toMatch(/===\s*['"]peach['"]/)
    }
  })

  it('10. the internal expiry endpoint requires a configured secret and never defaults open', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/internal/expire-unpaid-bookings/route.ts'), 'utf-8')
    expect(content).toMatch(/INTERNAL_CRON_SECRET/)
    expect(content).toMatch(/if \(!secret\)/)
  })

  it('11. the payment deadline duration is read from one single config module, not re-parsed inline elsewhere', () => {
    const offenders: string[] = []
    const dirs = [join(REPO_ROOT, 'src/app/api/bookings'), join(REPO_ROOT, 'src/lib/checkout'), join(REPO_ROOT, 'src/lib/bookings')]
    for (const dir of dirs) {
      for (const file of allTsFiles(dir)) {
        if (file.endsWith('payment-deadline.ts') || file.includes('__tests__')) continue
        const content = readFileSync(file, 'utf-8')
        if (/process\.env\.BOOKING_PAYMENT_DEADLINE_HOURS/.test(content)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('Step 6 migration invariants (regression guards over the SQL text)', () => {
  const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260805000001_payment_readiness.sql')
  const sql = readFileSync(migrationPath, 'utf-8')

  it('12. (category: Cancellation) the unpaid-expiry sweep only ever targets status = accepted -- a cancelled booking can never be matched by it', () => {
    const fnBody = sql.split('create or replace function public.expire_unpaid_accepted_bookings')[1]
    expect(fnBody).toMatch(/where status = 'accepted' and payment_due_at is not null/)
  })

  it('13. (category: Security) payment_due_at and payment_expired_at are both reverted for non-service-role callers by the privileged-field trigger', () => {
    const fnBody = sql.split('create or replace function public.protect_booking_privileged_fields')[1]
    expect(fnBody).toMatch(/new\.payment_due_at := old\.payment_due_at/)
    expect(fnBody).toMatch(/new\.payment_expired_at := old\.payment_expired_at/)
  })

  it('14. (category: Security) every new/changed RPC is revoked from anon and authenticated, granted only to service_role', () => {
    for (const fn of ['accept_booking_request(uuid, uuid, text, text, integer)', 'expire_unpaid_accepted_bookings()', 'record_late_payment_reconciliation(uuid, text)']) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, '\\$&')} from public, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, '\\$&')} to service_role`))
    }
  })

  it('15. (category: Acceptance) accept_booking_request rejects a missing or non-positive payment deadline rather than silently defaulting', () => {
    const fnBody = sql.split('create or replace function public.accept_booking_request')[1]
    expect(fnBody).toMatch(/if p_payment_deadline_hours is null or p_payment_deadline_hours <= 0 then/)
  })

  it('16. (category: Acceptance) payment_due_at is computed as least(accepted-time + deadline, start_at) -- never after start_at', () => {
    const fnBody = sql.split('create or replace function public.accept_booking_request')[1]
    expect(fnBody).toMatch(/v_payment_due_at := least\(now\(\) \+ make_interval\(hours => p_payment_deadline_hours\), v_booking\.start_at\)/)
  })

  it('17. (category: Expiry) the expiry RPC skips a booking whose payments are actually captured/authorised, never expiring a booking that paid in time', () => {
    const fnBody = sql.split('create or replace function public.expire_unpaid_accepted_bookings')[1]
    expect(fnBody).toMatch(/v_ready := \(v_rental_status = 'captured'\) and \(not v_deposit_required or v_deposit_status = 'authorised'\)/)
    expect(fnBody).toMatch(/if v_ready then/)
  })

  it('18. (category: Expiry) the expiry sweep uses "for update skip locked", matching the pre-existing expire_stale_booking_requests() concurrency pattern', () => {
    const fnBody = sql.split('create or replace function public.expire_unpaid_accepted_bookings')[1]
    expect(fnBody).toMatch(/for update skip locked/)
  })

  it('19. (category: Late Events) record_late_payment_reconciliation never writes to payments or ledger_entries -- it only ever inserts one booking_history row', () => {
    const fnBody = sql.split('create or replace function public.record_late_payment_reconciliation')[1].split('$$;')[0]
    expect(fnBody).not.toMatch(/\.from\(['"]payments['"]\)/)
    expect(fnBody).not.toMatch(/insert into public\.payments/)
    expect(fnBody).not.toMatch(/insert into public\.ledger_entries/)
    expect(fnBody).toMatch(/insert into public\.booking_history/)
  })

  it('20. (category: Late Events) record_late_payment_reconciliation is idempotent -- it checks for an existing marker before inserting a second one', () => {
    const fnBody = sql.split('create or replace function public.record_late_payment_reconciliation')[1]
    expect(fnBody).toMatch(/select exists\(/)
    expect(fnBody).toMatch(/if not v_already_recorded then/)
  })
})
