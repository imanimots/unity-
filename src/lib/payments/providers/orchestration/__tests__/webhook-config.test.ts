import { describe, it, expect } from 'vitest'
import { loadOrchestrationWebhookConfig, requireOrchestrationWebhookConfig, OrchestrationWebhookConfigurationError, ORCHESTRATION_WEBHOOK_SECRET_HEADER } from '../webhook-config'

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('loadOrchestrationWebhookConfig', () => {
  it('returns null (never throws) when neither env var is set', () => {
    expect(loadOrchestrationWebhookConfig(env({}))).toBeNull()
  })

  it('returns a config when both are set', () => {
    const config = loadOrchestrationWebhookConfig(env({ PEACH_ORCHESTRATION_WEBHOOK_SECRET: 'secret-1', PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY: 'key-1' }))
    expect(config).toEqual({ customSecretHeaderName: ORCHESTRATION_WEBHOOK_SECRET_HEADER, customSecretValue: 'secret-1', paymentResponseHashKey: 'key-1' })
  })

  it('throws when only the custom secret is set (partial config is a misconfiguration, not "not configured")', () => {
    expect(() => loadOrchestrationWebhookConfig(env({ PEACH_ORCHESTRATION_WEBHOOK_SECRET: 'secret-1' }))).toThrow(OrchestrationWebhookConfigurationError)
  })

  it('throws when only the hash key is set', () => {
    expect(() => loadOrchestrationWebhookConfig(env({ PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY: 'key-1' }))).toThrow(OrchestrationWebhookConfigurationError)
  })

  it('treats a whitespace-only value as absent', () => {
    expect(loadOrchestrationWebhookConfig(env({ PEACH_ORCHESTRATION_WEBHOOK_SECRET: '   ', PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY: '   ' }))).toBeNull()
  })
})

describe('requireOrchestrationWebhookConfig', () => {
  it('throws (fail-closed) when not configured', () => {
    expect(() => requireOrchestrationWebhookConfig(env({}))).toThrow(OrchestrationWebhookConfigurationError)
  })

  it('returns the config when configured', () => {
    const config = requireOrchestrationWebhookConfig(env({ PEACH_ORCHESTRATION_WEBHOOK_SECRET: 'secret-1', PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY: 'key-1' }))
    expect(config.customSecretValue).toBe('secret-1')
  })
})
