import { describe, it, expect, vi } from 'vitest'
import {
  describeBlockedCategories,
  parseEraseAccountResult,
  eraseAccount,
  runPostErasureCleanup,
  mapAccountErasureRpcError,
} from '../account-erasure'

describe('describeBlockedCategories (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-I)', () => {
  it('1. maps every known category to a safe, generic label never naming a specific record', () => {
    const labels = describeBlockedCategories(['active_booking', 'open_dispute'])
    expect(labels).toEqual(['an active or pending rental booking', 'an unresolved dispute'])
    for (const label of labels) {
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i) // never a uuid
    }
  })
  it('2. falls back to a generic label for an unrecognized category rather than throwing', () => {
    expect(describeBlockedCategories(['some_future_category'])).toEqual(['an unresolved obligation'])
  })
  it('3. an empty list maps to an empty list', () => {
    expect(describeBlockedCategories([])).toEqual([])
  })
})

describe('parseEraseAccountResult', () => {
  it('4. a blocked RPC result is parsed with its categories', () => {
    const result = parseEraseAccountResult({ blocked: true, blocked_categories: ['active_booking'] })
    expect(result).toEqual({ blocked: true, blockedCategories: ['active_booking'] })
  })
  it('5. a completed RPC result is parsed as not blocked, not already erased', () => {
    const result = parseEraseAccountResult({ blocked: false, already_erased: false })
    expect(result).toEqual({ blocked: false, alreadyErased: false })
  })
  it('6. an idempotent replay of an already-erased account is parsed with alreadyErased true', () => {
    const result = parseEraseAccountResult({ blocked: false, already_erased: true })
    expect(result).toEqual({ blocked: false, alreadyErased: true })
  })
  it('7. null/missing data never throws', () => {
    expect(parseEraseAccountResult(null)).toEqual({ blocked: false, alreadyErased: false })
  })
})

/**
 * A minimal fake admin client covering exactly what runPostErasureCleanup
 * touches: account_erasure_cleanup (read current status, upsert new status),
 * storage.from('avatars'|'kyc-documents').list/.remove(), and
 * auth.admin.updateUserById(). `cleanupRow` seeds the existing status row
 * (null = none yet, i.e. first attempt).
 */
function fakeAdmin(opts: {
  cleanupRow?: { auth_ban_complete: boolean; avatar_cleanup_complete: boolean; kyc_cleanup_complete: boolean; attempt_count: number } | null
  avatarListError?: boolean
  avatarRemoveError?: boolean
  kycListError?: boolean
  kycRemoveError?: boolean
  authBanError?: boolean
  avatarFiles?: { name: string }[]
  kycFiles?: { name: string }[]
} = {}) {
  const upsertCalls: unknown[] = []
  const removeCalls: Array<{ bucket: string; paths: string[] }> = []
  const updateUserById = vi.fn().mockImplementation(async () => {
    if (opts.authBanError) return { data: null, error: { message: 'auth admin unavailable' } }
    return { data: {}, error: null }
  })

  return {
    from: (table: string) => {
      if (table === 'account_erasure_cleanup') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.cleanupRow ?? null, error: null }),
            }),
          }),
          upsert: async (row: unknown) => {
            upsertCalls.push(row)
            return { data: row, error: null }
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    storage: {
      from: (bucket: 'avatars' | 'kyc-documents') => ({
        list: async () => {
          if (bucket === 'avatars') {
            if (opts.avatarListError) return { data: null, error: { message: 'list failed' } }
            return { data: opts.avatarFiles ?? [], error: null }
          }
          if (opts.kycListError) return { data: null, error: { message: 'list failed' } }
          return { data: opts.kycFiles ?? [], error: null }
        },
        remove: async (paths: string[]) => {
          removeCalls.push({ bucket, paths })
          if (bucket === 'avatars' && opts.avatarRemoveError) return { data: null, error: { message: 'remove failed' } }
          if (bucket === 'kyc-documents' && opts.kycRemoveError) return { data: null, error: { message: 'remove failed' } }
          return { data: null, error: null }
        },
      }),
    },
    auth: { admin: { updateUserById } },
    _mocks: { upsertCalls, removeCalls, updateUserById },
  }
}

describe('eraseAccount RPC wrapper', () => {
  it('8. calls erase_account with the exact expected parameter names', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blocked: false, already_erased: false }, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await eraseAccount({ rpc } as any, 'user-1', 'actor-1', 'self_service', 'key-123')
    expect(rpc).toHaveBeenCalledWith('erase_account', {
      p_user_id: 'user-1',
      p_actor_id: 'actor-1',
      p_request_source: 'self_service',
      p_idempotency_key: 'key-123',
    })
  })
  it('9. an undefined idempotency key is passed through as null, never undefined', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await eraseAccount({ rpc } as any, 'user-1', 'admin-1', 'admin', undefined)
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBeNull()
  })
})

