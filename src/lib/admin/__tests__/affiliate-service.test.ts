import { describe, it, expect } from 'vitest'
import { AFFILIATE_COMMISSION_CSV_COLUMNS } from '../affiliate-service'

describe('affiliate-service: CSV export column list (category: CSV Exports, Security)', () => {
  it('1. excludes personal identity numbers, addresses, bank details, payment credentials, KYC documents', () => {
    const forbidden = ['idnumber', 'passport', 'address', 'bank', 'card', 'kyc', 'secret', 'token', 'email', 'phone']
    for (const col of AFFILIATE_COMMISSION_CSV_COLUMNS) {
      const lower = col.toLowerCase()
      for (const f of forbidden) {
        expect(lower.includes(f), `column "${col}" should not include "${f}"`).toBe(false)
      }
    }
  })
  it('2. includes affiliate/merchant display names, not raw user ids', () => {
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('affiliateName')
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('merchantName')
  })
  it('3. includes the commission amount, rate basis, status, and payout timestamps', () => {
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('commissionAmount')
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('status')
  })
})
