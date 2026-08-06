# Essential Transactional Emails (Step 8)

A provider-neutral email layer wired to the critical lifecycle events across listings, KYC
and bookings. Booking, listing, verification and payment routes never import a concrete email
provider — every route calls `sendTemplate()` from `src/lib/email`, exactly the same pattern
already established for payments (`src/lib/payments/registry.ts`), ownership verification and
identity verification in earlier steps.

## What already existed (audit findings)

Before this step, the only email-shaped code in the codebase was Supabase Auth's own managed
emails (confirmation, password reset, password changed) — configured entirely inside the
Supabase dashboard, no application code involved. There were no email stubs, no fake
"notification" console logs, no TODOs referencing email, and no direct provider calls anywhere
in booking/listing/verification/payment routes. This step does not touch or duplicate any
Supabase Auth email.

## Provider abstraction

```
Notification domain → sendTemplate() (src/lib/email/service.ts)
                     → EmailProvider (src/lib/email/provider.ts)
                     → ConsoleEmailProvider   (local dev, default)
                     → ResendEmailProvider    (server-only, real API — never exercised live this step)
```

`getEmailProvider(name?)` (`src/lib/email/registry.ts`) resolves via explicit param →
`EMAIL_PROVIDER` env var → default `'console'`, throwing on an unknown name — the same
resolution order as every other provider registry in this codebase.

`EmailProvider` interface:

```ts
interface EmailProvider {
  readonly name: string
  sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult>
  healthCheck(): Promise<HealthCheckResult>
}
```

A provider throws on failure rather than returning a "failed" result — the thrown error's
*type* carries the classification (`src/lib/email/errors.ts`, mirroring
`src/lib/payments/provider-errors.ts`):

| Error class | Meaning | Auto-retried? |
|---|---|---|
| `EmailConfigurationError` | provider misconfigured (bad/missing credentials) | no — needs a human fix |
| `InvalidRecipientError` | recipient address rejected by the provider | no — needs a human fix |
| `EmailTimeoutError` | request exceeded the provider timeout | yes |
| `RetryableEmailError` | transient provider-side failure | yes |
| `RateLimitedEmailError` | provider rate limit hit | yes |
| `TerminalEmailError` | provider rejected the message outright | no |

### ConsoleEmailProvider (local dev, default)

Logs a redacted summary — `to`, `from`, `subject`, a deterministic `messageId`
(`console_<md5 prefix>`), and a 120-character `textPreview` — and **never** logs the full HTML
body or a raw error object. Two deterministic failure fixtures, keyed off the recipient
address, exist purely for testing the failure/retry path: any recipient containing
`+fail-retryable` throws `RetryableEmailError`; `+fail-terminal` throws `TerminalEmailError`.
Every other address succeeds.

### ResendEmailProvider (server-only, implemented but unexercised)

Built fully against Resend's documented REST contract (`POST https://api.resend.com/emails`,
`Authorization: Bearer <RESEND_API_KEY>`, 10-second `AbortController` timeout, HTTP status →
error class mapping: 429 → rate-limited, 401/403 → configuration, 400/422 → invalid recipient,
5xx → retryable, anything else non-2xx → terminal). `RESEND_API_KEY` is read from
`process.env` only inside the send method — never accepted as a constructor argument, so it
can never end up in a browser bundle.

**This provider was never exercised against the live Resend API in this environment** — no
`RESEND_API_KEY` was configured anywhere in `.env.local` (confirmed by audit), and none was
added. `EMAIL_PROVIDER` stays at its default, `console`, everywhere this repository currently
runs. This was a deliberate choice: exercising Resend would have required a real sending
domain, which is exactly Step 8's own stop condition ("Resend requires production DNS/domain
changes").

## Event catalogue

Events are dot-namespaced and stable — never a subject line, never derived from a template id.

