import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../../../../..')
const PAGE_PATH = join(REPO_ROOT, "src/app/[locale]/(auth)/reset-password/page.tsx")
const EN_AUTH_MESSAGES_PATH = join(REPO_ROOT, 'src/i18n/messages/en-ZA/auth.json')
const source = readFileSync(PAGE_PATH, 'utf-8')

/**
 * E16: hosted leaked-password protection readiness. updateUser({
 * password }) will start returning AuthWeakPasswordError (code
 * weak_password, reasons including 'pwned') once Supabase's
 * leaked-password protection is enabled. This guards the password
 * reset completion flow the same way as the signup flow.
 */
describe('reset-password page: updateUser error handling is leaked-password-safe', () => {
  it('1. never collapses every updateUser error into the single undifferentiated generic message', () => {
    // The old code was: `if (updateError) { setError(t('errors.generic')) ... }`
    // with nothing else between the error check and the generic fallback.
    expect(source).not.toMatch(/if \(updateError\) \{\s*setError\(t\('errors\.generic'\)\)/)
  })

  it('2. classifies the updateUser error via the shared classifyPasswordError helper', () => {
    expect(source).toMatch(/import \{ classifyPasswordError \} from '@\/lib\/auth\/password-error'/)
    expect(source).toMatch(/const reason = classifyPasswordError\(updateError\)/)
  })

  it('3. maps "leaked" and "weak" reasons to distinct, safe translated messages, falling back to generic', () => {
    expect(source).toMatch(/reason === 'leaked'\s*\n\s*\?\s*t\('errors\.leakedPassword'\)/)
    expect(source).toMatch(/:\s*reason === 'weak'\s*\n\s*\?\s*t\('errors\.weakPassword'\)/)
    expect(source).toMatch(/:\s*t\('errors\.generic'\)/)
  })

  it('4. the translated keys it references actually exist in the message dictionary', () => {
    const messages = JSON.parse(readFileSync(EN_AUTH_MESSAGES_PATH, 'utf-8'))
    expect(messages.resetPassword.errors.leakedPassword).toBeTruthy()
    expect(messages.resetPassword.errors.weakPassword).toBeTruthy()
    expect(messages.resetPassword.errors.generic).toBeTruthy()
  })

  it('5. a leaked/weak-password rejection is still distinct from the "invalid or expired link" state -- it never forces status to "invalid"', () => {
    const updateBlockMatch = source.match(/const \{ error: updateError \} = await supabase\.auth\.updateUser\(\{ password: data\.password \}\)[\s\S]*?\n  \}/)
    expect(updateBlockMatch, 'updateUser error-handling block not found').toBeTruthy()
    expect(updateBlockMatch![0]).not.toMatch(/setStatus\('invalid'\)/)
  })

  it('6. the recovery access/refresh tokens are still never logged (no regression to the existing Q guard)', () => {
    const consoleCalls = source.match(/console\.(log|error|warn|info|debug)\([^)]*\)/g) ?? []
    for (const call of consoleCalls) {
      expect(call).not.toMatch(/accessToken|refreshToken|access_token|refresh_token/)
    }
  })
})
