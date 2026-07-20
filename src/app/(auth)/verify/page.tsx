import { KycFlow } from './kyc-flow'

export const metadata = { title: 'Verify Your Identity — Unity' }

export default function VerifyPage() {
  return (
    <div className="w-full max-w-md">
      {/* Page heading */}
      <div className="mb-10 text-center">
        <h1
          className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3"
          style={{ fontSize: 'clamp(36px, 5vw, 64px)' }}
        >
          VERIFY IDENTITY.
        </h1>
        <p className="text-[#6B5B55] text-base">Confirm who you are to unlock all features.</p>
      </div>

      <KycFlow />
    </div>
  )
}
