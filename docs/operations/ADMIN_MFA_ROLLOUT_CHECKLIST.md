# Admin MFA Rollout Checklist

**Current state: the MFA gate exists in code (`src/lib/supabase/admin-mfa.ts`, wired into `requireAdmin()`) but is OFF by default.** Setting `ADMIN_MFA_ENFORCED=true` without completing every step below WILL lock out any admin who hasn't enrolled a verified factor — there is no soft/transitional mode, by design, because a fuzzy "sometimes enforced" state is itself a harder thing to reason about safely than a clean on/off switch gated by a completed checklist.

## How the gate actually works (for whoever flips it)

- `isAdminMfaEnforced()` reads `process.env.ADMIN_MFA_ENFORCED === 'true'` — any other value (unset, `'1'`, `'TRUE'`) is treated as off.
- When on, `requireAdmin()` additionally requires the current session's Authenticator Assurance Level to be `aal2` — meaning the admin has actually completed an MFA challenge *in this session*, not merely "has a factor enrolled somewhere."
- This uses Supabase Auth's own built-in MFA (TOTP) primitives — no custom second-factor mechanism was built, and none should be.

## Step 1 — Inventory current admin accounts

Before anything else, get the list of every `profiles.role = 'admin'` account from whoever has Supabase dashboard/database access. This document cannot generate that list itself — it needs a live read against the real `profiles` table, and the list must be complete, not sampled.

## Step 2 — Enrollment window (no enforcement yet)

For every admin account on the Step 1 list:
1. Sign in normally (MFA not required yet).
2. Enroll a TOTP factor via Supabase Auth's client SDK (`supabase.auth.mfa.enroll({ factorType: 'totp' })`), following the QR-code/secret flow Supabase's own UI library or a simple custom form presents.
3. Complete the verification challenge (`supabase.auth.mfa.challengeAndVerify(...)`) to confirm the factor is genuinely usable, not just registered.
4. Confirm the factor shows as `status: 'verified'` — visible read-only today in the admin Customer 360 panel's `mfaVerifiedFactorCount` field (`src/lib/supabase/admin-auth-info.ts`), which already exists and needs no new code.

**Do not proceed to Step 3 until every single admin from the Step 1 list has `mfaVerifiedFactorCount >= 1`.** One un-enrolled admin is one locked-out admin the moment enforcement flips on.

## Step 3 — Confirm via the admin audit trail

Cross-check the enrollment-window activity (Step 2) against `admin_action_history`/the broader `/admin/audit` feed to confirm every enrolling admin's session activity looks normal — this is a lightweight sanity check, not a substitute for the dashboard-level `mfaVerifiedFactorCount` check in Step 2.

## Step 4 — Dry run in a non-production context

Before flipping the flag anywhere real admins depend on it, set `ADMIN_MFA_ENFORCED=true` in a local/preview environment only, and confirm:
- An admin with a verified, challenged-this-session factor can still reach `/admin/*`.
- An admin who has NOT completed an MFA challenge this session (even if enrolled) is correctly denied, not waved through.
- The denial path (`requireAdmin()` returning `null`) renders the same "you must be signed in as an administrator" state every other denial already produces — no new error-handling code was needed for this, which is itself a signal the integration is minimal and low-risk.

## Step 5 — Flip enforcement in the real environment

Only after Steps 1-4 are complete: set `ADMIN_MFA_ENFORCED=true` in the real deployment's environment variables. This is a configuration change, not a code deployment — it can be toggled without a new release, which also means it can be toggled back off immediately if Step 6 reveals a problem.

## Step 6 — Immediate post-flip verification

Within minutes of flipping the flag, confirm at least one real admin can still sign in and reach `/admin`. If not, revert the flag immediately (unset or set to anything other than `'true'`) — this is a fast, safe rollback with no code change required.

## Rollback / emergency access procedure

If an admin is locked out despite completing Step 2 (e.g. a lost authenticator device):
1. **Do not disable `ADMIN_MFA_ENFORCED` globally** just to unblock one person — that removes MFA protection for every admin, not just the affected one.
2. The locked-out admin should use Supabase Auth's own factor-recovery flow (re-enrolling a new factor requires being able to sign in — if `aal2` is required to reach anywhere, this needs an admin who already has a *different* working factor, or someone with direct Supabase Auth dashboard access, to unenroll the lost factor on the affected account via the Supabase Admin API (`supabase.auth.admin.mfa.deleteFactor`) so they can re-enroll a fresh one at their next normal sign-in.
3. Log the recovery action — who performed it, for whom, when, and why — in the same place any other privileged administrative action is logged in this system (the existing `admin_action_history` pattern), even though this document does not propose new code to automate that logging; it should be a manual, written record at minimum until/unless that gap is closed.
4. Never create a standing, undocumented bypass ("just disable the check for this one admin") — any emergency access must be a logged, single-use action, not a silent permanent exception.

## What this checklist does not cover

- Which specific admins currently exist (needs Step 1's live data).
- Whether Supabase Auth's own password policy is adequate on its own (a separate, already-flagged audit gap).
- Failed-authentication-attempt monitoring (also a separate, already-flagged gap — MFA reduces the *impact* of a compromised password, it doesn't provide visibility into *attempts*).
