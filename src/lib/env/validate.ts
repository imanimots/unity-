/**
 * One centralized server-side environment validator (Step 10). Reports
 * variable NAMES only — never values — so a report can be safely logged
 * or shown in an admin page without leaking secrets.
 */

export type EnvCheckStatus = 'ok' | 'missing' | 'invalid'

export interface EnvCheck {
  name: string
  status: EnvCheckStatus
  required: boolean
  detail?: string
}

export interface EnvValidationReport {
  ok: boolean
  checks: EnvCheck[]
  criticalFailures: string[]
}

function check(name: string, value: string | undefined, opts: { required: boolean; allowed?: string[]; detail?: string }): EnvCheck {
  if (!value) {
    return { name, status: opts.required ? 'missing' : 'missing', required: opts.required, detail: opts.detail }
  }
  if (opts.allowed && !opts.allowed.includes(value)) {
    return { name, status: 'invalid', required: opts.required, detail: `expected one of: ${opts.allowed.join(', ')}` }
  }
  return { name, status: 'ok', required: opts.required, detail: opts.detail }
}

/**
 * Pure function — reads from the object passed in (defaults to
 * process.env) so it's trivially unit-testable without mutating real
 * process.env.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvValidationReport {
  const checks: EnvCheck[] = [
    check('NEXT_PUBLIC_SUPABASE_URL', env.NEXT_PUBLIC_SUPABASE_URL, { required: true }),
    check('NEXT_PUBLIC_SUPABASE_ANON_KEY', env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { required: true }),
    check('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY, { required: true }),
    check('NEXT_PUBLIC_APP_URL', env.NEXT_PUBLIC_APP_URL, { required: true }),
    check('NEXT_PUBLIC_MOCK_MODE', env.NEXT_PUBLIC_MOCK_MODE ?? 'false', { required: true, allowed: ['false', 'true'], detail: 'must be "false" for any real (non-demo) deployment' }),
    check('PAYMENT_PROVIDER', env.PAYMENT_PROVIDER ?? 'mock', { required: true, allowed: ['mock'], detail: 'must be "mock" — real Peach integration is out of scope for public test' }),
    check('OWNERSHIP_VERIFICATION_PROVIDER', env.OWNERSHIP_VERIFICATION_PROVIDER ?? 'manual', { required: true, allowed: ['manual'], detail: 'must be "manual" for public test' }),
    check('IDENTITY_VERIFICATION_PROVIDER', env.IDENTITY_VERIFICATION_PROVIDER ?? 'manual', { required: true, allowed: ['manual'], detail: 'must be "manual" for public test' }),
    check('EMAIL_PROVIDER', env.EMAIL_PROVIDER ?? 'console', { required: true, allowed: ['console', 'resend'] }),
    check('NEXT_PUBLIC_PAYMENT_MODE', env.NEXT_PUBLIC_PAYMENT_MODE ?? 'test', { required: true, allowed: ['test', 'production'], detail: 'gates the mock-checkout scenario selector; must be "test" during public test' }),
    check('INTERNAL_CRON_SECRET', env.INTERNAL_CRON_SECRET, { required: true, detail: 'protects the unpaid-expiry and email-sweep internal routes — required for those crons to ever run' }),

    // Optional
    check('SEO_INDEXING_ENABLED', env.SEO_INDEXING_ENABLED ?? 'false', { required: false, allowed: ['false', 'true'], detail: 'must stay "false" until a permanent domain, Search Console, legal approval, and real inventory are in place — see src/lib/seo/config.ts' }),
    check('SEO_MARKETPLACE_INDEXING_ENABLED', env.SEO_MARKETPLACE_INDEXING_ENABLED ?? 'false', { required: false, allowed: ['false', 'true'], detail: 'independent of SEO_INDEXING_ENABLED — must also stay "false" for now' }),
    check('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY, { required: false, detail: 'AI assistant falls back to a canned response when unset' }),
    check('RESEND_API_KEY', env.RESEND_API_KEY, { required: false, detail: 'only needed when EMAIL_PROVIDER=resend' }),
    check('VOYAGE_API_KEY', env.VOYAGE_API_KEY, { required: false, detail: 'assistant falls back to ILIKE search when unset' }),
  ]

  // Peach/Sumsub credentials must never be REQUIRED for this deployment —
  // explicitly assert none of them are silently expected. This is a
  // negative check: presence is fine (harmless, unused while providers
  // stay 'mock'/'manual'), but their ABSENCE must never fail validation.
  const neverRequired = [
    'PEACH_PAYMENTS_API_ENTITY_ID', 'PEACH_CHECKOUT_ENTITY_ID', 'PEACH_CARD_API_BACKOFFICE_BEARER_TOKEN',
    'SUMSUB_APP_TOKEN', 'SUMSUB_SECRET_KEY',
  ]
  for (const name of neverRequired) {
    checks.push({ name, status: 'ok', required: false, detail: 'not required — Peach/Sumsub integration is out of scope' })
  }

  const criticalFailures = checks.filter((c) => c.required && c.status !== 'ok').map((c) => c.name)

  return { ok: criticalFailures.length === 0, checks, criticalFailures }
}

/** Formats a report as names-and-statuses only — never prints a value. */
export function formatEnvReport(report: EnvValidationReport): string {
  const lines = ['Environment validation report:']
  for (const c of report.checks) {
    const marker = c.status === 'ok' ? 'OK' : c.status === 'missing' ? (c.required ? 'MISSING (required)' : 'unset (optional)') : 'INVALID'
    lines.push(`  [${marker}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  lines.push(report.ok ? 'Result: PASS' : `Result: FAIL — ${report.criticalFailures.join(', ')}`)
  return lines.join('\n')
}
