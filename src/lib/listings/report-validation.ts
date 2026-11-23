import { z } from 'zod'

export const LISTING_REPORT_REASONS = [
  'prohibited_item',
  'misleading_listing',
  'scam_fraud',
  'counterfeit',
  'inappropriate_content',
  'other',
] as const

export const reportListingSchema = z.object({
  reason: z.enum(LISTING_REPORT_REASONS),
  description: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
})
export type ReportListingRequest = z.infer<typeof reportListingSchema>
