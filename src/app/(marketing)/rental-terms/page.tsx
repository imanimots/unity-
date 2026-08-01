import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'

const doc = getLegalDocument('rental-terms')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How a rental booking works on Unity, from request to return.',
  alternates: { canonical: '/rental-terms' },
}

export default function RentalTermsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>
        This is a draft describing how a Unity rental booking works, matching the platform&apos;s current
        implementation. It is pending legal review.
      </p>

      <LegalSection title="Booking lifecycle">
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Requested</strong> — a renter requests a listing for specific dates. No dates are reserved yet.</li>
          <li><strong>Accepted</strong> — the merchant accepts. The dates are now reserved and a payment deadline is set (see <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>).</li>
          <li><strong>Active</strong> — the renter has completed required payment and the rental period has begun.</li>
          <li><strong>Return pending / Returned / Completed</strong> — either party marks the item as being returned; the other party confirms.</li>
        </ul>
        <p>A booking may also be rejected, cancelled, or expire unpaid — see the <Link href="/cancellations" className="underline">Cancellation Policy</Link>.</p>
      </LegalSection>

      <LegalSection title="Renter and merchant responsibilities">
        <p>
          The renter is responsible for using the item as described, within any stated restrictions, and returning
          it in the condition received (ordinary wear excepted). The merchant is responsible for the accuracy of
          the listing, the item&apos;s legality and safety, and making the item available for the agreed period.
          Unity is not a party to the rental agreement between renter and merchant.
        </p>
      </LegalSection>

      <LegalSection title="Financial readiness before a rental starts">
        <p>
          A booking can only move to Active once the required rental payment (and deposit, if any) has been
          successfully authorized — see the <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Prohibited items">
        <p>
          All listings and bookings are subject to the <Link href="/prohibited-items" className="underline">Prohibited Items Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Delivery and handover">
        <p>
          See the <Link href="/delivery-and-handover" className="underline">Delivery and Handover Terms</Link> for how items change hands.
        </p>
      </LegalSection>

      <LegalSection title="Disputes">
        <p>
          If something goes wrong with a booking, see the <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
