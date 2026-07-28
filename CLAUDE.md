@AGENTS.md

# Unity — Claude Code Master Brief

This file is the master instruction set for Claude Code when working on the Unity platform.
**Always read this file first. Then read all files in docs/ before writing any code.**

---

## What is Unity?

Unity is a peer-to-peer rental marketplace launching in South Africa (JHB, Cape Town, Durban).
Users can rent out items they own, or rent from others instead of buying.
MVP scope: peer-to-peer rentals, buying & selling, and affiliate marketing.
Explicitly out of scope — do not build or plan: loans, collateral-backed
lending, credit building, credit scoring, credit bureau reporting, or NCR
registration workflows. Risk is assessed by the Risk Engine, not a credit
score — see `docs/RISK_ENGINE.md`. Buying & selling design is in
`docs/BUYING_SELLING.md`.

---

## Project Docs (Read in This Order)

| File | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | Tech stack, folder structure, database schema |
| `docs/BRAND.md` | Brand identity, tone, values, visual direction |
| `docs/FEATURES.md` | All platform features, MVP scope, build checklist |
| `docs/PAGES.md` | Every page, every section, every component |
| `docs/USERS.md` | User types, journeys, workflows |
| `docs/INTEGRATIONS.md` | All third-party APIs, keys, env vars |

---

## Confirmed Build Spec (Non-Negotiable)

### Scope
- ✅ Full platform — not a landing page
- ✅ Both user types (renter + merchant) built with equal priority, frictionless UX
- ✅ South Africa launch, but **architecture must support country selector** for future international expansion
- ✅ Ready ASAP — build lean, build clean

### Sign-Up Flow
- User chooses **Renter** or **Merchant** at sign-up
- KYC is **optional at sign-up** — user can click "Skip for now"
- KYC becomes **required** before first booking (renter) or first listing (merchant)

### Renter Entry Point
- After sign-up → **Homepage** with recommended items feed
- Navigation: top menu (website) / bottom nav (mobile)

### Merchant Entry Point
- After sign-up → **Merchant Dashboard**
- Dashboard shows: listings, earnings overview, pending booking requests
- Prominent "List an Item" button

### Listing Workflow (all steps required before publishing)
1. Title, description, category, condition, photos (min 3)
2. Proof of ownership upload (receipt / serial number / video)
3. Pricing (daily rate, weekly rate, min rental days)
4. Insurance amount (optional — merchant pays, sets amount)
5. Deposit amount (optional — renter pays, held in escrow)
6. Affiliate toggle: "Accept Affiliates" (Yes/No) + commission rate if Yes
7. KYC gate (if not yet verified, prompt to complete before publishing)

### Payments
- **PayFast** — integrated and live (onsite integration)
- Sandbox mode for testing, production keys via .env.local
- Escrow: hold deposit + rental fee until return confirmed
- See docs/INTEGRATIONS.md for full PayFast setup

### Affiliate System (Two types — both live at launch)
**1. Ambassador Program (external)**
- Link/button in My Profile submenu → redirects to **Warp** affiliate platform
- Warp handles tracking, commissions, payouts for platform-wide ambassadors

**2. Merchant Affiliate Program (internal)**
- Merchants toggle "Accept Affiliates" on any listing
- Merchant sets commission rate (e.g., 10%)
- Affiliates browse affiliate-enabled listings and earn commission on referrals
- Merchant dashboard shows affiliate names who referred rentals (name only)
- Commission auto-calculated per completed booking

### Chat
- Built-in filtered chat between renters and merchants
- Auto-blocks phone numbers, email addresses, and payment requests
- Accessible from main navigation

### Design
- **Airbnb-clean, minimal, modern**
- Dark mode toggle (top right of navbar)
- Mobile-first, fully responsive
- High-quality imagery, smooth transitions
- All monetary values in **ZAR (R)**

### Navigation (Top Menu — Website)
```
[Unity Logo]   Home   Browse   Chat       [Dark Mode Toggle]   [Login / Avatar]
                                          My Profile ▾
                                            ├── My Listings
                                            ├── Bookings
                                            └── Affiliate Program ↗ (Warp link)
```

Mobile: Home, Browse, Chat, Profile as bottom nav icons.

### Geography
- Launch: South Africa only
- Country selector in UI (SA pre-selected)
- Database and routing designed to add new countries without rewrites
- Listings filtered by user's selected country

---

## Tech Stack Summary

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (TypeScript, App Router, src/ directory) |
| Styling | Tailwind CSS + shadcn/ui |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| Storage | Supabase Storage |
| Realtime | Supabase Realtime (chat) |
| Payments | PayFast (onsite integration) |
| KYC | Sumsub |
| Hosting | Vercel |
| Affiliate | Warp (external link) |
| Dark mode | next-themes |

---

## Folder Structure (src/)

```
src/
├── app/
│   ├── (marketing)/        # Public pages (homepage, listings, how-it-works)
│   ├── (auth)/             # /login, /register, /verify, /onboarding
│   ├── (dashboard)/        # Protected: /dashboard/renter, /dashboard/merchant
│   └── api/                # API routes
├── components/
│   ├── ui/                 # shadcn base components
│   ├── listings/           # ListingCard, ListingGrid, SearchBar
│   ├── checkout/           # BookingFlow, DepositSummary
│   ├── dashboard/          # Dashboard-specific components
│   └── shared/             # Navbar, Footer, modals
├── lib/
│   ├── supabase/           # client.ts (browser), server.ts (RSC), middleware.ts
│   ├── payfast/            # Payment helpers
│   └── utils/              # General utilities
├── hooks/                  # Custom React hooks
└── types/                  # TypeScript types (index.ts)
```

---

## Ground Rules

- Mobile-first — SA is a mobile-first market
- Image compression + lazy loading on all media
- All API keys in `.env.local` — never hardcode
- POPIA compliance on all data collection
- Write clean code — small team, lean startup
- When scope is unclear — refer to `docs/FEATURES.md`
- When page layout is unclear — refer to `docs/PAGES.md`
- When user flow is unclear — refer to `docs/USERS.md`
- Next.js 15: cookies(), params, searchParams are all async — await them

---

## Build Order

**Phase 1:** Structure, auth, homepage, dashboards, dark mode ← current
**Phase 2:** Renter browse + checkout flow
**Phase 3:** Merchant listing workflow + booking management
**Phase 4:** KYC gate, chat, dispute system
**Phase 5:** Affiliates, reviews, polish, deploy
