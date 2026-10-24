# Wave 0 Controlled Pilot — Operations Runbook

Operator-facing document for the Wave 0 controlled pilot. This file is documentation only — it does not change, gate, or enforce anything in the application. All numeric thresholds below are **operational recommendations** agreed for Wave 0, not values enforced by code, except where explicitly noted as code-enforced.

## ADMIN ANALYTICS — DO NOT USE FOR PILOT REPORTING

The figures shown on `/admin/analytics` are mock/demo data (`src/lib/mock/admin-data.ts`), not real platform data.

They must not be used for:
- operational decisions
- pilot KPI reporting
- investor reporting
- merchant reporting
- financial reporting
- compliance reporting
- any external reporting

Wave 0 reporting must come only from verified production records and the Wave 0 manual KPI tracker / exceptions tracker (`docs/WAVE0_EXCEPTIONS_TRACKER.csv`). This restriction remains in force until the Analytics page is rebuilt against real data in a separate, explicitly authorized implementation phase.

## Geography

**Nationwide South Africa.** There is no city-only launch and no geographic sequencing. Merchants/owners and renters/buyers may be located anywhere in South Africa.

Local self-collection feasibility is a **transaction-level** check, not a platform-launch restriction: before confirming any individual Wave 0 transaction, confirm the two parties can reasonably complete the permitted handover method (see Logistics below). This never restricts who may sign up or list — only which specific transactions are allowed to proceed.

## Cohort

- 8–12 initial merchants/owners
- 15–25 initial users
- 2-week Wave 0 duration
- Invite-only — no external/open signup
- Maximum 5 concurrent transactions at any time

## Category Whitelist

Allowed: outdoor, events, sports, baby, tools
Excluded for Wave 0: vehicles, tech, fashion, music

## Logistics

Allowed: **owner/renter self-collection only.**
Not allowed: Unity-arranged delivery, Bob Go, Pargo, any courier integration, or merchant delivery unless separately and manually approved by the pilot lead for a specific transaction. No courier integration exists in the codebase today — do not imply one does.

Operator/user message: *"Unity Wave 0 uses direct collection and handover only — no delivery service or courier protection is provided or implied."*

## Insurance / Damage Position

No real insurance, no real deposit holding, no real financial protection, no real payment exists in Wave 0. Damage is handled entirely through manual review of condition evidence and the dispute workflow — never an insurance claim.

Prohibited phrases: "insured", "covered by Unity", "securely held deposit", "guaranteed replacement", "Unity protection".

Approved explanation: *"This is a pilot with no real money involved. There's no insurance, no real deposit held, and no payment taken. If something goes wrong, our team manually reviews before/after photos and makes a decision — there's no insurance claim because no real transaction occurred."*

## KYC Operating Limits (recommendations only — not code-enforced beyond the existing 48h overdue-detection threshold)

- Target SLA: 24 hours
- Max SLA: 48 hours
- Reviews per operator per day: 15–20
- Max pending queue: 30
- Pause new signups: queue > 40 pending, or any item aged > 72h
- Escalate: queue > 60 pending, or any item aged > 96h

Operator checklist:
1. Review submission
2. Compare evidence
3. Approve/reject with a reason
4. Escalate suspicious cases
5. Never approve just to clear backlog pressure
6. Second-review ambiguous identity/document cases

## Ownership Verification Operating Limits (recommendations only)

- Low risk: same-day target
- Medium risk: 24–48h target
- High risk: not allowed in Wave 0
- Max pending queue: 25
- Escalate: serial mismatch, suspicious invoice/receipt, stock-photo reuse, inconsistent evidence, disputed ownership
- Reject: evidence clearly doesn't match the item, no credible ownership proof, or an evidence request left unresolved > 7 days

## Support Model

- Minimum staffing: 1 active ops/support person during support hours
- Support hours: business hours SAST, 7 days/week during Wave 0
- First response SLA: 4 business hours
- Urgent response SLA (safety, fraud, privacy, platform outage): 1 hour, any hour

| Role | Name |
|---|---|
| Primary Ops | TBD |
| Backup Ops | TBD |
| Technical Escalation | TBD |
| Founder / Pilot Lead | TBD |

## Condition Evidence SOP

- Low-risk items: evidence recommended
- Medium-risk items: evidence required
- Pre-handover: clear photos, all major visible sides, existing damage recorded
- Post-return: same coverage, captured immediately on return
- Missing required evidence: never an automatic liability assumption — flag for manual dispute review

## Dispute Operating Model

- First review: 24h
- Evidence collection window: 48h
- Decision: 72h
- Ops lead escalation: any dispute open > 5 days
- Pause new transactions: > 3 simultaneous open disputes, or any single dispute aged > 7 days

No financial execution (fund release, forfeiture, refund, payout) occurs as a result of any Wave 0 dispute outcome — this is a no-real-money pilot. Booking status is restored for all resolution outcomes per the existing `resolve_dispute()` behavior.

## Exceptions Tracker

See `docs/WAVE0_EXCEPTIONS_TRACKER.csv`. Operating rules:
- Review cadence: daily
- Escalate to ops lead: any item aged > 5 days
- Pause expansion: > 10 genuinely-unresolved items
- Hard maximum unresolved age: 7 days

This tracker exists because the in-app Exceptions dashboard's resolve endpoint only recognizes 11 of the ~54 categories it detects — most categories cannot be dismissed in the UI even after remediation, so this external tracker is the source of truth for tracking their actual resolution until that endpoint is expanded.

## Immediate Stop Conditions

Stop the pilot immediately for any of:
- Real payment processed
- Unauthorized payout
- Privacy/security breach
- Material KYC bypass
- Credible stolen-goods incident
- Physical safety incident
- Serious production outage during active transactions
- Data loss/corruption
- Regulatory/legal complaint requiring suspension

## Pause-and-Review Conditions

Pause expansion (not a full stop) for:
- KYC backlog breach (see KYC limits above)
- Ownership backlog breach (see Ownership limits above)
- Support SLA breach
- Dispute rate > 20%
- More than 10 genuinely-unresolved exceptions
- Cancellation rate > 35%
- Required condition evidence missing on > 25% of applicable bookings
- Credible fraud suspicion
- Supply refresh below 70% in the last 7 days (if/when a reliable refresh signal exists — see note below)

**Note on availability refresh**: the current schema has no reliable availability-refresh timestamp field. This threshold cannot be measured until such a field exists; do not substitute a different signal without updating this document first.
