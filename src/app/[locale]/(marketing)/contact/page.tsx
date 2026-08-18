import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'
import { getLegalDocument } from '@/lib/legal/registry'
import { legalRobotsMeta } from '@/lib/seo/legal-metadata'
import { absoluteUrl } from '@/lib/seo/config'

const doc = getLegalDocument('contact')!

export const metadata: Metadata = {
  title: `${doc.title} — Unity`,
  description: 'How to reach Unity for support, legal, or privacy matters.',
  alternates: { canonical: absoluteUrl('/contact') },
  robots: legalRobotsMeta(doc),
}

export default function ContactPage() {
  return (
    <LegalPageLayout doc={doc}>
      <p>
        Unity is currently in public test — the contact details below are the public-test support channel.
        Production contact details will be published once confirmed.
      </p>

      <LegalSection title="Support">
        <p>For questions about your account, a booking, or using the platform: <strong>support@unitytest.co.za</strong></p>
        <p className="text-xs text-[#9B8B85]">Expected response target: within 2 business days during the public test phase. This is a target, not a guarantee.</p>
      </LegalSection>

      <LegalSection title="Legal">
        <p>For legal notices or Terms of Use questions: <strong>legal@unitytest.co.za</strong></p>
      </LegalSection>

      <LegalSection title="Privacy and POPIA requests">
        <p>To exercise a privacy right described in the <Link href="/privacy" className="underline">Privacy Policy</Link> or <Link href="/popia" className="underline">POPIA Notice</Link>, or to lodge a complaint: <strong>privacy@unitytest.co.za</strong></p>
      </LegalSection>

      <LegalSection title="Business details">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Business name: Unity</li>
          <li>Operating country: South Africa</li>
          <li>Registered company name and registration number: to be confirmed — pending company-secretarial and legal confirmation.</li>
          <li>Support hours: not yet formally defined for the public test phase.</li>
        </ul>
      </LegalSection>
    </LegalPageLayout>
  )
}
