# Unity — Platform Features

## MVP Scope (Launch)
Focus on these features first. Everything marked [POST-MVP] comes later.

The MVP covers **peer-to-peer rentals, buying & selling, and affiliate
marketing only.** Loans, credit building, credit scoring, credit bureau
reporting, and NCR registration workflows must not be built or planned for.
Risk is assessed automatically by the Risk Engine (`RISK_ENGINE.md`), not a
credit score — see that doc for the LOW/MEDIUM/HIGH rules. Buying & selling
architecture is documented in `BUYING_SELLING.md`.

---

## 1. Authentication & Onboarding

### All Users
- [ ] Email + password registration
- [ ] Phone number verification (OTP via Twilio)
- [ ] Role selection: Renter / Merchant / Both
- [ ] KYC verification flow (Sumsub):
  - Government-issued ID upload
  - Proof of residence
  - Liveness check / biometrics
  - AML/PEP screening
- [ ] Accept Terms & Conditions + Privacy Policy
- [ ] POPIA consent for data sharing
- [ ] Onboarding quiz (2 questions): most-rented category, preferred rental length

---

## 2. Listings

### Create a Listing (Merchant)
- [ ] Category selection (see categories below)
- [ ] Title, description, condition
- [ ] Photo/video upload (timestamped, min 3 photos)
- [ ] Proof of ownership upload (receipt, serial number, warranty)
- [ ] Pricing: daily rate, weekly rate
- [ ] Availability calendar
- [ ] Per-listing custom settings:
  - Deposit: Yes/No + amount
  - Minimum rental days (e.g., 1–30)
  - Shipping payer: Renter / Merchant / Split / Negotiate
  - Minimum Unity Score required
  - Risk tier: assigned automatically by the Risk Engine (LOW/MEDIUM/HIGH) — not merchant-configurable, see `RISK_ENGINE.md`
- [ ] Listing verification (auto + manual review for HIGH risk tier)
- [ ] Optional: Pro photography add-on [POST-MVP]

### Browse & Search (Renter)
- [ ] Search bar with keyword + location
- [ ] Filters: category, price range, location, min rating, availability dates
- [ ] Sort: relevance, price low–high, newest, rating
- [ ] Item detail page: photos, description, merchant profile, reviews, availability
- [ ] "Similar items" section
- [ ] Save to wishlist

### Categories
- Tech & Electronics
- Outdoor & Camping Gear
- Tools & DIY Equipment
- Luxury Fashion & Accessories
- Event & Party Supplies
- Vehicles (Cars, Bikes, Scooters)
- Property [POST-MVP]
- Musical Instruments
- Sports & Fitness Equipment
- Baby & Kids

---

## 3. Booking Flow

- [ ] Date picker (respects min rental days + availability calendar)
- [ ] Eligibility check (Unity Score vs merchant requirements; risk tier requirements — deposit/insurance/manual review — enforced per `RISK_ENGINE.md`)
- [ ] Booking request sent to merchant
- [ ] Merchant approve/decline (with optional filtered chat for clarification)
- [ ] On approval: payment checkout
  - Rental fee
  - Deposit (if required, held in escrow)
  - Shipping fee (based on merchant setting)
- [ ] Payment via PayFast (card, Instant EFT — onsite integration)
- [ ] Funds held in escrow until return confirmed
- [ ] Booking confirmation + logistics coordination

---

## 4. During Rental

- [ ] Pre-rental: merchant uploads timestamped condition video/photos
- [ ] Renter confirms item received + uploads own timestamped photos
- [ ] In-app filtered chat (phone numbers, emails auto-blocked)
- [ ] Return date reminders (push + SMS)
- [ ] Option to extend rental (merchant approval required)

---

## 5. Return & Payout

- [ ] Renter returns item (logistics or drop-off)
- [ ] Merchant uploads post-rental timestamped photos/video
- [ ] Merchant confirms: Good / Damaged / Missing
- [ ] Good → auto-release escrow: deposit to renter, payout to merchant (minus Unity commission)
- [ ] Issue → dispute raised, funds held pending resolution
- [ ] Both parties leave reviews/ratings
- [ ] Unity Score updated for both

