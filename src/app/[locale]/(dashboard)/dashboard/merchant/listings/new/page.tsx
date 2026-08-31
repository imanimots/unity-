import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'
import { CreateListingFlow } from './create-listing-flow'
import { getServerUser } from '@/lib/data/profiles'
import { getListingDraftForEdit } from '@/lib/data/listings'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

export const metadata = { title: 'Create Listing — Unity' }

interface Props {
  searchParams: Promise<{ edit?: string }>
}

// Reflects backend affiliate entitlement in the wizard UI (Part 12 of the
// affiliate P1 remediation) -- the actual enforcement is server-side in
// save_listing_draft regardless of what this renders; this is purely so a
// Starter merchant isn't shown a control that looks actionable when the
// backend will reject it.
async function resolveAffiliateEnabled(): Promise<boolean> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return false
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  return (await getMerchantEntitlements(supabase, user.id)).affiliateEnabled
}

// CreateListingFlow now reads useSearchParams() (barter return-flow —
// see create-listing-flow.tsx's getPostSaveRedirect), which requires a
// Suspense boundary, matching FilterBar/MarketplaceModeSelectorContainer's
// existing convention elsewhere in this codebase.
export default async function NewListingPage({ searchParams }: Props) {
  const locale = (await getLocale()) as Locale
  const { edit } = await searchParams
  const affiliateEnabled = await resolveAffiliateEnabled()

  if (!edit) {
    return (
      <Suspense fallback={null}>
        <CreateListingFlow affiliateEnabled={affiliateEnabled} />
      </Suspense>
    )
  }

  const { profile } = await getServerUser()
  if (!profile) redirect(withLocalePrefix('/login', locale))

  const draft = await getListingDraftForEdit(edit, profile.id)
  if (!draft) redirect(withLocalePrefix('/dashboard/merchant/listings', locale))

  return (
    <Suspense fallback={null}>
      <CreateListingFlow draft={draft} affiliateEnabled={affiliateEnabled} />
    </Suspense>
  )
}
