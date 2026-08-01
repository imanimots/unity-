import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'

const doc = getLegalDocument('terms')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'The terms that govern use of the Unity peer-to-peer rental marketplace.',
  alternates: { canonical: '/terms' },
}

export default function TermsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>
        This is a draft Terms of Use, published for Unity&apos;s public test phase. It has not yet been reviewed
        or approved by Unity&apos;s legal advisors. Nothing on this page is legal advice, and nothing here creates
        a guarantee beyond what is expressly stated.
      </p>

      <LegalSection title="1. What Unity is">
        <p>
          Unity is a peer-to-peer rental marketplace platform operating in South Africa. Unity connects people who
          want to rent out items they own (&quot;merchants&quot;) with people who want to rent those items
          (&quot;renters&quot;), and provides the tools to list items, request and accept bookings, communicate,
          check out, and manage the rental lifecycle.
        </p>
      </LegalSection>

      <LegalSection title="2. What Unity is not">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Unity is not the renter or the merchant in any transaction — the rental agreement is between them.</li>
          <li>Unity does not own, inspect, or take possession of any listed item.</li>
          <li>Unity is not a courier or delivery provider — see the <Link href="/delivery-and-handover" className="underline">Delivery and Handover Terms</Link>.</li>
          <li>Unity does not currently provide a licensed escrow service. Payment and deposit handling is described in the <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>.</li>
          <li>Unity does not guarantee that any booking, listing, or transaction will complete successfully, or that any user will act as represented.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Definitions">
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>Renter</strong> — a user who books and pays for the use of an item for a rental period.</li>
          <li><strong>Merchant</strong> — a user who lists an item for rent.</li>
          <li><strong>Listing</strong> — an item, with its description, photos, pricing, and requirements, published by a merchant.</li>
          <li><strong>Booking</strong> — a specific request, and if accepted, agreement, to rent a listing for a rental period.</li>
          <li><strong>Rental period</strong> — the start and end date/time a booking covers.</li>
          <li><strong>Payment provider</strong> — the third-party or test service that processes a booking&apos;s financial authorization (see <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>).</li>
          <li><strong>Security deposit</strong> — an additional amount a merchant may require to cover loss or damage, authorized separately from the rental fee.</li>
          <li><strong>Verification</strong> — Unity&apos;s review of a user&apos;s identity or a listing&apos;s ownership evidence (see <Link href="/verification-and-trust" className="underline">Verification and Trust</Link>).</li>
          <li><strong>Ownership evidence</strong> — documentation or media a merchant submits to support their claim of ownership or authority to rent out an item.</li>
          <li><strong>Courier or delivery provider</strong> — an independent third party who may be used to transport an item between renter and merchant.</li>
          <li><strong>Dispute</strong> — a disagreement between a renter and merchant about a booking, raised through Unity&apos;s process (see <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>).</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. Platform role">
        <p>Unity:</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>connects renters and merchants, and provides booking, messaging, checkout, and dispute workflows;</li>
          <li>manages the platform&apos;s technical workflows — listing moderation, identity and ownership review, payment orchestration, and booking lifecycle rules;</li>
          <li>relies on third-party providers where applicable (for example, a payment provider once live payments are enabled);</li>
          <li>may suspend or restrict a user&apos;s account, or remove a listing, where Unity reasonably believes there is a risk of fraud, illegality, or a breach of this or any related policy.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Public test environment">
        <p>
          Unity is currently operating as a public test. Payments are simulated — see the{' '}
          <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link> — and the platform&apos;s
          workflows may change without notice as testing continues.
        </p>
      </LegalSection>

      <LegalSection title="6. Other policies">
        <p>
          This Terms of Use is read together with the{' '}
          <Link href="/privacy" className="underline">Privacy Policy</Link>,{' '}
          <Link href="/popia" className="underline">POPIA Notice</Link>,{' '}
          <Link href="/rental-terms" className="underline">Rental Terms</Link>,{' '}
          <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link>,{' '}
          <Link href="/cancellations" className="underline">Cancellation Policy</Link>,{' '}
          <Link href="/refunds" className="underline">Refund Policy</Link>,{' '}
          <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>,{' '}
          <Link href="/prohibited-items" className="underline">Prohibited Items Policy</Link>, and{' '}
          <Link href="/delivery-and-handover" className="underline">Delivery and Handover Terms</Link>.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
