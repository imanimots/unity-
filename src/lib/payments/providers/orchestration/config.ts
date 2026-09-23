/**
 * Peach Orchestration configuration -- environment variables only, never
 * a secret in code (P5C). Mirrors the existing classic peach/config.ts's
 * own discipline (read env vars, validate shape, never make a network
 * call here), but with a genuinely different variable set: Orchestration
 * authenticates with a single api-key header, not the classic OAuth
 * client-credentials or basic-auth models.
 *
 * PEACH_ORCHESTRATION_API_BASE_URL is deliberately a required, explicit
 * env var rather than a hardcoded sandbox/production host pair -- unlike
 * every classic Peach host (which this repo's earlier research directly
 * confirmed from documentation), the real Orchestration REST API's own
 * base URL was never directly confirmed by any fetch performed across
 * P5B.2-R or P5C (only the interactive-docs/playground host was). Rather
 * than guess a host for a live financial API, this is left to be
 * supplied explicitly once confirmed (e.g. from the Peach dashboard or
 * direct API-reference lookup) -- required, not defaulted.
 */

export type OrchestrationEnvironmentName = 'sandbox' | 'production'

export interface OrchestrationConfig {
  environment: OrchestrationEnvironmentName
  apiBaseUrl: string
  apiKey: string
}

export class OrchestrationConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestrationConfigurationError'
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Returns null (never throws) when Orchestration is not configured at
 * all -- the same "absent config is not an error, just unavailable"
 * convention as loadPeachConfig() for the classic modules, so a caller
 * (the provider adapter) can fall through to a clear "not configured"
 * error only at the point an operation is actually attempted, not at
 * import/module-load time.
 */
export function loadOrchestrationConfig(env: NodeJS.ProcessEnv = process.env): OrchestrationConfig | null {
  const environment = readEnv(env, 'PEACH_ORCHESTRATION_ENVIRONMENT')
  const apiBaseUrl = readEnv(env, 'PEACH_ORCHESTRATION_API_BASE_URL')
  const apiKey = readEnv(env, 'PEACH_ORCHESTRATION_API_KEY')

  if (!environment && !apiBaseUrl && !apiKey) return null

  if (environment !== 'sandbox' && environment !== 'production') {
    throw new OrchestrationConfigurationError('PEACH_ORCHESTRATION_ENVIRONMENT must be "sandbox" or "production"')
  }
  if (!apiBaseUrl) {
    throw new OrchestrationConfigurationError('PEACH_ORCHESTRATION_API_BASE_URL is required when Orchestration is configured')
  }
  if (!apiKey) {
    throw new OrchestrationConfigurationError('PEACH_ORCHESTRATION_API_KEY is required when Orchestration is configured')
  }

  return { environment, apiBaseUrl, apiKey }
}

export interface OrchestrationConfigStatus {
  healthy: boolean
  detail: string
}

/** No network call -- shape validation only, mirrors describePeachConfigStatus()'s own contract. */
export function describeOrchestrationConfigStatus(config: OrchestrationConfig | null): OrchestrationConfigStatus {
  if (!config) return { healthy: false, detail: 'Peach Orchestration is not configured' }
  return { healthy: true, detail: `environment=${config.environment}` }
}
