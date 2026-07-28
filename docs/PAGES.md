# Unity — Pages & Components

## Public Pages (No Login Required)

### `/` — Homepage
**Goal:** Convert visitors into signups. Communicate value instantly.
**Sections:**
1. **Hero** — Bold headline, subheadline, CTA buttons (Start Renting / List Your Item)
   - Headline examples: "Rent what you need. Earn from what you have."
2. **How It Works** — 3-step visual flow (Browse → Book → Receive)
3. **Category Grid** — Icon-based grid of rental categories
4. **Featured Listings** — Carousel of active, verified listings
5. **Trust Section** — KYC verified, Escrow protected, Reviewed community
6. **Story/Campaign** — Emotional video or image campaign (The Boots, The Hustler etc.)
7. **Ambassador CTA** — "Are you a creator? Partner with Unity."
8. **Waitlist / Download CTA** — Email capture or app download (if app is live)
9. **Footer** — Links, social media, legal

---

### `/listings` — Browse All Listings
**Sections:**
1. Search bar (prominent, with location input)
2. Filter sidebar / drawer (mobile): category, price, location, rating, availability
3. Sort controls
4. Listings grid (card per item: photo, title, price/day, location, rating, merchant badge)
5. Pagination or infinite scroll
6. Empty state (no results)

---

### `/listings/[id]` — Item Detail Page
**Sections:**
1. Photo gallery (full-width, swipeable on mobile)
2. Title, category, condition badge
3. Price (daily/weekly), minimum rental days
4. Availability calendar
5. Merchant profile card (name, Unity Score, KYC badge, reviews)
6. Description
7. Deposit & insurance info
8. Shipping options
9. Eligibility notice (if user doesn't meet merchant requirements)
10. "Book Now" sticky CTA (mobile)
11. Similar listings
12. Reviews section

---

### `/how-it-works` — How Unity Works
**Sections:**
1. For Renters — step-by-step visual journey
2. For Merchants — step-by-step visual journey
3. Trust & Safety overview
4. FAQ accordion
5. CTA

---

### `/trust-and-safety` — Trust Page
- KYC process explained
- Escrow system explained
- Dispute resolution process
- Item verification explained
- Unity Score explained

---

### `/pricing` — Merchant Subscription Tiers
- Free / Pro (R199/mo) / Elite (R499/mo) comparison table
- On-platform advertising packages
- FAQ

---

### `/ambassadors` — Ambassador Program
- Program overview
- Eligibility requirements
- Commission structure (LTV model)
- Application form
- FAQ

---

## Auth Pages

### `/register` — Sign Up
- Role selection: Renter / Merchant / Both
- Email + password
- Phone number + OTP verification
- T&Cs + Privacy Policy consent
- POPIA data consent
- KYC prompt with "Skip for now" option

### `/login` — Log In
- Email + password
- "Forgot password" link

### `/verify` — KYC Verification Flow
- Step 1: ID upload
- Step 2: Proof of residence
- Step 3: Liveness check (Sumsub widget)
- Step 4: Confirmation pending screen

### `/onboarding` — Post-KYC Onboarding Quiz
- Q1: What do you rent most? (sets recommendation engine)
- Q2: Preferred rental length? (pre-fills filters)

---

## Renter Dashboard `/dashboard/renter`

### `/dashboard/renter` — Overview
- Active bookings summary
- Unity Score widget
- Recent activity feed
- Quick actions: Browse, Wishlist, Messages

### `/dashboard/renter/bookings` — My Bookings
- Active / Pending / Past tabs
- Each booking: item photo, dates, status badge, action buttons
- Dispute button (if within window)

### `/dashboard/renter/wishlist` — Wishlist
- Saved listings grid

### `/dashboard/renter/profile` — My Profile
- Edit personal info
- KYC status
- Unity Score breakdown
- Bank details (for deposit refunds)
- Notification preferences

---

## Merchant Dashboard `/dashboard/merchant`

### `/dashboard/merchant` — Overview
- Earnings summary (week / month / all time)
- Active listings count
- Pending booking requests (with approve/decline)
- Unity Score
- Subscription tier badge

### `/dashboard/merchant/listings` — My Listings
- Active / Paused / Draft tabs
- Create new listing button
- Per listing: edit, pause, promote, view stats

### `/dashboard/merchant/listings/new` — Create Listing
- Multi-step form (see FEATURES.md)
- Media upload (photos/video)
- Proof of ownership upload
- Custom settings (deposit, min days, shipping, eligibility)

### `/dashboard/merchant/bookings` — Booking Requests
- Incoming requests with renter profile preview
- Approve / Decline / Chat
- Active rentals tracker

### `/dashboard/merchant/earnings` — Earnings
- Payout history table
- Upcoming payouts
- Commission breakdown
- Download CSV

### `/dashboard/merchant/promote` — Promote Listings
- On-platform ad packages
- Subscription upgrade CTA

### `/dashboard/merchant/profile` — Merchant Profile
- Public profile preview
- Edit bio, display name, photo
- Bank account for payouts
- Subscription management

---

## Shared Components

### Navbar
- Logo (left)
- Nav links: Home, Browse, How It Works (desktop)
- Dark mode toggle (top right)
- Auth: Login / Sign Up buttons OR Avatar dropdown when logged in
  - Avatar dropdown: My Listings, Bookings, Affiliate Program (Warp link), Logout
- Mobile: bottom nav with Home, Browse, Chat, Profile icons

### Footer
- Links: About, How It Works, Trust & Safety, Pricing, Ambassadors
- Social: Instagram, TikTok, YouTube, Facebook
- Legal: Terms & Conditions, Privacy Policy, POPIA Policy
- Copyright © Unity

### Item Card
- Thumbnail photo
- Title (truncated)
- Price per day (ZAR)
- Location (city)
- Rating + review count
- KYC/Verified badge
- Wishlist heart icon

### Booking Status Badge
- Pending (yellow)
- Approved (blue)
- Active (green)
- Returned (grey)
- Disputed (red)
- Cancelled (grey)
