import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../../../../..')

const FILES = [
  'src/app/api/auth/forgot-password/route.ts',
  'src/app/[locale]/(auth)/reset-password/page.tsx',
  'src/app/[locale]/(auth)/forgot-password/page.tsx',
]

// Static regression guard: recovery access/refresh tokens and the raw
// email-request error must never be piped into a console.* call or
// rendered directly into JSX -- a future edit could otherwise leak a
// sensitive value into server logs or the page without any live test
// catching it (logs/DOM content aren't exercised by the API/E2E suites).
describe('password recovery: raw tokens are never logged or rendered (Q)', () => {
  for (const relPath of FILES) {
    it(`${relPath} never logs accessToken/refreshToken`, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), 'utf8')
      const consoleCalls = source.match(/console\.(log|error|warn|info|debug)\([^)]*\)/g) ?? []
      for (const call of consoleCalls) {
        expect(call).not.toMatch(/accessToken|refreshToken|access_token|refresh_token/)
      }
    })
  }
})
