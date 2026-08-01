import { describe, it, expect, vi } from 'vitest'
import { triggerLazyExpirySweep } from '../lazy-expiry'

function fakeAdmin(rpcImpl: (name: string) => Promise<unknown>) {
  return { rpc: vi.fn(rpcImpl) } as unknown as Parameters<typeof triggerLazyExpirySweep>[0]
}

describe('triggerLazyExpirySweep (category: Lazy Expiry)', () => {
  it('1. calls expire_unpaid_accepted_bookings via the admin client', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { expired_count: 0, skipped_ready_count: 0 }, error: null })
    const admin = { rpc } as unknown as Parameters<typeof triggerLazyExpirySweep>[0]
    await triggerLazyExpirySweep(admin)
    expect(rpc).toHaveBeenCalledWith('expire_unpaid_accepted_bookings')
  })

  it('2. never throws when the RPC call rejects -- a failed sweep must not break the caller', async () => {
    const admin = fakeAdmin(() => Promise.reject(new Error('boom')))
    await expect(triggerLazyExpirySweep(admin)).resolves.toBeNull()
  })

  it('3. never throws when the RPC call itself throws synchronously', async () => {
    const admin = {
      rpc: () => {
        throw new Error('sync boom')
      },
    } as unknown as Parameters<typeof triggerLazyExpirySweep>[0]
    await expect(triggerLazyExpirySweep(admin)).resolves.toBeNull()
  })
})
