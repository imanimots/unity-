import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'
import { CreateListingFlow } from './create-listing-flow'
import { getServerUser } from '@/lib/data/profiles'
import { getListingDraftForEdit } from '@/lib/data/listings'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

export const metadata = { title: 'Create Listing — Unity' }

interface Props {
  searchParams: Promise<{ edit?: string }>
}

// CreateListingFlow now reads useSearchParams() (barter return-flow —
// see create-listing-flow.tsx's getPostSaveRedirect), which requires a
// Suspense boundary, matching FilterBar/MarketplaceModeSelectorContainer's
// existing convention elsewhere in this codebase.
export default async function NewListingPage({ searchParams }: Props) {
  const locale = (await getLocale()) as Locale
  const { edit } = await searchParams
  if (!edit) {
    return (
      <Suspense fallback={null}>
        <CreateListingFlow />
      </Suspense>
    )
  }

  const { profile } = await getServerUser()
  if (!profile) redirect(withLocalePrefix('/login', locale))

  const draft = await getListingDraftForEdit(edit, profile.id)
  if (!draft) redirect(withLocalePrefix('/dashboard/merchant/listings', locale))

  return (
    <Suspense fallback={null}>
      <CreateListingFlow draft={draft} />
    </Suspense>
  )
}
