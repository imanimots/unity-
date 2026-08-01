# Peach Payments Integration (Phase 2D — Discovery & Compatibility)

Discovery and architectural-compatibility pass only. **No real Peach API call is made
anywhere in this codebase.** Every source cited below is an official
`developer.peachpayments.com` (or its linked `peach-organization.gitbook.io` webhook page)
document, fetched during this phase — no blog posts, no third-party wrappers, no AI
examples. Where the official docs didn't answer a question directly, that is stated
explicitly as an open question rather than filled in with a guess.

## Primary objective — result

**The Phase 2C financial architecture supports Peach Payments without changing the
`PaymentProvider` interface's method set.** One narrow, justified change was made (see
"Architecture review" below): `WebhookVerificationInput.signatureHeader: string | null`
became `headers: Record<string, string | null>`, because Peach's real webhook schemes need
more than one header and the old shape couldn't carry them. Two new
`OrchestrationErrorCode` values were added (`provider_configuration_error`,
`invalid_webhook_signature`) — both explicitly anticipated by this phase's own error-model
brief. Nothing else in the Financial Orchestrator, the booking domain, or the database
schema needed to change.

---

## 1. Architecture review — PaymentProvider interface, method by method

| Method | Verdict | Notes |
|---|---|---|
| `createPaymentIntent()` | Maps, but currently unused | Not called anywhere in the orchestrator today (`prepareBookingFinancials` creates the local `payments` row via RPC only — see `docs/FINANCIAL_ORCHESTRATION.md`). Pre-existing observation, not Peach-specific. If ever wired, would correspond to opening a Checkout V2 session (`POST /v2/checkout`) and returning its `id` as `providerReference`. |
| `authorizeDeposit()` | Requires adaptation | Maps to Peach's `PA` (preauthorization) — available via **Checkout V2** (`POST /v2/checkout` with `paymentType: "PA"`, JWT bearer auth, SAQ-A-friendly hosted card entry) or the legacy **Server-to-Server** API (`POST /v1/payments`, `paymentType=PA`, full PCI-DSS burden). The adaptation is entirely internal to the adapter (which sub-product to call) — no interface change. See "Deposit mapping" — this is card-only in Peach's model. |
| `captureDeposit()` | Requires adaptation | Maps to Peach's `CP`, called via `POST /v1/payments/{id}` against the **card/backoffice API** — using a *different bearer token* than the one that created the PA, even if the PA came from Checkout (confirmed explicitly: "use a Server-to-Server, Mobile SDK, recurring, or COPYandPAY bearer token, not a Checkout bearer token" — [card-manage-payments](https://developer.peachpayments.com/docs/card-manage-payments)). Adaptation lives in config/adapter, not the interface — `DepositInput` already carries `providerReference` (the PA's `id`) and `amount`. |
| `releaseDeposit()` | Maps directly | Peach's `RV` (reversal), same endpoint, `paymentType=RV`. Matches Unity's own rule exactly: Peach explicitly forbids reversing an already-captured PA ("reversals cannot be performed on already-captured preauthorizations" — card-manage-payments), and Unity's `releaseDeposit` already only fires when `payment.status === 'authorised'`, never after capture. Zero behavioral gap. |
| `chargeRental()` | Maps directly | Peach's `DB` (debit) via the **Payments API v2** (`POST /payments`, basic auth) or Checkout V2. Works across every Peach-supported payment method (card, EFT, wallet, BNPL, ...), not just cards — this is the common case for Unity's immediate rental charge. |
| `refund()` | Maps directly | Peach's `RF`, `POST /payments/{uniqueId}` with `paymentType=RF`, single `amount` field — full or partial in one call. Not every payment method is refundable (M-PESA, MauCAS, some others — see "Refunds"); the interface already models this via `RefundResult.status: 'failed'` with a `failureReason`, no change needed. |
| `createMerchantPayout()` | Maps directly | Peach's Payouts API (`POST /merchants/{merchantId}/payouts`, JWT bearer). See "Marketplace payout analysis" — this is a bulk-disbursement product, not a Stripe-Connect-style split-payment system, but it slots directly into what `createMerchantPayout` already models. |
| `verifyWebhook()` | **Required an interface change** | Peach has three distinct, non-uniform webhook schemes (see "Webhook mapping"). Checkout needs 4 headers to reconstruct an HMAC-signed string; OPPWA needs 2 different headers plus AES-256-GCM decryption (not a signature at all); Payouts has no documented verification mechanism. A single `signatureHeader: string` cannot carry what any of these actually need. Fixed by broadening the input to a generic `headers` bag — see "Interface change" below. |
| `healthCheck()` | Maps directly | Implemented for real this phase — validates configuration only, no network call (see "Proof of concept"). |

