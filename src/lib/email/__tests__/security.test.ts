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

describe('security: no generic public send route exists (category: Security)', () => {
  const apiFiles = allTsFiles(join(REPO_ROOT, 'src/app/api'))

  it('1. no route reads event_type/template_id/recipient_user_id directly from the request body and forwards it to sendTemplate', () => {
    const offenders: string[] = []
    for (const file of apiFiles) {
      const content = readFileSync(file, 'utf-8')
      if (!content.includes('sendTemplate(')) continue
      // Every real call site constructs eventType/templateId as a literal
      // string or from server-derived context -- never from `parsed.data`
      // or `body.` directly feeding those two fields.
      const suspicious = /eventType:\s*(parsed\.data|body)\.|templateId:\s*(parsed\.data|body)\./
      if (suspicious.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('2. no route accepts a client-supplied recipientUserId for sendTemplate -- every call site uses a server-derived id (ctx.*, requester.userId, or a route param already ownership-checked)', () => {
    const offenders: string[] = []
    for (const file of apiFiles) {
      const content = readFileSync(file, 'utf-8')
      if (!content.includes('sendTemplate(')) continue
      const suspicious = /recipientUserId:\s*(parsed\.data|body)\./
      if (suspicious.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('3. no public (non-internal) route imports sendTemplate with a client-suppliable provider name', () => {
    const offenders: string[] = []
    for (const file of apiFiles) {
      const content = readFileSync(file, 'utf-8')
      if (/providerName:\s*(parsed\.data|body)\./.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('security: internal email routes require the configured secret (category: Security)', () => {
  const internalRoutes = [
    'src/app/api/internal/email/send-payment-reminders/route.ts',
    'src/app/api/internal/email/retry-failed/route.ts',
  ]

  it('4. every internal email route refuses to run when INTERNAL_CRON_SECRET is unset (closed by default)', () => {
    for (const rel of internalRoutes) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf-8')
      expect(content, rel).toMatch(/INTERNAL_CRON_SECRET/)
      expect(content, rel).toMatch(/if \(!secret\)/)
    }
  })

  it('5. every internal email route compares the Authorization header against the configured secret', () => {
    for (const rel of internalRoutes) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf-8')
      expect(content, rel).toMatch(/Bearer \$\{secret\}/)
    }
  })

  it('6. the admin email-previews page is gated by the parent admin layout\'s requireAdmin(), not a public route', () => {
    const layout = readFileSync(join(REPO_ROOT, 'src/app/admin/layout.tsx'), 'utf-8')
    expect(layout).toMatch(/requireAdmin/)
    // The preview page itself does not send anything.
    const preview = readFileSync(join(REPO_ROOT, 'src/app/admin/email-previews/page.tsx'), 'utf-8')
    expect(preview).not.toMatch(/sendTemplate/)
    expect(preview).not.toMatch(/fetch\(/)
  })
})

describe('security: no sensitive data reaches provider logs (category: Security)', () => {
  it('7. the console provider logs only recipient/subject/messageId/a short text preview -- never the full HTML body or raw provider errors', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/lib/email/providers/console-provider.ts'), 'utf-8')
    expect(content).not.toMatch(/console\.log\([^)]*input\.html/)
    expect(content).toMatch(/textPreview: input\.text\.slice/)
  })

  it('8. the dispatch service never logs a raw provider error object, only err.name (a safe, bounded label)', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/lib/email/service.ts'), 'utf-8')
    expect(content).toMatch(/err instanceof Error \? err\.name/)
    expect(content).not.toMatch(/last_error.*err\.message/)
  })

  it('9. no ID/passport number, address, or provider payment reference field name appears anywhere in the template catalogue\'s var usage', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/lib/email/templates/catalogue.ts'), 'utf-8')
    for (const forbidden of ['idNumber', 'passportNumber', 'residentialAddress', 'providerReference', 'idReferenceNumber']) {
      expect(content, forbidden).not.toContain(forbidden)
    }
  })
})
