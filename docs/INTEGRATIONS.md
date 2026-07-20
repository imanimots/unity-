# Unity — Third-Party Integrations

## Payments

### PayFast (Primary — Confirmed)
- **Purpose:** Card payments, Instant EFT, deposit collection
- **Docs:** https://developers.payfast.co.za
- **SA pricing:** 2% + R2 per transaction
- **Integration type:** Onsite (embedded checkout, no redirect)
- **Test sandbox:** https://sandbox.payfast.co.za
- **Keys:**
  - `NEXT_PUBLIC_PAYFAST_MERCHANT_ID`
  - `PAYFAST_MERCHANT_KEY`
  - `PAYFAST_PASSPHRASE`
- **Onsite engine (production):** `https://www.payfast.co.za/onsite/engine.js`
- **Onsite engine (sandbox):** `https://sandbox.payfast.co.za/onsite/engine.js`

**Onsite integration flow:**
```javascript
// 1. Generate payment identifier on server (POST to PayFast)
// 2. Return UUID to client
// 3. Trigger payment:
window.payfast_do_onsite_payment({ uuid: paymentIdentifier }, (result) => {
  if (result === true) {
    // Payment successful — update booking status in Supabase
  }
});
```

### Escrow Logic (Built In-Platform)
- PayFast does not natively support escrow
- Implement via booking status logic: funds conceptually held until merchant confirms return
- Store `payfast_payment_id` on booking record
- Merchant payout triggered only when `booking.status = 'returned'` and no dispute
- Dispute → `booking.status = 'disputed'` → admin reviews → manual payout resolution

---

## KYC / Identity Verification

### Sumsub (Primary)
- **Purpose:** ID upload, proof of residence, liveness check, AML/PEP screening
- **Docs:** https://docs.sumsub.com
- **Flow:** User submits → Sumsub auto-reviews → webhook fires result → update `kyc_status` in DB
- **Keys:** `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`
- **Webhook:** Listen for `applicantReviewed` event
- **When triggered:** Required before first booking (renter) or first listing (merchant)
- **At signup:** Optional — show "Skip for now" button, gate later

---

## Affiliate Programs

### Warp (Ambassador Program — External)
- **Purpose:** Platform-level ambassador affiliate program (influencers promoting Unity)
- **Integration:** External link only — no API integration needed
- **Where it appears:** My Profile → Affiliate Program (link redirects to Warp)
- **Key:** `NEXT_PUBLIC_WARP_AFFILIATE_URL` (your Warp program URL)
- **Note:** Warp handles all tracking, commissions, and payouts for ambassadors

### Merchant Affiliate Program (Internal — Built in Platform)
- **Purpose:** Individual merchants allow affiliates to refer renters to their specific listings
- **How it works:**
  1. Merchant enables "Accept Affiliates" toggle on listing
  2. Merchant sets commission rate (e.g., 10% of rental fee)
  3. Affiliate gets a referral link for that listing
  4. Affiliate refers renter → booking completed → commission recorded
- **Tracking:** `affiliate_referrals` table in Supabase
- **Visibility:** Merchant sees affiliate name only (no contact details, no commission breakdown shown to merchant)

---

## Logistics

### Bob Go (Primary)
- **Purpose:** Courier booking, label generation, real-time tracking
- **Docs:** https://my.bobgo.co.za
- **Keys:** `BOBGO_API_KEY`

### Pargo (Fallback / Click & Collect)
- **Purpose:** Parcel drop-off/pickup points across SA
- **Keys:** `PARGO_API_KEY`

---

## Notifications

### Twilio (SMS)
- **Purpose:** OTP verification, return reminders, urgent alerts
- **Keys:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

### OneSignal (Push Notifications)
- **Purpose:** In-app push notifications (booking updates, price drops, reminders)
- **Free tier:** 10,000 subscribers
- **Keys:** `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`

---

## Analytics

### Google Analytics 4
- **Keys:** `NEXT_PUBLIC_GA4_MEASUREMENT_ID`

### Meta Pixel
- **Keys:** `NEXT_PUBLIC_META_PIXEL_ID`

### Hotjar
- **Keys:** `NEXT_PUBLIC_HOTJAR_ID`

---

## Database & Backend

### Supabase
- **Purpose:** PostgreSQL database, auth, file storage, realtime chat
- **Keys:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`

---

## Environment Variables (.env.local)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# PayFast
NEXT_PUBLIC_PAYFAST_MERCHANT_ID=
PAYFAST_MERCHANT_KEY=
PAYFAST_PASSPHRASE=

# KYC
SUMSUB_APP_TOKEN=
SUMSUB_SECRET_KEY=

# Affiliate
NEXT_PUBLIC_WARP_AFFILIATE_URL=

# Logistics
BOBGO_API_KEY=
PARGO_API_KEY=

# Notifications
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
ONESIGNAL_APP_ID=
ONESIGNAL_REST_API_KEY=

# Analytics
NEXT_PUBLIC_GA4_MEASUREMENT_ID=
NEXT_PUBLIC_META_PIXEL_ID=
NEXT_PUBLIC_HOTJAR_ID=

# App Config
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_DEFAULT_COUNTRY=ZA
NEXT_PUBLIC_DEFAULT_CURRENCY=ZAR
```
