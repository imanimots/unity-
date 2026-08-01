import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

describe('event wiring: each admin route calls its documented RPC/service function (category: Users/Bookings/Financial/Email/Exceptions/Audit)', () => {
  it('1. restrict calls set_user_account_status with action "restricted"', () => {
    expect(read('src/app/api/admin/users/[id]/restrict/route.ts')).toMatch(/'restricted'/)
  })
  it('2. suspend calls set_user_account_status with action "suspended"', () => {
    expect(read('src/app/api/admin/users/[id]/suspend/route.ts')).toMatch(/'suspended'/)
  })
  it('3. restore calls set_user_account_status with action "restored"', () => {
    expect(read('src/app/api/admin/users/[id]/restore/route.ts')).toMatch(/'restored'/)
  })
  it('4. notes route calls add_admin_note scoped to entity_type "user"', () => {
    const content = read('src/app/api/admin/users/[id]/notes/route.ts')
    expect(content).toMatch(/addAdminNote\(admin, 'user'/)
  })
  it("5. users-service's set_user_account_status wrapper forwards the exact RPC parameter names the migration defines", () => {
    const content = read('src/lib/admin/users-service.ts')
    expect(content).toMatch(/p_user_id:/)
    expect(content).toMatch(/p_admin_id:/)
    expect(content).toMatch(/p_action:/)
  })
  it('6. bookings list reuses the SAME financial-readiness derivation as checkout (no separate admin-only readiness logic)', () => {
    const content = read('src/lib/admin/operations-service.ts')
    expect(content).toMatch(/from '@\/lib\/checkout\/financial-readiness'/)
    expect(content).toMatch(/from '@\/lib\/checkout\/load-financial-state'/)
  })
  it('7. financial-operations reuses the same ledger_entries/merchant_payouts tables, never invents a parallel financial model', () => {
    const content = read('src/lib/admin/operations-service.ts')
    expect(content).toMatch(/\.from\('ledger_entries'\)/)
    expect(content).toMatch(/\.from\('merchant_payouts'\)/)
  })
  it('8. the email retry route reuses Step 8\'s retryDelivery(), not a new send path', () => {
    const content = read('src/app/api/admin/email-deliveries/[id]/retry/route.ts')
    expect(content).toMatch(/import \{ retryDelivery \} from '@\/lib\/email'/)
    expect(content).toMatch(/retryDelivery\(admin, deliveryId\)/)
  })
  it('9. resolve_exception is an idempotent UPSERT (on conflict do update), not an append-only insert', () => {
    const migration = read('supabase/migrations/20260808000002_admin_overview_and_exceptions.sql')
    expect(migration).toMatch(/on conflict \(exception_type, entity_type, entity_id\)\s*\n\s*do update set/)
  })
  it('10. the exceptions service covers all 11 documented categories', () => {
    const content = read('src/lib/admin/exceptions-service.ts')
    for (const type of [
      'listing_review_overdue',
      'ownership_review_overdue',
      'kyc_review_overdue',
      'booking_payment_deadline_overdue',
      'workflow_failed_retryable',
      'workflow_failed_terminal',
      'email_delivery_failed',
      'active_rental_overdue',
      'suspended_account_with_open_booking',
      'late_successful_provider_event',
      'booking_missing_financial_workflow',
    ]) {
      expect(content, type).toContain(`'${type}'`)
    }
  })
  it('11. the audit log excludes user-initiated (non-admin) identity_verification_history rows', () => {
    const content = read('src/lib/admin/audit-service.ts')
    expect(content).toMatch(/\.not\('admin_id', 'is', null\)/)
  })
  it('12. the audit log never merges raw ledger_entries rows into the admin-action feed', () => {
    const content = read('src/lib/admin/audit-service.ts')
    expect(content).not.toMatch(/\.from\(['"`]ledger_entries['"`]\)/)
  })
})

describe('idempotency: replay-safety matches the established convention (category: Users)', () => {
  it('13. set_user_account_status scopes idempotency by the ADMIN id, never the target user id', () => {
    const migration = read('supabase/migrations/20260808000001_account_status_and_admin_notes.sql')
    expect(migration).toMatch(/where merchant_id = p_admin_id and operation = v_operation and idempotency_key = p_idempotency_key/)
  })
  it('14. a changed payload under the same idempotency key raises the standard conflict message', () => {
    const migration = read('supabase/migrations/20260808000001_account_status_and_admin_notes.sql')
    expect(migration).toMatch(/idempotency key already used with a different request/)
  })
})
