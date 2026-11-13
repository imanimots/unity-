import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../providers/peach/payouts-config', () => ({ loadPeachPayoutsConfig: vi.fn() }))
vi.mock('../../providers/peach/banv-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/peach/banv-client')>()
  return { ...actual, PeachPayoutsClient: vi.fn() }
})

import { loadPeachPayoutsConfig } from '../../providers/peach/payouts-config'
import { PeachPayoutsClient } from '../../providers/peach/banv-client'
import {
  addPayoutDestination,
  submitBankVerification,
  reconcileBankVerification,
  applyBankVerificationWebhookPayload,
  getPayoutDestinationEligibility,
  disablePayoutDestination,
} from '../service'
import { PayoutDestinationError } from '../errors'

const VALID_FIELD_RESULTS = {
  accountNumber: 'positive',
  idNumber: 'positive',
  initials: 'unverified',
  lastName: 'positive',
  accountOpen: 'positive',
  accountAcceptsCredits: 'positive',
  accountAcceptsDebits: 'positive',
  accountOpenGtThreeMonths: 'positive',
  accountType: 'positive',
}

function fakeAdmin(options: {
  rpcResults?: Record<string, { data?: unknown; error?: { message: string } | null }>
  destinationRow?: Record<string, unknown> | null
  identityRow?: Record<string, unknown> | null
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    const result = options.rpcResults?.[name]
    if (!result) throw new Error(`unexpected rpc call in test: ${name}`)
    return result
  })

  const destinationsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.destinationRow === undefined ? { id: 'dest-1', owner_id: 'owner-1', universal_branch_code: '250655', account_type: 'savings_account' } : options.destinationRow,
      error: null,
    }),
  }
  const identityChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.identityRow === undefined ? { status: 'approved', id_reference_number: '8001015009087', legal_surname: 'Smith' } : options.identityRow,
      error: null,
    }),
  }
  const from = vi.fn((table: string) => {
    if (table === 'payout_destinations') return destinationsChain
    if (table === 'identity_verifications') return identityChain
    throw new Error(`unexpected table in test: ${table}`)
  })
  return { admin: { rpc, from } as never, rpcCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('addPayoutDestination', () => {
  it('1. calls create_payout_destination with the exact expected params and maps the result', async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpcResults: { create_payout_destination: { data: { destination_id: 'dest-1', version: 1, verification_status: 'unverified' }, error: null } } })

    const result = await addPayoutDestination({ admin }, { ownerId: 'owner-1', bankCode: 'fnb', accountNumber: '1234567890', accountType: 'savings_account', actorId: 'owner-1' })

    expect(result).toEqual({ destinationId: 'dest-1', version: 1, verificationStatus: 'unverified' })
    expect(rpcCalls[0]).toEqual({
      name: 'create_payout_destination',
      params: { p_owner_id: 'owner-1', p_bank_code: 'fnb', p_account_number: '1234567890', p_account_type: 'savings_account', p_actor_id: 'owner-1', p_actor_type: 'owner' },
    })
  })

  it('2. maps a concurrent-change RPC error to the concurrent_change code', async () => {
    const { admin } = fakeAdmin({ rpcResults: { create_payout_destination: { data: null, error: { message: 'a concurrent bank-detail change is already in progress for this owner -- please retry' } } } })

    await expect(addPayoutDestination({ admin }, { ownerId: 'o', bankCode: 'fnb', accountNumber: '123', accountType: 'savings_account', actorId: 'o' })).rejects.toMatchObject({
      code: 'concurrent_change',
    })
  })

  it('3. maps a bank-not-found RPC error to the bank_not_found code', async () => {
    const { admin } = fakeAdmin({ rpcResults: { create_payout_destination: { data: null, error: { message: 'unknown or inactive bank_code xyz' } } } })

    await expect(addPayoutDestination({ admin }, { ownerId: 'o', bankCode: 'xyz', accountNumber: '123', accountType: 'savings_account', actorId: 'o' })).rejects.toMatchObject({
      code: 'bank_not_found',
    })
  })
})

