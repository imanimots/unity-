import { z } from 'zod'

/**
 * Mirrors Peach's own current BANV field constraints exactly (confirmed
 * live this phase: accountNumber ^[0-9]{1,13}$, the 6 documented
 * accountType enum values) -- a 400 at this layer is a clean rejection,
 * never a substitute for the RPC's own equivalent checks.
 */
export const addPayoutDestinationSchema = z.object({
  bank_code: z.string().trim().min(1).max(100),
  account_number: z.string().regex(/^[0-9]{1,13}$/, 'Account number must be 1-13 numeric characters'),
  account_type: z.enum(['current_cheque_account', 'savings_account', 'transmission_account', 'bond_account', 'subscription_share', 'unknown']),
})

export type AddPayoutDestinationInput = z.infer<typeof addPayoutDestinationSchema>
