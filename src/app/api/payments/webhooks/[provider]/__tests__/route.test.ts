import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import { POST } from '../route'
import { ORCHESTRATION_WEBHOOK_SECRET_HEADER, ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER } from '@/lib/payments/providers/orchestration/webhook-config'

const ORIGINAL_ENV = { ...process.env }
const CUSTOM_SECRET = 'test-custom-webhook-secret-value'
const HASH_KEY = 'test-payment-response-hash-key'

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('PEACH_') || key === 'NEXT_PUBLIC_SUPABASE_URL' || key === 'SUPABASE_SERVICE_ROLE_KEY') delete process.env[key]
  })
  Object.assign(process.env, ORIGINAL_ENV)
}

function setStorageEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-not-real'
}

function setOrchestrationWebhookEnv() {
  process.env.PEACH_ORCHESTRATION_WEBHOOK_SECRET = CUSTOM_SECRET
  process.env.PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY = HASH_KEY
}

function sign(body: string): string {
  return createHmac('sha512', HASH_KEY).update(Buffer.from(body, 'utf-8')).digest('hex')
}

function orchestrationRequest(bodyObj: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  const body = JSON.stringify(bodyObj)
  return new NextRequest('https://unity.test/api/payments/webhooks/peach', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CUSTOM_SECRET,
      [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: sign(body),
      ...extraHeaders,
    },
  })
}

const routeParams = { params: Promise.resolve({ provider: 'peach' }) }
const mockRouteParams = { params: Promise.resolve({ provider: 'mock' }) }

/**
 * Fake service-role admin client covering every RPC/table call the
 * route (and, for the orchestration path, reconcileOrchestrationPayment
 * called for real inside it) can make. Each RPC name maps to a
 * configurable responder so a test can script exactly what a given
 * scenario needs; `paymentsLookupRows` backs the `.from('payments')`
 * chain reconcileOrchestrationPayment issues directly.
 */
function fakeAdmin(overrides: {
  recordWebhookEvent?: { data?: unknown; error?: unknown }
  claim?: { data?: unknown; error?: unknown }
  markProcessed?: { data?: unknown; error?: unknown }
  markError?: { data?: unknown; error?: unknown }
  paymentsLookupRows?: unknown[]
  transitionResult?: { data?: unknown; error?: unknown }
  markOrderPaidResult?: { data?: unknown; error?: unknown }
  bookingRow?: { status: string; payment_expired_at: string | null } | null
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    switch (name) {
      case 'record_webhook_event':
        return overrides.recordWebhookEvent ?? { data: { webhook_event_id: 'wh-1', is_duplicate: false }, error: null }
      case 'claim_webhook_event_processing':
        return overrides.claim ?? { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null }
      case 'mark_webhook_event_processed':
        return overrides.markProcessed ?? { data: { outcome: 'completed', processing_status: 'processed' }, error: null }
      case 'mark_webhook_event_error':
        return overrides.markError ?? { data: { outcome: 'error_recorded', processing_status: 'error' }, error: null }
      case 'transition_payment_status':
        return overrides.transitionResult ?? { data: {}, error: null }
      case 'mark_order_paid':
        return overrides.markOrderPaidResult ?? { data: { order_id: 'order-1', status: 'paid' }, error: null }
      case 'record_late_payment_reconciliation':
        return { data: { booking_id: 'booking-1', recorded: true }, error: null }
      default:
        throw new Error(`unexpected rpc call: ${name}`)
    }
  })

  const paymentsSelectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: overrides.paymentsLookupRows ?? [], error: null }),
  }
  const bookingsSelectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: overrides.bookingRow ?? null, error: null }),
  }

  const from = vi.fn((table: string) => {
    if (table === 'payments') return paymentsSelectChain
    if (table === 'bookings') return bookingsSelectChain
    throw new Error(`unexpected table: ${table}`)
  })

  return { rpc, from, rpcCalls }
}

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn() }
})

