import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { CreateListingFlow } from './create-listing-flow'
import { getServerUser } from '@/lib/data/profiles'
import { getListingDraftForEdit } from '@/lib/data/listings'

export const metadata = { title: 'Create Listing — Unity' }

interface Props {
  searchParams: Promise<{ edit?: string }>
}

// CreateListingFlow now reads useSearchParams() (barter return-flow —
// see create-listing-flow.tsx's getPostSaveRedirect), which requires a
// Suspense boundary, matching FilterBar/MarketplaceModeSelectorContainer's
// existing convention elsewhere in this codebase.
export default async function NewListingPage({ searchParams }: Props) {
  const { edit } = await searchParams
  if (!edit) {
    return (
      <Suspense fallback={null}>
        <CreateListingFlow />
      </Suspense>
    )
  }

  const { profile } = await getServerUser()
  if (!profile) redirect('/login')

  const draft = await getListingDraftForEdit(edit, profile.id)
  if (!draft) redirect('/dashboard/merchant/listings')

  return (
    <Suspense fallback={null}>
      <CreateListingFlow draft={draft} />
    </Suspense>
  )
}
