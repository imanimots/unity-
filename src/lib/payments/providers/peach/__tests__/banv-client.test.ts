import { describe, it, expect, vi } from 'vitest'
import { PeachPayoutsClient, parseBanvResultShape } from '../banv-client'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../../provider-errors'
import type { PeachPayoutsConfig } from '../payouts-config'

const CONFIG: PeachPayoutsConfig = {
  environment: 'sandbox',
  baseUrl: 'https://sandbox-payouts.peachpayments.com/api',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  merchantId: 'merchant-1',
  webhookSigningSecret: null,
}

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

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

describe('PeachPayoutsClient', () => {
  it('1. fetches an OAuth token before the first real call, with the documented request shape', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'pending', resultCode: '2902.000.001' }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await client.createBankAccountVerification({ accountNumber: '1234567890', accountType: 'savings_account', branchCode: '250655', idNumber: '8001015009087' })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0]
    expect(tokenUrl).toBe('https://sandbox-payouts.peachpayments.com/api/oauth/token')
    expect(JSON.parse(tokenInit.body as string)).toEqual({ clientId: 'client-id', clientSecret: 'client-secret', merchantId: 'merchant-1' })
  })

  it('2. reuses a cached token across multiple calls instead of re-fetching', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'pending', resultCode: '2902.000.001' }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'successful', resultCode: '2002.000.000', ...VALID_FIELD_RESULTS }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await client.createBankAccountVerification({ accountNumber: '1234567890', accountType: 'savings_account', branchCode: '250655', idNumber: '8001015009087' })
    await client.getBankAccountVerificationResult('bv-1')

    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 token fetch + 2 real calls, never a second token fetch
  })

  it('3. createBankAccountVerification sends the exact confirmed field names, omitting optional fields when absent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'pending', resultCode: '2902.000.001' }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await client.createBankAccountVerification({ accountNumber: '1234567890', accountType: 'savings_account', branchCode: '250655', idNumber: '8001015009087' })

    const [url, init] = fetchImpl.mock.calls[1]
    expect(url).toBe('https://sandbox-payouts.peachpayments.com/api/merchants/merchant-1/banv')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ accountNumber: '1234567890', accountType: 'savings_account', branchCode: '250655', idNumber: '8001015009087' })
    expect(body.initials).toBeUndefined()
    expect(body.lastName).toBeUndefined()
  })

  it('4. getBankAccountVerificationResult parses all 9 attestation fields plus status/resultCode', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'successful', resultCode: '2002.000.000', ...VALID_FIELD_RESULTS }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    const result = await client.getBankAccountVerificationResult('bv-1')

    expect(result.status).toBe('successful')
    expect(result.fieldResults).toEqual(VALID_FIELD_RESULTS)
  })

  it('5. fails closed (TerminalProviderError) on an unrecognized response shape -- never guesses a status', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 })).mockResolvedValueOnce(jsonResponse(200, { unexpected: 'shape' }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await expect(client.getBankAccountVerificationResult('bv-1')).rejects.toThrow(TerminalProviderError)
  })

  it('6. fails closed when one of the 9 attestation fields has an unrecognized value', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { bankVerificationId: 'bv-1', status: 'successful', resultCode: '2002.000.000', ...VALID_FIELD_RESULTS, accountNumber: 'maybe' }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await expect(client.getBankAccountVerificationResult('bv-1')).rejects.toThrow(TerminalProviderError)
  })

  it('7. maps a 503 token response to RetryableProviderError (Peach\'s own documented "temporarily unavailable" case)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ status: 503, json: async () => ({}) } as unknown as Response)
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await expect(client.createBankAccountVerification({ accountNumber: '123', accountType: 'savings_account', branchCode: '250655', idNumber: '800' })).rejects.toThrow(RetryableProviderError)
  })

  it('8. maps a 500+ response on the real call to RetryableProviderError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 })).mockResolvedValueOnce({ status: 500, json: async () => ({}) } as unknown as Response)
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await expect(client.createBankAccountVerification({ accountNumber: '123', accountType: 'savings_account', branchCode: '250655', idNumber: '800' })).rejects.toThrow(RetryableProviderError)
  })

  it('9. maps a 400 response on the real call to TerminalProviderError, never forwarding the raw Peach body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'invalid accountNumber', accountNumber: '123' }))
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl })

    await expect(client.createBankAccountVerification({ accountNumber: '123', accountType: 'savings_account', branchCode: '250655', idNumber: '800' })).rejects.toThrow(TerminalProviderError)
  })

  it('10. maps an abort/timeout to ProviderTimeoutError on the real call', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 })).mockImplementationOnce(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })
    const client = new PeachPayoutsClient(CONFIG, { fetchImpl, timeoutMs: 10 })

    await expect(client.createBankAccountVerification({ accountNumber: '123', accountType: 'savings_account', branchCode: '250655', idNumber: '800' })).rejects.toThrow(ProviderTimeoutError)
  })
})

describe('parseBanvResultShape', () => {
  it('11. returns null for a non-object input', () => {
    expect(parseBanvResultShape(null)).toBeNull()
    expect(parseBanvResultShape('string')).toBeNull()
  })

  it('12. returns null when status is missing or invalid', () => {
    expect(parseBanvResultShape({ ...VALID_FIELD_RESULTS, resultCode: '2002.000.000' })).toBeNull()
    expect(parseBanvResultShape({ status: 'unknown', ...VALID_FIELD_RESULTS })).toBeNull()
  })

  it('13. returns null when any attestation field is missing', () => {
    const rest: Record<string, string> = { ...VALID_FIELD_RESULTS }
    delete rest.accountNumber
    expect(parseBanvResultShape({ status: 'successful', resultCode: '2002.000.000', ...rest })).toBeNull()
  })

  it('14. parses successfully with a fallback bankVerificationId when the body omits it', () => {
    const parsed = parseBanvResultShape({ status: 'successful', resultCode: '2002.000.000', ...VALID_FIELD_RESULTS }, 'bv-fallback')
    expect(parsed?.bankVerificationId).toBe('bv-fallback')
  })
})