async function withAdmin(admin: ReturnType<typeof fakeAdmin>, fn: () => Promise<Response>): Promise<Response> {
  const { createClient } = await import('@supabase/supabase-js')
  ;(createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
  return fn()
}

describe('POST /api/payments/webhooks/[provider] -- dispatch', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
    setOrchestrationWebhookEnv()
  })
  afterEach(resetEnv)

  it('a peach delivery carrying the Orchestration custom-secret header is routed to the Orchestration pipeline', async () => {
    const admin = fakeAdmin({ paymentsLookupRows: [{ id: 'pay-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }] })
    const body = { event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'peach_1', status: 'succeeded', amount: 9200, currency: 'ZAR' } }
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    expect(admin.rpcCalls.map((c) => c.name)).toContain('claim_webhook_event_processing')
  })

  it('a peach delivery carrying only classic headers (no Orchestration headers) falls through to the generic pipeline unchanged', async () => {
    const admin = fakeAdmin({})
    const request = new NextRequest('https://unity.test/api/payments/webhooks/peach', {
      method: 'POST',
      body: JSON.stringify({ some: 'classic-shaped-payload' }),
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'whatever-the-classic-verifier-checks' },
    })
    const response = await withAdmin(admin, () => POST(request, routeParams))
    // Classic verifyWebhook() will reject this (no real classic config
    // in this test env) -- the point is it never reaches
    // claim_webhook_event_processing at all, proving no cross-routing.
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('claim_webhook_event_processing')
    expect(response.status).not.toBe(0)
  })
})

describe('POST /api/payments/webhooks/[provider] -- MockProvider regression (unchanged generic pipeline)', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
  })
  afterEach(resetEnv)

  it('a mock webhook still authenticates via x-mock-signature and reaches reconcileProviderEvent, completely bypassing the Orchestration pipeline', async () => {
    const admin = fakeAdmin({
      recordWebhookEvent: { data: { webhook_event_id: 'wh-mock', is_duplicate: false }, error: null },
    })
    // reconcileProviderEvent queries financial_workflows -- extend the
    // fake admin's `from` to answer that too for this one test.
    const financialWorkflowChain = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
    admin.from = vi.fn((table: string) => {
      if (table === 'financial_workflows') return financialWorkflowChain
      throw new Error(`unexpected table: ${table}`)
    }) as unknown as typeof admin.from

    const request = new NextRequest('https://unity.test/api/payments/webhooks/mock', {
      method: 'POST',
      body: JSON.stringify({ event_id: 'evt_mock_1', type: 'booking.financial_workflow_retry', booking_id: 'booking-1' }),
      headers: { 'content-type': 'application/json', 'x-mock-signature': 'mock-signature' },
    })
    const response = await withAdmin(admin, () => POST(request, mockRouteParams))
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.status).toBe('received')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('claim_webhook_event_processing')
  })
})

