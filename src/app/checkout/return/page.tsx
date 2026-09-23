import { getAppUrl } from '@/lib/seo/config'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import type { Metadata } from 'next'

/**
 * Shopper-facing "confirming your payment" page (P5C) -- the one place
 * that actually reads `payments.status`, always fresh from the
 * database, never from anything the browser supplied. Reached only via
 * a 303 redirect from /api/payments/checkout-return, which itself never
 * reads or trusts a Peach-supplied status.
 *
 * Deliberately outside the [locale] segment for this phase, matching
 * the existing precedent of /admin also living outside [locale] --
 * localizing the return page is a presentational follow-up, not part
 * of this phase's payment-logic scope.
 *
 * Peach's own status vocabulary (requires_capture, succeeded, ...) never
 * appears here -- only Unity's own normalized payments.status values are
 * read, and only five broad, user-safe categories are ever rendered.
 */

export const metadata: Metadata = {
  metadataBase: new URL(getAppUrl()),
  robots: PERMANENT_NOINDEX,
}

type DisplayCategory = 'pending' | 'authorised' | 'captured' | 'failed' | 'cancelled'

function categorize(status: string | null): DisplayCategory {
  switch (status) {
    case 'authorised':
      return 'authorised'
    case 'captured':
    case 'partially_captured':
      return 'captured'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'released':
    case 'expired':
      return 'cancelled'
    default:
      // pending, or no matching payment found at all -- same safe,
      // non-committal "still confirming" copy either way.
      return 'pending'
  }
}

const COPY: Record<DisplayCategory, { heading: string; body: string }> = {
  pending: {
    heading: 'Confirming your payment',
    body: 'We’re still confirming this with our payment partner. This can take a moment — you don’t need to do anything else right now.',
  },
  authorised: {
    heading: 'Deposit authorised',
    body: 'Your deposit has been authorised. You’ll be notified once everything is finalised.',
  },
  captured: {
    heading: 'Payment successful',
    body: 'Your payment went through. You can find the details in your dashboard.',
  },
  failed: {
    heading: 'Payment did not go through',
    body: 'Something went wrong processing this payment. No funds were captured — please try again from your dashboard.',
  },
  cancelled: {
    heading: 'Payment cancelled',
    body: 'This payment was cancelled. No funds were captured.',
  },
}

async function loadPaymentStatus(providerReference: string | null): Promise<string | null> {
  if (!providerReference) return null

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data } = await admin.from('payments').select('status').eq('provider_reference', providerReference).maybeSingle()
    return data?.status ?? null
  } catch {
    // Never surface a raw DB/network error to the shopper on a payment
    // return page -- fall back to the safe "still confirming" state.
    return null
  }
}

export default async function CheckoutReturnPage({ searchParams }: { searchParams: Promise<{ payment_id?: string }> }) {
  const { payment_id: paymentId } = await searchParams
  const status = await loadPaymentStatus(paymentId ?? null)
  const category = categorize(status)
  const { heading, body } = COPY[category]

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FAF8F5] px-4">
      <div className="max-w-md w-full text-center">
        <h1 className="text-2xl font-semibold text-[#1A0A0A] mb-3">{heading}</h1>
        <p className="text-[#6B5B55]">{body}</p>
      </div>
    </main>
  )
}
