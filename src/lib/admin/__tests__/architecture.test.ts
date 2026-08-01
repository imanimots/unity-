import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

function allTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allTsFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('architecture: every new admin route uses the authoritative admin gate (category: Overview/Users/Bookings)', () => {
  const ADMIN_ROUTES = [
    'src/app/api/admin/overview/route.ts',
    'src/app/api/admin/users/route.ts',
    'src/app/api/admin/users/[id]/route.ts',
    'src/app/api/admin/users/[id]/restrict/route.ts',
    'src/app/api/admin/users/[id]/suspend/route.ts',
    'src/app/api/admin/users/[id]/restore/route.ts',
    'src/app/api/admin/users/[id]/notes/route.ts',
    'src/app/api/admin/bookings/route.ts',
    'src/app/api/admin/bookings/[id]/route.ts',
    'src/app/api/admin/financial-operations/route.ts',
    'src/app/api/admin/email-deliveries/route.ts',
    'src/app/api/admin/email-deliveries/[id]/retry/route.ts',
    'src/app/api/admin/exceptions/route.ts',
    'src/app/api/admin/exceptions/[id]/resolve/route.ts',
    'src/app/api/admin/audit/route.ts',
  ]

  it('1. every new admin route calls requireAdminForRoute as its only auth check', () => {
    for (const rel of ADMIN_ROUTES) {
      const content = read(rel)
      expect(content, rel).toMatch(/requireAdminForRoute\(/)
    }
  })

  it('2. every new admin route uses the service-role client, never the session-scoped client', () => {
    for (const rel of ADMIN_ROUTES) {
      const content = read(rel)
      expect(content, rel).toMatch(/getAdminServiceClient\(/)
    }
  })

  it('3. no generic public "run any SQL"/"mutate any table" admin endpoint exists', () => {
    const apiFiles = allTsFiles(join(REPO_ROOT, 'src/app/api/admin'))
    for (const file of apiFiles) {
      const content = readFileSync(file, 'utf-8')
      expect(content, file).not.toMatch(/admin\.rpc\(\s*['"`]exec_sql/)
      expect(content, file).not.toMatch(/\.from\(\s*(request\.|body\.|parsed\.data\.)/)
    }
  })

  it('4. the overview route delegates all aggregation to one SQL RPC, never computing totals from multiple client-side queries', () => {
    const content = read('src/app/api/admin/overview/route.ts')
    expect(content).toMatch(/admin\.rpc\(['"`]get_admin_overview_stats['"`]\)/)
  })

  it('5. the email retry route accepts no request body at all — the recipient always comes from the stored delivery row', () => {
    const content = read('src/app/api/admin/email-deliveries/[id]/retry/route.ts')
    expect(content).not.toMatch(/request\.json\(\)/)
  })
})

describe('architecture: account-status gate wired into every named trusted route (category: Users)', () => {
  it('6. listing creation blocks a restricted/suspended user from creating a NEW listing (existing drafts remain editable)', () => {
    const content = read('src/app/api/listings/route.ts')
    expect(content).toMatch(/blockIfCannotCreate/)
    expect(content).toMatch(/if \(!listing_id\)/)
  })
  it('7. listing submission is gated', () => {
    expect(read('src/app/api/listings/[id]/submit/route.ts')).toMatch(/blockIfCannotCreate/)
  })
  it('8. booking creation is gated', () => {
    expect(read('src/app/api/bookings/route.ts')).toMatch(/blockIfCannotCreate/)
  })
  it('9. merchant acceptance, checkout, and rental start are gated against suspension', () => {
    expect(read('src/app/api/bookings/[id]/accept/route.ts')).toMatch(/blockIfCannotTransact/)
    expect(read('src/app/api/bookings/[id]/checkout/route.ts')).toMatch(/blockIfCannotTransact/)
    expect(read('src/app/api/bookings/[id]/start/route.ts')).toMatch(/blockIfCannotTransact/)
  })
  it('10. KYC submission is gated against suspension', () => {
    expect(read('src/app/api/verification/submit/route.ts')).toMatch(/blockIfCannotTransact/)
  })
  it('11. listing activation checks the LISTING\'S MERCHANT status, not the admin\'s own', () => {
    const content = read('src/app/api/admin/listings/[id]/activate/route.ts')
    expect(content).toMatch(/blocksNewTransactions/)
    expect(content).toMatch(/merchant\?\.account_status/)
  })
})
