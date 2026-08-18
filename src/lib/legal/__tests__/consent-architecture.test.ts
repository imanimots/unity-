import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

describe('consent capture wiring (category: Consent)', () => {
  it('23. registration records terms/privacy/popia acceptance after signup', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(auth)/register/page.tsx'), 'utf-8')
    expect(content).toMatch(/\/api\/legal\/accept/)
    expect(content).toMatch(/context:\s*'registration'/)
  })

  it('24. booking request records rental-terms/cancellations/delivery-and-handover acceptance, and the button is gated on an explicit (unchecked-by-default) checkbox', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(marketing)/listings/[id]/book/booking-flow.tsx'), 'utf-8')
    expect(content).toMatch(/\/api\/legal\/accept/)
    expect(content).toMatch(/context:\s*'booking_request'/)
    expect(content).toMatch(/useState\(false\)/) // agreedToTerms starts false -- not preselected
    expect(content).toMatch(/disabled=\{submitting \|\| !agreedToTerms\}/)
  })

  it('25. checkout records payments-and-deposits/refunds acceptance, gated on an explicit checkbox', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/renter/bookings/[id]/checkout/checkout-flow.tsx'),
      'utf-8'
    )
    expect(content).toMatch(/\/api\/legal\/accept/)
    expect(content).toMatch(/context:\s*'checkout'/)
    expect(content).toMatch(/disabled=\{submitting \|\| !agreedToPaymentTerms\}/)
  })

  it('26. verification submission records popia/verification-and-trust acceptance, gated on an explicit checkbox', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/[locale]/(auth)/verify/kyc-flow.tsx'), 'utf-8')
    expect(content).toMatch(/\/api\/legal\/accept/)
    expect(content).toMatch(/context:\s*'verification'/)
    expect(content).toMatch(/agreedToVerificationTerms/)
  })

  it('27. listing submission reuses the existing declaration mechanism, not a new one', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'src/app/[locale]/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx'),
      'utf-8'
    )
    expect(content).toMatch(/DECLARATION_CATALOGUE/)
    expect(content).not.toMatch(/\/api\/legal\/accept/)
  })
})

describe('POST /api/legal/accept trust boundary (category: Consent + Security)', () => {
  const routeContent = readFileSync(join(REPO_ROOT, 'src/app/api/legal/accept/route.ts'), 'utf-8')

  it('28. the request schema accepts only policy slugs and a context enum -- no version, user id, or timestamp field', () => {
    expect(routeContent).toMatch(/policies:\s*z\.array/)
    expect(routeContent).toMatch(/context:\s*z\.enum/)
    expect(routeContent).not.toMatch(/policy_version:\s*z\./)
    expect(routeContent).not.toMatch(/user_id:\s*z\./)
  })

  it('29. the recorded user id always comes from the verified session, never the request body', () => {
    expect(routeContent).toMatch(/getRequestProfile/)
    expect(routeContent).toMatch(/user_id:\s*requester\.userId/)
  })

  it('30. the recorded policy version is always resolved server-side from the registry, never taken from the client', () => {
    expect(routeContent).toMatch(/resolvePolicyVersions/)
  })

  it('31. inserts use the service-role client, never a session-scoped client, matching the immutable-append-only trust boundary', () => {
    expect(routeContent).toMatch(/createServiceClient/)
    expect(routeContent).toMatch(/\.from\('legal_acceptances'\)\.insert/)
  })
})

describe('legal_acceptances migration invariants (category: Privacy + Security)', () => {
  const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260806000001_legal_acceptances.sql')
  const sql = readFileSync(migrationPath, 'utf-8')

  it('32. no insert/update/delete policy exists for anon or authenticated -- only a read policy', () => {
    expect(sql).toMatch(/create policy "legal_acceptances: own read"/)
    expect(sql).not.toMatch(/create policy.*legal_acceptances.*for insert/i)
    expect(sql).not.toMatch(/create policy.*legal_acceptances.*for update/i)
  })

  it('33. the table is immutable via the shared prevent_row_mutation trigger -- acceptance records append, never overwrite', () => {
    expect(sql).toMatch(/prevent_row_mutation/)
    expect(sql).toMatch(/before update or delete on public\.legal_acceptances/)
  })

  it('34. context is constrained to the four defined checkpoints, not an arbitrary string', () => {
    expect(sql).toMatch(/check \(context in \('registration', 'booking_request', 'checkout', 'verification'\)\)/)
  })
})
