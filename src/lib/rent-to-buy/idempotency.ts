import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeSaveListingTermsHash(listingId: string, enabled: boolean, totalPurchasePrice: number, installmentAmount: number, installmentCount: number): string {
  return md5(`${listingId}|${enabled}|${totalPurchasePrice}|${installmentAmount}|${installmentCount}`)
}

export function computeCreateRequestHash(listingId: string): string {
  return md5(listingId)
}

export function computeAgreementActionHash(agreementId: string): string {
  return md5(agreementId)
}