describe('POST /api/payments/webhooks/[provider] -- Orchestration authentication', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
    setOrchestrationWebhookEnv()
  })
  afterEach(resetEnv)

  it('rejects a wrong custom secret with 401 and never calls claim', async () => {
    const admin = fakeAdmin({})
    const body = { event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' } }
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body, { [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: 'wrong-secret' }), routeParams))
    expect(response.status).toBe(401)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('claim_webhook_event_processing')
    // Still recorded for invalid-auth audit, but never using the
    // body-derived event_id as an authenticated identity.
    const recordCall = admin.rpcCalls.find((c) => c.name === 'record_webhook_event')
    expect(recordCall).toBeDefined()
    expect((recordCall!.params as Record<string, unknown>).p_provider_event_id).toMatch(/^invalid_/)
  })

  it('rejects when the Orchestration webhook config is entirely missing (fails closed, never proceeds as trusted)', async () => {
    resetEnv()
    setStorageEnv()
    // Deliberately no webhook secret/hash key configured.
    const admin = fakeAdmin({})
    const body = { event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' } }
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(401)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('claim_webhook_event_processing')
  })

  it('rejects a malformed envelope even after successful authentication', async () => {
    const admin = fakeAdmin({})
    const rawBadEnvelope = JSON.stringify({ event_id: 'evt_1' }) // missing event_type/content
    const request = new NextRequest('https://unity.test/api/payments/webhooks/peach', {
      method: 'POST',
      body: rawBadEnvelope,
      headers: {
        'content-type': 'application/json',
        [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CUSTOM_SECRET,
        [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: sign(rawBadEnvelope),
      },
    })
    const response = await withAdmin(admin, () => POST(request, routeParams))
    expect(response.status).toBe(400)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_webhook_event')
  })
})

describe('POST /api/payments/webhooks/[provider] -- Orchestration inbox integration', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
    setOrchestrationWebhookEnv()
  })
  afterEach(resetEnv)

  const body = { event_id: 'evt_new', event_type: 'payment_succeeded', content: { payment_id: 'peach_1', status: 'succeeded', amount: 9200, currency: 'ZAR' } }

  it('new event: record -> claim -> reconcile -> mark processed -> 2xx', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).toEqual(['record_webhook_event', 'claim_webhook_event_processing', 'transition_payment_status', 'mark_webhook_event_processed'])
  })

  it('duplicate + already processed: claim reports claimed=false -> no reconciliation, 2xx', async () => {
    const admin = fakeAdmin({ claim: { data: { claimed: false, processing_status: 'processed', processing_attempts: 1 }, error: null } })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).toEqual(['record_webhook_event', 'claim_webhook_event_processing'])
    expect(names).not.toContain('transition_payment_status')
  })

  it('duplicate + ignored: claim reports claimed=false -> no reconciliation, 2xx', async () => {
    const admin = fakeAdmin({ claim: { data: { claimed: false, processing_status: 'ignored', processing_attempts: 1 }, error: null } })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('transition_payment_status')
  })

  it('duplicate + live processing lease: claim reports claimed=false -> no second reconciliation, 2xx', async () => {
    const admin = fakeAdmin({ claim: { data: { claimed: false, processing_status: 'processing', processing_attempts: 2 }, error: null } })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('transition_payment_status')
  })

  it('duplicate + received/error/stale-processing: claim succeeds -> reconciliation resumes', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 2 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    expect(admin.rpcCalls.map((c) => c.name)).toContain('transition_payment_status')
  })

  it('the claim token (processing_attempts) is passed unchanged to mark_webhook_event_processed', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 7 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
    })
    await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    const markCall = admin.rpcCalls.find((c) => c.name === 'mark_webhook_event_processed')
    expect((markCall!.params as Record<string, unknown>).p_expected_processing_attempt).toBe(7)
  })

  it('mark_webhook_event_processed returning lost_claim does not trigger a second completion attempt', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
      markProcessed: { data: { outcome: 'lost_claim', processing_status: 'processing', processing_attempts: 2 }, error: null },
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(200)
    const markCalls = admin.rpcCalls.filter((c) => c.name === 'mark_webhook_event_processed')
    expect(markCalls).toHaveLength(1)
  })

  it('a transient reconciliation failure calls mark_webhook_event_error with the claim token and responds non-2xx so Peach retries', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 3 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
      transitionResult: { data: null, error: new Error('db hiccup') },
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(503)
    const errorCall = admin.rpcCalls.find((c) => c.name === 'mark_webhook_event_error')
    expect(errorCall).toBeDefined()
    expect((errorCall!.params as Record<string, unknown>).p_expected_processing_attempt).toBe(3)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('mark_webhook_event_processed')
  })

  it('mark_webhook_event_error returning lost_claim does not overwrite a newer worker\'s claim', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR' }],
      transitionResult: { data: null, error: new Error('db hiccup') },
      markError: { data: { outcome: 'lost_claim', processing_status: 'processing', processing_attempts: 2 }, error: null },
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(body), routeParams))
    expect(response.status).toBe(503)
    const errorCalls = admin.rpcCalls.filter((c) => c.name === 'mark_webhook_event_error')
    expect(errorCalls).toHaveLength(1)
  })

  it('a refund event_type is deferred (not mutated) and marked processed without calling reconciliation', async () => {
    const admin = fakeAdmin({ claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null } })
    const refundBody = { event_id: 'evt_refund_1', event_type: 'refund_created', content: { payment_id: 'peach_1', status: 'succeeded' } }
    const response = await withAdmin(admin, () => POST(orchestrationRequest(refundBody), routeParams))
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.status).toBe('deferred')
    expect(admin.rpcCalls.map((c) => c.name)).toEqual(['record_webhook_event', 'claim_webhook_event_processing', 'mark_webhook_event_processed'])
  })
})

