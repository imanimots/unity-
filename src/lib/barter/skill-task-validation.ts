import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const milestoneTemplateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  sequence: z.number().int().positive(),
  weight_percent: z.number().positive().max(100),
})

export const saveSkillTaskPostDraftSchema = z.object({
  kind: z.enum(['skill', 'task'] as const).optional(),
  direction: z.enum(['available', 'looking_for'] as const).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(3000).optional(),
  category_slug: z.string().trim().max(100).optional(),
  delivery_mode: z.enum(['remote', 'in_person', 'either'] as const).optional(),
  province: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
  exclusions: z.string().trim().max(2000).optional(),
  materials_arrangement: z.string().trim().max(1000).optional(),
  evidence_expectations: z.string().trim().max(1000).optional(),
  desired_exchange_notes: z.string().trim().max(1000).optional(),
  wants_item: z.boolean().optional(),
  wants_skill: z.boolean().optional(),
  wants_task: z.boolean().optional(),
  wants_cash_adjustment: z.boolean().optional(),
  availability_notes: z.string().trim().max(1000).optional(),
  preferred_start_date: z.string().date().optional(),
  preferred_start_time: z.string().optional(),
  deadline: z.string().date().optional(),
  expected_duration_notes: z.string().trim().max(500).optional(),
  milestone_templates: z.array(milestoneTemplateSchema).max(20).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const updateSkillTaskPostSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(3000).optional(),
  delivery_mode: z.enum(['remote', 'in_person', 'either'] as const).optional(),
  province: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
  exclusions: z.string().trim().max(2000).optional(),
  materials_arrangement: z.string().trim().max(1000).optional(),
  evidence_expectations: z.string().trim().max(1000).optional(),
  desired_exchange_notes: z.string().trim().max(1000).optional(),
  availability_notes: z.string().trim().max(1000).optional(),
  preferred_start_date: z.string().date().optional(),
  preferred_start_time: z.string().optional(),
  deadline: z.string().date().optional(),
  expected_duration_notes: z.string().trim().max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const skillTaskLifecycleActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const reportSkillTaskPostSchema = z.object({
  reason: z.enum(['harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'prohibited_content', 'other'] as const),
  description: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminSuspendSkillTaskPostSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminRestoreSkillTaskPostSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const scheduleMilestoneSchema = z.object({
  scheduled_at: z.string().datetime(),
  scheduled_city: z.string().trim().min(1).max(200),
  scheduled_province: z.string().trim().min(1).max(200),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const confirmMilestoneScheduleSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const completeMilestoneSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const createBarterReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const registerMilestoneEvidenceSchema = z.object({
  storage_path: z.string().trim().min(1).max(500),
  file_type: z.enum(['image', 'pdf', 'document'] as const),
  display_order: z.number().int().min(0).max(100).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})
