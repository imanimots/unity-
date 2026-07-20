# Unity — Quick Setup Guide

Follow these steps in order. This gets your project running locally and ready for Claude Code to build.

---

## Step 1: Set Up Your Project Folder

Create a folder on your machine and copy in the docs:

```
unity/
├── CLAUDE.md
├── QUICK_SETUP.md (this file)
└── docs/
    ├── ARCHITECTURE.md
    ├── BRAND.md
    ├── FEATURES.md
    ├── INTEGRATIONS.md
    ├── PAGES.md
    └── USERS.md
```

---

## Step 2: Create the Next.js App

Open terminal in your `unity/` folder and run:

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --src-dir --app --import-alias "@/*"
```

When prompted:
- Would you like to use TypeScript? → **Yes**
- Would you like to use ESLint? → **Yes**
- Would you like to use Tailwind CSS? → **Yes**
- Would you like to use `src/` directory? → **Yes**
- Would you like to use App Router? → **Yes**
- Would you like to customize the import alias? → **Yes** (keep `@/*`)

---

## Step 3: Install Core Dependencies

```bash
# Supabase
npm install @supabase/supabase-js @supabase/ssr

# shadcn/ui (follow prompts)
npx shadcn@latest init

# Forms & validation
npm install react-hook-form zod @hookform/resolvers

# State management
npm install zustand

# Date picker (for rental calendar)
npm install react-day-picker date-fns

# Image handling
npm install react-dropzone

# Toast notifications
npm install sonner

# Icons
npm install lucide-react
```

---

## Step 4: Set Up Supabase

1. Go to **https://supabase.com** and create a free account
2. Click **"New Project"**
3. Name it `unity`
4. Choose region: **South Africa (or closest available)**
5. Set a strong database password — **save this somewhere**
6. Wait for project to spin up (~2 minutes)
7. Go to **Settings → API**
8. Copy your:
   - `Project URL`
   - `anon public` key
   - `service_role` key (keep this secret)

---

## Step 5: Create Your .env.local File

Create a file called `.env.local` in your project root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_project_url_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# PayFast (get from payfast.io → account → integration)
NEXT_PUBLIC_PAYFAST_MERCHANT_ID=your_merchant_id
PAYFAST_MERCHANT_KEY=your_merchant_key
PAYFAST_PASSPHRASE=your_passphrase

# Sumsub KYC (get from sumsub.com → developers)
SUMSUB_APP_TOKEN=your_app_token
SUMSUB_SECRET_KEY=your_secret_key

# Warp Affiliate Link (your public Warp affiliate URL)
NEXT_PUBLIC_WARP_AFFILIATE_URL=your_warp_link_here

# App Config
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_DEFAULT_COUNTRY=ZA
NEXT_PUBLIC_DEFAULT_CURRENCY=ZAR
```

> ⚠️ Never commit .env.local to Git. Make sure `.env.local` is in your `.gitignore`

---

## Step 6: Set Up the Database (Supabase SQL Editor)

Go to your Supabase project → **SQL Editor** → run this:

```sql
-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Countries (for international scaling)
create table countries (
  id text primary key, -- e.g. 'ZA', 'US', 'UK'
  name text not null,
  currency text not null,
  active boolean default false
);
insert into countries (id, name, currency, active) values ('ZA', 'South Africa', 'ZAR', true);

-- Users (extends Supabase auth.users)
create table profiles (
  id uuid references auth.users(id) primary key,
  full_name text,
  display_name text,
  phone text,
  role text check (role in ('renter', 'merchant', 'both')) default 'renter',
  kyc_status text check (kyc_status in ('none', 'pending', 'approved', 'rejected')) default 'none',
  unity_score numeric(3,2) default 5.0,
  country_id text references countries(id) default 'ZA',
  avatar_url text,
  created_at timestamptz default now()
);

-- Listings
create table listings (
  id uuid default uuid_generate_v4() primary key,
  merchant_id uuid references profiles(id) not null,
  country_id text references countries(id) default 'ZA',
  title text not null,
  description text,
  category text not null,
  condition text check (condition in ('new', 'like_new', 'good', 'fair')),
  daily_rate numeric(10,2) not null,
  weekly_rate numeric(10,2),
  min_rental_days int default 1,
  deposit_required boolean default false,
  deposit_amount numeric(10,2),
  insurance_amount numeric(10,2),
  shipping_payer text check (shipping_payer in ('renter', 'merchant', 'split', 'negotiate')) default 'renter',
  min_unity_score numeric(3,2) default 0,
  requires_credit_score boolean default false,
  min_credit_score int,
  accepts_affiliates boolean default false,
  affiliate_commission_rate numeric(5,2) default 0,
  status text check (status in ('draft', 'pending', 'active', 'paused', 'rented')) default 'draft',
  ownership_verified boolean default false,
  created_at timestamptz default now()
);

-- Listing media (photos/videos)
create table listing_media (
  id uuid default uuid_generate_v4() primary key,
  listing_id uuid references listings(id) on delete cascade,
  url text not null,
  type text check (type in ('photo', 'video', 'ownership_proof')),
  display_order int default 0,
  created_at timestamptz default now()
);

-- Bookings
create table bookings (
  id uuid default uuid_generate_v4() primary key,
  listing_id uuid references listings(id),
  renter_id uuid references profiles(id),
  merchant_id uuid references profiles(id),
  start_date date not null,
  end_date date not null,
  total_days int not null,
  rental_fee numeric(10,2) not null,
  deposit_amount numeric(10,2) default 0,
  shipping_fee numeric(10,2) default 0,
  total_amount numeric(10,2) not null,
  status text check (status in ('pending', 'approved', 'active', 'returned', 'disputed', 'cancelled')) default 'pending',
  pre_rental_media_url text,
  post_rental_media_url text,
  payfast_payment_id text,
  affiliate_id uuid references profiles(id),
  affiliate_commission_amount numeric(10,2),
  created_at timestamptz default now()
);

-- Reviews
create table reviews (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references bookings(id),
  reviewer_id uuid references profiles(id),
  reviewee_id uuid references profiles(id),
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now()
);

-- Disputes
create table disputes (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references bookings(id),
  raised_by uuid references profiles(id),
  reason text,
  evidence_urls text[],
  status text check (status in ('open', 'resolved', 'escalated')) default 'open',
  resolution_notes text,
  created_at timestamptz default now()
);

-- Messages (filtered chat)
create table messages (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references bookings(id),
  sender_id uuid references profiles(id),
  content text not null,
  is_filtered boolean default false,
  filter_reason text,
  created_at timestamptz default now()
);

-- Affiliate referrals
create table affiliate_referrals (
  id uuid default uuid_generate_v4() primary key,
  affiliate_id uuid references profiles(id),
  referred_user_id uuid references profiles(id),
  listing_id uuid references listings(id),
  booking_id uuid references bookings(id),
  commission_amount numeric(10,2),
  status text check (status in ('pending', 'paid', 'cancelled')) default 'pending',
  created_at timestamptz default now()
);

-- Enable Row Level Security
alter table profiles enable row level security;
alter table listings enable row level security;
alter table listing_media enable row level security;
alter table bookings enable row level security;
alter table reviews enable row level security;
alter table disputes enable row level security;
alter table messages enable row level security;
alter table affiliate_referrals enable row level security;

-- Basic RLS policies (Claude Code will expand these)
create policy "Public profiles are viewable by everyone" on profiles for select using (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Active listings are viewable by everyone" on listings for select using (status = 'active');
create policy "Merchants can manage own listings" on listings for all using (auth.uid() = merchant_id);
```

---

## Step 7: Open in VS Code + Claude Code

1. Open VS Code in your project folder:
```bash
code .
```

2. Install the **Claude Code extension** from the VS Code marketplace (if not already installed)

3. Open Claude Code and paste this **first prompt:**

```
Read CLAUDE.md completely, then read all files in the docs/ folder in this order:
ARCHITECTURE.md, BRAND.md, FEATURES.md, PAGES.md, USERS.md, INTEGRATIONS.md.

Confirm you have read them all, then:
1. Set up the Supabase client in lib/supabase/
2. Set up the folder structure exactly as described in ARCHITECTURE.md
3. Build the homepage (/) with a recommended items feed, search bar, category grid, and navigation
4. Build the auth pages: /signup (with renter/merchant choice), /login
5. Build the renter dashboard and merchant dashboard landing pages
6. Add a dark mode toggle to the navbar

Use Tailwind CSS and shadcn/ui components. Airbnb-clean aesthetic. Mobile-first.
Do not build checkout or KYC flows yet — just the core pages and navigation.
```

---

## Step 8: Accounts to Set Up (Do This in Parallel)

While Claude Code builds, set up your third-party accounts:

| Service | URL | What to Get |
|---|---|---|
| **Supabase** | supabase.com | Already done in Step 4 |
| **PayFast** | payfast.io | Merchant ID, Key, Passphrase |
| **Sumsub** | sumsub.com | App Token, Secret Key |
| **Warp** | warp.dev | Your affiliate program URL |
| **Vercel** | vercel.com | Connect GitHub repo for deploys |

---

## Step 9: Git Setup

```bash
git init
git add .
git commit -m "Initial Unity project setup"
```

Create a repo on GitHub, then:
```bash
git remote add origin https://github.com/yourusername/unity.git
git push -u origin main
```

Connect the repo to Vercel for automatic deploys on every push.

---

## Step 10: Running Locally

```bash
npm run dev
```

Open **http://localhost:3000** — your Unity platform is running.

---

## Build Order (Recommended for Claude Code)

Follow this sequence. Complete each phase before starting the next.

### Phase 1 — Foundation
- [ ] Project structure + Supabase client setup
- [ ] Navbar (Home, Browse, Chat, My Profile dropdown)
- [ ] Dark mode toggle
- [ ] Homepage (renter feed)
- [ ] Auth: Signup (renter/merchant choice), Login
- [ ] Country selector (SA default)

### Phase 2 — Core Renter Flow
- [ ] Browse page (listings grid + filters)
- [ ] Item detail page
- [ ] Booking flow + PayFast checkout
- [ ] Renter dashboard

### Phase 3 — Core Merchant Flow
- [ ] Merchant dashboard
- [ ] Create listing workflow (with item validation + affiliate toggle)
- [ ] Booking management
- [ ] Payout tracking

### Phase 4 — Trust & Safety
- [ ] KYC gate (required before booking/listing)
- [ ] Filtered chat
- [ ] Pre/post rental media uploads
- [ ] Dispute system

### Phase 5 — Affiliate & Polish
- [ ] Ambassador link to Warp
- [ ] Merchant affiliate tracking
- [ ] Reviews & Unity Score
- [ ] Performance optimisation
- [ ] Deploy to Vercel

---

## Useful Commands

```bash
npm run dev          # Start local dev server
npm run build        # Build for production
npm run lint         # Check for errors
npx supabase login   # Log in to Supabase CLI (optional)
```

---

**You're ready. Open Claude Code and start with Phase 1.**
