import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function allTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allTsFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const RESEND_IMPORT = /from ['"].*providers\/resend-provider['"]/
const CONSOLE_IMPORT = /from ['"].*providers\/console-provider['"]/

const DOMAIN_ROUTE_DIRS = [
  join(REPO_ROOT, 'src/app/api/bookings'),
  join(REPO_ROOT, 'src/app/api/admin/listings'),
  join(REPO_ROOT, 'src/app/api/admin/verifications'),
  join(REPO_ROOT, 'src/app/api/verification'),
]

describe('architecture fitness: email stays provider-agnostic (category: Architecture)', () => {
  it('1. no domain route (bookings/listings/verifications) imports a concrete email provider directly', () => {
    const offenders: string[] = []
    for (const dir of DOMAIN_ROUTE_DIRS) {
      for (const file of allTsFiles(dir)) {
        const content = readFileSync(file, 'utf-8')
        if (RESEND_IMPORT.test(content) || CONSOLE_IMPORT.test(content)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('2. the template catalogue and shared shell import no provider -- templates are provider-neutral by construction', () => {
    const catalogue = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/catalogue.ts'), 'utf-8')
    const shared = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/shared.ts'), 'utf-8')
    expect(catalogue).not.toMatch(RESEND_IMPORT)
    expect(catalogue).not.toMatch(CONSOLE_IMPORT)
    expect(shared).not.toMatch(RESEND_IMPORT)
    expect(shared).not.toMatch(CONSOLE_IMPORT)
  })

  it('3. the provider is resolved only through the registry (name -> EMAIL_PROVIDER env -> "console" default), never hardcoded in the dispatch service', () => {
    const service = readFileSync(join(REPO_ROOT, 'src/lib/email/service.ts'), 'utf-8')
    expect(service).toMatch(/from '\.\/registry'/)
    expect(service).toMatch(/getEmailProvider\(\)/)
    expect(service).not.toMatch(RESEND_IMPORT)
    expect(service).not.toMatch(CONSOLE_IMPORT)

    const registry = readFileSync(join(REPO_ROOT, 'src/lib/email/registry.ts'), 'utf-8')
    expect(registry).toMatch(/process\.env\.EMAIL_PROVIDER/)
    expect(registry).toMatch(/'console'/)
  })

  it('4. switching providers requires only the EMAIL_PROVIDER env var -- both Console and Resend are registered under stable string keys', () => {
    const registry = readFileSync(join(REPO_ROOT, 'src/lib/email/registry.ts'), 'utf-8')
    expect(registry).toMatch(/console:\s*new ConsoleEmailProvider\(\)/)
    expect(registry).toMatch(/resend:\s*new ResendEmailProvider\(\)/)
  })
})
