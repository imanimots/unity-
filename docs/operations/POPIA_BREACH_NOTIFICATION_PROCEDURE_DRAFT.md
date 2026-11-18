# POPIA Breach-Notification Procedure — DRAFT, PENDING LEGAL REVIEW

**This is not legal advice and must not be treated as a compliant procedure until a South African privacy/data-protection adviser has reviewed it.** It exists so that, if a real incident happened today, there is a starting structure rather than nothing — and so counsel has a concrete draft to react to rather than a blank page. Drafted to work alongside `docs/operations/INCIDENT_RESPONSE_WORKFLOW.md`'s existing 9-step structure, not as a separate, competing process.

## What POPIA requires (general framework, not a complete legal statement — confirm every item with counsel)

South Africa's Protection of Personal Information Act generally requires a responsible party to notify the Information Regulator and affected data subjects "as soon as reasonably possible" after discovering that personal information has been accessed or acquired by an unauthorized person. The exact timing, format, and threshold for what counts as a notifiable breach are legal questions this draft does not attempt to answer definitively.

## Step 1 — Detect and confirm

Using `INCIDENT_RESPONSE_WORKFLOW.md`'s existing detection/classification steps. A breach-notification process only begins once an incident is confirmed to have actually involved personal information — not every security incident does (e.g., a public-bucket availability issue with no unauthorized access is a reliability incident, not a breach).

## Step 2 — Identify exactly what was exposed

Given this project's data inventory (from the earlier technical audit and this programme's own findings):

| Data category | Where it lives | Sensitivity |
|---|---|---|
| Identity documents (ID/passport numbers, legal names, addresses) | `identity_verifications`, `kyc-documents` bucket | Highest |
| Bank account details | `payout_destinations` + Supabase Vault (`account_last4` plaintext, full number encrypted) | Highest |
| Contact details | `profiles.phone`, `auth.users.email` | High |
| Transaction records | `bookings`, `orders`, `payments` | Medium-high (financial) |
| Behavioral analytics | `analytics_events` | Low (no raw query text, no PII by design) |

The specific table(s)/bucket(s) involved in an actual incident determine the severity and notification scope — this draft does not pre-judge which category any future incident would touch.

## Step 3 — Determine whether notification is required

**This step requires counsel, not a technical judgment call.** Prepare for that conversation by having ready:
- Exact data categories exposed (Step 2).
- Approximate number of affected data subjects (query the relevant table(s) by the incident's known scope — a count, not full records).
- Whether the exposure was to an unauthorized third party or an internal access-control failure (e.g., an RLS gap) with no evidence of actual external access.
- Whether the data was encrypted/otherwise protected at the point of exposure (relevant for bank account numbers, which are Vault-encrypted even at rest — a storage-layer breach of that specific table would not expose full account numbers the way it would expose, say, a KYC document's contents).

## Step 4 — Notify (if counsel determines it's required)

- **The Information Regulator**: per whatever current process counsel confirms (this draft does not pre-specify a submission mechanism, since that is itself something to confirm at the time, not assume in advance).
- **Affected data subjects**: via whatever channel reaches them (email, the in-app notification system already built for transactional emails) — but **do not send a real notification without counsel's sign-off on both the decision to notify and the wording**, per this programme's own standing instruction not to send real customer notifications without approval.

## Step 5 — Internal record-keeping

Log the incident, the determination made (notify or not, and why), and any notification sent, in a durable internal record — this project's existing `admin_action_history`-style pattern is a reasonable place to anchor this, though a dedicated incident-log table may be worth building once a real incident makes the need concrete (not built speculatively here).

## Step 6 — Post-incident review

Per `INCIDENT_RESPONSE_WORKFLOW.md`'s existing Step 9 — what happened, root cause, what changed, what would prevent recurrence — plus, specifically for a POPIA-relevant incident, whether the notification process itself (Steps 3-4) worked as intended or needs revision for next time.

## Explicit questions for counsel (do not resolve these without legal input)

1. What specific timeline does "as soon as reasonably possible" translate to for this business's risk profile — hours, days?
2. What exact threshold of exposure (number of records, sensitivity category) triggers mandatory Regulator notification versus a judgment call?
3. Is there a required notification format/template for the Information Regulator specifically?
4. Does this project's current single-Supabase-project architecture (no production/staging separation, confirmed by the E46 programme) create any additional notification obligation if a "test" incident technically touched a table that also holds real customer data?
5. Who, by role (not necessarily by name), should be the designated point of contact for Regulator communications once this business has real customers?
