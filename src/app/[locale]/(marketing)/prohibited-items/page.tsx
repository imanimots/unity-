import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('prohibited-items')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'Items and transactions that are not permitted on Unity.',
  alternates: { canonical: absoluteUrl('/prohibited-items') },
  robots: legalRobotsMeta(doc),
}

export default function ProhibitedItemsPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>This page is a draft, pending legal review. It applies to every listing on Unity, regardless of category.</p>

      <LegalSection title="Prohibited">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Illegal goods, or goods whose rental is illegal in South Africa.</li>
          <li>Stolen goods, or items without lawful ownership or authority to rent out.</li>
          <li>Firearms, ammunition, and firearm components.</li>
          <li>Explosives and fireworks (beyond consumer-legal, non-listable quantities).</li>
          <li>Controlled substances and drug paraphernalia.</li>
          <li>Counterfeit or unlicensed replica goods.</li>
          <li>Hazardous materials (flammable, toxic, corrosive, or radioactive materials).</li>
          <li>Prescription medication and medical devices requiring a prescription.</li>
          <li>Regulated financial products or instruments.</li>
          <li>Anything facilitating adult services or illegal content.</li>
          <li>Surveillance equipment intended for covert use, and malicious or unauthorized-access software.</li>
          <li>Wildlife products or contraband regulated under CITES or South African conservation law.</li>
          <li>Items subject to a safety recall, or that are otherwise unsafe for their stated use.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Ownership evidence does not override this policy">
        <p>
          Submitting ownership evidence for a listing (see{' '}
          <Link href="/verification-and-trust" className="underline">Verification and Trust</Link>) does not make a
          prohibited item permitted. A listing may be rejected or removed under this policy even where ownership is
          not in question.
        </p>
      </LegalSection>

      <LegalSection title="Reporting a prohibited listing">
        <p>
          If you believe a listing violates this policy, contact Unity via the{' '}
          <Link href="/contact" className="underline">Contact page</Link> with the listing link and a description of
          the concern. Unity reviews reports and may suspend a listing or account while investigating.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
