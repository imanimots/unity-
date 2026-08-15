'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  LayoutDashboard, Users, Package, Calendar,
  AlertTriangle, Link2, BookOpen, BarChart3,
  Menu, X, Shield, LogOut, ChevronRight, UserCheck, Mail,
  Wallet, Inbox, ScrollText, Repeat, ShoppingBag, DollarSign, Banknote, CreditCard, Percent, ShieldCheck, ClipboardList, KeyRound, Megaphone,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { IS_MOCK_MODE } from '@/lib/mock/data'

const NAV_ITEMS = [
  { href: '/admin',                     label: 'Overview',            icon: LayoutDashboard, exact: true },
  { href: '/admin/users',               label: 'Users',                icon: Users            },
  { href: '/admin/verifications',       label: 'Verifications',        icon: UserCheck        },
  { href: '/admin/listings',            label: 'Listings',             icon: Package          },
  { href: '/admin/bookings',            label: 'Bookings',             icon: Calendar         },
  { href: '/admin/financial-operations',label: 'Financial Operations', icon: Wallet           },
  { href: '/admin/email-deliveries',    label: 'Email Deliveries',     icon: Inbox            },
  { href: '/admin/exceptions',          label: 'Exception Queue',      icon: AlertTriangle    },
  { href: '/admin/audit',               label: 'Audit Log',            icon: ScrollText       },
  { href: '/admin/disputes',            label: 'Disputes',             icon: AlertTriangle    },
  { href: '/admin/barter',              label: 'Barter Trades',        icon: Repeat           },
  { href: '/admin/orders',              label: 'Orders',               icon: ShoppingBag      },
  { href: '/admin/affiliates',          label: 'Affiliates',           icon: Link2            },
  { href: '/admin/affiliate-commissions', label: 'Affiliate Commissions', icon: DollarSign     },
  { href: '/admin/payouts',             label: 'Merchant Payouts',     icon: Banknote         },
  { href: '/admin/subscriptions',       label: 'Merchant Subscriptions', icon: CreditCard     },
  { href: '/admin/commissions',         label: 'Unity Commissions',    icon: Percent          },
  { href: '/admin/escrow',              label: 'Secure Transactions',  icon: ShieldCheck      },
  { href: '/admin/marketplace-requests', label: 'Looking For',         icon: ClipboardList    },
  { href: '/admin/rent-to-buy',         label: 'Rent-to-Buy',          icon: KeyRound         },
  { href: '/admin/advertising',         label: 'Advertising',          icon: Megaphone        },
  { href: '/admin/knowledge-base',      label: 'Knowledge Base',       icon: BookOpen         },
  { href: '/admin/email-previews',      label: 'Email Previews',       icon: Mail             },
  { href: '/admin/analytics',           label: 'Analytics',            icon: BarChart3        },
]

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { signOut } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + '/')

  const handleSignOut = async () => {
    await signOut()
    router.replace('/')
  }

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex">

      {/* ── Sidebar ── */}
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-40 w-60 flex flex-col
        bg-[#1A0A0A] dark:bg-[#0F0A0A]
        border-r border-[#2A1A1A]
        transition-transform duration-300
        lg:translate-x-0 lg:static lg:z-auto
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-[#2A1A1A] shrink-0">
          <div className="w-7 h-7 rounded-lg bg-[#8B1A1A] flex items-center justify-center text-white text-xs font-black">
            U
          </div>
          <div>
            <div className="text-white font-extrabold text-sm tracking-tight uppercase">Unity</div>
            <div className="text-[#9B8B85] text-[10px] uppercase tracking-[0.12em]">Admin</div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto lg:hidden text-[#9B8B85] hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ href, label, icon: Icon, exact }) => {
            const active = isActive(href, exact)
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setSidebarOpen(false)}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active
                    ? 'bg-[#8B1A1A] text-white'
                    : 'text-[#9B8B85] hover:text-white hover:bg-[#2A1A1A]'
                  }
                `}
              >
                <Icon size={16} className="shrink-0" />
                {label}
                {active && <ChevronRight size={14} className="ml-auto opacity-60" />}
              </Link>
            )
          })}
        </nav>

        {/* Bottom */}
        <div className="px-3 py-4 border-t border-[#2A1A1A] shrink-0 space-y-1">
          <Link
            href="/"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#9B8B85] hover:text-white hover:bg-[#2A1A1A] transition-colors"
          >
            <LogOut size={16} className="shrink-0 rotate-180" />
            Back to Unity
          </Link>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-red-400 hover:bg-[#2A1A1A] transition-colors"
          >
            <LogOut size={16} className="shrink-0" />
            Exit Admin
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-16 flex items-center justify-between px-6 bg-white dark:bg-[#1A1010] border-b border-[#F2EDE8] dark:border-[#2A1A1A] shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 rounded-lg text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2">
              <Shield size={15} className="text-[#8B1A1A]" />
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#8B1A1A]">
                Admin Console
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#FAF8F5] dark:bg-[#2A1A1A] border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[11px] font-medium text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.1em]">
              {IS_MOCK_MODE ? 'Live · Mock Mode' : 'Live'}
            </span>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
