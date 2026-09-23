import { describe, it, expect } from 'vitest'
import { loadOrchestrationConfig, describeOrchestrationConfigStatus, OrchestrationConfigurationError } from '../config'

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('loadOrchestrationConfig', () => {
  it('returns null when nothing is configured -- not an error', () => {
    expect(loadOrchestrationConfig(env({}))).toBeNull()
  })

  it('loads a complete sandbox config', () => {
    const config = loadOrchestrationConfig(
      env({
        PEACH_ORCHESTRATION_ENVIRONMENT: 'sandbox',
        PEACH_ORCHESTRATION_API_BASE_URL: 'https://sandbox.example/orchestration',
        PEACH_ORCHESTRATION_API_KEY: 'test-key-not-real',
      })
    )
    expect(config).toEqual({
      environment: 'sandbox',
      apiBaseUrl: 'https://sandbox.example/orchestration',
      apiKey: 'test-key-not-real',
    })
  })

  it('rejects an invalid PEACH_ORCHESTRATION_ENVIRONMENT value', () => {
    expect(() =>
      loadOrchestrationConfig(
        env({ PEACH_ORCHESTRATION_ENVIRONMENT: 'staging', PEACH_ORCHESTRATION_API_BASE_URL: 'https://x', PEACH_ORCHESTRATION_API_KEY: 'k' })
      )
    ).toThrow(OrchestrationConfigurationError)
  })

  it('rejects a config missing the API base URL', () => {
    expect(() => loadOrchestrationConfig(env({ PEACH_ORCHESTRATION_ENVIRONMENT: 'sandbox', PEACH_ORCHESTRATION_API_KEY: 'k' }))).toThrow(
      OrchestrationConfigurationError
    )
  })

  it('rejects a config missing the API key', () => {
    expect(() =>
      loadOrchestrationConfig(env({ PEACH_ORCHESTRATION_ENVIRONMENT: 'sandbox', PEACH_ORCHESTRATION_API_BASE_URL: 'https://x' }))
    ).toThrow(OrchestrationConfigurationError)
  })
})

describe('describeOrchestrationConfigStatus', () => {
  it('reports unhealthy for a null config, with no crash', () => {
    expect(describeOrchestrationConfigStatus(null)).toEqual({ healthy: false, detail: 'Peach Orchestration is not configured' })
  })

  it('reports healthy for a present config and never includes the api key in the detail string', () => {
    const status = describeOrchestrationConfigStatus({ environment: 'sandbox', apiBaseUrl: 'https://x', apiKey: 'super-secret-value' })
    expect(status.healthy).toBe(true)
    expect(status.detail).not.toContain('super-secret-value')
  })
})
