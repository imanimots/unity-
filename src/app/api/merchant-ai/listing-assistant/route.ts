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
import { LISTING_ASSISTANT_SYSTEM_PROMPT } from '@/lib/merchant-ai/prompts'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'

const bodySchema = z.object({
  draftText: z.string().trim().min(1).max(4_000),
  fieldContext: z.string().max(100).optional(),
})

/**
 * POST /api/merchant-ai/listing-assistant -- Pro/Elite only (Section
 * 35/74). Advisory only: returns suggestions text, never writes to any
 * listing/offer itself (Section 39). The merchant's own draft is the
 * only user-authored content sent to the provider -- no KYC/payment/
 * private data ever enters the payload (Section 38).
 */
export async function POST(request: NextRequest) {
  if (!isMerchantAiAssistantEnabled()) {
    return NextResponse.json({ error: 'The merchant assistant is not currently available' }, { status: 503 })
  }

  const rate = checkRateLimit(`merchant-ai:listing:${getClientKey(request)}`, 20, 60_000)
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

  const allowed = await isMerchantAiCapabilityAllowed(admin, requester.userId, 'listing_assistant')
  if (!allowed) {
    return NextResponse.json({ error: 'The listing assistant requires an active Pro or Elite subscription' }, { status: 403 })
  }

  const merchantRate = checkMerchantAiRateLimit(requester.userId, 'listing_assistant')
  if (!merchantRate.allowed) {
    return NextResponse.json({ error: 'You have reached your assistant usage limit for this hour' }, { status: 429 })
  }

  const { planId } = await getEffectiveMerchantPlan(admin, requester.userId)

  const userPrompt = `${parsed.data.fieldContext ? `Field: ${parsed.data.fieldContext}\n\n` : ''}Current draft:\n${truncatePrompt(parsed.data.draftText)}\n\nSuggest specific improvements.`

  const result = await completeWithMerchantAiProvider({
    capability: 'listing_assistant',
    systemPrompt: LISTING_ASSISTANT_SYSTEM_PROMPT,
    userPrompt,
  })

  await recordMerchantAiUsage(admin, requester.userId, planId, 'listing_assistant', result, 'anthropic')

  if (result.status !== 'succeeded') {
    return NextResponse.json({ error: result.status === 'provider_unavailable' ? 'The assistant is temporarily unavailable' : 'Could not generate suggestions — please try again' }, { status: result.status === 'provider_unavailable' ? 503 : 500 })
  }

  return NextResponse.json({ suggestions: result.text })
}