### Interface change made

```ts
// Before
export interface WebhookVerificationInput {
  rawBody: string
  signatureHeader: string | null
}

// After
export interface WebhookVerificationInput {
  rawBody: string
  headers: Record<string, string | null>
}
```

Blast radius: `src/lib/payments/provider.ts` (definition), `src/lib/payments/providers/mock-provider.ts`
(reads `headers['x-mock-signature']` instead of `signatureHeader`), `src/app/api/payments/webhooks/[provider]/route.ts`
(passes the full request header set instead of pre-selecting one via a hardcoded
per-provider map — the hardcoded map, which guessed `x-peach-signature`, a header name that
doesn't actually exist in any of Peach's real schemes, is deleted), and the existing test
suite (updated, not weakened — every prior assertion still holds, just through the new
shape).

### Error codes added

`provider_configuration_error` and `invalid_webhook_signature` were added to
`OrchestrationErrorCode` (`src/lib/payments/orchestrator/errors.ts`) — both were named
explicitly in this phase's own brief, and both describe a real failure category Unity's
existing 12 codes didn't cover: a missing/malformed credential (caught before any network
call) and a webhook that fails verification (caught before any payload is trusted). Neither
is retryable in the automatic sense (`isRetryableOrchestrationError` is unchanged — both
fall through to `false`, correctly: retrying with the same bad config or the same forged
signature would never succeed).

---

## 2. Payment methods (South Africa — Unity's launch market)