---

## 6. Dashboards

### Renter Dashboard
- [ ] Active bookings + status tracker
- [ ] Booking history
- [ ] Wishlist
- [ ] Unity Score display + breakdown
- [ ] Notifications centre

### Merchant Dashboard
- [ ] Active listings + quick edit
- [ ] Incoming booking requests (approve/decline)
- [ ] Earnings overview (this week, this month, all time)
- [ ] Payout history
- [ ] Dispute management
- [ ] Unity Score + performance metrics
- [ ] Subscription tier display (Free / Pro / Elite)
- [ ] Listing spotlight / ad purchase

---

## 7. Trust & Safety

- [ ] Unity Score (0–5 rating based on rental history, disputes, reviews)
- [ ] KYC badge on all verified profiles
- [ ] Item verification badge on validated listings
- [ ] Dispute resolution system (evidence upload, admin review)
- [ ] Electronic rental contract (auto-generated per booking)
- [ ] Report user / listing functionality
- [ ] Strike system: suspension → penalty → ban (public record)

---

## 8. Merchant Subscription Tiers

| Tier | Price | Key Features |
|---|---|---|
| Free (Starter) | R0/mo | Up to 5 listings, basic dashboard |
| Pro Merchant | R199/mo | Unlimited listings, Pro badge, weekly spotlight, priority support, CSV tools |
| Elite Merchant | R499/mo | API access, dynamic pricing AI, Elite badge + top search placement, homepage feature slot |

---

## 9. Advertising (On-Platform)

| Package | Placement | Price |
|---|---|---|
| Search Boost | Top 10 results | R50 / 7 days |
| Category Spotlight | Category banner | R99 / 7 days |
| Homepage Feature | Homepage carousel | R199 / 7 days |
| Urgency Badge | "HOT DEAL" badge | R25 / 7 days |

---

## 10. Affiliate System

### Ambassador Program (External — via Warp)
- [ ] Link in My Profile → Affiliate Program → redirects to Warp
- [ ] Warp handles tracking, commissions, payouts
- [ ] Commission structure: 7.5% first rental, 1–2% LTV for 12 months, R50/new merchant listing

### Merchant Affiliate Program (Internal — built in platform)
- [ ] Merchant toggles "Accept Affiliates" on listing + sets commission rate
- [ ] Affiliates earn commission on completed bookings they referred
- [ ] Merchant sees affiliate name only (no contact details, no commission breakdown)
- [ ] Tracked via `affiliate_referrals` table

---

## 11. Notifications

- [ ] Email: booking confirmations, approvals, reminders, disputes
- [ ] SMS: OTP, return reminders, urgent alerts (via Twilio)
- [ ] Push: real-time booking updates, price drops on wishlisted items (via OneSignal)

---

## 12. Buying & Selling (MVP)

Core MVP scope alongside rentals. Full schema design in `BUYING_SELLING.md`.

- [ ] Merchant creates a sale listing (same wizard as rentals, `listing_type: 'sale'`): title, description, category, condition, photos, proof of ownership, sale price, quantity
- [ ] Risk tier assigned automatically (see `RISK_ENGINE.md`) using sale price instead of daily rate
- [ ] Renter/buyer purchases via checkout: item price + shipping fee, payment via PayFast
- [ ] Funds held in escrow until delivery is confirmed by the buyer
- [ ] Reviews, disputes, and filtered chat work the same way as rentals (shared infrastructure, see `orders` table)
- [ ] Affiliate promotion works on sale listings the same way as rental listings

---

## POST-MVP Features

- Rent-to-buy option
- Property rentals
- Zero-interest loans
- Unity as insurance provider
- Raffles / giveaways
- Credit building / credit scoring / credit bureau reporting / NCR registration — explicitly excluded, not just deferred; see MVP scope note at top of this file
