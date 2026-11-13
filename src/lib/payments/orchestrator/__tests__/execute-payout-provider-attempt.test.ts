import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry')>()
  return { ...actual, getActivePaymentProvider: vi.fn() }
})
vi.mock('../../payout-execution/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../payout-execution/gate')>()
  return { ...actual, isPayoutExecutionEnabled: vi.fn() }
})
vi.mock('../../providers/peach/payouts-config', () => ({ loadPeachPayoutsConfig: vi.fn() }))
vi.mock('../payout-provider-attempt-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payout-provider-attempt-shared')>()
  return { ...actual, resolvePayoutDestinationDetails: vi.fn() }
})

import { getActivePaymentProvider, ProviderNotPermittedError } from '../../registry'
import { isPayoutExecutionEnabled } from '../../payout-execution/gate'
import { loadPeachPayoutsConfig } from '../../providers/peach/payouts-config'
import { resolvePayoutDestinationDetails } from '../payout-provider-attempt-shared'
import { executeMerchantPayoutProviderAttempt } from '../execute-merchant-payout-provider-attempt'
import { executeAffiliatePayoutProviderAttempt } from '../execute-affiliate-payout-provider-attempt'
import { OrchestrationError } from '../errors'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../provider-errors'

const DESTINATION_DETAILS = { accountNumber: '1234567890', branchCode: '250655', bankName: 'FNB', accountHolder: 'Jane Smith' }
const START_RESULT = { attempt_id: 'attempt-1', provider_payout_id: 'payout-uuid-1', destination_id: 'dest-1', amount: 500, amount_minor_units: 50000, currency: 'ZAR' }

function fakeAdmin(options: {
  startResult?: { data?: unknown; error?: unknown }
  completeResult?: { data?: unknown; error?: unknown }
  domainRow?: Record<string, unknown> | null
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    if (name === 'start_merchant_payout_provider_attempt' || name === 'start_affiliate_payout_provider_attempt') {
      return options.startResult ?? { data: START_RESULT, error: null }
    }
    if (name === 'complete_merchant_payout_provider_attempt' || name === 'complete_affiliate_payout_provider_attempt') {
      return options.completeResult ?? { data: { ok: true, domain_transitioned: true }, error: null }
    }
    throw new Error(`unexpected rpc call in test: ${name}`)
  })
  const domainChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.domainRow === undefined ? { merchant_id: 'merchant-1', affiliate_id: 'affiliate-1' } : options.domainRow }),
  }
  const from = vi.fn(() => domainChain)
  return { admin: { rpc, from } as never, rpcCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isPayoutExecutionEnabled).mockReturnValue(true)
  vi.mocked(resolvePayoutDestinationDetails).mockResolvedValue(DESTINATION_DETAILS)
  vi.mocked(loadPeachPayoutsConfig).mockReturnValue({
    environment: 'sandbox',
    baseUrl: 'https://sandbox-payouts.peachpayments.com/api',
    authBaseUrl: 'https://sandbox-dashboard.peachpayments.com',
    clientId: 'id',
    clientSecret: 'secret',
    merchantId: 'merchant-1',
    webhookSigningSecret: null,
  })
})

