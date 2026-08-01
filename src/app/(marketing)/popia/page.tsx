import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'

const doc = getLegalDocument('popia')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'Unity\'s notice under the Protection of Personal Information Act (POPIA).',
  alternates: { canonical: '/popia' },
}

export default function PopiaPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>
        This is a draft notice under the Protection of Personal Information Act, 4 of 2013 (POPIA), published for
        Unity&apos;s public test phase and pending legal review. It supplements the{' '}
        <Link href="/privacy" className="underline">Privacy Policy</Link>.
      </p>

      <LegalSection title="Responsible party">
        <p>
          Unity is the responsible party for personal information processed through the platform, as described on
          the <Link href="/contact" className="underline">Contact page</Link>. Registered company details are being
          finalized and will be published here once confirmed.
        </p>
      </LegalSection>

      <LegalSection title="Lawful basis">
        <p>
          Personal information is processed on the basis of: your consent (for example, at registration and
          verification), performance of the agreement between you and Unity (operating your account and bookings),
          and Unity&apos;s legitimate interests in preventing fraud and maintaining a safe platform, and compliance
          with legal obligations. The exact lawful basis for each processing activity is pending final legal
          confirmation.
        </p>
      </LegalSection>

      <LegalSection title="Special personal information">
        <p>
          Identity documents submitted for verification may contain special personal information (for example, an
          ID number). This information is collected only for identity verification, stored in access-controlled
          private storage, and reviewed only by authorized Unity administrators.
        </p>
      </LegalSection>

      <LegalSection title="Retention">
        <p>Personal information is retained as required for legal, fraud, dispute and operational purposes.</p>
      </LegalSection>

      <LegalSection title="Your rights under POPIA">
        <p>
          Subject to POPIA, you have the right to access, correct, or request deletion of your personal information,
          to object to processing, and to lodge a complaint with the Information Regulator of South Africa if you
          believe your information has been processed unlawfully.
        </p>
      </LegalSection>

      <LegalSection title="Contact for privacy requests">
        <p>
          Use the privacy contact details on the <Link href="/contact" className="underline">Contact page</Link> to
          exercise any of the rights above.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}
