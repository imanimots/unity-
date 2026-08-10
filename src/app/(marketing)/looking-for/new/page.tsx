import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/supabase/require-admin'
import { RequestForm } from '@/components/marketplace/request-form'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

export const metadata: Metadata = { title: 'Post a Request — Unity', robots: PERMANENT_NOINDEX }

/** Requires sign-in to reach the form at all (publishing itself is additionally KYC-gated server-side in the RPC). Browsing requests never requires sign-in. */
export default async function NewLookingForRequestPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?next=/looking-for/new')

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen pt-24 pb-24 px-6 lg:px-12">
      <div className="max-w-[1400px] mx-auto">
        <p className="section-label mb-4">Looking For</p>
        <h1 className="section-heading font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-10">
          Post What<br className="hidden sm:block" /> You Need.
        </h1>
        <RequestForm />
      </div>
    </div>
  )
}
