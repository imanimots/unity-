import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { ManualIdentityVerificationProvider, mapRpcError } from '../manual-provider'
import { SumsubIdentityVerificationProvider } from '../sumsub-provider'
import { getIdentityVerificationProvider, listRegisteredIdentityVerificationProviders } from '../registry'
import { IdentityVerificationError } from '../types'

/** Minimal fake Supabase client -- enough surface for ManualIdentityVerificationProvider, no network/DB involved. Mirrors src/lib/ownership-verification/__tests__/provider.test.ts (Step 3). */
function fakeAdmin(overrides: { rpcResult?: { data?: unknown; error?: { message: string } | null }; selectResult?: { data?: unknown } } = {}) {
  const rpc = async () => overrides.rpcResult ?? { data: null, error: null }
  const maybeSingle = async () => overrides.selectResult ?? { data: null }
  const chain = { select: () => chain, eq: () => chain, maybeSingle }
  return { rpc, from: () => chain } as unknown as import('@supabase/supabase-js').SupabaseClient
}

const SAMPLE_INPUT = {
  legalFirstName: 'Jane',
  legalSurname: 'Doe',
  dateOfBirth: '1990-01-01',
  idReferenceType: 'sa_id' as const,
  idReferenceNumber: '9001015800080',
  nationality: 'South African',
  countryOfResidence: 'South Africa',
  residentialAddress: '1 Main Road, Johannesburg',
}

describe('ManualIdentityVerificationProvider', () => {
  const provider = new ManualIdentityVerificationProvider()

  it('is registered under the name "manual"', () => {
    expect(provider.name).toBe('manual')
  })

  it('submitVerification maps the RPC result into the normalized shape', async () => {
    const admin = fakeAdmin({ rpcResult: { data: { user_id: 'u1', status: 'pending', review_count: 0 }, error: null } })
    const result = await provider.submitVerification({ admin }, 'u1', SAMPLE_INPUT)
    expect(result).toEqual({ userId: 'u1', status: 'pending', reviewCount: 0 })
  })

  it('startReview maps the RPC result into the normalized shape', async () => {
    const admin = fakeAdmin({ rpcResult: { data: { user_id: 'u1', status: 'under_review' }, error: null } })
    const result = await provider.startReview({ admin }, 'u1', 'admin1')
    expect(result).toEqual({ userId: 'u1', status: 'under_review' })
  })

  it('approve maps the RPC result into the normalized shape', async () => {
    const admin = fakeAdmin({ rpcResult: { data: { user_id: 'u1', status: 'approved' }, error: null } })
    const result = await provider.approve({ admin }, 'u1', 'admin1', 'meets_requirements', 'looks fine', 'Identity verified by Unity')
    expect(result).toEqual({ userId: 'u1', status: 'approved' })
  })

  it('throws a normalized IdentityVerificationError when the RPC errors', async () => {
    const admin = fakeAdmin({ rpcResult: { data: null, error: { message: 'identity verification already has a final decision' } } })
    await expect(provider.reject({ admin }, 'u1', 'admin1', null, null, null)).rejects.toThrow(IdentityVerificationError)
  })

  it('getStatus returns the stored row when one exists', async () => {
    const admin = fakeAdmin({ selectResult: { data: { status: 'approved', provider: 'manual', reviewed_by: 'admin1', reviewed_at: '2026-01-01' } } })
    const result = await provider.getStatus({ admin }, 'u1')
    expect(result.status).toBe('approved')
    expect(result.reviewedBy).toBe('admin1')
  })

  it('getStatus defaults to "not_started" when no row exists yet -- unlike ownership verification, KYC has no risk-tier-based implicit default', async () => {
    const admin = fakeAdmin({ selectResult: { data: null } })
    const result = await provider.getStatus({ admin }, 'u1')
    expect(result.status).toBe('not_started')
  })
})

describe('mapRpcError', () => {
  it.each([
    ['idempotency key already used with a different request', 'duplicate_conflict'],
    ['identity verification already has a final decision', 'already_decided'],
    ['identity verification is not in a resubmittable state', 'not_resubmittable'],
    ['no identity verification submission exists for this user', 'not_found'],
    ['not authorized', 'not_authorized'],
    ['not authenticated', 'not_authorized'],
    ['something entirely unexpected', 'internal_error'],
  ])('%s -> %s', (message, code) => {
    expect(mapRpcError(message).code).toBe(code)
  })
})

describe('SumsubIdentityVerificationProvider (future stub)', () => {
  it('is registered under the name "sumsub" and every method throws', async () => {
    const provider = new SumsubIdentityVerificationProvider()
    expect(provider.name).toBe('sumsub')
    await expect(provider.submitVerification({ admin: fakeAdmin() }, 'u1', SAMPLE_INPUT)).rejects.toThrow()
    await expect(provider.getStatus({ admin: fakeAdmin() }, 'u1')).rejects.toThrow()
  })
})

describe('identity verification provider registry', () => {
  it('registers both manual and sumsub', () => {
    expect(listRegisteredIdentityVerificationProviders().sort()).toEqual(['manual', 'sumsub'])
  })

  it('defaults to manual when no override is set', () => {
    expect(getIdentityVerificationProvider().name).toBe('manual')
  })

  it('returns the requested provider by name', () => {
    expect(getIdentityVerificationProvider('sumsub').name).toBe('sumsub')
  })

  it('throws for an unknown provider name', () => {
    expect(() => getIdentityVerificationProvider('unknown')).toThrow(/Unknown identity verification provider/)
  })
})

/**
 * Architecture fitness: mirrors
 * src/lib/ownership-verification/__tests__/provider.test.ts (Step 3) --
 * confirms admin verification routes import the
 * IdentityVerificationService abstraction (getIdentityVerificationProvider),
 * never ManualIdentityVerificationProvider directly outside its own
 * registration in registry.ts.
 */
describe('architecture fitness: identity verification stays provider-neutral', () => {
  const srcRoot = path.resolve(__dirname, '../../../..')

  function listFilesRecursive(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true })
    return entries.flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listFilesRecursive(full)
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) return [full]
      return []
    })
  }

  it('no admin route or verification-service file imports ManualIdentityVerificationProvider directly', () => {
    const candidateDirs = [path.join(srcRoot, 'src/app/api/admin/verifications'), path.join(srcRoot, 'src/app/api/verification'), path.join(srcRoot, 'src/lib/verification')]
    const offenders: string[] = []
    for (const dir of candidateDirs) {
      let files: string[] = []
      try {
        files = listFilesRecursive(dir)
      } catch {
        continue
      }
      for (const file of files) {
        const content = readFileSync(file, 'utf8')
        if (/from\s+['"][^'"]*manual-provider['"]/.test(content)) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every admin verification action route imports getIdentityVerificationProvider from the registry barrel, not a concrete provider', () => {
    const actionDirs = ['start', 'approve', 'reject', 'request-information'].map((a) => path.join(srcRoot, 'src/app/api/admin/verifications/[id]', a, 'route.ts'))
    for (const file of actionDirs) {
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('getIdentityVerificationProvider')
    }
  })

  it('the KYC eligibility predicate is used by listing activation and booking routes, not re-derived ad hoc', () => {
    const candidates = [
      path.join(srcRoot, 'src/lib/listings/activation.ts'),
      path.join(srcRoot, 'src/app/api/bookings/route.ts'),
      path.join(srcRoot, 'src/app/api/bookings/[id]/start/route.ts'),
    ]
    for (const file of candidates) {
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('isKycApproved')
    }
  })
})