describe('runPostErasureCleanup (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F1)', () => {
  it('10. first attempt, everything succeeds -- complete, and the status row is upserted with all three flags true', async () => {
    const admin = fakeAdmin({ cleanupRow: null, avatarFiles: [{ name: 'photo.jpg' }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-1')
    expect(result).toEqual({ complete: true, pending: [] })
    expect(admin._mocks.removeCalls).toContainEqual({ bucket: 'avatars', paths: ['user-1/photo.jpg'] })
    expect(admin._mocks.upsertCalls[0]).toMatchObject({
      user_id: 'user-1',
      auth_ban_complete: true,
      avatar_cleanup_complete: true,
      kyc_cleanup_complete: true,
      attempt_count: 1,
    })
  })

  it('11. an empty listing counts as success -- no remove call, still complete', async () => {
    const admin = fakeAdmin({ cleanupRow: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-2')
    expect(result.complete).toBe(true)
    expect(admin._mocks.removeCalls).toHaveLength(0)
  })

  it('12. auth ban failure is reported as pending, not swallowed as success', async () => {
    const admin = fakeAdmin({ cleanupRow: null, authBanError: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-3')
    expect(result).toEqual({ complete: false, pending: ['auth_identity_ban'] })
    expect(admin._mocks.upsertCalls[0]).toMatchObject({ auth_ban_complete: false, avatar_cleanup_complete: true, kyc_cleanup_complete: true })
  })

  it('13. avatar storage failure is reported as pending', async () => {
    const admin = fakeAdmin({ cleanupRow: null, avatarListError: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-4')
    expect(result.complete).toBe(false)
    expect(result.pending).toContain('avatar_cleanup')
  })

  it('14. kyc storage failure is reported as pending', async () => {
    const admin = fakeAdmin({ cleanupRow: null, kycRemoveError: true, kycFiles: [{ name: 'doc.jpg' }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-5')
    expect(result.complete).toBe(false)
    expect(result.pending).toContain('kyc_document_cleanup')
  })

  it('15. a retry only re-attempts categories NOT already recorded complete -- already-complete categories are never re-run', async () => {
    const admin = fakeAdmin({
      cleanupRow: { auth_ban_complete: true, avatar_cleanup_complete: true, kyc_cleanup_complete: false, attempt_count: 1 },
      kycFiles: [{ name: 'doc.jpg' }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-6')
    expect(result).toEqual({ complete: true, pending: [] })
    // Only the kyc bucket was ever listed/removed -- avatars was never touched again.
    expect(admin._mocks.removeCalls.every((c) => c.bucket === 'kyc-documents')).toBe(true)
    expect(admin._mocks.updateUserById).not.toHaveBeenCalled()
    expect(admin._mocks.upsertCalls[0]).toMatchObject({ attempt_count: 2 })
  })

  it('16. repeated retries are idempotent -- calling again after full completion stays complete with no further remove calls', async () => {
    const admin = fakeAdmin({
      cleanupRow: { auth_ban_complete: true, avatar_cleanup_complete: true, kyc_cleanup_complete: true, attempt_count: 3 },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-7')
    expect(result).toEqual({ complete: true, pending: [] })
    expect(admin._mocks.removeCalls).toHaveLength(0)
    expect(admin._mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('17. never throws even if the status-row read/write itself fails', async () => {
    const admin = fakeAdmin({ cleanupRow: null })
    admin.from = () => {
      throw new Error('db unavailable')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runPostErasureCleanup(admin as any, 'user-8')).resolves.toBeDefined()
  })

  it('18. storage/auth categories are safe, generic labels -- never a raw path or provider error', async () => {
    const admin = fakeAdmin({ cleanupRow: null, authBanError: true, avatarListError: true, kycListError: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runPostErasureCleanup(admin as any, 'user-9')
    for (const category of result.pending) {
      expect(category).toMatch(/^(avatar_cleanup|kyc_document_cleanup|auth_identity_ban)$/)
    }
  })
})

describe('mapAccountErasureRpcError', () => {
  it('19. never forwards a raw Postgres error message to the client', () => {
    const mapped = mapAccountErasureRpcError('relation "foo" does not exist')
    expect(mapped.status).toBe(500)
    expect(mapped.error).not.toMatch(/relation|postgres|sql/i)
  })
  it('20. maps the self-erasure-via-admin-path rejection to a safe 403', () => {
    const mapped = mapAccountErasureRpcError('use the self-service erasure flow for your own account')
    expect(mapped.status).toBe(403)
  })
  it('21. maps user not found to 404', () => {
    expect(mapAccountErasureRpcError('user not found').status).toBe(404)
  })
  it('22. maps an idempotency conflict to 409', () => {
    expect(mapAccountErasureRpcError('idempotency key already used with a different request').status).toBe(409)
  })
})