| Domain | Events |
|---|---|
| Listing | `listing.submitted`, `listing.changes_requested`, `listing.ownership_approved`, `listing.ownership_rejected`, `listing.moderation_approved`, `listing.moderation_rejected`, `listing.activated`, `listing.suspended` |
| Identity verification | `verification.submitted`, `verification.additional_information_requested`, `verification.approved`, `verification.rejected` |
| Bookings | `booking.requested`, `booking.rejected`, `booking.cancelled`, `booking.expired_unanswered`, `booking.payment_required`, `booking.payment_reminder`, `booking.payment_expired`, `booking.financially_ready`, `booking.started`, `booking.return_initiated`, `booking.completed` |
| Payment / test mode | `payment.declined`, `payment.retryable_failure`, `deposit.failed` |
| Disputes (Step 11 Phase 2) | `dispute.opened`, `dispute.evidence_requested`, `dispute.evidence_received`, `dispute.under_review`, `dispute.resolved`, `dispute.closed`, `dispute.cancelled` — generic across bookings/orders/barter, see `docs/DISPUTE_SYSTEM.md` |
| Messaging (Step 11 Phase 3) | `message.new` — one generic event across bookings/orders/barter, gated by a two-tier debounce (presence heartbeat, then a 10-minute last-sent-message fallback) so an active conversation doesn't spam inboxes; see `docs/REAL_CHAT.md` |
| Barter execution (Step 11 Phase 4) | `barter.accepted`, `barter.deposit_required`, `barter.ready_to_exchange`, `barter.completion_requested`, `barter.completed`, `barter.cancelled` — no separate `barter.disputed` event, since Phase 2's `dispute.opened` already fires for any transaction type including barter; see `docs/BARTER_EXECUTION.md` |
| Orders (Step 11 Phase 6) | `order.created`, `order.payment_received`, `order.shipped`, `order.delivered`, `order.cancelled`, `order.payment_failed` — no separate `order.payment_required` (creation and "payment required" are the same moment for a purchase), no separate retryable/terminal payment-failure split (not durably stored for orders), no separate `order.dispute_opened`/`order.dispute_resolved` (Phase 2's generic dispute emails already cover orders); see `docs/ORDER_ADMINISTRATION.md` |
| Affiliates (Step 11 Phase 7) | `affiliate.enrolled`, `affiliate.commission_approved`, `affiliate.commission_held`, `affiliate.payout_queued`, `affiliate.commission_paid`, `affiliate.payout_failed`, `affiliate.commission_voided`, `affiliate.adjustment_created`, `merchant.affiliate_enabled`, `merchant.affiliate_disabled` — no separate `affiliate.commission_pending` (too early/noisy, the dashboard already reflects it live), no `affiliate.listing_link_ready` (redundant with the dashboard), no `merchant.affiliate_commission_created` (would fire once per sale for an active merchant, excessive); see `docs/AFFILIATE_SYSTEM.md` |

Two consolidation decisions were made explicitly to avoid the overlapping-email pattern the
brief warned against:

- **No separate `booking.accepted` email.** `booking-payment-required-renter` (fired from the
  accept route) already says "your booking was accepted — pay by \<deadline\>", so a second,
  earlier "accepted" email would be redundant. `booking.accepted` was defined once during
  design, then deliberately removed from the catalogue.
- **No separate `booking.returned` email.** `confirm_return()` transitions
  `return_pending → returned → completed` in a single RPC call, so only the consolidated
  `booking.completed` (sent to both parties) fires — `booking.return_initiated` (sent to the
  *other* party when a return is first opened) is the only return-related email before
  completion.

`verification.submitted` is fired with an `occurrenceKey` of `'submit'` on first submission and
`'resubmit'` on resubmission from the same route pair — same event, distinguishable delivery
records, no separate event name needed.

## Template catalogue

67 templates (`src/lib/email/templates/catalogue.ts`, 10 added in Step 11 Phase 6 for orders — see `docs/ORDER_ADMINISTRATION.md` — and 10 more added in Step 11 Phase 7 for affiliates — see `docs/AFFILIATE_SYSTEM.md`), all composing through one shared shell
(`renderShell()` in `src/lib/email/templates/shared.ts`) rather than 32 hand-authored HTML
files. Each entry is:

```ts
interface EmailTemplateDef {
  id: string                 // stable, e.g. 'booking-payment-required-renter'
  version: number
  event: string               // the normalized event this template maps to
  requiredVars: string[]
  subject: (vars) => string
  build: (vars) => ShellInput
}
```

`renderTemplate(templateId, vars)` validates every `requiredVars` entry is present
(non-undefined/null/empty-string) and throws `TemplateValidationError` — a listing- or
booking-shaped template can never silently render with blanks — before returning `{ html,
text }`. Every template has both.

The shared shell provides: Unity header, greeting, primary CTA (an application route, never a
private Storage URL), an optional transaction summary table, support contact, legal footer
(Terms / Privacy / Contact links), and a test-mode notice block. Unity's existing brand palette
(`#8B1A1A` red, `#1A0A0A` text, `#9B8B85` muted, `#F2EDE8` border) is reused, matching the
website. All interpolated values pass through `escapeHtml()`.

**Test-mode financial emails** (payment/deposit templates) include, verbatim, exactly the
sentence the brief specified: *"Unity is currently operating in test mode. No real payment,
deposit or payout was processed."* No email claims escrow, guaranteed payment, Sumsub
verification, Peach protection, insurance, or government verification.

## Transactional vs. optional

Every email this step sends is transactional — account/contract-critical (moderation and KYC
decisions, booking accept/reject/cancel/expiry, payment required/declined/expired,
deposit failure) or a single bounded reminder. None require or offer an unsubscribe link (not
appropriate for strictly transactional messages); all include support contact details. No
marketing-consent mechanism was built — out of scope for this step by explicit instruction.

## Database: `email_deliveries`

New table, migration `20260807000001_transactional_emails.sql`. Unlike Step 7's
`legal_acceptances` (append-only, immutable), this table is **mutable** — status genuinely
transitions `pending → sent / failed_retryable / failed_terminal`, and a retry updates the same
row (`attempts` incremented) rather than inserting a new one. This mirrors the `payments`
table's mutable-with-RLS-lockdown precedent, not the Step 7 audit-log pattern.

Columns: `event_type`, `recipient_user_id`, `recipient_email`, `template_id`,
`template_version`, `related_entity_type` (`booking | listing | identity_verification`),
`related_entity_id`, `provider`, `provider_message_id`, `status`, `idempotency_key` (unique),
`template_vars jsonb`, `attempts`, `last_error`, `sent_at`, `failed_at`, `created_at`,
`updated_at`.

`template_vars` stores the exact (safe) vars object passed to `sendTemplate()` — booking
reference, listing title, dates, amounts, display names. It never stores ID/passport numbers,
addresses, ownership-document references, or payment references — those never reach the email
layer at all (confirmed by a text-scan test over the template catalogue). This lets
`retryDelivery()` re-render from stored vars without re-deriving context from the (possibly
since-changed) related entity.

RLS: `"email_deliveries: own read"` only — no client write policy of any kind; every write goes
through the service-role client from a trusted server route.

## Dispatch architecture

Pattern **A** — explicit post-transaction dispatch — not an outbox. Every route that reaches
one of the 32 events calls `sendTemplate()` directly after its RPC/business transaction
succeeds, wrapped in try/catch so an email failure can never block or roll back the business
action. This was chosen over a transactional outbox because every event already has exactly one
natural trigger point (an existing trusted server route), and the brief explicitly asked not to
build a complex event bus. The one exception — payment deadline reminders, which have no user
action to hook a dispatch call onto — uses a periodic **sweep** (`sendDuePaymentReminders()`),
mirroring Step 6's `expire_unpaid_accepted_bookings()` lazy-sweep pattern exactly, not a second
architecture.

`sendTemplate(admin, req)` (`src/lib/email/service.ts`) never throws. It: resolves the template
version → computes the idempotency key → resolves the recipient's email → atomically
inserts-or-detects-a-duplicate → renders the template → calls the configured provider → updates
the delivery row to `sent` or a failure status → returns a normalized result. Every step that
can fail is caught and turned into a durable `email_deliveries` row instead of a thrown error.

Browser input never reaches `sendTemplate()`'s trust boundary: `recipientUserId`,
`recipientEmail`, `eventType`, `templateId`, `relatedEntityId` and provider name are always
constructed server-side from already-authenticated/ownership-checked context (`ctx.merchantId`,
`requester.userId`, a route param that was already validated) — confirmed both by a text-scan
security test and by a live forged-recipient attempt (see Live validation → Scenario F below).

## Idempotency

`computeEmailIdempotencyKey(eventType, relatedEntityId, recipientUserId, templateVersion,
occurrenceKey = '')` = `md5(eventType|entityId|recipientUserId|templateVersion|occurrenceKey)`.

Enforced with a real Postgres `unique(idempotency_key)` constraint — not an
application-level check-then-insert. `sendTemplate()` attempts the insert and catches Postgres
error `23505` (unique violation) to detect a duplicate atomically, so it is race-safe under
concurrent calls, not just safe under sequential retries. Reminder emails use their own
`occurrenceKey: 'reminder'`, distinct from any one-shot event, so a reminder never collides with
(or substitutes for) the original notification.

## Failure and retry policy

An email failure never rolls back a business transaction — booking acceptance, moderation
approval, payment capture, etc. all succeed even if the email that follows fails. The failure
is recorded (`status: failed_retryable` or `failed_terminal`, `attempts` incremented,
`last_error` set to the error's *name only* — never the raw message or a raw provider error
object) and left safely retriable.

`retryDelivery(admin, deliveryId)` only proceeds if the current status is `failed_retryable`;
it re-renders from the stored `template_vars`, re-resolves the recipient email if it was null,
and updates the *same row* (never inserts a new one). `retryAllFailedDeliveries(admin)` sweeps
every `failed_retryable` row, oldest first.

## Payment deadline reminders

One reminder per booking, at `PAYMENT_REMINDER_HOURS_BEFORE_DUE` (default `6`) hours before
`payment_due_at`, via `sendDuePaymentReminders()` querying `bookings` where
`status = 'accepted' and payment_due_at` falls inside that window. Naturally idempotent — a
booking that already has a `reminder`-occurrence delivery row for the current template version
is skipped by the same unique-constraint mechanism as every other event, so no separate
"already reminded" flag or column exists. `POST /api/internal/email/send-payment-reminders`
exposes this behind the same secret-authenticated internal-route pattern Step 6 established for
`POST /api/internal/expire-unpaid-bookings`.

## Preview tooling

`GET /admin/email-previews` — a server component, gated entirely by the parent `/admin/*`
layout's `requireAdmin()` (no separate auth check needed). Renders every catalogue entry via
`renderTemplate(def.id, SYNTHETIC_VARS)` inside a sandboxed `<iframe srcDoc sandbox="">`.
`SYNTHETIC_VARS` uses obviously-fake names (`"Jane Merchant (example)"`) — no real user or
booking data is ever read by this page, confirmed by a text-scan test asserting the page
contains neither `sendTemplate` nor a `fetch(` call.

## Live validation

Run against the development Supabase project with `EMAIL_PROVIDER=console` (no `RESEND_API_KEY`
configured in this environment). QA accounts: `phase2a-renter-c@unitytest.co.za` (renter),
`phase2a-merchant-a@unitytest.co.za` (merchant), plus a freshly created
`step8-qa-admin@unitytest.co.za` (admin — created for this step, since no admin QA credential
from earlier steps was recoverable) and a disposable
`step8-qa-renter+fail-retryable@unitytest.co.za` (renter, used only to trigger the console
provider's retryable-failure fixture for Scenario E).

**Scenario A — listing.** On a real pending listing: `request-changes` → renter-safe
`listing.changes_requested` email confirmed (only the merchant-facing feedback text appeared,
no internal notes) → `ownership/approve` → `listing.ownership_approved` → `moderation/approve`
→ `listing.moderation_approved` → `activate` → `listing.activated`, listing reached `active` →
`suspend` → `listing.suspended`. A `moderation/reject` was also run against a second listing to
exercise `listing.moderation_rejected`. All 6 distinct events recorded exactly once each,
status `sent`.

**Scenario B — KYC.** Reset an existing verification to `under_review` → admin
`request-information` → `verification.additional_information_requested` sent → reset to
`under_review` → `approve` → `verification.approved` sent. A second user was rejected to
exercise `verification.rejected`. (`verification.submitted`'s two occurrence keys were not
independently re-exercised live in this pass — see Known limitations — but are covered by a
text-scan event-wiring test asserting both routes fire the event with distinct
`occurrenceKey`s.)

**Scenario C — booking/payment.** Renter requests a booking → both `booking.requested` emails
sent → merchant accepts → `booking.payment_required` sent with the correct deadline → mock
checkout succeeds → both `booking.financially_ready` emails sent → replaying the same checkout
call (already-financially-ready) was correctly rejected before reaching the email layer at all,
and a direct row-count check confirmed no 6th delivery row was created.

**Scenario D — unpaid expiry.** An accepted booking's `payment_due_at` was moved into the
reminder window → `POST /api/internal/email/send-payment-reminders` sent exactly one reminder
(`considered_count: 1, sent_count: 1`) → an immediate second call correctly reported
`skipped_duplicate_count: 1`, no new email. `payment_due_at` was then moved into the past →
`POST /api/internal/expire-unpaid-bookings` expired the booking and sent both
`booking.payment_expired` emails (`expired_count: 1`) → an immediate second call correctly
reported `expired_count: 0`. Final row count for the booking: 6 rows total (2×requested, 1×
payment_required, 1×reminder, 2×payment_expired), each `sent` exactly once.

**Scenario E — failure and retry.** A disposable renter account with `+fail-retryable` in its
real address was approved for KYC by an admin; the resulting `verification.approved` delivery
was correctly marked `failed_retryable` with `last_error: "RetryableEmailError"` (no raw
message), while **the KYC approval itself succeeded** (`status: 200, "status":"approved"`) —
confirming business success is never hidden behind an email-provider error. The delivery row's
`recipient_email` was then corrected (simulating the transient condition clearing) and
`POST /api/internal/email/retry-failed` was called: `sent_count: 1`. A final check confirmed
exactly **one** row for that event, `status: sent`, `attempts: 2` — the retry updated the same
row rather than creating a second one.

**Scenario F — security.**
- *Forged recipient / arbitrary template*: a real booking-request call had
  `recipient_email: "attacker@evil.com"`, a bogus `recipientUserId`, an unrelated `templateId`,
  and an unrelated `eventType` injected into the request body. The booking succeeded normally
  (schema-validated fields only) and the resulting delivery rows show the real,
  server-derived recipients (`phase2a-merchant-a@unitytest.co.za` /
  `phase2a-renter-c@unitytest.co.za`) and the real templates — none of the injected fields had
  any effect.
- *Wrong cron secret*: both internal email routes and the expiry route returned `401
  {"error":"Unauthorized"}` for a wrong bearer token and for a missing `Authorization` header
  entirely.
- *Public preview access*: an unauthenticated `GET /admin/email-previews` returned `307`,
  redirecting to `/login?redirectTo=%2Fadmin%2Femail-previews` — never rendered.
- *Sensitive data in logs*: grepped the dev server log for the synthetic ID reference number
  and residential address used in this session's KYC test fixtures — zero matches. The console
  provider's log lines contain only `to`/`from`/`subject`/`messageId`/`textPreview`, confirmed
  by 15 occurrences of `textPreview` and zero occurrences of a raw `html:` log key.
- *Duplicate event replay*: covered by Scenarios C, D and E above (checkout replay, reminder
  replay, expiry-sweep replay) — every replay produced zero additional delivery rows.

## Files changed

New: `supabase/migrations/20260807000001_transactional_emails.sql`;
`src/lib/email/{provider,errors,registry,idempotency,resolve-recipient,service,context,
dispatch-expiry,reminders,index}.ts`; `src/lib/email/providers/{console-provider,
resend-provider}.ts`; `src/lib/email/templates/{shared,catalogue}.ts`;
`src/lib/email/__tests__/{templates,test-helpers,service,architecture,security,
event-wiring}.test.ts`; `src/app/api/internal/email/{send-payment-reminders,retry-failed}
/route.ts`; `src/app/admin/email-previews/page.tsx`.

Modified: `src/app/admin/admin-shell.tsx` (nav entry); the 7 listing moderation/ownership admin
routes; the 3 identity-verification admin decision routes; `src/app/api/verification/
{submit,resubmit}/route.ts`; `src/app/api/bookings/route.ts` and its
`[id]/{accept,reject,cancel,start,return,confirm-return,checkout}/route.ts`;
`src/lib/bookings/lazy-expiry.ts` (return type changed, see Known limitations);
`src/app/api/internal/expire-unpaid-bookings/route.ts`; `.env.example`;
`src/lib/bookings/__tests__/lazy-expiry.test.ts` (2 assertions updated for the new return type).

## Migrations

One: `20260807000001_transactional_emails.sql` — `email_delivery_status` enum,
`email_deliveries` table with its unique idempotency constraint and indexes, a
`touch_email_delivery_updated_at()` trigger, RLS (own-read only), and an updated
`expire_unpaid_accepted_bookings()` that now returns the exact ids of the bookings it just
expired (`expired_booking_ids`) so the email layer can dispatch without a second query.

## Build health

`npx tsc --noEmit` — clean. `npx vitest run` — 546/546 passing (56 new this step). `npm run
build` — compiled successfully, including `/admin/email-previews` and both new internal
routes. `npx eslint` over every file touched this step — 0 errors, 0 warnings (two trivial
warnings found on first pass were fixed, not suppressed).

## Known limitations

- **A genuine bug was found and fixed during this step's own live validation**:
  `resolveUserEmail()` originally called `admin.auth.admin.getUserById(userId)` with no
  timeout. During Scenario C, a real checkout request hung for **15.8 minutes** server-side
  (confirmed by Next.js's own request-duration log) purely because of this unbounded call —
  even though the console provider itself makes zero network calls. Fixed by wrapping the
  lookup in an 8-second `Promise.race` timeout, returning `null` (already handled safely
  downstream as "missing email") on timeout. Re-verified live: an identical flow afterward
  completed in 9 seconds. Any future change to this function must preserve the timeout — an
  unbounded external-API call inside an email dispatch path can otherwise stall the *business*
  route that triggered it, not just the email.
- `verification.submitted` (both `'submit'` and `'resubmit'` occurrence keys) requires a real
  document upload through Supabase Storage to exercise end-to-end through the actual submit
  route; this pass validated its event wiring via a text-scan test rather than a live document
  upload, to stay inside a reasonable live-validation scope. The admin-decision emails that
  follow submission (`request-information`, `approve`, `reject`) were all validated live.
- No admin QA credential survived from earlier steps in a form that could be safely recovered
  (no known password, and resetting an existing account's credentials was intentionally not
  attempted). A new, clearly-named `step8-qa-admin@unitytest.co.za` test account was created
  instead for this step's live validation.
- `triggerLazyExpirySweep()`'s return type changed from `Promise<void>` to
  `Promise<LazyExpirySweepResult | null>` this step (to surface `expired_booking_ids` for email
  dispatch). Every existing call site still just `await`s it and ignores the return value,
  which TypeScript allows — only the two tests asserting the old `undefined` return needed
  updating.
- Buying & selling emails, push, SMS, WhatsApp, marketing/newsletter emails, a full preference
  centre, and email receipt parsing remain explicitly out of scope, per the brief.

## Switching providers later

Set `EMAIL_PROVIDER=resend`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO`, and `RESEND_API_KEY` in
the environment — no application code changes anywhere outside `src/lib/email`. A future third
provider only needs to implement `EmailProvider` and be registered in
`src/lib/email/registry.ts`'s `providers` map.

## Step 8 status

Complete. All 33 required tests pass (56 new tests total, including template/dispatch/
event-wiring/security/architecture categories), build is clean, all six live-validation
scenarios (A–F) were run against the development Supabase project and documented above, and one
real bug (the unbounded-timeout hang) was found and fixed during that live validation.

No blockers before Step 9. Per the brief, **Step 9 is not started** — this step ends here,
pending review and approval.

### Recommended commit grouping

1. Migration (`20260807000001_transactional_emails.sql`) alone.
2. Provider abstraction + error classification + registry + console/resend providers
   (`src/lib/email/{provider,errors,registry}.ts`, `src/lib/email/providers/*`).
3. Template system (`src/lib/email/templates/*`) + idempotency + service layer + context
   loaders + reminders/expiry dispatch (`src/lib/email/{idempotency,resolve-recipient,service,
   context,dispatch-expiry,reminders,index}.ts`).
4. Route wiring — listing admin routes, verification admin + user routes, booking routes,
   `lazy-expiry.ts` + its internal route.
5. Internal cron routes + admin preview page (`src/app/api/internal/email/*`,
   `src/app/admin/email-previews`, `admin-shell.tsx` nav entry).
6. Tests (all 6 new test files + the 2 updated `lazy-expiry.test.ts` assertions).
7. Docs + `.env.example` (this file).
