# How Far Is UNity From a Trustworthy, Scalable Marketplace?

*One-page summary. No claim is made about Takealot/Makro's actual internal infrastructure — only about publicly observable marketplace behavior and standard engineering practice (OWASP ASVS, general SaaS operational norms).*

## What's already genuinely solid

Underneath the visible product, Unity has real engineering maturity in places that don't show up in a demo: **270 row-level-security policies** correctly scoping multi-tenant data (bookings, payments, disputes all properly restricted to their actual parties); **every payment/escrow webhook verifies a cryptographic signature** before trusting its payload; a **real anti-keyword-stuffing search-ranking fix** that was found and fixed through live testing, not guessed at; a **thoughtfully designed account-erasure system** that anonymizes personal data while correctly preserving financial/legal records; and a **custom analytics pipeline** that is honest about its own limitations (explicitly labeling unavailable metrics rather than fabricating them) rather than looking impressive and lying. This is the profile of a codebase that has been through real, repeated hardening passes — not a prototype.

## What stands between here and "trustworthy and scalable"

**Trustworthy** is currently blocked less by what's broken and more by what's *unknown*: nobody reading this repository can currently say what region the database lives in, what the backup/restore story actually is, or whether a restore has ever been tested. Those three unknowns matter more than almost any code-level finding, because a marketplace's core trust promise — "your money, your documents, and your bookings are safe with us" — depends entirely on the backup answer being good, and right now it's simply not written down anywhere accessible. Alongside that, admin accounts can reach KYC documents and financial records with a password alone (no MFA), and nobody is watching for errors in production (no Sentry/Datadog-equivalent) — so even if something does go wrong, there's no guarantee anyone would know quickly.

**Scalable** is more a question of two specific, fixable gaps than a wholesale redesign. The search architecture itself (Postgres full-text + trigram + tiered ranking + proper keyset pagination) is a genuinely reasonable foundation that will hold up reasonably well into the thousands of listings — the real problem is that two of the features renters most expect from a *rental* marketplace (filter by location, filter by availability) are not actually wired up, despite the groundwork existing. That's a feature gap wearing a performance-sounding name, not a scale problem.

## The comparison, stated plainly

A mature public marketplace earns trust through three things working *together*: visible product quality, operational rigor you can't see (backups, monitoring, access control), and compliance discipline (consent, retention, breach process). Unity is strong on the first (search ranking, RLS, webhook security are evidence of real care), **unverified** on the second (not failing — genuinely unknown, which is its own kind of risk), and **partially started** on the third (erasure is well-built; consent banner and retention periods are not). The honest statement is: **this is not a broken marketplace pretending to be solid — it's a solidly-built marketplace that has not yet had its operational and compliance foundations confirmed or closed out**, and those two things (not the product code) are what currently separate it from being launch-ready.

## The single highest-leverage next step

Get Supabase dashboard access and answer three questions — region, backup frequency, and whether a restore has ever been tested. Every other P0 item in this audit can proceed in parallel, but those three facts are the ones that turn "probably fine" into either "confirmed fine" or "here's exactly what to fix before launch" — and right now, nobody can honestly say which.
