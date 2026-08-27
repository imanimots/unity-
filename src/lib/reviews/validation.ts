import { z } from 'zod'

export const REVIEW_DOMAINS = ['buy', 'rent', 'barter', 'rent_to_buy'] as const
export type ReviewDomain = (typeof REVIEW_DOMAINS)[number]

export const submitReviewSchema = z.object({
  domain: z.enum(REVIEW_DOMAINS),
  transaction_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
})
export type SubmitReviewRequest = z.infer<typeof submitReviewSchema>

export const submitReviewReplySchema = z.object({
  reply_text: z.string().trim().min(1).max(2000),
  idempotency_key: z.string().min(1).max(200).optional(),
})
export type SubmitReviewReplyRequest = z.infer<typeof submitReviewReplySchema>

export const REVIEW_REPORT_REASONS = ['harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'fabricated', 'other'] as const

export const reportReviewContentSchema = z.object({
  target_type: z.enum(['review', 'reply']),
  target_id: z.string().uuid(),
  reason: z.enum(REVIEW_REPORT_REASONS),
  description: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
})
export type ReportReviewContentRequest = z.infer<typeof reportReviewContentSchema>
