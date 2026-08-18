import { notFound } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
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
  // A sale-only listing has no daily rate to book — the "Book Now" CTA
  // is never shown for one (see the listing detail page), but this route
  // is still reachable by a direct/typed URL, so guard here too.
  if (listing.daily_rate === null || listing.daily_rate === undefined) notFound()

  // Narrowly scoped nested provider (same principle as the root's public
  // message minimization and the (auth) layout's own scoped provider) --
  // this is a public/anonymous-reachable page, so it gets exactly the
  // namespaces BookingFlow needs, never the full message tree.
  const messages = await getMessages()
  const scoped = {
    rent: messages.rent,
    common: { actions: messages.common.actions, state: messages.common.state },
    errors: { validation: messages.errors.validation, generic: messages.errors.generic, network: messages.errors.network },
  }

  return (
    <NextIntlClientProvider messages={scoped}>
      <BookingFlow listing={{ ...listing, daily_rate: listing.daily_rate }} />
    </NextIntlClientProvider>
  )
}
