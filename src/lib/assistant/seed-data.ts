export const KNOWLEDGE_BASE_ENTRIES = [
  {
    title: 'What is Unity?',
    category: 'platform',
    content: `Unity is South Africa's peer-to-peer rental marketplace. It connects people who need items (renters) with people who own items and want to earn from them (merchants). You can rent cameras, drones, camping gear, power tools, audio equipment, bicycles, projectors, and much more. Unity operates in Johannesburg, Cape Town, and Durban, with expansion planned. Unity is currently in public test — see /terms and /payments-and-deposits for what that means.`,
  },
  {
    title: 'How to rent an item on Unity',
    category: 'faq',
    content: `To rent an item on Unity: 1) Browse listings at /listings and find what you need. 2) Click the listing to view details, pricing, and availability. 3) Select your rental start and end dates and send a booking request. 4) Once the merchant accepts, complete checkout before the payment deadline shown. 5) Review the price breakdown (daily rate × days + any deposit). You must have KYC verification completed before your first booking. Unity is currently in public test mode, so checkout uses simulated payments — no real money is charged.`,
  },
  {
    title: 'How to list an item as a merchant',
    category: 'platform',
    content: `To list an item on Unity: Go to your Merchant Dashboard and click "List an Item". You'll go through several steps: (1) Basics — title, description, category, condition; (2) Photos — minimum 3 photos required; (3) Ownership — upload proof of ownership (receipt, serial number, or video); (4) Pricing — set daily rate and minimum rental days; (5) Renter Requirements — optional minimum Unity Score and deposit, plus your listing's automatically assigned risk tier; (6) Affiliates — choose whether to accept affiliate referrals and set commission rate; (7) declarations and submit for review. A Unity administrator reviews and moderates every listing before it goes live.`,
  },
  {
    title: 'KYC verification process',
    category: 'policy',
    content: `KYC (Know Your Customer) is Unity's identity verification process. It asks for your legal name, date of birth, ID or passport number, nationality, residential address, an identity document, and proof of address. In the current public test environment, submitted documents are reviewed manually by a Unity administrator — this is not a third-party identity vendor, not a government database check, and not a bank check. KYC is optional at signup but becomes required before your first booking (renters) or before publishing your first listing (merchants). KYC status can be: not started, pending, under review, additional information required, approved, or rejected. "Approved" means the stated Unity review was completed based on the evidence submitted — it does not guarantee future conduct.`,
  },
  {
    title: 'Unity Score explained',
    category: 'platform',
    content: `Unity Score is a trust rating from 0 to 5 that reflects your reliability on the platform. It is calculated from: rental reviews received, on-time returns, completed bookings without disputes, and account age. New users start at 0. Merchants can set a minimum Unity Score requirement on their listings — for example, requiring a score of 3.5+ to book. The score is displayed on your profile and affects which premium listings you can access.`,
  },
  {
    title: 'Deposit policy',
    category: 'policy',
    content: `Deposits on Unity are optional — merchants choose whether to require one and set the amount in ZAR. When you check out a booking with a deposit, the deposit is authorized alongside the rental payment. After the rental ends and the merchant confirms the item was returned in good condition, the deposit is released back to the renter. If there is damage, the merchant can raise a dispute regarding the deposit. In the current public test environment, this entire flow is simulated — no real deposit is held, and see /payments-and-deposits and /disputes for the full policy.`,
  },
  {
    title: 'How payments currently work (test mode)',
    category: 'policy',
    content: `Unity is currently operating in public test mode. Payments at checkout are simulated by a test payment provider — no real money is charged, no real deposit is held, and no real merchant payout occurs. This lets renters and merchants exercise the full booking and checkout workflow safely. Once a live payment provider is enabled, real payment methods and provider-specific terms will apply — see /payments-and-deposits for the current, accurate description. Unity does not describe its payment handling as "escrow" unless that arrangement is confirmed with a regulated provider and approved by legal review.`,
  },
  {
    title: 'Return process',
    category: 'faq',
    content: `To complete a rental return: The renter returns the item to the agreed location on the last day of the rental period. The merchant inspects the item and confirms the return through their Merchant Dashboard. Once confirmed, the deposit (if any) is released back to the renter. It's recommended to take photos of the item at both pickup and return as evidence.`,
  },
  {
    title: 'Booking cancellation policy',
    category: 'policy',
    content: `A renter may cancel a requested booking at any time before the merchant responds, at no cost. After a merchant accepts, either party may still cancel, subject to any cancellation-notice window shown on the listing. If a renter doesn't complete payment before the deadline shown at checkout, the booking automatically expires and the dates become available again. Unity does not apply a fixed cancellation-fee percentage — see /cancellations for the current policy. In the current public test environment, no real payment is ever collected, so no refund is due on cancellation.`,
  },
  {
    title: 'Dispute resolution process',
    category: 'policy',
    content: `If there is a problem with a rental — damage, missing items, or non-return — either party can open a dispute from their bookings dashboard. To open a dispute: go to the booking, describe the issue, and upload evidence (photos or videos). Unity reviews the evidence submitted by both parties — see /disputes for the full process and possible outcomes. This is an internal platform review, not a legal or arbitral proceeding, and does not replace either party's statutory rights.`,
  },
  {
    title: 'Internal affiliate program',
    category: 'platform',
    content: `Unity's internal affiliate program lets any user earn commission by referring renters to specific listings. To become an affiliate: go to Dashboard > Affiliate Program. You receive a unique affiliate code. Share the affiliate link for any listing that has "Accept Affiliates" enabled. When someone books through your link, you earn a commission percentage set by the merchant.`,
  },
  {
    title: 'Ambassador program (external)',
    category: 'platform',
    content: `Unity's Ambassador Program is for platform-wide promotion. Ambassadors earn commission on any transaction they refer to Unity, not just specific listings. The Ambassador Program is managed externally through Warp. To join, visit the Ambassador Program page (link in your profile menu). Warp handles tracking and commissions. This is different from the internal affiliate program, which is for specific listing referrals.`,
  },
  {
    title: 'Merchant affiliate settings',
    category: 'listing',
    content: `Merchants can enable affiliate referrals on any listing during the listing creation wizard. Toggle "Accept Affiliates" to on, then set a commission rate. When an affiliate refers a booking to your listing, they earn that commission. You can see which affiliates have referred bookings in your Merchant Dashboard > Affiliates section.`,
  },
  {
    title: 'Listing requirements and quality',
    category: 'listing',
    content: `All Unity listings must include: a clear title and description, at least 3 high-quality photos, proof of ownership (receipt, serial number photo, or video), a daily rental rate in ZAR, and a minimum rental period. Optional: deposit requirement and renter score/KYC requirements. Every listing is reviewed by a Unity administrator before it goes live — see /verification-and-trust. Listings with complete information and good photos get significantly more bookings.`,
  },
  {
    title: 'Renter requirements on listings',
    category: 'listing',
    content: `Some listings have renter requirements: (1) Minimum Unity Score — e.g. "3.5+ required" means your Unity Score must be at least 3.5 to book. (2) Deposit — an amount authorized at checkout, not a booking gate by itself. Every listing is also assigned a risk tier (Low, Medium, or High) automatically by Unity's Risk Engine, based on the item's value and category — merchants cannot set or change this themselves. Higher tiers carry mandatory ownership verification, inspection video, deposit, and (for High Risk) manual review before the listing can go live. These requirements are shown in the "Renter Requirements" section on the listing page.`,
  },
  {
    title: 'Merchant payouts (test mode)',
    category: 'policy',
    content: `In the current public test environment, no real merchant payout occurs — Unity's payout workflow exists to be exercised for testing, but no real money is ever transferred to a merchant's bank account. Once live payments are enabled, payout timing and any platform fee will be confirmed and published in the Payment and Deposit Policy (/payments-and-deposits). Payout status, once real, can be tracked in Merchant Dashboard > Payouts.`,
  },
  {
    title: 'Chat and communication policy',
    category: 'policy',
    content: `Unity has a built-in chat system for renters and merchants to communicate about listings and bookings. Unity's chat automatically filters out phone numbers, email addresses, physical addresses, and payment requests. This is to protect both parties and keep transactions on-platform, where Unity's booking, checkout, and dispute protections apply. Attempting to arrange off-platform payments or exchanges violates Unity's terms and may result in account suspension.`,
  },
  {
    title: 'Unity platform fees and pricing',
    category: 'platform',
    content: `Unity applies a platform fee on completed rental payments (see current rate in the Payment and Deposit Policy at /payments-and-deposits — it is not fixed at a specific figure in this knowledge base entry to avoid drift from the actual configured rate). There are no listing fees or monthly subscriptions. Renters pay the full amount displayed at checkout (daily rate × days + any deposit).`,
  },
]
