import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('delivery-and-handover')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How items are handed over between renter and merchant on Unity today.',
  alternates: { canonical: absoluteUrl('/delivery-and-handover') },
  robots: legalRobotsMeta(doc),
}

export default function DeliveryAndHandoverPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>This page reflects Unity&apos;s current MVP handover model. It is a draft, pending legal review.</p>

      <LegalSection title="Manual handover today">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Unity does not currently integrate with a live courier service (no live Bob Go or Pargo integration).</li>
          <li>Handover between renter and merchant is arranged manually between the two parties, through Unity&apos;s in-platform chat.</li>
          <li>If a courier or delivery provider is used, that provider is independent of Unity — Unity does not guarantee courier protection or delivery insurance.</li>
          <li>Any tracking information available comes from the courier itself, not from Unity.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Inspection">
        <p>
          Both parties should inspect the item&apos;s packaging and condition at handover and at return, and are
          encouraged to record condition with photos or video through the platform where possible.
        </p>
      </LegalSection>

      <LegalSection title="Failed delivery">
        <p>
          Responsibility for a failed or delayed delivery depends on its cause — for example, an incorrect address
          supplied by the renter is treated differently from a courier error. Unresolved handover issues can be
          raised as a dispute — see the <Link href="/disputes" className="underline">Dispute Resolution Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Privacy of addresses">
        <p>
          Exact pickup/delivery addresses remain private and are only shared between renter and merchant once a
          booking reaches the appropriate stage — not before.
        </p>
      </LegalSection>

      <LegalSection title="Staying on-platform">
        <p>
          Renters and merchants should not be encouraged to arrange payment or communication outside Unity to bypass
          these protections. See the <Link href="/terms" className="underline">Terms of Use</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Large items and vehicles">
        <p>
          Unity does not yet have approved handling rules specific to large items or vehicles beyond the general
          rules above. This section will be expanded once those rules are approved.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
