import { NextRequest, NextResponse } from 'next/server'
import { absoluteUrl } from '@/lib/seo/config'

/**
 * GET/POST /api/payments/checkout-return -- the shopper-facing return
 * endpoint after Peach Orchestration's Hosted Checkout (P5C).
 *
 * Accepts BOTH GET and POST: Orchestration's exact return HTTP method
 * was not confirmed by any fetch performed across P5B.2-R/P5C (a
 * `redirect_to_merchant_with_http_post`-style toggle was referenced in
 * the phase brief's own facts but never independently verified by this
 * session's own research against the docs actually fetched) -- rather
 * than guess one method and risk silently dropping the other, both are
 * handled identically here.
 *
 * The ONLY thing this route does with whatever Peach includes on return
 * is extract a `payment_id` reference to know which Unity payment to
 * show a "confirming" page for. It never reads or trusts any
 * status-shaped field from the query string or body -- see
 * docs/PAYMENT_ARCHITECTURE.md's security model and this phase's own
 * "UX ONLY -- NOT PAYMENT AUTHORITY" requirement. The actual payment
 * state is always re-derived server-side from `payments.status` by the
 * page this redirects to, which queries the database directly -- never
 * from anything this route received.
 *
 * No webhook-driven state mutation happens here or anywhere in P5C --
 * that is explicitly P5D scope.
 */

const RETURN_PATH = '/api/payments/checkout-return'

export function orchestrationReturnUrl(): string {
  return absoluteUrl(RETURN_PATH)
}

async function extractPaymentId(request: NextRequest): Promise<string | null> {
  const fromQuery = request.nextUrl.searchParams.get('payment_id')
  if (fromQuery) return fromQuery

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? ''
    try {
      if (contentType.includes('application/json')) {
        const body = (await request.json()) as unknown
        if (body && typeof body === 'object' && 'payment_id' in body) {
          const value = (body as Record<string, unknown>).payment_id
          if (typeof value === 'string') return value
        }
      } else {
        // application/x-www-form-urlencoded or multipart/form-data
        const form = await request.formData()
        const value = form.get('payment_id')
        if (typeof value === 'string') return value
      }
    } catch {
      // Malformed body -- fall through to the no-reference case below.
    }
  }

  return null
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const paymentId = await extractPaymentId(request)

  // Redirect (never render financial state directly from this route) to
  // a neutral confirmation page. That page is the one place that reads
  // `payments.status` server-side -- this route deliberately does not
  // do that lookup itself, keeping "accept the return" and "show current
  // state" as two separate steps, the same separation this phase's own
  // design calls for.
  const target = new URL('/checkout/return', request.nextUrl.origin)
  if (paymentId) target.searchParams.set('payment_id', paymentId)

  return NextResponse.redirect(target, { status: 303 })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
