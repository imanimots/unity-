import { describe, it, expect, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createEscrowForPayment, fundEscrowForPayment, releaseEscrowForPayment, refundEscrowTransaction, EscrowOrchestrationError } from '../orchestrator'

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

/**
 * E25: partial escrow refunds are not currently supported -- no
 * transition anywhere accepts the resulting 'partially_refunded'
 * status as a source, so refundEscrowTransaction() must reject any
 * amount other than the full held principal BEFORE ever reaching the
 * provider or the database RPC. A throwing `.rpc()` stub proves the
 * database was never reached; since the thrown error is the literal
 * 'partial_refund_not_supported' error (not the stub's distinct "must
 * not call an RPC" error, and not a provider-origin error), the
 * rejection must have happened before either side effect.
 */
function escrowRowStub(principalAmount: number): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== 'escrow_transactions') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'escrow-1', status: 'funded', provider_reference: 'mock_escrow_ref', currency: 'ZAR', principal_amount: principalAmount },
            }),
          }),
        }),
      }
    },
    rpc: () => {
      throw new Error('must not reach the database RPC for a rejected partial refund')
    },
  } as unknown as SupabaseClient
}

describe('escrow orchestrator: refundEscrowTransaction rejects partial amounts before any side effect', () => {
  it('rejects an amount less than the full principal', async () => {
    const admin = escrowRowStub(1000)
    await expect(refundEscrowTransaction(admin, 'escrow-1', 'admin-1', 600, 'test reason')).rejects.toMatchObject({
      code: 'partial_refund_not_supported',
    })
  })

  it('rejects an amount greater than the full principal (not just "less than")', async () => {
    const admin = escrowRowStub(1000)
    await expect(refundEscrowTransaction(admin, 'escrow-1', 'admin-1', 1500, 'test reason')).rejects.toMatchObject({
      code: 'partial_refund_not_supported',
    })
  })

  it('the thrown error is an EscrowOrchestrationError instance with a safe, non-internal message', async () => {
    const admin = escrowRowStub(1000)
    try {
      await refundEscrowTransaction(admin, 'escrow-1', 'admin-1', 600, 'test reason')
      throw new Error('expected refundEscrowTransaction to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowOrchestrationError)
      expect((err as Error).message).toMatch(/full held principal amount/)
      expect((err as Error).message).not.toMatch(/sql|postgres|constraint|exception/i)
    }
  })
})
