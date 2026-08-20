import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isMerchantAiAssistantEnabled } from '@/lib/merchant-ai/config'
import { isMerchantAiCapabilityAllowed } from '@/lib/merchant-ai/entitlement'
import { checkMerchantAiRateLimit, truncatePrompt } from '@/lib/merchant-ai/safety'
import { completeWithMerchantAiProvider } from '@/lib/merchant-ai/provider'
import { recordMerchantAiUsage } from '@/lib/merchant-ai/usage'
import { ANALYTICS_ASSISTANT_SYSTEM_PROMPT, buildAnalyticsUserPrompt } from '@/lib/merchant-ai/prompts'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'
import { getCurrentMonthMerchantVolume } from '@/lib/subscriptions/monthly-volume'

const bodySchema = z.object({
  question: z.string().trim().min(1).max(1_000),
})

/**
 * POST /api/merchant-ai/analytics-assistant -- Elite only (Section 37/
 * 74). The model only ever sees STRUCTURED, already-aggregated,
 * merchant-owned metrics (Section 89) -- never raw buyer/order rows,
 * never another merchant's data. Real, already-available data only
 * (this month's sale/rental volume, own publication counts by status)
 * -- no fabricated statistic (Section 93).
 */
export async function POST(request: NextRequest) {
  if (!isMerchantAiAssistantEnabled()) {
    return NextResponse.json({ error: 'The merchant assistant is not currently available' }, { status: 503 })
  }

  const rate = checkRateLimit(`merchant-ai:analytics:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Assistant storage is not configured' }, { status: 503 })
  }

  const allowed = await isMerchantAiCapabilityAllowed(admin, requester.userId, 'analytics_assistant')
  if (!allowed) {
    return NextResponse.json({ error: 'The analytics assistant requires an active Elite subscription' }, { status: 403 })
  }

  const merchantRate = checkMerchantAiRateLimit(requester.userId, 'analytics_assistant')
  if (!merchantRate.allowed) {
    return NextResponse.json({ error: 'You have reached your assistant usage limit for this hour' }, { status: 429 })
  }

  const { planId } = await getEffectiveMerchantPlan(admin, requester.userId)

  const [volume, listingCounts, requestCounts, postCounts] = await Promise.all([
    getCurrentMonthMerchantVolume(admin, requester.userId),
    admin.from('listings').select('status').eq('merchant_id', requester.userId).eq('is_test', false),
    admin.from('marketplace_requests').select('status').eq('requester_id', requester.userId).eq('is_test', false),
    admin.from('barter_skill_task_posts').select('status').eq('owner_id', requester.userId).eq('is_test', false),
  ])

  const countByStatus = (rows: { status: string }[] | null) =>
    (rows ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})

  const structuredMetrics = {
    thisMonthSalesVolumeCents: volume.salesVolumeCents,
    thisMonthRentalVolumeCents: volume.rentalVolumeCents,
    listingsByStatus: countByStatus(listingCounts.data),
    marketplaceRequestsByStatus: countByStatus(requestCounts.data),
    skillTaskPostsByStatus: countByStatus(postCounts.data),
  }

  const result = await completeWithMerchantAiProvider({
    capability: 'analytics_assistant',
    systemPrompt: ANALYTICS_ASSISTANT_SYSTEM_PROMPT,
    userPrompt: buildAnalyticsUserPrompt(truncatePrompt(parsed.data.question), structuredMetrics),
  })

  await recordMerchantAiUsage(admin, requester.userId, planId, 'analytics_assistant', result, 'anthropic')

  if (result.status !== 'succeeded') {
    return NextResponse.json({ error: result.status === 'provider_unavailable' ? 'The assistant is temporarily unavailable' : 'Could not generate an answer — please try again' }, { status: result.status === 'provider_unavailable' ? 503 : 500 })
  }

  return NextResponse.json({ answer: result.text, metrics: structuredMetrics })
}
