import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import { POST } from '../route'

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn() }
})
vi.mock('@/lib/payments/providers/peach/payouts-config', () => ({ loadPeachPayoutsConfig: vi.fn() }))
vi.mock('@/lib/payments/payout-destinations/service', () => ({ applyBankVerificationWebhookPayload: vi.fn() }))

import { loadPeachPayoutsConfig } from '@/lib/payments/providers/peach/payouts-config'
import { applyBankVerificationWebhookPayload } from '@/lib/payments/payout-destinations/service'

const ORIGINAL_ENV = { ...process.env }
const SECRET_BYTES = Buffer.from('test-signing-key-bytes-0123456789')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key === 'NEXT_PUBLIC_SUPABASE_URL' || key === 'SUPABASE_SERVICE_ROLE_KEY') delete process.env[key]
  })
  Object.assign(process.env, ORIGINAL_ENV)
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-not-real'
}

function sign(webhookId: string, timestamp: string, body: string): string {
  const signedContent = `${webhookId}.${timestamp}.${body}`
  return `v1,${createHmac('sha256', SECRET_BYTES).update(signedContent).digest('base64')}`
}

function webhookRequest(bodyObj: unknown, options: { webhookId?: string; timestamp?: string; badSignature?: boolean; omitSignature?: boolean } = {}): NextRequest {
  const body = JSON.stringify(bodyObj)
  const webhookId = options.webhookId ?? 'msg_1'
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = { 'content-type': 'application/json', 'webhook-id': webhookId, 'webhook-timestamp': timestamp }
  if (!options.omitSignature) {
    headers['webhook-signature'] = options.badSignature ? 'v1,wrongsignature==' : sign(webhookId, timestamp, body)
  }
  return new NextRequest('https://unity.test/api/payments/webhooks/peach-banv', { method: 'POST', body, headers })
}

function fakeAdmin(overrides: {
  recordWebhookEvent?: { data?: unknown; error?: unknown }
  claim?: { data?: unknown; error?: unknown }
  markProcessed?: { data?: unknown; error?: unknown }
  markError?: { data?: unknown; error?: unknown }
}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'record_webhook_event') return overrides.recordWebhookEvent ?? { data: { webhook_event_id: 'evt-1', is_duplicate: false }, error: null }
    if (name === 'claim_webhook_event_processing') return overrides.claim ?? { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null }
    if (name === 'mark_webhook_event_processed') return overrides.markProcessed ?? { data: { outcome: 'completed' }, error: null }
    if (name === 'mark_webhook_event_error') return overrides.markError ?? { data: { outcome: 'completed' }, error: null }
    throw new Error(`unexpected rpc: ${name}`)
  })
  return { rpc }
}

async function withAdmin(admin: ReturnType<typeof fakeAdmin>, fn: () => Promise<Response>): Promise<Response> {
  const { createClient } = await import('@supabase/supabase-js')
  ;(createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
  return fn()
}

describe('POST /api/payments/webhooks/peach-banv', () => {
  beforeEach(() => {
    resetEnv()
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue({
      environment: 'sandbox',
      baseUrl: 'https://sandbox-payouts.peachpayments.com/api',
      clientId: 'id',
      clientSecret: 'secret',
      merchantId: 'merchant-1',
      webhookSigningSecret: SECRET,
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
    resetEnv()
  })

  it('1. returns 404 when Peach Payouts webhook signing is not configured', async () => {
    vi.mocked(loadPeachPayoutsConfig).mockReturnValue(null)
    const response = await POST(webhookRequest({ status: 'successful' }))
    expect(response.status).toBe(404)
  })

  it('2. rejects an invalid signature with 401 and records a signature_valid=false audit row', async () => {
    const admin = fakeAdmin({})
    const response = await withAdmin(admin, () => POST(webhookRequest({ status: 'successful' }, { badSignature: true })))

    expect(response.status).toBe(401)
    expect(admin.rpc).toHaveBeenCalledWith('record_webhook_event', expect.objectContaining({ p_signature_valid: false }))
  })

  it('3. rejects a request missing webhook-signature entirely with 401', async () => {
    const admin = fakeAdmin({})
    const response = await withAdmin(admin, () => POST(webhookRequest({ status: 'successful' }, { omitSignature: true })))
    expect(response.status).toBe(401)
  })

  it('4. a validly signed, correctly shaped payload is applied and marked processed', async () => {
    vi.mocked(applyBankVerificationWebhookPayload).mockResolvedValue({ ok: true, appliedToDestination: true })
    const admin = fakeAdmin({})

    const response = await withAdmin(admin, () => POST(webhookRequest({ status: 'successful' })))

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({ status: 'received', applied_to_destination: true })
    expect(admin.rpc).toHaveBeenCalledWith('mark_webhook_event_processed', expect.anything())
  })

  it('5. a duplicate/already-leased delivery (claim not granted) short-circuits with no_action and never calls apply', async () => {
    vi.mocked(applyBankVerificationWebhookPayload).mockResolvedValue({ ok: true, appliedToDestination: true })
    const admin = fakeAdmin({ claim: { data: { claimed: false, processing_status: 'processed' }, error: null } })

    const response = await withAdmin(admin, () => POST(webhookRequest({ status: 'successful' })))

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.status).toBe('no_action')
    expect(applyBankVerificationWebhookPayload).not.toHaveBeenCalled()
  })

  it('6. an unrecognized payload shape (service returns null) marks the event errored and responds 400, never marks processed', async () => {
    vi.mocked(applyBankVerificationWebhookPayload).mockResolvedValue(null)
    const admin = fakeAdmin({})

    const response = await withAdmin(admin, () => POST(webhookRequest({ unexpected: 'shape' })))

    expect(response.status).toBe(400)
    expect(admin.rpc).toHaveBeenCalledWith('mark_webhook_event_error', expect.objectContaining({ p_last_error: 'unrecognized BANV webhook payload shape' }))
    expect(admin.rpc).not.toHaveBeenCalledWith('mark_webhook_event_processed', expect.anything())
  })

  it('7. a transient error applying the result marks the event errored and responds 503 (retryable)', async () => {
    vi.mocked(applyBankVerificationWebhookPayload).mockRejectedValue(new Error('db unavailable'))
    const admin = fakeAdmin({})

    const response = await withAdmin(admin, () => POST(webhookRequest({ status: 'successful' })))

    expect(response.status).toBe(503)
    expect(admin.rpc).toHaveBeenCalledWith('mark_webhook_event_error', expect.objectContaining({ p_last_error: 'db unavailable' }))
  })
})
