import { describe, it, expect, vi } from 'vitest'
import { OrchestrationClient } from '../client'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../../provider-errors'
import type { OrchestrationConfig } from '../config'

const config: OrchestrationConfig = {
  environment: 'sandbox',
  apiBaseUrl: 'https://sandbox.example/orchestration',
  apiKey: 'super-secret-test-key-not-real',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('OrchestrationClient -- no real network call is ever made (fetch is always injected)', () => {
  it('sends the api-key header, JSON content type, and JSON-stringified body on POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { payment_id: 'p_1', status: 'requires_confirmation' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })

    await client.post('/payments', { amount: 9200, currency: 'ZAR' }, 'create_payment')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sandbox.example/orchestration/payments')
    expect(init.method).toBe('POST')
    expect(init.headers['api-key']).toBe('super-secret-test-key-not-real')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ amount: 9200, currency: 'ZAR' })
  })

  it('sends GET requests with no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { payment_id: 'p_1', status: 'succeeded', amount: 9200, currency: 'ZAR' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })

    await client.get('/payments/p_1', 'get_payment')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sandbox.example/orchestration/payments/p_1')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('returns the parsed JSON body on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { payment_id: 'p_1', status: 'succeeded' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    const result = await client.post('/payments/p_1/capture', {}, 'capture_deposit')
    expect(result).toEqual({ payment_id: 'p_1', status: 'succeeded' })
  })

  it('maps a 5xx response to RetryableProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    await expect(client.post('/payments', {}, 'create_payment')).rejects.toThrow(RetryableProviderError)
  })

  it('maps a 429 response to RetryableProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate_limited' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    await expect(client.post('/payments', {}, 'create_payment')).rejects.toThrow(RetryableProviderError)
  })

  it('maps a 4xx response (other than 429) to TerminalProviderError, without leaking the raw response body in the thrown error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_request', detail: 'super-secret-internal-detail' }))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    try {
      await client.post('/payments', {}, 'create_payment')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalProviderError)
      expect((err as Error).message).not.toContain('super-secret-internal-detail')
    }
  })

  it('maps an aborted request (timeout) to ProviderTimeoutError', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock, timeoutMs: 1 })
    await expect(client.post('/payments', {}, 'create_payment')).rejects.toThrow(ProviderTimeoutError)
  })

  it('maps a generic network failure to RetryableProviderError, without leaking the raw error message (which could contain the host)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND sandbox.example'))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    try {
      await client.post('/payments', {}, 'create_payment')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryableProviderError)
      expect((err as Error).message).not.toContain('ENOTFOUND')
      expect((err as Error).message).not.toContain('sandbox.example')
    }
  })

  it('never includes the api key anywhere in a thrown error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}))
    const client = new OrchestrationClient(config, { fetchImpl: fetchMock })
    try {
      await client.post('/payments', {}, 'create_payment')
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-test-key-not-real')
    }
  })
})
