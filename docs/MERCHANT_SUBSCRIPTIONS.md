# Merchant Subscriptions & Economics (Unity Phase 1)

The first of four planned commercial phases (1. Subscriptions [this], 2. Commission Framework, 3.
Escrow/TradeSafe, 4. Available/Looking For). This phase adds a real, three-tier merchant
subscription model (Starter/Pro/Elite), a central pricing authority every future phase must read
from, an economics calculator, a Starter listing cap, mock provider-neutral billing, and full
admin/merchant surfaces. **No commission is actually charged anywhere by this phase** — that is
Phase 2's job. Phase 1 only establishes the plan model, the listing entitlement, and the pricing
authority Phase 2 will consume.

## Plan model

One authoritative table, `merchant_subscription_plans`, is the single source of every commercial
term. No consumer (dashboard, admin, economics calculator) ever hardcodes a rate.

| Plan | Monthly fee | Sales commission | Rental commission | Barter commission | Active listing cap |
|---|---|---|---|---|---|
| Starter | R0 | 6% | 12% | 0% | 5 |
| Pro | R199 | 5% | 10% | 0% | Unlimited |
| Elite | R499 | 4% | 8% | 0% | Unlimited |

Rates are stored as integer basis points (`sales_commission_bps` etc., 1/100 of a percent) and
fees as integer cents (`monthly_fee_cents`) — no floating-point money anywhere in this schema or
its consumers. Barter commission is hard-enforced at 0 via a CHECK constraint, not just
convention. Stable text identifiers (`starter`/`pro`/`elite`) are the primary key; `display_name`
can change without ever touching a foreign key. `commercial_version` exists so a future rate
change to an existing plan id can be told apart from "same id, same terms the whole time" — Phase
1 ships exactly one version of each plan.

## Subscription lifecycle — explicit states, never null-inferred

`merchant_subscriptions` has **no row at all** for a merchant who has never changed plan — an
absent row *is* Starter, resolved by `getEffectiveMerchantPlan()`
(`src/lib/subscriptions/effective-plan.ts`). A row is created only on a merchant's first real plan
change (upgrade or admin correction). This avoids millions of default rows while keeping "what
plan is this merchant on" a single, well-defined question.

Explicit `status` values (never inferred from null-ness):

- **`active`** — `current_plan_id` is in effect, nothing pending.
- **`pending_change`** — a scheduled upgrade/downgrade will apply at `pending_plan_effective_at`.
- **`cancelled`** — the paid plan was cancelled; will revert to Starter at `pending_plan_effective_at`.

`last_transition_category` records what produced the current state: `upgrade`, `downgrade`,
`cancellation`, `reversion`, `admin_correction`, or `pending_change_cancelled`.

**Upgrades are immediate** and require a successful mock billing charge first (the merchant
already needs to pay for the higher tier before they get its rates). **Downgrades and
cancellations are always scheduled one month out, never immediate** — the merchant already paid
for the current period, so they keep its benefits until the next billing period. A due scheduled
change is applied by `apply_due_merchant_subscription_changes()`, a lazy sweep mirroring the
established `expire_stale_barter_proposals()` pattern: triggered opportunistically from
`GET /api/subscriptions/me` and the admin list/detail routes, plus an explicit
`POST /api/internal/subscriptions/apply-due` for a real scheduler. It is naturally idempotent —
its own `WHERE ... pending_plan_effective_at <= now()` clause finds nothing left to do on a
harmless re-run.

> **Product-policy note — the one-month rule is an MVP assumption, not a permanent financial
> invariant.** The commercial source requires plan changes to be prospective with a clear
> effective date, but does not itself fix the billing-cycle length. "One month" (`interval '1
> month'`, hardcoded in `request_merchant_plan_change()`/`admin_correct_merchant_subscription()`)
> is this phase's own provider-neutral MVP policy choice, made in the absence of a real billing
> provider or contractual billing-cycle terms. It is expected to be revisited once a real
> subscription billing provider and its actual billing-cycle rules are approved — at that point
> `pending_plan_effective_at`'s computation is the one place that would change, not the
> prospective-only/explicit-effective-date architecture itself, which is the actual invariant.

