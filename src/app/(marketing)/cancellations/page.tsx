import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('cancellations')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'When and how a booking can be cancelled on Unity.',
  alternates: { canonical: absoluteUrl('/cancellations') },
  robots: legalRobotsMeta(doc),
}

export default function CancellationsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>This page reflects the cancellation rules currently implemented on Unity. It is a draft, pending legal review.</p>

      <LegalSection title="Before merchant acceptance">
        <p>A renter may cancel a requested booking at any time before the merchant responds, at no cost.</p>
      </LegalSection>

      <LegalSection title="After acceptance, before payment">
        <p>
          Once a merchant accepts a booking, the renter must complete required payment within the deadline shown at
          checkout (see the <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>).
          Either party may still cancel an accepted-but-unpaid booking, subject to any cancellation-notice window
          shown on the listing.
        </p>
      </LegalSection>

      <LegalSection title="Payment deadline expiry">
        <p>
          If the renter does not complete required payment before the deadline, the booking automatically expires.
          The dates become available again, and no charge occurs. This is not treated as a cancellation by either
          party — it is an automatic expiry.
        </p>
      </LegalSection>

      <LegalSection title="Merchant cancellation">
        <p>
          A merchant may cancel an accepted booking, subject to any merchant cancellation-notice window shown on the
          listing at the time of booking.
        </p>
      </LegalSection>

      <LegalSection title="Active or completed bookings">
        <p>
          Once a booking is active (the rental period has started), it cannot be self-service cancelled by either
          party — any issue at that stage is handled as a dispute (see the{' '}
          <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>). Completed bookings cannot be cancelled.
        </p>
      </LegalSection>

      <LegalSection title="Refunds on cancellation">
        <p>
          In the current public test environment, no real payment is ever collected, so no automatic refund occurs
          on cancellation. In a future live environment, whether and how much is refunded will depend on the
          booking&apos;s payment status, the payment provider, and the applicable policy shown before payment — see
          the <Link href="/refunds" className="underline">Refund Policy</Link>. Unity does not apply fixed cancellation
          percentages or refund bands at this time; final live-transaction cancellation terms will be shown in the
          booking terms displayed before payment.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
