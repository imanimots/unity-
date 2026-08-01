'use client'

import { CHECKOUT_TEST_SCENARIOS, CHECKOUT_TEST_SCENARIO_LABELS, type CheckoutTestScenario } from '@/lib/checkout/test-scenario'

interface Props {
  value: CheckoutTestScenario
  onChange: (scenario: CheckoutTestScenario) => void
  disabled?: boolean
}

/**
 * Only ever rendered by the checkout page when the server has confirmed
 * (via GET .../financial-status's testModeAvailable flag) that scenario
 * selection is currently permitted -- this component itself renders
 * unconditionally once mounted, the gating decision belongs to the
 * caller. The server independently re-validates PAYMENT_PROVIDER +
 * NEXT_PUBLIC_PAYMENT_MODE on every POST regardless of what this control
 * shows, so a forged scenario value from a tampered client is rejected
 * server-side either way.
 */
export function TestPaymentScenarioSelector({ value, onChange, disabled }: Props) {
  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-dashed border-amber-400/60 dark:border-amber-500/40 p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-amber-600 dark:text-amber-400">Test mode — choose an outcome</p>
        <span className="text-[10px] font-mono text-[#9B8B85]">Provider: MockProvider</span>
      </div>
      <div className="space-y-2">
        {CHECKOUT_TEST_SCENARIOS.map((scenario) => (
          <label
            key={scenario}
            className="flex items-start gap-2.5 text-sm cursor-pointer rounded-lg px-2 py-1.5 -mx-2 hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]"
          >
            <input
              type="radio"
              name="test_scenario"
              value={scenario}
              checked={value === scenario}
              onChange={() => onChange(scenario)}
              disabled={disabled}
              className="mt-0.5 accent-[#8B1A1A]"
            />
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{CHECKOUT_TEST_SCENARIO_LABELS[scenario]}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
