import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

describe('security: privileged fields are never client-writable (category: Security)', () => {
  it('1. profile updates from a non-service-role caller always revert account_status (protect_profile_privileged_fields)', () => {
    const migration = read('supabase/migrations/20260808000001_account_status_and_admin_notes.sql')
    expect(migration).toMatch(/new\.account_status := old\.account_status;/)
  })

  it('2. set_user_account_status refuses to run for anyone but service_role', () => {
    const migration = read('supabase/migrations/20260808000001_account_status_and_admin_notes.sql')
    expect(migration).toMatch(/create or replace function public\.set_user_account_status[\s\S]*?if auth\.role\(\) <> 'service_role' then\s*raise exception 'not authorized';/)
  })

  it('3. an admin cannot restrict or suspend their own account via the RPC', () => {
    const migration = read('supabase/migrations/20260808000001_account_status_and_admin_notes.sql')
    expect(migration).toMatch(/p_user_id = p_admin_id and p_action in \('restricted', 'suspended'\)/)
  })

  it("4. the restrict/suspend/restore routes always pass the SERVER-DERIVED admin id (gate.requester.userId), never a client-supplied admin id", () => {
    for (const rel of [
      'src/app/api/admin/users/[id]/restrict/route.ts',
      'src/app/api/admin/users/[id]/suspend/route.ts',
      'src/app/api/admin/users/[id]/restore/route.ts',
      'src/app/api/admin/users/[id]/notes/route.ts',
    ]) {
      const content = read(rel)
      expect(content, rel).toMatch(/gate\.requester\.userId/)
      expect(content, rel).not.toMatch(/admin_id:\s*(parsed\.data|body)\./)
    }
  })

  it('5. resolve_exception derives entityType server-side from a fixed type->entityType map, never trusting a client-supplied entity_type', () => {
    const content = read('src/app/api/admin/exceptions/[id]/resolve/route.ts')
    expect(content).toMatch(/TYPE_TO_ENTITY_TYPE\[exceptionType\]/)
    expect(content).not.toMatch(/entity_type:\s*(parsed\.data|body)\./)
  })
})

describe('security: CSV exports never include sensitive identity fields (category: CSV Exports)', () => {
  it('6. the users CSV export column list excludes ID/passport and address fields', () => {
    const content = read('src/app/api/admin/users/route.ts')
    for (const forbidden of ['idNumber', 'idReferenceNumber', 'passportNumber', 'residentialAddress', 'phone']) {
      expect(content, forbidden).not.toContain(forbidden)
    }
  })

  it('7. the users list query itself never selects a document/identity-reference column', () => {
    const content = read('src/lib/admin/users-service.ts')
    expect(content).not.toMatch(/id_reference_number|residential_address|passport/)
  })

  it('8. the email-deliveries list never selects template_vars in bulk', () => {
    const content = read('src/lib/admin/email-deliveries-service.ts')
    expect(content).not.toMatch(/\.select\([^)]*template_vars/)
  })
})

describe('security: no route accepts a client-supplied booking/payment mutation (category: Bookings/Financial)', () => {
  it('9. the admin booking detail route has no POST/PATCH handler — read-only by construction', () => {
    const content = read('src/app/api/admin/bookings/[id]/route.ts')
    expect(content).not.toMatch(/export async function POST/)
    expect(content).not.toMatch(/export async function PATCH/)
  })

  it('10. the financial-operations route never queries payment_webhook_events (raw provider payloads stay out of the admin surface entirely)', () => {
    const content = read('src/lib/admin/operations-service.ts')
    expect(content).not.toMatch(/\.from\(['"`]payment_webhook_events['"`]\)/)
  })
})
