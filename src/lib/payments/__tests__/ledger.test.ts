import { describe, it, expect } from 'vitest'
import { deriveLedgerEntries } from '../ledger'

describe('deriveLedgerEntries — mirrors transition_payment_status()', () => {
  it('produces a rental_charge entry plus a platform_fee entry when a rental_charge is captured', () => {
    const entries = deriveLedgerEntries('rental_charge', 'captured', 1000)
    expect(entries).toEqual([
      { entryType: 'rental_charge', amount: 1000 },
      { entryType: 'platform_fee', amount: 50 },
    ])
  })

  it('produces a deposit_hold entry when a deposit is authorised', () => {
    expect(deriveLedgerEntries('deposit', 'authorised', 500)).toEqual([{ entryType: 'deposit_hold', amount: 500 }])
  })

  it('produces a deposit_release entry when a deposit is released', () => {
    expect(deriveLedgerEntries('deposit', 'released', 500)).toEqual([{ entryType: 'deposit_release', amount: 500 }])
  })

  it('produces a deposit_capture entry for both full and partial deposit capture', () => {
    expect(deriveLedgerEntries('deposit', 'captured', 500)).toEqual([{ entryType: 'deposit_capture', amount: 500 }])
    expect(deriveLedgerEntries('deposit', 'partially_captured', 150)).toEqual([{ entryType: 'deposit_capture', amount: 150 }])
  })

  it('produces no ledger entries for a rental_charge merely reaching pending or failed', () => {
    expect(deriveLedgerEntries('rental_charge', 'pending', 1000)).toEqual([])
    expect(deriveLedgerEntries('rental_charge', 'failed', 1000)).toEqual([])
  })

  it('produces no ledger entries for a deposit reaching a status with no financial-movement meaning (e.g. cancelled)', () => {
    expect(deriveLedgerEntries('deposit', 'cancelled', 500)).toEqual([])
  })

  it('a captured deposit does not also produce a platform_fee entry -- only rental charges do', () => {
    const entries = deriveLedgerEntries('deposit', 'captured', 500)
    expect(entries.some((e) => e.entryType === 'platform_fee')).toBe(false)
  })
})
