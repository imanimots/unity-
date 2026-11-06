import { isAuthWeakPasswordError } from '@supabase/supabase-js'

export type PasswordErrorReason = 'leaked' | 'weak' | 'generic'

/**
 * Classifies a Supabase Auth error from a password-setting call
 * (signUp/updateUser) so the UI can show a safe, specific message
 * instead of the raw backend error text. Never inspects or logs the
 * password itself -- only the error Supabase Auth returned.
 */
export function classifyPasswordError(error: unknown): PasswordErrorReason {
  if (isAuthWeakPasswordError(error)) {
    return error.reasons.includes('pwned') ? 'leaked' : 'weak'
  }
  return 'generic'
}
