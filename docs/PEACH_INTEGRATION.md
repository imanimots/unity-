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

## 0. E31 update — refund contract investigation, generation mismatch, and corrected payout facts

Everything below this section describes the Phase 2D generation of this integration:
**classic** Payments API v2 (`userId`/`password`/`entityId`), Checkout V2 session creation,
the card/backoffice API, and a static Payouts bearer token. **That is no longer what
`PeachPaymentsProvider` actually does.** A later phase (P5C.1, per that class's own doc
comment) rewired `chargeRental()`/`authorizeDeposit()`/`captureDeposit()`/`releaseDeposit()`
onto a *different* generation — "Peach Orchestration," authenticated with a single `api-key`
header against `PEACH_ORCHESTRATION_API_BASE_URL` — without this document being updated to
match. The classic scaffolding under `./peach/` (config, signature, request-builders,
response-parsers, error-mapper — everything §15 lists as "real") still exists and is still
unit-tested, but as of P5C.1 it is **unreferenced by any money-moving method** and is used
today only by `verifyWebhook()`/`healthCheck()`. Treat every claim below about `refund()`,
`createMerchantPayout()`, or `createAffiliatePayout()`'s *intended* request/response shape as
describing the classic generation specifically, not necessarily the Orchestration generation
the live methods actually use.

**E31's refund-contract audit, performed against current official
`developer.peachpayments.com` documentation (live web search + fetch, this phase):**