Source: [pp-payment-methods](https://developer.peachpayments.com/docs/pp-payment-methods)

| Category | Methods |
|---|---|
| Cards | Visa, Mastercard, Amex, Diners (ZAR) |
| EFT / bank | PayShap (5 banks, capped), Pay by Bank, Capitec Pay, Absa Pay, Peach EFT (8+ banks, Payments API only) |
| BNPL | Payflex (R10–R50,000), ZeroPay (min R30), Float (R1–R99,000), Happy Pay |
| Wallets | Apple Pay, Google Pay, Samsung Pay |
| QR | Scan to Pay (full refunds only) |
| Vouchers | 1Voucher |
| Alternative credit | Mobicred, RCS cards, A+ store cards |
| Crypto | MoneyBadger (Bitcoin Lightning, Luno, VALR, Binance, Bybit) |
| Other | PayPal — **USD/GBP/EUR only, not ZAR** |

Unity's rental charge (`chargeRental`, a plain debit) can use any of these. Unity's deposit
(`authorizeDeposit`, a hold) is realistically **card-only** — see "Deposit mapping".

---

## 3. Authorization vs. capture

Source: [oppwa-references-transaction-flows](https://developer.peachpayments.com/docs/oppwa-references-transaction-flows),
[oppwa-integrations-server-to-server](https://developer.peachpayments.com/docs/oppwa-integrations-server-to-server),
[card-manage-payments](https://developer.peachpayments.com/docs/card-manage-payments),
[reference/payment.md](https://developer.peachpayments.com/reference/payment.md)

- **Authorize now, capture later: supported**, but only via the card-transaction family
  (`PA` → `CP`), not the modern Payments API v2 (`POST /payments`), whose `paymentType` is
  confirmed to accept **only `DB` or `RF`** — no `PA`. Authorize/capture requires either
  the legacy Server-to-Server API (full PCI-DSS burden, raw card handling) or **Checkout
  V2**, which can create a `PA` (`paymentType: "PA"` is an explicitly documented optional
  field on `POST /v2/checkout`) while keeping Peach's hosted widget between Unity's servers
  and raw card data (SAQ-A).
- **Capturing/reversing** a PA — regardless of which product created it (Checkout,
  COPYandPAY, or Server-to-Server) — always goes through the same card/backoffice endpoint,
  `POST /v1/payments/{id}` with `paymentType=CP` or `RV`, authenticated with a bearer token
  from that backoffice/Server-to-Server credential set specifically, **not** the Checkout
  bearer token used to create the PA. This is a real operational detail (two credential
  sets for one deposit's lifecycle), not an architectural blocker.
- **Time limit: 7 days** to capture or reverse a PA. Captures cannot be reversed; reversals
  cannot be performed on an already-captured PA.
- **Partial capture / multiple captures against one PA: not confirmed either way** by any
  official page fetched this phase. This is the single most important open question for
  Phase 2E — Unity's `capture_deposit_amount` RPC (built in Phase 2C) already supports
  partial captures at the database level, but whether Peach's own `CP` accepts an amount
  less than the full PA and whether a second `CP` against the same PA is accepted at all
  needs to be verified in the sandbox (or with Peach support) before that code path is
  wired to a real call.
- **Void: supported** (`RV`, same endpoint, referencing the PA's `id`).

---

## 4. Refunds

Source: [checkout-refund](https://developer.peachpayments.com/docs/checkout-refund),
[reference/refund.md](https://developer.peachpayments.com/reference/refund.md)

- **Full and partial refund: supported.** `POST /payments/{uniqueId}` with
  `paymentType=RF` and a single `amount` field (decimal, 2dp) — no batch/array shape.
- **Multiple sequential partial refunds against the same original payment: not confirmed
  either way.** No page fetched this phase states whether a second `RF` against a payment
  that already has one partial refund is accepted or rejected. Flagged as an open question
  for sandbox verification, same as partial deposit captures.
- **Not every payment method is refundable** — M-PESA (Kenya) and MauCAS (Mauritius) are
  explicitly documented as non-refundable; attempting to refund an unsupported type returns
  error `700.300.100`.
- Attempting to refund more than the original amount returns `700.400.200`.

---

## 5. Deposit mapping

**Does Unity's deposit model (authorize → capture-or-release) map cleanly onto Peach?**

**Mostly yes, with one real constraint: true hold-based deposits are a card-only concept in
Peach's model.** EFT, PayShap, wallets, and BNPL are debit-style payment methods in Peach's
system — none of the fetched documentation describes a `PA`-equivalent hold for any of
them, and the mechanism (`PA`/`CP`/`RV`) is documented specifically under card-transaction
flows. This was not contradicted anywhere; it also matches how these payment rails work in
general (an instant EFT push payment or a BNPL approval has no card-network-style
authorization-hold primitive to borrow).

**Consequence for Unity, not a blocker:** if Unity wants a real provider-side deposit hold,
it is only available for renters paying by card. For every other payment method, Unity's
existing `payment_status` state machine (`authorised` → `captured`/`released`) can still be
used, but the *provider-level* meaning changes — the deposit would need to be modeled as an
immediate `DB` charge held as an internal ledger liability (already how `ledger_entries`
tracks `deposit_hold`/`deposit_release`/`deposit_capture` today) with a genuine refund
(`RF`) standing in for "release," rather than a real authorization hold. This is a Phase 2E
product/scope decision (does Unity require card-only for deposits, or build the
non-card fallback path), not something this phase resolves — flagged clearly rather than
silently assumed either way.

Where the mapping **is** clean: Unity's actual database/orchestrator model needs no change
either way. `DepositInput`/`DepositResult` already carry everything either path needs
(`paymentId`, `providerReference`, `amount`, `currency` in; `status` out). The 7-day
capture window is worth checking against Unity's actual rental-duration distribution before
Phase 2E — a booking whose return is confirmed more than 7 days after acceptance would need
a re-authorization strategy that doesn't exist today.

---

## 6. Marketplace payouts

Source: [peach-payouts](https://developer.peachpayments.com/docs/peach-payouts),
[payouts-api-1](https://developer.peachpayments.com/docs/payouts-api-1),
[reference/createpayoutrequest.md](https://developer.peachpayments.com/reference/createpayoutrequest.md),
[reference/querypayoutrequest.md](https://developer.peachpayments.com/reference/querypayoutrequest.md)

**Peach does not perform marketplace/split-payment payouts the way Stripe Connect does.**
There is no "connected sub-merchant account" concept anywhere in the fetched documentation.
Instead:

- Peach Payouts is a **bulk-disbursement product**: "South African businesses make instant
  EFT payments to suppliers, employees, partners, or customers" — general-purpose, not
  marketplace-specific.
- **Funding model:** the calling business (Unity) deposits funds into its own Peach account
  balance ("float") first, then instructs disbursement from that balance. Peach never holds
  individual merchants' money as separate sub-accounts — Unity's own account is the single
  pool everything flows through.
- **Recipient details are supplied per-payout**, not stored by Peach as a "connected
  account": `bankName`, `accountNumber`, `branchCode`, `accountHolder` are request fields
  on every `POST /merchants/{merchantId}/payouts` call. Unity would need to collect and
  store each merchant's banking details itself (not built yet — no such field exists on
  `profiles` or anywhere else today).
- **This does functionally support Unity's use case** — Unity is already the sole entity
  Peach knows about (the merchant-of-record), collecting all rental charges into its own
  balance and owing each platform-merchant their proceeds, which is exactly what
  `merchant_payouts` + `createMerchantPayout()` already model. Peach Payouts is the real
  money-movement step Unity's `MockProvider` currently simulates — this slots in directly,
  no redesign needed.
- **Real business/compliance implication worth flagging even though it doesn't block the
  architecture:** because there's no sub-merchant risk transfer, Unity — not Peach — is the
  entity holding every platform-merchant's money until it pays it out. This is a
  business/compliance question (how Unity's own settlement obligations are structured), not
  a technical one, but it's a direct consequence of how Peach's product works and should be
  understood before Phase 2E, not discovered after.
- **Bank verification:** a separate `POST /payouts/bank-verification` endpoint exists,
  suggesting Peach recommends verifying a recipient's account before the first payout to it
  — a reasonable addition for Phase 2E, not built this phase.
- **Batching:** the docs explicitly discourage single-recipient calls when multiple
  payouts are due at once ("Do not use a create payout request to pay a single customer
  unless you only have to pay one customer") in favor of batching several recipients into
  one `payouts` array. Unity's current per-booking payout timing (payouts happen
  individually as each booking completes, not as a daily batch) is naturally
  single-recipient per call, which the docs' own guidance treats as fine when that's
  genuinely the only recipient in that call. A future move to scheduled/batched payouts
  would batch multiple pending payouts into one request — not built this phase, no
  interface change implied either way.
- **Payout status lifecycle** (`PayoutState` enum): `pending → processing → successful |
  failed | cancelled | reversed`. Asynchronous — tracked via `GET /payouts/{payoutId}` or
  the `POST /payouts/status-updated` webhook.

---

## 7. Webhook mapping

Peach has **three separate, non-uniform webhook systems** — not one "Peach webhook."
Unity's single `POST /api/payments/webhooks/[provider]` route (provider-isolated by its own
route segment, per `docs/PAYMENT_ARCHITECTURE.md`) already isolates providers from each
other; within the `peach` provider, `verifyWebhook()` itself now dispatches on which headers
are present (implemented this phase — see "Proof of concept").

### Checkout / Payment Links webhooks

Source: [checkout-webhooks](https://developer.peachpayments.com/docs/checkout-webhooks)

- **Events:** `Created`, `Pending`, `Successful`, `Uncertain`, `Cancelled`.
- **Signature:** HMAC-SHA256 over `${timestamp}.${webhookId}.${url}.${payload}`, verified
  against headers `x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id`,
  `x-webhook-signature-algorithm`. Raw body required (Checkout sends form-urlencoded;
  Payment Links sends JSON — never parse before verifying).
- **Replay protection:** the unique `webhookId` is baked into the signed string itself.
- **Ordering:** not guaranteed — use the payload's own `timestamp`.
- **Retries:** exponential backoff (2/4/8/15/30 min, then hourly) for up to 30 days, until
  a 200 response.

### OPPWA / card webhooks

Source: [oppwa-guides-webhooks](https://developer.peachpayments.com/docs/oppwa-guides-webhooks)

- **Events:** four categories — `PAYMENT`, `REGISTRATION` (with `CREATED`/`UPDATED`/`DELETED`
  actions), `SCHEDULE`, `RISK`.
- **Not signed — encrypted.** AES-256-GCM, decrypted with a Dashboard-issued key; IV and
  auth tag arrive as `X-Initialization-Vector` / `X-Authentication-Tag` headers (hex). Body
  is either a bare hex ciphertext or JSON-wrapped as `{"encryptedBody": "..."}`.
  Authentication-tag validation (built into AES-GCM decryption) is the actual integrity
  check here, not a separate signature comparison.
- **Explicit duplicate warning in the docs:** "You may receive more than one final status
  (for example, success + failure). Deduplicate based on transaction ID and status."
- **Retries:** 1/2/4/8/15/30 min, then hourly, up to 30 days; 30-second response timeout.

### Payouts webhooks

Source: [reference/post_payoutstatusupdated.md](https://developer.peachpayments.com/reference/post_payoutstatusupdated.md)

- **Payload:** `{ status, payoutId, lastUpdated, resultCode }`.
- **No documented signature or encryption mechanism was found for this webhook.** This
  phase deliberately does **not** assume it is safe to trust unsigned — `verifyWebhook()`
  treats a Payouts-shaped payload the same as an unverifiable one (`valid: false`), until
  a real verification mechanism is confirmed with Peach (support ticket or a sandbox trace
  showing what headers actually arrive) before Phase 2E processes one for real. See "Known
  limitations."

### Mapping table (Peach event → Unity effect)

| Peach event | Normalized Unity event | Financial Orchestrator action | Payment state transition | Ledger effect |
|---|---|---|---|---|
| Checkout `Successful` (DB) | `rental_charge.captured` | resume `authorizeBookingFinancials` if `financial_workflows` is `failed_retryable`; otherwise reconciliation-only | `payments.status → captured` | `rental_charge` + `platform_fee` entries (existing `transition_payment_status` RPC) |
| Checkout `Successful` (RF) | `refund.completed` | not yet wired — Phase 2E: a refund-reconciliation workflow | `payments.status → refunded`/`partially_refunded` | `refund` entry |
| Checkout `Cancelled` / `Uncertain` (timeout) | `rental_charge.failed` | resume-or-fail per existing retryable/terminal split | `payments.status → failed` (via `transition_payment_status`) | none |
| OPPWA `PAYMENT` (paymentType `PA`, success) | `deposit.authorised` | resume `authorizeBookingFinancials` | `payments.status → authorised` | `deposit_hold` entry |
| OPPWA `PAYMENT` (paymentType `CP`, success) | `deposit.captured` | not yet wired — Phase 2E: a capture-reconciliation path (today, `captureDeposit()` is caller-driven, not webhook-driven) | `payments.status → captured`/`partially_captured` | `deposit_capture` entry (`capture_deposit_amount` RPC) |
| OPPWA `PAYMENT` (paymentType `RV`, success) | `deposit.released` | not yet wired — Phase 2E | `payments.status → released` | `deposit_release` entry |
| Payouts `successful` | `payout.paid` | not yet wired — Phase 2E: update `merchant_payouts.status` on webhook rather than only on request | `merchant_payouts.status → paid` | none (the `merchant_payout` ledger entry is already written at request time by `create_merchant_payout`) |
| Payouts `failed`/`cancelled`/`reversed` | `payout.failed` | not yet wired — Phase 2E | `merchant_payouts.status → failed` | none |

Only the first two rows (resuming a `failed_retryable` `authorize_booking_financials`
workflow) are wired today, via the existing `reconcileProviderEvent()` — see
`docs/FINANCIAL_ORCHESTRATION.md`. The rest are documented as the intended mapping but not
implemented, since implementing them means writing new orchestrator resume paths against a
provider that doesn't make real calls yet — correctly out of scope for a discovery phase.

---

## 8. Payment state machine mapping

Unity's `payment_status`: `pending → authorised → captured ⇄ partially_captured → refunded
⇄ partially_refunded`, plus `released`, `failed`, `cancelled`, `expired`, `chargeback`
(terminal states) — see `docs/PAYMENT_ARCHITECTURE.md`.

| Unity `payment_status` | Peach equivalent | Mapping |
|---|---|---|
| `pending` | `PA`/`DB` submitted, awaiting result (`000.200.x` family) | 1:1 |
| `authorised` | `PA` succeeded | 1:1 (card-only, see "Deposit mapping") |
| `captured` | `DB` or `CP` succeeded | 1:1 |
| `partially_captured` | `CP` for less than the full PA amount | 1:1 *if* Peach confirms partial capture (open question, §3) |
| `released` | `RV` succeeded | 1:1 |
| `refunded` | `RF` for the full amount succeeded | 1:1 |
| `partially_refunded` | `RF` for less than the full amount succeeded | 1:1 *if* Peach confirms multiple partial refunds (open question, §4) |
| `failed` | Any non-success `result.code` | many-to-one — dozens of Peach codes collapse into this one Unity state; the *reason* is preserved separately via `OrchestrationErrorCode`, not folded into `payment_status` itself |
| `cancelled` | Checkout `Cancelled` | 1:1 |
| `expired` | Checkout `Uncertain` past its 30-minute window | 1:1 |
| `chargeback` | `CB` (chargeback) / `CR` (chargeback reversal) | 1:1 for `CB`; `CR` has no direct Unity state today (a reversed chargeback — not built this phase, flagged as a limitation) |

No Peach state is unsupported by Unity's model; the one gap (`CR`, chargeback reversal) is
narrow and named explicitly rather than silently dropped.

---

## 9. Error mapping

Source: [dashboard-response-codes](https://developer.peachpayments.com/docs/dashboard-response-codes)

Implemented in `src/lib/payments/providers/peach/error-mapper.ts`
(`mapPeachResultCodeToOrchestrationError`), unit-tested against every code below.

| Peach result code | Meaning | `OrchestrationErrorCode` |
|---|---|---|
| `800.100.151`–`800.100.159` | invalid/expired card | `provider_declined` |
| `800.100.160`–`800.100.169` | blocked/lost/stolen card | `provider_declined` |
| `800.100.155`, `800.100.203` | insufficient funds | `provider_declined` |
| `800.100.153`, `800.100.192` | CVV rejection | `provider_declined` |
| `000.400.104` | missing/malformed 3DS config | `provider_configuration_error` (Unity's setup, not the customer's) |
| `000.400.106` | invalid 3DS authentication response | `provider_declined` (the customer's auth attempt failed) |
| `700.300.100` | referenced transaction can't be refunded/captured/reversed | `invalid_payment_transition` |
| `700.400.200` | refund/capture amount exceeds original | `invalid_payment_transition` (closest existing code — not a perfect semantic fit, see "Known limitations") |
| `800.120.100` | rate limited ("too many requests") | `provider_unavailable` (retryable) |
| `000.200.000`, `000.400.081` | pending/timeout | `provider_timeout` (retryable) |
| any unrecognized code | — | `terminal_provider_error` (safe default — never silently treated as success or auto-retryable) |
| webhook signature/decryption failure | — | `invalid_webhook_signature` |

---

## 10. Idempotency

Source: [reference-best-practices](https://developer.peachpayments.com/docs/reference-best-practices),
[payments-faq](https://developer.peachpayments.com/docs/payments-faq)

**No first-class idempotency mechanism is documented anywhere fetched this phase.** No
`Idempotency-Key`-style header exists in any endpoint reference. The closest thing is
`merchantTransactionId` (an 8–16 character alphanumeric field on `POST /payments`),
described only as "used for reconciliation" — with no documented guarantee about what
happens if the same value is submitted twice (dedup? processed again? rejected?).

**Conclusion: Unity's own idempotency layer must remain fully authoritative and must never
assume Peach will deduplicate a retried request.** This is not a new gap Phase 2D needs to
close — it confirms that Phase 2C's existing design (every orchestrator call checks Unity's
own `idempotency_keys` / `financial_workflows` state *before* ever calling the provider,
never relying on the provider itself being idempotent) was the correct approach, not an
optional safeguard. No change needed; this is a finding that validates prior work.

---

## 11. Sandbox

Source: [dashboard-sandbox](https://developer.peachpayments.com/docs/dashboard-sandbox),
[oppwa-guides-3-d-secure-testing-guide](https://developer.peachpayments.com/docs/oppwa-guides-3-d-secure-testing-guide)

- Separate dashboard (`sandbox-dashboard.peachpayments.com`), credentials available
  immediately on signup, fully isolated from live — "no real money is ever transferred."
- Card payments work out of the box in sandbox; other payment methods need activation via
  the Dashboard or Peach support.
- Deterministic 3DS test outcomes via specific test card numbers (e.g. `4200000000000042`
  for a challenge flow) or `customParameters[3DS2_flow]=challenge|frictionless` — this
  mirrors Unity's own `MockScenario` philosophy (explicit, deterministic outcome selection,
  never randomness), meaning a future real sandbox test suite can stay just as deterministic
  as `MockProvider`'s tests are today.
- Limitations: SMS/WhatsApp notification testing unavailable; some multi-currency test
  amounts only simulate success at specific values (92.00 or 15.99, per one documented
  quirk); Wix and Xero integrations have no sandbox at all.

---

## 12. SDKs

Source: [checkout-embedded-sdk-reference](https://developer.peachpayments.com/docs/checkout-embedded-sdk-reference)

**No official server-side SDK for any language, including Node.js/TypeScript.**
Server-to-server integration is REST-only. The Embedded Checkout SDK is a **browser**
JS/TS widget only (renders the payment form; the server-side `POST /v2/checkout` call that
creates the session happens outside the SDK). Separate Mobile SDKs (iOS/Android, v1 and a
newer v2) exist for native apps — not relevant to Unity's Next.js server.

**This matches Unity's existing architecture exactly** — `PeachPaymentsProvider` is already
a hand-rolled adapter with no SDK dependency, consistent with how `MockProvider` and the
rest of the payment domain are built. No package to add, no vendor lock-in beyond a REST
contract.

---

## 13. Rate limits

Source: [oppwa-references-api](https://developer.peachpayments.com/docs/oppwa-references-api),
[reconciliation](https://developer.peachpayments.com/docs/bus-ops-recon-api)

| Endpoint | Limit |
|---|---|
| Server-to-Server `GET /v1/payments/{id}` (status) | **2 requests/minute** |
| Server-to-Server backoffice ops | 200/minute |
| "Payments over token" (`POST /v1/registrations/{id}/payments`) | 200/minute |
| COPYandPAY `GET /v1/checkouts/{id}/payment` | 9/minute (2/minute in sandbox) |
| Reconciliation API | 1 request/second, 24-hour max query window |
| Throttle response | `800.120.100` "Too many requests" |

**The 2-requests-per-minute status-polling limit is the single most consequential number in
this whole discovery.** It confirms that status polling cannot be a primary reconciliation
mechanism at any real volume — Unity's existing webhook-first design (`docs/FINANCIAL_ORCHESTRATION.md`,
`docs/PAYMENT_ARCHITECTURE.md`) is not just a reasonable choice, it is close to mandatory
given this constraint. No client-side timeout recommendation was found in any fetched page
— flagged as an open question for Phase 2E (Unity will need to pick its own outbound
timeout; the 30-day webhook retry window suggests being conservative and relying on
webhooks/reconciliation over aggressive synchronous retries).

---

## 14. Configuration

Environment variables only — see `.env.example` for the authoritative list (names only, no
values, matching every other integration in this codebase). No secret appears in this
document or anywhere else.

Peach spans **four independent credential domains** (discovered during this phase — see
§3): Payments API v2, Checkout V2, the card/backoffice API, and the Payouts API. Each is
optional independently — `loadPeachConfig()` (`src/lib/payments/providers/peach/config.ts`)
returns `null` for whichever block isn't configured rather than failing the whole provider,
so a deployment can enable rental charges (Payments API only) before deposits (Checkout +
card API) or payouts are ready.

| Variable | Required for | Sandbox/production |
|---|---|---|
| `PEACH_ENVIRONMENT` | selecting every base URL below | `sandbox` or `production` — required if any Peach block is used |
| `PEACH_PAYMENTS_API_ENTITY_ID` / `_USER_ID` / `_PASSWORD` | rental charge (`DB`) and its refund (`RF`) | value differs per environment |
| `PEACH_CHECKOUT_ENTITY_ID` | creating a Checkout V2 session (rental charge or deposit `PA`) | value differs per environment |
| `PEACH_CHECKOUT_WEBHOOK_SIGNING_SECRET` | verifying Checkout webhooks | value differs per environment |
| `PEACH_CHECKOUT_WEBHOOK_URL` | verifying Checkout webhooks (part of the signed string — must exactly match what's registered in the Dashboard) | value differs per environment |
| `PEACH_CARD_API_BACKOFFICE_BEARER_TOKEN` | capturing/reversing a deposit (`CP`/`RV`) | value differs per environment |
| `PEACH_CARD_API_WEBHOOK_DECRYPTION_KEY` | decrypting OPPWA webhooks | value differs per environment |
| `PEACH_PAYOUTS_API_BEARER_TOKEN` | merchant payouts | value differs per environment |
| `PAYMENT_PROVIDER=peach` | selecting this provider at all (existing var from Phase 2C) | same both environments |

---

## 15. Proof of concept — what was actually built this phase

**Real (no live calls, nothing here sends money or touches a network):**

- `src/lib/payments/providers/peach/config.ts` — env var loading, per-block validation,
  sandbox/production URL resolution. No network call.
- `src/lib/payments/providers/peach/signature.ts` — real HMAC-SHA256 verification
  (Checkout/Payment Links) and real AES-256-GCM decryption (OPPWA), both pure functions
  over caller-supplied inputs.
- `src/lib/payments/providers/peach/error-mapper.ts` — real Peach-result-code →
  `OrchestrationErrorCode` mapping.
- `src/lib/payments/providers/peach/event-normalizer.ts` — real parsing of all three
  webhook payload shapes into one internal shape (deliberately stops short of resolving a
  Unity `bookingId`, which needs a DB lookup — a pure function's job ends at the shape
  translation; see the module's own doc comment).
- `src/lib/payments/providers/peach/request-builders.ts` — real request-shape builders for
  rental charge, refund, deposit capture/reversal, and payout requests, matching the
  documented field names/types exactly (including the rand-vs-cents unit difference between
  the Payments API and the Payouts API, tested explicitly).
- `src/lib/payments/providers/peach/response-parsers.ts` — real response parsing into
  Unity's `ChargeResult`/`RefundResult`/`DepositResult`/`MerchantPayoutResult` shapes.
- `PeachPaymentsProvider.healthCheck()` — real, validates configuration only.
- `PeachPaymentsProvider.verifyWebhook()` — real, dispatches to the correct verification
  scheme based on which headers are present; the Payouts case is deliberately treated as
  unverifiable (see §7) rather than trusted.

**Still stubs (throw `NotImplementedError`, unchanged from Phase 2C):**
`createPaymentIntent()`, `authorizeDeposit()`, `captureDeposit()`, `releaseDeposit()`,
`chargeRental()`, `refund()`, `createMerchantPayout()` — every method that would move money
or call a live API. The request builders and response parsers above exist and are tested,
but nothing calls `fetch()` anywhere in this codebase for Peach.

---

## 16. Known limitations

- **Partial/multiple deposit captures against one `PA`: unconfirmed.** Needs sandbox
  verification or a Peach support conversation before Phase 2E wires `captureDeposit()` to
  a real call.
- **Multiple sequential partial refunds against one payment: unconfirmed.** Same treatment.
- **Production host for the card/backoffice API is inferred, not confirmed** — only the
  sandbox host (`sandbox-card.peachpayments.com`) was found explicitly in the fetched docs;
  the production value in `config.ts` (`card.peachpayments.com`) follows the same
  "sandbox-" prefix pattern every other confirmed Peach host uses, but is flagged as an
  assumption, not a fact, in the code comment itself.
- **Payouts webhook signature/verification mechanism is not documented anywhere found this
  phase.** Treated as unverifiable (see §7) — must be confirmed before Phase 2E trusts a
  payout webhook.
- **Deposits are realistically card-only** in Peach's model — Unity needs a product
  decision (Phase 2E or later) about whether that's acceptable or whether a non-card
  deposit fallback (immediate charge + conditional refund) is needed.
- **Merchant banking details are not collected anywhere in Unity today** — a real payout
  needs `bankName`/`accountNumber`/`branchCode`/`accountHolder` per merchant, which has no
  home in the schema yet. Not built this phase (would be Phase 2E+ schema work).
- **No client-side request timeout guidance found** in any fetched Peach page — Phase 2E
  will need to choose its own values.
- **`700.400.200`'s mapping to `invalid_payment_transition`** is the closest existing code,
  not a perfect semantic match (it's really "amount exceeds available," closer in spirit to
  `insufficient_deposit_authorization`, but that code's name is deposit-specific and this
  error can occur on a plain refund too). Left as-is rather than inventing a third
  overlapping code for one edge case — noted here for Phase 2E to revisit if it becomes a
  real point of confusion in practice.
- **Chargeback reversal (`CR`) has no corresponding Unity `payment_status`** — narrow gap,
  not built this phase.
- Every webhook mapping-table row beyond "resume a `failed_retryable` authorize workflow"
  (capture/release/payout reconciliation) is documented but not implemented — see §7.

## 17. Migration plan (for Phase 2E, not built now)

1. Confirm the two open questions (partial capture, multiple partial refunds) against the
   sandbox.
2. Confirm the Payouts webhook verification mechanism with Peach support.
3. Decide the deposit product scope (card-only vs. a non-card fallback).
4. Add merchant banking-details collection (new schema, new UI) if payouts are in scope for
   the same milestone as deposits/charges.
5. Wire `chargeRental()`/`refund()` to the Payments API v2 first (broadest payment-method
   coverage, simplest credential set, no PA/CP complexity) — natural first real integration
   milestone.
6. Wire `authorizeDeposit()`/`captureDeposit()`/`releaseDeposit()` to Checkout V2 + the
   card/backoffice API second, once the two open questions above are resolved.
7. Wire `createMerchantPayout()` to the Payouts API third, once merchant banking details
   exist.
8. Extend the webhook mapping table's remaining rows (capture/release/payout
   reconciliation) into real `reconcileProviderEvent`-style resume paths as each product
   above goes live, not all at once.
9. Re-run this document's request-builder/response-parser/error-mapper tests against real
   sandbox responses as each step lands, to catch any drift between what the docs say and
   what the sandbox actually returns.
