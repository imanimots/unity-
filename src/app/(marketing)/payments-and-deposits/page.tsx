import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('payments-and-deposits')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How payments and security deposits currently work on Unity, in test mode and in a future live environment.',
  alternates: { canonical: absoluteUrl('/payments-and-deposits') },
  robots: legalRobotsMeta(doc),
}

export default function PaymentsAndDepositsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <TestModeBanner />

      <p className="mt-2">This page describes Unity&apos;s actual payment architecture. It is a draft, pending legal review.</p>

      <LegalSection title="Public test environment (current)">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Payments are simulated by a test payment provider. No real money is charged.</li>
          <li>Security deposits are simulated — no real deposit is held.</li>
          <li>No real payout is ever made to a merchant.</li>
          <li>Test financial statuses (success, decline, retry, timeout) exist only to let users exercise the booking and checkout workflow.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Future live environment">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Once enabled, payments will be processed by an approved third-party payment provider.</li>
          <li>That provider&apos;s own terms and payment-method-specific rules may apply in addition to this policy.</li>
          <li>Booking status and payment status are always kept separate — a booking&apos;s contractual state and its financial state are tracked independently.</li>
          <li>Whether a security deposit is authorized, captured, or released — and how — depends on the selected payment provider and payment method.</li>
          <li>Unity does not describe payment handling as &quot;escrow&quot; unless that arrangement is confirmed with a regulated provider and approved by legal review.</li>
          <li>Unity does not promise an indefinite hold on any authorization, and does not promise card pre-authorization for payment methods that do not support it.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Payment deadlines">
        <p>
          Once a merchant accepts a booking, the renter has a limited window to complete required payment (see the
          booking&apos;s own checkout page for the exact deadline). If payment is not completed in time, the
          booking expires and the dates become available again — see the <Link href="/cancellations" className="underline">Cancellation Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Refunds">
        <p>
          See the <Link href="/refunds" className="underline">Refund Policy</Link> for how refunds, failed payments and
          chargebacks are handled.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
