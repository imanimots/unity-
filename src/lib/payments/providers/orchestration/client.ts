import type { OrchestrationConfig } from './config'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../../provider-errors'

/**
 * Thin Peach Orchestration HTTP client (P5C). Confirmed live: auth is a
 * single `api-key` header (not OAuth/bearer) -- see config.ts's own
 * comment for why the base URL itself is a required, explicit env var
 * rather than a hardcoded host.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so every
 * caller/test can supply a mock -- no test in this phase makes a real
 * network call.
 */

const DEFAULT_TIMEOUT_MS = 15_000

export interface OrchestrationClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class OrchestrationClient {
  private readonly config: OrchestrationConfig
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(config: OrchestrationConfig, options: OrchestrationClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async post(path: string, body: unknown, operation: string): Promise<unknown> {
    return this.request('POST', path, body, operation)
  }

  async get(path: string, operation: string): Promise<unknown> {
    return this.request('GET', path, undefined, operation)
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, operation: string): Promise<unknown> {
    const url = `${this.config.apiBaseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'api-key': this.config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError('peach-orchestration', operation)
      }
      // Network-level failure (DNS, connection refused, etc.) -- never
      // surface the raw error message, which could include the request
      // URL/host; retryable, since it says nothing about whether the
      // request itself was valid.
      throw new RetryableProviderError('peach-orchestration', operation, 'network error')
    } finally {
      clearTimeout(timeout)
    }

    let parsedBody: unknown
    try {
      parsedBody = await response.json()
    } catch {
      parsedBody = null
    }

    if (response.status >= 500) {
      throw new RetryableProviderError('peach-orchestration', operation, `HTTP ${response.status}`)
    }
    if (response.status === 429) {
      throw new RetryableProviderError('peach-orchestration', operation, 'rate limited')
    }
    if (response.status >= 400) {
      // Never forward the raw Peach response body to a client-facing
      // caller -- the orchestrator/route layer maps TerminalProviderError
      // to a generic, user-safe message, matching every other provider
      // integration convention in this codebase.
      throw new TerminalProviderError('peach-orchestration', operation, `HTTP ${response.status}`)
    }

    return parsedBody
  }
}

/**
 * Never logs the api-key value itself -- only ever placed in the
 * request header, never in a thrown error, never in a log line. This
 * function exists purely so a caller can confirm presence without
 * accidentally interpolating the config object (which contains the raw
 * key) into a log/error message elsewhere.
 */
export function sanitizedConfigSummary(config: OrchestrationConfig): string {
  return `environment=${config.environment}`
}
