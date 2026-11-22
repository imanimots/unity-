'use client'

import { useState } from 'react'
import { Menu, X, ShieldAlert } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { AccountSidebarContent, type AccountSidebarProfile } from './account-sidebar-content'
import { Link } from '@/i18n/navigation'
import { ACCOUNT_STATUS_NOTICE } from '@/lib/help/contextual-copy'

interface AccountShellProps {
  profile: AccountSidebarProfile
  rentToBuyEnabled: boolean
  personalizationEnabled: boolean
  ambassadorUrl: string | undefined
  /** 'active' (or undefined) renders nothing -- see
   * src/lib/admin/account-status.ts for what each state actually
   * blocks. The banner is purely informational; the real gate is
   * server-side (blockIfCannotCreate/blockIfCannotTransact), so it
   * disappears on its own the next time this layout renders once the
   * account's status changes back to 'active' -- never a client-side
   * toggle to maintain. */
  accountStatus?: 'active' | 'restricted' | 'suspended' | 'erased'
  children: React.ReactNode
}

/**
 * The authenticated account shell (E47 Phase F): a persistent left
 * sidebar on desktop (Reference 05), a drawer on mobile (Phase AD --
 * "the persistent desktop sidebar may become: drawer, sheet, or compact
 * account navigation" rather than a squeezed permanent sidebar on a
 * 390px screen). Every (dashboard) page renders through this once, from
 * the shared (dashboard)/layout.tsx.
 */
export function AccountShell({ profile, rentToBuyEnabled, personalizationEnabled, ambassadorUrl, accountStatus, children }: AccountShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { signOut } = useAuth()
  const statusNotice = accountStatus === 'restricted' || accountStatus === 'suspended' ? ACCOUNT_STATUS_NOTICE[accountStatus] : null

  return (
    <div className="max-w-[1400px] mx-auto">
      {statusNotice && (
        <div className="mx-4 sm:mx-6 lg:ml-8 mb-4 flex items-start gap-2.5 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
          <ShieldAlert size={16} className="shrink-0 mt-0.5 text-amber-600" />
          <p className="flex-1">
            {statusNotice.text}{' '}
            <Link href={statusNotice.learnMoreHref} className="font-semibold underline">
              Learn more
            </Link>
          </p>
        </div>
      )}
      {/* Mobile account bar — avatar + name + menu trigger, opens the
          drawer. Margin only (not padding) since <main> deliberately
          carries none here -- every (dashboard) page already applies its
          own max-w/px gutter, so adding a second one here would double
          it up. */}
      <button
        onClick={() => setDrawerOpen(true)}
        className="lg:hidden w-[calc(100%-2rem)] mx-4 sm:w-[calc(100%-3rem)] sm:mx-6 flex items-center gap-3 p-3 rounded-xl border border-[#F2EDE8] bg-white mb-6"
      >
        <div className="w-9 h-9 rounded-full bg-[#F2EDE8] flex items-center justify-center text-sm font-bold text-[#1A0A0A] shrink-0">
          {profile.initial}
        </div>
        <span className="flex-1 text-left font-semibold text-sm text-[#1A0A0A] truncate">{profile.displayName}</span>
        <Menu size={18} className="text-[#6B5B55]" />
      </button>

      <div className="lg:flex lg:items-start">
        {/* Desktop persistent sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 sticky top-20 ml-4 sm:ml-6 lg:ml-8">
          <AccountSidebarContent
            profile={profile}
            rentToBuyEnabled={rentToBuyEnabled}
            personalizationEnabled={personalizationEnabled}
            ambassadorUrl={ambassadorUrl}
            onSignOut={signOut}
          />
        </aside>

        <main className="flex-1 min-w-0 pb-16">{children}</main>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-[60]">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[85%] max-w-sm bg-[#FAF8F5] p-4 overflow-y-auto">
            <button
              onClick={() => setDrawerOpen(false)}
              className="absolute top-4 right-4 p-2 rounded-lg text-[#6B5B55] hover:bg-[#F2EDE8]"
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
            <div className="pt-12 h-full">
              <AccountSidebarContent
                profile={profile}
                rentToBuyEnabled={rentToBuyEnabled}
                personalizationEnabled={personalizationEnabled}
                ambassadorUrl={ambassadorUrl}
                onNavigate={() => setDrawerOpen(false)}
                onSignOut={signOut}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
