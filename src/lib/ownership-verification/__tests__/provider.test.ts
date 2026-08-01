import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { ManualOwnershipVerificationProvider, mapRpcError } from '../manual-provider'
import { SumsubOwnershipVerificationProvider } from '../sumsub-provider'
import { getOwnershipVerificationProvider, listRegisteredOwnershipVerificationProviders } from '../registry'
import { OwnershipVerificationError } from '../types'

/** Minimal fake Supabase client -- enough surface for ManualOwnershipVerificationProvider, no network/DB involved. */
function fakeAdmin(overrides: { rpcResult?: { data?: unknown; error?: { message: string } | null }; selectResult?: { data?: unknown } } = {}) {
  const rpc = async () => overrides.rpcResult ?? { data: null, error: null }
  const maybeSingle = async () => overrides.selectResult ?? { data: null }
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle,
  }
  return {
    rpc,
    from: () => chain,
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('ManualOwnershipVerificationProvider', () => {
  const provider = new ManualOwnershipVerificationProvider()

  it('is registered under the name "manual"', () => {
    expect(provider.name).toBe('manual')
  })

  it('startReview maps the RPC result into the normalized shape', async () => {
    const admin = fakeAdmin({ rpcResult: { data: { listing_id: 'l1', ownership_verification_status: 'under_review' }, error: null } })
    const result = await provider.startReview({ admin }, 'l1', 'admin1')
    expect(result).toEqual({ listingId: 'l1', status: 'under_review' })
  })

  it('approveOwnership maps the RPC result into the normalized shape', async () => {
    const admin = fakeAdmin({ rpcResult: { data: { listing_id: 'l1', ownership_verification_status: 'verified' }, error: null } })
    const result = await provider.approveOwnership({ admin }, 'l1', 'admin1', 'meets_requirements', 'looks fine', 'Approved', undefined)
    expect(result).toEqual({ listingId: 'l1', status: 'verified' })
  })

  it('throws a normalized OwnershipVerificationError when the RPC errors', async () => {
    const admin = fakeAdmin({ rpcResult: { data: null, error: { message: 'ownership verification already has a final decision' } } })
    await expect(provider.rejectOwnership({ admin }, 'l1', 'admin1', null, null, null)).rejects.toThrow(OwnershipVerificationError)
  })

  it('getVerificationStatus returns the stored row when one exists', async () => {
    const admin = fakeAdmin({ selectResult: { data: { status: 'verified', provider: 'manual', reviewed_by: 'admin1', reviewed_at: '2026-01-01' } } })
    const result = await provider.getVerificationStatus({ admin }, 'l1')
    expect(result.status).toBe('verified')
    expect(result.reviewedBy).toBe('admin1')
  })

  it('getVerificationStatus defaults to "pending" for a risk tier that requires verification when no row exists yet', async () => {
    let call = 0
    const admin = {
      rpc: async () => ({ data: null, error: null }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              call += 1
              // first call: listing_ownership_verification -> no row; second call: listings -> risk_tier
              return call === 1 ? { data: null } : { data: { risk_tier: 'medium' } }
            },
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    const result = await provider.getVerificationStatus({ admin }, 'l1')
    expect(result.status).toBe('pending')
  })

  it('getVerificationStatus defaults to "not_required" for a low risk tier when no row exists yet', async () => {
    let call = 0
    const admin = {
      rpc: async () => ({ data: null, error: null }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              call += 1
              return call === 1 ? { data: null } : { data: { risk_tier: 'low' } }
            },
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    const result = await provider.getVerificationStatus({ admin }, 'l1')
    expect(result.status).toBe('not_required')
  })
})

describe('mapRpcError', () => {
  it.each([
    ['idempotency key already used with a different request', 'duplicate_conflict'],
    ['ownership verification already has a final decision', 'already_decided'],
    ['listing not found', 'not_found'],
    ['not authorized', 'not_authorized'],
    ['not authenticated', 'not_authorized'],
    ['something entirely unexpected', 'internal_error'],
  ])('%s -> %s', (message, code) => {
    expect(mapRpcError(message).code).toBe(code)
  })
})

describe('SumsubOwnershipVerificationProvider (future stub)', () => {
  it('is registered under the name "sumsub" and every method throws', async () => {
    const provider = new SumsubOwnershipVerificationProvider()
    expect(provider.name).toBe('sumsub')
    await expect(provider.startReview({ admin: fakeAdmin() }, 'l1', 'a1')).rejects.toThrow()
    await expect(provider.getVerificationStatus({ admin: fakeAdmin() }, 'l1')).rejects.toThrow()
  })
})

describe('ownership verification provider registry', () => {
  it('registers both manual and sumsub', () => {
    expect(listRegisteredOwnershipVerificationProviders().sort()).toEqual(['manual', 'sumsub'])
  })

  it('defaults to manual when no override is set', () => {
    expect(getOwnershipVerificationProvider().name).toBe('manual')
  })

  it('returns the requested provider by name', () => {
    expect(getOwnershipVerificationProvider('sumsub').name).toBe('sumsub')
  })

  it('throws for an unknown provider name', () => {
    expect(() => getOwnershipVerificationProvider('unknown')).toThrow(/Unknown ownership verification provider/)
  })
})

/**
 * Architecture fitness: mirrors src/lib/payments/orchestrator/__tests__/architecture.test.ts
 * from Phase 2C -- confirms admin routes/moderation code import the
 * OwnershipVerificationService abstraction (getOwnershipVerificationProvider),
 * never ManualOwnershipVerificationProvider directly outside its own
 * registration in registry.ts. Directly satisfies test #32 from the Step 3 brief.
 */
describe('architecture fitness: ownership verification stays provider-neutral', () => {
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

  it('no admin route or moderation-service file imports ManualOwnershipVerificationProvider directly', () => {
    const candidateDirs = [path.join(srcRoot, 'src/app/api/admin'), path.join(srcRoot, 'src/lib/listings')]
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
        // Only flags an actual import, not a doc-comment mention of the class name.
        if (/from\s+['"][^'"]*manual-provider['"]/.test(content)) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every admin ownership route imports getOwnershipVerificationProvider from the registry barrel, not a concrete provider', () => {
    const ownershipDir = path.join(srcRoot, 'src/app/api/admin/listings/[id]/ownership')
    const files = listFilesRecursive(ownershipDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('getOwnershipVerificationProvider')
    }
  })
})
