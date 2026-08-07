import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('disputes')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How a booking dispute is raised and reviewed on Unity.',
  alternates: { canonical: absoluteUrl('/disputes') },
  robots: legalRobotsMeta(doc),
}

export default function DisputesPage() {
  return (
    <LegalPageLayout doc={doc}>
      <TestModeBanner />

      <p className="mt-2">This page is a draft, pending legal review.</p>

      <LegalSection title="When a dispute may be opened">
        <p>
          Either party to a booking may raise a dispute — most commonly after an active rental, if the item was not
          returned as agreed, was damaged, or was not received as described.
        </p>
      </LegalSection>

      <LegalSection title="Evidence">
        <p>
          A dispute is reviewed using the evidence available on the platform: booking details, in-platform messages,
          and any timestamped media or before-and-after condition evidence either party has uploaded. Off-platform
          evidence is not automatically visible to Unity.
        </p>
      </LegalSection>

      <LegalSection title="Response periods">
        <p>
          The other party to a dispute is given a reasonable opportunity to respond before Unity reviews the matter.
          Exact response-period lengths are still being finalized and will be published here once confirmed.
        </p>
      </LegalSection>

      <LegalSection title="Internal review">
        <p>
          Unity reviews the evidence submitted by both parties. This is an internal platform review, not a legal or
          arbitral proceeding, and does not replace either party&apos;s statutory rights.
        </p>
      </LegalSection>

      <LegalSection title="Possible outcomes">
        <p>In the current public test environment, no outcome below results in a real financial transaction:</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>No action — the booking&apos;s recorded state stands.</li>
          <li>Full or partial refund of the rental fee (once live payments exist).</li>
          <li>Deposit deduction, in whole or part, to cover confirmed loss or damage (once live payments exist).</li>
          <li>Merchant payout of some or all of the rental fee (once live payments exist).</li>
          <li>A split outcome combining the above.</li>
          <li>Account or listing suspension, where the evidence supports it, independent of any financial outcome.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Escalation and statutory rights">
        <p>
          If a dispute is not resolved to a party&apos;s satisfaction through Unity&apos;s process, nothing in this
          policy limits either party&apos;s statutory rights, including the right to pursue the matter through the
          National Consumer Commission, a South African court, or another applicable forum.
        </p>
      </LegalSection>

      <LegalSection title="Payments and deposits">
        <p>See the <Link href="/payments-and-deposits" className="underline">Payment and Deposit Policy</Link> and the <Link href="/refunds" className="underline">Refund Policy</Link> for how financial outcomes are actually processed.</p>
      </LegalSection>
    </LegalPageLayout>
  )
}
