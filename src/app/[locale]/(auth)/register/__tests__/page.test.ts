import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../../../../..')
const PAGE_PATH = join(REPO_ROOT, "src/app/[locale]/(auth)/register/page.tsx")
const EN_AUTH_MESSAGES_PATH = join(REPO_ROOT, 'src/i18n/messages/en-ZA/auth.json')
const source = readFileSync(PAGE_PATH, 'utf-8')

/**
 * E16: hosted leaked-password protection readiness. signUp() will start
 * returning AuthWeakPasswordError (code weak_password, reasons
 * including 'pwned') once Supabase's leaked-password protection is
 * enabled. This guards against the raw backend error text ever being
 * shown to the user again, and confirms the signup error branch
 * classifies the error via the shared helper instead.
 */
describe('register page: signup error handling is leaked-password-safe', () => {
  it('1. never renders the raw Supabase error message directly', () => {
    expect(source).not.toMatch(/setError\(\s*authError\.message\s*\)/)
  })

  it('2. classifies the signUp error via the shared classifyPasswordError helper', () => {
    expect(source).toMatch(/import \{ classifyPasswordError \} from '@\/lib\/auth\/password-error'/)
    expect(source).toMatch(/const reason = classifyPasswordError\(authError\)/)
  })

  it('3. maps "leaked" and "weak" reasons to distinct, safe translated messages, falling back to generic', () => {
    expect(source).toMatch(/reason === 'leaked'\s*\n\s*\?\s*t\('errors\.leakedPassword'\)/)
    expect(source).toMatch(/:\s*reason === 'weak'\s*\n\s*\?\s*t\('errors\.weakPassword'\)/)
    expect(source).toMatch(/:\s*t\('errors\.generic'\)/)
  })

  it('4. the translated keys it references actually exist in the message dictionary', () => {
    const messages = JSON.parse(readFileSync(EN_AUTH_MESSAGES_PATH, 'utf-8'))
    expect(messages.register.errors.leakedPassword).toBeTruthy()
    expect(messages.register.errors.weakPassword).toBeTruthy()
    expect(messages.register.errors.generic).toBeTruthy()
  })

  it('5. still never passes the plaintext password into trackEvent/analytics metadata', () => {
    const trackCalls = source.match(/trackEvent\([^)]*\)/g) ?? []
    for (const call of trackCalls) {
      expect(call).not.toMatch(/data\.password|password:/)
    }
  })
})
