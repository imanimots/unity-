import type { PeachPayoutsConfig } from './payouts-config'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../provider-errors'

/**
 * E32: Peach Payouts client, originally covering only bank account
 * verification (BANV). E33 widens it with the real create-payout and
 * query-by-payoutId methods (payout EXECUTION itself was explicitly
 * out of scope for E32).
 *
 * Contract confirmed live against developer.peachpayments.com across
 * both phases (not training knowledge, not a guess):
 *   - Auth: POST {authBaseUrl}/api/oauth/token { clientId, clientSecret,
 *     merchantId } -> { access_token, expires_in, token_type }. E33
 *     CORRECTION: authBaseUrl (dashboard.peachpayments.com /
 *     sandbox-dashboard.peachpayments.com) is a genuinely different
 *     host from the Payouts API's own baseUrl -- E32 incorrectly used
 *     baseUrl for this call; see payouts-config.ts's own comment.
 *   - Create BANV: POST {baseUrl}/merchants/{merchantId}/banv
 *     { accountNumber, accountType, branchCode, idNumber, initials?,
 *     lastName? } -> { bankVerificationId, status, resultCode }.
 *   - Query BANV: GET {baseUrl}/merchants/{merchantId}/banv/{id}/status ->
 *     { bankVerificationId, status, resultCode, accountNumber,
 *     idNumber, initials, lastName, accountOpen, accountAcceptsCredits,
 *     accountAcceptsDebits, accountOpenGtThreeMonths, accountType }
 *     (the last 9 fields are each 'positive'|'negative'|'unverified'
 *     attestation outcomes, never raw banking values).
 *   - Create payout (E33): POST {baseUrl}/merchants/{merchantId}/payouts
 *     { payouts: [{ payoutId, reference, currency, amount, accountNumber,
 *     branchCode, bankName, accountHolder, payoutMethod: 'realtime-eft' }] }
 *     -> { payoutRequestId, created, payouts: [{ payoutId, status,
 *     resultCode, lastUpdated, created, ... }] }. E33 submits exactly
 *     ONE payout per request (phase brief §13) -- no batching.
 *   - Query payout by payoutId (E33): GET {baseUrl}/merchants/{merchantId}
 *     /payouts/status?payoutId={payoutId} -> a PayoutRequestStatus
 *     object; a 404 means "not visible yet -- wait and call again; send
 *     create again only if this call stays 404" (confirmed verbatim
 *     from the live reference, introduced 2026-10-01 specifically for
 *     the lost-create-response case).
 *
 * The access token is held only in memory for the lifetime of this
 * client instance -- never persisted to any table, never logged.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const TOKEN_EXPIRY_BUFFER_MS = 30_000

export type BanvStatus = 'pending' | 'processing' | 'successful' | 'failed'
export type BanvAttestation = 'positive' | 'negative' | 'unverified'

export interface CreateBanvInput {
  accountNumber: string
  accountType: string
  branchCode: string
  idNumber: string
  initials?: string
  lastName?: string
}

export interface CreateBanvResult {
  bankVerificationId: string
  status: BanvStatus
  resultCode: string
}

export interface BanvFieldResults {
  accountNumber: BanvAttestation
  idNumber: BanvAttestation
  initials: BanvAttestation
  lastName: BanvAttestation
  accountOpen: BanvAttestation
  accountAcceptsCredits: BanvAttestation
  accountAcceptsDebits: BanvAttestation
  accountOpenGtThreeMonths: BanvAttestation
  accountType: BanvAttestation
}

export interface GetBanvResultOutput {
  bankVerificationId: string
  status: BanvStatus
  resultCode: string
  fieldResults: BanvFieldResults
}

export interface PeachPayoutsClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type PeachPayoutStatus = 'pending' | 'processing' | 'successful' | 'failed' | 'cancelled' | 'reversed'

export interface CreatePayoutInput {
  payoutId: string
  reference: string
  amountMinorUnits: number
  currency: string
  bankName: string
  branchCode: string
  accountNumber: string
  accountHolder: string
}

export interface CreatePayoutResult {
  payoutRequestId: string
  payoutId: string
  status: PeachPayoutStatus
  resultCode: string
}

export interface QueryPayoutByPayoutIdResult {
  payoutRequestId: string
  payoutId: string
  status: PeachPayoutStatus
  resultCode: string
  lastUpdated: string | null
}

function isPeachPayoutStatus(value: unknown): value is PeachPayoutStatus {
  return value === 'pending' || value === 'processing' || value === 'successful' || value === 'failed' || value === 'cancelled' || value === 'reversed'
}

const ATTESTATION_FIELDS = [
  'accountNumber',
  'idNumber',
  'initials',
  'lastName',
  'accountOpen',
  'accountAcceptsCredits',
  'accountAcceptsDebits',
  'accountOpenGtThreeMonths',
  'accountType',
] as const

function isAttestation(value: unknown): value is BanvAttestation {
  return value === 'positive' || value === 'negative' || value === 'unverified'
}

export class PeachPayoutsClient {
  private readonly config: PeachPayoutsConfig
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private cachedToken: { accessToken: string; expiresAt: number } | null = null

  constructor(config: PeachPayoutsConfig, options: PeachPayoutsClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async createBankAccountVerification(input: CreateBanvInput): Promise<CreateBanvResult> {
    const raw = await this.request('POST', `/merchants/${encodeURIComponent(this.config.merchantId)}/banv`, {
      accountNumber: input.accountNumber,
      accountType: input.accountType,
      branchCode: input.branchCode,
      idNumber: input.idNumber,
      ...(input.initials ? { initials: input.initials } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
    }, 'createBankAccountVerification')

    const body = raw as Record<string, unknown>
    const bankVerificationId = typeof body.bankVerificationId === 'string' ? body.bankVerificationId : null
    const status = body.status
    if (!bankVerificationId || !isBanvStatus(status)) {
      throw new TerminalProviderError('peach-payouts', 'createBankAccountVerification', 'unexpected response shape')
    }
    return { bankVerificationId, status, resultCode: typeof body.resultCode === 'string' ? body.resultCode : '' }
  }

  async getBankAccountVerificationResult(bankVerificationId: string): Promise<GetBanvResultOutput> {
    const raw = await this.request(
      'GET',
      `/merchants/${encodeURIComponent(this.config.merchantId)}/banv/${encodeURIComponent(bankVerificationId)}/status`,
      undefined,
      'getBankAccountVerificationResult'
    )

    const parsed = parseBanvResultShape(raw, bankVerificationId)
    if (!parsed) {
      throw new TerminalProviderError('peach-payouts', 'getBankAccountVerificationResult', 'unexpected response shape')
    }
    return parsed
  }

  /**
   * E33. Submits exactly ONE payout per request (phase brief §13 --
   * no batching). The 1-element `payouts` array in the response is
   * read back for its own echoed status/resultCode -- Peach's create
   * response is NOT merely an acknowledgement, it can already carry a
   * synchronous final-ish status (confirmed live: the same 6-value
   * enum the webhook uses).
   */
  async createPayout(input: CreatePayoutInput): Promise<CreatePayoutResult> {
    const raw = await this.request(
      'POST',
      `/merchants/${encodeURIComponent(this.config.merchantId)}/payouts`,
      {
        payouts: [
          {
            payoutId: input.payoutId,
            reference: input.reference,
            currency: input.currency,
            amount: input.amountMinorUnits,
            accountNumber: input.accountNumber,
            branchCode: input.branchCode,
            bankName: input.bankName,
            accountHolder: input.accountHolder,
            payoutMethod: 'realtime-eft',
          },
        ],
      },
      'createPayout'
    )

    const body = raw as Record<string, unknown>
    const payoutRequestId = typeof body.payoutRequestId === 'string' ? body.payoutRequestId : null
    const payouts = Array.isArray(body.payouts) ? body.payouts : null
    const first = payouts && payouts.length > 0 ? (payouts[0] as Record<string, unknown>) : null
    const status = first?.status
    if (!payoutRequestId || !first || typeof first.payoutId !== 'string' || !isPeachPayoutStatus(status)) {
      throw new TerminalProviderError('peach-payouts', 'createPayout', 'unexpected response shape')
    }

    return {
      payoutRequestId,
      payoutId: first.payoutId,
      status,
      resultCode: typeof first.resultCode === 'string' ? first.resultCode : '',
    }
  }

  /**
   * E33. For the lost-create-response case ONLY -- never used to
   * submit a new payout. Returns null on a 404, which per the live
   * reference means "not visible yet, wait and call again" -- never
   * treated as a terminal error, never treated as proof the payout
   * was never received (the caller's own bounded-attempt policy
   * decides what a persistent 404 means, this method just reports the
   * current fact).
   */
  async queryPayoutByPayoutId(payoutId: string): Promise<QueryPayoutByPayoutIdResult | null> {
    const raw = await this.request(
      'GET',
      `/merchants/${encodeURIComponent(this.config.merchantId)}/payouts/status?payoutId=${encodeURIComponent(payoutId)}`,
      undefined,
      'queryPayoutByPayoutId',
      { allowNotFound: true }
    )
    if (raw === null) return null

    const body = raw as Record<string, unknown>
    const payoutRequestId = typeof body.payoutRequestId === 'string' ? body.payoutRequestId : null
    const payouts = Array.isArray(body.payouts) ? body.payouts : null
    const match = payouts?.find((p) => (p as Record<string, unknown>).payoutId === payoutId) as Record<string, unknown> | undefined
    const status = match?.status
    if (!payoutRequestId || !match || !isPeachPayoutStatus(status)) {
      throw new TerminalProviderError('peach-payouts', 'queryPayoutByPayoutId', 'unexpected response shape')
    }

    return {
      payoutRequestId,
      payoutId,
      status,
      resultCode: typeof match.resultCode === 'string' ? match.resultCode : '',
      lastUpdated: typeof match.lastUpdated === 'string' ? match.lastUpdated : null,
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      return this.cachedToken.accessToken
    }

    const url = `${this.config.authBaseUrl}/api/oauth/token`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientId: this.config.clientId, clientSecret: this.config.clientSecret, merchantId: this.config.merchantId }),
      })
    } catch {
      throw new RetryableProviderError('peach-payouts', 'oauthToken', 'network error')
    }

    if (response.status >= 500) throw new RetryableProviderError('peach-payouts', 'oauthToken', `HTTP ${response.status}`)
    if (response.status === 503) throw new RetryableProviderError('peach-payouts', 'oauthToken', 'authentication temporarily unavailable')
    if (response.status >= 400) throw new TerminalProviderError('peach-payouts', 'oauthToken', `HTTP ${response.status}`)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new TerminalProviderError('peach-payouts', 'oauthToken', 'unparseable token response')
    }
    const accessToken = (body as Record<string, unknown>)?.access_token
    const expiresIn = (body as Record<string, unknown>)?.expires_in
    if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
      throw new TerminalProviderError('peach-payouts', 'oauthToken', 'unexpected token response shape')
    }

    this.cachedToken = { accessToken, expiresAt: Date.now() + expiresIn * 1000 }
    return accessToken
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    operation: string,
    options: { allowNotFound?: boolean } = {}
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken()
    const url = `${this.config.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new ProviderTimeoutError('peach-payouts', operation)
      throw new RetryableProviderError('peach-payouts', operation, 'network error')
    } finally {
      clearTimeout(timeout)
    }

    if (options.allowNotFound && response.status === 404) return null

    let parsedBody: unknown
    try {
      parsedBody = await response.json()
    } catch {
      parsedBody = null
    }

    if (response.status >= 500) throw new RetryableProviderError('peach-payouts', operation, `HTTP ${response.status}`)
    if (response.status === 429) throw new RetryableProviderError('peach-payouts', operation, 'rate limited')
    if (response.status >= 400) {
      // Never forward the raw Peach response body -- it echoes request
      // fields (accountNumber, idNumber) back on validation errors.
      throw new TerminalProviderError('peach-payouts', operation, `HTTP ${response.status}`)
    }

    return parsedBody
  }
}

function isBanvStatus(value: unknown): value is BanvStatus {
  return value === 'pending' || value === 'processing' || value === 'successful' || value === 'failed'
}

/**
 * Shared, pure shape validator for a BANV query-result response --
 * reused by the HTTP client above AND the BANV webhook route (whose
 * payload is assumed, per Peach's own "sends a webhook with the bank
 * account verification result" wording, to carry the same shape as the
 * query-result response; never confirmed by a dedicated webhook-payload
 * reference page). Returns null on ANY unrecognized shape -- the caller
 * must fail closed, never guess a status or skip an attestation field.
 */
export function parseBanvResultShape(raw: unknown, fallbackBankVerificationId?: string): GetBanvResultOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const status = body.status
  if (!isBanvStatus(status)) return null

  const fieldResults: Partial<BanvFieldResults> = {}
  for (const field of ATTESTATION_FIELDS) {
    const value = body[field]
    if (!isAttestation(value)) return null
    fieldResults[field] = value
  }

  const bankVerificationId = typeof body.bankVerificationId === 'string' ? body.bankVerificationId : fallbackBankVerificationId
  if (!bankVerificationId) return null

  return {
    bankVerificationId,
    status,
    resultCode: typeof body.resultCode === 'string' ? body.resultCode : '',
    fieldResults: fieldResults as BanvFieldResults,
  }
}
