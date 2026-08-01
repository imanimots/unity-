import { redirect } from 'next/navigation'
import { CreateListingFlow } from './create-listing-flow'
import { getServerUser } from '@/lib/data/profiles'
import { getListingDraftForEdit } from '@/lib/data/listings'

export const metadata = { title: 'Create Listing — Unity' }

interface Props {
  searchParams: Promise<{ edit?: string }>
}

export default async function NewListingPage({ searchParams }: Props) {
  const { edit } = await searchParams
  if (!edit) return <CreateListingFlow />

  const { profile } = await getServerUser()
  if (!profile) redirect('/login')

  const draft = await getListingDraftForEdit(edit, profile.id)
  if (!draft) redirect('/dashboard/merchant/listings')

  return <CreateListingFlow draft={draft} />
}
