import { notFound } from 'next/navigation'
import { getListing } from '@/lib/data/listings'
import { BuyFlow } from './buy-flow'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) return { title: 'Not found' }
  return { title: `Buy: ${listing.title} — Unity` }
}

export default async function BuyPage({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) notFound()
  // A rental-only listing has no sale price to buy — the "Buy Now" CTA
  // is never shown for one (see the listing detail page), but this route
  // is still reachable by a direct/typed URL, so guard here too.
  if (listing.sale_price === null || listing.sale_price === undefined) notFound()
  return <BuyFlow listing={{ ...listing, sale_price: listing.sale_price }} />
}
