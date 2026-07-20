# Unity — Platform Features

## MVP Scope (Launch)
Focus on these features first. Everything marked [POST-MVP] comes later.

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
- [ ] POPIA consent for data sharing (credit building opt-in)
- [ ] Onboarding quiz (3 questions): most-rented category, preferred rental length, credit-building opt-in

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
  - Credit score required: Yes/No + threshold
- [ ] Listing verification (auto + manual for high-value items)
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
- [ ] Eligibility check (Unity Score, credit score vs merchant requirements)
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
- [ ] Credit building progress [POST-MVP]
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

## POST-MVP Features

- Credit builder (bureau reporting)
- Rent-to-buy option
- Property rentals
- Zero-interest loans
- Unity as insurance provider
- Raffles / giveaways
- Buy & sell marketplace
