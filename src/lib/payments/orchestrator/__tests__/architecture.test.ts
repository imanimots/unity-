import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../../..')
const BOOKING_DIRS = [join(REPO_ROOT, 'src/lib/bookings'), join(REPO_ROOT, 'src/app/api/bookings')]
const ORCHESTRATOR_DIR = join(REPO_ROOT, 'src/lib/payments/orchestrator')
const PROVIDER_FILES = [join(REPO_ROOT, 'src/lib/payments/providers/mock-provider.ts'), join(REPO_ROOT, 'src/lib/payments/providers/peach-provider.ts')]

function allTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allTsFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('architecture fitness: booking domain stays provider-agnostic', () => {
  it('no booking file imports MockProvider or PeachPaymentsProvider directly', () => {
    const offenders: string[] = []
    for (const dir of BOOKING_DIRS) {
      for (const file of allTsFiles(dir)) {
        const content = readFileSync(file, 'utf-8')
        if (/from ['"].*providers\/mock-provider['"]/.test(content) || /from ['"].*providers\/peach-provider['"]/.test(content)) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the booking accept route does not import a provider or the orchestrator at all -- as of Step 5, financial authorization is a separate, renter-triggered checkout step (see docs/MOCK_CHECKOUT.md)', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/bookings/[id]/accept/route.ts'), 'utf-8')
    expect(content).not.toMatch(/providers\/mock-provider|providers\/peach-provider/)
    expect(content).not.toMatch(/from '@\/lib\/payments\/orchestrator'/)
  })
})

describe('architecture fitness: provider adapters contain no booking-state mutations', () => {
  it('neither provider file references the bookings table or booking_status', () => {
    for (const file of PROVIDER_FILES) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(/\.from\(['"]bookings['"]\)/)
      expect(content).not.toMatch(/booking_status/)
    }
  })
})

describe('architecture fitness: orchestrator uses the provider registry, not a hardcoded provider', () => {
  it('every orchestrator workflow file that talks to a provider imports getPaymentProvider from the registry', () => {
    // create-merchant-payout.ts deliberately does NOT talk to a provider
    // (Step 11 Phase 8, review correction 1) -- it creates the pending
    // payout obligation only; provider invocation belongs to a future,
    // separately-approved processing integration. See the dedicated
    // architecture test below for that guarantee.
    const filesExpectedToUseAProvider = ['authorize-booking-financials.ts', 'release-deposit.ts', 'capture-deposit.ts']
    for (const name of filesExpectedToUseAProvider) {
      const content = readFileSync(join(ORCHESTRATOR_DIR, name), 'utf-8')
      expect(content).toMatch(/from ['"]\.\.\/registry['"]/)
      expect(content).toMatch(/getPaymentProvider/)
    }
  })

  it('create-merchant-payout.ts never calls a payout provider at creation time (Step 11 Phase 8 correction 1)', () => {
    const content = readFileSync(join(ORCHESTRATOR_DIR, 'create-merchant-payout.ts'), 'utf-8')
    expect(content).not.toMatch(/getPaymentProvider/)
    expect(content).not.toMatch(/provider\.createMerchantPayout/)
  })

  it('no orchestrator file imports a concrete provider class directly', () => {
    for (const file of allTsFiles(ORCHESTRATOR_DIR)) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(/from ['"].*providers\/mock-provider['"]/)
      expect(content).not.toMatch(/from ['"].*providers\/peach-provider['"]/)
    }
  })
})

describe('architecture fitness: orchestrator never writes ledger rows directly', () => {
  it('no orchestrator file inserts into ledger_entries -- only the existing payment RPCs do', () => {
    for (const file of allTsFiles(ORCHESTRATOR_DIR)) {
      const content = readFileSync(file, 'utf-8')
      expect(content).not.toMatch(/\.from\(['"]ledger_entries['"]\)\s*\.\s*insert/)
    }
  })

  it('every ledger-affecting orchestrator step goes through an RPC call (transition_payment_status or capture_deposit_amount)', () => {
    const authorizeContent = readFileSync(join(ORCHESTRATOR_DIR, 'authorize-booking-financials.ts'), 'utf-8')
    expect(authorizeContent).toMatch(/rpc\(['"]transition_payment_status['"]/)
    const captureContent = readFileSync(join(ORCHESTRATOR_DIR, 'capture-deposit.ts'), 'utf-8')
    expect(captureContent).toMatch(/rpc\(['"]capture_deposit_amount['"]/)
  })
})

describe('architecture fitness: PaymentProvider interface stays generic', () => {
  it('does not expose Unity-specific workflow methods like acceptBookingAndCharge', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/lib/payments/provider.ts'), 'utf-8')
    expect(content).not.toMatch(/acceptBookingAndCharge|completeRentalAndReleaseDeposit/)
  })
})
