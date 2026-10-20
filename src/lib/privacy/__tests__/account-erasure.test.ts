import { describe, it, expect, vi } from 'vitest'
import {
  describeBlockedCategories,
  parseEraseAccountResult,
  eraseAccount,
  cleanupErasedAccountStorage,
  disableErasedAccountAuthIdentity,
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

function fakeAdmin() {
  const rpc = vi.fn().mockResolvedValue({ data: { blocked: false, already_erased: false }, error: null })
  const storageList = vi.fn().mockResolvedValue({ data: [], error: null })
  const storageRemove = vi.fn().mockResolvedValue({ data: null, error: null })
  const updateUserById = vi.fn().mockResolvedValue({ data: {}, error: null })
  return {
    rpc,
    storage: { from: () => ({ list: storageList, remove: storageRemove }) },
    auth: { admin: { updateUserById } },
    _mocks: { rpc, storageList, storageRemove, updateUserById },
  }
}

describe('eraseAccount RPC wrapper', () => {
  it('8. calls erase_account with the exact expected parameter names', async () => {
    const admin = fakeAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await eraseAccount(admin as any, 'user-1', 'actor-1', 'self_service', 'key-123')
    expect(admin._mocks.rpc).toHaveBeenCalledWith('erase_account', {
      p_user_id: 'user-1',
      p_actor_id: 'actor-1',
      p_request_source: 'self_service',
      p_idempotency_key: 'key-123',
    })
  })
  it('9. an undefined idempotency key is passed through as null, never undefined', async () => {
    const admin = fakeAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await eraseAccount(admin as any, 'user-1', 'admin-1', 'admin', undefined)
    expect(admin._mocks.rpc.mock.calls[0][1].p_idempotency_key).toBeNull()
  })
})

describe('cleanupErasedAccountStorage (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-I)', () => {
  it('10. lists and removes only the target user-scoped prefix in avatars and both kyc-documents subfolders', async () => {
    const admin = fakeAdmin()
    admin._mocks.storageList.mockResolvedValue({ data: [{ name: 'photo.jpg' }], error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanupErasedAccountStorage(admin as any, 'user-1')
    expect(admin._mocks.storageRemove).toHaveBeenCalledWith(['user-1/photo.jpg'])
    // avatars (1 list) + identity_document + proof_of_address = 3 list calls
    expect(admin._mocks.storageList).toHaveBeenCalledTimes(3)
  })
  it('11. an empty listing performs no remove call', async () => {
    const admin = fakeAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanupErasedAccountStorage(admin as any, 'user-2')
    expect(admin._mocks.storageRemove).not.toHaveBeenCalled()
  })
  it('12. a storage error never throws -- cleanup is best-effort', async () => {
    const admin = fakeAdmin()
    admin._mocks.storageList.mockRejectedValue(new Error('network error'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cleanupErasedAccountStorage(admin as any, 'user-3')).resolves.toBeUndefined()
  })
})

describe('disableErasedAccountAuthIdentity', () => {
  it('13. bans the auth identity with a long (effectively permanent) duration rather than deleting it', async () => {
    const admin = fakeAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await disableErasedAccountAuthIdentity(admin as any, 'user-1')
    expect(admin._mocks.updateUserById).toHaveBeenCalledWith('user-1', { ban_duration: '876000h' })
  })
  it('14. an auth-admin failure never throws -- best-effort, logged only', async () => {
    const admin = fakeAdmin()
    admin._mocks.updateUserById.mockRejectedValue(new Error('auth admin unavailable'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(disableErasedAccountAuthIdentity(admin as any, 'user-1')).resolves.toBeUndefined()
  })
})

describe('runPostErasureCleanup', () => {
  it('15. runs both storage cleanup and auth-identity disable', async () => {
    const admin = fakeAdmin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostErasureCleanup(admin as any, 'user-1')
    expect(admin._mocks.storageList).toHaveBeenCalled()
    expect(admin._mocks.updateUserById).toHaveBeenCalled()
  })
})

describe('mapAccountErasureRpcError', () => {
  it('16. never forwards a raw Postgres error message to the client', () => {
    const mapped = mapAccountErasureRpcError('relation "foo" does not exist')
    expect(mapped.status).toBe(500)
    expect(mapped.error).not.toMatch(/relation|postgres|sql/i)
  })
  it('17. maps the self-erasure-via-admin-path rejection to a safe 403', () => {
    const mapped = mapAccountErasureRpcError('use the self-service erasure flow for your own account')
    expect(mapped.status).toBe(403)
  })
  it('18. maps user not found to 404', () => {
    expect(mapAccountErasureRpcError('user not found').status).toBe(404)
  })
  it('19. maps an idempotency conflict to 409', () => {
    expect(mapAccountErasureRpcError('idempotency key already used with a different request').status).toBe(409)
  })
})
