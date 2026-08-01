import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().max(4_000),
      })
    )
    .max(20)
    .optional(),
  pageUrl: z.string().max(500).optional(),
  knowledgeContext: z.string().max(8_000).optional(),
})

const BASE_SYSTEM_PROMPT = `You are the Unity Assistant — the AI helper for Unity, South Africa's peer-to-peer rental marketplace.

Unity connects renters (people who need items) with merchants (people who earn by renting out what they own). Items available include cameras, drones, camping gear, power tools, audio equipment, bicycles, projectors, and more. Unity operates in Johannesburg, Cape Town, and Durban.

You help with:
- Finding and booking rentals
- Understanding Unity Score (0–5 trust rating)
- KYC verification (required before first booking or listing) — currently manual test verification by Unity administrators, not a third-party identity vendor
- Deposits (authorized at checkout, released after return is confirmed)
- Payments — Unity is currently in public test mode, so payments are simulated and no real money is charged
- Dispute resolution
- The affiliate program (earn commission on referrals)
- Merchant listings and requirements
- Return process and policies

Never claim payments are held in "escrow", never claim a specific third-party payment or identity provider is live unless the user explicitly asks about test/mock mode, and never state a specific cancellation-fee percentage or payout schedule that isn't confirmed in the knowledge base context provided to you.

Guidelines:
- Be warm, concise, and helpful — 2-3 sentences max unless more detail is requested
- All prices are in ZAR (South African Rand, R)
- Never fabricate specific prices, availability, or user data
- If context about a specific listing is provided, use it
- Suggest next steps when relevant (e.g. "You can complete KYC at /verify")`

function buildSystemPrompt(pageUrl?: string, knowledgeContext?: string): string {
  let prompt = BASE_SYSTEM_PROMPT

  if (pageUrl) {
    prompt += `\n\nUser's current page: ${pageUrl}`
    if (pageUrl.includes('/listings/') && pageUrl.includes('/book')) {
      prompt += '\nContext: User is in the booking flow for a specific listing.'
    } else if (pageUrl.includes('/listings/') && !pageUrl.includes('/listings?')) {
      prompt += '\nContext: User is viewing a specific listing detail page.'
    } else if (pageUrl.includes('/listings')) {
      prompt += '\nContext: User is browsing the listings catalogue.'
    } else if (pageUrl.includes('/dashboard/merchant')) {
      prompt += '\nContext: User is in their merchant dashboard.'
    } else if (pageUrl.includes('/dashboard/renter')) {
      prompt += '\nContext: User is in their renter dashboard.'
    } else if (pageUrl.includes('/dashboard/affiliate')) {
      prompt += '\nContext: User is viewing the affiliate program dashboard.'
    } else if (pageUrl.includes('/verify') || pageUrl.includes('/kyc')) {
      prompt += '\nContext: User is on the KYC/verification page.'
    } else if (pageUrl === '/' || pageUrl.includes('home')) {
      prompt += '\nContext: User is on the Unity homepage.'
    }
  }

  if (knowledgeContext) {
    prompt += `\n\nRelevant Unity knowledge base information:\n${knowledgeContext}`
  }

  return prompt
}

function getMockResponse(userMessage: string): string {
  const msg = userMessage.toLowerCase()
  if (msg.includes('hello') || msg.includes('hi') || msg.includes('hey') || msg.includes('help')) {
    return "Hi! I'm the Unity Assistant. I can help you rent items, understand how the platform works, answer questions about payments, KYC, deposits, and more. What do you need?"
  }
  if (msg.includes('book') || msg.includes('reserve')) {
    return "To book an item, select your dates on the listing page and send a request. You'll need KYC verification completed first, and the merchant needs to accept before you check out. The total includes the daily rate × days, plus any deposit — both are authorized at checkout and, for the deposit, released after return is confirmed."
  }
  if (msg.includes('kyc') || msg.includes('verify') || msg.includes('identity')) {
    return "KYC verification asks for your legal details, an ID or passport, and proof of address. It's currently reviewed manually by a Unity administrator (not a third-party identity vendor) — head to /verify to complete it. It's required before your first booking or listing."
  }
  if (msg.includes('unity score') || msg.includes('score')) {
    return "Your Unity Score (0–5) is your trust rating on the platform, built up through completed rentals and good reviews. Some premium listings require a minimum score to book."
  }
  if (msg.includes('deposit')) {
    return "Deposits are set by merchants and authorized at checkout. After you return the item and the merchant confirms it's in good condition, your deposit is released. In the current public test environment, this is simulated — no real money is held."
  }
  if (msg.includes('dispute') || msg.includes('damage') || msg.includes('problem')) {
    return "If something goes wrong, open a dispute from your bookings dashboard. Upload photos as evidence and describe the issue — see /disputes for how the review process works."
  }
  if (msg.includes('affiliate') || msg.includes('earn') || msg.includes('commission') || msg.includes('refer')) {
    return "To earn affiliate commissions, go to Dashboard > Affiliate Program and activate your account. You'll get a unique code to share on listings that accept affiliates."
  }
  if (msg.includes('list') || msg.includes('merchant') || msg.includes('rent out') || msg.includes('earn')) {
    return "To list an item, go to your Merchant Dashboard and click 'List an Item'. You'll need at least 3 photos and proof of ownership. Your listing is reviewed by Unity before it goes live."
  }
  if (msg.includes('payment') || msg.includes('payfast') || msg.includes('pay')) {
    return "Unity is currently in public test mode, so payments are simulated — no real money is charged. See /payments-and-deposits for how payments will work once a live payment provider is enabled."
  }
  if (msg.includes('cancel')) {
    return "You can cancel a request any time before the merchant responds, at no cost. After acceptance, cancellation rules depend on the notice period shown on the listing — see /cancellations for the full policy. In test mode, no real payment is ever collected, so there's nothing to refund yet."
  }
  if (msg.includes('payout') || msg.includes('withdraw') || msg.includes('bank')) {
    return "Unity is currently in public test mode — no real merchant payout is processed yet. Once live payments are enabled, payout timing and any platform fee will be confirmed in the Payment and Deposit Policy."
  }
  return "I'm here to help with anything Unity-related — renting, listing, payments, KYC, Unity Score, disputes, and more. What would you like to know?"
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  const rate = checkRateLimit(`chat:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', issues: parsed.error.issues }, { status: 400 })
  }

  const { messages = [], pageUrl, knowledgeContext } = parsed.data
  const systemPrompt = buildSystemPrompt(pageUrl, knowledgeContext)
  const encoder = new TextEncoder()

  // Mock mode: stream a canned response character by character
  if (!apiKey || apiKey === 'sk-ant-placeholder' || apiKey.startsWith('sk-ant-placeholder')) {
    const lastUserMsg = messages.findLast(m => m.role === 'user')?.content ?? ''
    const mockText = getMockResponse(lastUserMsg)
    const stream = new ReadableStream({
      async start(controller) {
        for (const char of mockText) {
          controller.enqueue(encoder.encode(char))
          await new Promise(r => setTimeout(r, 12))
        }
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }

  // Real Claude API streaming
  const client = new Anthropic({ apiKey })

  const validMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  if (!validMessages.length || validMessages[validMessages.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Last message must be from user' }, { status: 400 })
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const anthropicStream = client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages: validMessages,
        })

        for await (const event of anthropicStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        controller.enqueue(encoder.encode(`\n\nSorry, I ran into a problem: ${msg}`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
