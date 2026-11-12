import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { loadPeachPayoutsConfig } from '../../providers/peach/payouts-config'

/**
 * E35: closes the specific gaps the phase brief's own §71/§72 test
 * lists named that were not yet covered by a dedicated test anywhere
 * in E32/E33/E34 -- "unknown provider host rejected", "credentials
 * never reach client", "raw bank data remains server-only", and "no
 * mass/backlog activation path exists". Everything else in those two
 * lists (gate-off, preview/sandbox host mismatch, duplicate webhook,
 * no-provider-call-without-eligible-destination, no-auto-retry, etc)
 * is already proven by E32/E32-R1/E33/E34's own existing tests -- not
 * duplicated here.
 */

const REPO_ROOT = join(__dirname, '../../../../..')

function allSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      out.push(...allSourceFiles(full))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

function isClientFile(content: string): boolean {
  const firstMeaningfulLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstMeaningfulLine.trim() === "'use client'" || firstMeaningfulLine.trim() === '"use client"'
}

describe('loadPeachPayoutsConfig -- unknown/custom host rejection (phase brief §52/§71)', () => {
  it('1. the resolved baseUrl is always one of exactly two hardcoded hosts, never derived from any env var -- an attempted override has zero effect', () => {
    const baseEnv = { PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1' }

    const withoutOverride = loadPeachPayoutsConfig({ ...baseEnv, PEACH_ENVIRONMENT: 'sandbox' } as unknown as NodeJS.ProcessEnv)
    const withAttemptedOverride = loadPeachPayoutsConfig({
      ...baseEnv,
      PEACH_ENVIRONMENT: 'sandbox',
      // None of these are ever read by loadPeachPayoutsConfig -- if any
      // had an effect, this test would catch it.
      PEACH_PAYOUTS_BASE_URL: 'https://evil.example.com',
      PEACH_PAYOUTS_HOST: 'evil.example.com',
      PEACH_BASE_URL: 'https://evil.example.com',
    } as unknown as NodeJS.ProcessEnv)

    expect(withoutOverride?.baseUrl).toBe(withAttemptedOverride?.baseUrl)
    expect(['https://sandbox-payouts.peachpayments.com/api', 'https://payouts.peachpayments.com/api']).toContain(withAttemptedOverride?.baseUrl)
  })

  it('2. the resolved authBaseUrl is likewise always one of exactly two hardcoded hosts, never env-derived', () => {
    const config = loadPeachPayoutsConfig({
      PEACH_PAYOUTS_CLIENT_ID: 'id',
      PEACH_PAYOUTS_CLIENT_SECRET: 'secret',
      PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1',
      PEACH_ENVIRONMENT: 'production',
      PEACH_AUTH_BASE_URL: 'https://evil.example.com',
    } as unknown as NodeJS.ProcessEnv)

    expect(['https://sandbox-dashboard.peachpayments.com', 'https://dashboard.peachpayments.com']).toContain(config?.authBaseUrl)
  })

  it('3. PEACH_ENVIRONMENT only ever resolves to exactly "sandbox" or "production" -- any other value throws rather than falling through to an unrecognized host', () => {
    const baseEnv = { PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1' }
    expect(() => loadPeachPayoutsConfig({ ...baseEnv, PEACH_ENVIRONMENT: 'staging' } as unknown as NodeJS.ProcessEnv)).toThrow()
    expect(() => loadPeachPayoutsConfig({ ...baseEnv, PEACH_ENVIRONMENT: 'qa' } as unknown as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('credentials never reach the client (phase brief §71)', () => {
  const clientFiles = allSourceFiles(join(REPO_ROOT, 'src/components/payouts'))
    .concat(allSourceFiles(join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/payout-settings')))
    .filter((f) => isClientFile(readFileSync(f, 'utf-8')))

  it('4. at least one client file was actually found to check (sanity -- a passing suite with zero files checked would be a false negative)', () => {
    expect(clientFiles.length).toBeGreaterThan(0)
  })

  it('5. no client component ("use client") anywhere in the new payout-destination UI references a Peach credential name', () => {
    const forbidden = [/PEACH_PAYOUTS_CLIENT_SECRET/, /PEACH_PAYOUTS_CLIENT_ID/, /PEACH_PAYOUTS_MERCHANT_ID/, /PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET/, /clientSecret/, /access_token/]
    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf-8')
      for (const pattern of forbidden) {
        expect(content, `${file} must not reference ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('6. no client component references vault.decrypted_secrets or the raw-secret RPC name directly', () => {
    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(/decrypted_secrets/)
      expect(content).not.toMatch(/get_payout_destination_account_number/)
    }
  })
})

describe('raw bank data remains server-only (phase brief §71/§82)', () => {
  it("7. the self-service GET /api/payout-destinations route never selects a raw account number or identity column in its own SELECT clause (the POST handler's account_number is the INCOMING new-destination field, not a leak -- scoped out by isolating the GET function body only)", () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/payout-destinations/route.ts'), 'utf-8')
    const getStart = content.indexOf('export async function GET()')
    const getEnd = content.indexOf('export async function POST(')
    const getBody = content.slice(getStart, getEnd)
    expect(getBody).not.toMatch(/account_number/)
    expect(getBody).not.toMatch(/id_reference_number/)
    expect(getBody).not.toMatch(/vault_secret/)
  })

  it('8. the bank catalog route never selects anything beyond the safe, documented column list', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/payout-banks/route.ts'), 'utf-8')
    expect(content).toMatch(/select\('bank_code, display_name, banv_supported'\)/)
  })
})

describe('no mass/backlog activation path exists (phase brief §36/§44/§57/§58)', () => {
  it('9. the merchant provider-execution route operates on exactly one payout id (a dynamic [id] segment), never a bulk/list endpoint', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/admin/payouts/[id]/execute-provider/route.ts'), 'utf-8')
    expect(content).toMatch(/const \{ id: payoutId \} = await params/)
    expect(content).not.toMatch(/\.in\(|\.limit\(/)
  })

  it('10. the affiliate cron sweep remains bounded by AFFILIATE_SWEEP_BATCH_LIMIT, never an unbounded query', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/internal/affiliate/process-payouts/route.ts'), 'utf-8')
    expect(content).toMatch(/AFFILIATE_SWEEP_BATCH_LIMIT/)
    expect(content).toMatch(/\.limit\(AFFILIATE_SWEEP_BATCH_LIMIT\)/)
  })

  it('11. no admin UI source contains a "pay all" / "process backlog" style bulk action', () => {
    const adminFiles = allSourceFiles(join(REPO_ROOT, 'src/app/admin/payouts')).concat(allSourceFiles(join(REPO_ROOT, 'src/app/admin/payout-provider-attempts')))
    const forbidden = /pay all|process backlog|process all|bulk process|mass process/i
    for (const file of adminFiles) {
      const content = readFileSync(file, 'utf-8')
      expect(content, `${file} must not offer a bulk payout action`).not.toMatch(forbidden)
    }
  })

  it('12. the new admin provider-attempts list route never selects raw bank data, and its only mutating action is a single-id reconcile (never a client-supplied final state)', () => {
    const listContent = readFileSync(join(REPO_ROOT, 'src/app/api/admin/payout-provider-attempts/route.ts'), 'utf-8')
    expect(listContent).not.toMatch(/account_number|vault_secret|access_token|client_secret/)
    const pageContent = readFileSync(join(REPO_ROOT, 'src/app/admin/payout-provider-attempts/page.tsx'), 'utf-8')
    expect(pageContent).toMatch(/\/reconcile/)
    expect(pageContent).not.toMatch(/p_provider_status:|body: JSON\.stringify\(\{\s*status/)
  })
})
