import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('refunds')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How refunds are handled on Unity, today and in a future live environment.',
  alternates: { canonical: absoluteUrl('/refunds') },
  robots: legalRobotsMeta(doc),
}

export default function RefundsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <TestModeBanner />

      <p className="mt-2">This page is a draft, pending legal review.</p>

      <LegalSection title="Test-mode behaviour (current)">
        <p>
          Because no real payment is ever collected in the current public test environment, no real refund is ever
          issued. Test financial outcomes shown at checkout (success, decline, retry) exist only to exercise the
          workflow.
        </p>
      </LegalSection>

      <LegalSection title="Future live refunds">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Refunds, once live, will be processed by the payment provider that handled the original payment.</li>
          <li>Provider processing times will apply and are outside Unity&apos;s direct control — Unity does not promise instant refunds.</li>
          <li>Refunds are made to the original payment method used, where the provider supports this.</li>
          <li>Partial refunds may apply depending on the booking&apos;s outcome (for example, a partially completed rental or a dispute outcome — see the <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>).</li>
          <li>A duplicate or failed payment that was never successfully captured does not require a refund — it was never charged.</li>
          <li>Cancelled bookings are refunded according to the <Link href="/cancellations" className="underline">Cancellation Policy</Link> and the booking terms shown before payment.</li>
          <li>Deposit refunds (releases) depend on confirmation that the item was returned in the agreed condition.</li>
          <li>Chargebacks are handled according to the payment provider&apos;s own rules; Unity may request supporting evidence from both parties.</li>
        </ul>
      </LegalSection>

      <LegalSection title="What Unity does not promise">
        <p>
          Unity does not guarantee refund eligibility beyond what is stated in this policy and the booking terms
          shown before payment, and does not convert a refund a user is legally entitled to into platform credit
          without the user&apos;s agreement.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
