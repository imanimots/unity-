import type { PeachPayoutsConfig } from './payouts-config'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../provider-errors'

/**
 * E32: narrow Peach Payouts client covering ONLY bank account
 * verification (BANV) -- create + query. Deliberately does not include
 * create-payout; that is explicitly out of scope for this phase (no
 * payout execution yet, see docs/PEACH_INTEGRATION.md §0 and this
 * phase's own report).
 *
 * Contract confirmed live against developer.peachpayments.com this
 * phase (not training knowledge, not a guess):
 *   - Auth: POST {baseUrl}/oauth/token { clientId, clientSecret,
 *     merchantId } -> { access_token, expires_in, token_type }.
 *   - Create: POST {baseUrl}/merchants/{merchantId}/banv
 *     { accountNumber, accountType, branchCode, idNumber, initials?,
 *     lastName? } -> { bankVerificationId, status, resultCode }.
 *   - Query: GET {baseUrl}/merchants/{merchantId}/banv/{id}/status ->
 *     { bankVerificationId, status, resultCode, accountNumber,
 *     idNumber, initials, lastName, accountOpen, accountAcceptsCredits,
 *     accountAcceptsDebits, accountOpenGtThreeMonths, accountType }
 *     (the last 9 fields are each 'positive'|'negative'|'unverified'
 *     attestation outcomes, never raw banking values).
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

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      return this.cachedToken.accessToken
    }

    const url = `${this.config.baseUrl}/oauth/token`
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

  private async request(method: 'GET' | 'POST', path: string, body: unknown, operation: string): Promise<unknown> {
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
