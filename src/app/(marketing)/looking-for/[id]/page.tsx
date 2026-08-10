import { notFound } from 'next/navigation'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getMarketplaceRequestDetail } from '@/lib/data/marketplace-requests'
import { RequestDetailClient } from '@/components/marketplace/request-detail-client'
import { absoluteUrl, PERMANENT_NOINDEX } from '@/lib/seo/config'
import { resolveLookingForRequestRobots } from '@/lib/marketplace/seo'

interface PageProps {
  params: Promise<{ id: string }>
}

/**
 * Public request-detail metadata follows the existing marketplace
 * indexing gate (isMarketplaceIndexingEnabled(), same authority as
 * /listings/[id]) rather than a separate/hardcoded switch -- currently
 * resolves noindex since that gate is globally off, and only becomes
 * indexable later if that same approved gate is ever turned on. A
 * request only qualifies as "active/public" here if it's in the same
 * status set the public browse listing actually surfaces
 * (active/offers_received, matching getMarketplaceRequests()'s own
 * filter) -- draft, matched, completed, closed, archived, date_passed,
 * or any is_test fixture always stay PERMANENT_NOINDEX regardless of
 * the gate, mirroring /listings/[id]'s own is_test carve-out. Metadata
 * is always resolved as an anonymous viewer (viewerUserId: null) so an
 * owner viewing their own draft never gets different metadata than the
 * public would -- indexability must never depend on who's looking.
 */
export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return { title: 'Request — Unity', robots: PERMANENT_NOINDEX }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)
  const detail = await getMarketplaceRequestDetail(admin, id, null)
  if (!detail) return { title: 'Request not found — Unity', robots: PERMANENT_NOINDEX }

  const req = detail.request as { title: string; status: string; is_test: boolean }
  const robots = resolveLookingForRequestRobots(req.status, req.is_test)
  const marketplaceIndexable = robots.index
  const canonicalUrl = absoluteUrl(`/looking-for/${id}`)
  const title = `${req.title} — Looking For — Unity`

  return {
    title,
    alternates: marketplaceIndexable ? { canonical: canonicalUrl } : undefined,
    robots,
  }
}

/** Step O -- public request detail, calling the shared detail resolver directly (not a self-fetch, which would need manual cookie forwarding to preserve isOwner detection). */
export default async function LookingForDetailPage({ params }: PageProps) {
  const { id } = await params
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) notFound()

  const requester = await getRequestProfile()

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const detail = await getMarketplaceRequestDetail(admin, id, requester?.userId ?? null)
  if (!detail) notFound()

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen pt-24 pb-24 px-6 lg:px-12">
      <div className="max-w-[1400px] mx-auto">
        <RequestDetailClient
          request={detail.request as never}
          requesterName={detail.requesterName}
          requesterVerified={detail.requesterVerified}
          isOwner={detail.isOwner}
          initialOffers={detail.offers as never}
          currentUserId={requester?.userId ?? null}
        />
      </div>
    </div>
  )
}