Plan changes are **prospective only** — nothing in this phase ever rewrites a historical
transaction's economics. That is explicitly Phase 2's concern.

## The central pricing authority: `getEffectiveMerchantPlan()`

`src/lib/subscriptions/effective-plan.ts` is the one trusted function that answers "what plan
is/was in effect for this merchant" — Phase 2's commission engine is expected to call this
directly rather than copying plan rates from a UI constant.

Resolution is entirely history-table-driven (`merchant_subscription_history`), which makes it
correct for both "now" and any past `atTime` with **no special-casing**: the most recent history
row whose `effective_at` has already passed tells you the plan that was actually in effect at that
moment — including a scheduled-but-not-yet-swept change, since its history row is written (with a
future `effective_at`) at request time, not at sweep time. No history row at or before `atTime`
means the merchant was implicitly on Starter that whole time.

A SQL-side mirror, `_get_effective_merchant_plan_id()`, exists purely because Postgres can't call
out to the TS implementation — both read the same two tables, so data can never drift, only the
tiny resolution algorithm is duplicated (deliberately kept small for exactly that reason).

## Economics calculator (Step E/F)

`src/lib/subscriptions/economics.ts`: `computeMonthlyPlanCost()` (monthly fee + sales commission +
rental commission, all integer cents, `Math.round()` half-up matching every other financial
calculation in this codebase), `findCheapestPlans()` (returns **every** plan tied at the minimum —
never picks an arbitrary "winner" on a tie), `computeSavingsCents()` (never negative — a tie or a
more expensive candidate both yield 0).

All six cross-plan break-even points are mathematically verified and covered by
`src/lib/subscriptions/__tests__/economics.test.ts`:

| Comparison | Sales break-even | Rental break-even |
|---|---|---|
| Starter vs Pro | R19,900 | R9,950 |
| Starter vs Elite | R24,950 | R12,475 |
| Pro vs Elite | R30,000 (documented tie case) | R15,000 |

`src/lib/subscriptions/monthly-volume.ts` (`getCurrentMonthMerchantVolume()`) is deliberately
**read-only and additive** — it computes current-calendar-month (UTC) volume from real completed
transactions only (delivered orders minus shipping fee; captured `rental_charge` payments for
completed bookings) and never touches existing sale/rental/payout/commission logic. Explicitly
excludes: failed/cancelled transactions, refundable deposits (a different `payment_type`,
structurally excluded), delivery charges, damage reimbursements, provider fees, escrow fees,
affiliate payouts, and barter value (barter is commission-free on every plan, so it never
contributes volume here).

## Entitlements: the Starter listing cap

`active_listing_limit` lives on `merchant_subscription_plans` itself (5 for Starter, `null` =
unlimited for Pro/Elite) rather than hardcoded in the RPC, keeping the cap inside the one
authoritative plan model. Enforced at the single real activation gate, `activate_listing()`
(`20260822000004_merchant_subscription_listing_cap.sql`) — covers both first-time moderation
approval and re-activating a suspended listing; nothing else ever flips a listing to `'active'`.

- **Blocks NEW activation only** — never touches an already-active listing. An existing
  over-the-cap merchant is grandfathered automatically by construction: their existing rows are
  simply never revisited by this check.
- **Test/QA fixture listings (`is_test = true`) are excluded entirely** — both as something the
  cap counts against and as something it's ever enforced on. Regression scripts routinely exceed
  5 listings per QA merchant (confirmed live: up to 85) and must keep working unmodified.
- `src/lib/subscriptions/entitlements.ts` (`getListingEntitlementUsage()`) is the TS-side mirror
  used purely for **display** ("X/5 listings used", a disabled "List an item" affordance) — it is
  never itself an enforcement point. The RPC is the only real gate.

## Mock billing provider