describe('executeMerchantPayoutProviderAttempt', () => {
  it('1. refuses outright when payout execution is not enabled, before calling any RPC', async () => {
    vi.mocked(isPayoutExecutionEnabled).mockReturnValue(false)
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    expect(rpcCalls).toEqual([])
  })

  it('2. refuses when the provider is not permitted (e.g. mock outside a permitted environment), before calling any RPC', async () => {
    vi.mocked(getActivePaymentProvider).mockImplementation(() => {
      throw new ProviderNotPermittedError('mock')
    })
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    expect(rpcCalls).toEqual([])
  })

  it('3. on a successful provider response, calls complete_merchant_payout_provider_attempt with source=create_response and the exact returned status', async () => {
    const createMerchantPayout = vi.fn().mockResolvedValue({ providerPayoutId: 'payout-uuid-1', providerRequestId: 'req-1', status: 'successful', resultCode: '2002.000.000' })
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')

    expect(result).toEqual({ attemptId: 'attempt-1', providerPayoutId: 'payout-uuid-1', outcome: 'submitted', status: 'successful' })
    const completeCall = rpcCalls.find((c) => c.name === 'complete_merchant_payout_provider_attempt')
    expect(completeCall?.params).toMatchObject({ p_attempt_id: 'attempt-1', p_provider_status: 'successful', p_source: 'create_response' })
  })

  it('4. passes exactly the resolved destination fields and the attempt-bound payoutId/amountMinorUnits to the provider -- never re-derives them', async () => {
    const createMerchantPayout = vi.fn().mockResolvedValue({ providerPayoutId: 'payout-uuid-1', status: 'pending' })
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin } = fakeAdmin({})

    await executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')

    expect(createMerchantPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutId: 'payout-uuid-1',
        amountMinorUnits: 50000,
        currency: 'ZAR',
        bankName: 'FNB',
        branchCode: '250655',
        accountNumber: '1234567890',
        accountHolder: 'Jane Smith',
      })
    )
  })

  it('5. CRITICAL: an ambiguous provider error (timeout) never calls complete_* -- the attempt is left unresolved for reconciliation, not marked failed', async () => {
    const createMerchantPayout = vi.fn().mockRejectedValue(new ProviderTimeoutError('peach', 'createPayout'))
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')

    expect(result.outcome).toBe('ambiguous')
    expect(result.ambiguousReason).toBe('provider_timeout')
    expect(rpcCalls.find((c) => c.name === 'complete_merchant_payout_provider_attempt')).toBeUndefined()
  })

  it('6. CRITICAL: a retryable/unknown network error is likewise ambiguous, never auto-marked failed', async () => {
    const createMerchantPayout = vi.fn().mockRejectedValue(new RetryableProviderError('peach', 'createPayout', 'network error'))
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')

    expect(result.outcome).toBe('ambiguous')
    expect(rpcCalls.find((c) => c.name === 'complete_merchant_payout_provider_attempt')).toBeUndefined()
  })

  it('7. an authoritative TerminalProviderError (4xx rejection) DOES call complete_* with status=failed -- this is proof of non-acceptance, not an ambiguous case', async () => {
    const createMerchantPayout = vi.fn().mockRejectedValue(new TerminalProviderError('peach', 'createPayout', 'HTTP 400'))
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')

    expect(result.outcome).toBe('submitted')
    expect(result.status).toBe('failed')
    const completeCall = rpcCalls.find((c) => c.name === 'complete_merchant_payout_provider_attempt')
    expect(completeCall?.params).toMatchObject({ p_provider_status: 'failed', p_source: 'create_response' })
  })

  it('8. propagates a start-RPC error (ineligible/misconfigured) as an OrchestrationError, never calling the provider at all', async () => {
    const createMerchantPayout = vi.fn()
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createMerchantPayout } as never)
    const { admin } = fakeAdmin({ startResult: { data: null, error: { message: 'merchant has no eligible payout destination: unverified' } } })

    await expect(executeMerchantPayoutProviderAttempt({ admin }, 'payout-1', 'admin-1')).rejects.toBeInstanceOf(OrchestrationError)
    expect(createMerchantPayout).not.toHaveBeenCalled()
  })
})

describe('executeAffiliatePayoutProviderAttempt', () => {
  it('9. mirrors the merchant path: a successful response calls complete_affiliate_payout_provider_attempt with source=create_response', async () => {
    const createAffiliatePayout = vi.fn().mockResolvedValue({ providerPayoutId: 'payout-uuid-1', status: 'successful' })
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createAffiliatePayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeAffiliatePayoutProviderAttempt({ admin }, 'commission-1')

    expect(result).toMatchObject({ outcome: 'submitted', status: 'successful' })
    expect(rpcCalls.find((c) => c.name === 'complete_affiliate_payout_provider_attempt')).toBeTruthy()
  })

  it('10. CRITICAL: an ambiguous provider error never calls complete_* for the affiliate path either', async () => {
    const createAffiliatePayout = vi.fn().mockRejectedValue(new ProviderTimeoutError('peach', 'createPayout'))
    vi.mocked(getActivePaymentProvider).mockReturnValue({ name: 'peach', supportsCapability: () => true, createAffiliatePayout } as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await executeAffiliatePayoutProviderAttempt({ admin }, 'commission-1')

    expect(result.outcome).toBe('ambiguous')
    expect(rpcCalls.find((c) => c.name === 'complete_affiliate_payout_provider_attempt')).toBeUndefined()
  })

  it('11. refuses when execution is not enabled, before any RPC', async () => {
    vi.mocked(isPayoutExecutionEnabled).mockReturnValue(false)
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(executeAffiliatePayoutProviderAttempt({ admin }, 'commission-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    expect(rpcCalls).toEqual([])
  })
})