- Peach's current documentation **has no standalone "Orchestration" product category at
  all** — confirmed directly against the live top-level docs index. The only concrete
  reference to "Peach Orchestration's Server-to-Server" links to
  `https://playground.peachpayments.com/integrate/api-only`, an interactive, JavaScript-
  rendered playground that returns only a loading placeholder to a static fetch — not a
  crawlable reference page. **This is the exact same wall `orchestration/config.ts`'s own
  comment already discloses** ("the real Orchestration REST API's own base URL was never
  directly confirmed by any fetch... only the interactive-docs/playground host was") — still
  unresolved today, not newly discovered by this phase.
- Two *different*, fully-documented refund endpoints exist, and **neither is confirmed to be
  the one Unity's actual `api-key`-header `OrchestrationClient` would use**:
  1. Classic Payments API: `POST /payments/{uniqueId}`, `userId`/`password`/`entityId` body
     auth — officially deprecated for new integrations ("use Peach Orchestration's
     Server-to-Server and not the classic Payments API").
  2. Checkout API: `POST /v1/checkout/refund`, **HMAC-SHA256 signature** auth — a plausible
     candidate for what Peach calls "Orchestration" (the "use Orchestration" sentence lives
     on the Checkout API's own overview page), but no page directly confirms this identity,
     and its auth model doesn't match the plain `api-key` header Unity's session-creation
     calls already use successfully.
- Given this, **no real `refund()` implementation was written this phase.** Building one
  against either unverified candidate would risk a real-money refund operation on a wrong
  auth model, wrong endpoint, or wrong finality assumption. `PeachPaymentsProvider.refund()`
  remains a `NotImplementedError` stub; `supportsCapability('refund')` remains `false`.

**Corrected payout facts** (the specific stale claims named by this phase's own brief,
re-verified against current official docs):

- **§7 "Payouts webhooks," §16:** "No documented signature or encryption mechanism was found
  for this webhook" is **no longer accurate.** Current Peach Payouts documentation now
  explicitly supports webhook signature verification — Svix-compatible (or manual)
  verification using a signing secret plus `webhook-id`/`webhook-timestamp` headers. A real
  Payouts webhook integration must use this, never treat the payload as unsigned/trusted.
- **§14 "Configuration," §6:** the static `PEACH_PAYOUTS_API_BEARER_TOKEN` model is
  **confirmed stale.** Current official Peach Payouts authentication is OAuth-style:
  `clientId` + `clientSecret` + `merchantId` → a Peach Authentication API token endpoint →
  a short-lived `access_token`, used as `Authorization: Bearer <token>` and refreshed on
  expiry. This repo's existing `PEACH_PAYOUTS_API_BEARER_TOKEN` variable and the
  `payoutsBearerToken` block in `peach/config.ts` are **not production-ready** and are
  unreferenced by any real call site today (`createMerchantPayout`/`createAffiliatePayout`
  are still stubs) — a real implementation needs client-credentials config
  (`PEACH_PAYOUTS_CLIENT_ID`/`_CLIENT_SECRET`/`_MERCHANT_ID` or equivalent), not this
  variable.
- **§6 "Payout status lifecycle":** re-confirmed accurate — `processing`/`successful`/
  `failed` (this phase's fetch also surfaced `cancelled`/`reversed` as additional terminal
  states already recorded here) remain the current documented states. Re-confirmed: querying
  by payout ID is a real, documented reconciliation mechanism; a merchant-supplied `payoutId`
  is not yet mandatory but **Peach has stated it will become mandatory and reject duplicate
  `payoutId`s** once it does — any future implementation should treat uniqueness as mandatory
  now rather than retrofit it later.
- **Bank account verification:** confirmed to run on a schedule (03:00–23:00) for first
  payouts to a new account — a real operational constraint, not just a recommendation, worth
  carrying into any future payout-activation runbook.

**The hard blocker for either real payout capability remains unrelated to any of the above:**
no `bankName`/`accountNumber`/`branchCode`/`accountHolder` (or equivalent) column exists
anywhere in this schema for a merchant or an affiliate — confirmed again this phase, schema
unchanged. `PeachPaymentsProvider.supportsCapability('merchant_payout' | 'affiliate_payout')`
remain `false`. A dedicated follow-up phase (recipient banking authority, storage, RLS,
verification, change lifecycle, payout-time snapshot) must land before either capability can
honestly become `true` — see the engagement's own E32 scope note.

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
- **STALE, corrected by E31 (see §0):** signature verification for this webhook *is* now
  documented (Svix-compatible, signing secret + `webhook-id`/`webhook-timestamp` headers).
  `verifyWebhook()` still treats a Payouts-shaped payload as unverifiable today (`valid:
  false`) — that remains correct behavior until the signature scheme above is actually
  implemented, just not because no mechanism exists any more.

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
| `PEACH_PAYOUTS_API_BEARER_TOKEN` | merchant payouts — **stale, see §0**: current official Peach Payouts auth is OAuth client-credentials, not a static bearer token | value differs per environment |
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
- **STALE, corrected by E31 (see §0):** a Payouts webhook signature/verification mechanism
  *is* now documented (Svix-compatible). Still treated as unverifiable in code (see §7) until
  that scheme is actually implemented — the gap now is "not yet built," not "not documented."
- **Deposits are realistically card-only** in Peach's model — Unity needs a product
  decision (Phase 2E or later) about whether that's acceptable or whether a non-card
  deposit fallback (immediate charge + conditional refund) is needed.
- **STALE, superseded by E32 (see §18):** merchant/affiliate bank destinations now have a
  real, Vault-backed, versioned home (`payout_destinations` + BANV), established
  specifically so a future payout-execution phase has somewhere real to read from. What
  remains unbuilt is payout *execution* itself (`createMerchantPayout`/
  `createAffiliatePayout` are still stubs, Peach's `merchant_payout`/`affiliate_payout`
  capabilities still `false`) — not banking-details collection, which this sentence
  previously (incorrectly, as of E32) described as entirely missing.
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

## 18. E32 update — payout recipient banking authority, verification & secure storage

Closes step 4 of §17's migration plan above (merchant/affiliate banking-details
collection) — but only that step. Payout *execution* (steps 7+) remains untouched:
`createMerchantPayout()`/`createAffiliatePayout()` are still `NotImplementedError` stubs,
and `PeachPaymentsProvider.supportsCapability('merchant_payout'|'affiliate_payout')` are
still `false`.

**Recipient model.** Unity has exactly one canonical identity, `profiles(id)` — no separate
merchants/affiliates table exists (confirmed by audit: "merchant" is a `profiles.role` enum
value, "affiliate" an independent `profiles.is_affiliate` boolean, so one profile can be
both). A bank destination is therefore owned by `profiles(id)` directly, purpose-agnostic —
one destination serves both merchant and affiliate payouts for that person, never a
polymorphic `(recipient_type, recipient_id)` pair.

**Storage.** Supabase Vault (`vault.create_secret`/`vault.decrypted_secrets`), not a new
`pgsodium` integration — current official guidance is to prefer Vault for new secret
storage; Vault's own API is stable even as `pgsodium` itself is pending deprecation for
direct use. The vault schema is structurally un-exposable via the Data API
(`supabase/config.toml` `[api] schemas = ["public", "graphql_public"]`), and its default
grants are service-role-only. The one function that ever reads `vault.decrypted_secrets`
(`get_payout_destination_account_number`) is itself grant-gated to `service_role` only,
exactly like every other sensitive RPC already in this codebase — it is **not** in the
pre-existing `private` schema (that schema is reserved for RLS-policy-internal predicates
that are never called via PostgREST `.rpc()`; a function the application *does* call via
`.rpc()` must stay in a Data-API-exposed schema to be reachable at all).

**Versioning.** Every `payout_destinations` row is an immutable version — bank/account-type/
last4/branch-code fields are never `UPDATE`d after insert; replacing a destination always
inserts a new version and flips the previous one's `is_current` to `false` in the same
transaction. A partial unique index (`(owner_id) where is_current and disabled_at is null`)
is the actual concurrency backstop, not just RPC discipline.

**KYC reuse — no duplicated identity data.** Peach's BANV `idNumber`/`lastName` are sourced
*live*, at submission time, from the already-structured `identity_verifications` table
(`id_reference_number`/`legal_surname`) — confirmed by audit to already capture structured
fields, not just uploaded documents. Nothing is copied into the new payout-destination
tables; a destination cannot be submitted for verification until
`identity_verifications.status = 'approved'` for its owner, failing closed with a clear
error otherwise.

**BANV contract (confirmed live against current official docs, 2026-11-11):**
- Create: `POST /merchants/{merchantId}/banv` — `accountNumber` (`^[0-9]{1,13}$`),
  `accountType` (enum: `current_cheque_account|savings_account|transmission_account|
  bond_account|subscription_share|unknown`), `branchCode` (`^[0-9]{6}$`), `idNumber`
  (1–13 chars), `initials`/`lastName` optional — returns `bankVerificationId`, `status`
  (`pending|processing|successful|failed`), `resultCode`.
- Query: `GET /merchants/{merchantId}/banv/{bankVerificationId}/status` — returns the same
  `status`/`resultCode` plus nine per-attribute `positive|negative|unverified` attestation
  outcomes (`accountNumber`, `idNumber`, `initials`, `lastName`, `accountOpen`,
  `accountAcceptsCredits`, `accountAcceptsDebits`, `accountOpenGtThreeMonths`,
  `accountType`) — stored verbatim (safe: attestation outcomes, never raw banking values).
- Auth: OAuth client-credentials (`clientId`/`clientSecret`/`merchantId` →
  short-lived `access_token`), reusing the existing `PEACH_ENVIRONMENT` selector for host
  choice rather than adding a second toggle.
- Webhook: Svix/Standard Webhooks (`webhook-id`/`webhook-timestamp`/`webhook-signature`
  headers, `whsec_`-prefixed secret) — a **different** scheme from Checkout's own
  `x-webhook-signature` family (§7), implemented separately
  (`providers/peach/payouts-webhook-signature.ts`). The webhook payload shape itself was
  never confirmed by a dedicated reference page — assumed, conservatively, to match the
  query-result shape (Peach's own wording: "sends a webhook with the bank account
  verification result"); an unrecognized shape fails closed (never marks anything
  verified) rather than guessing.

**Bank catalog.** Seeded from Peach's current official "Supported banks" table (29 banks,
fetched live) — payout and BANV support are tracked independently because they are
genuinely asymmetric for several banks (e.g. Bidvest Bank Alliances: payout yes/BANV no;
Finbond Net1: payout no/BANV yes).

**Verification finality & freshness.** Only Peach's own top-level `status = 'successful'`
on a signed webhook or an authenticated query-reconciliation call can ever set
`verification_status = 'verified'` — never HTTP 200 on creation, never an admin action.
Freshness is a 90-day window (matching Peach's own "approximately every three months"
guidance), computed live at eligibility-check time rather than stored as a separate enum
value, so no cron sweep is needed to fail closed on staleness.

**Webhook infrastructure reuse.** BANV results reuse the existing, already provider-neutral
`payment_webhook_events` table and its claim/complete/error lease RPCs completely
unchanged, under a new `provider` value `'peach_banv'` — no new webhook ledger.

**Scope boundary.** No payout-execution code was touched. `createMerchantPayout()`/
`createAffiliatePayout()` remain stubs; both payout capabilities remain `false`. The one
authoritative check a future payout-execution phase must call is
`_payout_destination_eligibility(owner_id)` — eligible only for exactly one current,
enabled, verified, non-stale destination.

**STALE, superseded by E33 (see §19):** real Peach payout execution now exists for both
merchant and affiliate payouts — `createMerchantPayout()`/`createAffiliatePayout()` are
implemented, not stubs, and `supportsCapability('merchant_payout'|'affiliate_payout')` is
`true`. Production remains disabled via a separate, independently-gated
`PEACH_PAYOUTS_EXECUTION_ENABLED` control (default false) — the capability flag means "a
real implementation exists," never "production execution is enabled."

## 19. E33 update — Peach payout execution, async reconciliation & destination snapshot binding

Closes steps 7+ of §17's migration plan (payout execution itself), consuming the E32
destination authority rather than inventing recipient banking data during this phase.
Production stays fail-closed: `PAYMENT_PROVIDER` remains absent, and the new
`PEACH_PAYOUTS_EXECUTION_ENABLED` gate independently defaults `false` — `PAYMENT_PROVIDER=
peach` alone was deliberately never allowed to auto-enable payouts, since Peach already
serves charges/deposits under that same env var and payout activation may need separate
operational sign-off (funded float, source-of-funds compliance, Dashboard webhook
configuration — see E34, planned next).

**Two critical corrections found by re-verifying current official docs this phase** (never
assumed correct from E32's own research):
1. **Auth host.** The OAuth token endpoint lives on `dashboard.peachpayments.com` /
   `sandbox-dashboard.peachpayments.com` — a genuinely different host from the Payouts API
   itself (`payouts.peachpayments.com`). E32's client posted the token request to the
   Payouts host, which would have failed against the real API. Fixed in
   `providers/peach/banv-client.ts`/`payouts-config.ts` (new `authBaseUrl` field).
2. **bankName enum mismatch.** Peach's real-time-EFT `bankName` field only accepts 25
   literal values (confirmed via the live `createpayoutrequest` reference), which do **not**
   match E32's `payout_banks.display_name` strings, and exclude 3 banks E32 had marked
   `payout_supported = true` (Mukuru, Mercantile Bank, Rand Merchant Bank) — those banks were
   sourced from a different, less authoritative docs page. Fixed additively: a new nullable
   `payout_banks.peach_payout_bank_name` column, populated only for the 22 confirmed
   matches; the submission path requires it non-null, layered on top of (not replacing)
   `payout_supported`.

**Create-payout contract (confirmed live):** `POST /merchants/{merchantId}/payouts`, one
payout per request (no batching) — `payoutId` (a genuine v4 UUID, generated and persisted
server-side *before* any HTTP call), `reference` (≤20 chars, alnum+space, built
deterministically from the attempt id, never PII), `currency: "ZAR"`, `amount` (integer
minor units, exact decimal→cents conversion, no floating-point multiplication), `bankName`,
`branchCode`, `accountNumber`, `accountHolder` (2-50 chars, strict pattern, built fresh from
the destination owner's currently-approved `identity_verifications.legal_first_name`/
`legal_surname` — re-checked at execution time, never trusted stale from BANV-submission
time), `payoutMethod: "realtime-eft"`. The create response already carries a real status
(the same 6-value enum the webhook uses) — never treated as mere acknowledgement.

**Lost-create-response handling (confirmed live, introduced 2026-10-01 specifically for
this case):** `GET /merchants/{merchantId}/payouts/status?payoutId={payoutId}` — "a 404
means it is not visible yet; wait and call this again; send create again only if this call
stays 404." A thrown `ProviderTimeoutError`/`RetryableProviderError`/unrecognized error from
the create call is classified **ambiguous**, never automatically resolved: the attempt and
the domain row are left in `processing`, relying on this query (by the identical
`provider_payout_id`, never a new one) for reconciliation. Only an authoritative
`TerminalProviderError` (a genuine 4xx rejection, proof the payout was never accepted) is
safe to mark `failed` immediately.

**Provider-attempt model:** one new table, `payout_provider_attempts`, with a domain-FK
`CHECK` (exactly one of `merchant_payout_id`/`affiliate_commission_id`) rather than a
polymorphic pair, and a real partial unique index enforcing at most one nonterminal attempt
per domain row — the same idiom `payout_destinations_one_current_per_owner_idx` already
established. Each attempt immutably binds the exact `payout_destinations.id` snapshot used
at creation time; a later bank-detail change can never redirect an in-flight payout, and a
retry after confirmed failure re-runs E32 eligibility fresh (so a corrected destination can
be used) rather than reusing the old binding.

**State application:** one shared RPC per domain
(`complete_merchant_payout_provider_attempt` / `complete_affiliate_payout_provider_attempt`)
is called identically from three places — the create-response handler, the payout webhook,
and query reconciliation — so there is exactly one authority for what a Peach status means.
Idempotent on a duplicate terminal result; monotonic on `provider_last_updated_at` (an older
update can never regress a newer one). `payout_status` gained a `reversed` value (merchant
side; `affiliate_commission_status` already had one, Phase 7) — a provider reversal after
`successful` moves the domain row to `reversed` without rewriting its prior `paid` history.

**Manual-flow conflict guard:** `mark_payout_paid`/`mark_payout_failed`/`retry_payout` each
gained one additional check — refuse outright while a live (pending/processing) provider
attempt exists for the payout — so manual admin action can never race live provider
authority. The one deliberate exception to "don't touch unrelated historical functions":
this phase's own brief explicitly required it.

**Webhook & security:** a new dedicated signed route
(`/api/payments/webhooks/peach-payouts`) reuses the same Svix/Standard Webhooks helper E32
built for BANV, and the same provider-neutral `payment_webhook_events` lease RPCs
(`record_webhook_event`/`claim_webhook_event_processing`/`mark_webhook_event_processed`/
`mark_webhook_event_error`) unchanged, under provider value `'peach_payouts'`. Every new
SQL function continues the E32-R1 lesson — `search_path = ''`, `REVOKE ALL FROM public,
anon, authenticated`, `GRANT EXECUTE TO service_role`, no `auth.role()` caller guard. The
new attempt table has RLS enabled with an explicit deny-all policy plus explicit client
revokes (no owner-read policy at all — this is operational financial-execution authority,
server/admin-only).

**Scope boundary:** no production activation. `PAYMENT_PROVIDER` stays absent,
`PEACH_PAYOUTS_EXECUTION_ENABLED` defaults false, no credentials were added anywhere, and no
historical `merchant_payouts`/`affiliate_commissions` row was touched or auto-submitted to
Peach. `refund` capability remains `false` (E31 still binding). Planned next: E34 (payout
destination UX, Peach sandbox certification, and controlled production activation).

## 20. E34 update — payout destination UX, sandbox certification & activation readiness

**Sandbox credentials confirmed absent** (`.env.local` has no `PEACH_*` variables at all,
confirmed by presence-only check this phase) — per this phase's own instruction, this blocks
sandbox *certification* only; it does not block UX or readiness-control work, all of which is
complete.

### Peach docs re-verified live, 2026-11-12

- **Hosts** (`developer.peachpayments.com/docs/payouts-dashboard`, `/docs/payment-links-authentication`): confirmed unchanged from E33 — sandbox auth
  `sandbox-dashboard.peachpayments.com`, sandbox payouts `sandbox-payouts.peachpayments.com`,
  live auth `dashboard.peachpayments.com`, live payouts `payouts.peachpayments.com`. Unity's
  own client (`payouts-config.ts`) already only ever resolves one of these two enum-derived
  pairs — never a raw `PEACH_PAYOUTS_BASE_URL` env var — satisfying §52's own stated
  preference without any change needed.
- **Payouts product activation** (`/docs/peach-payouts`): Dashboard-only, four manual steps
  ("Log in... click Payouts... click Activate Payouts... agree to terms and click
  Activate"). No API. Cannot be verified by code — reported `unknown` unless a new
  `PEACH_PAYOUTS_PRODUCT_ACTIVE` attestation env var is explicitly set.
- **Source of funds**: "Before executing any payouts, you should send Peach Payments a
  source of funds document for compliance reasons" — an operational, human prerequisite,
  same treatment as above (`PEACH_SOURCE_OF_FUNDS_APPROVED`).
- **Webhook configuration** (`/docs/reference-webhooks`): Dashboard-only ("click **Add
  webhook URL**"), no API. **Payout-status and BANV webhooks are separate dashboard
  sections/URLs**, not one shared setting — confirmed directly, correcting any assumption
  that one URL covers both. Cannot be verified by code; reported `unknown`.
- **Available balance**: "The top of the Payouts page shows your available payout balance" —
  Dashboard display only; no balance-query API was found in the current public docs, so E34
  does not implement a balance check (phase brief §41 permits this only "if E33/E34 can query
  balance safely" — it cannot, confirmed).
- **Known limitations** (`/docs/peach-payouts`, quoted): RTC processing limits (R5,000,000
  business-day daytime, R250,000 overnight/weekends/holidays); cannot pay Capitec Live
  Better accounts or GoTyme SME accounts starting "53"; BANV 03:00–23:00 only; float balance
  is held per-country, not fungible across countries; sandbox testing may fail outside South
  African office hours.
- **Sandbox test data** (`/docs/reference-test-and-go-live`, confirmed live, public — not the
  login-walled support article): real documented test accounts exist, recorded here for a
  future phase with credentials to actually exercise:
  - Payout (any amount within float balance, `realtime-eft`): Absa `4047594620`/`632005`;
    Nedbank `1012546144`/`198765`; Discovery Bank (multiple accounts)/`679000`.
  - BANV: Absa `4047594620` → "all match"; Discovery Bank `10503060072` → "partial match";
    GoTyme Bank `51000347387` → "no match".
  - Mobile money: amount a multiple of 100 from 20000 up to sandbox float balance; result
    code `2000.000.000` on success.

### Sandbox certification report (phase brief §67)

```text
PEACH SANDBOX CERTIFICATION

ENVIRONMENT: sandbox
AUTH: NOT TESTABLE — no credentials available
BANV FULL MATCH: NOT TESTABLE
BANV PARTIAL MATCH: NOT TESTABLE
BANV NO MATCH: NOT TESTABLE
BANV WEBHOOK: NOT TESTABLE
BANV QUERY RECONCILIATION: NOT TESTABLE
PAYOUT CREATE: NOT TESTABLE
PAYOUT STATUS: NOT TESTABLE
PAYOUT WEBHOOK: NOT TESTABLE
QUERY BY PAYOUT ID: NOT TESTABLE
DUPLICATE WEBHOOK: NOT TESTABLE
LOST RESPONSE SAFETY: NOT TESTABLE
REAL MONEY MOVED: NO

BLOCKED — SANDBOX CREDENTIALS NOT AVAILABLE
```

No PASS is claimed for anything not actually exercised, per the phase brief's own explicit
instruction. The real, documented test account data above is recorded so a future phase with
credentials does not need to re-research it.

### Webhook config audit / live readiness (phase brief §37/§38)

```text
SANDBOX PAYOUT WEBHOOK: UNKNOWN — no Dashboard access this phase
SANDBOX BANV WEBHOOK: UNKNOWN — no Dashboard access this phase
LIVE PAYOUT WEBHOOK: NOT CHANGED — no credentials, no Dashboard access; endpoint ready: /api/payments/webhooks/peach-payouts
LIVE BANV WEBHOOK: NOT CHANGED — no credentials, no Dashboard access; endpoint ready: /api/payments/webhooks/peach-banv
```

### Production readiness matrix (phase brief §69)

```text
PEACH PAYOUT PRODUCTION READINESS

CODE:
  provider client:         ready
  async states:             ready (6-state ProviderPayoutStatus, E33)
  signed webhook:           ready (Svix/Standard Webhooks, E32/E33)
  query reconciliation:     ready (E33, reused by E34's "check status" UX)
  duplicate protection:     ready (payment_webhook_events lease RPCs, unchanged)
  destination binding:      ready (immutable snapshot, E32/E33)
  lost-response handling:   ready (ambiguous-outcome classification, E33)
  kill switch:              ready (PEACH_PAYOUTS_EXECUTION_ENABLED, E33; see below)
  env-consistency guard:    ready (NEW, E34 -- app env vs Peach env cross-check)

UX:
  merchant bank settings:   ready (/dashboard/payout-settings, linked from merchant dashboard + payouts page)
  affiliate bank settings:  ready (same shared page, linked from affiliate dashboard)
  BANV:                     ready (start/check-status actions, KYC-gated)
  replacement:               ready (explicit confirmation + warning copy)
  masked display:            ready (bank + last4 + status only, never raw account number)

SANDBOX:
  credentials:               absent
  BANV certified:            blocked
  payout certified:          blocked
  webhook certified:         blocked

PEACH ACCOUNT:
  Payouts activated:         unknown
  source-of-funds approved:  unknown
  live credentials:          absent
  live webhook configured:   unknown
  signing secret:            absent

UNITY PRODUCTION:
  PAYMENT_PROVIDER:          absent
  payout execution gate:     absent (defaults false)

REAL-MONEY CANARY APPROVED: NO

PRODUCTION READY: NO
```

Code-ready and UX-ready are both `YES`; production-ready is correctly `NO` (phase brief §70 —
this is a valid, expected outcome, not a failure to resolve).

### Kill switch (phase brief §50)

`PEACH_PAYOUTS_EXECUTION_ENABLED` (env var, exact string `"true"` required) is the kill
switch, unchanged from E33, confirmed independent of `PAYMENT_PROVIDER`. Rollback procedure:
unset it (or set to anything other than `"true"`) and redeploy / let the config change
propagate — both `executeMerchantPayoutProviderAttempt`/`executeAffiliatePayoutProviderAttempt`
check it first, before any DB mutation, so this alone stops all future provider submissions
without a code rollback. In-flight attempts already `pending`/`processing` at the moment the
switch is flipped are NOT auto-cancelled (Peach itself states payouts cannot be recalled once
submitted) — they continue to resolve via webhook/query reconciliation as normal; the switch
only prevents *new* submissions.

### Environment-consistency guard (phase brief §51/§52, new this phase)

`assertPeachEnvironmentConsistency()` (`src/lib/payments/payout-execution/gate.ts`) rejects,
before any DB mutation: a real production app deployment pointed at Peach sandbox (unless
`PEACH_SANDBOX_CERTIFICATION_MODE="true"` is explicitly set, for a deliberate controlled
sandbox run from production), and any non-production app deployment pointed at Peach
production (no exception). Peach hosts themselves remain enum-derived from `PEACH_ENVIRONMENT`
(`'sandbox'|'production'`) only — never a raw base-URL env var — so there is no way to point
at an arbitrary/custom host at all, satisfying §52 directly.

## 21. E35 update — production payout activation audit, rollback & canary procedure

**Fresh verification, 2026-11-12:** sandbox credentials remain completely absent from this
environment (presence-only check of `.env.local` and `.env` — zero `PEACH_*` variables of
any kind). Production environment likewise has zero Peach presence: `PAYMENT_PROVIDER`,
every `PEACH_PAYOUTS_*` credential, every `PEACH_ORCHESTRATION_*` variable, and
`PEACH_PAYOUTS_EXECUTION_ENABLED` are all absent. Remote `main` is still at the E32-R1 commit
— E33/E34 are not published. This phase's own instruction (§10/§11) is explicit: do not
bypass E34's sandbox blocker, and stop before production activation while it stands. Nothing
this phase found changes that conclusion.

**Peach docs re-confirmed live this phase** (`/docs/peach-payouts`): sandbox and live remain
distinct hosts; Payouts maintains a separately-funded, per-country float balance ("Funds
that you deposit for one country are not available for payouts in another country");
sandbox is confirmed a test environment only ("may fail intermittently outside of South
African office hours" — a test-environment characteristic, not a live-money one). No change
from E34's own findings on activation (4 Dashboard-only steps), source-of-funds (required,
no API), or webhook configuration (Dashboard-only, two separate URLs).

### Security & financial safety tests added this phase

E32/E32-R1/E33/E34 already proved nearly every item on this phase's own required test lists
(§71/§72) — gate-off blocks the provider call, sandbox-from-production and
production-from-preview are both rejected, duplicate webhooks are idempotent, no provider
call happens without an eligible/non-stale destination, timeouts never trigger a second
payout, non-terminal provider states never mark anything paid, and the affiliate sweep is
bounded (never unbounded). Three specific gaps this phase's own list named but nothing
before it had a dedicated test for were closed
(`src/lib/payments/payout-execution/__tests__/production-safety.test.ts`, 11 tests):

- **Unknown/custom provider host rejection** — proved that no env var of any name can ever
  change the resolved Payouts/auth host away from the two hardcoded pairs, and that
  `PEACH_ENVIRONMENT` outside `'sandbox'|'production'` throws rather than silently resolving
  to an unrecognized value.
- **Credentials never reach the client** — proved by scanning every `'use client'` file in
  the new payout-destination UI for any Peach credential name, access-token reference, or
  Vault/raw-secret RPC name.
- **No mass/backlog activation path** — proved the merchant provider-execution route only
  ever operates on one `[id]` at a time (no `.in()`/list-based bulk call), the affiliate
  cron sweep stays bounded by `AFFILIATE_SWEEP_BATCH_LIMIT`, and no admin UI source contains
  a "pay all"/"process backlog" action.

### Kill switch — audited, not reinvented (phase brief §27/§31/§33)

Confirmed exactly one execution gate exists: `PEACH_PAYOUTS_EXECUTION_ENABLED`
(`src/lib/payments/payout-execution/gate.ts`, `isPayoutExecutionEnabled()`), checked first,
before any DB mutation, in both `executeMerchantPayoutProviderAttempt()` and
`executeAffiliatePayoutProviderAttempt()`. No second gate was added. Already proven by test
(`execute-payout-provider-attempt.test.ts` #1/#11, `gate.test.ts` #1/#2) that the gate being
off/absent/any-value-other-than-the-exact-string-`"true"` prevents the provider method from
ever being called — this is a config-only control, never a database row, satisfying §33
("emergency payout stop must not require Git revert, database rollback, schema rollback").

### Rollback / emergency-stop procedure (phase brief §32/§34)

1. Set `PEACH_PAYOUTS_EXECUTION_ENABLED` to anything other than the exact string `"true"`
   (or remove it) in the Vercel production environment.
2. Redeploy, or wait for the platform's own config-propagation (Vercel env var changes take
   effect on the next deployment/cold start — confirm via the platform's own documented
   propagation behavior before assuming it is instant).
3. Confirm the execution routes now fail closed: `POST /api/admin/payouts/[id]/execute-provider`
   and the affiliate cron (`GET/POST /api/internal/affiliate/process-payouts`) both return
   503 with zero RPC calls made (proved statically by this phase's and E33's own tests; verify
   the same behavior live against the actual deployed environment before relying on it).
4. Any provider attempt already `pending`/`processing` at the moment the switch is flipped is
   left exactly as-is — Peach's own documentation states a submitted payout cannot be
   recalled, so there is nothing to "cancel" — reconciliation (signed webhook delivery and/or
   admin-triggered query-by-payoutId, `POST /api/admin/payout-provider-attempts/[id]/reconcile`)
   continues to resolve it to its authoritative final state.
5. Do NOT resubmit any attempt whose outcome is uncertain at the time of the stop — the exact
   same lost-response safety E33 already enforces (same `provider_payout_id`, never a new
   one, only after the query endpoint's own 404-means-not-visible-yet guidance is satisfied).
6. Monitor webhook delivery and/or run query reconciliation until every attempt open at stop
   time reaches a terminal state (`successful`/`failed`/`cancelled`/`reversed`).

### Canary selection criteria (not a selected candidate — phase brief §35-39)

A future canary candidate, if and when sandbox certification completes and explicit approval
is sought, must satisfy ALL of:

- An existing, legitimate `merchant_payouts` or `affiliate_commissions` row — never a
  fabricated obligation created merely to exercise Peach.
- `_merchant_payout_full_eligibility_block` (merchant) or the destination-eligibility +
  `payout_queued` status (affiliate) currently passes with zero blockers.
- `_payout_destination_eligibility` reports `eligible: true` for the recipient — current,
  enabled, verified, and not past the 90-day freshness window.
- No open dispute, no pending financial disposition, no `account_restricted` state, no
  active (`pending`/`processing`) provider attempt already on that row.
- Currency is `ZAR` (the only currency this integration supports).
- A small, real amount — never invented; whatever the existing obligation's own amount is.
- The recipient is a real, known identity with currently-approved KYC — never a synthetic or
  anonymized test subject.

No candidate is selected by this phase. Selecting one is a future, separately-approved step,
and even then only after sandbox certification is complete (phase brief §10/§11 — this phase
does not have standing to waive that).

### Production payout readiness matrix (phase brief §68)

```text
UNITY E35 — PRODUCTION PAYOUT READINESS MATRIX

CODE STACK:
  E33 present:            YES (local, commit 04c0d12e1ceda8aa9e3646047dc062bb959a5586)
  E34 present:             YES (local, commit 661218a62cd62b4b4ad79809b4eb16de9e1ec2e9)
  E35 present:             YES (this commit)

REMOTE:
  main contains E33:       NO
  main contains E34:       NO
  main contains E35:       NO

SUPABASE:
  migrations current:      unchanged (20261111184936_add_payout_destination_authority is still the latest LIVE migration; E33/E34/E35 migrations, where they exist, are not yet deployed)
  health:                   not independently re-queried (no live project access in this environment)
  security baseline:        unchanged (no new migration this phase)

VERCEL:
  deployment SHA:           faea09ffe9b56e58633a5b2aceaa733ce0e7f284 (E32-R1) -- unchanged
  READY:                    YES (at that commit; E33/E34/E35 not yet deployed)

SANDBOX:
  credentials:              ABSENT
  BANV certified:           BLOCKED
  payout certified:         BLOCKED
  webhook certified:        BLOCKED
  lost-response certified:  BLOCKED

PEACH LIVE:
  Payouts product active:  UNKNOWN
  source-of-funds:         UNKNOWN
  live credentials:        ABSENT
  webhooks configured:     UNKNOWN
  signing enabled:         ABSENT (no secret present)
  available float:         UNKNOWN (no authenticated access)

UNITY:
  PAYMENT_PROVIDER:                ABSENT
  payout execution gate:            ABSENT (defaults false)
  kill switch tested:                YES (statically, via test -- not yet tested against a live deployment, since nothing is deployed)
  historical auto-sweep disabled:   YES (confirmed: no bulk/backlog code path exists anywhere, proved by test this phase)

CANARY:
  candidate selected:       NONE
  explicit approval:        NO

PRODUCTION READY FOR CANARY: NO

BLOCKERS:
  1. Sandbox credentials absent -- sandbox certification cannot proceed at all (external blocker, unchanged from E34).
  2. E33/E34/E35 are not published to origin/main -- Supabase/Vercel are still on the E32-R1 commit.
  3. Live Peach credentials, Payouts product activation, source-of-funds approval, and live webhook configuration are all unknown/absent -- none can be verified or set by code.
  4. No canary candidate has been selected, and none may be without a completed sandbox certification first.
```
