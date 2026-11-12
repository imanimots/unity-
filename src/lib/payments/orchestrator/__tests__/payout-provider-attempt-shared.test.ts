import { describe, it, expect, vi } from 'vitest'
import { resolvePayoutDestinationDetails, classifyProviderCallError, applyPayoutWebhookPayload } from '../payout-provider-attempt-shared'
import { OrchestrationError } from '../errors'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../provider-errors'

function fakeAdmin(options: {
  destinationRow?: Record<string, unknown> | null
  bankRow?: Record<string, unknown> | null
  identityRow?: Record<string, unknown> | null
  accountNumberResult?: { data?: unknown; error?: unknown }
  attemptRow?: Record<string, unknown> | null
  completeResult?: { data?: unknown; error?: unknown }
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    if (name === 'get_payout_destination_account_number') return options.accountNumberResult ?? { data: '1234567890', error: null }
    if (name.startsWith('complete_')) return options.completeResult ?? { data: { ok: true, domain_transitioned: true }, error: null }
    throw new Error(`unexpected rpc: ${name}`)
  })

  const chains: Record<string, unknown> = {
    payout_destinations: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: options.destinationRow === undefined ? { owner_id: 'owner-1', universal_branch_code: '250655', bank_code: 'fnb' } : options.destinationRow, error: null }),
    },
    payout_banks: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: options.bankRow === undefined ? { peach_payout_bank_name: 'FNB' } : options.bankRow, error: null }),
    },
    identity_verifications: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: options.identityRow === undefined ? { status: 'approved', legal_first_name: 'Jane', legal_surname: 'Smith' } : options.identityRow, error: null }),
    },
    payout_provider_attempts: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: options.attemptRow === undefined ? { id: 'attempt-1', merchant_payout_id: 'payout-1' } : options.attemptRow, error: null }),
    },
  }
  const from = vi.fn((table: string) => {
    const chain = chains[table]
    if (!chain) throw new Error(`unexpected table: ${table}`)
    return chain
  })
  return { admin: { rpc, from } as never, rpcCalls }
}

describe('resolvePayoutDestinationDetails', () => {
  it('1. resolves account number, branch code, bank name, and a fresh account holder built from approved identity', async () => {
    const { admin } = fakeAdmin({})
    const result = await resolvePayoutDestinationDetails(admin, 'dest-1')
    expect(result).toEqual({ accountNumber: '1234567890', branchCode: '250655', bankName: 'FNB', accountHolder: 'Jane Smith' })
  })

  it('2. fails closed when identity is not currently approved, even if it was approved at BANV-submission time', async () => {
    const { admin } = fakeAdmin({ identityRow: { status: 'pending', legal_first_name: 'Jane', legal_surname: 'Smith' } })
    await expect(resolvePayoutDestinationDetails(admin, 'dest-1')).rejects.toBeInstanceOf(OrchestrationError)
  })

  it('3. fails closed when no identity_verifications row exists at all', async () => {
    const { admin } = fakeAdmin({ identityRow: null })
    await expect(resolvePayoutDestinationDetails(admin, 'dest-1')).rejects.toBeInstanceOf(OrchestrationError)
  })

  it('4. fails closed when the destination bank has no confirmed Peach payout bankName mapping', async () => {
    const { admin } = fakeAdmin({ bankRow: { peach_payout_bank_name: null } })
    await expect(resolvePayoutDestinationDetails(admin, 'dest-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
  })

  it('5. fails closed when the destination does not exist', async () => {
    const { admin } = fakeAdmin({ destinationRow: null })
    await expect(resolvePayoutDestinationDetails(admin, 'dest-1')).rejects.toBeInstanceOf(OrchestrationError)
  })
})

describe('classifyProviderCallError', () => {
  it('6. a TerminalProviderError is terminal:true (authoritative rejection, safe to mark failed)', () => {
    expect(classifyProviderCallError(new TerminalProviderError('peach', 'createPayout'))).toMatchObject({ terminal: true })
  })

  it('7. a ProviderTimeoutError is terminal:false (ambiguous -- Peach may have received it)', () => {
    expect(classifyProviderCallError(new ProviderTimeoutError('peach', 'createPayout'))).toMatchObject({ terminal: false, reason: 'provider_timeout' })
  })

  it('8. a RetryableProviderError is terminal:false', () => {
    expect(classifyProviderCallError(new RetryableProviderError('peach', 'createPayout'))).toMatchObject({ terminal: false, reason: 'retryable_provider_error' })
  })

  it('9. an unrecognized thrown value is terminal:false -- never assumed safe to mark failed', () => {
    expect(classifyProviderCallError(new Error('something strange'))).toMatchObject({ terminal: false })
    expect(classifyProviderCallError('a raw string throw')).toMatchObject({ terminal: false })
  })
})

describe('applyPayoutWebhookPayload', () => {
  it('10. returns null (fails closed) on an unrecognized payload shape, without calling any RPC', async () => {
    const { admin, rpcCalls } = fakeAdmin({})
    const result = await applyPayoutWebhookPayload(admin, { unexpected: 'shape' })
    expect(result).toBeNull()
    expect(rpcCalls).toEqual([])
  })

  it('11. returns null when the payoutId is not found among known attempts', async () => {
    const { admin } = fakeAdmin({ attemptRow: null })
    const result = await applyPayoutWebhookPayload(admin, { payoutId: 'unknown-payout', status: 'successful' })
    expect(result).toBeNull()
  })

  it('12. routes to complete_merchant_payout_provider_attempt when the attempt has a merchant_payout_id', async () => {
    const { admin, rpcCalls } = fakeAdmin({ attemptRow: { id: 'attempt-1', merchant_payout_id: 'payout-1' } })
    await applyPayoutWebhookPayload(admin, { payoutId: 'payout-uuid-1', status: 'successful', resultCode: '2002.000.000', lastUpdated: '2026-11-12T00:00:00Z' })
    expect(rpcCalls[0].name).toBe('complete_merchant_payout_provider_attempt')
    expect(rpcCalls[0].params).toMatchObject({ p_attempt_id: 'attempt-1', p_provider_status: 'successful', p_source: 'webhook' })
  })

  it('13. routes to complete_affiliate_payout_provider_attempt when the attempt has no merchant_payout_id', async () => {
    const { admin, rpcCalls } = fakeAdmin({ attemptRow: { id: 'attempt-2', merchant_payout_id: null } })
    await applyPayoutWebhookPayload(admin, { payoutId: 'payout-uuid-2', status: 'failed' })
    expect(rpcCalls[0].name).toBe('complete_affiliate_payout_provider_attempt')
  })

  it('14. rejects an unrecognized status value', async () => {
    const { admin, rpcCalls } = fakeAdmin({})
    const result = await applyPayoutWebhookPayload(admin, { payoutId: 'payout-uuid-1', status: 'not-a-real-status' })
    expect(result).toBeNull()
    expect(rpcCalls).toEqual([])
  })
})
