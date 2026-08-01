import { describe, it, expect } from 'vitest'
import { mapPeachResultCodeToOrchestrationError, isPeachSuccessResultCode } from '../error-mapper'

describe('mapPeachResultCodeToOrchestrationError', () => {
  it.each([
    ['800.100.151', 'provider_declined'],
    ['800.100.160', 'provider_declined'],
    ['800.100.155', 'provider_declined'],
    ['800.100.203', 'provider_declined'],
    ['800.100.153', 'provider_declined'],
    ['000.400.104', 'provider_configuration_error'],
    ['000.400.106', 'provider_declined'],
    ['700.300.100', 'invalid_payment_transition'],
    ['700.400.200', 'invalid_payment_transition'],
    ['800.120.100', 'provider_unavailable'],
    ['000.200.000', 'provider_timeout'],
    ['000.400.081', 'provider_timeout'],
  ])('%s -> %s', (code, expected) => {
    expect(mapPeachResultCodeToOrchestrationError(code)).toBe(expected)
  })

  it('falls back to terminal_provider_error for an unrecognized code rather than guessing', () => {
    expect(mapPeachResultCodeToOrchestrationError('999.999.999')).toBe('terminal_provider_error')
  })
})

describe('isPeachSuccessResultCode', () => {
  it.each(['000.000.000', '000.300.100', '000.500.100', '000.600.100', '000.400.110', '000.400.120', '000.400.100', '000.400.001'])(
    '%s is a success code',
    (code) => {
      expect(isPeachSuccessResultCode(code)).toBe(true)
    }
  )

  it.each(['800.100.151', '700.300.100', '000.400.104', '000.200.000'])('%s is not a success code', (code) => {
    expect(isPeachSuccessResultCode(code)).toBe(false)
  })
})