`src/lib/subscriptions/billing/{provider,mock-provider,registry,service,test-scenario}.ts` — a
small, dedicated, provider-neutral interface, deliberately **separate** from
`src/lib/payments/provider.ts` (that interface models a booking/order/barter transaction's
intent→authorize→capture→refund lifecycle; a subscription upgrade is one immediate "charge this
plan's monthly fee" event with no deposit/refund concept). `"provider"` stays the generic label
`'mock'` in every persisted record — no real vendor name (Stripe/PayFast/Peach/TradeSafe) appears
anywhere in this module. `MockSubscriptionBillingProvider` is deterministic by explicit
`mockScenario` (`'success'` | `'declined'`), never random, gated the same double way
(`isSubscriptionMockScenarioSelectionAllowed()`) as the existing checkout mock-scenario gate:
mock provider **and** non-production environment, both required.

`attemptSubscriptionBilling()` (`billing/service.ts`) is the one call site every upgrade route
uses — it records one audit row per attempt in `merchant_subscription_billing_attempts` (append-only,
immutable) and, given an `idempotencyKey`, replays a prior attempt's own result instead of
charging a second time. **The upgrade route never accepts a client-supplied billing reference** —
accepting one would let a merchant forge "I already paid." The billing charge always happens
server-side, before `request_merchant_plan_change()` is ever called.

## RPCs

All `SECURITY DEFINER`, service-role-only (`auth.role() <> 'service_role'` hard-blocked),
idempotency-keyed via the standard `idempotency_keys` table, actor id always an explicit parameter
— never `auth.uid()`.

- **`request_merchant_plan_change(merchant_id, target_plan_id, billing_reference?, idempotency_key?)`**
  — merchant-initiated. Upgrade (target rank higher): immediate, requires a `billing_reference`.
  Downgrade/cancellation (target rank lower, including target = starter): always scheduled one
  month out. Requesting the plan already active is rejected outright (directs the caller to
  `cancel_pending_merchant_plan_change` instead of scheduling a redundant no-op change).
- **`cancel_pending_merchant_plan_change(merchant_id, idempotency_key?)`** — reverts a scheduled
  downgrade/cancellation, staying active on the current plan. Requires a genuine pending change.
- **`apply_due_merchant_subscription_changes()`** — the lazy sweep (no args, system-wide). Writes
  a second, system-actor history row (the first, at request time, already recorded the merchant's
  original request) and returns the list of merchants actually changed, so callers can dispatch
  notifications.
- **`admin_correct_merchant_subscription(admin_id, merchant_id, new_plan_id, immediate, reason, idempotency_key?)`**
  — a narrow, reason-required override. Never charges the merchant, never rewrites history —
  appends a new `admin_correction` history row. Unlike the merchant-initiated RPC, it never
  rejects a same-plan target (used by the regression script to force a known baseline).

## Routes

Merchant-facing: `GET /api/subscriptions/me`, `GET /api/subscriptions/plans`,
`POST /api/subscriptions/{upgrade,downgrade,cancel,cancel-pending-change}`. Admin:
`GET /api/admin/subscriptions` (+ `?format=csv`), `GET /api/admin/subscriptions/[merchantId]`,
`POST /api/admin/subscriptions/[merchantId]/correct`. Internal:
`POST /api/internal/subscriptions/apply-due` (`INTERNAL_CRON_SECRET`-gated, mirrors every other
`/api/internal/*` route in this codebase; manual `curl` invocation documented until a real
scheduler is wired).

## Admin service, exceptions, overview

`src/lib/admin/subscriptions-service.ts` mirrors `orders-service.ts`'s exact shape (one base query
+ `Promise.all` of related rows + in-memory joins). `listAdminSubscriptions()` lists
`merchant_subscriptions` rows only (merchants who have ever left the implicit Starter default);
`getAdminSubscriptionDetail()` resolves **any** merchant id, including one with no row at all
(implicit Starter), since an admin needs to be able to look up and correct a Starter-by-default
merchant too. Two new exception categories in `exceptions-service.ts`:
`merchant_subscription_pending_change_overdue` (a scheduled change 48h+ past due and still
unapplied — the lazy sweep may not be running for that merchant) and
`merchant_subscription_repeated_billing_failures` (3+ failed billing attempts with zero successes
in 48h). `get_admin_overview_stats()` gains 5 new keys via the established append-only
`CREATE OR REPLACE` pattern.

