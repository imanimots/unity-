import { describe, it, expect, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createEscrowForPayment, fundEscrowForPayment, releaseEscrowForPayment } from '../orchestrator'

/**
 * Proves the safe-by-default contract directly: with ESCROW_ENABLED
 * unset (or anything other than "true"), every orchestrator function
 * must early-return null WITHOUT ever touching the Supabase client or a
 * provider. A throwing stub in place of `admin` makes any accidental
 * DB call fail the test loudly rather than silently succeeding.
 */
function throwingAdminStub(): SupabaseClient {
  return {
    from: () => {
      throw new Error('escrow orchestrator must not query the database while disabled')
    },
    rpc: () => {
      throw new Error('escrow orchestrator must not call an RPC while disabled')
    },
  } as unknown as SupabaseClient
}

describe('escrow orchestrator: safe-by-default when ESCROW_ENABLED is not "true"', () => {
  const original = process.env.ESCROW_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.ESCROW_ENABLED
    else process.env.ESCROW_ENABLED = original
  })

  it('createEscrowForPayment is a no-op', async () => {
    delete process.env.ESCROW_ENABLED
    const result = await createEscrowForPayment(throwingAdminStub(), {
      transactionType: 'sale',
      orderId: 'order-1',
      paymentId: 'payment-1',
      principalAmount: 100,
    })
    expect(result).toBeNull()
  })

  it('fundEscrowForPayment is a no-op', async () => {
    process.env.ESCROW_ENABLED = 'false'
    const result = await fundEscrowForPayment(throwingAdminStub(), 'payment-1')
    expect(result).toBeNull()
  })

  it('releaseEscrowForPayment is a no-op', async () => {
    process.env.ESCROW_ENABLED = 'no'
    const result = await releaseEscrowForPayment(throwingAdminStub(), 'payment-1', 'recipient-1')
    expect(result).toBeNull()
  })
})
