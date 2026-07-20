import { notFound } from 'next/navigation'
import { getListing } from '@/lib/data/listings'
import { BookingFlow } from './booking-flow'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) return { title: 'Not found' }
  return { title: `Book: ${listing.title} — Unity` }
}

export default async function BookPage({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) notFound()
  return <BookingFlow listing={listing} />
}
