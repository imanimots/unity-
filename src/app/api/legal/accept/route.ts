import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { resolvePolicyVersions } from '@/lib/legal/registry'

const bodySchema = z.object({
  policies: z.array(z.string().min(1).max(64)).min(1).max(10),
  context: z.enum(['registration', 'booking_request', 'checkout', 'verification']),
})

/**
 * POST /api/legal/accept -- records that the authenticated user accepted
 * one or more policies at a given consent checkpoint (Step 7). The only
 * consent checkpoint NOT using this route is listing submission, which
 * already has its own richer, versioned mechanism
 * (listing_declarations / submit_listing_for_review(), Phase 2A) --
 * reused unchanged rather than duplicated here.
 *
 * user_id is always requester.userId from the verified session -- never
 * client-supplied, so the browser cannot forge whose acceptance is
 * recorded. policy_version is always resolved server-side from the legal
 * registry (src/lib/legal/registry.ts) -- the client sends only slugs, it
 * cannot claim to have accepted a specific version. Unknown slugs are
 * silently dropped (resolvePolicyVersions), never invented. Insert-only,
 * via the service-role client -- legal_acceptances has no anon/
 * authenticated write policy at all (Step 7 migration) and is immutable
 * (prevent_row_mutation trigger, reused).
 *
 * This route is deliberately fire-and-forget from the caller's
 * perspective for non-registration contexts (the primary action --
 * booking/checkout/verification submission -- has already succeeded by
 * the time this is called); a failure here is logged, not surfaced as a
 * user-facing error, since it must never block an already-successful
 * primary action.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`legal:accept:${getClientKey(request)}`, 30, 60_000)
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
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const resolved = resolvePolicyVersions(parsed.data.policies)
  if (resolved.length === 0) {
    return NextResponse.json({ error: 'No recognized policies to record' }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const rows = resolved.map(({ slug, version }) => ({
      user_id: requester.userId,
      policy_slug: slug,
      policy_version: version,
      context: parsed.data.context,
    }))

    const { error } = await admin.from('legal_acceptances').insert(rows)
    if (error) {
      console.error('[legal.accept] insert error', { userId: requester.userId, context: parsed.data.context, error })
      return NextResponse.json({ error: 'Could not record acceptance' }, { status: 500 })
    }

    return NextResponse.json({ recorded: resolved.map((r) => r.slug) })
  } catch (err) {
    console.error('[legal.accept] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not record acceptance' }, { status: 500 })
  }
}