describe('submitBankVerification -- KYC reuse and fail-closed gating', () => {
  it('4. refuses with identity_not_approved when identity_verifications.status is not approved, before ever starting an attempt or calling Peach', async () => {
    const { admin, rpcCalls } = fakeAdmin({ identityRow: { status: 'pending', id_reference_number: '800', legal_surname: 'Smith' } })

    await expect(submitBankVerification({ admin }, { destinationId: 'dest-1', trigger: 'initial' })).rejects.toMatchObject({ code: 'identity_not_approved' })
    expect(rpcCalls.find((c) => c.name === 'start_bank_verification_attempt')).toBeUndefined()
  })

  it('5. refuses with identity_not_approved when no identity_verifications row exists at all', async () => {
    const { admin } = fakeAdmin({ identityRow: null })

    await expect(submitBankVerification({ admin }, { destinationId: 'dest-1', trigger: 'initial' })).rejects.toMatchObject({ code: 'identity_not_approved' })
  })

  it('6. refuses with destination_not_found when the destination does not exist', async () => {
    const { admin } = fakeAdmin({ destinationRow: null })

    await expect(submitBankVerification({ admin }, { destinationId: 'missing', trigger: 'initial' })).rejects.toMatchObject({ code: 'destination_not_found' })
  })

  it('7. refuses with provider_configuration_error when Peach Payouts is not configured, after starting the attempt', async () => {
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue(null)
    const { admin } = fakeAdmin({ rpcResults: { start_bank_verification_attempt: { data: { attempt_id: 'attempt-1' }, error: null } } })

    await expect(submitBankVerification({ admin }, { destinationId: 'dest-1', trigger: 'initial' })).rejects.toMatchObject({ code: 'provider_configuration_error' })
  })

  it('8. reads idNumber/lastName live from identity_verifications and submits them to Peach, then records the submission via RPC', async () => {
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue({
      environment: 'sandbox',
      baseUrl: 'https://sandbox-payouts.peachpayments.com/api',      authBaseUrl: 'https://sandbox-dashboard.peachpayments.com',
      clientId: 'id',
      clientSecret: 'secret',
      merchantId: 'merchant-1',
      webhookSigningSecret: null,
    })
    const createBankAccountVerification = vi.fn().mockResolvedValue({ bankVerificationId: 'bv-1', status: 'pending', resultCode: '2902.000.001' })
    vi.mocked(PeachPayoutsClient).mockImplementation(function () {
      return { createBankAccountVerification } as never
    } as never)

    const { admin, rpcCalls } = fakeAdmin({
      rpcResults: {
        start_bank_verification_attempt: { data: { attempt_id: 'attempt-1' }, error: null },
        get_payout_destination_account_number: { data: '1234567890', error: null },
        record_bank_verification_submitted: { data: { ok: true }, error: null },
      },
    })

    const result = await submitBankVerification({ admin }, { destinationId: 'dest-1', trigger: 'initial', actorId: 'owner-1' })

    expect(createBankAccountVerification).toHaveBeenCalledWith({
      accountNumber: '1234567890',
      accountType: 'savings_account',
      branchCode: '250655',
      idNumber: '8001015009087',
      lastName: 'Smith',
    })
    expect(result).toEqual({ attemptId: 'attempt-1', providerVerificationId: 'bv-1', status: 'pending' })
    expect(rpcCalls.find((c) => c.name === 'record_bank_verification_submitted')?.params).toEqual({
      p_attempt_id: 'attempt-1',
      p_provider_verification_id: 'bv-1',
      p_initial_status: 'pending',
      p_result_code: '2902.000.001',
    })
  })

  it('9. never persists the raw account number or idNumber anywhere outside the single provider call -- no RPC call in this flow carries them as a param', async () => {
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue({
      environment: 'sandbox',
      baseUrl: 'https://sandbox-payouts.peachpayments.com/api',      authBaseUrl: 'https://sandbox-dashboard.peachpayments.com',
      clientId: 'id',
      clientSecret: 'secret',
      merchantId: 'merchant-1',
      webhookSigningSecret: null,
    })
    vi.mocked(PeachPayoutsClient).mockImplementation(function () {
      return { createBankAccountVerification: vi.fn().mockResolvedValue({ bankVerificationId: 'bv-1', status: 'pending', resultCode: '2902.000.001' }) } as never
    } as never)
    const { admin, rpcCalls } = fakeAdmin({
      rpcResults: {
        start_bank_verification_attempt: { data: { attempt_id: 'attempt-1' }, error: null },
        get_payout_destination_account_number: { data: '1234567890', error: null },
        record_bank_verification_submitted: { data: { ok: true }, error: null },
      },
    })

    await submitBankVerification({ admin }, { destinationId: 'dest-1', trigger: 'initial' })

    const serialized = JSON.stringify(rpcCalls)
    expect(serialized).not.toContain('1234567890')
    expect(serialized).not.toContain('8001015009087')
  })
})

