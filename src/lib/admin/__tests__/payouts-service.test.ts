import { describe, it, expect } from 'vitest'
import { ADMIN_PAYOUT_CSV_COLUMNS } from '../payouts-service'

describe('payouts-service: CSV export column list (category: CSV Exports, Security)', () => {
  it('1. excludes personal identity numbers, addresses, banking details, payment credentials, raw failure text', () => {
    const forbidden = ['idnumber', 'passport', 'address', 'bank', 'card', 'kyc', 'secret', 'token', 'email', 'phone', 'rawfailure', 'failuremessage']
    for (const col of ADMIN_PAYOUT_CSV_COLUMNS) {
      const lower = col.toLowerCase()
      for (const f of forbidden) {
        expect(lower.includes(f), `column "${col}" should not include "${f}"`).toBe(false)
      }
    }
  })
  it('2. includes merchant display name, not a raw merchant id', () => {
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('merchantName')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).not.toContain('merchantId')
  })
  it('3. includes amount, currency, status, and payout lifecycle timestamps', () => {
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('amount')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('currency')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('status')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('paidAt')
  })
})
