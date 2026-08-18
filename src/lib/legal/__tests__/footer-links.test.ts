import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')
const FOOTER_PATH = join(REPO_ROOT, 'src/components/shared/footer.tsx')

function extractHrefs(content: string): string[] {
  const matches = [...content.matchAll(/href="([^"]+)"/g)]
  return matches.map((m) => m[1])
}

const ROUTE_GROUPS = ['(marketing)', '(auth)', '(dashboard)']

/** Resolves an internal Link href to the app-router page file it must map to, or null if it's not a page route (anchor/external/mailto). */
function resolveRouteFile(href: string): string | null {
  if (href.startsWith('http') || href.startsWith('mailto:') || href === '#') return null
  const [pathPart] = href.split('#')
  if (pathPart === '' || pathPart === '/') return join(REPO_ROOT, 'src/app/[locale]/(marketing)/page.tsx')
  const [routePath] = pathPart.slice(1).split('?')
  for (const group of ROUTE_GROUPS) {
    const candidate = join(REPO_ROOT, `src/app/[locale]/${group}/${routePath}/page.tsx`)
    if (existsSync(candidate)) return candidate
  }
  // None of the known groups had it -- report the most likely (marketing) path so the failure message is still useful.
  return join(REPO_ROOT, `src/app/[locale]/(marketing)/${routePath}/page.tsx`)
}

describe('footer links (category: Links)', () => {
  const content = readFileSync(FOOTER_PATH, 'utf-8')
  const hrefs = extractHrefs(content)

  // Footer.tsx is now internationalized (i18n Phase 2) -- it renders
  // t('footer.platform')/t('footer.trust')/t('footer.legal')/
  // t('footer.support') rather than literal English strings, so the
  // dictionary is the actual source of truth for the group labels now,
  // not the component source.
  it('17. the footer has at least one link in each required group (Platform, Trust, Legal, Support)', () => {
    expect(content).toMatch(/t\('footer\.platform'\)/)
    expect(content).toMatch(/t\('footer\.trust'\)/)
    expect(content).toMatch(/t\('footer\.legal'\)/)
    expect(content).toMatch(/t\('footer\.support'\)/)
    const enNavigation = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages/en-ZA/navigation.json'), 'utf-8'))
    expect(enNavigation.footer.platform).toBeTruthy()
    expect(enNavigation.footer.trust).toBeTruthy()
    expect(enNavigation.footer.legal).toBeTruthy()
    expect(enNavigation.footer.support).toBeTruthy()
  })

  it('18. every internal footer link resolves to an existing page file (no placeholder route)', () => {
    const missing: string[] = []
    for (const href of hrefs) {
      const routeFile = resolveRouteFile(href)
      if (routeFile && !existsSync(routeFile)) missing.push(href)
    }
    expect(missing).toEqual([])
  })

  it('19. every required legal route is actually linked from the footer', () => {
    const requiredLegalHrefs = [
      '/terms', '/privacy', '/popia', '/rental-terms', '/payments-and-deposits',
      '/cancellations', '/refunds', '/delivery-and-handover',
    ]
    for (const href of requiredLegalHrefs) {
      expect(hrefs, href).toContain(href)
    }
  })

  it('20. every required trust route is linked from the footer', () => {
    for (const href of ['/verification-and-trust', '/prohibited-items', '/disputes']) {
      expect(hrefs, href).toContain(href)
    }
  })

  it('21. the contact route is linked from the footer', () => {
    expect(hrefs).toContain('/contact')
  })

  it('22. the footer no longer links to any of the previously-broken placeholder routes', () => {
    for (const stale of ['/how-it-works', '/pricing', '/trust-and-safety', '/about']) {
      expect(hrefs, stale).not.toContain(stale)
    }
  })

  it('23. the navbar (not just the footer) also uses the working #how-it-works anchor, not the broken /how-it-works route', () => {
    const navbarContent = readFileSync(join(REPO_ROOT, 'src/components/shared/navbar.tsx'), 'utf-8')
    expect(navbarContent).not.toMatch(/href:\s*'\/how-it-works'/)
    expect(navbarContent).toMatch(/href:\s*'\/#how-it-works'/)
  })
})