## UI

Public `/pricing` (plan comparison, highlights the visitor's current plan if signed in as a
merchant, no actions — actions live on the dashboard). Merchant
`/dashboard/merchant/subscription` (current plan, listing usage, this month's real economics,
plan comparison grid with upgrade/downgrade buttons, pending-change cancellation). The dead
`/pricing`-linking "Upgrade Plan" quick-link card on the merchant dashboard now links to the real
subscription page and shows the merchant's actual plan/cap instead of a hardcoded "Starter · Up to
5 listings" string. Admin `/admin/subscriptions` (list) + `/admin/subscriptions/[merchantId]`
(detail, plan history, billing attempts, the one narrow "Correct plan" action) + a new nav entry
and overview section.

## Emails

7 new catalogue entries, all merchant-only (no merchant/renter asymmetry to split, unlike
booking-domain emails): `merchant-subscription-upgraded`, `-downgrade-scheduled`,
`-cancellation-scheduled`, `-pending-change-cancelled`, `-reverted` (sweep-applied cancellation),
`-downgrade-applied` (sweep-applied downgrade), `-admin-corrected`.
`email_deliveries.related_entity_type` and `src/lib/email/service.ts`'s `RelatedEntityType` union
both gained `'merchant_subscription'`. Every dispatch call uses a deterministic, caller-derived
`occurrenceKey` (the RPC's own returned effective timestamp, never a self-generated one) so an
exact route retry can never double-send.

## Security

Zero client write policies on `merchant_subscriptions`/`merchant_subscription_history`/
`merchant_subscription_billing_attempts` — every mutation is RPC-mediated. RLS: a merchant reads
only their own subscription/history/billing-attempt rows; an admin reads all. Every RPC hard-blocks
non-service-role callers. The upgrade route never trusts a client-supplied billing reference. Zod
schemas validate every request body server-side (`src/lib/subscriptions/validation.ts`); the
`mockScenario` field is only ever honoured behind the double gate
(`isSubscriptionMockScenarioSelectionAllowed()`). `mapSubscriptionRpcError()` never forwards a raw
Postgres message to the client.

## Known limitations (stated up front)

No real billing provider — mock-only, matching every other financial domain in this codebase at
this stage. No commission is charged anywhere by this phase (Phase 2's job). No transaction-level
commission snapshot/history exists yet. `active_listing_limit` is the only entitlement enforced;
no other Pro/Elite "feature" claims (ranking, homepage/newsletter promotion, etc.) are built or
implied — this phase deliberately does not invent capabilities Unity doesn't actually provide.

## Tests

Unit tests: `src/lib/subscriptions/__tests__/{economics,plans,rpc-errors,idempotency,validation}.test.ts`,
`src/lib/subscriptions/billing/__tests__/{mock-provider,test-scenario}.test.ts`. Live validation:
`scripts/verify-subscriptions-phase1.mjs` (mirrors `verify-order-administration.mjs`'s /
`verify-merchant-payout-workflow.mjs`'s exact safety-gated shape) — plan catalogue correctness,
the full upgrade/downgrade/cancel/cancel-pending lifecycle, idempotent replay and idempotency-key
conflict, the apply-due sweep (including a direct-service-role backdate, since no route can move
calendar time backward), admin correction, forged admin access, direct RLS/RPC bypass attempts,
the Starter listing cap (blocked at 5, unblocked immediately after upgrading), email dispatch, and
full fixture cleanup so the script is safely re-runnable.

## Explicitly deferred to later phases (per the Phase 1 brief)

No R100,000 high-value marginal sales commission, no refund/cancellation commission handling, no
transaction commission snapshot system, no commission history/settlement (all Commission Framework
— Phase 2). No TradeSafe/escrow. No Available/Looking For. No SEO indexing changes. No Services.
