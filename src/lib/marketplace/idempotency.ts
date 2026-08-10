import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeCreateRequestHash(title: string, transactionType: string, description: string | null | undefined): string {
  return md5(`${title}|${transactionType}|${description ?? ''}`)
}

export function computeSubmitOfferHash(requestId: string, offerType: string, linkedListingId: string | null | undefined, amount: number | null | undefined): string {
  return md5(`${requestId}|${offerType}|${linkedListingId ?? ''}|${amount ?? ''}`)
}

export function computeAcceptOfferHash(offerId: string): string {
  return md5(offerId)
}