describe('POST /api/payments/webhooks/[provider] -- P5D-B.1 async business-state progression', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
    setOrchestrationWebhookEnv()
  })
  afterEach(resetEnv)

  const orderBody = { event_id: 'evt_order_1', event_type: 'payment_succeeded', content: { payment_id: 'peach_order_1', status: 'succeeded', amount: 9200, currency: 'ZAR' } }

  it('a captured order_payment triggers mark_order_paid before the event is marked processed', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-order-1', status: 'pending', payment_type: 'order_payment', amount: '92.00', currency: 'ZAR', order_id: 'order-1' }],
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(orderBody), routeParams))
    expect(response.status).toBe(200)
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names.indexOf('mark_order_paid')).toBeGreaterThan(names.indexOf('transition_payment_status'))
    expect(names.indexOf('mark_order_paid')).toBeLessThan(names.indexOf('mark_webhook_event_processed'))
  })

  it('a transient mark_order_paid failure is treated exactly like a reconciliation failure -- mark_webhook_event_error, 503, event never marked processed', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-order-1', status: 'pending', payment_type: 'order_payment', amount: '92.00', currency: 'ZAR', order_id: 'order-1' }],
      markOrderPaidResult: { data: null, error: new Error('order rpc failed') },
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(orderBody), routeParams))
    expect(response.status).toBe(503)
    expect(admin.rpcCalls.map((c) => c.name)).toContain('mark_webhook_event_error')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('mark_webhook_event_processed')
  })

  it('retry after a transient business-progression failure: payment now already_current, mark_order_paid safely retries and succeeds, event marked processed', async () => {
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 2 }, error: null },
      // Simulates the payment having already reached 'captured' on a
      // prior attempt (already_current), business progression not yet
      // having completed then.
      paymentsLookupRows: [{ id: 'pay-order-1', status: 'captured', payment_type: 'order_payment', amount: '92.00', currency: 'ZAR', order_id: 'order-1' }],
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(orderBody), routeParams))
    expect(response.status).toBe(200)
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).toContain('mark_order_paid')
    expect(names).toContain('mark_webhook_event_processed')
    expect(names).not.toContain('transition_payment_status')
  })

  it('a captured booking rental payment triggers the existing late-success check before the event is marked processed', async () => {
    const bookingBody = { event_id: 'evt_booking_1', event_type: 'payment_succeeded', content: { payment_id: 'peach_booking_1', status: 'succeeded', amount: 9200, currency: 'ZAR' } }
    const admin = fakeAdmin({
      claim: { data: { claimed: true, processing_status: 'processing', processing_attempts: 1 }, error: null },
      paymentsLookupRows: [{ id: 'pay-booking-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR', booking_id: 'booking-1' }],
      bookingRow: { status: 'expired', payment_expired_at: '2026-01-01T00:00:00Z' },
    })
    const response = await withAdmin(admin, () => POST(orchestrationRequest(bookingBody), routeParams))
    expect(response.status).toBe(200)
    expect(admin.rpcCalls.map((c) => c.name)).toContain('record_late_payment_reconciliation')
  })
})

describe('POST /api/payments/webhooks/[provider] -- body size limit', () => {
  beforeEach(() => {
    resetEnv()
    setStorageEnv()
    setOrchestrationWebhookEnv()
  })
  afterEach(resetEnv)

  it('rejects an oversized body with 413 before any authentication/parsing work', async () => {
    const admin = fakeAdmin({})
    const hugeBody = 'x'.repeat(70 * 1024)
    const request = new NextRequest('https://unity.test/api/payments/webhooks/peach', {
      method: 'POST',
      body: hugeBody,
      headers: { 'content-type': 'application/json', [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CUSTOM_SECRET, [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: sign(hugeBody) },
    })
    const response = await withAdmin(admin, () => POST(request, routeParams))
    expect(response.status).toBe(413)
    expect(admin.rpcCalls).toHaveLength(0)
  })
})
