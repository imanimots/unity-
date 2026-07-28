# Unity — Architecture & Tech Stack

> **MVP scope note:** Unity's MVP covers peer-to-peer rentals, buying & selling,
> and affiliate marketing only. Loans, credit building, credit scoring, credit
> bureau reporting, and NCR registration are explicitly out of scope and must
> not be built or planned for. Risk assessment is handled by the Risk Engine
> (`RISK_ENGINE.md`), not a credit score.

## Recommended Stack

### Frontend
- **Framework:** Next.js 14+ (App Router)
- **Styling:** Tailwind CSS
- **UI Components:** shadcn/ui
- **State Management:** Zustand (lightweight, startup-friendly)
- **Forms:** React Hook Form + Zod validation

### Backend
- **Database & Auth:** Supabase (PostgreSQL, Row Level Security, Auth)
- **File Storage:** Supabase Storage (photos, videos, documents)
- **API:** Next.js API Routes + Supabase Edge Functions

### Key Integrations
See `INTEGRATIONS.md` for full details.
- **Payments:** PayFast (primary)
- **KYC:** Sumsub
- **Logistics:** Bob Go (primary) / Pargo (fallback)
- **Notifications:** OneSignal (push) + Twilio (SMS)
- **Analytics:** Google Analytics 4 + Meta Pixel + Hotjar

### Hosting
- **Platform:** Vercel (seamless Next.js deployment)
- **Region:** Primary — closest to South Africa (consider AWS Cape Town for Supabase)

---

## Folder Structure

```
unity/
├── CLAUDE.md                  # Claude Code master instructions
├── docs/                      # All project documentation
│   ├── BRAND.md
│   ├── ARCHITECTURE.md
│   ├── FEATURES.md
│   ├── INTEGRATIONS.md
│   ├── PAGES.md
│   └── USERS.md
└── src/
    ├── app/                   # Next.js App Router
    │   ├── (marketing)/       # Public-facing pages
    │   │   ├── page.tsx       # Homepage
    │   │   ├── how-it-works/
    │   │   ├── listings/
    │   │   └── item/[id]/
    │   ├── (auth)/            # Auth pages
    │   │   ├── login/
    │   │   ├── register/
    │   │   └── verify/
    │   ├── (dashboard)/       # Protected pages
    │   │   ├── renter/        # Renter dashboard
    │   │   └── merchant/      # Merchant dashboard
    │   └── api/               # API routes
    ├── components/
    │   ├── ui/                # shadcn base components
    │   ├── listings/          # Listing cards, grids, search
    │   ├── checkout/          # Booking flow, deposit summary
    │   ├── dashboard/         # Dashboard-specific components
    │   └── shared/            # Navbar, footer, modals
    ├── lib/
    │   ├── supabase/          # Supabase client + helpers
    │   ├── payfast/           # Payment helpers
    │   └── utils/             # General utilities
    ├── hooks/                 # Custom React hooks
    └── types/                 # TypeScript types
```

---

## Database Schema (Core Tables)

### profiles (extends auth.users)
- id, full_name, display_name, phone, avatar_url
- role: 'renter' | 'merchant' | 'both' | 'admin'
- kyc_status: 'none' | 'pending' | 'approved' | 'rejected'
- unity_score (float, 0–5, default 5.0)
- country_id (references countries, default 'ZA')
- created_at

### listings
- id, merchant_id (→ profiles)
- title, description, category, condition
- listing_type: 'rental' | 'sale'
- daily_rate, weekly_rate (rental only) / sale_price, quantity_available (sale only)
- deposit_required (bool), deposit_amount
- min_rental_days
- shipping_payer: 'renter' | 'merchant' | 'split' | 'negotiate'
- min_unity_score
- risk_tier: 'low' | 'medium' | 'high' — assigned automatically by the Risk Engine, not user-settable. See `RISK_ENGINE.md`.
- accepts_affiliates (bool), affiliate_commission_rate
- status: 'draft' | 'active' | 'paused' | 'rented'
- ownership_verified (bool)
- created_at

### orders (one-time purchases — parallel to `bookings`)
- id, listing_id (→ listings), buyer_id (→ profiles), seller_id (→ profiles)
- quantity, unit_price, shipping_fee, total_amount
- status: 'pending' | 'paid' | 'shipped' | 'delivered' | 'disputed' | 'cancelled'
- payfast_payment_id
- affiliate_id, affiliate_commission_amount
- created_at

See `BUYING_SELLING.md` for the full design and rationale.

### bookings
- id, listing_id (→ listings), renter_id (→ profiles), merchant_id (→ profiles)
- start_date, end_date, total_days
- rental_fee, deposit_amount, shipping_fee, total_amount
- status: 'pending' | 'approved' | 'active' | 'returned' | 'disputed' | 'cancelled'
- pre_rental_media_url, post_rental_media_url
- payfast_payment_id
- affiliate_id, affiliate_commission_amount
- created_at

### reviews
- id, booking_id, reviewer_id, reviewee_id
- rating (1–5), comment
- created_at

### disputes
- id, booking_id, raised_by
- reason, evidence_urls (text[])
- status: 'open' | 'resolved' | 'escalated'
- resolution_notes

### messages
- id, booking_id, sender_id
- content, is_filtered, filter_reason
- created_at

### affiliate_referrals
- id, affiliate_id, referred_user_id, listing_id, booking_id
- commission_amount
- status: 'pending' | 'paid' | 'cancelled'
- created_at

---

## Security Requirements
- HTTPS enforced (SSL)
- All API routes protected with Supabase RLS
- Environment variables for all secrets (.env.local, never committed)
- Cookie consent banner (POPIA/GDPR)
- Data encrypted at rest and in transit
- MFA available for merchant accounts