describe('reconcileBankVerification', () => {
  it('10. queries Peach and forwards the result via record_bank_verification_result with source=query_reconciliation', async () => {
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue({
      environment: 'sandbox',
      baseUrl: 'https://sandbox-payouts.peachpayments.com/api',      authBaseUrl: 'https://sandbox-dashboard.peachpayments.com',
      clientId: 'id',
      clientSecret: 'secret',
      merchantId: 'merchant-1',
      webhookSigningSecret: null,
    })
    const getBankAccountVerificationResult = vi.fn().mockResolvedValue({ bankVerificationId: 'bv-1', status: 'successful', resultCode: '2002.000.000', fieldResults: VALID_FIELD_RESULTS })
    vi.mocked(PeachPayoutsClient).mockImplementation(function () {
      return { getBankAccountVerificationResult } as never
    } as never)
    const { admin, rpcCalls } = fakeAdmin({ rpcResults: { record_bank_verification_result: { data: { ok: true, applied_to_destination: true }, error: null } } })

    const result = await reconcileBankVerification({ admin }, { providerVerificationId: 'bv-1' })

    expect(result).toEqual({ ok: true, appliedToDestination: true })
    expect(rpcCalls[0].params).toEqual({
      p_provider: 'peach',
      p_provider_verification_id: 'bv-1',
      p_status: 'successful',
      p_result_code: '2002.000.000',
      p_field_results: VALID_FIELD_RESULTS,
      p_source: 'query_reconciliation',
    })
  })
})

describe('applyBankVerificationWebhookPayload -- fail-closed on unrecognized shape', () => {
  it('11. returns null without calling any RPC when the payload does not match the expected shape', async () => {
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await applyBankVerificationWebhookPayload({ admin }, { unexpected: 'shape' })

    expect(result).toBeNull()
    expect(rpcCalls).toEqual([])
  })

  it('12. forwards a valid payload to record_bank_verification_result with source=webhook', async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpcResults: { record_bank_verification_result: { data: { ok: true, applied_to_destination: true }, error: null } } })

    const result = await applyBankVerificationWebhookPayload({ admin }, { bankVerificationId: 'bv-1', status: 'successful', resultCode: '2002.000.000', ...VALID_FIELD_RESULTS })

    expect(result).toEqual({ ok: true, appliedToDestination: true })
    expect(rpcCalls[0].params).toMatchObject({ p_source: 'webhook', p_provider_verification_id: 'bv-1' })
  })
})

describe('getPayoutDestinationEligibility', () => {
  it('13. forwards the owner id and returns the mapped eligibility result', async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpcResults: { _payout_destination_eligibility: { data: { eligible: false, reason: 'stale', destination_id: 'dest-1' }, error: null } } })

    const result = await getPayoutDestinationEligibility({ admin }, 'owner-1')

    expect(result).toEqual({ eligible: false, reason: 'stale', destinationId: 'dest-1' })
    expect(rpcCalls[0]).toEqual({ name: '_payout_destination_eligibility', params: { p_owner_id: 'owner-1' } })
  })
})

describe('disablePayoutDestination', () => {
  it('14. calls disable_payout_destination with the expected params', async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpcResults: { disable_payout_destination: { data: { ok: true }, error: null } } })

    await disablePayoutDestination({ admin }, { destinationId: 'dest-1', actorId: 'owner-1', reason: 'replaced' })

    expect(rpcCalls[0]).toEqual({
      name: 'disable_payout_destination',
      params: { p_destination_id: 'dest-1', p_actor_id: 'owner-1', p_actor_type: 'owner', p_reason: 'replaced' },
    })
  })
})

describe('PayoutDestinationError propagation', () => {
  it('15. addPayoutDestination propagates a PayoutDestinationError instance, not a raw object', async () => {
    const { admin } = fakeAdmin({ rpcResults: { create_payout_destination: { data: null, error: { message: 'invalid account type' } } } })

    try {
      await addPayoutDestination({ admin }, { ownerId: 'o', bankCode: 'fnb', accountNumber: '123', accountType: 'bad', actorId: 'o' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(PayoutDestinationError)
    }
  })
})
